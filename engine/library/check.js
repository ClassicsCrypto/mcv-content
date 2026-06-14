'use strict';

/**
 * engine/library/check.js  [A adapted]
 *
 * Library retrieval — the §7.8 Retrieval Query/Result contract (release-spec §7.8; model §2
 * Retrieval Query/Result; model §10 #5). Given a query it scores every archive-index entry,
 * returns ranked candidates (each with a similarity score, a plain-language rationale, a
 * cooldown status, and any retrieval risk codes), and derives the media decision the
 * candidate set implies: reuse an owned asset, modify (crop/edit) one, or generate fresh.
 *
 * What this port keeps from production (the correct behavior):
 *   - Evidence-weighted token similarity over the index entry's describable fields, with a
 *     whole-phrase bonus and a query-size-normalized 0..1 score.
 *   - The reuse/modify/generate decision ladder driven by similarity thresholds, cooldown,
 *     overuse, and per-candidate risk flags.
 *   - The cooldown filter as enforcement point 1 of the three §8.6 points — read through the
 *     SINGLE canonical ledger (engine/library/usage-log.js), not any private workflow scrape.
 *
 * What this port deliberately drops (instance specifics — regenerate-never-redact, §0.3):
 *   - All hardcoded brand/world lane heuristics (per-collection "modify lane" rules,
 *     operator-proof contexts, named-asset contextual blocks, brand-synonym tables). Those
 *     were calibrated judgment for one instance (DD-9: calibrated heuristics stay private).
 *     The public engine ships the CONTRACT and a brand-neutral default decision ladder;
 *     operators tune thresholds via config and risk rules via rules/.
 *   - Reading usage from the live queue file and Discord preview residue (the production
 *     multi-source read). Cooldown reads exactly one ledger now (DD-14).
 *
 * Empty-library mode (DD-21): if no index is present (or it has no assets), retrieval returns
 * a generate-only decision and an empty candidate list — it never throws. Nothing in the
 * chain hard-depends on a populated index (reverses the production hard index dependency,
 * gap §2.2 cold-start row).
 *
 * Brand/world scoping and visual-model descriptions are NOT this module's job: the index
 * entry's `description`/`tags` come from the visual-model seam (§12.5), and brand gating is
 * a risk rule, not hardcoded here. All paths resolve through engine/shared/paths.js.
 */

const fs = require('fs');
const path = require('path');
const paths = require('../shared/paths.js');
const usageLog = require('./usage-log.js');

/**
 * Default decision thresholds (release-spec §8.5/§8.6 ladder). Brand/instance overrides ride
 * config; these are the day-one-usable defaults so an operator gets sensible behavior before
 * any calibration (DR W#24). No calibrated weights — DD-9 ceiling.
 */
const DEFAULTS = Object.freeze({
  reuseSimilarity: 0.85, // >= this and no edit-required flags ⇒ REUSE
  modifySimilarity: 0.6, // >= this (below reuse) ⇒ MODIFY
  generateBelow: 0.6, // below this ⇒ GENERATE fresh
  overuseTarget: 3, // more uses than this inside the target window ⇒ treat as overused
  hardCooldownDays: 14, // §8.6 hard floor (config-supplied)
  targetCooldownDays: 30, // §8.6 target window (config-supplied)
  limit: 10,
});

/** Risk codes the retrieval layer can flag (public, brand-neutral). The retrieval-lab's
 * false-positive / false-negative calibration codes do NOT ship in the runtime (DD-9); these
 * are the generic structural ones a default engine can detect without instance knowledge. */
const RISK = Object.freeze({
  NEVER_REUSE: 'NEVER_REUSE',
  REQUIRES_MODIFICATION: 'REQUIRES_MODIFICATION',
  HAS_VISIBLE_TEXT: 'HAS_VISIBLE_TEXT',
  COOLDOWN_BLOCKED: 'COOLDOWN_BLOCKED',
  OVERUSED: 'OVERUSED',
  LOW_CONFIDENCE: 'LOW_CONFIDENCE',
  WRONG_MEDIA_TYPE: 'WRONG_MEDIA_TYPE',
});

/** Risk codes that hard-block direct reuse of a candidate (it may still be a modify base). */
const HARD_BLOCK_CODES = new Set([RISK.NEVER_REUSE]);

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'from', 'has',
  'have', 'in', 'into', 'is', 'it', 'its', 'of', 'on', 'or', 'our', 'show',
  'that', 'the', 'this', 'to', 'use', 'with', 'without', 'make', 'create',
  'image', 'video', 'asset', 'post', 'content', 'social',
]);

/** Normalize a free token: lower-case, collapse separators, keep trait `k:v` colon form. */
function normalizeToken(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/['"]/gu, '')
    .replace(/&/gu, ' and ')
    .replace(/[^a-z0-9:]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
}

/** Tokenize text into a deduped set of search tokens (stopwords + 1-char tokens dropped). */
function tokenize(text) {
  const raw = String(text || '')
    .toLowerCase()
    .replace(/([a-z]+):([a-z0-9-]+)/gu, ' $1:$2 $2 ')
    .split(/[^a-z0-9:]+/gu)
    .map(normalizeToken)
    .filter((t) => t && t.length > 1 && !STOPWORDS.has(t));
  return [...new Set(raw)];
}

/** Add fuzzy (tokenized) evidence under a weight + source label. */
function addEvidence(map, value, weight, source) {
  const tokens = Array.isArray(value) ? value.flatMap(tokenize) : tokenize(value);
  for (const token of tokens) {
    if (!map.has(token)) map.set(token, { weight: 0, sources: new Set() });
    const e = map.get(token);
    e.weight += weight;
    e.sources.add(source);
  }
}

/** Add exact (single-token) evidence — used for enum-like fields (tags, type, source_class). */
function addExactEvidence(map, values, weight, source) {
  const arr = Array.isArray(values) ? values : [values];
  for (const value of arr) {
    const exact = normalizeToken(value);
    if (!exact) continue;
    if (!map.has(exact)) map.set(exact, { weight: 0, sources: new Set() });
    const e = map.get(exact);
    e.weight += weight;
    e.sources.add(source);
  }
}

/**
 * Build the evidence map for an archive index entry. Fields are the §7.8 / archive-index-entry
 * shape plus the optional describable fields a visual-model description may populate. Weights
 * favor model-supplied semantic fields (description, tags) over incidental ones (path).
 */
function buildEvidence(entry) {
  const evidence = new Map();
  addExactEvidence(evidence, entry.tags || [], 4.0, 'tags');
  addEvidence(evidence, entry.description || '', 3.0, 'description');
  addEvidence(evidence, entry.filename || path.basename(entry.path || ''), 0.7, 'filename');
  addEvidence(evidence, entry.path || '', 0.5, 'path');
  addExactEvidence(evidence, entry.type || '', 2.5, 'type');
  addExactEvidence(evidence, entry.source_class || '', 1.5, 'source_class');
  addEvidence(evidence, entry.character_refs || [], 2.6, 'character_refs');
  return evidence;
}

/** Asset id for an index entry (explicit asset_id, else its CONTENT_HOME-relative path). */
function entryAssetId(entry) {
  return entry.asset_id || usageLog.normalizeAssetId(entry.path || '');
}

/** Does an entry's media type satisfy a requested media_type filter? */
function mediaTypeMatches(entry, mediaType) {
  if (!mediaType) return true;
  const want = String(mediaType).toLowerCase();
  const have = String(entry.type || '').toLowerCase();
  if (want === have) return true;
  // Treat gif/animated_image/motion as interchangeable time-based-ish stills.
  const animated = new Set(['gif', 'animated_image', 'motion']);
  return animated.has(want) && animated.has(have);
}

/** Compute the retrieval risk codes for a scored candidate (brand-neutral, structural). */
function riskCodesFor(entry, score, cooldown, opts) {
  const codes = [];
  const reuseMode = String(entry.reuse_mode || '').toLowerCase();
  if (reuseMode === 'never_reuse') codes.push(RISK.NEVER_REUSE);
  if (['modify_only', 'reference_only'].includes(reuseMode)) codes.push(RISK.REQUIRES_MODIFICATION);
  if (entry.has_visible_text || entry.text_detected) codes.push(RISK.REQUIRES_MODIFICATION);
  if (cooldown.cooldown_blocked) codes.push(RISK.COOLDOWN_BLOCKED);
  if (recentUseCountFor(entry, opts) > (opts.overuseTarget ?? DEFAULTS.overuseTarget)) {
    codes.push(RISK.OVERUSED);
  }
  if (typeof entry.confidence === 'number' && entry.confidence < 0.72) codes.push(RISK.LOW_CONFIDENCE);
  // Medium-similarity matches imply a crop/edit rather than direct reuse.
  if (score >= 0.6 && score < (opts.reuseSimilarity ?? DEFAULTS.reuseSimilarity)) {
    codes.push(RISK.REQUIRES_MODIFICATION);
  }
  return [...new Set(codes)];
}

function recentUseCountFor(entry, opts) {
  return usageLog.recentUseCount(entryAssetId(entry), opts.targetCooldownDays ?? DEFAULTS.targetCooldownDays, {
    records: opts._ledger,
    now: opts.now,
    excludeContentId: opts.excludeContentId,
  });
}

/**
 * Score one index entry against the query. Returns a candidate object (the public
 * retrieval-result candidate shape, plus internal fields the decision ladder reads), or null
 * if the entry does not match at all / is filtered out.
 */
function scoreEntry(entry, queryTokens, phrase, opts) {
  if (!mediaTypeMatches(entry, opts.media_type)) return null;
  if (queryTokens.size === 0) return null;

  const evidence = buildEvidence(entry);
  let raw = 0;
  const matched = [];
  for (const q of queryTokens) {
    const hit = evidence.get(q);
    if (!hit) continue;
    raw += Math.min(hit.weight, 5.5);
    matched.push(q);
  }

  // Whole-phrase bonus for multi-word specific queries.
  if (phrase && phrase.length > 5) {
    const haystack = [entry.description, entry.path, path.basename(entry.path || ''), ...(entry.tags || [])]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    if (haystack.includes(phrase)) raw += 4;
  }

  const denom = Math.max(7, queryTokens.size * 3.8);
  const score = Math.min(1, raw / denom);
  if (score <= 0) return null;

  const assetId = entryAssetId(entry);
  const cooldown = usageLog.cooldownStatus(assetId, {
    hardDays: opts.hardCooldownDays ?? DEFAULTS.hardCooldownDays,
    records: opts._ledger,
    now: opts.now,
    excludeContentId: opts.excludeContentId,
  });
  const risk_codes = riskCodesFor(entry, score, cooldown, opts);
  const hard_blocks = risk_codes.filter((c) => HARD_BLOCK_CODES.has(c));
  // A cooled asset that is only reachable via an explicit override may be EDITED, never blindly
  // reused — so a cooldown block also implies reuse_requires_modification (release-spec §8.6).
  const reuse_requires_modification =
    risk_codes.includes(RISK.REQUIRES_MODIFICATION) ||
    cooldown.cooldown_blocked ||
    ['modify_only', 'reference_only'].includes(String(entry.reuse_mode || '').toLowerCase());

  return {
    asset_id: assetId,
    path: entry.path || null,
    score: Number(score.toFixed(4)),
    rationale: matched.length
      ? `matched ${matched.slice(0, 8).join(', ')}${matched.length > 8 ? '…' : ''}`
      : 'phrase match',
    cooldown_status: cooldown,
    risk_codes,
    hard_blocks,
    reuse_requires_modification,
    // Internal-only fields (not part of the persisted candidate schema; stripped on emit).
    _overused: risk_codes.includes(RISK.OVERUSED),
    _matched_terms: matched,
  };
}

/** Is a candidate selectable for a direct decision (not hard-blocked / cooled / overused)? */
function candidateBlocked(candidate, opts) {
  if (candidate.hard_blocks.length) return true;
  if (candidate.cooldown_status.cooldown_blocked && !opts.allow_cooldown_override) return true;
  if (candidate._overused) return true;
  return false;
}

/** Skip reason for a higher-ranked but unselected candidate (media-decision skip enum). */
function skipReason(candidate) {
  if (candidate.hard_blocks.length) return 'hard_block';
  if (candidate.cooldown_status.cooldown_blocked) return 'cooldown';
  if (candidate._overused) return 'overuse';
  return 'not_selected';
}

/** Summarize a skipped candidate (media-decision skipped_candidates item shape). */
function skippedSummary(candidate) {
  return {
    asset_id: candidate.asset_id,
    score: candidate.score,
    reason: skipReason(candidate),
    risk_codes: candidate.risk_codes,
  };
}

/**
 * Map the usage-log cooldown status onto the strict retrieval-result `cooldown_status` block
 * (schemas/artifacts/retrieval-result.schema.json, additionalProperties:false).
 */
function emitCooldownStatus(cs) {
  const out = {
    eligible: cs.eligible,
    cooldown_blocked: cs.cooldown_blocked,
    cooldown_days: cs.cooldown_days,
    recent_use_count: cs.recent_use_count,
    days_since_last_use: cs.days_since_last_use,
    duplicate_of_recent_use: Boolean(cs.duplicate_of_recent_use),
  };
  out.last_use = cs.last_use
    ? {
        content_id: cs.last_use.content_id,
        platform: cs.last_use.platform,
        used_at: cs.last_use.used_at,
        match_reason: cs.last_use.match_reason,
      }
    : null;
  return out;
}

/** Strip internal-only fields + conform cooldown_status so the candidate matches the schema. */
function emitCandidate(candidate) {
  const { _overused, _matched_terms, cooldown_status, ...rest } = candidate;
  return { ...rest, cooldown_status: emitCooldownStatus(cooldown_status) };
}

/**
 * Load the archive index from $CONTENT_HOME/library/index.json. Empty-library mode (DD-21):
 * a missing or unreadable index returns { assets: [] } — never throws.
 * @param {object} [env]
 * @returns {{assets: Array<object>}}
 */
function loadIndex(env = process.env) {
  const file = paths.libraryIndex(env);
  if (!fs.existsSync(file)) return { assets: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { assets: Array.isArray(parsed.assets) ? parsed.assets : [] };
  } catch {
    return { assets: [] };
  }
}

/**
 * Run a retrieval query and produce the §7.8 result (release-spec §7.8).
 *
 * @param {object} query
 * @param {string} [query.query]        free-text visual search.
 * @param {string[]} [query.tags]       tag/keyword filters.
 * @param {string} [query.media_type]   image | video | gif | motion | animated_image.
 * @param {string} [query.brand]        brand scope (carried through to the result query block).
 * @param {string} [query.theme]
 * @param {string} [query.archetype]
 * @param {object} [options]
 * @param {Array<object>} [options.index]   pre-loaded index assets (else read from CONTENT_HOME).
 * @param {Array<object>} [options.ledger]  pre-read usage ledger (else read from CONTENT_HOME).
 * @param {object} [options.config]     decision thresholds + cooldown days (overrides DEFAULTS).
 * @param {number} [options.limit]      max candidates returned (default 10).
 * @param {boolean} [options.allow_cooldown_override]  permit a human-approved in-cooldown modify.
 * @param {string} [options.excludeContentId]  ignore this item's own prior uses.
 * @param {number} [options.now]        clock override (ms) for deterministic tests.
 * @param {object} [options.env]
 * @returns {object} retrieval-result-shaped object (query, candidates[], decision, total_matches).
 */
function check(query = {}, options = {}) {
  const env = options.env || process.env;
  const cfg = { ...DEFAULTS, ...(options.config || {}) };
  const limit = options.limit ?? cfg.limit ?? DEFAULTS.limit;

  const assets = options.index || loadIndex(env).assets;
  const ledger = options.ledger || usageLog.readLedger(env);

  const opts = {
    ...cfg,
    media_type: query.media_type || null,
    allow_cooldown_override: Boolean(options.allow_cooldown_override),
    excludeContentId: options.excludeContentId || null,
    now: options.now,
    _ledger: ledger,
    reuseSimilarity: cfg.reuseSimilarity,
    overuseTarget: cfg.overuseTarget,
    hardCooldownDays: cfg.hardCooldownDays,
    targetCooldownDays: cfg.targetCooldownDays,
  };

  const queryTokens = new Set([...tokenize(query.query), ...(query.tags || []).flatMap(tokenize)]);
  const phrase = String(query.query || '').toLowerCase().trim();

  const scored = [];
  for (const entry of assets) {
    const candidate = scoreEntry(entry, queryTokens, phrase, opts);
    if (candidate) scored.push(candidate);
  }

  scored.sort(
    (a, b) =>
      b.score - a.score ||
      String(a.path || a.asset_id || '').localeCompare(String(b.path || b.asset_id || ''), undefined, { numeric: true }),
  );

  const totalMatches = scored.length;
  const top = scored.slice(0, limit);

  // Pick the best SELECTABLE candidate (first not hard-blocked / cooled / overused).
  const firstSelectable = top.find((c) => !candidateBlocked(c, opts)) || null;
  const best = firstSelectable;

  const queryBlock = {};
  for (const k of ['brand', 'theme', 'archetype', 'media_type']) {
    if (query[k]) queryBlock[k] = query[k];
  }
  if (query.tags && query.tags.length) queryBlock.tags = [...query.tags];

  const rich = decide(best, top, opts);

  // The retrieval-result schema's `decision` block is intentionally minimal
  // (additionalProperties:false → only action/reason/chosen_asset_id). The richer decision
  // metadata (skipped candidates, override/manual-override flags) belongs to the downstream
  // media-decision record (schemas/artifacts/media-decision.schema.json), which the media seat
  // composes via buildMediaDecision(); it is NOT spilled into the retrieval-result. The rich
  // object is attached non-enumerably so a media-seat caller can reach it without polluting the
  // schema-validated result (Object.keys / JSON.stringify still see only the four spec fields).
  const decision = { action: rich.action, reason: rich.reason };
  if (rich.chosen_asset_id) decision.chosen_asset_id = rich.chosen_asset_id;

  const result = {
    query: queryBlock,
    candidates: top.map(emitCandidate),
    decision,
    total_matches: totalMatches,
  };
  Object.defineProperty(result, '_richDecision', { value: rich, enumerable: false });
  return result;
}

/**
 * Run a retrieval query and return the media-decision record (§9.2 media→packager handoff;
 * schemas/artifacts/media-decision.schema.json) — the rich-path API the media seat uses. It
 * carries skipped_candidates, the cooldown_ref, and override detail that the minimal
 * retrieval-result `decision` omits.
 * @param {object} query  see check().
 * @param {object} meta   `{content_id, brand?, platform?, candidates_ref?}`.
 * @param {object} [options]  see check().
 * @returns {{result: object, mediaDecision: object}}
 */
function decideMedia(query = {}, meta = {}, options = {}) {
  const result = check(query, options);
  const mediaDecision = buildMediaDecision(result, meta, result._richDecision);
  return { result, mediaDecision };
}

/**
 * Derive the reuse/modify/generate decision from the selected candidate (brand-neutral ladder).
 * Returns a RICH internal decision (with skip/override metadata); check() emits a schema-strict
 * subset and buildMediaDecision() uses the full object.
 */
function decide(best, top, opts) {
  if (!best) {
    // No selectable candidate. Distinguish "nothing matched" from "all matches blocked".
    if (top.length === 0) {
      return { action: 'generate', reason: 'No matching assets in library.' };
    }
    const blocker = top[0];
    if (blocker.hard_blocks.length) {
      return {
        action: 'generate',
        reason: `Top candidate hard-blocked (${blocker.hard_blocks.join(', ')}).`,
        skipped_candidates: top.map(skippedSummary),
      };
    }
    if (blocker.cooldown_status.cooldown_blocked) {
      return {
        action: 'generate',
        reason: 'Top candidate is inside its reuse cooldown; generate fresh or approve an override.',
        manual_override_required: 'cooldown',
        skipped_candidates: top.map(skippedSummary),
      };
    }
    return { action: 'generate', reason: 'No eligible candidate; generate fresh.', skipped_candidates: top.map(skippedSummary) };
  }

  const pct = (best.score * 100).toFixed(0);
  const decision = {};
  const cooledOverridden = best.cooldown_status.cooldown_blocked && opts.allow_cooldown_override;

  if (best.score >= (opts.reuseSimilarity ?? DEFAULTS.reuseSimilarity) && !best.reuse_requires_modification) {
    decision.action = 'reuse';
    decision.reason = `High similarity (${pct}%) and no edit-required flags.`;
    decision.chosen_asset_id = best.asset_id;
  } else if (best.score >= (opts.modifySimilarity ?? DEFAULTS.modifySimilarity)) {
    decision.action = 'modify';
    decision.reason = `Candidate (${pct}%) should be cropped/edited before use.`;
    decision.chosen_asset_id = best.asset_id;
    if (cooledOverridden) decision.cooldown_override_applied = true;
  } else {
    decision.action = 'generate';
    decision.reason = `Best match only ${pct}% similar; generate new with owned references.`;
  }

  // Record any higher-ranked candidates skipped to reach `best`.
  const bestIndex = top.indexOf(best);
  if (bestIndex > 0) {
    decision.skipped_candidates = top.slice(0, bestIndex).map(skippedSummary);
  }
  return decision;
}

/**
 * Compose a media-decision record (schemas/artifacts/media-decision.schema.json) from a
 * retrieval result plus the rich decision — the media→packager handoff artifact (§9.2). This
 * is where skipped_candidates and the cooldown_ref (with override_applied) live, since the
 * retrieval-result schema keeps `decision` minimal. The chosen candidate's cooldown status is
 * looked up from the result's candidate list.
 *
 * @param {object} result  the output of check().
 * @param {object} meta    `{content_id, brand?, platform?, candidates_ref?}`.
 * @param {object} [rich]  the rich decision (from a paired check() call that retained it);
 *   when omitted, the minimal result.decision is used (no skip/override detail).
 * @returns {object} media-decision-shaped record.
 */
function buildMediaDecision(result, meta = {}, rich = result.decision) {
  const record = {
    content_id: meta.content_id,
    query: result.query,
    action: rich.action,
  };
  if (meta.brand) record.brand = meta.brand;
  if (meta.platform) record.platform = meta.platform;
  if (meta.candidates_ref) record.candidates_ref = meta.candidates_ref;
  if (rich.reason) record.reason = rich.reason;

  if (rich.chosen_asset_id) {
    record.chosen_asset_id = rich.chosen_asset_id;
    const chosen = result.candidates.find((c) => c.asset_id === rich.chosen_asset_id);
    if (chosen) {
      if (chosen.path) record.chosen_asset_ref = chosen.path;
      record.cooldown_ref = {
        asset_id: chosen.asset_id,
        eligible: chosen.cooldown_status.eligible,
        cooldown_blocked: chosen.cooldown_status.cooldown_blocked,
        cooldown_days: chosen.cooldown_status.cooldown_days,
        override_applied: Boolean(rich.cooldown_override_applied),
      };
    }
  }
  if (rich.skipped_candidates && rich.skipped_candidates.length) {
    record.skipped_candidates = rich.skipped_candidates;
  }
  record.decided_at = new Date().toISOString();
  return record;
}

module.exports = {
  DEFAULTS,
  RISK,
  HARD_BLOCK_CODES,
  tokenize,
  normalizeToken,
  buildEvidence,
  loadIndex,
  check,
  decideMedia,
  buildMediaDecision,
};
