'use strict';

/**
 * engine/orchestrator/dispatch.js  [N net-new — the RD-18 run-dispatch transport]
 *
 * The run-dispatch transport: every run — scheduled or ad hoc — is a schema'd SLOT-RUN TASK
 * RECORD written to `$CONTENT_HOME/ledger/tasks/` in state `pending` (release-spec §8.4 run
 * mechanics; RD-18; §7.11 task-record shape; §13.1 run attribution; DD-19 named-trigger
 * discipline). The host runtime consumes pending records through a per-runtime hook
 * (docs/runtimes/<runtime>.md); the engine never calls a chain-seat LLM (RD-2). The invariant:
 * NO TASK RECORD, NO RUN — task records double as the run-attribution records `engine status`
 * reports on.
 *
 * This module owns:
 *   - the task-record lifecycle on disk (write `pending`; claim → `claimed`; complete → `done`;
 *     fail → `failed`), each transition persisted atomically (tmp + rename) so a crash never
 *     leaves a half-written record;
 *   - the dispatch PREFLIGHT (§15.4): the PAUSED sentinel and an optional spend-cap hook are
 *     checked BEFORE any record is written — a paused/over-budget project dispatches nothing
 *     (stopping dispatch stops new chain spend, RD-19/§15.4). The spend-cap hook is a no-op
 *     placeholder until P6-SPEND wires the real ledger-backed evaluation;
 *   - the on-demand verbs the CLI calls: `dispatchTask` (write one record from a command) and
 *     `runSlot` (validate a named calendar slot against the calendar, then dispatch one record);
 *   - the engine-side CONSUMPTION surface (list / peek pending, claim, mark-consumed) so any
 *     runtime — or a human prompt — can satisfy the RD-18 hook against `ledger/tasks/`.
 *
 * Every record carries its NAMED TRIGGER (`morning-kickoff | calendar-tick | run-slot |
 * kickoff--now | run-campaign` — DD-19) and a stable `task_id`, so the same logical slot run is
 * idempotent: re-dispatching an already-pending/claimed slot for the same date does not create a
 * second record (it returns the existing one). This is the dispatch-discipline guard against the
 * two failure modes — stranded slots (no run) and unattributed spend (a run with no record).
 *
 * Tier-3 cleanliness (§0.3 r6 / RD-3): no hardcoded IDs/handles/paths (paths.js derives the
 * tasks dir under $CONTENT_HOME), no production persona codenames, no brand strings. Records are
 * redacted at write through the ledger's redact-at-write discipline (§13.3) — we redact the
 * record body via redact.js before serialization.
 *
 * The task-record schema (schemas/artifacts/slot-run-task.schema.json, §7.11) is authored by
 * P1-SCH-QUEUE; this module writes the field set that schema documents and stays defensive about
 * fields it does not own (unknown command fields ride along under `command`).
 */

const fs = require('fs');
const path = require('path');

const paths = require('./../shared/paths');
const { redact } = require('./../shared/redact');
const mode = require('./mode');

const SCHEMA_VERSION = 1;

/** Task-record lifecycle states (§7.11 / §8.4). pending → claimed → done | failed. */
const TASK_STATE = Object.freeze({
  PENDING: 'pending',
  CLAIMED: 'claimed',
  DONE: 'done',
  FAILED: 'failed',
});

/** The named triggers a run can be attributed to (DD-19; §13.1 last-run-per-trigger). */
const TRIGGER = Object.freeze({
  MORNING_KICKOFF: 'morning-kickoff',
  CALENDAR_TICK: 'calendar-tick',
  RUN_SLOT: 'run-slot',
  KICKOFF_NOW: 'kickoff--now',
  RUN_CAMPAIGN: 'run-campaign',
  // Source-pathway triggers (both config-gated, off by default — §8.8 / §3.3):
  TREND_POLL: 'trend-poll',     // a config-gated trend pass fills RESERVED trend slots (DD-16)
  WORK_RECAP: 'work-recap',     // the daily build-in-public option the kickoff fills (per account)
});

const VALID_TRIGGERS = new Set(Object.values(TRIGGER));

/** The §6.1 command families a dispatch can carry (fail-closed: an unknown family is rejected). */
const COMMAND_FAMILY = Object.freeze({
  RUN_SLOT: 'RUN_SLOT',
  RUN_BATCH: 'RUN_BATCH',
  RUN_CAMPAIGN: 'RUN_CAMPAIGN',
  RUN_TREND_MANUAL: 'RUN_TREND_MANUAL',
});

const VALID_FAMILIES = new Set(Object.values(COMMAND_FAMILY));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nowIso() {
  return new Date().toISOString();
}

/** Sanitize an arbitrary id into a filesystem-safe stem (mirrors the ledger's discipline). */
function safeId(id) {
  return String(id || '')
    .trim()
    .replace(/[^A-Za-z0-9_.-]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
}

/** $CONTENT_HOME/ledger/tasks — the pending-task transport dir (RD-18; §8.4). */
function tasksDir(env = process.env) {
  return paths.tasksDir(env);
}

function ensureTasksDir(env = process.env) {
  fs.mkdirSync(tasksDir(env), { recursive: true });
}

/**
 * The stable task id for a logical slot run: `<date>|<slot_id>|<trigger-family>`-shaped so the
 * same slot on the same date dispatched by the same logical trigger is idempotent. The CLI may
 * pass an explicit task_id (e.g. for RUN_TREND_MANUAL); otherwise we derive one.
 */
function deriveTaskId(command, trigger) {
  if (command.task_id) return safeId(command.task_id);
  const date = command.date || nowIso().slice(0, 10);
  const slot = command.slot_id || command.content_id || command.campaign_id || 'adhoc';
  const t = VALID_TRIGGERS.has(trigger) ? trigger : 'dispatch';
  return safeId(`${date}-${slot}-${t}`);
}

function taskPath(taskId, env = process.env) {
  const safe = safeId(taskId);
  if (!safe) throw new Error('slot-run task_id is required');
  return path.join(tasksDir(env), `${safe}.json`);
}

/** Atomic JSON write (redact-at-write, §13.3). tmp + rename so no reader sees a partial record. */
function atomicWriteJson(filePath, value) {
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(redact(value), null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

function readJsonIfExists(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Dispatch preflight (§15.4) — checked BEFORE any record is written
// ---------------------------------------------------------------------------

/**
 * Decide whether dispatch is permitted right now. Fail-closed: the PAUSED sentinel halts ALL new
 * dispatch (the kill switch, §15.4), and an optional spend-cap hook (no-op until P6-SPEND) can
 * additionally halt. Returns { ok, reason, code } — the caller writes NO record when !ok.
 *
 * The spend hook is injectable (opts.spendHook) and defaults to the engine-metered-only stub that
 * always allows; P6-SPEND replaces the default with the ledger-backed cap evaluation.
 */
function dispatchPreflight(opts = {}) {
  const env = opts.env || process.env;
  // CONTENT_HOME must resolve to know where the sentinel lives; an unset home is a setup error,
  // not a silent allow.
  let pausedPath;
  try {
    pausedPath = paths.pausedSentinel(env);
  } catch (e) {
    return { ok: false, reason: e.message, code: 'ECONTENTHOME' };
  }
  if (fs.existsSync(pausedPath)) {
    return {
      ok: false,
      reason: 'PAUSED sentinel present — kill switch engaged (§15.4); no new slot-run task records will be dispatched.',
      code: 'EPAUSED',
    };
  }
  // Spend-cap hook (RD-19/§15.4): cap breach halts dispatch of NEW runs. Default no-op stub.
  const spendHook = typeof opts.spendHook === 'function' ? opts.spendHook : defaultSpendHook;
  const spend = spendHook({ env });
  if (spend && spend.over_cap) {
    return {
      ok: false,
      reason: spend.reason || 'spend cap breached — dispatch halted (§15.4)',
      code: 'EBUDGET',
    };
  }
  return { ok: true };
}

/** Engine-metered-only spend stub: always allows. P6-SPEND swaps in the real evaluation. */
function defaultSpendHook() {
  return { over_cap: false, metered: 'engine-only (partial)' };
}

// ---------------------------------------------------------------------------
// Record construction + write (the `pending` transport, §8.4)
// ---------------------------------------------------------------------------

/**
 * Build a §7.11 slot-run task record (in-memory) from a normalized command + named trigger. The
 * command's mode is resolved through the ONE ladder authority (mode.js) so a dispatched record
 * always carries a valid, fail-closed mode (§8.3). Unknown command fields ride under `command`.
 */
function buildTaskRecord(command, trigger, opts = {}) {
  const resolved = mode.resolveMode({ override: command.mode, config: opts.config, env: opts.env });
  const ts = nowIso();
  const taskId = deriveTaskId(command, trigger);
  return {
    schema_version: SCHEMA_VERSION,
    task_id: taskId,
    state: TASK_STATE.PENDING,
    trigger: VALID_TRIGGERS.has(trigger) ? trigger : 'dispatch',
    created_at: ts,
    updated_at: ts,
    command_family: command.command_family || null,
    content_id: command.content_id || null,
    slot_id: command.slot_id || null,
    brand: command.brand || null,
    platform: command.platform || null,
    format: command.format || null,
    date: command.date || null,
    mode: resolved.mode,
    mode_source: resolved.source,
    campaign_id: command.campaign_id || null,
    dispatcher: opts.dispatcher || 'engine',
    claimed_by: null,
    claimed_at: null,
    completed_at: null,
    error: null,
    // The full normalized command rides along so the host runtime can start the orchestrator seat
    // with the exact intent (pre-seed, theme, notes). Schema'd shape lives in the command schema.
    command: { ...command, mode: resolved.mode, trigger: VALID_TRIGGERS.has(trigger) ? trigger : 'dispatch' },
  };
}

/**
 * Write one pending slot-run task record (the core RD-18 dispatch primitive). Idempotent by
 * task_id: if a record with the same task_id already exists in a NON-terminal state
 * (pending/claimed), the existing record is returned unchanged (no duplicate run). A terminal
 * record (done/failed) with the same id is OVERWRITTEN with a fresh pending record (an explicit
 * re-dispatch of a finished slot is allowed).
 *
 * @param {object} command  a §6.1-shaped command (command_family, slot_id, brand, …)
 * @param {string} trigger  the named trigger (TRIGGER.*) — required for attribution (DD-19)
 * @param {object} [opts]   { env, config, dispatcher, spendHook, force }
 * @returns {{ ok:boolean, code?:string, reason?:string, task?:object, existed?:boolean }}
 */
function dispatchTask(command, trigger, opts = {}) {
  const env = opts.env || process.env;
  if (!command || typeof command !== 'object') {
    return { ok: false, code: 'EBADCOMMAND', reason: 'command object is required' };
  }
  // Fail-closed family validation (§6.1): a record with no/unknown family is unusable downstream.
  if (command.command_family != null && !VALID_FAMILIES.has(command.command_family)) {
    return { ok: false, code: 'EBADFAMILY', reason: `unknown command_family "${command.command_family}"` };
  }

  const pre = dispatchPreflight({ env, config: opts.config, spendHook: opts.spendHook });
  if (!pre.ok) return { ok: false, code: pre.code, reason: pre.reason };

  ensureTasksDir(env);
  const record = buildTaskRecord(command, trigger, { ...opts, env });
  const file = taskPath(record.task_id, env);

  if (!opts.force) {
    const existing = readJsonIfExists(file);
    if (existing && (existing.state === TASK_STATE.PENDING || existing.state === TASK_STATE.CLAIMED)) {
      // Already dispatched and not yet finished — idempotent no-op (no double run).
      return { ok: true, task: existing, existed: true };
    }
  }
  atomicWriteJson(file, record);
  return { ok: true, task: record, existed: false };
}

// ---------------------------------------------------------------------------
// run-slot (§8.4 / §6.1 intake route 1) — validate a calendar slot, then dispatch one record
// ---------------------------------------------------------------------------

/**
 * Dispatch one run for a NAMED calendar slot (the `engine run-slot <slot-id>` verb; quick-start
 * step 7). The slot is validated against the supplied calendar slots (fail-closed §6.1: an
 * unknown slot is rejected — no record written). The matched slot's fields seed the command.
 *
 * @param {string} slotId
 * @param {object} [opts]
 * @param {Array}  [opts.slots]    parsed calendar slots (from the calendar reader); REQUIRED to validate
 * @param {string} [opts.mode]     per-run mode override (resolved through mode.js; default SAFE)
 * @param {string} [opts.date]     ISO date for the run (default today)
 * @param {object} [opts.preSeed]  campaign/theme pre-seed merged into the command (§8.7)
 * @returns {{ ok:boolean, code?:string, reason?:string, task?:object }}
 */
function runSlot(slotId, opts = {}) {
  const env = opts.env || process.env;
  const id = String(slotId || '').trim();
  if (!id) return { ok: false, code: 'EBADSLOT', reason: 'slot id is required' };

  const slots = Array.isArray(opts.slots) ? opts.slots : null;
  if (!slots) {
    return { ok: false, code: 'ENOCALENDAR', reason: 'calendar slots are required to validate a run-slot dispatch (§6.1 fail-closed)' };
  }
  const slot = slots.find((s) => s && String(s.slot_id) === id);
  if (!slot) {
    return { ok: false, code: 'EUNKNOWNSLOT', reason: `slot "${id}" is not in the calendar (§6.1 fail-closed validation)` };
  }

  const date = opts.date || nowIso().slice(0, 10);
  const command = {
    command_family: slot.command_family || COMMAND_FAMILY.RUN_SLOT,
    slot_id: slot.slot_id,
    content_id: `${date}-${slot.slot_id}`,
    brand: slot.brand || null,
    platform: slot.platform || null,
    format: slot.format || null,
    pillar: slot.pillar || null,
    content_type: slot.content_type || null,
    date,
    mode: opts.mode,
    ...(opts.preSeed ? { pre_seed: opts.preSeed } : {}),
  };
  return dispatchTask(command, opts.trigger || TRIGGER.RUN_SLOT, { ...opts, env });
}

// ---------------------------------------------------------------------------
// Consumption surface (the engine side of the RD-18 per-runtime hook)
// ---------------------------------------------------------------------------

/** Read every task record on disk (no order guarantee). Tolerates a torn/partial file. */
function readAllTasks(env = process.env) {
  let names;
  try {
    names = fs.readdirSync(tasksDir(env));
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const rec = readJsonIfExists(path.join(tasksDir(env), name));
    if (rec) out.push(rec);
  }
  return out;
}

/** List pending task records oldest-first (the host hook polls this). */
function listPending(env = process.env) {
  return readAllTasks(env)
    .filter((t) => t.state === TASK_STATE.PENDING)
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
}

/** Peek the oldest pending record without claiming it, or null if none. */
function peekPending(env = process.env) {
  return listPending(env)[0] || null;
}

/** Read one task record by id, or null. */
function getTask(taskId, env = process.env) {
  return readJsonIfExists(taskPath(taskId, env));
}

/**
 * Persist a state transition on a task record (claim / complete / fail). Re-reads fresh, applies
 * the transition, writes atomically. Returns { ok, task } or { ok:false, reason }.
 */
function transitionTask(taskId, toState, patch = {}, env = process.env) {
  const file = taskPath(taskId, env);
  const rec = readJsonIfExists(file);
  if (!rec) return { ok: false, reason: `task not found: ${taskId}` };
  const next = { ...rec, ...patch, state: toState, updated_at: nowIso() };
  atomicWriteJson(file, next);
  return { ok: true, task: next };
}

/**
 * Claim a pending record for a runtime (pending → claimed), recording who claimed it. Refuses to
 * claim a record not in `pending` (so two runtimes cannot both claim the same run). The claim is
 * the host-runtime side of "no task record, no run" — a claimed record IS the run attribution.
 */
function claimTask(taskId, claimedBy, env = process.env) {
  const rec = getTask(taskId, env);
  if (!rec) return { ok: false, reason: `task not found: ${taskId}` };
  if (rec.state !== TASK_STATE.PENDING) {
    return { ok: false, reason: `task ${taskId} is ${rec.state}, not pending (already claimed/finished)` };
  }
  return transitionTask(taskId, TASK_STATE.CLAIMED, {
    claimed_by: claimedBy || 'unknown',
    claimed_at: nowIso(),
  }, env);
}

/** Mark a claimed record done (the run completed). */
function completeTask(taskId, env = process.env) {
  return transitionTask(taskId, TASK_STATE.DONE, { completed_at: nowIso(), error: null }, env);
}

/** Mark a record failed (the run could not start / errored), recording the reason. */
function failTask(taskId, reason, env = process.env) {
  return transitionTask(taskId, TASK_STATE.FAILED, {
    completed_at: nowIso(),
    error: reason ? String(reason).slice(0, 800) : 'unspecified',
  }, env);
}

module.exports = {
  SCHEMA_VERSION,
  TASK_STATE,
  TRIGGER,
  COMMAND_FAMILY,
  VALID_TRIGGERS,
  VALID_FAMILIES,
  // path accessors (computed via paths.js — never constants)
  tasksDir,
  taskPath,
  // preflight
  dispatchPreflight,
  // dispatch API (the CLI surface)
  buildTaskRecord,
  dispatchTask,
  runSlot,
  // consumption surface (the host-runtime hook side)
  readAllTasks,
  listPending,
  peekPending,
  getTask,
  claimTask,
  completeTask,
  failTask,
  transitionTask,
};
