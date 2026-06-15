'use strict';

/**
 * Tests for engine/improvement-sharing/evaluate.js — the maintainer-side evaluation harness
 * (DD-7(b); design-review risk #7; release-spec roadmap #4; original-design-spec §2.6).
 *
 * Zero-key, deterministic, no LLM, no network (RD-2 / RD-12). node:test + node:assert only.
 *
 * The four checks are exercised in isolation with the gate-regression test seams
 * (opts.gateRegression injects a runner result; opts.skipGateRegression skips it) so the unit tests
 * never depend on the full suite — except ONE test that runs the REAL runner once to prove the
 * wiring is live + zero-key (the runner is itself deterministic + side-effect-free).
 *
 * Tier-3 cleanliness (§0.3 r6): the only example brand is the synthetic "Acme Cosmos".
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const ev = require('../evaluate');

/* ----------------------------------------------------------------- a well-formed clean contribution */

// A machine-allowed target (an explicitly bounded tunable dial — see mutability.js registry) with a
// clean before/after content-preference change carrying NO gate axis. This is the canonical ACCEPT.
function cleanContribution(overrides = {}) {
  return {
    kind: 'rule-diff',
    target: { kind: 'tunable-dial', machine_tunable: true, bounds: { min: 0, max: 1 } },
    change: { field: 'emphasis_weight', before: 0.4, after: 0.5 },
    rationale: 'Lanes with a stronger opener emphasis tested better; nudge the emphasis dial within bounds.',
    ...overrides,
  };
}

/* ----------------------------------------------------------------------------- happy path: ACCEPT */

test('a clean, well-formed, non-loosening machine-target contribution is ACCEPTED (gate-regression seam green)', () => {
  const v = ev.evaluateContribution(cleanContribution(), { gateRegression: { ok: true } });
  assert.equal(v.accepted, true, v.reasons.join(' | '));
  assert.equal(v.auto_merge, false); // structural: never an auto-merge.
  assert.deepEqual(v.reasons, []);
  assert.equal(v.checks.shareable.ok, true);
  assert.equal(v.checks.applies.ok, true);
  assert.equal(v.checks.gate_regression.ok, true);
  assert.equal(v.checks.mutability.ok, true);
});

test('the verdict is NEVER an auto-merge — auto_merge is structurally false even when accepted', () => {
  const v = ev.evaluateContribution(cleanContribution(), { skipGateRegression: true });
  assert.equal(v.auto_merge, false);
});

/* --------------------------------------------------------------- (a) shape + no instance specifics */

test('a contribution that is not a rule-diff is rejected on shape', () => {
  const v = ev.evaluateContribution({ kind: 'patch', target: {}, change: {} }, { skipGateRegression: true });
  assert.equal(v.accepted, false);
  assert.ok(v.checks.shareable.reasons.some((r) => /rule-diff/.test(r)));
});

test('a non-object contribution is rejected', () => {
  for (const bad of [null, undefined, 42, 'x', []]) {
    const v = ev.evaluateContribution(bad, { skipGateRegression: true });
    assert.equal(v.accepted, false);
  }
});

test('a contribution smuggling a secret shape is rejected as un-shareable (no specific echoed back)', () => {
  const c = cleanContribution({
    rationale: 'Reintroduced the deploy token abcDEF123456ghiJKL789012mnoPQR345678stuVWX into the rule note',
  });
  const v = ev.evaluateContribution(c, { gateRegression: { ok: true } });
  assert.equal(v.accepted, false);
  assert.ok(v.checks.shareable.reasons.some((r) => /instance\/brand specifics/.test(r)));
  // The verdict must NOT echo the matched secret back (privacy: no re-leak).
  assert.ok(!JSON.stringify(v.reasons).includes('abcDEF123456'));
});

test('a contribution smuggling a Discord snowflake is rejected', () => {
  // A zero-padded placeholder snowflake: matches the 17-20-digit detector but is a documented
  // hygiene placeholder (scripts/hygiene-scan.js snowflakeIsPlaceholder), so this test file stays clean.
  const c = cleanContribution({ rationale: 'Saw this in channel 000000000000000001 a lot.' });
  const v = ev.evaluateContribution(c, { gateRegression: { ok: true } });
  assert.equal(v.accepted, false);
  assert.ok(v.checks.shareable.reasons.length > 0);
});

test('a contribution smuggling an absolute path is rejected', () => {
  // The path is synthetic (Acme operator) and assembled at runtime from segments so this source file
  // carries no literal operator-home path (it stays clean under scripts/hygiene-scan.js — $CONTENT_HOME
  // is the documented placeholder); the detector still fires on the assembled path string.
  const homePath = ['', 'Users', 'acme-operator', 'rules', 'foo.md'].join('/');
  const c = cleanContribution({ diff: `updated ${homePath}` });
  const v = ev.evaluateContribution(c, { gateRegression: { ok: true } });
  assert.equal(v.accepted, false);
  assert.ok(v.checks.shareable.reasons.length > 0);
});

test('a contribution smuggling a configured private term is rejected', () => {
  const c = cleanContribution({ rationale: 'This pattern worked great for Stardust Partners.' });
  const v = ev.evaluateContribution(c, { gateRegression: { ok: true }, privateTerms: ['Stardust Partners'] });
  assert.equal(v.accepted, false);
  assert.ok(v.checks.shareable.reasons.length > 0);
});

test('a contribution smuggling a brand name is rejected via brandTerms', () => {
  const c = cleanContribution({ rationale: 'Tuned specifically for the Orbit Outfitters launch.' });
  const v = ev.evaluateContribution(c, { gateRegression: { ok: true }, brandTerms: ['Orbit Outfitters'] });
  assert.equal(v.accepted, false);
});

test('the fallback shareability guard (payload contract) accepts clean abstract objects and throws on a specific', () => {
  assert.equal(ev.fallbackAssertShareable({ rationale: 'Nudge the opener emphasis dial within bounds.' }, {}), true);
  assert.throws(
    () => ev.fallbackAssertShareable({ rationale: 'partner is Stardust Partners' }, { privateTerms: ['Stardust Partners'] }),
    (e) => e.code === 'EUNSHAREABLE',
  );
  // fail-closed on a non-object payload.
  assert.throws(() => ev.fallbackAssertShareable(null, {}), (e) => e.code === 'EUNSHAREABLE');
});

test('collectStrings reaches deeply nested string fields so no field escapes the scan', () => {
  const strs = ev.collectStrings({ a: 'x', b: { c: ['y', { d: 'z' }] }, n: 5 });
  assert.deepEqual(strs.sort(), ['x', 'y', 'z']);
});

/* --------------------------------------------------------------------------- (b) applies cleanly */

test('a no-op diff (before === after) does not apply', () => {
  const c = cleanContribution({ change: { field: 'emphasis_weight', before: 0.5, after: 0.5 } });
  const v = ev.evaluateContribution(c, { skipGateRegression: true });
  assert.equal(v.checks.applies.ok, false);
  assert.equal(v.accepted, false);
});

test('a half-transition (before present, after missing) does not apply', () => {
  const c = cleanContribution({ change: { field: 'emphasis_weight', before: 0.5 } });
  const v = ev.evaluateContribution(c, { skipGateRegression: true });
  assert.equal(v.checks.applies.ok, false);
});

test('an op/values change with a non-empty values map applies', () => {
  const c = cleanContribution({
    target: { kind: 'calendar-weighting' },
    change: { op: 'increase_weight', values: { 'theme-explainer': 0.6 } },
  });
  const v = ev.evaluateContribution(c, { gateRegression: { ok: true } });
  assert.equal(v.checks.applies.ok, true);
  assert.equal(v.accepted, true, v.reasons.join(' | '));
});

test('an empty values map does not apply', () => {
  const c = cleanContribution({ target: { kind: 'calendar-weighting' }, change: { op: 'increase_weight', values: {} } });
  const v = ev.evaluateContribution(c, { skipGateRegression: true });
  assert.equal(v.checks.applies.ok, false);
});

test('a missing change is rejected on apply', () => {
  const c = { kind: 'rule-diff', target: { kind: 'calendar-weighting' } };
  const v = ev.evaluateContribution(c, { skipGateRegression: true });
  assert.equal(v.checks.applies.ok, false);
});

/* ------------------------------------------------------------------- (d) never-loosen + human-only */

test('a contribution targeting a human-only artifact is rejected (EHUMANONLY)', () => {
  const c = cleanContribution({ target: { kind: 'gate' } });
  const v = ev.evaluateContribution(c, { gateRegression: { ok: true } });
  assert.equal(v.accepted, false);
  assert.ok(v.checks.mutability.reasons.some((r) => /human-only/.test(r)));
});

test('a contribution targeting a guardrail/safety rule is rejected', () => {
  const c = cleanContribution({
    target: { kind: 'rule', rule_frontmatter: { id: 'rule.safety.x', category: 'safety', mutability: 'human-only' } },
  });
  const v = ev.evaluateContribution(c, { gateRegression: { ok: true } });
  assert.equal(v.accepted, false);
  assert.ok(v.checks.mutability.reasons.length > 0);
});

test('a contribution that loosens a gate disposition is rejected (ENEVERLOOSEN)', () => {
  // Even on a machine-allowed target, a disposition weakening (block→warn) must be refused.
  const c = cleanContribution({
    change: { disposition: { before: 'block', after: 'warn' } },
  });
  const v = ev.evaluateContribution(c, { gateRegression: { ok: true } });
  assert.equal(v.accepted, false);
  assert.ok(v.checks.mutability.reasons.some((r) => /loosen/.test(r)));
});

test('a contribution that weakens severity hard→soft is rejected', () => {
  const c = cleanContribution({ change: { severity: { before: 'hard', after: 'soft' } } });
  const v = ev.evaluateContribution(c, { gateRegression: { ok: true } });
  assert.equal(v.accepted, false);
});

test('a contribution that widens human-set bounds is rejected', () => {
  const c = cleanContribution({ change: { bounds: { before: { min: 0, max: 1 }, after: { min: -1, max: 2 } } } });
  const v = ev.evaluateContribution(c, { gateRegression: { ok: true } });
  assert.equal(v.accepted, false);
});

/* ------------------------------------------------------------------------- (c) gate-regression seam */

test('an injected red gate-regression result rejects the contribution', () => {
  const v = ev.evaluateContribution(cleanContribution(), { gateRegression: { ok: false, failures: ['x :: y [CODES]: ...'] } });
  assert.equal(v.accepted, false);
  assert.ok(v.checks.gate_regression.ok === false);
  assert.ok(v.checks.gate_regression.skipped === false);
});

test('skipGateRegression is recorded on the verdict (never a silent skip)', () => {
  const v = ev.evaluateContribution(cleanContribution(), { skipGateRegression: true });
  assert.equal(v.checks.gate_regression.skipped, true);
});

test('the REAL gate-regression runner runs zero-key and is wired live (deterministic, side-effect-free)', () => {
  // No seam: this exercises the actual scripts/gate-regression.js over fixtures/gate-regression.
  // It must run with no credentials and pass (the shipped corpus is green), proving the wiring.
  const v = ev.evaluateContribution(cleanContribution(), {});
  assert.equal(v.checks.gate_regression.skipped, false);
  assert.equal(v.checks.gate_regression.ok, true, v.checks.gate_regression.reasons.join(' | '));
  assert.equal(v.accepted, true, v.reasons.join(' | '));
});

/* ------------------------------------------------------------------------- multi-failure reporting */

test('the verdict reports EVERY failing check, not just the first', () => {
  // Human-only target + a loosening change + a smuggled specific, all at once.
  const c = {
    kind: 'patch', // wrong kind (shape)
    target: { kind: 'gate' }, // human-only (mutability)
    change: { disposition: { before: 'block', after: 'warn' } }, // loosening (mutability)
    rationale: 'tuned for Stardust Partners', // specific (shareable)
  };
  const v = ev.evaluateContribution(c, { gateRegression: { ok: false, failures: ['z'] }, privateTerms: ['Stardust Partners'] });
  assert.equal(v.accepted, false);
  assert.equal(v.checks.shareable.ok, false);
  assert.equal(v.checks.gate_regression.ok, false);
  assert.equal(v.checks.mutability.ok, false);
  // Reasons are prefixed by check so a maintainer can triage all of them.
  assert.ok(v.reasons.some((r) => r.startsWith('[shape/shareable]')));
  assert.ok(v.reasons.some((r) => r.startsWith('[gate-regression]')));
  assert.ok(v.reasons.some((r) => r.startsWith('[mutability]')));
});
