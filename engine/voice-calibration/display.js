'use strict';

/**
 * engine/voice-calibration/display.js  [N net-new — roadmap #5 voice-calibration display]
 *
 * displayCalibrationCard(proposal, env) -> { cliPrompt, discordEmbed? }
 *   Renders a calibration card from a voice-calibration proposal record, showing current->proposed
 *   per axis with a REDACTED evidence summary. Output is safe for CLI + Discord surfaces.
 *
 * captureConsent(ctx) -> boolean
 *   Reads the explicit --consent flag. NEVER defaults to true — consent must be explicit.
 *
 * SAFETY INVARIANTS:
 *   - ALL brand/partner/snowflake terms are stripped via engine/shared/redact.js + config private_terms.
 *   - The card contains NO verbatim competitor text — guaranteed at propose time (propose.js
 *     assertNotVerbatimRationale runs the P1 guard before writing; display.js renders only the
 *     stored patterns-only rationale). Display also skips the rationale for any record that does
 *     not carry the scan_freshness_expires_at marker (pre-fix records may lack the guarantee).
 *   - captureConsent reads ONLY the explicit --consent flag (never a default).
 *   - The card surface does not commit any change — it only renders.
 *
 * Tier-3 cleanliness (§0.3 r6 / RD-3): no hardcoded brand names, ids, handles, or paths.
 */

const { redact, redactString } = require('../shared/redact.js');

// ---------------------------------------------------------------------------
// Redaction helpers
// ---------------------------------------------------------------------------

/**
 * Build a redaction function that strips brand/partner/snowflake terms from display text.
 * Reuses engine/shared/redact.js for secret shapes, augmented with configured private_terms.
 *
 * @param {string[]} [privateTerms]  terms from config (brand names, partner names, codenames)
 * @returns {function(string): string}  synchronous string redactor
 */
function buildRedactor(privateTerms) {
  const terms = Array.isArray(privateTerms) ? privateTerms.filter((t) => typeof t === 'string' && t.trim()) : [];

  return function redactDisplay(text) {
    if (typeof text !== 'string') return String(text == null ? '' : text);
    // 1. Apply secret shapes (token/key/bearer/etc.) via engine/shared/redact.js.
    let out = redactString(text);
    // 2. Strip configured private terms (brand names, partner names, codenames).
    for (const term of terms) {
      if (!term) continue;
      // Simple case-insensitive global replace.
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      try {
        out = out.replace(new RegExp(escaped, 'gi'), '[REDACTED]');
      } catch {
        // Ignore invalid regexes (malformed private terms).
      }
    }
    return out;
  };
}

// ---------------------------------------------------------------------------
// Card renderers — one per display axis
// ---------------------------------------------------------------------------

/**
 * Render the drama_dial axis line.
 * Format: "  drama_dial:           low → low (no change)"
 */
function renderDramaDialLine(diff) {
  if (!diff || !diff.drama_dial) return '  drama_dial:           (not set)';
  const cur = diff.drama_dial.current || '?';
  const prop = diff.drama_dial.proposed || '?';
  const changed = cur !== prop;
  return `  drama_dial:           ${cur} → ${prop}${changed ? '' : '  (no change)'}`;
}

/**
 * Render the archetype_emphasis axis lines.
 * Shows current and proposed weights side-by-side. NEVER shows verbatim competitor text.
 */
function renderArchetypeEmphasis(diff) {
  if (!diff || !diff.archetype_emphasis) return '  archetype_emphasis:   (not set)';
  const cur = Array.isArray(diff.archetype_emphasis.current) ? diff.archetype_emphasis.current : [];
  const prop = Array.isArray(diff.archetype_emphasis.proposed) ? diff.archetype_emphasis.proposed : [];

  if (cur.length === 0 && prop.length === 0) return '  archetype_emphasis:   (empty)';

  const lines = ['  archetype_emphasis:'];
  const allCodes = Array.from(new Set([...cur.map((e) => e.code), ...prop.map((e) => e.code)])).sort();
  for (const code of allCodes) {
    const cEntry = cur.find((e) => e.code === code);
    const pEntry = prop.find((e) => e.code === code);
    const cw = cEntry ? cEntry.weight : '—';
    const pw = pEntry ? pEntry.weight : '—';
    const changed = JSON.stringify(cw) !== JSON.stringify(pw);
    lines.push(`    ${String(code).padEnd(25)} ${String(cw).padStart(5)} → ${String(pw).padStart(5)}${changed ? '  *' : ''}`);
  }
  return lines.join('\n');
}

/**
 * Render the hook_preferences axis lines.
 * Shows pattern labels (never verbatim competitor text) and weight changes.
 */
function renderHookPreferences(diff) {
  if (!diff || !diff.hook_preferences) return '  hook_preferences:     (not set)';
  const cur = Array.isArray(diff.hook_preferences.current) ? diff.hook_preferences.current : [];
  const prop = Array.isArray(diff.hook_preferences.proposed) ? diff.hook_preferences.proposed : [];

  if (cur.length === 0 && prop.length === 0) return '  hook_preferences:     (empty)';

  const lines = ['  hook_preferences:'];
  const allPatterns = Array.from(new Set([...cur.map((p) => p.pattern), ...prop.map((p) => p.pattern)])).sort();
  for (const pattern of allPatterns) {
    const cEntry = cur.find((p) => p.pattern === pattern);
    const pEntry = prop.find((p) => p.pattern === pattern);
    const cw = cEntry ? cEntry.weight : '—';
    const pw = pEntry ? pEntry.weight : '—';
    const changed = JSON.stringify(cw) !== JSON.stringify(pw);
    lines.push(`    ${String(pattern).padEnd(25)} ${String(cw).padStart(5)} → ${String(pw).padStart(5)}${changed ? '  *' : ''}`);
  }
  return lines.join('\n');
}

/**
 * Render the cadence_preferences axis lines.
 */
function renderCadencePreferences(diff) {
  if (!diff || !diff.cadence_preferences) return '  cadence_preferences:  (not set)';
  const cur = diff.cadence_preferences.current;
  const prop = diff.cadence_preferences.proposed;
  if (!cur && !prop) return '  cadence_preferences:  (empty)';

  const fields = ['preferred_posts_per_week', 'thread_preference', 'media_preference', 'top_days'];
  const lines = ['  cadence_preferences:'];
  for (const field of fields) {
    const cv = cur ? JSON.stringify(cur[field]) : '—';
    const pv = prop ? JSON.stringify(prop[field]) : '—';
    const changed = cv !== pv;
    lines.push(`    ${String(field).padEnd(28)} ${cv} → ${pv}${changed ? '  *' : ''}`);
  }
  return lines.join('\n');
}

/**
 * Render a REDACTED evidence summary.
 * Shows only counts, codes, ratios, and confidence — NEVER verbatim competitor text.
 *
 * @param {object} proposal   the voice-calibration proposal record
 * @param {function} redactFn  the configured redactor
 * @returns {string}
 */
function renderEvidenceSummary(proposal, redactFn) {
  const confidence = typeof proposal.confidence === 'number' ? proposal.confidence : '?';
  const evidence = (proposal && proposal.evidence) || {};
  const count = evidence.count || (
    Array.isArray(proposal.source_signals)
      ? proposal.source_signals.reduce((s, sig) => s + (sig.count || 0), 0)
      : 0
  );

  const lines = [
    `  confidence:  ${confidence}`,
    `  sample_size: ${count} competitor item(s)`,
  ];

  // Show top archetype codes from proposed_diff_structured (codes only, no verbatim text).
  const structured = proposal && proposal.proposed_diff_structured;
  if (structured && structured.archetype_emphasis && Array.isArray(structured.archetype_emphasis.proposed)) {
    const topCodes = structured.archetype_emphasis.proposed
      .filter((e) => e.weight > 2)
      .map((e) => redactFn(String(e.code || '')))
      .slice(0, 5);
    if (topCodes.length > 0) {
      lines.push(`  top_archetypes: ${topCodes.join(', ')}`);
    }
  }

  // Show drama signal without competitor text.
  if (structured && structured.drama_dial) {
    const { current, proposed: prop } = structured.drama_dial;
    lines.push(`  drama_dial:  ${redactFn(String(current))} → ${redactFn(String(prop))}`);
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// displayCalibrationCard — the public entry point
// ---------------------------------------------------------------------------

/**
 * Render a calibration card suitable for CLI and Discord display.
 *
 * SAFETY: ALL output is redacted with buildRedactor. No verbatim competitor text ever appears.
 * The card shows current->proposed per axis, a confidence line, and a yes/no consent question.
 *
 * @param {object|null} proposal  the voice-calibration proposal record (from proposeVoiceCalibration)
 * @param {object|string[]} [env]  process.env override OR array of private_terms (for tests)
 * @param {object} [opts]
 * @param {string[]} [opts.privateTerms]  additional private terms to strip
 * @returns {{ cliPrompt: string, discordEmbed?: object }}
 */
function displayCalibrationCard(proposal, env, opts = {}) {
  // Resolve private terms for redaction.
  let privateTerms = [];
  if (Array.isArray(env)) {
    // Test shorthand: pass private_terms directly as an array.
    privateTerms = env;
    env = process.env;
  } else {
    env = env || process.env;
    if (Array.isArray(opts.privateTerms)) privateTerms = opts.privateTerms;
  }

  const redactFn = buildRedactor(privateTerms);

  // Handle no pending proposal.
  if (!proposal || typeof proposal !== 'object') {
    const msg = 'No pending voice-calibration proposal found.\nRun `engine competitor-scan --brand <id>` first.';
    return { cliPrompt: msg };
  }

  const diff = proposal.proposed_diff_structured ||
    (typeof proposal.proposed_diff === 'string'
      ? safeParseJson(proposal.proposed_diff)
      : proposal.proposed_diff) || {};

  const brandId = typeof proposal.target_artifact === 'string'
    ? proposal.target_artifact.replace(/^brand:/, '').replace(/:voice$/, '')
    : 'unknown';
  const status = proposal.status || 'proposed';
  // Render the rationale only when the record was produced with the P1 verbatim guard in place
  // (evidenced by scan_freshness_expires_at, which propose.js persists after the guard runs).
  // Pre-fix records without this marker get a safe placeholder instead of potentially unsafe prose.
  const rationaleGuaranteedClean = Boolean(proposal.scan_freshness_expires_at);
  const rationale = rationaleGuaranteedClean && typeof proposal.rationale === 'string'
    ? redactFn(proposal.rationale)
    : (typeof proposal.rationale === 'string' && !proposal.scan_freshness_expires_at
      ? '(rationale omitted — re-run engine competitor-scan to generate a P1-verified proposal)'
      : '(deterministic rationale not available)');

  // Build the CLI prompt.
  const lines = [
    '╔══════════════════════════════════════════════════════════════════╗',
    `║  VOICE CALIBRATION PROPOSAL  —  brand: ${redactFn(brandId).padEnd(24)}║`,
    `║  status: ${String(status).padEnd(57)}║`,
    '╚══════════════════════════════════════════════════════════════════╝',
    '',
    'PROPOSED CHANGES (current → proposed):',
    '─────────────────────────────────────',
    renderDramaDialLine(diff),
    '',
    renderArchetypeEmphasis(diff),
    '',
    renderHookPreferences(diff),
    '',
    renderCadencePreferences(diff),
    '',
    'EVIDENCE SUMMARY (redacted):',
    '─────────────────────────────────────',
    renderEvidenceSummary(proposal, redactFn),
    '',
    'RATIONALE:',
    '─────────────────────────────────────',
    redactFn(rationale),
    '',
    '* = changed from current value',
    '',
    '─────────────────────────────────────',
    'GOVERNANCE: This is a HUMAN-ONLY operation. Gate/rule/threshold fields are never touched.',
    'To apply: engine voice-calibrate --brand <id> --apply --consent',
    'To dismiss: engine voice-calibrate --brand <id> (no --apply)',
    '',
    'Do you wish to apply this calibration? [y/N] (pass --consent to apply explicitly)',
  ];

  const cliPrompt = lines.join('\n');

  // Discord embed (optional, for Discord surface).
  const discordEmbed = buildDiscordEmbed(proposal, diff, redactFn, brandId, rationale);

  return { cliPrompt, discordEmbed };
}

/**
 * Build a Discord embed for the calibration card. Returns null when display is CLI-only.
 * NEVER includes verbatim competitor text — only labels, codes, counts, confidence.
 */
function buildDiscordEmbed(proposal, diff, redactFn, brandId, rationale) {
  const confidence = typeof proposal.confidence === 'number' ? proposal.confidence : '?';
  const structured = proposal.proposed_diff_structured || diff || {};

  // Drama dial summary.
  const dramaDial = structured.drama_dial
    ? `${redactFn(String(structured.drama_dial.current || '?'))} → ${redactFn(String(structured.drama_dial.proposed || '?'))}`
    : '(not set)';

  // Top archetype codes that changed.
  const archChanges = [];
  if (structured.archetype_emphasis) {
    const cur = Array.isArray(structured.archetype_emphasis.current) ? structured.archetype_emphasis.current : [];
    const prop = Array.isArray(structured.archetype_emphasis.proposed) ? structured.archetype_emphasis.proposed : [];
    for (const pe of prop) {
      const ce = cur.find((e) => e.code === pe.code);
      if (!ce || ce.weight !== pe.weight) {
        archChanges.push(`${redactFn(String(pe.code))}: ${ce ? ce.weight : '—'} → ${pe.weight}`);
      }
    }
  }

  // Hook changes.
  const hookChanges = [];
  if (structured.hook_preferences) {
    const cur = Array.isArray(structured.hook_preferences.current) ? structured.hook_preferences.current : [];
    const prop = Array.isArray(structured.hook_preferences.proposed) ? structured.hook_preferences.proposed : [];
    for (const pp of prop) {
      const cp = cur.find((p) => p.pattern === pp.pattern);
      if (!cp || cp.weight !== pp.weight) {
        hookChanges.push(`${redactFn(String(pp.pattern))}: ${cp ? cp.weight : '—'} → ${pp.weight}`);
      }
    }
  }

  const fields = [
    { name: 'drama_dial', value: dramaDial, inline: true },
    { name: 'confidence', value: String(confidence), inline: true },
  ];
  if (archChanges.length > 0) {
    fields.push({ name: 'archetype changes', value: archChanges.slice(0, 5).join('\n'), inline: false });
  }
  if (hookChanges.length > 0) {
    fields.push({ name: 'hook changes', value: hookChanges.slice(0, 5).join('\n'), inline: false });
  }
  if (rationale) {
    fields.push({ name: 'rationale', value: redactFn(rationale).slice(0, 400), inline: false });
  }
  fields.push({ name: 'consent', value: 'Apply with: `engine voice-calibrate --brand <id> --apply --consent`', inline: false });

  return {
    title: `Voice Calibration Proposal — ${redactFn(brandId)}`,
    color: 0x5865F2, // Discord blurple
    description: 'HUMAN-ONLY — gate/rule/threshold fields are NEVER touched.',
    fields,
    footer: { text: 'status: proposed | target_mutability: human-only' },
  };
}

// ---------------------------------------------------------------------------
// captureConsent
// ---------------------------------------------------------------------------

/**
 * Capture consent from the command context. Reads ONLY the explicit --consent flag.
 * NEVER defaults to true — consent must be explicitly provided.
 *
 * @param {object} ctx  command context { flags }
 * @returns {boolean}   true only when --consent was explicitly passed as true
 */
function captureConsent(ctx) {
  const flags = (ctx && ctx.flags) || {};
  const consent = flags.consent;
  // Only accept explicit boolean true or the string 'true'. Default is false.
  if (consent === true) return true;
  if (typeof consent === 'string' && consent.toLowerCase() === 'true') return true;
  return false;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function safeParseJson(str) {
  try { return JSON.parse(str); } catch { return null; }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  displayCalibrationCard,
  captureConsent,
  buildRedactor,
  // Renderers exposed for tests.
  renderDramaDialLine,
  renderArchetypeEmphasis,
  renderHookPreferences,
  renderCadencePreferences,
  renderEvidenceSummary,
};
