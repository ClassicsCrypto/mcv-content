'use strict';

/**
 * tests/cli-calibrate.test.js  [N — CAL-CLI verb coverage]
 *
 * Coverage for the public calibration runner (engine/cli/calibrate.js; release-spec §2.5 C3 /
 * §16.4 / DD-9). Deterministic + zero-key (RD-12): the estimate/confirm/grade seam is exercised
 * without spending — the generative path is never driven (no pipeline injected, no real samples),
 * and the operator-judged --result path grades against a throwaway $CONTENT_HOME.
 *
 * The bar these tests pin (DD-18 estimate-and-confirm): nothing happens before confirmation;
 * --estimate-only is free; --yes without content/pipeline halts honestly (exit 2, never a false
 * green); a recorded --result is graded by the SAME C3 verifier definition.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const calibrate = require('../engine/cli/calibrate.js');

/** A throwaway $CONTENT_HOME with a minimal system.json (so setCheckpoint can record C3). */
function tmpHome(extra = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oce-cal-'));
  fs.mkdirSync(path.join(home, 'config'), { recursive: true });
  fs.writeFileSync(path.join(home, 'config', 'system.json'), `${JSON.stringify({ mode: 'SAFE', ...extra }, null, 2)}\n`);
  return { CONTENT_HOME: home };
}

test('--help returns the help banner (exit 0)', async () => {
  const res = await calibrate.run({ flags: { help: true } });
  assert.equal(res.ok, true);
  assert.match(res.detail, /engine calibrate/);
});

test('missing --brand is an error (exit 1)', async () => {
  const res = await calibrate.run({ flags: {}, env: tmpHome() });
  assert.equal(res.ok, false);
  assert.equal(res.exitCode, 1);
  assert.match(res.summary, /needs --brand/);
});

test('--estimate-only prints the cost band and spends nothing (exit 0, not confirmed)', async () => {
  const res = await calibrate.run({ flags: { brand: 'acme', 'estimate-only': true }, env: tmpHome() });
  assert.equal(res.ok, true);
  assert.equal(res.data.confirmed, false);
  assert.match(res.summary, /calibration estimate/);
  assert.ok(res.data.estimate.estimated_total_usd.low >= 0);
});

test('a config cost band overrides the default per-sample figure', async () => {
  const env = tmpHome({ cost: { per_sample_usd: { low: 1, high: 2 } } });
  const res = await calibrate.run({ flags: { brand: 'acme', samples: 5, 'estimate-only': true }, env });
  assert.equal(res.data.estimate.estimated_total_usd.low, 5);
  assert.equal(res.data.estimate.estimated_total_usd.high, 10);
});

test('without --yes the run halts awaiting confirmation (DD-18) and spends nothing', async () => {
  const res = await calibrate.run({ flags: { brand: 'acme' }, env: tmpHome() });
  assert.equal(res.ok, false);
  assert.equal(res.exitCode, 0);
  assert.equal(res.data.awaiting_confirmation, true);
  assert.match(res.summary, /requires confirmation/);
});

test('--result with invalid JSON is a usage error (exit 1)', async () => {
  const res = await calibrate.run({ flags: { brand: 'acme', result: '{not json' }, env: tmpHome() });
  assert.equal(res.ok, false);
  assert.equal(res.exitCode, 1);
  assert.match(res.summary, /not valid JSON/);
});

test('a passing operator-judged --result is graded and recorded as C3 PASS', async () => {
  const env = tmpHome();
  const result = JSON.stringify({ sample_count: 10, gate_clear: 10, on_voice: 9, fabrication_codes: 0 });
  const res = await calibrate.run({ flags: { brand: 'acme', result }, env });
  assert.equal(res.ok, true);
  assert.equal(res.exitCode, 0);
  assert.equal(res.data.passed, true);
  assert.match(res.summary, /calibration PASSED/);
});

test('a failing operator-judged --result grades as C3 FAIL (exit 1)', async () => {
  const env = tmpHome();
  const result = JSON.stringify({ sample_count: 10, gate_clear: 1, on_voice: 0, fabrication_codes: 5 });
  const res = await calibrate.run({ flags: { brand: 'acme', result }, env });
  assert.equal(res.ok, false);
  assert.equal(res.exitCode, 1);
  assert.match(res.summary, /calibration FAILED/);
});

test('--yes with calibration content present but no pipeline halts honestly (exit 2)', async () => {
  // The shipped calibration/ content is present in-repo, so this reaches the "no wired pipeline"
  // halt rather than the "content not present" halt — either way it never fakes a pass.
  const res = await calibrate.run({ flags: { brand: 'acme', yes: true }, env: tmpHome() });
  assert.equal(res.ok, false);
  assert.equal(res.exitCode, 2);
  assert.equal(res.data.confirmed, true);
});

test('--yes with an injected pipeline reaches the host-runtime generative notice (exit 2)', async () => {
  const res = await calibrate.run({ flags: { brand: 'acme', yes: true }, env: tmpHome(), pipeline: {} });
  assert.equal(res.ok, false);
  assert.equal(res.exitCode, 2);
  assert.match(res.summary, /host runtime/);
});
