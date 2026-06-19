'use strict';

/**
 * tests/setup-flow.test.js  [N — new tests, SETUP-DRIVER]
 *
 * Covers engine/setup/flow.js (the guided-setup driver brain) + engine/cli/setup.js (its renderer)
 * (release-spec §2.1 resumable setup; §2.8 quick-start; model §12 named-step remediation). The
 * driver turns the C0–C4 checkpoint ladder into a strict, resumable, surface-agnostic FRAME. These
 * tests assert the load-bearing contracts:
 *   - STRICT: the frame is always the FIRST not-yet-passing checkpoint; a later step is never
 *     surfaced as the active step until the earlier one verifies.
 *   - SELF-ADVANCING + RESUMABLE: re-computing after a step is fixed records the pass and moves on.
 *   - CONTENT_HOME-free safe: a fresh clone (no CONTENT_HOME) yields a usable C1 frame, not a throw.
 *   - record:false is a pure read-only preview (no setup-state mutation).
 *   - CONTRACT: every frame the engine can emit validates against the published frame schema
 *     (schemas/artifacts/setup-frame.schema.json) — the contract a host-runtime/Discord adapter pins.
 *
 * Deterministic + zero-key: throwaway temp CONTENT_HOME or CONTENT_HOME-free; no network.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const flow = require('../engine/setup/flow.js');
const setupVerb = require('../engine/cli/setup.js');
const setupState = require('../engine/setup/setup-state.js');
const paths = require('../engine/shared/paths.js');
const engine = require('../bin/engine.js');
const { validate } = require('../scripts/validate-schemas.js');

const FRAME_SCHEMA = require('../schemas/artifacts/setup-frame.schema.json');

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'oce-flow-'));
}

/** Init a temp instance and return { home, env }. */
function initHome() {
  const home = tempHome();
  const env = { CONTENT_HOME: home };
  require('../engine/setup/init.js').initHome({ home, env });
  return { home, env };
}

/** A system.json that satisfies every C1 verifier check (real ids, caps, four bound channels). */
function writeValidC1Config(home) {
  const cfg = {
    schema_version: '1.0.0',
    mode: 'SAFE',
    reviewers: [{ id: '111122223333', name: 'Lead', rights: ['approve', 'edit'] }],
    budget: { monthly_cap: 50, daily_cap: 5, per_item_generation_limit: 1, indexing_requires_estimate: true },
    publish: { draft_only: true, auto_publish_allowed: false },
    approval_surface: { channels: { 'content-review': '100', 'content-published': '200', 'content-ops': '300', 'media-bank': '400' } },
    scheduler: { kickoff_time: '09:00' },
  };
  fs.writeFileSync(path.join(home, 'config', 'system.json'), JSON.stringify(cfg, null, 2));
}

/** Assert a frame validates against the published schema (the adapter contract). */
function assertConformsToSchema(frame) {
  const res = validate(frame, FRAME_SCHEMA);
  assert.ok(res.ok, `frame must validate against setup-frame.schema.json — errors:\n${res.errors.join('\n')}`);
}

// ---------------------------------------------------------------------------
// CONTENT_HOME-free: a fresh clone gets a usable frame, never a throw
// ---------------------------------------------------------------------------

test('no CONTENT_HOME → C1 frame (C0 passes), with the progress-not-saved note; never throws', () => {
  const frame = flow.computeFrame({ env: {}, record: true });
  assert.equal(frame.generated_for, 'C1');
  assert.equal(frame.done, false);
  assert.ok(frame.just_passed.includes('C0'), 'C0 should pass on a healthy clone');
  assert.match(frame.note || '', /CONTENT_HOME is not set/i);
  // The init action is the headline next step.
  assert.ok(frame.actions.some((a) => a.id === 'init' && a.type === 'run'));
  assertConformsToSchema(frame);
});

// ---------------------------------------------------------------------------
// After init: C0 recorded, C1 active with the verifier's real failing checks
// ---------------------------------------------------------------------------

test('after init (starter config has placeholders) → C1 frame; C0 recorded; reviewers+channels are the todo', () => {
  const { home, env } = initHome();
  const frame = flow.computeFrame({ env });
  assert.equal(frame.generated_for, 'C1');
  assert.equal(frame.progress.done, 1, 'C0 counts as done');
  const todoNames = frame.todo.map((t) => t.name);
  assert.ok(todoNames.includes('reviewers'), 'placeholder reviewer is outstanding');
  assert.ok(todoNames.includes('channel_bindings'), 'placeholder channels are outstanding');
  // Every outstanding item carries a named remediation (model §12).
  for (const t of frame.todo) assert.ok(t.remediation, `todo ${t.name} must carry a remediation`);
  // C0's pass was durably recorded (resumability).
  assert.equal(setupState.readSetupState(env).checkpoints.C0.passed, true);
  assertConformsToSchema(frame);
  fs.rmSync(home, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// STRICT: a valid C1 surfaces C2, NEVER a later step
// ---------------------------------------------------------------------------

test('valid C1 config but no brand → the active step is C2, never C3/C4 (strict ladder)', () => {
  const { home, env } = initHome();
  writeValidC1Config(home);
  const frame = flow.computeFrame({ env });
  assert.equal(frame.generated_for, 'C2', 'must stop at the first not-passing checkpoint');
  assert.ok(frame.just_passed.includes('C1'), 'C1 flipped to passing this walk');
  assert.ok(frame.todo.some((t) => t.name === 'brand_registered'));
  // C3/C4 must be locked, not active.
  const byId = Object.fromEntries(frame.progress.checkpoints.map((c) => [c.id, c.status]));
  assert.equal(byId.C2, 'active');
  assert.equal(byId.C3, 'locked');
  assert.equal(byId.C4, 'locked');
  // The C2 frame surfaces the content-source CHOICE (files / apify / cold-start), with a metered option.
  const choice = frame.actions.find((a) => a.type === 'choice');
  assert.ok(choice && choice.options.length >= 3);
  assert.ok(choice.options.some((o) => o.spends === true), 'the Apify auto-fetch option is metered');
  assertConformsToSchema(frame);
  fs.rmSync(home, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// SELF-ADVANCING: re-compute after fixing a step records the pass and moves on
// ---------------------------------------------------------------------------

test('self-advancing: computeFrame records each pass so re-running moves to the next step', () => {
  const { home, env } = initHome();
  // First compute: C0 recorded, stuck at C1.
  assert.equal(flow.computeFrame({ env }).generated_for, 'C1');
  assert.equal(setupState.readSetupState(env).checkpoints.C1.passed, false);
  // Fix C1, recompute: C1 now recorded passed, advanced to C2.
  writeValidC1Config(home);
  const frame = flow.computeFrame({ env });
  assert.equal(frame.generated_for, 'C2');
  assert.equal(setupState.readSetupState(env).checkpoints.C1.passed, true);
  fs.rmSync(home, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// record:false is a pure read-only preview
// ---------------------------------------------------------------------------

test('record:false computes the frame without mutating setup-state', () => {
  const { home, env } = initHome();
  const before = fs.existsSync(paths.setupState(env)) ? fs.readFileSync(paths.setupState(env), 'utf8') : null;
  const frame = flow.computeFrame({ env, record: false });
  assert.equal(frame.generated_for, 'C1');
  const after = fs.existsSync(paths.setupState(env)) ? fs.readFileSync(paths.setupState(env), 'utf8') : null;
  assert.equal(after, before, 'setup-state must be unchanged by a read-only preview');
  fs.rmSync(home, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Terminal done frame
// ---------------------------------------------------------------------------

test('all checkpoints recorded-passed → the terminal done frame (operational)', () => {
  const { home, env } = initHome();
  for (const id of setupState.CHECKPOINTS) setupState.setCheckpoint(id, true, { env });
  const frame = flow.computeFrame({ env });
  assert.equal(frame.done, true);
  assert.equal(frame.generated_for, 'done');
  assert.equal(frame.progress.done, frame.progress.total);
  assert.ok(frame.actions.some((a) => a.id === 'status'));
  assert.ok(frame.actions.some((a) => a.type === 'finish'));
  assertConformsToSchema(frame);
  fs.rmSync(home, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// CLI verb: engine setup
// ---------------------------------------------------------------------------

test('engine setup verb returns ok + exit 0 + the frame as data; help works', () => {
  const { home, env } = initHome();
  const res = setupVerb.run({ flags: {}, positionals: [], env });
  assert.equal(res.ok, true);
  assert.equal(res.exitCode, 0); // mid-setup is informational, not a failure
  assert.equal(res.data.generated_for, 'C1');
  assert.ok(Array.isArray(res.detail) && res.detail.some((l) => /guided setup/i.test(l)));

  const help = setupVerb.run({ flags: { help: true }, env });
  assert.match(help.detail, /guided, strict, resumable/i);
  fs.rmSync(home, { recursive: true, force: true });
});

test('engine setup --no-record does not mutate setup-state through the verb', () => {
  const { home, env } = initHome();
  const before = fs.existsSync(paths.setupState(env)) ? fs.readFileSync(paths.setupState(env), 'utf8') : null;
  setupVerb.run({ flags: { 'no-record': true }, env });
  const after = fs.existsSync(paths.setupState(env)) ? fs.readFileSync(paths.setupState(env), 'utf8') : null;
  assert.equal(after, before);
  fs.rmSync(home, { recursive: true, force: true });
});

test('dispatcher routes `setup` and exits 0', async () => {
  const { home } = initHome();
  const origHome = process.env.CONTENT_HOME;
  process.env.CONTENT_HOME = home;
  const origWrite = process.stdout.write.bind(process.stdout);
  const chunks = [];
  process.stdout.write = (c) => { chunks.push(String(c)); return true; };
  let code;
  try {
    code = await engine.main(['node', 'engine', 'setup']);
  } finally {
    process.stdout.write = origWrite;
    if (origHome === undefined) delete process.env.CONTENT_HOME; else process.env.CONTENT_HOME = origHome;
  }
  assert.equal(code, 0);
  assert.match(chunks.join(''), /guided setup/i);
  fs.rmSync(home, { recursive: true, force: true });
});

test('dispatcher `setup --json` emits a schema-valid frame object', async () => {
  const { home } = initHome();
  const origHome = process.env.CONTENT_HOME;
  process.env.CONTENT_HOME = home;
  const origWrite = process.stdout.write.bind(process.stdout);
  const chunks = [];
  process.stdout.write = (c) => { chunks.push(String(c)); return true; };
  try {
    await engine.main(['node', 'engine', 'setup', '--json']);
  } finally {
    process.stdout.write = origWrite;
    if (origHome === undefined) delete process.env.CONTENT_HOME; else process.env.CONTENT_HOME = origHome;
  }
  const frame = JSON.parse(chunks.join(''));
  assertConformsToSchema(frame);
  assert.equal(frame.generated_for, 'C1');
  fs.rmSync(home, { recursive: true, force: true });
});
