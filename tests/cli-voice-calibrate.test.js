'use strict';

/**
 * tests/cli-voice-calibrate.test.js  [N — VC-CLI verb coverage]
 *
 * Coverage for the consent-gated voice-DNA calibration CLI verb (engine/cli/voice-calibrate.js;
 * roadmap #5). Deterministic + zero-key (RD-12): every route runs against a throwaway $CONTENT_HOME
 * with no proposal on disk, so the sub-action modules (propose/display/apply) take their honest
 * empty-state paths (no pending proposal, not-a-git-repo rollback) without any network or key.
 *
 * The bar these tests pin: arg validation fails CLOSED with exit 2; --apply requires explicit
 * --consent (ECONSENTREQUIRED, exit 1); the show/apply/rollback routes are wired to the
 * voice-calibration modules and surface their honest no-op results.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const voiceCalibrate = require('../engine/cli/voice-calibrate.js');

/** A throwaway $CONTENT_HOME with a minimal system.json (no proposal, not a git repo). */
function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oce-vc-'));
  fs.mkdirSync(path.join(home, 'config'), { recursive: true });
  fs.writeFileSync(path.join(home, 'config', 'system.json'), `${JSON.stringify({ mode: 'SAFE' }, null, 2)}\n`);
  return { CONTENT_HOME: home };
}

test('--help returns the help banner (exit 0)', async () => {
  const res = await voiceCalibrate.run({ flags: { help: true } });
  assert.equal(res.ok, true);
  assert.ok(res.detail.includes('voice-calibrate'));
});

test('missing --brand is a usage error (exit 2)', async () => {
  const res = await voiceCalibrate.run({ flags: {}, env: tmpHome() });
  assert.equal(res.ok, false);
  assert.equal(res.exitCode, 2);
  assert.match(res.summary, /--brand <id> is required/);
});

test('--show and --apply together are mutually exclusive (exit 2)', async () => {
  const res = await voiceCalibrate.run({ flags: { brand: 'acme', show: true, apply: true }, env: tmpHome() });
  assert.equal(res.ok, false);
  assert.equal(res.exitCode, 2);
  assert.match(res.summary, /mutually exclusive/);
});

test('--rollback --to-baseline without a ref is a usage error (exit 2)', async () => {
  const res = await voiceCalibrate.run({ flags: { brand: 'acme', rollback: true, 'to-baseline': true }, env: tmpHome() });
  assert.equal(res.ok, false);
  assert.equal(res.exitCode, 2);
  assert.match(res.summary, /requires a commit ref/);
});

test('--apply without --consent is refused (ECONSENTREQUIRED, exit 1)', async () => {
  const res = await voiceCalibrate.run({ flags: { brand: 'acme', apply: true }, env: tmpHome() });
  assert.equal(res.ok, false);
  assert.equal(res.exitCode, 1);
  assert.match(res.summary, /ECONSENTREQUIRED/);
});

test('default --show surfaces the calibration card route (no pending proposal)', async () => {
  const res = await voiceCalibrate.run({ flags: { brand: 'acme' }, env: tmpHome() });
  assert.equal(res.ok, true);
  assert.match(res.summary, /voice calibration card/);
});

test('explicit --show takes the display route', async () => {
  const res = await voiceCalibrate.run({ flags: { brand: 'acme', show: true }, env: tmpHome() });
  assert.equal(res.ok, true);
  assert.match(res.summary, /voice calibration card/);
});

test('--apply --consent with no pending proposal reports an honest no-op (not a crash)', async () => {
  const res = await voiceCalibrate.run({ flags: { brand: 'acme', apply: true, consent: true }, env: tmpHome() });
  assert.equal(res.ok, false);
  assert.match(res.summary, /No pending voice-calibration proposal/i);
});

test('--rollback refuses on a non-git instance (P8) rather than throwing', async () => {
  const res = await voiceCalibrate.run({ flags: { brand: 'acme', rollback: true }, env: tmpHome() });
  assert.equal(res.ok, false);
  assert.match(res.summary, /not a git repo/i);
});
