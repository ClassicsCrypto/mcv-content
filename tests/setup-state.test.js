'use strict';

/**
 * tests/setup-state.test.js  [N — new tests]
 *
 * Covers engine/setup/setup-state.js (release-spec §2.1 resumable setup; model §5.2 lifecycle):
 * read/write round-trip, checkpoint recording, the DERIVED lifecycle (a project can never reach
 * operational without C3 — §2.4 invariant), missing/torn-file tolerance, and the resume point.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const setupState = require('../engine/setup/setup-state.js');
const paths = require('../engine/shared/paths.js');

function tempHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oce-setupstate-'));
  return { CONTENT_HOME: dir };
}

test('missing setup-state.json reads as the uninitialized baseline (never throws)', () => {
  const env = tempHome();
  const state = setupState.readSetupState(env);
  assert.equal(state.project_state, setupState.LIFECYCLE.UNINITIALIZED);
  assert.equal(state.paused, false);
  for (const id of setupState.CHECKPOINTS) {
    assert.equal(state.checkpoints[id].passed, false);
  }
});

test('setCheckpoint persists and is read back; write is atomic JSON', () => {
  const env = tempHome();
  setupState.setCheckpoint('C0', true, { env });
  const onDisk = JSON.parse(fs.readFileSync(paths.setupState(env), 'utf8'));
  assert.equal(onDisk.checkpoints.C0.passed, true);
  assert.ok(onDisk.checkpoints.C0.at);
  assert.equal(setupState.readSetupState(env).checkpoints.C0.passed, true);
});

test('lifecycle is DERIVED from checkpoints: C2 => ingested, C3 => calibrated, C4(+C3) => operational', () => {
  const env = tempHome();
  setupState.setCheckpoint('C0', true, { env });
  setupState.setCheckpoint('C1', true, { env });
  assert.equal(setupState.readSetupState(env).project_state, setupState.LIFECYCLE.UNINITIALIZED);

  setupState.setCheckpoint('C2', true, { env });
  assert.equal(setupState.readSetupState(env).project_state, setupState.LIFECYCLE.INGESTED);

  setupState.setCheckpoint('C3', true, { env });
  assert.equal(setupState.readSetupState(env).project_state, setupState.LIFECYCLE.CALIBRATED);

  setupState.setCheckpoint('C4', true, { env });
  assert.equal(setupState.readSetupState(env).project_state, setupState.LIFECYCLE.OPERATIONAL);
});

test('a project can NEVER reach operational without C3 (the §2.4 calibration invariant)', () => {
  const env = tempHome();
  // C4 passed but C3 skipped — must NOT be operational.
  setupState.setCheckpoint('C0', true, { env });
  setupState.setCheckpoint('C1', true, { env });
  setupState.setCheckpoint('C2', true, { env });
  setupState.setCheckpoint('C4', true, { env });
  const state = setupState.readSetupState(env);
  assert.notEqual(state.project_state, setupState.LIFECYCLE.OPERATIONAL);
  assert.equal(state.project_state, setupState.LIFECYCLE.INGESTED);
});

test('a hand-edited file claiming operational without C3 is corrected on read (derivation wins)', () => {
  const env = tempHome();
  fs.writeFileSync(
    paths.setupState(env),
    JSON.stringify({
      project_state: 'operational', // a lie
      checkpoints: { C0: { passed: true }, C4: { passed: true } },
    }),
    'utf8',
  );
  const state = setupState.readSetupState(env);
  assert.notEqual(state.project_state, setupState.LIFECYCLE.OPERATIONAL);
});

test('torn / non-JSON file reads as baseline, not a throw', () => {
  const env = tempHome();
  fs.writeFileSync(paths.setupState(env), '{ this is not json', 'utf8');
  const state = setupState.readSetupState(env);
  assert.equal(state.project_state, setupState.LIFECYCLE.UNINITIALIZED);
});

test('firstIncompleteCheckpoint is the resume point; null when the ladder is complete', () => {
  const env = tempHome();
  assert.equal(setupState.firstIncompleteCheckpoint(env), 'C0');
  setupState.setCheckpoint('C0', true, { env });
  setupState.setCheckpoint('C1', true, { env });
  assert.equal(setupState.firstIncompleteCheckpoint(env), 'C2');
  for (const id of setupState.CHECKPOINTS) setupState.setCheckpoint(id, true, { env });
  assert.equal(setupState.firstIncompleteCheckpoint(env), null);
});

test('setCheckpoint rejects an unknown checkpoint id', () => {
  const env = tempHome();
  assert.throws(() => setupState.setCheckpoint('C9', true, { env }), /Unknown checkpoint/);
});

test('setCheckpoint stores a small structured detail (e.g. calibration scores)', () => {
  const env = tempHome();
  setupState.setCheckpoint('C3', true, { env, detail: { sample_count: 10, gate_clear: 9, on_voice: 7, fabrication_codes: 0 } });
  const cp = setupState.readSetupState(env).checkpoints.C3;
  assert.equal(cp.detail.gate_clear, 9);
});
