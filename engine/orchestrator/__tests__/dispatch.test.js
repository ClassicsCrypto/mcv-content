'use strict';

/**
 * Tests for engine/orchestrator/dispatch.js (release-spec §8.4 run mechanics; RD-18 transport;
 * DD-19 named trigger; §15.4 PAUSED preflight). Zero-key, CONTENT_HOME-injected temp dirs.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dispatch = require('../dispatch');

function tmpEnv() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oce-dispatch-'));
  return { CONTENT_HOME: home };
}

const SLOTS = [
  { slot_id: 'acme-mon-01', brand: 'acme', platform: 'twitter', command_family: 'RUN_SLOT', format: 'text' },
  { slot_id: 'acme-tue-01', brand: 'acme', platform: 'giphy', command_family: 'RUN_SLOT', format: 'gif' },
];

test('dispatchTask writes a pending record under $CONTENT_HOME/ledger/tasks via paths.js', () => {
  const env = tmpEnv();
  const r = dispatch.dispatchTask(
    { command_family: 'RUN_SLOT', slot_id: 'acme-mon-01', brand: 'acme', date: '2026-06-14' },
    dispatch.TRIGGER.RUN_SLOT,
    { env },
  );
  assert.equal(r.ok, true);
  assert.equal(r.task.state, 'pending');
  assert.equal(r.task.trigger, 'run-slot');
  assert.ok(dispatch.tasksDir(env).startsWith(env.CONTENT_HOME));
  assert.ok(fs.existsSync(dispatch.taskPath(r.task.task_id, env)));
});

test('mode is resolved through the ladder (default SAFE) and stamped on the record', () => {
  const env = tmpEnv();
  const r = dispatch.dispatchTask({ command_family: 'RUN_SLOT', slot_id: 's', date: '2026-06-14' }, dispatch.TRIGGER.RUN_SLOT, { env });
  assert.equal(r.task.mode, 'SAFE');
  const r2 = dispatch.dispatchTask({ command_family: 'RUN_SLOT', slot_id: 's2', date: '2026-06-14', mode: 'live' }, dispatch.TRIGGER.RUN_SLOT, { env });
  assert.equal(r2.task.mode, 'LIVE');
});

test('idempotent: re-dispatching a pending (date,slot,trigger) returns the existing record', () => {
  const env = tmpEnv();
  const cmd = { command_family: 'RUN_SLOT', slot_id: 'acme-mon-01', date: '2026-06-14' };
  const a = dispatch.dispatchTask(cmd, dispatch.TRIGGER.RUN_SLOT, { env });
  const b = dispatch.dispatchTask(cmd, dispatch.TRIGGER.RUN_SLOT, { env });
  assert.equal(b.existed, true);
  assert.equal(a.task.task_id, b.task.task_id);
  assert.equal(dispatch.readAllTasks(env).length, 1); // no duplicate run
});

test('fail-closed: unknown command_family is rejected with no record written', () => {
  const env = tmpEnv();
  const r = dispatch.dispatchTask({ command_family: 'RUN_NONSENSE', slot_id: 's' }, dispatch.TRIGGER.RUN_SLOT, { env });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'EBADFAMILY');
  assert.equal(dispatch.readAllTasks(env).length, 0);
});

test('PAUSED sentinel halts dispatch (§15.4) — no task record is written', () => {
  const env = tmpEnv();
  fs.mkdirSync(env.CONTENT_HOME, { recursive: true });
  fs.writeFileSync(path.join(env.CONTENT_HOME, 'PAUSED'), 'kill switch', 'utf8');
  const r = dispatch.dispatchTask({ command_family: 'RUN_SLOT', slot_id: 's' }, dispatch.TRIGGER.RUN_SLOT, { env });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'EPAUSED');
  assert.equal(dispatch.readAllTasks(env).length, 0);
});

test('spend-cap hook halts dispatch when over cap (RD-19/§15.4)', () => {
  const env = tmpEnv();
  const r = dispatch.dispatchTask({ command_family: 'RUN_SLOT', slot_id: 's' }, dispatch.TRIGGER.RUN_SLOT, {
    env,
    spendHook: () => ({ over_cap: true, reason: 'monthly cap breached' }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'EBUDGET');
});

test('runSlot validates the slot against the calendar (fail-closed §6.1)', () => {
  const env = tmpEnv();
  const ok = dispatch.runSlot('acme-mon-01', { env, slots: SLOTS, date: '2026-06-14' });
  assert.equal(ok.ok, true);
  assert.equal(ok.task.content_id, '2026-06-14-acme-mon-01');
  assert.equal(ok.task.platform, 'twitter');

  const bad = dispatch.runSlot('ghost-slot', { env, slots: SLOTS });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'EUNKNOWNSLOT');

  const noCal = dispatch.runSlot('acme-mon-01', { env });
  assert.equal(noCal.ok, false);
  assert.equal(noCal.code, 'ENOCALENDAR');
});

test('consumption surface: list/peek pending, claim, complete, fail', () => {
  const env = tmpEnv();
  const a = dispatch.dispatchTask({ command_family: 'RUN_SLOT', slot_id: 's1', date: '2026-06-14' }, dispatch.TRIGGER.RUN_SLOT, { env });
  dispatch.dispatchTask({ command_family: 'RUN_SLOT', slot_id: 's2', date: '2026-06-14' }, dispatch.TRIGGER.RUN_SLOT, { env });

  assert.equal(dispatch.listPending(env).length, 2);
  const peek = dispatch.peekPending(env);
  assert.equal(peek.state, 'pending');

  const claimed = dispatch.claimTask(a.task.task_id, 'host-runtime', env);
  assert.equal(claimed.ok, true);
  assert.equal(claimed.task.state, 'claimed');
  assert.equal(claimed.task.claimed_by, 'host-runtime');
  // a claimed task is no longer pending
  assert.equal(dispatch.listPending(env).length, 1);
  // double-claim refused
  assert.equal(dispatch.claimTask(a.task.task_id, 'other', env).ok, false);

  assert.equal(dispatch.completeTask(a.task.task_id, env).task.state, 'done');

  const b = dispatch.dispatchTask({ command_family: 'RUN_SLOT', slot_id: 's3', date: '2026-06-14' }, dispatch.TRIGGER.RUN_SLOT, { env });
  const failed = dispatch.failTask(b.task.task_id, 'runtime could not start seat', env);
  assert.equal(failed.task.state, 'failed');
  assert.match(failed.task.error, /could not start/);
});

test('a terminal (done) record may be re-dispatched fresh', () => {
  const env = tmpEnv();
  const cmd = { command_family: 'RUN_SLOT', slot_id: 'redo', date: '2026-06-14' };
  const a = dispatch.dispatchTask(cmd, dispatch.TRIGGER.RUN_SLOT, { env });
  dispatch.completeTask(a.task.task_id, env);
  const b = dispatch.dispatchTask(cmd, dispatch.TRIGGER.RUN_SLOT, { env });
  assert.equal(b.ok, true);
  assert.equal(b.existed, false);
  assert.equal(b.task.state, 'pending');
});
