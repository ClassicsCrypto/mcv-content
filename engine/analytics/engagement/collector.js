'use strict';

/**
 * engine/analytics/engagement/collector.js  [A adapted]
 *
 * Engagement checkpoint collection — the v1 analytics loop's data-acquisition half
 * (release-spec §8.9 "engagement checkpoint collection + baselines"; §7.9 performance
 * report; §15.1 analytics-pull row). Adapted from the production analytics runner (the
 * subsystem whose production codename is retired here per §0.3 rule 6 — the public name
 * is `analytics/engagement`, never the production codename).
 *
 * What this module does (and only this):
 *   1. Read published queue entries (those in state `published` with a published_at) plus
 *      the workflow ledger, and for each compute which checkpoints (1h / 24h / 7d, §7.9)
 *      are DUE (offset elapsed) and NOT YET COLLECTED.
 *   2. For each due checkpoint, fetch metrics through the publisher adapter SEAM
 *      (`publisher.fetchMetrics`, §12.3) — NEVER a direct Postiz/HTTP client. The seam is
 *      the only place a publisher API is called (RD-11).
 *   3. Write one §7.9-conformant raw checkpoint record to $CONTENT_HOME/analytics/ via
 *      paths.js, redacted at write (§13.3). Dedup is by the record file's existence.
 *
 * Honest v1 scope (§8.9): this is collection only. It does NOT promote draft→published
 * (that truth-check is the executor's verifyStatus job, §12.3) and it NEVER writes the
 * publish-queue.md — analytics is physically incapable of mutating the queue (the production
 * "analytics should never write the queue" invariant, preserved by simply not importing the
 * queue lock or any queue-write helper here).
 *
 * De-localization vs the production source (the named remediation, plan P3-ANALYTICS):
 *   - no hardcoded absolute queue/analytics paths — everything via engine/shared/paths.js (RD-3);
 *   - no shell-spawned publisher CLI — metrics flow through `publisher.fetchMetrics` (§12.3),
 *     so the analytics path never shells out and never touches a publisher binary directly;
 *   - no instance-secrets-file fallback chain — adapters resolve credentials by NAME via
 *     engine/shared/secrets.js (§4.4 terminating resolution);
 *   - the production `account` field is the public `brand` field (§7.4 / DD-10);
 *   - the dry-run toggle is `ANALYTICS_DRY_RUN` (the §4.5 rename of the production dry-run env
 *     var) — in dry-run no adapter is called and synthetic metrics exercise the flow;
 *   - partial pulls are FLAGGED (`partial: true`), never silently consumed (§15.1);
 *   - the PAUSED kill-switch sentinel is honored (§15.4) — a paused instance collects nothing;
 *   - auth failure (401/403) is permanent and halts collection, distinct from an outage which
 *     is skip-and-retry-next-cycle (§15.1 / §15.2 auth-vs-outage normative distinction).
 *
 * Tier-3 cleanliness (§1 per-path rule): no instance IDs/handles/absolute roots, no production
 * persona codename. The checkpoint cadence is a config-overridable constant, not a literal
 * baked into a scheduler script (the production install/run wrappers are NOT ported).
 */

const fs = require('fs');
const path = require('path');

const paths = require('../../shared/paths.js');
const { redact } = require('../../shared/redact.js');
const queue = require('../../shared/queue.js');
const publisher = require('../../publishers/publisher.js');

/**
 * Analytics checkpoints (§7.9): name + offset from publish. Shipped default; an instance may
 * override the cadence in config/system.json (the production hardcoded scheduler is dropped —
 * cadence is data, not a baked-in script literal).
 */
const CHECKPOINTS = Object.freeze([
  { name: '1h', offsetMs: 1 * 60 * 60 * 1000 },
  { name: '24h', offsetMs: 24 * 60 * 60 * 1000 },
  { name: '7d', offsetMs: 7 * 24 * 60 * 60 * 1000 },
]);

/** The §4.5 dry-run toggle (the public rename of the production analytics dry-run env var). */
function isDryRun(env = process.env) {
  return env.ANALYTICS_DRY_RUN === '1';
}

/** Honor the §15.4 kill-switch: a PAUSED instance collects nothing. */
function isPaused(env = process.env) {
  try {
    return fs.existsSync(paths.pausedSentinel(env));
  } catch {
    return false;
  }
}

/** Filesystem-safe stem for a checkpoint raw-record filename, derived from content_id. */
function safeId(contentId) {
  return String(contentId || '')
    .trim()
    .replace(/[^A-Za-z0-9_.-]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
}

/** $CONTENT_HOME/analytics/raw-<content-id>-<checkpoint>.json — the dedup-by-existence key. */
function rawRecordPath(contentId, checkpoint, env = process.env) {
  return path.join(paths.analyticsDir(env), `raw-${safeId(contentId)}-${checkpoint}.json`);
}

/**
 * Which checkpoints are due (offset elapsed since published_at) and not yet collected
 * (no raw record on disk). Pure given `now` + the filesystem; `now` is injectable for tests.
 * @param {object} entry  a parsed queue entry (queue.js shape: { header, fields }).
 * @param {object} [opts] { now, env, checkpoints }
 * @returns {Array<{checkpoint:string, dueAt:number, rawPath:string}>}
 */
function pendingCheckpoints(entry, opts = {}) {
  const env = opts.env || process.env;
  const now = typeof opts.now === 'number' ? opts.now : Date.now();
  const checkpoints = opts.checkpoints || CHECKPOINTS;
  const publishedAt = Date.parse(entry.fields.published_at);
  if (Number.isNaN(publishedAt)) return [];
  const contentId = entry.fields.content_id || entry.header;
  const pending = [];
  for (const cp of checkpoints) {
    const dueAt = publishedAt + cp.offsetMs;
    if (now < dueAt) continue;
    const rawPath = rawRecordPath(contentId, cp.name, env);
    if (fs.existsSync(rawPath)) continue;
    pending.push({ checkpoint: cp.name, dueAt, rawPath });
  }
  return pending;
}

/** Published entries the collector considers (state published + a parseable published_at). */
function publishedEntries(queueRaw) {
  return queue.parseQueue(queueRaw).filter(
    (e) => e.fields.state === 'published' && e.fields.published_at,
  );
}

/** Deterministic synthetic metrics for ANALYTICS_DRY_RUN — exercises the flow with no adapter. */
function syntheticMetrics(contentId, checkpoint) {
  // Stable per (content_id, checkpoint) so dry-run baselines are reproducible in tests.
  const seedStr = `${contentId}|${checkpoint}`;
  let h = 0;
  for (const ch of seedStr) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const r = (mul) => (h % mul);
  return {
    likes: 40 + r(120),
    comments: 2 + r(12),
    shares: 1 + r(8),
    views: 800 + r(4000),
    impressions: 1200 + r(5000),
  };
}

/**
 * Normalize an adapter fetchMetrics return into the §7.9 metrics object (open map of
 * metric→number). The reference Postiz adapter already returns a `{ metrics }` block; this
 * coerces values to finite numbers and drops non-numerics so the schema's
 * `additionalProperties: { type: number }` holds. Provider-specific keys pass through.
 */
function normalizeMetrics(raw) {
  const src = (raw && raw.metrics) || {};
  const out = {};
  for (const [k, v] of Object.entries(src)) {
    const n = typeof v === 'string' ? Number(v) : v;
    if (typeof n === 'number' && Number.isFinite(n)) out[k] = n;
  }
  return out;
}

/** A 401/403-class adapter error is a permanent auth failure (§15.1) — not retryable. */
function isAuthFailure(err) {
  const status = err && (err.httpStatus || err.status);
  return status === 401 || status === 403;
}

/**
 * Build a §7.9-conformant raw checkpoint record. `external_post_ref` is a publisher id, never
 * a URL (the schema + §13.3 forbid credential-bearing URLs in any artifact).
 */
function buildRawRecord(entry, checkpoint, fetched, opts = {}) {
  const now = typeof opts.now === 'number' ? opts.now : Date.now();
  const f = entry.fields;
  const record = {
    content_id: f.content_id || entry.header,
    brand: f.brand,
    platform: f.platform,
    external_post_ref: f.external_post_ref || undefined,
    captured_at: new Date(now).toISOString(),
    checkpoint,
    metrics: normalizeMetrics(fetched),
  };
  // §15.1: a partial/unsupported pull is flagged, never silently consumed. supported:false or
  // an empty metrics block from a degraded provider marks the checkpoint partial.
  const supported = fetched && fetched.supported !== false;
  const empty = Object.keys(record.metrics).length === 0;
  if (!supported || (empty && !opts.dryRun)) record.partial = true;
  return record;
}

/** Write a raw checkpoint record atomically and redacted (§13.3). Returns the record. */
function writeRawRecord(record, rawPath, env = process.env) {
  fs.mkdirSync(path.dirname(rawPath), { recursive: true });
  const tmp = `${rawPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(redact(record), null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, rawPath);
  return record;
}

/**
 * collectEngagement — the public entry point (plan P3-ANALYTICS export).
 *
 * Reads the publish queue, finds due-and-uncollected checkpoints for every published entry,
 * fetches metrics through the publisher seam (or synthesizes them in dry-run), and writes one
 * §7.9 raw checkpoint record per collected checkpoint under $CONTENT_HOME/analytics/.
 *
 * @param {object} [opts]
 * @param {object}   [opts.env]            env for path/secret resolution (default process.env).
 * @param {number}   [opts.now]            injected clock (ms) for deterministic tests.
 * @param {string}   [opts.queueRaw]       raw publish-queue.md text; default reads from disk.
 * @param {function} [opts.getAdapter]     (name) => adapter; default the publisher registry.
 * @param {object}   [opts.checkpoints]    checkpoint cadence override.
 * @param {function} [opts.resolveAdapterName]  (entry) => adapter name; default platform value.
 * @returns {Promise<{collected:Array, failures:Array, paused:boolean, dryRun:boolean,
 *                     authHalted:boolean}>}
 */
async function collectEngagement(opts = {}) {
  const env = opts.env || process.env;
  const now = typeof opts.now === 'number' ? opts.now : Date.now();
  const dryRun = isDryRun(env);
  const getAdapter = opts.getAdapter || ((name) => publisher.get(name));
  const resolveName = opts.resolveAdapterName
    || ((entry) => entry.fields.publisher || entry.fields.platform);

  const result = {
    collected: [], failures: [], paused: false, dryRun, authHalted: false,
  };

  if (isPaused(env)) {
    result.paused = true;
    return result;
  }

  let queueRaw = opts.queueRaw;
  if (queueRaw == null) {
    const queuePath = queue.queueFilePath(env);
    if (!fs.existsSync(queuePath)) return result; // nothing published yet
    queueRaw = fs.readFileSync(queuePath, 'utf8');
  }

  const entries = publishedEntries(queueRaw);
  for (const entry of entries) {
    const due = pendingCheckpoints(entry, { now, env, checkpoints: opts.checkpoints });
    if (due.length === 0) continue;
    const contentId = entry.fields.content_id || entry.header;

    for (const d of due) {
      try {
        let fetched;
        if (dryRun) {
          fetched = { supported: true, metrics: syntheticMetrics(contentId, d.checkpoint), dry_run: true };
        } else {
          const adapter = getAdapter(resolveName(entry));
          fetched = await adapter.fetchMetrics(entry.fields.external_post_ref, d.checkpoint, { env });
        }
        const record = buildRawRecord(entry, d.checkpoint, fetched, { now, dryRun });
        writeRawRecord(record, d.rawPath, env);
        result.collected.push(record);
      } catch (err) {
        // Auth failure is permanent (§15.1): halt collection, do not retry this run.
        if (isAuthFailure(err)) {
          result.authHalted = true;
          result.failures.push({ content_id: contentId, checkpoint: d.checkpoint, error: err.message, auth: true });
          return result;
        }
        // Outage/ambiguous: skip-and-retry next cycle (§15.1 / §15.2). Nothing written.
        result.failures.push({ content_id: contentId, checkpoint: d.checkpoint, error: err.message });
      }
    }
  }

  return result;
}

module.exports = {
  CHECKPOINTS,
  collectEngagement,
  // internals exported for the co-located tests (not the public contract)
  isDryRun,
  isPaused,
  rawRecordPath,
  pendingCheckpoints,
  publishedEntries,
  normalizeMetrics,
  buildRawRecord,
  writeRawRecord,
  syntheticMetrics,
  isAuthFailure,
};
