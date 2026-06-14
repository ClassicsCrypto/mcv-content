'use strict';

/**
 * tests/fixture-run.test.js  [N net-new — P4-TEST / P4-FIXRUN]
 *
 * The zero-key, deterministic end-to-end fixture run IS the test (release-spec §5.4; §16.5 CI
 * "the zero-key fixture run on every push"; model §13.1 MUST; decisions.md ratification (b) — the
 * Step-9 audit target). It exercises the §5.4 spine on the synthetic Acme Cosmos fixtures with:
 *
 *   - NO live API keys  (the LLM seats replay fixtures/stage-outputs/; nothing calls a provider)
 *   - NO network        (the executor leg hands off to a §12.3 stub adapter)
 *   - NO operator CONTENT_HOME required (the verb is one of the two CONTENT_HOME-free entry points;
 *     all state goes to an OS temp dir the verb creates + removes)
 *
 * These tests drive BOTH layers: the CLI verb (engine fixture-run, the literal audit-target
 * invocation) and the runner module directly (fixtures/run.js) so the stage list + artifacts are
 * inspectable. A failure here is a real engine-port defect, not a flaky fixture — the run is
 * byte-stable across two invocations.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const fixtureRunVerb = require('../engine/cli/fixture-run.js');
const runner = require('../fixtures/run.js');
const cardMod = require('../engine/shared/components-v2.js');

const REPO_ROOT = path.resolve(__dirname, '..');
const FIXTURES_DIR = path.join(REPO_ROOT, 'fixtures');

// Many of these runs register/unregister the stub publisher + may run the executor in-process,
// which installs a per-run process-exit lock-release handler. Lift the listener cap for the test
// process (production runs each invocation as its own process).
process.setMaxListeners(0);

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'oce-fixrun-'));
}

// Snapshot every path under the checkout before a run, so we can assert the run wrote NOTHING into
// the repo tree (the temp-dir / no-CONTENT_HOME contract, §5.4).
function checkoutFileCount() {
  let count = 0;
  const skip = new Set(['.git', 'node_modules']);
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(ent.name)) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else count += 1;
    }
  };
  walk(REPO_ROOT);
  return count;
}

// ---------------------------------------------------------------------------
// The CLI verb — the literal `engine fixture-run` audit target
// ---------------------------------------------------------------------------

test('engine fixture-run PASSES end-to-end with zero keys and no CONTENT_HOME', async () => {
  // The verb creates + removes its own temp home; env carries only PATH (no CONTENT_HOME, no keys).
  const result = await fixtureRunVerb.run({ flags: {}, env: { PATH: process.env.PATH } });
  assert.equal(result.ok, true, `fixture-run should PASS. detail:\n${JSON.stringify(result, null, 2)}`);
  assert.equal(result.exitCode, 0);
  assert.match(result.summary, /PASSED/);
  assert.equal(result.data.result.ok, true);
  // The deterministic spine ran every stage en route to the mock card + executor dry-run.
  assert.deepEqual(result.data.result.stages, [
    'load-recorded-fixtures',
    'seed-content-home',
    'pipeline-awaiting_approval',
    'mock-approval-card',
    'simulated-approval',
    'executor-dry-run-handed_off',
    'idempotent-rerun',
  ]);
});

test('engine fixture-run requires no live env (CONTENT_HOME unset, no API keys present)', async () => {
  // A deliberately minimal env: no CONTENT_HOME, no POSTIZ_/GIPHY_/DISCORD_ keys. It must still pass.
  const result = await fixtureRunVerb.run({ flags: {}, env: {} });
  assert.equal(result.ok, true, `must run CONTENT_HOME-free + key-free. summary: ${result.summary}`);
});

test('engine fixture-run writes NOTHING into the code checkout (temp-dir contract, §5.4)', async () => {
  const before = checkoutFileCount();
  await fixtureRunVerb.run({ flags: {}, env: { PATH: process.env.PATH } });
  const after = checkoutFileCount();
  assert.equal(after, before, 'the fixture run must not write any file into the repo tree');
});

// ---------------------------------------------------------------------------
// The runner module directly — inspectable artifacts + byte-stability
// ---------------------------------------------------------------------------

test('runFixture: mock card validates against the approval-card contract + carries the soft warnings', async () => {
  const home = tempHome();
  try {
    const out = await runner.runFixture({
      env: { CONTENT_HOME: home, WORKFLOW_LEDGER_DISABLE: '1' },
      fixturesDir: FIXTURES_DIR,
    });
    assert.equal(out.ok, true, `runFixture should pass. reason: ${out.reason || ''}`);

    // The mock approval-card artifact was written to the temp dir (no Discord call).
    const cardPath = path.join(home, ...out.card_ref.split('/'));
    assert.ok(fs.existsSync(cardPath), 'mock approval-card artifact exists in the temp dir');
    const card = JSON.parse(fs.readFileSync(cardPath, 'utf8'));

    // It re-validates through buildCard (the structural contract behind approval-card.schema.json):
    // a malformed card throws. content_id + a recommended variant + bounded actions are present.
    const rebuilt = cardMod.buildCard(card);
    assert.equal(rebuilt.content_id, 'acme-fixture-0001');
    assert.ok(rebuilt.variants.some((v) => v.label === 'recommended'), 'recommended slot present');
    assert.ok(rebuilt.actions.length >= 1, 'bounded action set present');

    // The recorded soft codes (the union-of-codes warnings, DD-3) rode onto the card.
    const warnCodes = card.warnings.map((w) => w.code).sort();
    assert.deepEqual(warnCodes, ['FM.STATUS_RECAP', 'FM.UNVERIFIED_CAUSAL']);
    // The verdict the spine computed equals the recorded final verdict (replay fidelity).
    assert.equal(out.gate_verdict, 'PASS_ALTERNATE_ONLY');
    // Exactly one handoff to the stub (idempotency, DR W#35).
    assert.equal(out.handoff_calls, 1);
    assert.equal(out.queue_state, 'handed_off');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('runFixture: byte-stable across two runs (the deterministic-spine guarantee)', async () => {
  const run = async () => {
    const home = tempHome();
    try {
      const out = await runner.runFixture({
        env: { CONTENT_HOME: home, WORKFLOW_LEDGER_DISABLE: '1' },
        fixturesDir: FIXTURES_DIR,
      });
      const card = JSON.parse(fs.readFileSync(path.join(home, ...out.card_ref.split('/')), 'utf8'));
      return { stages: out.stages, gate: out.gate_verdict, warnings: out.soft_warnings, card };
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  };
  const a = await run();
  const b = await run();
  // The card artifact + the stage/verdict/warning summary are identical across runs (no clock-
  // dependent fields land in the card; created_at is intentionally omitted from the mock card).
  assert.deepEqual(a.stages, b.stages);
  assert.equal(a.gate, b.gate);
  assert.deepEqual(a.warnings, b.warnings);
  assert.deepEqual(a.card, b.card, 'the mock approval card is byte-stable across runs');
});

test('runFixture fails loudly (never a fabricated pass) when a recorded fixture is missing', async () => {
  // Point the runner at a fixtures dir whose stage-outputs is empty: it MUST throw EFIXTURE, never
  // report a green run (the fixture run is the Step-9 audit target — a false green is the worst case).
  const emptyFixtures = tempHome();
  fs.mkdirSync(path.join(emptyFixtures, 'stage-outputs'), { recursive: true });
  const home = tempHome();
  try {
    await assert.rejects(
      () => runner.runFixture({ env: { CONTENT_HOME: home }, fixturesDir: emptyFixtures }),
      (err) => err.code === 'EFIXTURE',
      'a missing recorded fixture must fail loudly with EFIXTURE',
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(emptyFixtures, { recursive: true, force: true });
  }
});
