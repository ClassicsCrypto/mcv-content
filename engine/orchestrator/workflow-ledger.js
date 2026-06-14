'use strict';

/**
 * engine/orchestrator/workflow-ledger.js  [E extracted]
 *
 * The workflow / event ledger — the run-attribution + observability substrate
 * (release-spec §13.1 surface 2 "Event ledger"; §7.11 ledger-record + event shapes;
 * §8.4 named-trigger / run-mechanics attribution, DD-19).
 *
 * Two durable artifacts, both under $CONTENT_HOME via engine/shared/paths.js (RD-3):
 *   - $CONTENT_HOME/ledger/records/<content-id>.json — one mutable, deep-merged record
 *     per content item: the current rollup of run, package, media, gates, discord,
 *     review, and handoff facts. Written atomically (tmp + rename) so a crash never
 *     leaves a half-written record (§8.2 durability invariant; §15.1 crash-safety).
 *   - $CONTENT_HOME/ledger/events.jsonl — the append-only event stream: every stage
 *     transition, gate verdict, decision, and handoff as one JSON line. This is the
 *     machine-readable substrate the daily digest / `engine status` read (§13.1).
 *
 * Redact-at-write (§13.3; model §9 rule 3): EVERY write — both the record write and the
 * events.jsonl append — passes through engine/shared/redact.js first, so no token-shaped
 * value or named-credential field can reach the ledger files. Redaction happens at write
 * time, not share time, because the ledger feeds future observability/learning surfaces.
 *
 * State vocabulary: record.status uses the public §8.2 state machine. Incoming production
 * stage/queue labels are normalized through mapState() so the ledger speaks one vocabulary
 * (state-machine reconciliation, §8.2; docs/architecture.md carries the full mapping).
 *
 * Tier-3 cleanliness (§1 per-path rule): this module constructs no instance paths of its
 * own (paths.js does), hardcodes no IDs/handles/absolute roots, and carries no production
 * persona codenames (§0.3 rule 6).
 *
 * Disable toggle: WORKFLOW_LEDGER_DISABLE=1 turns recording into a no-op (§4.5 diagnostic
 * toggle) — used by the zero-key fixture run and tests that don't need a CONTENT_HOME.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const paths = require('../shared/paths');
const { redact } = require('../shared/redact');

const SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Public §8.2 state vocabulary + normalization
// ---------------------------------------------------------------------------

/**
 * Map an internal stage/queue label to a public §8.2 state. Unknown labels pass through
 * unchanged so an extension that introduces a new queue_state is never silently swallowed —
 * `engine status` surfaces unmapped states rather than hiding them.
 */
const STATE_MAP = {
  // Pre-packaging / run stages (§8.2 stage states).
  new: 'planned',
  dispatched: 'seeded',
  dispatch_failed: 'hard_failed',
  package_validated: 'packaged',
  package_validation_failed: 'hard_failed',
  gates_passed: 'publish_intent',
  gates_failed: 'failed_handoff',

  // Review / approval (§8.2 queue states).
  previewed: 'awaiting_approval',
  edit_requested: 'awaiting_approval',
  rejected: 'rejected',
  approval_blocked: 'manual_review',
  queued_for_handoff: 'approved',
  preview_only_approved: 'approved',

  // Handoff / publish (§8.2 queue states).
  queued: 'approved',
  handoff_updated: 'handed_off',
  handed_off: 'handed_off',
  published: 'published',
  interrupted_hold: 'interrupted_hold',
  manual_review: 'manual_review',
  dead_lettered: 'dead_lettered',
  failed_handoff: 'failed_handoff',
  skipped_on_overlap: 'skipped_on_overlap',
};

function mapState(label) {
  if (label == null) return null;
  const key = String(label);
  return Object.prototype.hasOwnProperty.call(STATE_MAP, key) ? STATE_MAP[key] : key;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nowIso() {
  return new Date().toISOString();
}

/** Sanitize a content id into a filesystem-safe record filename stem. */
function safeContentId(contentId) {
  return String(contentId || '')
    .trim()
    .replace(/[^A-Za-z0-9_.-]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
}

/** $CONTENT_HOME/ledger/records — the per-content rollup dir (under paths.ledgerDir). */
function recordsDir(env = process.env) {
  return path.join(paths.ledgerDir(env), 'records');
}

/** $CONTENT_HOME/ledger/events.jsonl — the append-only event stream. */
function eventsPath(env = process.env) {
  return paths.events(env);
}

function ensureDirs(env = process.env) {
  fs.mkdirSync(recordsDir(env), { recursive: true });
}

function recordPath(contentId, env = process.env) {
  const safe = safeContentId(contentId);
  if (!safe) throw new Error('workflow ledger content_id is required');
  return path.join(recordsDir(env), `${safe}.json`);
}

/**
 * Normalize any artifact path to a CONTENT_HOME-relative POSIX string (§7.1: artifact refs
 * are CONTENT_HOME-relative; absolute paths are forbidden in any artifact). Remote URLs and
 * already-relative refs are returned as-is (after slash normalization); an absolute path that
 * sits under $CONTENT_HOME is rebased; an absolute path outside it is reduced to its basename
 * so no operator filesystem layout leaks into the ledger.
 */
function relativeToHome(filePath, env = process.env) {
  if (!filePath) return null;
  const raw = String(filePath).trim().replace(/\\/gu, '/');
  if (!raw || raw.toLowerCase() === 'null') return null;
  if (/^https?:/iu.test(raw)) return raw;
  if (!path.isAbsolute(raw)) return raw;
  let home;
  try {
    home = paths.contentHome(env);
  } catch {
    // No CONTENT_HOME resolvable: never emit an absolute path — fall back to basename.
    return path.basename(raw);
  }
  const rel = path.relative(home, path.resolve(raw)).replace(/\\/gu, '/');
  if (rel && !rel.startsWith('..')) return rel;
  return path.basename(raw);
}

function readJsonIfExists(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function emptyRecord(contentId) {
  const ts = nowIso();
  return {
    schema_version: SCHEMA_VERSION,
    content_id: contentId,
    status: 'planned',
    created_at: ts,
    updated_at: ts,
    run: {},
    package: {},
    media: {},
    gates: {},
    discord: {},
    review: {},
    handoff: {},
    refs: {},
    last_event: null,
  };
}

function readRecord(contentId, env = process.env) {
  const file = recordPath(contentId, env);
  return readJsonIfExists(file) || emptyRecord(contentId);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Deep-merge a patch into a base record; undefined patch values are skipped. */
function mergeDeep(base, patch) {
  const out = { ...base };
  for (const [key, value] of Object.entries(patch || {})) {
    if (value === undefined) continue;
    if (isPlainObject(out[key]) && isPlainObject(value)) out[key] = mergeDeep(out[key], value);
    else out[key] = value;
  }
  return out;
}

/**
 * Atomic JSON write: serialize to a unique temp file, then rename over the target. The rename
 * is atomic on a single filesystem, so a reader never observes a partial record (§15.1).
 * The value is redacted before serialization (§13.3 redact-at-write).
 */
function atomicWriteJson(filePath, value, env = process.env) {
  ensureDirs(env);
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(redact(value), null, 2)}\n`, 'utf8');
  fs.renameSync(tmpPath, filePath);
}

/** Append one redacted JSON line to events.jsonl (§13.3 redact-at-write). */
function appendEvent(row, env = process.env) {
  ensureDirs(env);
  fs.appendFileSync(eventsPath(env), `${JSON.stringify(redact(row))}\n`, 'utf8');
}

// ---------------------------------------------------------------------------
// Media identity (asset attribution for cooldown / archive lineage)
// ---------------------------------------------------------------------------

/** sha256 of a local media file, or null for remote/unknown refs. */
function hashFile(filePath, env = process.env) {
  try {
    if (!filePath || /^https?:/iu.test(String(filePath))) return null;
    const rel = relativeToHome(filePath, env);
    if (!rel || /^https?:/iu.test(rel)) return null;
    let abs;
    try {
      abs = path.isAbsolute(String(filePath))
        ? String(filePath)
        : path.join(paths.contentHome(env), rel);
    } catch {
      return null;
    }
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return null;
    const h = crypto.createHash('sha256');
    h.update(fs.readFileSync(abs));
    return h.digest('hex');
  } catch {
    return null;
  }
}

/** Stable asset id: a remote URL as-is, else the CONTENT_HOME-relative path. */
function normalizeAssetId(mediaPath, env = process.env) {
  if (!mediaPath) return null;
  const raw = String(mediaPath).trim();
  if (!raw || raw.toLowerCase() === 'null') return null;
  if (/^https?:/iu.test(raw)) return raw;
  return relativeToHome(raw, env);
}

/**
 * Build the media-identity block recorded against a content item: stable asset id, the
 * CONTENT_HOME-relative source path, a content hash for derivative matching, plus any extra
 * cooldown facts the caller supplies.
 */
function mediaIdentity(mediaPath, extra = {}, env = process.env) {
  const assetId = normalizeAssetId(mediaPath, env);
  if (!assetId) return null;
  return {
    asset_id: assetId,
    source_path: /^https?:/iu.test(String(mediaPath))
      ? String(mediaPath)
      : relativeToHome(mediaPath, env),
    sha256: hashFile(mediaPath, env),
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Core append: write the rolled-up record + append the event line
// ---------------------------------------------------------------------------

/**
 * Record one workflow event. Deep-merges `patch` into the content item's rollup record,
 * stamps updated_at + last_event, writes the record atomically, and appends a redacted event
 * line to events.jsonl. No-op (returns null) when WORKFLOW_LEDGER_DISABLE=1 or when the
 * content id sanitizes to empty.
 *
 * @param {string} contentId
 * @param {string} eventType  the event name written to events.jsonl
 * @param {object} [patch]     deep-merged into the rollup record
 * @param {object} [eventData] extra fields merged into the event line (in addition to ts/type/id)
 * @param {object} [env]       environment for paths resolution (default process.env)
 * @returns {object|null} the updated record, or null when disabled/invalid
 */
function recordEvent(contentId, eventType, patch = {}, eventData = {}, env = process.env) {
  if (env.WORKFLOW_LEDGER_DISABLE === '1') return null;
  const safeId = safeContentId(contentId);
  if (!safeId) return null;
  const ts = nowIso();
  const event = {
    ts,
    event_type: eventType,
    content_id: contentId,
    ...eventData,
  };
  const current = readRecord(contentId, env);
  const next = mergeDeep(current, {
    updated_at: ts,
    last_event: { ts, event_type: eventType },
    ...patch,
  });
  atomicWriteJson(recordPath(contentId, env), next, env);
  appendEvent(event, env);
  return next;
}

// ---------------------------------------------------------------------------
// Typed event recorders (the query/append API the pipeline calls)
// ---------------------------------------------------------------------------

function compactValidationDetails(details = {}) {
  return {
    package_size_bytes: details.package_size_bytes ?? null,
    mode: details.mode ?? null,
    package_status: details.package_status ?? null,
    publish_state: details.publish_state ?? null,
    ready_for_preview: details.ready_for_preview ?? null,
    ready_for_publish: details.ready_for_publish ?? null,
    voice_verdict: details.voice_verdict ?? null,
    quality_verdict: details.quality_verdict ?? null,
    media_cooldown: details.media_cooldown || [],
    visual_check: details.visual_check || null,
  };
}

/** Deterministic package/platform-gate result (§14.1 layer 3). */
function packageValidation(out, env = process.env) {
  const contentId = out.content_id;
  const current = readRecord(contentId, env);
  const canAdvance = ['planned', 'seeded', 'hard_failed', 'packaged'].includes(current.status);
  const nextStatus = out.pass
    ? (canAdvance ? mapState('package_validated') : current.status)
    : mapState('package_validation_failed');
  const mediaStatuses = out.details?.media_cooldown || [];
  const firstMedia = mediaStatuses[0] || null;
  const selectedMedia = firstMedia
    ? mediaIdentity(firstMedia.asset_path, {
        asset_family_key: firstMedia.asset_family_key || null,
        cooldown_pass: !firstMedia.cooldown_blocked,
        cooldown_blocked: Boolean(firstMedia.cooldown_blocked),
        days_since_last_use: firstMedia.days_since_last_use ?? null,
        last_use: firstMedia.last_use || null,
      }, env)
    : null;
  return recordEvent(contentId, out.pass ? 'package_validation_pass' : 'package_validation_fail', {
    status: nextStatus,
    package: {
      path: relativeToHome(out.package_path, env),
      platform: out.platform || 'auto',
      pass: Boolean(out.pass),
      failures: out.failures || [],
      validated_at: nowIso(),
      details: compactValidationDetails(out.details || {}),
    },
    media: {
      ...(selectedMedia ? { selected: selectedMedia } : {}),
      cooldown_pass: mediaStatuses.length ? mediaStatuses.every((s) => !s.cooldown_blocked) : null,
    },
    gates: {
      package_validation: {
        ok: Boolean(out.pass),
        failures: out.failures || [],
      },
      visual_check: out.details?.visual_check || null,
    },
  }, {
    pass: Boolean(out.pass),
    failures: out.failures || [],
    package_path: relativeToHome(out.package_path, env),
  }, env);
}

/** Orchestrator dispatched (or failed to dispatch) a slot run (§8.4 run mechanics, DD-19). */
function runDispatched(data, env = process.env) {
  const failed = data.ok === false;
  return recordEvent(data.content_id, failed ? 'run_dispatch_failed' : 'run_dispatched', {
    status: failed ? mapState('dispatch_failed') : mapState('dispatched'),
    run: {
      content_id: data.content_id,
      slot_id: data.slot_id || null,
      account: data.account || null,
      platform: data.platform || null,
      command_family: data.command_family || null,
      mode: data.mode || null,
      date: data.date || null,
      harness: data.harness || null,
      dispatcher: data.dispatcher || null,
      trigger: data.trigger || null,
      scheduled_at: data.scheduled_at || null,
      delay_seconds: data.delay_seconds ?? null,
      job_id: data.job_id || null,
      dry_run: Boolean(data.dry_run),
      error: data.error || null,
    },
  }, data, env);
}

/** Approval card posted to the review surface (§7.5; §8.2 awaiting_approval). */
function previewPosted(data, env = process.env) {
  return recordEvent(data.content_id, 'preview_posted', {
    status: mapState('previewed'),
    discord: {
      preview_channel_id: data.preview_channel_id || null,
      preview_message_id: data.preview_message_id || null,
      preview_link: data.preview_link || null,
      media_bank_message_id: data.media_bank_message_id || null,
      media_bank_cdn_url: data.media_bank_cdn_url || null,
      components_v2: data.components_v2 ?? null,
      mediagallery_count: data.mediagallery_count ?? null,
      readback_pass: data.readback_pass ?? null,
      reactions_present: data.reactions_present ?? null,
    },
    package: {
      path: relativeToHome(data.package_path, env),
      account: data.account || undefined,
      platform: data.platform || undefined,
      mode: data.mode || undefined,
      format: data.format || undefined,
    },
  }, data, env);
}

/** A reviewer reaction was observed on the card (decision-capture, DD-17). */
function reaction(data, env = process.env) {
  return recordEvent(data.content_id, `reaction_${data.action || 'unknown'}`, {
    discord: {
      preview_message_id: data.preview_message_id || data.message_id || null,
    },
    review: {
      state: data.review_state || data.action || 'reaction_received',
      last_reaction: {
        action: data.action || null,
        emoji: data.emoji || null,
        variant: data.variant || null,
        user_id: data.user_id || null,
        message_id: data.preview_message_id || data.message_id || null,
        at: nowIso(),
      },
    },
  }, data, env);
}

/** Reviewer requested an edit (return-for-rework; §14.5 re-gate path). */
function editRequested(data, env = process.env) {
  return recordEvent(data.content_id, 'edit_requested', {
    status: mapState('edit_requested'),
    discord: {
      ...(data.preview_message_id ? { preview_message_id: data.preview_message_id } : {}),
    },
    review: {
      state: 'edit_requested',
      edit_type: data.edit_type || null,
      edit_option: data.edit_option || null,
      feedback: data.feedback || null,
      menu_message_id: data.menu_message_id || null,
      freeform_message_id: data.freeform_message_id || null,
      requested_at: nowIso(),
    },
  }, data, env);
}

/** Reviewer rejected the item (§8.2 rejected). */
function rejected(data, env = process.env) {
  return recordEvent(data.content_id, 'rejected', {
    status: mapState('rejected'),
    discord: {
      ...(data.preview_message_id ? { preview_message_id: data.preview_message_id } : {}),
    },
    package: {
      path: relativeToHome(data.package_path, env),
    },
    review: {
      state: 'rejected',
      rejected_by: data.user_id || null,
      rejected_at: nowIso(),
      rejection_reason: data.reason || null,
    },
  }, data, env);
}

/** An approval was received but could not be queued for handoff (needs human attention). */
function approvalBlocked(data, env = process.env) {
  return recordEvent(data.content_id, 'approval_blocked', {
    status: mapState('approval_blocked'),
    discord: {
      ...(data.preview_message_id ? { preview_message_id: data.preview_message_id } : {}),
    },
    package: {
      path: relativeToHome(data.package_path, env),
    },
    review: {
      state: 'approval_blocked',
      approved_variant: data.variant || null,
      blocked_reason: data.reason || null,
      blocked_at: nowIso(),
    },
    gates: {
      approval_handoff: {
        ok: false,
        reason: data.reason || null,
      },
    },
  }, data, env);
}

/** Reviewer approved; item queued for the publisher handoff (§8.2 approved). */
function approvedQueued(data, env = process.env) {
  return recordEvent(data.content_id, 'approved_queued', {
    status: mapState('queued_for_handoff'),
    discord: {
      ...(data.preview_message_id ? { preview_message_id: data.preview_message_id } : {}),
    },
    package: {
      path: relativeToHome(data.package_path, env),
    },
    review: {
      state: 'approved',
      approved_variant: data.variant || null,
      approved_by: data.user_id || null,
      approved_at: nowIso(),
    },
    handoff: {
      queue_state: 'queued',
      queue_path: relativeToHome(data.queue_path, env),
      source_package: relativeToHome(data.package_path, env),
    },
  }, data, env);
}

/** LIVE_PREVIEW approval: approved with no publish path (§8.3 mode ladder). */
function previewOnlyApproval(data, env = process.env) {
  return recordEvent(data.content_id, 'preview_only_approval', {
    status: mapState('preview_only_approved'),
    discord: {
      ...(data.preview_message_id ? { preview_message_id: data.preview_message_id } : {}),
    },
    package: {
      path: relativeToHome(data.package_path, env),
    },
    review: {
      state: 'preview_only_approved',
      approved_variant: data.variant || null,
      reason: data.reason || null,
      approved_at: nowIso(),
    },
  }, data, env);
}

/** Executor publish-edge gate results (§14.1 layer 3, executor gates). */
function executorGateResults(data, env = process.env) {
  const failed = data.failed || [];
  return recordEvent(data.content_id, failed.length ? 'executor_gates_failed' : 'executor_gates_passed', {
    status: failed.length ? mapState('gates_failed') : mapState('gates_passed'),
    gates: {
      executor: {
        checked_at: nowIso(),
        results: data.results || {},
        failed,
      },
    },
    handoff: {
      queue_state: mapState(data.queue_state),
      executor_error: data.executor_error || null,
    },
  }, data, env);
}

/**
 * Publisher handoff state advanced (write-ahead intent → handed_off → published, and the
 * failure/hold branches). `data.queue_state` carries the public §8.2 queue state; the record
 * status mirrors it through mapState() unless the caller pins an explicit status.
 */
function handoffUpdated(data, env = process.env) {
  return recordEvent(data.content_id, data.event_type || 'handoff_updated', {
    status: mapState(data.status || data.queue_state || 'handoff_updated'),
    handoff: {
      queue_state: mapState(data.queue_state),
      publish_mode: data.publish_mode || null,
      publisher_draft_id: data.publisher_draft_id || null,
      publisher_integration_id: data.publisher_integration_id || null,
      publisher_media_url: data.publisher_media_url || null,
      publisher_draft_type: data.publisher_draft_type || null,
      publisher_draft_date: data.publisher_draft_date || null,
      giphy_manifest: relativeToHome(data.giphy_manifest, env),
      giphy_id: data.giphy_id || null,
      post_url: data.post_url || null,
      published_at: data.published_at || null,
      executor_error: data.executor_error || null,
    },
  }, data, env);
}

// ---------------------------------------------------------------------------
// Query API (read side — §13.1 surface 2 substrate)
// ---------------------------------------------------------------------------

/** All event lines for one content id, oldest first. Returns [] when no stream exists. */
function readEvents(contentId, env = process.env) {
  const file = eventsPath(env);
  const wanted = safeContentId(contentId);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const rows = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue; // tolerate a torn last line from a crashed append
    }
    if (!wanted || safeContentId(parsed.content_id) === wanted) rows.push(parsed);
  }
  return rows;
}

/** The current rollup status of a content item, or null if no record exists. */
function statusOf(contentId, env = process.env) {
  const file = recordPath(contentId, env);
  const rec = readJsonIfExists(file);
  return rec ? rec.status : null;
}

/** Every content id that has a ledger record (no order guarantee). */
function listContentIds(env = process.env) {
  let entries;
  try {
    entries = fs.readdirSync(recordsDir(env));
  } catch {
    return [];
  }
  return entries
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.slice(0, -'.json'.length));
}

module.exports = {
  SCHEMA_VERSION,
  STATE_MAP,
  mapState,
  // path accessors (computed, not constants — resolved per call via paths.js)
  recordsDir,
  eventsPath,
  // media attribution
  mediaIdentity,
  // append API
  recordEvent,
  packageValidation,
  previewPosted,
  runDispatched,
  reaction,
  editRequested,
  rejected,
  approvalBlocked,
  approvedQueued,
  previewOnlyApproval,
  executorGateResults,
  handoffUpdated,
  // query API
  readRecord,
  readEvents,
  statusOf,
  listContentIds,
  relativeToHome,
};
