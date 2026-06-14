'use strict';

/**
 * engine/orchestrator/mode.js  [N net-new — normalizes the production posture model]
 *
 * The single mode-resolution authority for the SAFE → LIVE_PREVIEW → LIVE ladder
 * (release-spec §8.3 normative ladder; RD-16f default SAFE; §6.1 MODE field default SAFE).
 *
 * One rule, everywhere (the RD-16f resolution of the production SAFE-vs-LIVE contradiction —
 * production orchestrator rules 7-8 defaulted LIVE while the operator-command validation
 * defaulted SAFE; the engine resolves that fail-closed to SAFE):
 *
 *   - The effective mode is the FIRST resolvable of: an explicit per-command/per-run override,
 *     then config/system.json `mode`, then the SAFE default.
 *   - An unknown / malformed value falls CLOSED to SAFE — never silently to a more permissive
 *     mode (a typo in config can only ever make the engine safer, never accidentally LIVE).
 *   - The §4.5 posture env vars (ENGINE_MODE) are documented DIAGNOSTIC overrides, loud at
 *     startup; safety posture lives in config, not in scheduler wrappers (§8.4). resolveMode()
 *     honors the env override but reports that it was the source so the caller can log it loudly.
 *
 * The mode ladder's behavioral contract (what each rung permits), encoded as data so the
 * executor, listener, kickoff, and seat templates all consult ONE definition (§8.3):
 *
 *   SAFE         — artifacts only. No approval-surface posts, no publisher calls.
 *   LIVE_PREVIEW — real approval cards posted; publishing disabled (no publisher call).
 *   LIVE         — full pipeline; publisher handoff DRAFT-ONLY by default (the second gate):
 *                  approve → executor creates a draft → `handed_off` → operator publishes in
 *                  the publisher → executor's verifyStatus poll advances `handed_off → published`.
 *                  "Approved but nothing posted yet" (`handed_off`) is the EXPECTED LIVE state.
 *
 * This module is pure: it reads an env/config object and returns a verdict. It performs no I/O,
 * constructs no paths, and carries no Tier-3 instance values or production codenames (§0.3 r6).
 * The executor (publish-executor.js) keeps its own copy of resolveMode for its hot path; this
 * module is the canonical definition that copy conforms to and that kickoff/dispatch/CLI share.
 */

/** The ladder, least → most permissive. Index is the permissiveness rank. */
const MODES = Object.freeze(['SAFE', 'LIVE_PREVIEW', 'LIVE']);

/** The fail-closed default for a fresh install (RD-16f; §8.3). */
const DEFAULT_MODE = 'SAFE';

/**
 * The per-mode behavioral contract (§8.3) — what each rung permits. Consulted by every surface
 * so the ladder is defined once. `posts_cards` gates approval-surface output; `calls_publisher`
 * gates any publisher-adapter handoff; `draft_only` records that LIVE is second-gate draft-only.
 */
const MODE_BEHAVIOR = Object.freeze({
  SAFE: Object.freeze({
    posts_cards: false,
    calls_publisher: false,
    draft_only: true,
    description: 'artifacts only; no approval-surface posts, no publisher calls',
  }),
  LIVE_PREVIEW: Object.freeze({
    posts_cards: true,
    calls_publisher: false,
    draft_only: true,
    description: 'real approval cards posted; publishing disabled',
  }),
  LIVE: Object.freeze({
    posts_cards: true,
    calls_publisher: true,
    draft_only: true,
    description: 'full pipeline; publisher handoff draft-only (the second gate)',
  }),
});

/** The §4.5 diagnostic posture override env var (loud, documented). */
const MODE_ENV_VAR = 'ENGINE_MODE';

/**
 * Normalize any candidate to a valid ladder value, falling CLOSED to SAFE for null/unknown.
 * @param {*} candidate
 * @returns {'SAFE'|'LIVE_PREVIEW'|'LIVE'}
 */
function normalizeMode(candidate) {
  if (candidate == null) return DEFAULT_MODE;
  const upper = String(candidate).trim().toUpperCase();
  return MODES.includes(upper) ? upper : DEFAULT_MODE;
}

/** True iff `candidate` is one of the three ladder values (case-insensitive). */
function isValidMode(candidate) {
  return candidate != null && MODES.includes(String(candidate).trim().toUpperCase());
}

/**
 * Resolve the effective mode for a run, with provenance so the caller can log the env override
 * loudly (§4.5). Precedence: explicit override > ENGINE_MODE env > config.mode > SAFE.
 *
 * @param {object}  [opts]
 * @param {string}  [opts.override]  an explicit per-command/per-run mode (highest precedence)
 * @param {object}  [opts.config]    parsed config/system.json (reads .mode)
 * @param {object}  [opts.env]       environment (reads ENGINE_MODE) — default process.env
 * @returns {{ mode:string, source:'override'|'env'|'config'|'default', invalid:boolean }}
 *          `invalid` is true when a non-null candidate was present but unrecognized (fell to SAFE).
 */
function resolveMode(opts = {}) {
  const env = opts.env || process.env;
  const config = opts.config || {};

  if (opts.override != null && String(opts.override).trim() !== '') {
    const norm = normalizeMode(opts.override);
    return { mode: norm, source: 'override', invalid: !isValidMode(opts.override) };
  }
  const envVal = env[MODE_ENV_VAR];
  if (envVal != null && String(envVal).trim() !== '') {
    const norm = normalizeMode(envVal);
    return { mode: norm, source: 'env', invalid: !isValidMode(envVal) };
  }
  if (config.mode != null && String(config.mode).trim() !== '') {
    const norm = normalizeMode(config.mode);
    return { mode: norm, source: 'config', invalid: !isValidMode(config.mode) };
  }
  return { mode: DEFAULT_MODE, source: 'default', invalid: false };
}

/** Set/override the run mode on a command-shaped object, returning a new object (no mutation). */
function setMode(command, mode) {
  return { ...(command || {}), mode: normalizeMode(mode) };
}

/** The behavior contract for a mode (falls closed to SAFE's contract for an unknown mode). */
function behaviorFor(mode) {
  return MODE_BEHAVIOR[normalizeMode(mode)];
}

/** True iff this mode permits posting real approval cards (LIVE_PREVIEW / LIVE). */
function postsCards(mode) {
  return behaviorFor(mode).posts_cards;
}

/** True iff this mode permits a publisher-adapter handoff (LIVE only). */
function callsPublisher(mode) {
  return behaviorFor(mode).calls_publisher;
}

/**
 * True iff `mode` is at least as permissive as `floor` on the ladder (e.g. atLeast('LIVE','LIVE_PREVIEW')
 * is true). Unknown values normalize to SAFE first, so the comparison is always well-defined.
 */
function atLeast(mode, floor) {
  return MODES.indexOf(normalizeMode(mode)) >= MODES.indexOf(normalizeMode(floor));
}

module.exports = {
  MODES,
  DEFAULT_MODE,
  MODE_BEHAVIOR,
  MODE_ENV_VAR,
  normalizeMode,
  isValidMode,
  resolveMode,
  setMode,
  behaviorFor,
  postsCards,
  callsPublisher,
  atLeast,
};
