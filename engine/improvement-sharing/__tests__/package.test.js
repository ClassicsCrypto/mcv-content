'use strict';

/**
 * Tests for engine/improvement-sharing/package.js — the CONSENT gate + contribution PACKAGER
 * (batch IS-CONSENT; release-spec roadmap #4; decisions.md DD-7 (b); original-design-spec §2.6).
 *
 * Zero-key, deterministic, no LLM, no network (RD-2 / RD-12). The shareability guard (IS-SANITIZE's
 * assertShareable) is INJECTED so the consent/packaging logic + the no-auto-send self-test are
 * exercised without depending on the sibling module being on disk yet. node:test + node:assert only.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const pkg = require('../package');

// A permissive injected guard (the payload is "shareable"): never throws.
const passGuard = () => true;
// A refusing injected guard: throws an ENOTSHAREABLE-shaped error with findings.
const failGuard = () => {
  const e = new Error('payload contains a brand name "Acme Cosmos"');
  e.code = 'ENOTSHAREABLE';
  e.findings = [{ kind: 'brand', term: 'Acme Cosmos' }];
  throw e;
};

const SANITIZED_PAYLOAD = Object.freeze({
  rule_diff: { rule_kind: 'tone', before: 'soft', after: 'soft', note: 'abstract diff' },
  rationale: 'Generalizable: tightening the abstract tone dial improved clean-pass rate.',
  regression_fixture: { case: 'abstract', expect: 'pass' },
});

const RECORD = Object.freeze({
  id: 'lr-0001',
  target_mutability: 'learnable',
  shareability: 'candidate-for-upstream',
  source_signals: [
    { type: 'analytics', refs: ['analytics/report-2026.json'], count: 14 }, // refs MUST be dropped
    { type: 'edit', refs: ['x'], count: 3 },
  ],
});

const NOW = Date.parse('2026-06-15T00:00:00.000Z');

function tmpHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'is-consent-'));
  return { env: { CONTENT_HOME: dir }, dir };
}

/* ------------------------------------------------------------------ DD-7 (1): OFF BY DEFAULT */

test('OFF by default: absent config => disabled no-op, writes nothing', () => {
  const r = pkg.prepareContribution(RECORD, { payload: SANITIZED_PAYLOAD, consent: true, assertShareable: passGuard });
  assert.equal(r.ok, true);
  assert.equal(r.mode, 'disabled');
  assert.equal(r.written, false);
  assert.equal(r.enabled, false);
  assert.equal(r.path, undefined);
});

test('OFF by default: enabled must be STRICT true (no coercion of "true"/1)', () => {
  for (const v of ['true', 1, 'yes', {}, null]) {
    const r = pkg.prepareContribution(RECORD, {
      config: { improvement_sharing: { enabled: v } },
      payload: SANITIZED_PAYLOAD,
      consent: true,
      assertShareable: passGuard,
    });
    assert.equal(r.mode, 'disabled', `enabled=${JSON.stringify(v)} must stay disabled`);
    assert.equal(r.written, false);
  }
  assert.equal(pkg.contributionEnabled({ improvement_sharing: { enabled: true } }), true);
});

/* ------------------------------------------------------------------ DD-7 (3): CONSENT GATE */

test('enabled but NO consent => review-only preview, writes nothing (fail-closed)', () => {
  const { env } = tmpHome();
  const r = pkg.prepareContribution(RECORD, {
    config: { improvement_sharing: { enabled: true } },
    payload: SANITIZED_PAYLOAD,
    env,
    now: NOW,
    assertShareable: passGuard,
    // consent absent
  });
  assert.equal(r.ok, true);
  assert.equal(r.mode, 'review');
  assert.equal(r.written, false);
  assert.equal(r.consented, false);
  // The preview IS the exact package that would be written.
  assert.ok(r.preview && r.preview.schema === 'improvement-contribution');
  assert.deepEqual(r.preview.rule_diff, SANITIZED_PAYLOAD.rule_diff);
});

test('consent must be STRICT true (a truthy non-true value does NOT write)', () => {
  const { env } = tmpHome();
  for (const v of ['yes', 1, {}]) {
    const r = pkg.prepareContribution(RECORD, {
      config: { improvement_sharing: { enabled: true } },
      payload: SANITIZED_PAYLOAD,
      env,
      consent: v,
      assertShareable: passGuard,
    });
    assert.equal(r.mode, 'review', `consent=${JSON.stringify(v)} must not write`);
    assert.equal(r.written, false);
  }
});

/* ------------------------------------------------------------------ DD-7 (2): SHAREABILITY GUARD */

test('payload that fails assertShareable => refused, writes nothing', () => {
  const { env } = tmpHome();
  const r = pkg.prepareContribution(RECORD, {
    config: { improvement_sharing: { enabled: true } },
    payload: SANITIZED_PAYLOAD,
    env,
    consent: true,
    assertShareable: failGuard,
  });
  assert.equal(r.ok, false);
  assert.equal(r.mode, 'refused');
  assert.equal(r.written, false);
  assert.ok(Array.isArray(r.findings));
});

test('real sibling guard: a payload carrying instance specifics is REFUSED end-to-end (no injection)', () => {
  const { env } = tmpHome();
  // No injected guard => uses the real IS-SANITIZE assertShareable. A snowflake-shaped id in the
  // payload must be refused (DD-7 (2)), proving the real outbound guard is wired and fail-closed.
  const dirty = {
    // A SYNTHETIC, zero-padded snowflake-shaped id (17-20 digits) — trips the guard's SNOWFLAKE
    // detector while staying a documented placeholder (never a real id; hygiene-exempt per §0.3 r6).
    rule_diff: { rule_kind: 'tone', note: 'mentions channel 00000000000000001234' },
    rationale: 'should be refused',
  };
  const r = pkg.prepareContribution(RECORD, {
    config: { improvement_sharing: { enabled: true } },
    payload: dirty,
    env,
    consent: true,
  });
  assert.equal(r.ok, false);
  assert.equal(r.mode, 'refused');
  assert.equal(r.written, false);
});

test('fail-closed: when NO guard is resolvable (assertShareable:null) => refuses to emit', () => {
  const { env } = tmpHome();
  // assertShareable === null forces the "no guard available" branch (simulates the sibling missing).
  // A missing guard must NEVER become an open door — it declines rather than writing un-vetted bytes.
  const res = pkg.checkShareable({ rule_diff: {} }, { assertShareable: null });
  assert.equal(res.ok, false);
  assert.match(res.reason, /unavailable|fail-closed/i);

  const r = pkg.prepareContribution(RECORD, {
    config: { improvement_sharing: { enabled: true } },
    payload: SANITIZED_PAYLOAD,
    env,
    consent: true,
    assertShareable: null,
  });
  assert.equal(r.ok, false);
  assert.equal(r.mode, 'refused');
  assert.equal(r.written, false);
});

/* ------------------------------------------------------------------ ENABLED + CONSENTED => WRITE */

test('enabled + consented + shareable => writes a local package file (and nothing else)', () => {
  const { env, dir } = tmpHome();
  const r = pkg.prepareContribution(RECORD, {
    config: { improvement_sharing: { enabled: true } },
    payload: SANITIZED_PAYLOAD,
    env,
    consent: true,
    now: NOW,
    operatorRef: 'maintainer-jdoe',
    assertShareable: passGuard,
  });
  assert.equal(r.ok, true);
  assert.equal(r.mode, 'written');
  assert.equal(r.written, true);
  assert.ok(typeof r.path === 'string' && r.path.length > 0);

  // The file exists, under $CONTENT_HOME/contributions/, and parses to the package.
  assert.ok(fs.existsSync(r.path));
  assert.ok(r.path.includes(path.join(dir, 'contributions')));
  const onDisk = JSON.parse(fs.readFileSync(r.path, 'utf8'));
  assert.equal(onDisk.schema, 'improvement-contribution');
  assert.deepEqual(onDisk.rule_diff, SANITIZED_PAYLOAD.rule_diff);
  assert.equal(onDisk.rationale, SANITIZED_PAYLOAD.rationale);

  // Provenance: operator-reviewed + manual-pr-only + abstract signals (refs DROPPED).
  assert.equal(onDisk.provenance.operator_reviewed, true);
  assert.equal(onDisk.provenance.transport, 'manual-pr-only');
  assert.equal(onDisk.provenance.consent.attested, true);
  assert.equal(onDisk.provenance.consent.operator, 'maintainer-jdoe');
  for (const s of onDisk.provenance.source_signal_types) {
    assert.deepEqual(Object.keys(s).sort(), ['count', 'type']); // NO refs leaked
  }
});

test('written package never contains source-signal refs or the target_artifact id', () => {
  const prov = pkg.buildProvenance(RECORD, { now: NOW });
  const json = JSON.stringify(prov);
  assert.ok(!json.includes('analytics/report-2026.json'), 'instance ref leaked into provenance');
  assert.ok(!json.includes('target_artifact'), 'target_artifact id must not be in provenance');
  assert.equal(prov.source_signal_types.length, 2);
});

/* ------------------------------------------------------------------ DD-7 (1): NO AUTO-SEND PROOF */

test('assertNoAutoSendPath passes on the real module (no transport require exists)', () => {
  const res = pkg.assertNoAutoSendPath();
  assert.equal(res.ok, true);
});

test('assertNoAutoSendPath THROWS when a transport require is present (proves the check bites)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'is-autosend-'));
  const bad = path.join(dir, 'bad-module.js');
  fs.writeFileSync(bad, "const https = require('https');\nmodule.exports = {};\n", 'utf8');
  assert.throws(() => pkg.assertNoAutoSendPath(bad), (err) => err.code === 'EAUTOSEND');

  const badFetch = path.join(dir, 'bad-fetch.js');
  fs.writeFileSync(badFetch, "async function go(){ await fetch('https://x'); }\nmodule.exports={go};\n", 'utf8');
  assert.throws(() => pkg.assertNoAutoSendPath(badFetch), (err) => err.code === 'EAUTOSEND');
});

test('assertNoAutoSendPath does NOT false-positive on the FORBIDDEN list comment/data', () => {
  // The module itself NAMES the forbidden modules (as data); the comment-stripping must not trip it.
  // Covered by the real-module pass test above, but assert the list is the documented set explicitly.
  assert.ok(pkg.FORBIDDEN_TRANSPORT_MODULES.includes('https'));
  assert.ok(pkg.FORBIDDEN_TRANSPORT_MODULES.includes('child_process'));
});

/* ------------------------------------------------------------------ no-payload honest no-op */

test('enabled + consented but NO payload => honest no-op (nothing to prepare)', () => {
  const { env } = tmpHome();
  const r = pkg.prepareContribution(RECORD, {
    config: { improvement_sharing: { enabled: true } },
    env,
    consent: true,
    assertShareable: passGuard,
  });
  assert.equal(r.ok, true);
  assert.equal(r.mode, 'review');
  assert.equal(r.written, false);
});
