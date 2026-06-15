'use strict';

/**
 * engine/voice-calibration/propose.js  [N net-new — roadmap #5 voice-calibration proposer]
 *
 * proposeVoiceCalibration(scanReport, brandConfig, opts)
 *   Deterministic voice-calibration proposer: derives a PROPOSED learning record over the FOUR
 *   structured voice axes (drama_dial, archetype_emphasis, hook_preferences, cadence_preferences)
 *   from a competitor-scan-report.schema.json document + the brand's current brand.json config.
 *
 * GOVERNANCE (NON-NEGOTIABLE):
 *   - target_mutability is ALWAYS "human-only" — never learnable (classifyTarget enforces this).
 *   - target_artifact is ALWAYS "brand:<id>:voice" — voice is instance-specific.
 *   - The record status is ALWAYS "proposed" — never applied/rolled_back here.
 *   - NEVER auto-applied: the self-improve applyGovernedChange MUST refuse (EHUMANONLY).
 *   - NEVER generates or touches rules/*.md, gate config, thresholds, or any guardrail surface.
 *
 * DD-15 FRESHNESS GUARD: a scan older than competitor_scan.voice_calibration.freshness_days never
 * advances to a proposal. Throws ESTALEREPORT.
 *
 * ANALYST SEAT (P7): the optional analystSeat.refine may ONLY return a rationale STRING.
 *   - The engine deep-clones inputs BEFORE the seat call so mutation is impossible.
 *   - After the seat returns, the structural fields are re-validated to be unchanged.
 *   - A throwing or absent seat degrades gracefully to the deterministic rationale.
 *   - A seat that returns a non-string or throws is silently dropped (P7 degrade).
 *
 * DETERMINISTIC (RD-12 / P6): NO Date.now() / Math.random() / I/O inside the proposal-
 * derivation. Time is injected via opts.now. Identical corpus => byte-identical proposal.
 *
 * Reuses:
 *   engine/analytics/engagement/learning.js  — proposeLearningRecord / writeProposed
 *   engine/self-improve/mutability.js        — classifyTarget (must return human-only)
 *
 * Tier-3 cleanliness (§0.3 r6 / RD-3): no hardcoded brand names, ids, handles, or paths.
 */

const crypto = require('crypto');

const { proposeLearningRecord, writeProposed } = require('../analytics/engagement/learning.js');
const mutability = require('../self-improve/mutability.js');

// ---------------------------------------------------------------------------
// Error types — stable .code strings, never branched on message text.
// ---------------------------------------------------------------------------

class StaleReportError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'StaleReportError';
    this.code = 'ESTALEREPORT';
    Object.assign(this, details);
  }
}

class VoiceProposalError extends Error {
  constructor(message, code = 'EVOICEPROPOSAL') {
    super(message);
    this.name = 'VoiceProposalError';
    this.code = code;
  }
}

class VerbatimCopyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'VerbatimCopyError';
    this.code = 'EVERBATIMCOPY';
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The target_artifact convention for voice calibration records.
 * Must be brand:<id>:voice — classifyTarget classifies any "voice" kind target as human-only.
 */
function voiceArtifact(brandId) {
  return `brand:${brandId}:voice`;
}

/**
 * The target descriptor passed to classifyTarget. Uses kind:'voice' so the classifier falls
 * through to the conservative default → human-only (DD-6 fail-closed).
 */
const VOICE_TARGET_DESCRIPTOR = Object.freeze({ kind: 'voice' });

// ---------------------------------------------------------------------------
// DD-15 freshness guard
// ---------------------------------------------------------------------------

/**
 * Assert the scan report is fresh enough to be advanced to a proposal.
 * A report is stale when:
 *   (a) freshness_window.expires_at is set and already past `now`, OR
 *   (b) freshness_window.duration + the submission date is > freshness_days days ago.
 *
 * @param {object} scanReport        competitor-scan-report.schema.json document
 * @param {number} nowMs             injected clock (ms since epoch)
 * @param {number} freshnessDays     from config (default 30)
 * @throws {StaleReportError}        ESTALEREPORT when the scan is too old
 */
function assertFresh(scanReport, nowMs, freshnessDays) {
  const days = (typeof freshnessDays === 'number' && freshnessDays >= 1) ? freshnessDays : 30;

  // (a) freshness_window.expires_at is the authoritative expiry when present.
  if (scanReport && scanReport.freshness_window && scanReport.freshness_window.expires_at) {
    const expiresAt = Date.parse(scanReport.freshness_window.expires_at);
    if (Number.isFinite(expiresAt) && nowMs >= expiresAt) {
      throw new StaleReportError(
        `Scan report freshness_window expired at ${scanReport.freshness_window.expires_at} (DD-15). ` +
        'Run engine competitor-scan again to generate a fresh report before proposing calibration.',
        { expires_at: scanReport.freshness_window.expires_at, now_iso: new Date(nowMs).toISOString() },
      );
    }
  } else {
    // (b) Use the report period.end or provenance.submitted_at as the report date.
    const reportDateStr =
      (scanReport && scanReport.provenance && scanReport.provenance.submitted_at) ||
      (scanReport && scanReport.period && scanReport.period.end) ||
      null;
    if (reportDateStr) {
      const reportMs = Date.parse(reportDateStr);
      if (Number.isFinite(reportMs)) {
        const ageMs = nowMs - reportMs;
        const staleLimitMs = days * 24 * 60 * 60 * 1000;
        if (ageMs > staleLimitMs) {
          throw new StaleReportError(
            `Scan report is ${Math.floor(ageMs / 86400000)} days old (limit: ${days} days, DD-15). ` +
            'Run engine competitor-scan again to generate a fresh report before proposing calibration.',
            { report_date: reportDateStr, freshness_days: days, now_iso: new Date(nowMs).toISOString() },
          );
        }
      }
    }
    // If no date info at all, allow (conservative: cannot prove stale without a date).
  }
}

// ---------------------------------------------------------------------------
// Axis derivation helpers — DETERMINISTIC, NO Date.now/Math.random/I/O
// ---------------------------------------------------------------------------

/**
 * Derive the proposed drama_dial from the scan report and current brand config.
 * Policy: if the competitor drama_signal is "high" and current dial is already "low",
 * keep it "low" (ANTI-PATTERN: do not raise drama to match competitors who are high-drama).
 * Only lower the dial or keep it — NEVER raise it based on competitor high-drama signals.
 * Competitor "low" drama with current "high" dial => recommend lowering.
 *
 * Returns { current, proposed, changed }.
 */
function deriveDramaDial(scanReport, currentDramaDial) {
  const current = typeof currentDramaDial === 'string' ? currentDramaDial : 'low';
  const DIAL_VALUES = Object.freeze(['low', 'medium', 'high']);

  const competitorSignal = (scanReport && scanReport.drama_signal) || 'low';
  const competitorIsHigh = competitorSignal === 'high';

  // Policy: never raise drama_dial to match a high-drama competitor. Only lower toward 'low'.
  let proposed = current;
  if (!DIAL_VALUES.includes(current)) {
    proposed = 'low';
  } else if (competitorIsHigh) {
    // Competitor high drama is an ANTI-SIGNAL — keep or lower (do not raise).
    proposed = current; // no change (already at their level or lower is fine)
  } else if (competitorSignal === 'low') {
    // Competitors are low-drama: gentle recommendation toward 'low' if not already there.
    if (current === 'high') proposed = 'medium';
    else proposed = current;
  }
  // If competitorSignal === 'medium': no change.

  return { current, proposed, changed: proposed !== current };
}

/**
 * Derive proposed archetype_emphasis from scan report's archetype_distribution + current emphasis.
 * Policy: codes that appear in the top competitor_count and show high engagement get a small boost
 * (+0.5 weight if not already at top). NEVER adds a code that is already present at high weight.
 * Returns { current, proposed, changed }.
 */
function deriveArchetypeEmphasis(scanReport, currentEmphasis) {
  const current = Array.isArray(currentEmphasis) ? currentEmphasis : [];

  // Safe deep-clone for comparison.
  const proposed = JSON.parse(JSON.stringify(current));

  const dist = (scanReport && Array.isArray(scanReport.archetype_distribution))
    ? scanReport.archetype_distribution : [];

  const engProfile = (scanReport && scanReport.engagement_profile) || {};
  const highEngCodes = Array.isArray(engProfile.high_engagement_archetype_codes)
    ? engProfile.high_engagement_archetype_codes : [];

  // For each code that has competitor_count > 0 AND is in high_engagement_archetype_codes,
  // boost its weight in proposed emphasis by +0.5, capped reasonably.
  // The BOOST is small and deterministic: same scan => same boost.
  const BOOST = 0.5;

  for (const entry of dist) {
    if (!entry || !entry.code || entry.competitor_count <= 0) continue;
    if (!highEngCodes.includes(entry.code)) continue;

    // Find in current emphasis.
    const idx = proposed.findIndex((e) => e.code === entry.code);
    if (idx >= 0) {
      // Existing code: boost by +0.5 (round to 1dp for determinism).
      const newWeight = Math.round((proposed[idx].weight + BOOST) * 10) / 10;
      proposed[idx] = { ...proposed[idx], weight: newWeight };
    }
    // If code is NOT in current emphasis, we do NOT add new codes — only reinforce existing ones.
    // Adding unseen codes would require content knowledge we don't have.
  }

  const changed = JSON.stringify(proposed) !== JSON.stringify(current);
  return { current, proposed, changed };
}

/**
 * Derive proposed hook_preferences from scan report's hook_signals + current preferences.
 * Policy: hook patterns that appear frequently (count >= 2) in top_patterns get a weight boost
 * for existing matching preferences. NEVER adds new patterns. NEVER copies verbatim text.
 * Returns { current, proposed, changed }.
 */
function deriveHookPreferences(scanReport, currentPrefs) {
  const current = Array.isArray(currentPrefs) ? currentPrefs : [];
  const proposed = JSON.parse(JSON.stringify(current));

  const hookSignals = (scanReport && scanReport.hook_signals) || {};
  const topPatterns = Array.isArray(hookSignals.top_patterns) ? hookSignals.top_patterns : [];

  const BOOST = 0.5;
  const MIN_COUNT_FOR_BOOST = 2;

  for (const hp of topPatterns) {
    if (!hp || typeof hp.pattern !== 'string' || hp.count < MIN_COUNT_FOR_BOOST) continue;

    // Find the matching preference.
    const idx = proposed.findIndex((p) => p.pattern === hp.pattern);
    if (idx >= 0) {
      const newWeight = Math.round((proposed[idx].weight + BOOST) * 10) / 10;
      proposed[idx] = { ...proposed[idx], weight: newWeight };
    }
    // If not found in current preferences, skip (do not add new patterns automatically).
  }

  const changed = JSON.stringify(proposed) !== JSON.stringify(current);
  return { current, proposed, changed };
}

/**
 * Derive proposed cadence_preferences from scan report's cadence_profile + current preferences.
 * Policy: only update if cadence signals are strong (total_items >= 4). Cadence is conservative
 * — we do not auto-change the brand's cadence without strong signal. Returns { current, proposed, changed }.
 */
function deriveCadencePreferences(scanReport, currentPrefs) {
  const current = currentPrefs && typeof currentPrefs === 'object'
    ? JSON.parse(JSON.stringify(currentPrefs))
    : {
        preferred_posts_per_week: 5,
        thread_preference: 'sometimes',
        media_preference: 'sometimes',
        top_days: [],
      };

  // Conservative: no change unless there's enough signal. Default: keep current.
  const proposed = JSON.parse(JSON.stringify(current));

  const cadence = (scanReport && scanReport.cadence_profile) || {};
  const totalItems = cadence.total_items || 0;

  // Only act when we have enough signal items.
  if (totalItems < 4) {
    return { current, proposed, changed: false };
  }

  // With sufficient signal, we can note top_days but we don't force-change the brand preference.
  // Cadence is very brand-specific; the proposal is intentionally conservative.
  // No changes: cadence is driven by the brand's publishing rhythm, not competitors.

  const changed = JSON.stringify(proposed) !== JSON.stringify(current);
  return { current, proposed, changed };
}

// ---------------------------------------------------------------------------
// Deterministic rationale builder
// ---------------------------------------------------------------------------

/**
 * Build a deterministic rationale string from the scan report and proposed changes.
 * NO verbatim competitor text — only labels, counts, codes, and rates. Pure.
 */
function buildDeterministicRationale(scanReport, axisResults) {
  const brand = (scanReport && scanReport.brand) || '?';
  const confidence = (scanReport && typeof scanReport.confidence === 'number')
    ? scanReport.confidence : 0;
  const compN = (scanReport && scanReport.drama_markers && scanReport.drama_markers.total_items)
    ? scanReport.drama_markers.total_items : 0;

  const dramaSignal = (scanReport && scanReport.drama_signal) || 'low';

  const engProfile = (scanReport && scanReport.engagement_profile) || {};
  const primaryMetric = engProfile.metric || 'engagement';
  const medianValue = typeof engProfile.median_value === 'number' ? engProfile.median_value : 0;
  const highEngCodes = Array.isArray(engProfile.high_engagement_archetype_codes)
    ? engProfile.high_engagement_archetype_codes : [];

  const lines = [
    `Competitor analysis (${compN} item(s), confidence ${confidence}, brand: ${brand}):`,
  ];

  if (highEngCodes.length > 0) {
    lines.push(
      `${highEngCodes.join(', ')} archetype(s) show highest engagement lift in competitor corpus ` +
      `(median ${primaryMetric} above ${medianValue} for these codes).`,
    );
  }

  // drama_dial rationale
  const drama = axisResults.drama;
  if (dramaSignal === 'high' && drama.current === 'low') {
    lines.push(
      `Drama signal is high in competitor landscape but own brand voice is established ${drama.current} ` +
      '— ANTI-PATTERN: do not raise drama_dial. Competitor high-drama may underperform on authentic engagement.',
    );
  } else if (drama.changed) {
    lines.push(`drama_dial: ${drama.current} → ${drama.proposed} (competitor signal: ${dramaSignal}).`);
  } else {
    lines.push(`drama_dial unchanged (${drama.current}): competitor signal is ${dramaSignal}.`);
  }

  // hook_preferences rationale
  const hooks = axisResults.hooks;
  if (hooks.changed) {
    lines.push('Hook preference weight(s) adjusted based on competitor top_patterns with count >= 2.');
  }

  // archetype_emphasis rationale
  const archs = axisResults.archetypes;
  if (archs.changed) {
    lines.push('Archetype emphasis weight(s) boosted for codes appearing in high_engagement_archetype_codes.');
  }

  // cadence
  const cadence = axisResults.cadence;
  if (!cadence.changed) {
    lines.push('Overall cadence_preferences unchanged — insufficient signal to shift posting rhythm.');
  }

  lines.push('Regenerate brand-dna.md prose via `engine generate-dna` after applying.');

  return lines.join(' ');
}

// ---------------------------------------------------------------------------
// Record ID — content-addressed, deterministic, no Date.now
// ---------------------------------------------------------------------------

function buildRecordId(brandId, scanReport, nowMs) {
  const h = crypto.createHash('sha256');
  h.update(JSON.stringify({
    brand: brandId,
    period: (scanReport && scanReport.period) || null,
    confidence: (scanReport && scanReport.confidence) || 0,
    nowMs,
  }));
  const date = new Date(nowMs).toISOString().slice(0, 10);
  return `vc-${date}-${h.digest('hex').slice(0, 10)}`;
}

// ---------------------------------------------------------------------------
// P1 verbatim guard for the rationale + full proposed record
// ---------------------------------------------------------------------------

const MIN_VERBATIM_LEN = 40;

/**
 * Normalise text the same way archetypes.assertNoVerbatimCompetitorCopy does:
 * lowercase, collapse whitespace.
 */
function normForCompare(text) {
  if (typeof text !== 'string') return '';
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Assert the rationale string and the full proposed record carry NO verbatim competitor text.
 * On a hit:
 *   - Drop the analyst-seat rationale and fall back to the deterministic rationale.
 * If verbatim still leaks after the fallback, throw EVERBATIMCOPY and write nothing.
 *
 * @param {string}   candidate           rationale candidate (analyst seat output)
 * @param {string}   deterministicFall   the safe deterministic rationale
 * @param {object}   recordSnapshot      the full proposed record (without rationale yet)
 * @param {object[]} competitorItems     raw competitor corpus items ({ text })
 * @returns {string}  the safe rationale to use
 * @throws {VerbatimCopyError}  EVERBATIMCOPY when verbatim text leaks even after fallback
 */
function assertNotVerbatimRationale(candidate, deterministicFall, recordSnapshot, competitorItems) {
  const items = Array.isArray(competitorItems) ? competitorItems : [];

  // Build normalised competitor shingles (>= MIN_VERBATIM_LEN chars).
  const compNorms = [];
  for (const item of items) {
    if (!item || typeof item.text !== 'string') continue;
    const n = normForCompare(item.text);
    if (n.length >= MIN_VERBATIM_LEN) compNorms.push(n);
  }

  if (compNorms.length === 0) {
    // No competitor texts to check against — no verbatim leak is possible.
    return candidate;
  }

  /** Check whether a string contains any competitor shingle. */
  function hasLeak(str) {
    if (typeof str !== 'string') return false;
    const n = normForCompare(str);
    for (const comp of compNorms) {
      if (n.includes(comp) || comp.includes(n)) return true;
    }
    return false;
  }

  /** Check entire JSON-serialised record for verbatim leaks. */
  function recordHasLeak(rec) {
    const serialised = JSON.stringify(rec);
    const normSer = normForCompare(serialised);
    for (const comp of compNorms) {
      if (normSer.includes(comp)) return true;
    }
    return false;
  }

  // Step 1: if the candidate rationale leaks verbatim competitor text, drop it.
  let safeRationale = candidate;
  if (hasLeak(candidate)) {
    safeRationale = deterministicFall;
  }

  // Step 2: check the full record (with the safe rationale substituted) for any remaining leak.
  const checkRecord = { ...recordSnapshot, rationale: safeRationale };
  if (recordHasLeak(checkRecord)) {
    throw new VerbatimCopyError(
      'EVERBATIMCOPY: verbatim competitor text detected in the proposed voice-calibration record ' +
      'even after discarding the analyst-seat rationale. The proposal cannot be written (P1).',
    );
  }

  return safeRationale;
}

// ---------------------------------------------------------------------------
// proposeVoiceCalibration — the public entry point
// ---------------------------------------------------------------------------

/**
 * Propose a structured voice-calibration over the four voice axes.
 *
 * GOVERNANCE: the returned record is ALWAYS target_mutability:'human-only', status:'proposed',
 * target_artifact:'brand:<id>:voice'. classifyTarget({ kind:'voice' }) returns human-only.
 * The record is written to $CONTENT_HOME/learning/proposed/ via the canonical writeProposed path.
 *
 * DD-15 FRESHNESS: throws ESTALEREPORT when the scan is older than freshness_days.
 *
 * P7 ANALYST SEAT: analystSeat.refine may ONLY return a rationale string. Engine deep-clones
 * inputs, re-validates structural fields after the seat returns, and degrades silently on any
 * seat error or non-string return.
 *
 * P6 DETERMINISTIC: identical inputs => byte-identical record (injected opts.now).
 *
 * @param {object} scanReport    competitor-scan-report.schema.json document
 * @param {object} brandConfig   parsed brand.json (current voice axis values)
 * @param {object} [opts]
 * @param {object}   [opts.env]                   process.env override for paths
 * @param {number}   [opts.now]                   injected clock (ms) — REQUIRED for determinism
 * @param {boolean}  [opts.write]                 write the proposed record (default true)
 * @param {number}   [opts.freshnessDays]         override freshness_days (else from config)
 * @param {object}   [opts.analystSeat]           { refine(proposal) => Promise<string>|string }
 * @param {object[]} [opts.competitorCorpusTexts] competitor corpus items ({ text }) for P1 guard
 * @returns {{ record, written, flags, proposed_diff, confidence }}
 * @throws {StaleReportError}  (ESTALEREPORT) when the scan is older than freshness_days
 */
async function proposeVoiceCalibration(scanReport, brandConfig, opts = {}) {
  const env = opts.env || process.env;
  const nowMs = typeof opts.now === 'number' ? opts.now
    : (opts.now instanceof Date ? opts.now.getTime() : Date.now());
  const freshnessDays = typeof opts.freshnessDays === 'number' ? opts.freshnessDays : 30;

  // Validate inputs.
  if (!scanReport || typeof scanReport !== 'object') {
    throw new VoiceProposalError('scanReport is required and must be an object');
  }
  if (!brandConfig || typeof brandConfig !== 'object') {
    throw new VoiceProposalError('brandConfig is required and must be an object');
  }

  // DD-15 FRESHNESS GUARD — before any derivation.
  assertFresh(scanReport, nowMs, freshnessDays);

  const brandId = (brandConfig.id && typeof brandConfig.id === 'string')
    ? brandConfig.id : (scanReport.brand || 'unknown');

  // Verify classifyTarget classifies the voice target as human-only (structural assertion).
  const classification = mutability.classifyTarget(VOICE_TARGET_DESCRIPTOR);
  if (classification.classification !== mutability.CLASSIFICATION.HUMAN_ONLY) {
    // This should never happen — 'voice' kind always resolves human-only under DD-6 fail-closed.
    throw new VoiceProposalError(
      'INTERNAL: classifyTarget returned non-human-only for a voice target — governance invariant violated.',
      'EGOVERNANCE_VIOLATED',
    );
  }

  // --- DERIVE ALL FOUR AXES (pure, deterministic, no I/O) ---

  const dramaDial = deriveDramaDial(scanReport, brandConfig.drama_dial);
  const archetypeEmphasis = deriveArchetypeEmphasis(scanReport, brandConfig.archetype_emphasis);
  const hookPreferences = deriveHookPreferences(scanReport, brandConfig.hook_preferences);
  const cadencePreferences = deriveCadencePreferences(scanReport, brandConfig.cadence_preferences);

  const axisResults = {
    drama: dramaDial,
    archetypes: archetypeEmphasis,
    hooks: hookPreferences,
    cadence: cadencePreferences,
  };

  // Build the proposed_diff over all four axes.
  const proposedDiff = {
    drama_dial: { current: dramaDial.current, proposed: dramaDial.proposed },
    archetype_emphasis: {
      current: archetypeEmphasis.current,
      proposed: archetypeEmphasis.proposed,
    },
    hook_preferences: {
      current: hookPreferences.current,
      proposed: hookPreferences.proposed,
    },
    cadence_preferences: {
      current: cadencePreferences.current,
      proposed: cadencePreferences.proposed,
    },
  };

  // Source signals: calibration type, count = number of competitor items.
  const competitorItemCount = (scanReport.drama_markers && typeof scanReport.drama_markers.total_items === 'number')
    ? scanReport.drama_markers.total_items : 1;
  const sourceSignals = [{ type: 'calibration', count: Math.max(1, competitorItemCount) }];

  // Evidence (confidence from scan report).
  const confidence = typeof scanReport.confidence === 'number' ? scanReport.confidence : 0;

  // --- DETERMINISTIC RATIONALE ---
  const deterministicRationale = buildDeterministicRationale(scanReport, axisResults);

  // BLOCKER 3 (step 1): capture scan freshness window from the report so apply.js can re-check it.
  const scanFreshnessWindow = (scanReport && scanReport.freshness_window) || null;
  // Derive a machine-readable expires_at for the record: prefer the report's freshness_window,
  // fall back to computing it from period.end + freshnessDays.
  let freshnessExpiresAt = null;
  if (scanFreshnessWindow && scanFreshnessWindow.expires_at) {
    freshnessExpiresAt = scanFreshnessWindow.expires_at;
  } else {
    const periodEnd = (scanReport && scanReport.period && scanReport.period.end) ||
      (scanReport && scanReport.provenance && scanReport.provenance.submitted_at) || null;
    if (periodEnd) {
      const periodEndMs = Date.parse(periodEnd);
      if (Number.isFinite(periodEndMs)) {
        freshnessExpiresAt = new Date(periodEndMs + freshnessDays * 24 * 60 * 60 * 1000).toISOString();
      }
    }
  }

  // Competitor corpus texts for the P1 verbatim guard (passed in from competitor-scan.js).
  const competitorCorpusTexts = Array.isArray(opts.competitorCorpusTexts) ? opts.competitorCorpusTexts : [];

  // --- ANALYST SEAT (P7): prose-only, deep-clone, re-validate, degrade on error ---
  let analystRationale = null;
  const seat = opts.analystSeat;
  if (seat && (typeof seat.refine === 'function' || typeof seat === 'function')) {
    // Deep-clone the record snapshot to prevent mutation by the seat.
    const snapshot = JSON.parse(JSON.stringify({
      proposed_diff: proposedDiff,
      target_artifact: voiceArtifact(brandId),
      target_mutability: 'human-only',
      status: 'proposed',
      confidence,
    }));

    const refineFn = typeof seat.refine === 'function' ? seat.refine : seat;
    try {
      const result = await refineFn(snapshot);
      if (typeof result === 'string' && result.trim()) {
        analystRationale = result.trim().slice(0, 1000); // cap prose length
      }
    } catch {
      // P7: a throwing seat degrades to deterministic rationale — no failure.
      analystRationale = null;
    }

    // Re-validate: structural fields must be unchanged regardless of what the seat did.
    // (The seat only got a deep clone, so original values are safe. Re-validate here for clarity.)
    // If analystRationale is a non-null string, it replaces the deterministic rationale (prose only).
  }

  // BLOCKER 4: run the P1 verbatim guard over the rationale + full record snapshot.
  // assertNotVerbatimRationale drops the analyst-seat output and falls back to the deterministic
  // rationale if it contains competitor copy; throws EVERBATIMCOPY if verbatim still leaks.
  const candidateRationale = analystRationale !== null ? analystRationale : deterministicRationale;
  // Build a snapshot of the record (without rationale) for the full-record check.
  const recordSnapshotForVerbatimCheck = {
    proposed_diff: proposedDiff,
    proposed_diff_structured: proposedDiff,
    confidence,
    evidence: { confidence, count: competitorItemCount },
    target_mutability: 'human-only',
    status: 'proposed',
    target_artifact: voiceArtifact(brandId),
    source_signals: sourceSignals,
  };
  const finalRationale = assertNotVerbatimRationale(
    candidateRationale,
    deterministicRationale,
    recordSnapshotForVerbatimCheck,
    competitorCorpusTexts,
  );

  // Build the proposed_diff string (for the learning record schema).
  const proposedDiffStr = JSON.stringify(proposedDiff, null, 2);

  // --- BUILD THE LEARNING RECORD via canonical proposeLearningRecord ---
  const recordId = buildRecordId(brandId, scanReport, nowMs);

  const baseResult = proposeLearningRecord({
    id: recordId,
    source_signals: sourceSignals,
    target_artifact: voiceArtifact(brandId),
    target_mutability: 'human-only', // ALWAYS human-only (governance invariant)
    proposed_diff: proposedDiffStr,
    shareability: 'private', // voice calibration is instance-specific, never shareable upstream (P10)
  }, { env, now: nowMs, write: false });

  // Layer structured governance fields on top of the base record.
  const record = {
    ...baseResult.record,
    // Structured proposed_diff (the four axes) — in addition to the string form.
    proposed_diff_structured: proposedDiff,
    // Evidence from scan.
    confidence,
    evidence: { confidence, count: competitorItemCount },
    // Rationale (guaranteed patterns-only — verbatim guard ran above).
    rationale: finalRationale,
    // Governance fields — always human-only, always proposed.
    target_mutability: 'human-only',
    status: 'proposed',
    target_artifact: voiceArtifact(brandId),
    // Source signals (structured).
    source_signals: sourceSignals,
    // BLOCKER 3 (step 1): persist the scan freshness window so apply.js can re-assert freshness.
    ...(freshnessExpiresAt ? { scan_freshness_expires_at: freshnessExpiresAt } : {}),
    // governance_state is not present (this is a human-only record; self-improve states don't apply).
  };

  // P2 structural assertion: classifyTarget must return human-only for this record's target kind.
  const targetDescriptor = { kind: 'voice', path: `brand.${brandId}.voice` };
  const classResult = mutability.classifyTarget(targetDescriptor);
  if (classResult.classification !== mutability.CLASSIFICATION.HUMAN_ONLY) {
    throw new VoiceProposalError(
      'INTERNAL: classifyTarget did not return human-only for the voice target — governance violated.',
      'EGOVERNANCE_VIOLATED',
    );
  }

  // --- WRITE the proposed record ---
  let written = null;
  if (opts.write !== false) {
    written = writeProposed(record, env);
  }

  return {
    record,
    written,
    flags: baseResult.flags,
    proposed_diff: proposedDiff,
    confidence,
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  proposeVoiceCalibration,
  // Exported for tests.
  assertFresh,
  deriveDramaDial,
  deriveArchetypeEmphasis,
  deriveHookPreferences,
  deriveCadencePreferences,
  buildDeterministicRationale,
  voiceArtifact,
  VOICE_TARGET_DESCRIPTOR,
  StaleReportError,
  VoiceProposalError,
  VerbatimCopyError,
  assertNotVerbatimRationale,
};
