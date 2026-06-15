'use strict';

/**
 * pipelines/shared.js  [N net-new — shared pipeline plumbing]
 *
 * The plumbing both lifecycle definitions (text-heavy.js, video-heavy.js) share: the run
 * context, the seat seam resolver, the artifact-contract assertions, the workflow-ledger event
 * helper, the deterministic-input builders (matcher input, lint rules, retrieval query), and
 * the ONE queue-write that lands a packaged item in `awaiting_approval` (§8.2 convergence).
 *
 * Keeping this here (rather than duplicated in each lifecycle) is the §8.1 "gate universality"
 * discipline at the plumbing level: both lifecycles converge on the SAME validating→packaged→
 * awaiting_approval states and the SAME queue writer, so the convergence cannot drift between
 * lanes. The gate COMPOSITION itself (runGate) lives in text-heavy.js and is imported by
 * video-heavy.js — one gate, two entry orders.
 *
 * Engine seams used (all already on disk; this module wires, never re-implements):
 *   - engine/shared/queue.js        the canonical locked queue writer (appendEntryBlock + lock)
 *   - engine/shared/paths.js        CONTENT_HOME path resolution (RD-3)
 *   - engine/orchestrator/workflow-ledger.js  the run-attribution / stage-state event stream
 *
 * Tier-3 cleanliness (§0.3 r6 / RD-3): no IDs/handles/absolute paths/brand strings; no
 * production persona codenames. Seats are named by the §9.1 neutral role vocabulary.
 */

const queue = require('../engine/shared/queue.js');

// The workflow ledger is best-effort observability (it no-ops with WORKFLOW_LEDGER_DISABLE=1
// and CONTENT_HOME-free). Loaded lazily so the pipelines run in a fixture/test harness with no
// CONTENT_HOME without a hard dependency.
let ledgerMod = null;
function ledger() {
  if (ledgerMod === null) {
    try {
      // eslint-disable-next-line global-require
      ledgerMod = require('../engine/orchestrator/workflow-ledger.js');
    } catch {
      ledgerMod = false;
    }
  }
  return ledgerMod || null;
}

const IMAGE_EXT_RE = /\.(?:png|jpe?g|webp|gif)$/iu;
const MEDIA_EXT_RE = /\.(?:png|jpe?g|webp|gif|mp4|mov|m4v|webm)$/iu;

/** Formats whose main artifact carries (or may carry) bound media in the text-heavy lane. */
const MEDIA_BEARING_FORMAT_RE = /(image|video|reel|short|carousel|gif|gallery|clip|\+\s*(image|video))/iu;

/** The valid §8.3 mode set; anything else falls closed to SAFE (RD-16f). */
const MODES = new Set(['SAFE', 'LIVE_PREVIEW', 'LIVE']);

// ---------------------------------------------------------------------------
// Seat seam
// ---------------------------------------------------------------------------

/** The §9.1 seat roles a lifecycle may dispatch. enricher is optional (RD-13). */
const SEAT_ROLES = Object.freeze(['matcher', 'enricher', 'writer', 'gate', 'media', 'packager']);

/**
 * Build a stub seat that throws a precise "unwired" error. The default pipeline uses these so a
 * host that forgot to wire a seat fails loudly at that stage rather than fabricating an artifact
 * (the engine never invents a seat output — RD-2/§4.3).
 */
function unwiredSeat(role) {
  return async () => {
    const err = new Error(
      `pipeline seat "${role}" is not wired. The engine does not call chain-seat LLMs (RD-2); ` +
        `the host runtime must inject seats via createPipeline({ seats: { ${role}: async (input) => artifact } }).`,
    );
    err.code = 'EUNWIREDSEAT';
    err.role = role;
    throw err;
  };
}

/** Resolve a seats map, filling unwired roles with throwing stubs. enricher/gate/media may stay null. */
function resolveSeats(seats = {}) {
  const out = {};
  for (const role of SEAT_ROLES) {
    if (typeof seats[role] === 'function') out[role] = seats[role];
    else if (role === 'enricher' || role === 'gate' || role === 'media') out[role] = seats[role] || null;
    else out[role] = unwiredSeat(role);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Run context
// ---------------------------------------------------------------------------

/** Derive a stable content id from the slot when one was not supplied. */
function deriveContentId(slot) {
  if (slot.content_id) return String(slot.content_id);
  const base = [slot.brand, slot.platform, slot.slot_ref || slot.slot_type || 'slot']
    .filter(Boolean)
    .join('-')
    .replace(/[^A-Za-z0-9_.-]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
  return `${base || 'item'}-${Date.now()}`;
}

/** Canonical mode (fail-closed to SAFE on anything unknown — RD-16f). */
function canonicalMode(value) {
  const v = String(value || 'SAFE').toUpperCase();
  return MODES.has(v) ? v : 'SAFE';
}

/**
 * Build the per-run context both lifecycles thread through their stages. It binds the resolved
 * seats, the engine config/env, and the normalized slot facts (content id, mode, content_form,
 * trend provenance). `content_form` defaults to standalone; a trend slot may carry quote-retweet
 * (DD-16). The trend report (when present) rides as Zone-U provenance for the matcher pre-seed.
 */
function makeRunCtx(slot, pipeline, lifecycle) {
  const content_id = deriveContentId(slot);
  return {
    lifecycle,
    slot,
    content_id,
    brand: slot.brand || null,
    platform: slot.platform || null,
    format: slot.format || null,
    mode: canonicalMode(slot.mode),
    slot_type: slot.slot_type || 'regular',
    content_form: slot.content_form || (slot.slot_type === 'trend' && slot.content_form === undefined ? 'standalone' : slot.content_form) || 'standalone',
    trend_report: slot.trend_report || null,
    trend_report_ref: slot.trend_report_ref || null,
    seats: pipeline.seats,
    config: pipeline.config || {},
    retrievalConfig: pipeline.retrievalConfig || {},
    visualProvider: pipeline.visualProvider || null,
    env: pipeline.env || process.env,
    pipeline,
  };
}

// ---------------------------------------------------------------------------
// Deterministic input builders
// ---------------------------------------------------------------------------

/**
 * The matcher's input artifact (orchestrator → matcher handoff, §9.2: the slot task). For a
 * TREND slot the submitted trend report's suggested angles are surfaced as Zone-U pre-seed
 * material (angles only — no drafted text, §8.8); the content_form is carried so quote-retweet
 * trends flow through the chain (DD-16).
 */
function matcherInput(ctx) {
  const input = {
    content_id: ctx.content_id,
    brand: ctx.brand,
    platform: ctx.platform,
    format: ctx.format,
    mode: ctx.mode,
    slot_ref: ctx.slot.slot_ref || null,
    slot_type: ctx.slot_type,
    content_form: ctx.content_form,
    archetype: ctx.slot.archetype || null,
    theme: ctx.slot.theme || null,
    pillar: ctx.slot.pillar || null,
    pre_seed_hint: ctx.slot.pre_seed || null,
  };
  if (ctx.slot_type === 'trend' && (ctx.trend_report || ctx.trend_report_ref)) {
    input.trend = {
      // Zone U always (trend reports are untrusted external input — §6.7). Only angles travel.
      trust_zone: 'U',
      report_ref: ctx.trend_report_ref || null,
      topics: trendAngles(ctx.trend_report),
    };
  }
  return input;
}

/** Extract suggested-angle material from a trend report (angles only; never drafted text). */
function trendAngles(report) {
  if (!report || !Array.isArray(report.topics)) return [];
  return report.topics.map((t) => ({
    topic: t.topic,
    suggested_angles: Array.isArray(t.suggested_angles) ? t.suggested_angles : [],
    source_links: Array.isArray(t.source_links) ? t.source_links : [],
  }));
}

/** The per-length framework reference the writer boot-reads (§9.3). Carried on the brief when set. */
function frameworkRefFor(brief) {
  if (brief && brief.framework_ref) return brief.framework_ref;
  return null; // host/brief supplies the concrete framework asset path; none is hardcoded.
}

/**
 * Build the rules object the deterministic pre-gate consumes (pre-gate-lint.lint's second arg).
 * Pulls the target-length window + variant count + historical entities from the brief, and the
 * banned-pattern list from config (the engine ships zero banned phrases — §10.3 / §0.3 r6; the
 * operator's $CONTENT_HOME list is unioned by the lint engine itself).
 */
function lintRules(ctx, brief) {
  const rules = { env: ctx.env };
  if (brief && Array.isArray(brief.target_chars)) rules.target_chars = brief.target_chars;
  else if (ctx.config && ctx.config.length_windows && ctx.platform && ctx.config.length_windows[ctx.platform]) {
    rules.target_chars = ctx.config.length_windows[ctx.platform];
  }
  if (brief && Number.isInteger(brief.variant_count)) rules.variant_count = brief.variant_count;
  if (brief && Array.isArray(brief.historical_entities)) rules.historical_entities = brief.historical_entities;
  // banned_patterns = the operator's global deny list UNIONED with the work-recap private-term deny
  // set, so the FORWARD deterministic gate (pre-gate-lint LINT.BANNED_PATTERN) enforces
  // config.work_recap.private_terms automatically — a writer-reintroduced configured private term is
  // caught on the first gate (no LLM spend), not only the post-edit re-gate / LLM judge. This makes
  // the privacy law's deterministic layer real on the forward path (§2.4 layer 3) without the
  // operator having to also copy the terms into banned_patterns. private_terms accepts a flat array
  // OR the { terms, secret_literals } object shape.
  const bannedSet = [];
  if (ctx.config && Array.isArray(ctx.config.banned_patterns)) bannedSet.push(...ctx.config.banned_patterns);
  const wrTerms = ctx.config && ctx.config.work_recap && ctx.config.work_recap.private_terms;
  if (Array.isArray(wrTerms)) {
    bannedSet.push(...wrTerms);
  } else if (wrTerms && typeof wrTerms === 'object') {
    if (Array.isArray(wrTerms.terms)) bannedSet.push(...wrTerms.terms);
    if (Array.isArray(wrTerms.secret_literals)) bannedSet.push(...wrTerms.secret_literals);
  }
  const cleanedBanned = bannedSet.map((t) => String(t == null ? '' : t).trim()).filter(Boolean);
  if (cleanedBanned.length) rules.banned_patterns = cleanedBanned;
  if (ctx.config && ctx.config.gate && ctx.config.gate.variant_distinctness) {
    rules.variant_distinctness = ctx.config.gate.variant_distinctness;
  }
  return rules;
}

/** Build the retrieval query (library/check.check's first arg) from the brief + draft. */
function mediaQuery(ctx, brief, draft) {
  const query = {};
  if (brief && brief.theme) query.theme = brief.theme;
  else if (ctx.slot.theme) query.theme = ctx.slot.theme;
  if (brief && brief.archetype) query.archetype = brief.archetype;
  if (ctx.brand) query.brand = ctx.brand;
  query.media_type = mediaTypeFor(ctx.format);
  // Free-text search: the matcher's angle + the draft's recommended variant text give the
  // retrieval scorer something to match against (the index entry descriptions/tags).
  const angle = brief && brief.pre_seed && brief.pre_seed.angle ? brief.pre_seed.angle : (ctx.slot.theme || '');
  const recommended = draft && Array.isArray(draft.variants) ? (draft.variants.find((v) => /recommend/i.test(v.label)) || draft.variants[0]) : null;
  query.query = [angle, recommended && recommended.text ? recommended.text.slice(0, 120) : '']
    .filter(Boolean)
    .join(' ')
    .trim();
  if (brief && Array.isArray(brief.media_tags)) query.tags = brief.media_tags;
  return query;
}

/** Map a content format to the retrieval media_type filter (library/check media_type enum). */
function mediaTypeFor(format) {
  const f = String(format || '').toLowerCase();
  if (/reel|short|video|clip/.test(f)) return 'video';
  if (/gif/.test(f)) return 'gif';
  if (/image|carousel|gallery|feed/.test(f)) return 'image';
  return undefined; // text-only: no media_type filter
}

/** Does a text-heavy format (potentially) carry media? Text-only formats skip the media stage. */
function formatNeedsMedia(format) {
  return MEDIA_BEARING_FORMAT_RE.test(String(format || ''));
}

function isImageRef(ref) {
  return IMAGE_EXT_RE.test(String(ref || ''));
}
function isMediaRef(ref) {
  return MEDIA_EXT_RE.test(String(ref || ''));
}

// ---------------------------------------------------------------------------
// Visual-check → package handoff
// ---------------------------------------------------------------------------

/**
 * Shape a visual-check validation-result for validate-package's `visualCheck` option
 * ({ exists, pass, rejection_code }). A skip / tool-error (vision_pass null) is treated as
 * NOT-pass with the first detected code as the rejection code (consumers never auto-pass null).
 */
function visualForPackage(visual) {
  if (!visual) return undefined;
  const x = visual['x-visual'] || {};
  const pass = x.vision_pass === true;
  const exists = x.vision_pass !== undefined; // a result was produced (pass / fail / skip)
  const rejection_code = pass ? null : ((visual.detected_codes && visual.detected_codes[0] && visual.detected_codes[0].code) || 'VIS.NOT_PASS');
  return { exists, pass, rejection_code };
}

// ---------------------------------------------------------------------------
// Artifact-contract assertions (fail-closed on a malformed seat output)
// ---------------------------------------------------------------------------

/**
 * Assert a seat produced a plausible artifact of the named kind with the required keys. This is
 * the §9.2 declared-artifact-contract check at the seam — a seat that returns junk is caught at
 * its handoff, not three stages later. (Full JSON-Schema validation is the schema-validation
 * runner's job; this is the cheap structural guard the chain needs to route correctly.)
 */
function assertArtifact(artifact, kind, requiredKeys) {
  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) {
    throw new Error(`pipeline: ${kind} seat returned a non-object artifact (§9.2 handoff contract)`);
  }
  for (const key of requiredKeys) {
    const v = artifact[key];
    const empty = v == null || (Array.isArray(v) && v.length === 0) || (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0);
    if (empty) {
      throw new Error(`pipeline: ${kind} artifact missing required "${key}" (§9.2 handoff contract)`);
    }
  }
  return artifact;
}

// ---------------------------------------------------------------------------
// Workflow-ledger event helper (stage-state tracking, §8.2 / §13.1)
// ---------------------------------------------------------------------------

/**
 * Record a stage-state event keyed by content-id (best-effort; never throws, never gates flow).
 * The `status` is a public §8.2 state name (validating, packaged, awaiting_approval, …); the
 * ledger normalizes/persists it. This is how the pre-packaging stage states are tracked (they
 * are NOT queue entries — the durable queue is authoritative only from packaging onward, §8.2).
 */
function ledgerEvent(contentId, eventType, patch, env) {
  const lg = ledger();
  if (!lg) return;
  try {
    lg.recordEvent(contentId, eventType, patch || {}, {}, env);
  } catch {
    // Observability is never a chain dependency (§13.1). A ledger write failure does not stop a run.
  }
}

// ---------------------------------------------------------------------------
// The ONE queue write — land a packaged item in awaiting_approval (§8.2)
// ---------------------------------------------------------------------------

/**
 * Serialize a §7.1 queue entry and append it to the canonical publish-queue under the ONE
 * canonical lock (§8.4 — queue writes happen exclusively through the engine's locked writer; no
 * seat touches the queue). The entry lands in `awaiting_approval`: the reviewer's first,
 * mandatory gate. The publisher-liaison surface posts the card and the executor handles handoff
 * — neither is the pipeline's job.
 *
 * Returns the in-memory entry fields (the appended block's parsed view) so callers can report it.
 * CONTENT_HOME-free harnesses (no queue path resolvable) get the entry object back WITHOUT a
 * disk write — the chain still "converges on awaiting_approval" in-memory for tests/fixtures.
 */
async function enqueueAwaitingApproval(ctx, { package: pkg, media, gate, validation, visual }) {
  const fields = buildQueueFields(ctx, { package: pkg, media, gate, visual });

  let queuePath;
  let lockPath;
  try {
    queuePath = queue.queueFilePath(ctx.env);
    lockPath = queue.queueLockFilePath(ctx.env);
  } catch {
    // CONTENT_HOME unset (fixture/test): return the entry shape without a disk write.
    return { fields, written: false };
  }

  const fs = require('fs');
  const path = require('path');
  fs.mkdirSync(path.dirname(queuePath), { recursive: true });
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  const entry = { header: ctx.content_id, fields };
  const block = queue.serializeEntry(entry);

  const lock = queue.acquireLockBlocking(lockPath, { owner: `pipeline:${ctx.lifecycle}`, timeoutMs: 30000 });
  try {
    queue.appendEntryBlock(queuePath, block);
  } finally {
    if (lock.acquired) queue.releaseLock(lockPath);
  }
  return { fields, written: true, queue_path: queuePath };
}

/**
 * Build the §7.1 queue-entry FIELD_ORDER-conformant fields for an item entering awaiting_approval.
 * Media refs / trend provenance / freshness window are populated when present (DD-15/DD-16). The
 * package_ref / media_refs are CONTENT_HOME-relative (absolute paths are forbidden, §7.1).
 */
function buildQueueFields(ctx, { package: pkg, media, gate, visual }) {
  const now = new Date().toISOString();
  const header = (pkg && pkg.audit_header) || {};
  const fields = {
    content_id: ctx.content_id,
    brand: ctx.brand || header.brand || null,
    platform: ctx.platform || header.platform || null,
    format: ctx.format || header.format || null,
    mode: ctx.mode,
    content_form: ctx.content_form || 'standalone',
    created_at: now,
    state: 'awaiting_approval',
    state_updated_at: now,
    package_ref: ctx.slot.package_ref || header.package_ref || null,
    media_refs: media && media.media_refs && media.media_refs.length ? JSON.stringify(media.media_refs) : 'null',
    gates: JSON.stringify({
      gate_verdict: gate ? gate.verdict : null,
      package_verdict: 'PASS',
      visual_pass: visual ? (visual['x-visual'] || {}).vision_pass ?? null : null,
    }),
  };
  // Trend variant fields (DD-15/DD-16): provenance ref + freshness-window expiry basis.
  if (ctx.slot_type === 'trend') {
    if (ctx.trend_report_ref) fields.trend_source_ref = ctx.trend_report_ref;
    const fw = ctx.trend_report && ctx.trend_report.freshness_window;
    if (fw && (fw.expires_at || fw.duration)) {
      fields.freshness_window = JSON.stringify(fw);
      fields.expires_basis = 'freshness_window';
    }
  }
  return fields;
}

// ---------------------------------------------------------------------------
// Routing + outcome
// ---------------------------------------------------------------------------

/** The first route target (which seat to route back to) from a validation-result's codes. */
function firstRoute(result) {
  const codes = result && Array.isArray(result.detected_codes) ? result.detected_codes : [];
  const hard = codes.find((c) => c.tier === 'hard' && c.route);
  if (hard) return hard.route;
  const any = codes.find((c) => c.route);
  return any ? any.route : null;
}

/** Compact gate summary for the run outcome (verdict + the codes that traveled). */
function gateSummary(gate, validation, visual) {
  return {
    gate_verdict: gate ? gate.verdict : null,
    package_verdict: validation ? validation.verdict : null,
    visual_pass: visual ? (visual['x-visual'] || {}).vision_pass ?? null : null,
    detected_codes: [
      ...(gate && gate.detected_codes ? gate.detected_codes.map((d) => d.code) : []),
      ...(validation && validation.detected_codes ? validation.detected_codes.map((d) => d.code) : []),
    ],
  };
}

/** Assemble the run outcome envelope both lifecycles return. */
function makeOutcome(ctx, partial) {
  return {
    lifecycle: ctx.lifecycle,
    content_id: ctx.content_id,
    brand: ctx.brand,
    platform: ctx.platform,
    mode: ctx.mode,
    content_form: ctx.content_form,
    ...partial,
  };
}

module.exports = {
  SEAT_ROLES,
  MODES,
  // seat seam
  resolveSeats,
  unwiredSeat,
  // context
  makeRunCtx,
  deriveContentId,
  canonicalMode,
  // deterministic input builders
  matcherInput,
  trendAngles,
  frameworkRefFor,
  lintRules,
  mediaQuery,
  mediaTypeFor,
  formatNeedsMedia,
  isImageRef,
  isMediaRef,
  // visual → package
  visualForPackage,
  // assertions + ledger
  assertArtifact,
  ledgerEvent,
  // queue convergence
  enqueueAwaitingApproval,
  buildQueueFields,
  // routing + outcome
  firstRoute,
  gateSummary,
  makeOutcome,
};
