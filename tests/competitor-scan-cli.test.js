'use strict';

/**
 * tests/competitor-scan-cli.test.js  [N net-new — cli-exit-codes group]
 *
 * Non-vacuous coverage for the exit-code-honesty contract of the two roadmap #5 CLI verbs:
 *
 *   engine/cli/poll-competitors.js  (`engine competitor-scan`)
 *   engine/cli/voice-calibrate.js   (`engine voice-calibrate`)
 *
 * Properties proven here:
 *   BAD-ARGS-2  missing/blank --brand => exit 2, never calls the orchestrator.
 *   BAD-ARGS-2  voice-calibrate --rollback with no resolvable --to-baseline ref => exit 2.
 *   BAD-ARGS-2  voice-calibrate --show --apply (mutually exclusive) => exit 2.
 *   DISABLED-0  competitor-scan with disabled config => exit 0 (system behaving correctly).
 *   HALTED-0    competitor-scan with halted:true result from orchestrator => exit 0.
 *
 * Zero-key: no API calls, no network, no real CONTENT_HOME needed for the arg-validation cases.
 * Synthetic brands only: Acme Cosmos / Orbit Outfitters (real brand names fail hygiene CI).
 *
 * Runner: Node's built-in node:test (zero-dependency, Node >= 22).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const pollCompetitors = require('../engine/cli/poll-competitors.js');
const voiceCalibrate = require('../engine/cli/voice-calibrate.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * A minimal tmpHome with config/system.json seeded.
 * Used only for DISABLED-0 and HALTED-0 tests that need an env.
 */
function tmpHome(csOverride = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oce-cs-cli-'));
  fs.mkdirSync(path.join(home, 'config'), { recursive: true });
  const config = {
    mode: 'SAFE',
    competitor_scan: {
      enabled: false,
      ...csOverride,
    },
  };
  fs.writeFileSync(
    path.join(home, 'config', 'system.json'),
    `${JSON.stringify(config, null, 2)}\n`,
  );
  return home;
}

// ---------------------------------------------------------------------------
// BLOCKER 2 — bad args do not exit 2 (poll-competitors.js)
// ---------------------------------------------------------------------------

describe('poll-competitors — bad-arg exit 2', () => {
  test('missing --brand emits exit 2 without calling the orchestrator', async () => {
    // No CONTENT_HOME set — if the orchestrator were called it would blow up, proving the guard fires first.
    const result = await pollCompetitors.run({
      flags: {},
      env: {},
    });
    assert.strictEqual(result.ok, false, 'ok should be false for bad args');
    assert.strictEqual(result.exitCode, 2, 'exit code must be 2 for missing --brand');
    assert.ok(
      typeof result.summary === 'string' && result.summary.toLowerCase().includes('brand'),
      'summary should mention "brand"',
    );
  });

  test('blank --brand string emits exit 2', async () => {
    const result = await pollCompetitors.run({
      flags: { brand: '   ' },
      env: {},
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.exitCode, 2);
  });
});

// ---------------------------------------------------------------------------
// BLOCKER 2 — bad args do not exit 2 (voice-calibrate.js)
// ---------------------------------------------------------------------------

describe('voice-calibrate — bad-arg exit 2', () => {
  test('missing --brand emits exit 2', async () => {
    const result = await voiceCalibrate.run({
      flags: {},
      env: {},
    });
    assert.strictEqual(result.ok, false, 'ok should be false for bad args');
    assert.strictEqual(result.exitCode, 2, 'exit code must be 2 for missing --brand');
    assert.ok(
      typeof result.summary === 'string' && result.summary.toLowerCase().includes('brand'),
      'summary should mention "brand"',
    );
  });

  test('blank --brand string emits exit 2', async () => {
    const result = await voiceCalibrate.run({
      flags: { brand: '' },
      env: {},
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.exitCode, 2);
  });

  test('--rollback with bare --to-baseline (no string ref) emits exit 2', async () => {
    // Simulates: engine voice-calibrate --brand acme-cosmos --rollback --to-baseline
    // The parser sets flags['to-baseline'] = true (boolean) when no value follows.
    const result = await voiceCalibrate.run({
      flags: { brand: 'acme-cosmos', rollback: true, 'to-baseline': true },
      env: {},
    });
    assert.strictEqual(result.ok, false, 'ok should be false');
    assert.strictEqual(result.exitCode, 2, 'exit code must be 2 for missing ref');
    assert.ok(
      typeof result.summary === 'string' &&
        (result.summary.includes('to-baseline') || result.summary.includes('ref') || result.summary.includes('bad args')),
      `summary should mention the missing ref; got: ${result.summary}`,
    );
  });

  test('--show and --apply together (mutually exclusive) emits exit 2', async () => {
    const result = await voiceCalibrate.run({
      flags: { brand: 'acme-cosmos', show: true, apply: true },
      env: {},
    });
    assert.strictEqual(result.ok, false, 'ok should be false');
    assert.strictEqual(result.exitCode, 2, 'exit code must be 2 for mutually-exclusive flags');
    assert.ok(
      typeof result.summary === 'string' &&
        (result.summary.includes('mutually exclusive') || result.summary.includes('bad args')),
      `summary should mention mutual exclusion; got: ${result.summary}`,
    );
  });
});

// ---------------------------------------------------------------------------
// DISABLED-0 — a disabled-config run exits 0 (system behaving correctly)
// ---------------------------------------------------------------------------

describe('poll-competitors — disabled config exits 0', () => {
  test('competitor-scan with disabled config returns exit 0, not 1', async () => {
    const home = tmpHome({ enabled: false });
    const env = { CONTENT_HOME: home };
    const config = { mode: 'SAFE', competitor_scan: { enabled: false } };

    const result = await pollCompetitors.run({
      flags: { brand: 'acme-cosmos' },
      env,
      config,
    });

    // A disabled scan is the system behaving correctly — must NOT be an error.
    assert.strictEqual(result.ok, true, 'disabled scan should be ok:true');
    // exitCode must be 0 (or absent, which bin/engine.js maps to 0).
    assert.ok(
      result.exitCode === undefined || result.exitCode === 0,
      `exitCode should be 0 or absent; got: ${result.exitCode}`,
    );
    assert.ok(
      typeof result.summary === 'string' && result.summary.toLowerCase().includes('off by default'),
      `summary should say "off by default"; got: ${result.summary}`,
    );
  });
});

// ---------------------------------------------------------------------------
// HALTED-0 — halted/ran:false from the orchestrator exits 0 (kill switch)
// ---------------------------------------------------------------------------

describe('poll-competitors — halted result exits 0', () => {
  test('ran:false halted:true from orchestrator maps to exit 0', async () => {
    // Inject a stub orchestrator result that mimics the PAUSED kill-switch path
    // returning ran:false with halted:true (a future orchestrator may surface this shape).
    // We test the CLI layer by passing a fabricated result via the module's internal path:
    // since we cannot inject the orchestrator result directly, we stub the orchestrator by
    // temporarily replacing the require'd module on ctx.config with a disabled-but-halted
    // shape. In practice, the safest approach is to call run() and verify the CLI's
    // fallback branch for ran:false+halted handles it correctly.
    //
    // We achieve this by monkey-patching the competitor-scan module for one call, then restoring.
    const competitorScanMod = require('../engine/orchestrator/competitor-scan.js');
    const originalRun = competitorScanMod.runCompetitorScan;

    // Stub: returns the halted+ran:false shape the fix must handle.
    competitorScanMod.runCompetitorScan = async () => ({
      ran: false,
      halted: true,
      brand: 'acme-cosmos',
      reason: 'PAUSED sentinel engaged',
      dispatched: 0,
      errors: [],
    });

    try {
      const home = tmpHome({ enabled: true });
      const env = { CONTENT_HOME: home };
      const config = { mode: 'SAFE', competitor_scan: { enabled: true } };

      const result = await pollCompetitors.run({
        flags: { brand: 'acme-cosmos', force: true },
        env,
        config,
      });

      // The PAUSED path is the system behaving correctly — must NOT be exit 1.
      assert.strictEqual(result.ok, true, 'halted scan should be ok:true');
      assert.ok(
        result.exitCode === undefined || result.exitCode === 0,
        `exitCode should be 0 or absent for halted; got: ${result.exitCode}`,
      );
      assert.ok(
        typeof result.summary === 'string' && result.summary.toLowerCase().includes('halted'),
        `summary should mention "halted"; got: ${result.summary}`,
      );
    } finally {
      competitorScanMod.runCompetitorScan = originalRun;
    }
  });
});
