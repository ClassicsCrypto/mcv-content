'use strict';

/**
 * engine/orchestrator/run-lock.js  [N net-new — wires the canonical lock into the trigger paths]
 *
 * The DD-19 single-runner lock for the orchestration triggers (release-spec §8.4 concurrency:
 * "single-runner lock per project with skip-and-log on overlap; every run records a named
 * trigger"; §8.2 `skipped_on_overlap`; §11.4 DD-19 fixed-in-v1 invariant).
 *
 * The REALIZED mechanism is the ONE canonical queue lock (engine/shared/queue.js's heartbeated,
 * mtime-stale, O_EXCL lock) — the same lock the publish executor and the reaction listener hold.
 * Wiring every trigger (morning-kickoff, calendar-tick, run-slot, kickoff--now) through THIS lock
 * means a kickoff batch, a tick, and the executor mutually exclude: at most one writer per project
 * touches the queue/dispatch path at a time (model §1.5 invariant — calendar and library writers
 * share the same lock discipline). On a held lock the run is SKIPPED and LOGGED — recorded as
 * `skipped_on_overlap` in the ledger with its named trigger — never queued behind, never run twice.
 *
 * Why a separate module rather than calling queue.acquireLock directly in each trigger: this
 * concentrates (a) the named-trigger validation (DD-19 — every run is attributable), (b) the
 * skip-and-log → `skipped_on_overlap` ledger emission, and (c) the heartbeat lifecycle, in one
 * tested place so the kickoff and tick ports both inherit identical overlap semantics (the bug
 * P3-LOCK guards: divergence between claiming-at-kickoff and claiming-at-tick).
 *
 * The lock helpers are PURE w.r.t. process control — like the queue lock, this module NEVER calls
 * process.exit; the caller (a trigger) decides how to react to a held lock (it skips). `register`
 * defaults to false here (triggers are short-lived and manage their own release in a finally), so
 * tests and library callers do not install process-exit handlers.
 *
 * Tier-3 cleanliness (§0.3 r6 / RD-3): no hardcoded paths (queue.js derives the lock path under
 * $CONTENT_HOME via paths.js), no instance ids, no production codenames.
 */

const fs = require('fs');

const paths = require('./../shared/paths');
const queue = require('./../shared/queue');
const dispatch = require('./dispatch');

/** Recommended heartbeat interval (mirrors the queue lock discipline — well inside the TTL). */
const HEARTBEAT_MS = queue.LOCK_HEARTBEAT_MS;

/** The named triggers a lock holder may declare (DD-19). Reuses the dispatch trigger vocabulary. */
const TRIGGER = dispatch.TRIGGER;
const VALID_TRIGGERS = dispatch.VALID_TRIGGERS;

/**
 * Try to claim the single-runner lock for a named trigger (non-blocking). On success returns a
 * handle whose .release() unlinks the lock (ownership-checked) and stops the heartbeat. On a held
 * lock returns { acquired:false, skipped_on_overlap:true, heldBy } — the caller records the skip.
 *
 * @param {object}  [opts]
 * @param {string}  [opts.trigger]   the named trigger (TRIGGER.*) — required for attribution (DD-19)
 * @param {object}  [opts.env]       environment for paths resolution (default process.env)
 * @param {boolean} [opts.heartbeat] keep the lock fresh across a long run (default true)
 * @param {boolean} [opts.register]  install process-exit release handlers (default false)
 * @returns {{ acquired:boolean, trigger:string, lockPath:string, heldBy?:object, ageMs?:number,
 *             skipped_on_overlap?:boolean, release?:Function, touch?:Function }}
 */
function claimRunLock(opts = {}) {
  const env = opts.env || process.env;
  const trigger = VALID_TRIGGERS.has(opts.trigger) ? opts.trigger : null;
  if (!trigger) {
    // DD-19: a run with no named trigger is unattributable — refuse rather than acquire anonymously.
    return { acquired: false, trigger: opts.trigger || null, error: 'a valid named trigger is required (DD-19)' };
  }

  const lockPath = queue.queueLockFilePath(env);
  // The canonical queue lock lives in $CONTENT_HOME/queue/locks/; ensure it exists before the
  // O_EXCL create (queue.acquireLock does not mkdir — `engine init` lays the tree, but a trigger
  // may fire against a freshly-resolved home, so we make the lock acquirable here).
  try { fs.mkdirSync(paths.queueLocksDir(env), { recursive: true }); } catch { /* surfaced by acquireLock */ }
  const res = queue.acquireLock(lockPath, {
    owner: trigger,
    register: opts.register === true,
  });

  if (!res.acquired) {
    return {
      acquired: false,
      trigger,
      lockPath,
      heldBy: res.heldBy || null,
      ageMs: res.ageMs,
      transient: Boolean(res.transient),
      skipped_on_overlap: true,
    };
  }

  // Heartbeat the held lock so a long-but-alive trigger run is never reclaimed mid-run (DD-19).
  let heartbeat = null;
  if (opts.heartbeat !== false) {
    heartbeat = setInterval(() => { queue.touchLock(lockPath); }, HEARTBEAT_MS);
    if (typeof heartbeat.unref === 'function') heartbeat.unref();
  }

  let released = false;
  return {
    acquired: true,
    trigger,
    lockPath,
    touch: () => queue.touchLock(lockPath),
    release: () => {
      if (released) return false;
      released = true;
      if (heartbeat) clearInterval(heartbeat);
      // Ownership-checked release: never unlink a lock another process reclaimed after we were
      // (wrongly) judged stale.
      return queue.releaseLock(lockPath);
    },
  };
}

/**
 * Record a skipped-on-overlap run in the workflow ledger with its named trigger (DD-19; §8.2). The
 * ledger module is required lazily so this file has no hard cycle with workflow-ledger and so a
 * caller can pass a stub ledger in tests. Best-effort: a ledger failure never crashes the trigger.
 *
 * The skip is recorded as a run-level event keyed by a synthetic content id describing the trigger
 * occurrence (no content item exists for a skipped run), so `engine status` can surface "trigger X
 * skipped at T because the lock was held by Y".
 */
function recordOverlapSkip(claim, opts = {}) {
  const env = opts.env || process.env;
  let ledger = opts.ledger;
  if (!ledger) {
    try { ledger = require('./workflow-ledger'); } catch { ledger = null; }
  }
  if (!ledger || typeof ledger.runDispatched !== 'function') return null;
  const held = (claim && claim.heldBy) || {};
  const ts = new Date().toISOString();
  const occurrenceId = `skipped_on_overlap-${claim.trigger}-${ts}`;
  try {
    return ledger.runDispatched({
      content_id: occurrenceId,
      ok: false,
      trigger: claim.trigger,
      dispatcher: 'run-lock',
      command_family: null,
      error: `skipped_on_overlap: queue lock held by ${held.owner || 'unknown'} (pid ${held.pid != null ? held.pid : '?'})`,
    }, env);
  } catch {
    return null;
  }
}

/**
 * Run `fn` under the single-runner lock, or skip-and-log on overlap. This is the convenience
 * wrapper the kickoff/tick ports use so they all get identical DD-19 semantics. `fn` receives the
 * acquired claim handle (so it can touch() the lock during long inner work). On overlap the run is
 * recorded as `skipped_on_overlap` and the function returns { ran:false, skipped_on_overlap:true }.
 *
 * @param {object}   opts  { trigger, env, ledger?, heartbeat?, register? }
 * @param {Function} fn    async (claim) => result
 * @returns {Promise<{ ran:boolean, result?, skipped_on_overlap?:boolean, heldBy?, error? }>}
 */
async function withRunLock(opts, fn) {
  const claim = claimRunLock(opts);
  if (!claim.acquired) {
    if (claim.error) return { ran: false, error: claim.error };
    recordOverlapSkip(claim, opts);
    return { ran: false, skipped_on_overlap: true, heldBy: claim.heldBy || null };
  }
  try {
    const result = await fn(claim);
    return { ran: true, result };
  } finally {
    claim.release();
  }
}

module.exports = {
  HEARTBEAT_MS,
  TRIGGER,
  claimRunLock,
  recordOverlapSkip,
  withRunLock,
};
