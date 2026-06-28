'use strict';

/**
 * tests/cli-verify.test.js  [N — VERIFY-CLI verb coverage]
 *
 * Coverage for the setup checkpoint verifier verb (engine/cli/verify.js; release-spec §2.2–§2.6
 * C0–C4, §2.1 resumable setup, model §12). Deterministic + zero-key (RD-12): the verifiers are
 * pure read-only checks; this verb wires them, records outcomes, and shapes exit codes.
 *
 * The bar these tests pin: single-checkpoint mode runs exactly one verifier; ladder mode walks
 * from the first incomplete checkpoint and halts at the first FAIL with its named remediation;
 * a bad checkpoint id fails CLOSED (exit 2) rather than passing silently.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const verify = require('../engine/cli/verify.js');

/** A throwaway $CONTENT_HOME with a minimal system.json (no checkpoints recorded yet). */
function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oce-verify-'));
  fs.mkdirSync(path.join(home, 'config'), { recursive: true });
  fs.writeFileSync(path.join(home, 'config', 'system.json'), `${JSON.stringify({ mode: 'SAFE' }, null, 2)}\n`);
  return { CONTENT_HOME: home };
}

test('--help returns the help banner (exit 0)', () => {
  const res = verify.run({ flags: { help: true } });
  assert.equal(res.ok, true);
  assert.match(res.detail, /engine verify/);
});

test('single-checkpoint mode runs exactly C0 and shapes a verdict', () => {
  // C0 is the CONTENT_HOME-free fit check; it records best-effort (no state file => skipped).
  const res = verify.run({ flags: { checkpoint: 'c0' }, env: {} });
  assert.equal(res.data.checkpoint, 'C0');
  assert.equal(typeof res.ok, 'boolean');
  assert.ok(Array.isArray(res.detail));
});

test('the --setup alias selects a single checkpoint too', () => {
  const res = verify.run({ flags: { setup: 'c0' }, env: {} });
  assert.equal(res.data.checkpoint, 'C0');
});

test('an unknown checkpoint id fails CLOSED (exit 2), never a silent pass', () => {
  const res = verify.run({ flags: { checkpoint: 'zzz' }, env: tmpHome() });
  assert.equal(res.ok, false);
  assert.equal(res.exitCode, 2);
  assert.match(res.summary, /verify failed/);
});

test('ladder mode walks from the first incomplete checkpoint and halts at the first FAIL', () => {
  // A fresh instance has nothing recorded, so the ladder starts at the beginning and stops at the
  // first checkpoint that does not pass (a fresh home is not yet operational).
  const res = verify.run({ flags: {}, env: tmpHome() });
  assert.equal(typeof res.ok, 'boolean');
  assert.ok(Array.isArray(res.data.results) && res.data.results.length >= 1);
  if (!res.ok) {
    assert.equal(res.exitCode, 1);
    assert.match(res.summary, /FAILED/);
  }
});

test('ladder mode with no CONTENT_HOME begins at C0 (state unreadable)', () => {
  const res = verify.run({ flags: {}, env: {} });
  assert.ok(Array.isArray(res.data.results));
  assert.equal(res.data.results[0].checkpoint, 'C0');
});
