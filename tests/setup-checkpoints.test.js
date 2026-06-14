'use strict';

/**
 * tests/setup-checkpoints.test.js  [N — new tests]
 *
 * Covers engine/setup/checkpoints.js (release-spec §2.2–§2.6 C0–C4 verifiers; §12 setup error
 * row; §15.1 credential fail-fast; DD-21 cold-start). Each verifier returns a structured pass/fail
 * with remediation, never throws for a normal failed check. CONTENT_HOME-free where the spec says
 * so (C0). Deterministic + zero-key (no live API calls — §16.5).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const checkpoints = require('../engine/setup/checkpoints.js');
const init = require('../engine/setup/init.js');
const paths = require('../engine/shared/paths.js');
const setupState = require('../engine/setup/setup-state.js');

/** A scaffolded instance with a baseline-valid system.json, returning its env. */
function freshInstance() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oce-cp-'));
  const { env } = init.initHome({ home, git: false });
  return env;
}

/** Make the starter system.json C1-valid by replacing placeholders. */
function makeC1ValidConfig(env, overrides = {}) {
  const sys = init.starterSystemConfig();
  sys.reviewers = [{ id: 'reviewer-1', name: 'Lead', rights: ['approve', 'edit'] }];
  sys.approval_surface.channels = {
    'content-review': '111',
    'content-published': '222',
    'content-ops': '333',
    'media-bank': '444',
  };
  Object.assign(sys, overrides);
  fs.writeFileSync(paths.systemConfig(env), `${JSON.stringify(sys, null, 2)}\n`, 'utf8');
}

function writeBrand(env, id, brand) {
  fs.mkdirSync(paths.brandDir(id, env), { recursive: true });
  fs.writeFileSync(paths.brandConfig(id, env), `${JSON.stringify(brand, null, 2)}\n`, 'utf8');
}

function findCheck(res, name) {
  return res.checks.find((c) => c.name === name);
}

// --------------------------------------------------------------------------- C0

test('C0 passes on this install and runs without CONTENT_HOME (zero-key)', () => {
  const res = checkpoints.verifyC0({ env: {} });
  assert.equal(res.checkpoint, 'C0');
  assert.equal(res.passed, true);
  assert.equal(findCheck(res, 'node_version').status, 'pass');
  assert.equal(findCheck(res, 'zero_key').status, 'pass');
  assert.equal(res.project_state, setupState.LIFECYCLE.UNINITIALIZED);
});

// --------------------------------------------------------------------------- C1

test('C1 fails (not throws) when CONTENT_HOME is unset', () => {
  const res = checkpoints.verifyC1({ env: {} });
  assert.equal(res.passed, false);
  assert.equal(findCheck(res, 'content_home').status, 'fail');
  assert.match(res.remediation, /engine init/u);
});

test('C1 passes with valid config + token; publisher SKIPPED (not failed) when Postiz deferred', () => {
  const env = freshInstance();
  makeC1ValidConfig(env);
  env.DISCORD_BOT_TOKEN = 'a-token-value'; // process-env resolution (§4.4)

  const res = checkpoints.verifyC1({ env });
  assert.equal(res.passed, true, JSON.stringify(res, null, 2));
  assert.equal(findCheck(res, 'reviewers').status, 'pass');
  assert.equal(findCheck(res, 'budget').status, 'pass');
  assert.equal(findCheck(res, 'channel_bindings').status, 'pass');
  assert.equal(findCheck(res, 'lock_dir_writable').status, 'pass');
  assert.equal(findCheck(res, 'discord_token').status, 'pass');
  // Postiz absent => skip-with-notice, never a fail (§2.3 step 7).
  assert.equal(findCheck(res, 'publisher').status, 'skip');
});

test('C1 fails fast on a missing DISCORD_BOT_TOKEN, naming the variable, never the value (§15.1)', () => {
  const env = freshInstance();
  makeC1ValidConfig(env);
  // no DISCORD_BOT_TOKEN

  const res = checkpoints.verifyC1({ env });
  assert.equal(res.passed, false);
  const tok = findCheck(res, 'discord_token');
  assert.equal(tok.status, 'fail');
  assert.match(tok.detail, /DISCORD_BOT_TOKEN/u);
  assert.match(tok.detail, /does not retry/u); // permanent-until-operator-acts contract
});

test('C1 fails when reviewers have only placeholder ids (no real approver — DD-17)', () => {
  const env = freshInstance(); // starter config ships <REVIEWER_ID> placeholder
  env.DISCORD_BOT_TOKEN = 't';
  // leave the starter config's placeholder reviewers/channels in place
  const res = checkpoints.verifyC1({ env });
  assert.equal(res.passed, false);
  assert.equal(findCheck(res, 'reviewers').status, 'fail');
  assert.equal(findCheck(res, 'channel_bindings').status, 'fail'); // placeholders too
});

test('C1 publisher check fails when Postiz is half-configured (key without url)', () => {
  const env = freshInstance();
  makeC1ValidConfig(env);
  env.DISCORD_BOT_TOKEN = 't';
  env.POSTIZ_API_KEY = 'k'; // no POSTIZ_API_URL
  const res = checkpoints.verifyC1({ env });
  assert.equal(findCheck(res, 'publisher').status, 'fail');
});

test('C1 publisher PASSES when both Postiz creds present', () => {
  const env = freshInstance();
  makeC1ValidConfig(env);
  env.DISCORD_BOT_TOKEN = 't';
  env.POSTIZ_API_KEY = 'k';
  env.POSTIZ_API_URL = 'https://postiz.example';
  const res = checkpoints.verifyC1({ env });
  assert.equal(findCheck(res, 'publisher').status, 'pass');
});

// --------------------------------------------------------------------------- C2

test('C2 fails when no brand is registered', () => {
  const env = freshInstance();
  const res = checkpoints.verifyC2({ env });
  assert.equal(res.passed, false);
  assert.equal(findCheck(res, 'brand_registered').status, 'fail');
});

test('C2 passes a cold-start brand: valid brand.json + DNA + empty archetypes with cold_start=true (DD-21)', () => {
  const env = freshInstance();
  writeBrand(env, 'acme-cosmos', {
    id: 'acme-cosmos',
    display_name: 'Acme Cosmos',
    account_class: 'brand',
    platforms: [{ platform: 'twitter', publisher: 'postiz' }],
    cold_start: true,
  });
  fs.writeFileSync(path.join(paths.brandDir('acme-cosmos', env), 'brand-dna.md'), '# DNA\n', 'utf8');

  const res = checkpoints.verifyC2({ env });
  assert.equal(res.passed, true, JSON.stringify(res, null, 2));
  assert.equal(findCheck(res, 'brand:acme-cosmos:archetypes').status, 'skip'); // cold-start
  assert.equal(findCheck(res, 'corpora_trust_tagged').status, 'skip'); // empty corpus ok
  assert.equal(res.project_state, setupState.LIFECYCLE.INGESTED);
});

test('C2 fails when a brand has no DNA file', () => {
  const env = freshInstance();
  writeBrand(env, 'b', {
    id: 'b', display_name: 'B', account_class: 'brand',
    platforms: [{ platform: 'twitter', publisher: 'postiz' }], cold_start: true,
  });
  const res = checkpoints.verifyC2({ env });
  assert.equal(res.passed, false);
  assert.equal(findCheck(res, 'brand:b:dna').status, 'fail');
});

test('C2 fails when an ingested corpus item lacks a trust_class (RD-8)', () => {
  const env = freshInstance();
  writeBrand(env, 'b', {
    id: 'b', display_name: 'B', account_class: 'brand',
    platforms: [{ platform: 'twitter', publisher: 'postiz' }], cold_start: true,
  });
  fs.writeFileSync(path.join(paths.brandDir('b', env), 'brand-dna.md'), '# DNA\n', 'utf8');
  fs.mkdirSync(paths.brandCorpusDir('b', env), { recursive: true });
  fs.writeFileSync(path.join(paths.brandCorpusDir('b', env), 'item-1.json'), JSON.stringify({ text: 'hi' }), 'utf8');

  const res = checkpoints.verifyC2({ env });
  assert.equal(res.passed, false);
  assert.equal(findCheck(res, 'corpora_trust_tagged').status, 'fail');
  assert.match(res.remediation, /trust_class/u);
});

// --------------------------------------------------------------------------- C3

test('C3 fails when no calibration result is recorded (the calibration gate, §2.5)', () => {
  const env = freshInstance();
  const res = checkpoints.verifyC3({ env });
  assert.equal(res.passed, false);
  assert.match(res.remediation, /engine calibrate/u);
  assert.equal(res.project_state, setupState.LIFECYCLE.INGESTED);
});

test('C3 passes a result meeting the default criteria; advances to calibrated', () => {
  const env = freshInstance();
  const res = checkpoints.verifyC3({
    env,
    calibration: { sample_count: 10, gate_clear: 9, on_voice: 7, fabrication_codes: 0 },
  });
  assert.equal(res.passed, true, JSON.stringify(res, null, 2));
  assert.equal(res.project_state, setupState.LIFECYCLE.CALIBRATED);
});

test('C3 fails on any fabrication-class code, and on sub-threshold gate-clear / on-voice', () => {
  const env = freshInstance();
  const fab = checkpoints.verifyC3({ env, calibration: { sample_count: 10, gate_clear: 9, on_voice: 8, fabrication_codes: 1 } });
  assert.equal(findCheck(fab, 'fabrication').status, 'fail');

  const low = checkpoints.verifyC3({ env, calibration: { sample_count: 10, gate_clear: 5, on_voice: 3, fabrication_codes: 0 } });
  assert.equal(findCheck(low, 'gate_clear').status, 'fail');
  assert.equal(findCheck(low, 'on_voice').status, 'fail');
});

test('C3 reads the recorded calibration detail from setup-state when no explicit result is given', () => {
  const env = freshInstance();
  setupState.setCheckpoint('C3', false, { env, detail: { sample_count: 10, gate_clear: 9, on_voice: 7, fabrication_codes: 0 } });
  const res = checkpoints.verifyC3({ env });
  assert.equal(res.passed, true);
});

// --------------------------------------------------------------------------- C4

test('C4 passes with a calendar slot + empty-library mode; operational only AFTER C3', () => {
  const env = freshInstance();
  // A minimal calendar with a slot table row carrying a clock time.
  fs.writeFileSync(
    path.join(paths.calendarDir(env), 'calendar.md'),
    '| slot_id | day | time |\n|---|---|---|\n| mon-1 | mon | 09:00 |\n',
    'utf8',
  );

  // Without C3 passed, a C4 pass stays calibrated-at-most (non-operational — §2.4 invariant).
  const before = checkpoints.verifyC4({ env });
  assert.equal(findCheck(before, 'calendar').status, 'pass');
  assert.equal(findCheck(before, 'library').status, 'skip'); // empty-library mode (DD-21)
  assert.equal(before.passed, true);
  assert.notEqual(before.project_state, setupState.LIFECYCLE.OPERATIONAL);

  // With C3 recorded, C4 pass implies operational.
  setupState.setCheckpoint('C3', true, { env });
  const after = checkpoints.verifyC4({ env });
  assert.equal(after.project_state, setupState.LIFECYCLE.OPERATIONAL);
});

test('C4 fails when no calendar slot is present', () => {
  const env = freshInstance();
  const res = checkpoints.verifyC4({ env });
  assert.equal(res.passed, false);
  assert.equal(findCheck(res, 'calendar').status, 'fail');
});

test('C4 fails when the library is enabled in config but unindexed', () => {
  const env = freshInstance();
  fs.writeFileSync(
    path.join(paths.calendarDir(env), 'calendar.md'),
    '| slot_id | day | time |\n|---|---|---|\n| mon-1 | mon | 09:00 |\n',
    'utf8',
  );
  makeC1ValidConfig(env, { library: { enabled: true } });
  const res = checkpoints.verifyC4({ env });
  assert.equal(findCheck(res, 'library').status, 'fail');
});

// --------------------------------------------------------------------------- dispatch

test('verifyCheckpoint accepts numeric, "C1", and "c1" forms; throws on unknown', () => {
  assert.equal(checkpoints.verifyCheckpoint(0, { env: {} }).checkpoint, 'C0');
  assert.equal(checkpoints.normalizeCheckpointId('c3'), 'C3');
  assert.equal(checkpoints.normalizeCheckpointId(2), 'C2');
  assert.throws(() => checkpoints.verifyCheckpoint('C9', {}), /Unknown checkpoint/u);
});
