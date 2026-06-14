'use strict';

/**
 * Tests for engine/orchestrator/run-lock.js (release-spec §8.4 single-runner lock; DD-19
 * skip-and-log → skipped_on_overlap; named-trigger discipline). Zero-key, CONTENT_HOME-injected.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const runLock = require('../run-lock');
const queue = require('../../shared/queue');

function tmpEnv() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oce-runlock-'));
  return { CONTENT_HOME: home };
}

test('claimRunLock acquires + releases the canonical queue lock', () => {
  const env = tmpEnv();
  const claim = runLock.claimRunLock({ trigger: runLock.TRIGGER.MORNING_KICKOFF, env });
  assert.equal(claim.acquired, true);
  assert.equal(claim.trigger, 'morning-kickoff');
  assert.ok(fs.existsSync(claim.lockPath)); // lock file present while held
  assert.equal(claim.release(), true);
  assert.equal(fs.existsSync(claim.lockPath), false); // released
});

test('DD-19: a run with no valid named trigger is refused (not acquired anonymously)', () => {
  const env = tmpEnv();
  const claim = runLock.claimRunLock({ trigger: 'not-a-trigger', env });
  assert.equal(claim.acquired, false);
  assert.match(claim.error, /named trigger/);
});

test('overlap: a second claim while held is skipped_on_overlap', () => {
  const env = tmpEnv();
  const first = runLock.claimRunLock({ trigger: runLock.TRIGGER.MORNING_KICKOFF, env });
  assert.equal(first.acquired, true);
  const second = runLock.claimRunLock({ trigger: runLock.TRIGGER.CALENDAR_TICK, env });
  assert.equal(second.acquired, false);
  assert.equal(second.skipped_on_overlap, true);
  first.release();
});

test('withRunLock records skipped_on_overlap via a stub ledger on overlap', async () => {
  const env = tmpEnv();
  const recorded = [];
  const stubLedger = { runDispatched: (payload) => { recorded.push(payload); return payload; } };

  // Hold the lock manually so the wrapped run sees an overlap.
  const held = runLock.claimRunLock({ trigger: runLock.TRIGGER.MORNING_KICKOFF, env });
  let ranInner = false;
  const out = await runLock.withRunLock(
    { trigger: runLock.TRIGGER.CALENDAR_TICK, env, ledger: stubLedger },
    async () => { ranInner = true; },
  );
  held.release();

  assert.equal(out.ran, false);
  assert.equal(out.skipped_on_overlap, true);
  assert.equal(ranInner, false); // inner body never ran under overlap
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].trigger, 'calendar-tick');
  assert.equal(recorded[0].ok, false);
  assert.match(recorded[0].error, /skipped_on_overlap/);
});

test('withRunLock runs the body and releases when uncontended; concurrent attempt then succeeds', async () => {
  const env = tmpEnv();
  const out = await runLock.withRunLock(
    { trigger: runLock.TRIGGER.MORNING_KICKOFF, env },
    async (claim) => {
      assert.equal(claim.acquired, true);
      assert.ok(fs.existsSync(claim.lockPath));
      return 'done';
    },
  );
  assert.equal(out.ran, true);
  assert.equal(out.result, 'done');
  // Lock released after the body — a fresh claim succeeds.
  const claim = runLock.claimRunLock({ trigger: runLock.TRIGGER.CALENDAR_TICK, env });
  assert.equal(claim.acquired, true);
  claim.release();
});

test('uses the same lock file as the canonical queue lock (mutual exclusion with executor)', () => {
  const env = tmpEnv();
  const claim = runLock.claimRunLock({ trigger: runLock.TRIGGER.MORNING_KICKOFF, env });
  assert.equal(claim.lockPath, queue.queueLockFilePath(env));
  claim.release();
});
