'use strict';

/**
 * engine/orchestrator/publish-executor.js  [E ported]
 *
 * The crash-safe publish spine (release-spec §1 tree `orchestrator/publish-executor.js`;
 * §8.3 mode ladder + second gate; §8.6/§14.1 cooldown enforcement point 3; §14.3 retry
 * bound + dead-letter; §15.1/§15.2 publish-handoff error handling; DD-4/DD-12/DD-13/DD-14/
 * DD-17/DD-19).
 *
 * It walks the durable publish-queue, applies the named publish-edge gates, and hands each
 * approved item to a publisher adapter through the §12.3 seam — preserving, verbatim in
 * behavior, the production module's crash-safety series:
 *
 *   - WRITE-AHEAD INTENT (DD-4): the entry transitions to `publish_intent` and is persisted
 *     to disk BEFORE any external publisher call. A crash between the call and the result
 *     write can therefore never leave an external artifact (a draft / a live post) without
 *     its on-disk record — the next tick finds the intent state and HOLDS, it does not
 *     replay the call.
 *   - ATTEMPT COUNTER BEFORE RETRY SPEND (DD-13): `attempt_count` is durably incremented
 *     and persisted before each handoff attempt, so a crash cannot reset the budget; the
 *     retry bound (3) is enforced against the persisted counter.
 *   - IDEMPOTENT PUBLISH (DR W#35): handoff is idempotent by content_id at the adapter
 *     (§12.3); the executor never issues a second handoff for an entry already past
 *     `publish_intent`, and an ambiguous outcome (timeout / dropped connection / id-lookup
 *     failure) parks as `interrupted_hold` rather than retrying — the artifact may exist.
 *   - INTERRUPTED_HOLD QUARANTINE (§15.1): an entry found at startup in `publish_intent`
 *     (i.e. a previous run died mid-call) is parked in `interrupted_hold` for explicit
 *     operator release — NEVER auto-retried (auto-retry would replay a publish).
 *   - LOCK HEARTBEAT + ELOCKTIMEOUT GUARDS (DD-19): the whole run holds the ONE canonical
 *     queue lock (shared/queue.js), heartbeated well inside its TTL so a long-but-alive run
 *     (slow handoff, big upload) is never reclaimed mid-run; overlap is skip-and-log
 *     (`skipped_on_overlap`); a foreign lock is left untouched (ownership-checked release).
 *   - CONFLICT ABORT: a foreign write to the queue mid-run aborts WITHOUT writing (our
 *     snapshot-based rewrite would erase it); already-persisted write-ahead intents make the
 *     next tick hold anything in flight.
 *
 * Mode ladder (§8.3, default SAFE per RD-16f): SAFE / LIVE_PREVIEW perform NO publisher call
 * (artifact/dry only); LIVE hands off draft-only by default (the second gate) → `handed_off`,
 * and a later tick's `verifyStatus` poll advances `handed_off → published`. "Approved but
 * nothing posted yet" (`handed_off`) is the expected LIVE state, not a failure.
 *
 * Cooldown enforcement point 3 (§8.6/§14.1, DD-14): at the publish edge the executor reads the
 * canonical `library/usage-log.jsonl` through engine/library/usage-log.js — the SAME ledger the
 * retrieval filter and package validation read — and blocks a same-asset (family-aware) reuse
 * inside the hard window with `PKG.MEDIA_COOLDOWN_BLOCKED`. No queue/preview-residue scan (the
 * production multi-source read is retired here).
 *
 * Tier-3 cleanliness (§0.3 r6 / RD-3): no hardcoded approver id (the DD-17 reviewers allowlist
 * is read from config/system.json), no hardcoded channel id (the ops/published channel comes
 * from `approval_surface`), no hardcoded queue/instance paths (paths.js derives everything under
 * $CONTENT_HOME), no production persona codenames, no brand strings. The test-mode guard keys
 * off ENGINE_TEST_MODE (renamed from the production instance-named toggle, §4.5).
 *
 * The publisher binding (which adapter, which integration ref) travels on the package /
 * platform descriptor (§11.3) — the executor resolves the adapter from the §12.3 registry by
 * name and never touches a publisher API itself (RD-11).
 */

const fs = require('fs');
const path = require('path');

const paths = require('../shared/paths');
const queue = require('../shared/queue');
const ledger = require('./workflow-ledger');
const usageLog = require('../library/usage-log');
const publishers = require('../publishers/publisher');
const { redact } = require('../shared/redact');

// ---------------------------------------------------------------------------
// Constants (no Tier-3 instance values — config-derived values live in config())
// ---------------------------------------------------------------------------

/** Process exit codes (§15 — machine-readable run outcome). */
const EXIT = Object.freeze({
  OK: 0,            // walked the queue; nothing needs operator attention
  BLOCKED: 1,       // one or more entries blocked by gates / dead-lettered (flagged in queue)
  MALFORMED: 2,     // malformed queue / config, or an unexpected crash (best-effort flush)
  TEST_MODE: 3,     // refused to run because ENGINE_TEST_MODE=1
  CONFLICT: 4,      // queue changed on disk mid-run (foreign writer); exited WITHOUT writing
  PAUSED: 5,        // PAUSED sentinel present — kill switch engaged (§15.4)
});

/** Retry bound for publisher handoff (DD-13: small fixed bound 2-3). */
const RETRY_BOUND = 3;

/** Lock TTL + heartbeat (DD-19) — mirrors the canonical queue lock discipline. */
const LOCK_STALE_MINUTES = queue.DEFAULT_LOCK_STALE_MINUTES;
const LOCK_HEARTBEAT_MS = queue.LOCK_HEARTBEAT_MS;

/** Shipped cooldown fallback (config overrides, §8.6). */
const DEFAULT_COOLDOWN_HARD_DAYS = usageLog.DEFAULT_HARD_DAYS;

/** Conflict-abort error code (a foreign writer touched the queue mid-run). */
const QUEUE_CONFLICT_CODE = 'EQUEUECONFLICT';

/** Publish-edge failure codes emitted onto the entry / ledger (SYS and PKG families, §10.2). */
const CODE = Object.freeze({
  MEDIA_COOLDOWN_BLOCKED: 'PKG.MEDIA_COOLDOWN_BLOCKED',
  TEST_PUBLISH_BLOCKED: 'SYS.TEST_PUBLISH_BLOCKED',
  RETRY_EXHAUSTED: 'SYS.RETRY_EXHAUSTED',
  HANDOFF_FAILED: 'SYS.HANDOFF_FAILED',
  INTERRUPTED_MID_PUBLISH: 'SYS.INTERRUPTED_MID_PUBLISH',
});

// ---------------------------------------------------------------------------
// Logging (redact-at-write, §13.3)
// ---------------------------------------------------------------------------

function log(msg) {
  const ts = new Date().toISOString();
  // Redact before the line reaches stdout/log capture — a publisher error string can carry a
  // signed URL or token-shaped value (the production Tier-2 leak class).
  console.log(`[${ts}] ${typeof msg === 'string' ? redactString(msg) : JSON.stringify(redact(msg))}`);
}

// Scrub a free-text log line via the shared redactor's string path.
function redactString(str) {
  const out = redact({ _: String(str) });
  return out && typeof out._ === 'string' ? out._ : String(str);
}

function recordLedger(method, payload, env) {
  try {
    if (typeof ledger[method] === 'function') ledger[method](payload, env);
  } catch (e) {
    log(`  WARN: workflow ledger ${method} failed: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// Config (system.json) — the Tier-3 home for mode, reviewers, publish posture, cooldown
// ---------------------------------------------------------------------------

const SAFE_DEFAULT_CONFIG = Object.freeze({
  mode: 'SAFE',
  reviewers: [],
  publish: { draft_only: true, auto_publish_allowed: false },
  approval_surface: { adapter: 'discord', channels: {} },
  cooldown: { hard_days: DEFAULT_COOLDOWN_HARD_DAYS, target_days: usageLog.DEFAULT_TARGET_DAYS },
});

/**
 * Load config/system.json. A missing/unreadable/malformed config falls back to the SAFE default
 * posture (fail-closed: no reviewers ⇒ no approval passes, mode SAFE ⇒ no publisher calls). The
 * caller's env may pin `mode`/posture via the §4.5 overrides applied in resolvePosture().
 */
function loadConfig(env = process.env) {
  let raw;
  try {
    raw = fs.readFileSync(paths.systemConfig(env), 'utf8');
  } catch {
    return { ...SAFE_DEFAULT_CONFIG };
  }
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch (e) {
    const err = new Error(`config/system.json is not valid JSON: ${e.message}`);
    err.code = 'ECONFIGMALFORMED';
    throw err;
  }
  return {
    ...SAFE_DEFAULT_CONFIG,
    ...cfg,
    publish: { ...SAFE_DEFAULT_CONFIG.publish, ...(cfg.publish || {}) },
    approval_surface: { ...SAFE_DEFAULT_CONFIG.approval_surface, ...(cfg.approval_surface || {}) },
    cooldown: { ...SAFE_DEFAULT_CONFIG.cooldown, ...(cfg.cooldown || {}) },
  };
}

/**
 * The effective mode for this run. config/system.json is canonical; ENGINE_MODE may pin it for a
 * one-off diagnostic run (§4.5), but it can only be more conservative is NOT enforced here — the
 * spec keeps posture in config; the env override is a documented diagnostic lever, loud at start.
 * Unknown values fall closed to SAFE.
 */
function resolveMode(cfg, env = process.env) {
  const candidate = String(env.ENGINE_MODE || cfg.mode || 'SAFE').toUpperCase();
  return ['SAFE', 'LIVE_PREVIEW', 'LIVE'].includes(candidate) ? candidate : 'SAFE';
}

// ---------------------------------------------------------------------------
// Test-mode guard (§4.5/§18.2) — test content can NEVER reach a real publish path
// ---------------------------------------------------------------------------

function isTestContentId(contentId) {
  return /^test-/iu.test(String(contentId || '').trim());
}

function assertNotTestPublish(contentId, context, env = process.env) {
  if (isTestContentId(contentId) || env.ENGINE_TEST_MODE === '1') {
    const reason = isTestContentId(contentId) ? `content_id "${contentId}" is a TEST- id` : 'ENGINE_TEST_MODE=1';
    const err = new Error(`[ENGINE_TEST_MODE GUARD] Refusing ${context} — ${reason}. Test content can never reach a real publish path.`);
    err.code = CODE.TEST_PUBLISH_BLOCKED;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Entry helpers (read fields off a parsed queue entry)
// ---------------------------------------------------------------------------

function entryId(entry) {
  return entry.fields.content_id || entry.header;
}

function entryState(entry) {
  return entry.fields.state || 'approved';
}

function entryAttempts(entry) {
  const n = parseInt(entry.fields.attempt_count, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** CONTENT_HOME-relative media refs bound to the entry (cooldown identity, §8.6). */
function entryMediaRefs(entry) {
  const refs = [];
  const raw = entry.fields.media_refs;
  if (Array.isArray(raw)) refs.push(...raw);
  else if (typeof raw === 'string' && raw.trim() && raw.trim().toLowerCase() !== 'null') {
    // serialized as JSON array or a single value
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) refs.push(...parsed);
      else refs.push(raw.trim());
    } catch {
      refs.push(raw.trim());
    }
  }
  return refs
    .map((r) => String(r).trim())
    .filter((r) => r && r.toLowerCase() !== 'null' && !/^https?:/iu.test(r));
}

/** The publisher-adapter name for the entry's platform (§11.3 binding; default postiz). */
function publisherFor(entry) {
  const explicit = entry.fields.publisher && String(entry.fields.publisher).trim();
  if (explicit) return explicit;
  const platform = String(entry.fields.platform || '').toLowerCase();
  if (platform === 'giphy') return 'giphy';
  return 'postiz';
}

// ---------------------------------------------------------------------------
// Publish-edge gates (§14.1 layer 3) — each returns { ok, reason, code? }; pure, no side effects
// ---------------------------------------------------------------------------

/**
 * Build the gate set bound to the run context (config + the usage ledger). Gates are pure: they
 * read the entry + context and return a verdict; the executor records results and decides flow.
 */
function buildGates(ctx) {
  return {
    // DD-17: the approver must be on the config reviewers allowlist with `approve` rights.
    // (Hardcoded single-approver id retired — Tier-3 ledger entry.)
    approver_allowlisted(entry) {
      const approvedBy = String(entry.fields.approved_by || '').trim();
      if (!approvedBy) return { ok: false, reason: 'no recorded approver (approved_by empty)' };
      const reviewer = (ctx.config.reviewers || []).find(
        (r) => r && String(r.id) === approvedBy,
      );
      if (!reviewer) return { ok: false, reason: `approver "${approvedBy}" is not on the reviewers allowlist (DD-17)` };
      if (!Array.isArray(reviewer.rights) || !reviewer.rights.includes('approve')) {
        return { ok: false, reason: `reviewer "${approvedBy}" lacks approve rights (DD-17)` };
      }
      return { ok: true, reason: `approver ${approvedBy} is allowlisted with approve rights` };
    },

    // Approved copy still pending real media cannot publish (placeholder previews).
    media_complete(entry) {
      const state = String(entry.fields.state || '').toLowerCase();
      const hold = String(entry.fields.hold_reason || '').toLowerCase();
      if (state === 'approved_pending_media' || hold.includes('pending_media')) {
        return { ok: false, reason: 'approved copy is still pending real media; placeholder previews cannot publish' };
      }
      return { ok: true, reason: 'media is complete or not required' };
    },

    // §8.6/§14.1 enforcement point 3 (DD-14): block reuse of an asset (family-aware) that is
    // inside its hard cooldown window per the canonical usage-log. Same ledger + same code the
    // retrieval filter and package validation read, so a confirmed publish that wrote the ledger
    // blocks a same-asset re-publish here too.
    media_cooldown(entry) {
      const refs = entryMediaRefs(entry);
      if (!refs.length) return { ok: true, reason: 'no reusable media ref to cooldown-check' };
      const id = entryId(entry);
      const hardDays = ctx.cooldownHardDays;
      for (const ref of refs) {
        const status = usageLog.cooldownStatus(ref, {
          hardDays,
          excludeContentId: id, // re-gating the same item must not block itself
          records: ctx.usageRecords,
          env: ctx.env,
        });
        if (status.cooldown_blocked) {
          const last = status.last_use || {};
          return {
            ok: false,
            code: CODE.MEDIA_COOLDOWN_BLOCKED,
            reason:
              `media "${status.asset_id}" is inside its ${hardDays}-day cooldown — last used by ` +
              `${last.content_id || 'unknown'} ${status.days_since_last_use ?? '?'} days ago ` +
              `(match: ${last.match_reason || 'asset'}); pick a different asset or get explicit continuation approval`,
          };
        }
      }
      return { ok: true, reason: `no asset reuse inside ${hardDays} days` };
    },

    // The platform must resolve to a registered publisher adapter (§12.3) — else a precise
    // wiring error rather than a publish-time crash (§15.1).
    publisher_registered(entry) {
      const name = publisherFor(entry);
      if (publishers.has(name)) return { ok: true, reason: `publisher adapter "${name}" registered` };
      return { ok: false, reason: `no publisher adapter registered as "${name}"; bind the platform to a shipped adapter (§11.3)` };
    },

    // Test ids never publish (defense in depth — the handoff guard is the hard stop).
    not_test_content(entry) {
      const id = entryId(entry);
      if (isTestContentId(id)) return { ok: false, code: CODE.TEST_PUBLISH_BLOCKED, reason: `content_id "${id}" is a TEST- id; never publishes` };
      return { ok: true, reason: 'not test content' };
    },

    // A content item already published must not publish again (idempotency backstop).
    no_duplicate(entry) {
      const id = entryId(entry);
      const dup = ctx.entries.find(
        (e) => e !== entry && entryId(e) === id && String(e.fields.state || '').toLowerCase() === 'published',
      );
      if (dup) return { ok: false, reason: `content_id ${id} already published` };
      return { ok: true, reason: 'not a duplicate' };
    },
  };
}

function runGates(entry, gates) {
  const results = {};
  for (const [name, fn] of Object.entries(gates)) {
    try {
      results[name] = fn(entry);
    } catch (e) {
      results[name] = { ok: false, reason: `gate threw: ${e.message}` };
    }
  }
  return results;
}

function compactGateResults(results) {
  return Object.fromEntries(
    Object.entries(results).map(([name, r]) => [name, { ok: Boolean(r.ok), reason: r.reason || '', code: r.code || null }]),
  );
}

// ---------------------------------------------------------------------------
// Lock + queue I/O wrappers (all state under $CONTENT_HOME via paths.js)
// ---------------------------------------------------------------------------

/**
 * A run context bundles the resolved paths, the held lock, the read snapshot, and the in-memory
 * entries — so the persist/crash-flush closures (the heart of the crash-safety series) operate on
 * one consistent set. State writes go ONLY through queue.writeFileAtomic + the snapshot guard.
 */
function makeRunContext(env) {
  const queuePath = queue.queueFilePath(env);
  const lockPath = queue.queueLockFilePath(env);
  return { env, queuePath, lockPath };
}

// ---------------------------------------------------------------------------
// Per-entry transition + persistence (the write-ahead substrate, DD-4)
// ---------------------------------------------------------------------------

/**
 * Apply a state transition (+ fields) to an in-memory entry and mark it mutated. Persistence is a
 * SEPARATE step (persistQueue) so the caller controls write-ahead ordering: mutate → persist →
 * external call. The mutated entry is re-serialized canonically by serializeQueue (FIELD_ORDER,
 * region-stable); matching is by the entry object identity (we hold the parsed array).
 */
function transition(entry, to, fields = {}) {
  entry.fields.state = to;
  entry.fields.state_updated_at = new Date().toISOString();
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    entry.fields[k] = v === null ? 'null' : v;
  }
  entry._mutated = true;
}

// ---------------------------------------------------------------------------
// Handoff + verify (the LIVE second-gate flow, §8.3)
// ---------------------------------------------------------------------------

/**
 * Build the §7.4 package shape the adapter's handoff expects from a queue entry. The executor does
 * not parse the package file itself — it passes the entry's audit fields + the adapter-relevant
 * binding; the adapter (postiz/giphy) extracts what it needs (DD-10 minimal interface).
 */
function packageFromEntry(entry) {
  const f = entry.fields;
  const mediaRefs = entryMediaRefs(entry);
  return {
    audit_header: {
      content_id: entryId(entry),
      brand: f.brand || null,
      platform: f.platform || null,
      mode: f.mode || null,
      format: f.format || null,
      schedule_time: f.schedule_time || null,
      approved_copy: f.approved_copy || null,
      media_path: mediaRefs[0] || null,
      integration_ref: f.integration_ref || null,
    },
    content_id: entryId(entry),
    integration_ref: f.integration_ref || null,
    schedule_time: f.schedule_time || null,
    format: f.format || null,
  };
}

/**
 * Resolve a CONTENT_HOME-relative media ref to an absolute path the adapter can read. Remote URLs
 * pass through. Absolute paths (defensive) pass through.
 */
function resolveMediaPath(ref, env) {
  if (!ref) return null;
  const raw = String(ref).trim();
  if (!raw || raw.toLowerCase() === 'null') return null;
  if (/^https?:/iu.test(raw)) return raw;
  if (path.isAbsolute(raw)) return raw;
  try {
    return path.join(paths.contentHome(env), raw);
  } catch {
    return raw;
  }
}

/**
 * Hand one approved item to its publisher adapter (LIVE only). Write-ahead `publish_intent` and
 * the attempt-counter increment have ALREADY been persisted by the caller before this is invoked.
 * Returns a normalized outcome the caller maps onto queue states:
 *   { kind:'handed_off', external_ref, ... } | { kind:'published', ... }
 *   { kind:'ambiguous', error }   -> hold (artifact may exist)
 *   { kind:'failed', error }      -> retryable handoff failure
 */
async function handoffOne(entry, ctx) {
  const id = entryId(entry);
  assertNotTestPublish(id, 'publisher handoff', ctx.env); // hard stop — no override

  const adapter = publishers.get(publisherFor(entry));
  const pkg = packageFromEntry(entry);
  const mediaRef = entryMediaRefs(entry)[0] || null;
  const options = {
    env: ctx.env,
    content: entry.fields.approved_copy || undefined,
    integration_ref: entry.fields.integration_ref || undefined,
    media_path: resolveMediaPath(mediaRef, ctx.env) || undefined,
    file: resolveMediaPath(mediaRef, ctx.env) || undefined,
  };

  let result;
  try {
    result = await adapter.handoff(pkg, options);
  } catch (err) {
    // Idempotency / ambiguity classification (DR W#35): a handoff whose outcome is unknown — the
    // adapter tagged it `phase: 'post-succeeded'` (the call landed; only the id lookup failed) or
    // `phase: 'post'` with no httpStatus (no real HTTP response = aborted/timeout, artifact MAY
    // exist) — MUST hold, never plain-retry. A DEFINITE backend rejection (httpStatus present) is
    // a retryable failure (no artifact).
    const phase = err && err.phase;
    const ambiguous = phase === 'post-succeeded' || (phase === 'post' && err.httpStatus == null) || err.ambiguous === true;
    if (ambiguous) return { kind: 'ambiguous', error: err };
    return { kind: 'failed', error: err };
  }

  const state = result && result.state;
  if (state === publishers.PUBLISH_STATE.PUBLISHED) {
    return {
      kind: 'published',
      external_ref: result.external_ref || null,
      post_url: result.post_url || null,
      published_at: result.published_at || new Date().toISOString(),
      result,
    };
  }
  if (state === publishers.PUBLISH_STATE.FAILED_HANDOFF) {
    return { kind: 'failed', error: new Error(`adapter reported failed_handoff for ${id}`) };
  }
  if (state === publishers.PUBLISH_STATE.UNVERIFIABLE) {
    // The adapter could not confirm the handoff produced a usable artifact. Treat like ambiguous:
    // hold for operator verification rather than claim handed_off (honest, RD-7).
    return { kind: 'ambiguous', error: new Error(`adapter returned unverifiable state for ${id}`) };
  }
  // HANDED_OFF (the draft/second-gate case) or NOT_FOUND-shaped — treat any draft/handoff as
  // handed_off; the verifyStatus tick advances it to published.
  return {
    kind: 'handed_off',
    external_ref: result && result.external_ref ? result.external_ref : null,
    result,
  };
}

/**
 * Poll the adapter's truth-check for an entry sitting in `handed_off`, advancing it to `published`
 * when the backend confirms (§8.3 second-gate completion). An ambiguous/outage response leaves the
 * entry in `handed_off` (never a fabricated published — RD-7). NOT_FOUND is surfaced as a hold for
 * operator attention (the handoff record exists but the backend lost it).
 */
async function verifyOne(entry, ctx) {
  const id = entryId(entry);
  const externalRef = entry.fields.external_post_ref || (entry.fields.publish_intent || null);
  if (!externalRef || externalRef === 'unknown') {
    return { kind: 'noop', reason: 'no external_post_ref to verify' };
  }
  const adapter = publishers.get(publisherFor(entry));
  let status;
  try {
    status = await adapter.verifyStatus(externalRef, { env: ctx.env });
  } catch (err) {
    // Outage / ambiguous error is NOT a publish confirmation — keep handed_off, retry next tick.
    return { kind: 'noop', reason: `verifyStatus errored (kept handed_off): ${err.message}` };
  }
  if (status && status.state === publishers.PUBLISH_STATE.PUBLISHED) {
    return {
      kind: 'published',
      external_ref: externalRef,
      post_url: status.post_url || null,
      published_at: status.published_at || new Date().toISOString(),
    };
  }
  if (status && status.state === publishers.PUBLISH_STATE.NOT_FOUND) {
    return { kind: 'not_found', reason: `backend no longer knows external_ref ${externalRef}` };
  }
  return { kind: 'noop', reason: `still ${status ? status.state : 'unknown'} — awaiting operator publish` };
}

// ---------------------------------------------------------------------------
// Usage write-back (DD-14) — record confirmed publishes into the canonical cooldown ledger
// ---------------------------------------------------------------------------

function recordUsageOnPublish(entry, ctx) {
  const id = entryId(entry);
  for (const ref of entryMediaRefs(entry)) {
    try {
      usageLog.recordUse(
        { asset_id: ref, content_id: id, platform: entry.fields.platform || undefined },
        { env: ctx.env },
      );
    } catch (e) {
      // Failed index write is alerted, never silently skipped (§15.1 / DD-14). The publish itself
      // already succeeded; we surface the integrity gap rather than rolling it back.
      log(`  WARN: usage write-back failed for ${id} asset ${ref}: ${e.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// main() — the queue walk
// ---------------------------------------------------------------------------

async function main(env = process.env) {
  // Test-mode hard guard: the prod executor must never run in test mode (§4.5/§18.2). The fixture
  // harness simulates the queue/executor against test channels; letting this run risks live effects.
  if (env.ENGINE_TEST_MODE === '1') {
    console.error('[ENGINE_TEST_MODE GUARD] publish-executor refuses to run with ENGINE_TEST_MODE=1. Use the fixture-run harness instead.');
    return EXIT.TEST_MODE;
  }

  // Kill switch (§15.4): every autonomous loop checks the PAUSED sentinel first.
  let pausedPath;
  try {
    pausedPath = paths.pausedSentinel(env);
  } catch (e) {
    // CONTENT_HOME unset — fail fast with a named remediation (§15.1).
    console.error(e.message);
    return EXIT.MALFORMED;
  }
  if (fs.existsSync(pausedPath)) {
    log('PAUSED sentinel present — kill switch engaged (§15.4). Exiting without processing.');
    return EXIT.PAUSED;
  }

  let cfg;
  try {
    cfg = loadConfig(env);
  } catch (e) {
    console.error(`FATAL: ${e.message}`);
    return EXIT.MALFORMED;
  }
  const mode = resolveMode(cfg, env);

  const ctx = makeRunContext(env);

  // Acquire the ONE canonical queue lock; skip-and-log on overlap (DD-19 → skipped_on_overlap).
  const lock = queue.acquireLock(ctx.lockPath, {
    owner: 'publish-executor',
    staleMinutes: LOCK_STALE_MINUTES,
  });
  if (!lock.acquired) {
    const h = lock.heldBy || {};
    const ageMin = Number.isFinite(lock.ageMs) ? (lock.ageMs / 60000).toFixed(1) : '?';
    log(`SKIP: queue lock held by ${h.owner || 'unknown'} (pid ${h.pid}) (${ageMin}m ago, < ${LOCK_STALE_MINUTES}m TTL). Another writer active. Exiting cleanly.`);
    return EXIT.OK; // overlap is not an error — skip-and-log (DD-19)
  }

  // Keep the held lock fresh across long awaits (slow handoff, big upload) so an alive run is
  // never reclaimed as stale mid-run (DD-19 heartbeat). unref so it never keeps the process alive.
  let heartbeatWarned = false;
  const heartbeat = setInterval(() => {
    if (!queue.touchLock(ctx.lockPath) && !heartbeatWarned) {
      heartbeatWarned = true;
      log('WARN: lock heartbeat failed (lock missing/foreign-owned); the pre-write conflict check is now the only guard');
    }
  }, LOCK_HEARTBEAT_MS);
  if (typeof heartbeat.unref === 'function') heartbeat.unref();

  log(`Publish executor starting. mode=${mode} draft_only=${cfg.publish.draft_only !== false} pid=${process.pid}.`);

  let crashFlush = null;
  try {
    if (!fs.existsSync(ctx.queuePath)) {
      log(`Queue file not found at ${ctx.queuePath} — nothing to process.`);
      return EXIT.OK;
    }

    // stat-read-stat: snapshot BEFORE reading, re-read once if the file moved under us, so the
    // snapshot never describes a version NEWER than `raw` (a later snapshot could absorb a foreign
    // write and blind every conflict check).
    let queueStat = queue.statSnapshot(ctx.queuePath);
    let raw = fs.readFileSync(ctx.queuePath, 'utf8');
    if (queue.statChanged(ctx.queuePath, queueStat)) {
      queueStat = queue.statSnapshot(ctx.queuePath);
      raw = fs.readFileSync(ctx.queuePath, 'utf8');
    }

    let entries;
    try {
      entries = queue.parseQueue(raw);
    } catch (e) {
      log(`FATAL: malformed queue file: ${e.message}`);
      return EXIT.MALFORMED;
    }
    ctx.entries = entries;

    // Cooldown context: read the canonical usage ledger ONCE for the run (point 3, §8.6/DD-14).
    ctx.config = cfg;
    ctx.cooldownHardDays = Number.isFinite(cfg.cooldown && cfg.cooldown.hard_days)
      ? cfg.cooldown.hard_days
      : DEFAULT_COOLDOWN_HARD_DAYS;
    let usageRecords;
    try {
      usageRecords = usageLog.readLedger(env);
    } catch {
      usageRecords = [];
    }
    ctx.usageRecords = usageRecords;

    const gates = buildGates(ctx);

    // The write-ahead persist (DD-4): re-serialize ONLY mutated entries and write atomically,
    // refusing to overwrite a file a foreign writer touched mid-run (EQUEUECONFLICT). Snapshot the
    // tmp BEFORE the rename (rename preserves mtime+size on a single fs, so the snapshot describes
    // OUR content, never a foreign write).
    let lastWritten = null;
    const writeQueue = () => {
      const updated = queue.serializeQueue(raw, entries);
      if (updated === (lastWritten == null ? raw : lastWritten)) return false; // no-op
      const tmp = `${ctx.queuePath}.tmp`;
      fs.writeFileSync(tmp, updated, 'utf8');
      const snap = queue.statSnapshot(tmp);
      if (!snap) throw new Error(`stat of just-written ${tmp} failed; refusing blind conflict detection`);
      queue.writeFileAtomic(ctx.queuePath, updated); // atomic tmp+rename with the Windows EPERM retry
      try { fs.unlinkSync(tmp); } catch {}
      lastWritten = updated;
      return queue.statSnapshot(ctx.queuePath);
    };
    const persistQueue = (reason) => {
      if (queue.statChanged(ctx.queuePath, queueStat)) {
        const err = new Error(`publish-queue.md changed on disk mid-run; refusing to overwrite it (at: ${reason})`);
        err.code = QUEUE_CONFLICT_CODE;
        throw err;
      }
      const written = writeQueue();
      if (written) {
        queueStat = written; // snapshot of OUR content, taken post-rename
        log(`  queue persisted (${reason})`);
      }
    };
    crashFlush = () => {
      try {
        if (queue.statChanged(ctx.queuePath, queueStat)) {
          log('crash-flush skipped: queue changed on disk under us');
        } else if (writeQueue()) {
          log('crash-flush: in-memory queue state persisted before exit');
        }
      } catch (e) {
        log(`crash-flush failed: ${e.message}`);
      }
    };

    if (entries.length === 0) {
      log('Queue has 0 entries. Nothing to do.');
      return EXIT.OK;
    }

    const targetId = env.TARGET_CONTENT_ID || env.CONTENT_ID || null;
    const retryGatesFailed = env.RETRY_GATES_FAILED === '1';
    let blocked = 0;
    let mutated = false;

    for (const entry of entries) {
      const id = entryId(entry);
      if (targetId && id !== targetId) continue;

      // Test ids never publish from the prod queue, even outside test mode.
      if (isTestContentId(id)) {
        log(`  SKIP test content_id "${id}" — TEST- ids never publish.`);
        continue;
      }

      const state = entryState(entry);

      // CRASH-RECOVERY HOLD (§15.1): an entry found at `publish_intent` means a previous run died
      // after the write-ahead intent but before the result write. The external artifact may or may
      // not exist — NEVER auto-retry (that replays a publish). Quarantine in `interrupted_hold` for
      // explicit operator release. A dedicated state (not failed_handoff) so RETRY_GATES_FAILED can
      // never readmit it.
      if (state === 'publish_intent') {
        transition(entry, 'interrupted_hold', {
          hold_reason: 'interrupted_mid_publish',
          error:
            `interrupted_mid_publish: a previous run died after entering 'publish_intent' ` +
            `(last checked ${entry.fields.state_updated_at || 'unknown'}). Verify in the publisher whether ` +
            `the artifact exists; if not, set 'state: approved' to retry.`,
        });
        mutated = true;
        recordLedger('handoffUpdated', {
          content_id: id,
          event_type: 'interrupted_mid_publish_hold',
          status: 'interrupted_hold',
          queue_state: 'interrupted_hold',
          executor_error: entry.fields.error,
        }, env);
        persistQueue('interrupted-hold');
        blocked++;
        log(`HOLD ${id} — interrupted_mid_publish`);
        continue;
      }

      // SECOND-GATE COMPLETION (§8.3): an entry sitting in `handed_off` is polled — the operator
      // may have published the draft in the publisher; verifyStatus advances it to `published`.
      if (state === 'handed_off') {
        if (mode !== 'LIVE') {
          log(`  SKIP ${id} — handed_off but mode is ${mode} (verify only in LIVE)`);
          continue;
        }
        log(`VERIFY ${id} (state=handed_off)`);
        const v = await verifyOne(entry, ctx);
        if (v.kind === 'published') {
          // Persist BEFORE the usage write-back so a write-back failure cannot lose the published
          // record. Usage write-back (DD-14) fires on confirmed publish.
          transition(entry, 'published', {
            external_post_ref: v.external_ref || entry.fields.external_post_ref || null,
            post_url: v.post_url || null,
            published_at: v.published_at,
            error: null,
          });
          mutated = true;
          recordLedger('handoffUpdated', {
            content_id: id,
            event_type: 'published',
            status: 'published',
            queue_state: 'published',
            post_url: v.post_url || null,
            published_at: v.published_at,
          }, env);
          persistQueue('published');
          recordUsageOnPublish(entry, ctx);
          log(`  PUBLISHED ${id}`);
        } else if (v.kind === 'not_found') {
          transition(entry, 'interrupted_hold', {
            hold_reason: 'handoff_lost',
            error: `handoff_lost: ${v.reason} — verify in the publisher before re-queueing.`,
          });
          mutated = true;
          persistQueue('handoff-lost-hold');
          blocked++;
          log(`  HOLD ${id} — ${v.reason}`);
        } else {
          log(`  ${id} ${v.reason}`);
        }
        continue;
      }

      // Only `approved` / `edited_approved` (and, under the operator flag, `failed_handoff`) are
      // eligible for a (re)handoff attempt. Everything else is terminal/held — skip and log.
      const eligible =
        state === 'approved' ||
        state === 'edited_approved' ||
        (retryGatesFailed && state === 'failed_handoff');
      if (!eligible) {
        log(`SKIP ${id} — state is ${state}`);
        continue;
      }

      log(`PROCESS ${id} (state=${state})`);
      const results = runGates(entry, gates);
      const failed = Object.entries(results).filter(([, r]) => !r.ok);
      transition(entry, state, { safety_gate_results: JSON.stringify(compactGateResults(results)) });
      mutated = true;
      recordLedger('executorGateResults', {
        content_id: id,
        queue_state: state,
        results: compactGateResults(results),
        failed: failed.map(([name, r]) => ({ name, reason: r.reason || '' })),
        executor_error: failed.length ? failed.map(([n, r]) => `${n}: ${r.reason || ''}`).join('; ') : null,
      }, env);

      if (failed.length > 0) {
        const firstCode = failed.map(([, r]) => r.code).find(Boolean) || null;
        transition(entry, 'manual_review', {
          hold_reason: 'gates_failed',
          error: failed.map(([n, r]) => `${n}: ${r.reason || ''}`).join('; '),
          last_gate_code: firstCode,
        });
        recordLedger('handoffUpdated', {
          content_id: id,
          event_type: 'publish_blocked',
          status: 'manual_review',
          queue_state: 'manual_review',
          executor_error: entry.fields.error,
        }, env);
        persistQueue('gates-failed');
        blocked++;
        log(`  BLOCKED ${id} — ${failed.length} gate(s) failed${firstCode ? ` [${firstCode}]` : ''}`);
        for (const [n, r] of failed) log(`    ${n}: ${r.reason}`);
        continue;
      }
      log(`  GATES PASS`);

      // Mode ladder (§8.3): SAFE / LIVE_PREVIEW perform NO publisher call. The item is gated and
      // ready; it simply does not hand off. (SAFE wouldn't normally reach the queue, but the
      // executor stays fail-closed if it does.) BOTH the run mode AND the item's own produced-under
      // mode must be LIVE: a LIVE_PREVIEW item never publishes even on a LIVE run, and it is NOT a
      // gate failure — it is the expected mode-ladder behavior, so the entry is left in place.
      const itemMode = String(entry.fields.mode || 'LIVE_PREVIEW').toUpperCase();
      if (mode !== 'LIVE') {
        log(`  ${mode}: gates pass; no publisher call (publish disabled below LIVE). Leaving ${id} in ${state}.`);
        continue;
      }
      if (itemMode !== 'LIVE') {
        log(`  item ${id} was produced under ${itemMode}; no publisher call (real publish needs MODE: LIVE on the original command). Leaving in ${state}.`);
        continue;
      }

      // ---- LIVE handoff with the full crash-safety series ----

      // DD-13: enforce the retry bound against the DURABLE attempt counter. On exhaustion,
      // dead-letter + an "unfilled slot" notice (no unbounded paid loop, DR W#32).
      const attempts = entryAttempts(entry);
      if (attempts >= RETRY_BOUND) {
        transition(entry, 'dead_lettered', {
          hold_reason: 'retry_exhausted',
          error: `${CODE.RETRY_EXHAUSTED}: handoff failed ${attempts} time(s) (bound ${RETRY_BOUND}); dead-lettered.`,
        });
        mutated = true;
        recordLedger('handoffUpdated', {
          content_id: id,
          event_type: 'dead_lettered',
          status: 'dead_lettered',
          queue_state: 'dead_lettered',
          executor_error: entry.fields.error,
        }, env);
        persistQueue('dead-lettered');
        notifyUnfilledSlot(entry, ctx, `retry exhausted (${attempts}/${RETRY_BOUND})`);
        blocked++;
        log(`  DEAD-LETTERED ${id} — retry bound ${RETRY_BOUND} exhausted`);
        continue;
      }

      // WRITE-AHEAD INTENT (DD-4) + ATTEMPT COUNTER BEFORE SPEND (DD-13): increment the durable
      // attempt counter and transition to `publish_intent`, PERSISTED, BEFORE the external call.
      // A crash between the call and the result write parks this entry next tick (interrupted_hold)
      // instead of re-issuing the handoff.
      transition(entry, 'publish_intent', {
        attempt_count: attempts + 1,
        error: null,
        hold_reason: null,
      });
      mutated = true;
      recordLedger('handoffUpdated', {
        content_id: id,
        event_type: 'publish_intent',
        status: 'publish_intent',
        queue_state: 'publish_intent',
      }, env);
      persistQueue('publish-intent'); // <-- write-ahead: MUST land before handoffOne()

      let outcome;
      try {
        outcome = await handoffOne(entry, ctx);
      } catch (err) {
        // The hard test-mode guard or a wiring error escaped handoffOne's own classification.
        outcome = { kind: 'failed', error: err };
      }

      if (outcome.kind === 'published') {
        // Direct-publish adapter (e.g. Giphy) — live immediately, no second gate.
        transition(entry, 'published', {
          external_post_ref: outcome.external_ref || null,
          post_url: outcome.post_url || null,
          published_at: outcome.published_at,
          error: null,
        });
        recordLedger('handoffUpdated', {
          content_id: id,
          event_type: 'published',
          status: 'published',
          queue_state: 'published',
          post_url: outcome.post_url || null,
          published_at: outcome.published_at,
        }, env);
        persistQueue('published');
        recordUsageOnPublish(entry, ctx);
        log(`  PUBLISHED ${id} (direct)`);
      } else if (outcome.kind === 'handed_off') {
        // The second gate: a draft exists at the publisher; the operator publishes it manually, and
        // a later tick's verifyStatus advances handed_off → published. "Approved but nothing posted
        // yet" is the expected LIVE state, not a failure (§8.3).
        transition(entry, 'handed_off', {
          external_post_ref: outcome.external_ref || null,
          publish_intent: outcome.external_ref || entry.fields.publish_intent || null,
          error: null,
        });
        recordLedger('handoffUpdated', {
          content_id: id,
          event_type: 'handed_off',
          status: 'handed_off',
          queue_state: 'handed_off',
          publisher_draft_id: outcome.external_ref || null,
        }, env);
        // Persist the handoff record BEFORE any best-effort notify so a notify crash can't lose it.
        persistQueue('handed-off');
        notifyHandoff(entry, ctx, outcome.external_ref || null);
        log(`  HANDED OFF ${id} — draft ${outcome.external_ref || 'unknown'} (operator publishes in the publisher)`);
      } else if (outcome.kind === 'ambiguous') {
        // Outcome unknown (timeout / dropped connection / id-lookup fail / unverifiable). The
        // artifact MAY exist — same ambiguity as a crash. HOLD, never plain-retry (DR W#35).
        transition(entry, 'interrupted_hold', {
          hold_reason: 'interrupted_mid_publish',
          error:
            `${CODE.INTERRUPTED_MID_PUBLISH}: ${outcome.error && outcome.error.message ? outcome.error.message : 'outcome unknown'} ` +
            `— verify in the publisher whether the artifact exists before re-queueing.`,
        });
        recordLedger('handoffUpdated', {
          content_id: id,
          event_type: 'interrupted_mid_publish_hold',
          status: 'interrupted_hold',
          queue_state: 'interrupted_hold',
          executor_error: entry.fields.error,
        }, env);
        persistQueue('ambiguous-hold');
        blocked++;
        log(`  HELD ${id} — ambiguous handoff outcome`);
      } else {
        // DEFINITE failure (the backend rejected, no artifact). Mark failed_handoff (retryable
        // within the bound); the attempt counter already spent one attempt. After RETRY_BOUND it
        // dead-letters on the next eligible pass.
        transition(entry, 'failed_handoff', {
          hold_reason: 'handoff_failed',
          error: `${CODE.HANDOFF_FAILED}: ${outcome.error && outcome.error.message ? outcome.error.message : 'handoff failed'}`,
        });
        recordLedger('handoffUpdated', {
          content_id: id,
          event_type: 'failed_handoff',
          status: 'failed_handoff',
          queue_state: 'failed_handoff',
          executor_error: entry.fields.error,
        }, env);
        persistQueue('handoff-failed');
        blocked++;
        log(`  FAILED ${id} — ${entry.fields.error}`);
      }
    }

    if (mutated) persistQueue('final');
    log(`Executor done. ${entries.length} entries walked, ${blocked} blocked/held.`);
    return blocked > 0 ? EXIT.BLOCKED : EXIT.OK;
  } catch (err) {
    console.error(err.stack || err.message);
    if (err && err.code === QUEUE_CONFLICT_CODE) {
      // A foreign writer touched the queue mid-run. Exit WITHOUT writing (our snapshot-based
      // rewrite would erase their change). Already-persisted write-ahead intents make the next
      // tick hold anything in flight.
      return EXIT.CONFLICT;
    }
    // Unexpected crash: best-effort flush of in-memory transitions (incl. write-ahead intents) so
    // the next tick parks in-flight entries instead of replaying their external calls.
    if (typeof crashFlush === 'function') crashFlush();
    return EXIT.MALFORMED;
  } finally {
    clearInterval(heartbeat);
    // Ownership-checked release: only unlink a lock THIS process owns (a foreign lock reclaimed
    // after we were judged stale must survive).
    queue.releaseLock(ctx.lockPath);
  }
}

// ---------------------------------------------------------------------------
// Best-effort operator notices (no hardcoded channel ids — resolved from approval_surface)
// ---------------------------------------------------------------------------

/**
 * The "unfilled slot" notice (DD-13/DD-15): on dead-letter, surface a notice to the ops channel so
 * a failed slot is visible, never silently dropped. v1 ships the notice as a ledger event + a log
 * line keyed off the configured `content-ops` channel id (the surface adapter — Discord in the
 * reference install — delivers it; the executor stays surface-agnostic and never embeds a channel
 * id in code). No automatic redraft (cost containment, §15.3).
 */
function notifyUnfilledSlot(entry, ctx, reason) {
  const channelId = ctx.config && ctx.config.approval_surface && ctx.config.approval_surface.channels
    ? ctx.config.approval_surface.channels['content-ops']
    : null;
  recordLedger('handoffUpdated', {
    content_id: entryId(entry),
    event_type: 'unfilled_slot_notice',
    status: 'dead_lettered',
    queue_state: 'dead_lettered',
    executor_error: `unfilled slot: ${reason}`,
  }, ctx.env);
  log(`  UNFILLED-SLOT NOTICE for ${entryId(entry)} (${reason})${channelId ? ` -> ops channel` : ''}`);
}

/**
 * Handoff confirmation notice: on a successful draft handoff, surface that the draft exists and is
 * awaiting the operator's manual publish (§8.3). v1 records the ledger event + a log line keyed off
 * the configured `content-published` channel id; the surface adapter delivers it. No channel id in
 * code.
 */
function notifyHandoff(entry, ctx, draftId) {
  const channelId = ctx.config && ctx.config.approval_surface && ctx.config.approval_surface.channels
    ? ctx.config.approval_surface.channels['content-published']
    : null;
  if (channelId) log(`  HANDOFF NOTICE for ${entryId(entry)} (draft ${draftId || 'unknown'}) -> published channel`);
}

// ---------------------------------------------------------------------------
// Entry point + exports
// ---------------------------------------------------------------------------

if (require.main === module) {
  main(process.env)
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err.stack || err.message);
      process.exit(EXIT.MALFORMED);
    });
}

module.exports = {
  main,
  EXIT,
  RETRY_BOUND,
  CODE,
  // internals exported for the co-located tests (not a public API surface)
  loadConfig,
  resolveMode,
  buildGates,
  runGates,
  packageFromEntry,
  handoffOne,
  verifyOne,
  publisherFor,
  entryMediaRefs,
  entryAttempts,
  isTestContentId,
  assertNotTestPublish,
};
