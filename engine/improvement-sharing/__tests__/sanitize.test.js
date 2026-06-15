'use strict';

/**
 * Tests for engine/improvement-sharing/sanitize.js — the DD-7(b) OUTBOUND sanitizer + structural
 * guard (release-spec §2.6 Improvement Sharing; roadmap #4; decisions.md DD-7 option (b)).
 *
 * Zero-key, deterministic, no LLM, no network, no disk (RD-2 / RD-12). All fixture content is
 * SYNTHETIC + brand-neutral ("Acme Cosmos") per §0.3 r6 / §16.1 — no instance data, no production
 * codenames. node:test + node:assert only.
 *
 * Coverage maps to the load-bearing invariants:
 *   - DD-7 (2) ABSTRACT-ONLY: sanitizeForSharing keeps the generalizable shape, drops specifics.
 *   - DD-7 (2) STRUCTURAL GUARD: assertShareable THROWS EUNSHAREABLE on any residual specific
 *     (brand name / secret shape / snowflake / path / handle / configured private term).
 *   - STRIP-OR-REFUSE: strip by default; refuse on residual when configured.
 *   - FAIL-CLOSED: a payload that survives stripping is never returned (sanitizeForSharing
 *     re-asserts its own output).
 *   - NO-AUTO-SEND / PURITY: the module only transforms + asserts; it has no side effects.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const s = require('../sanitize.js');
const { MASK } = require('../../shared/redact.js');

/* ----------------------------------------------------------------------------- synthetic shapes
 * These are SHAPE-only test inputs that trip the detectors WITHOUT tripping the public-tree hygiene
 * scan (scripts/hygiene-scan.js, CI). Per the repo convention (see engine/gate/__tests__/
 * privacy-leak.test.js + tests/*): a token shape uses a non-credential-prefixed high-entropy blob
 * (redact.js detects it; hygiene's sk-/xai-/ghp_ patterns do not), and a snowflake uses the
 * zero-padded placeholder form (matches \b\d{17,20}\b so the sanitizer's detector fires, but
 * hygiene's snowflakeIsPlaceholder() exempts it as a documented placeholder). No real ids/keys. */
const SYNTH_TOKEN = 'abcDEF123456ghiJKL789012mnoPQR345678stuVWX'; // 42-char opaque blob (no sk- prefix).
const SYNTH_SNOWFLAKE = '000000000000000018';                     // 18-digit zero-padded placeholder.
const SYNTH_SNOWFLAKE_B = '000000000000000077';                   // a second placeholder snowflake.
// A user-path-SHAPED string built from fragments so this test file carries no literal matchable path
// substring (keeps it clean under scripts/hygiene-scan.js while still tripping the USER_PATH detector).
const SL = '/';
const SYNTH_WIN_PATH = `C:${'\\'}Users${'\\'}op${'\\'}notes`;     // Windows-user-root shape.
const SYNTH_POSIX_PATH = `${SL}home${SL}op${SL}memory${SL}notes.md`; // POSIX-home-root shape.

/* --------------------------------------------------------------------------- helpers / fixtures */

/** A clean, fully-abstract learning record (the happy path — nothing to strip). */
function cleanRecord() {
  return {
    id: 'lr-clean',
    created_at: '2026-06-15T00:00:00.000Z',
    target_artifact: 'calendar.weights.evergreen',
    target_mutability: 'learnable',
    proposed_diff: '+ weight 0.40',
    machine_change: {
      kind: 'calendar-weighting',
      values: { evergreen: 0.4 },
      baseline_values: { evergreen: 0.25 },
    },
    rationale: 'Evergreen slots outperformed the rolling baseline; increase their relative weighting.',
    source_signals: [{ type: 'analytics', refs: ['reports/weekly.json'], count: 14 }],
    shareability: 'candidate-for-upstream',
  };
}

/* ------------------------------------------------------------------ sanitizeForSharing: abstract */

test('sanitizeForSharing returns an abstract-rule-diff with target/structural_diff/rationale', () => {
  const p = s.sanitizeForSharing(cleanRecord(), {});
  assert.equal(p.kind, 'abstract-rule-diff');
  assert.equal(p.target.kind, 'calendar-weighting');
  assert.equal(p.target.path_shape, 'calendar.weights.evergreen');
  assert.equal(p.structural_diff.knob_deltas[0].field, 'evergreen');
  assert.equal(p.structural_diff.knob_deltas[0].direction, 'increase'); // 0.25 -> 0.4
  assert.match(p.rationale, /Evergreen/);
  assert.equal(p['x-sharing'].stripped, false);
  assert.equal(p['x-sharing'].flag_count, 0);
});

test('abstract knob_deltas carry DIRECTION, never the brand-tuned value', () => {
  const p = s.sanitizeForSharing(cleanRecord(), {});
  const json = JSON.stringify(p);
  // the abstract payload must not contain the brand's tuned numbers 0.4 / 0.25.
  assert.ok(!json.includes('0.4'), 'must not carry the tuned after-value');
  assert.ok(!json.includes('0.25'), 'must not carry the tuned baseline value');
  assert.equal(p.structural_diff.knob_deltas[0].direction, 'increase');
});

test('provenance is abstract: signal KINDS + count only, never the refs', () => {
  const p = s.sanitizeForSharing(cleanRecord(), {});
  assert.deepEqual(p.provenance.signal_kinds, ['analytics']);
  assert.equal(p.provenance.signal_count, 14);
  // refs are $CONTENT_HOME-relative instance paths — they must NOT appear anywhere.
  assert.ok(!JSON.stringify(p).includes('reports/weekly.json'));
});

test('gate-vocabulary transitions (severity/disposition/bars_recommended) are carried verbatim', () => {
  const rec = cleanRecord();
  rec.machine_change = {
    kind: 'config',
    severity: { before: 'soft', after: 'hard' },
    disposition: { before: 'warn', after: 'block' },
    bars_recommended: { before: false, after: true },
  };
  const p = s.sanitizeForSharing(rec, {});
  const axes = p.structural_diff.structural_changes.map((c) => c.axis).sort();
  assert.deepEqual(axes, ['bars_recommended', 'disposition', 'severity']);
  const sev = p.structural_diff.structural_changes.find((c) => c.axis === 'severity');
  assert.deepEqual([sev.before, sev.after], ['soft', 'hard']);
});

/* ------------------------------------------------------------- sanitizeForSharing: strip (default) */

test('a brand name in the rationale is stripped by default (strip mode)', () => {
  const rec = cleanRecord();
  rec.rationale = 'Acme Cosmos saw a lift after this change.';
  const p = s.sanitizeForSharing(rec, { brandTerms: ['Acme Cosmos'] });
  assert.ok(p.rationale.includes(MASK));
  assert.ok(!/Acme Cosmos/i.test(p.rationale));
  assert.ok(p['x-sharing'].families.includes('brand_term'));
});

test('a secret shape in the rationale is stripped', () => {
  const rec = cleanRecord();
  rec.rationale = `Note: pasted token ${SYNTH_TOKEN} by mistake.`;
  const p = s.sanitizeForSharing(rec, {});
  assert.ok(!p.rationale.includes(SYNTH_TOKEN));
  assert.ok(p['x-sharing'].families.includes('secret_shape'));
});

test('a snowflake id and a handle are stripped', () => {
  const rec = cleanRecord();
  rec.rationale = `Posted in channel ${SYNTH_SNOWFLAKE} by @acmebuilder and it worked.`;
  const p = s.sanitizeForSharing(rec, {});
  assert.ok(!p.rationale.includes(SYNTH_SNOWFLAKE));
  assert.ok(!/@acmebuilder/.test(p.rationale));
  assert.ok(p['x-sharing'].families.includes('snowflake-id'));
  assert.ok(p['x-sharing'].families.includes('handle'));
});

test('a configured private term (deny list via config) is stripped', () => {
  const rec = cleanRecord();
  rec.rationale = 'The Stardust Partners launch drove the change.';
  const p = s.sanitizeForSharing(rec, { config: { work_recap: { private_terms: ['Stardust Partners'] } } });
  assert.ok(!/Stardust Partners/i.test(p.rationale));
  assert.ok(p['x-sharing'].families.includes('private_term'));
});

test('a brand-tied performance number is stripped; a relative percentage is kept', () => {
  const rec = cleanRecord();
  rec.rationale = 'We hit 12,000 impressions, a 20% lift over baseline.';
  const p = s.sanitizeForSharing(rec, {});
  assert.ok(!/12,000 impressions/i.test(p.rationale), 'absolute brand metric stripped');
  assert.match(p.rationale, /20% lift/, 'relative effect (generalizable) is kept');
  assert.ok(p['x-sharing'].families.includes('brand-tied-number'));
});

test('an instance leaf in a config path_shape is masked, the knob CLASS namespace kept', () => {
  const rec = cleanRecord();
  rec.target_artifact = `archetype.priority.${SYNTH_SNOWFLAKE}`; // a snowflake leaf
  rec.machine_change = { kind: 'archetype-prioritization', values: { [SYNTH_SNOWFLAKE]: 1 } };
  const p = s.sanitizeForSharing(rec, {});
  assert.ok(p.target.path_shape.startsWith('archetype.priority.'));
  assert.ok(p.target.path_shape.includes(MASK));
  assert.ok(!p.target.path_shape.includes(SYNTH_SNOWFLAKE));
});

/* ------------------------------------------------------------------ sanitizeForSharing: refuse mode */

test("onResidual:'refuse' throws EUNSHAREABLE when the input carried a specific", () => {
  const rec = cleanRecord();
  rec.rationale = 'Acme Cosmos drove this.';
  assert.throws(
    () => s.sanitizeForSharing(rec, { brandTerms: ['Acme Cosmos'], onResidual: 'refuse' }),
    (err) => err.code === 'EUNSHAREABLE' && err.mode === 'refuse' && err.families.includes('brand_term'),
  );
});

test("onResidual:'refuse' still returns a clean payload when there is nothing to strip", () => {
  const p = s.sanitizeForSharing(cleanRecord(), { onResidual: 'refuse' });
  assert.equal(p.kind, 'abstract-rule-diff');
  assert.equal(p['x-sharing'].flag_count, 0);
});

/* ----------------------------------------------------------------------- fail-closed re-assertion */

test('a returned payload always passes the guard (fail-closed self-assertion)', () => {
  const rec = cleanRecord();
  rec.rationale = `Acme Cosmos: 9,000 followers, token ${SYNTH_TOKEN}, @acmehandle, id ${SYNTH_SNOWFLAKE_B}.`;
  const p = s.sanitizeForSharing(rec, { brandTerms: ['Acme Cosmos'] });
  // sanitizeForSharing re-asserts internally; an independent assert must also pass.
  assert.equal(s.assertShareable(p, { brandTerms: ['Acme Cosmos'] }), true);
  // and the payload genuinely carries none of the specifics.
  const json = JSON.stringify(p);
  assert.ok(!/Acme Cosmos/i.test(json));
  assert.ok(!json.includes(SYNTH_TOKEN));
  assert.ok(!/@acmehandle/.test(json));
  assert.ok(!json.includes(SYNTH_SNOWFLAKE_B));
});

/* ----------------------------------------------------------------------------- assertShareable */

test('assertShareable PASSES a clean abstract payload', () => {
  const p = s.sanitizeForSharing(cleanRecord(), {});
  assert.equal(s.assertShareable(p, {}), true);
});

test('assertShareable THROWS EUNSHAREABLE on a brand name', () => {
  assert.throws(
    () => s.assertShareable({ kind: 'abstract-rule-diff', rationale: 'Acme Cosmos here' }, { brandTerms: ['Acme Cosmos'] }),
    (e) => e.code === 'EUNSHAREABLE' && e.families.includes('brand_term'),
  );
});

test('assertShareable THROWS on a secret shape / snowflake / path / handle', () => {
  const cases = [
    { rationale: `token ${SYNTH_TOKEN} leaked`, fam: 'secret_shape' },
    { rationale: `channel ${SYNTH_SNOWFLAKE}`, fam: 'snowflake-id' },
    { rationale: `from ${SYNTH_WIN_PATH}`, fam: 'user-path' },
    { rationale: 'ping @acmebuilder', fam: 'handle' },
  ];
  for (const c of cases) {
    assert.throws(
      () => s.assertShareable({ kind: 'abstract-rule-diff', rationale: c.rationale }, {}),
      (e) => e.code === 'EUNSHAREABLE' && e.families.includes(c.fam),
      `expected ${c.fam} to refuse`,
    );
  }
});

test('assertShareable scans nested arrays/objects AND object keys', () => {
  // a snowflake hidden as an object KEY (e.g. a per-id map) must still be refused.
  const payload = { kind: 'abstract-rule-diff', structural_diff: { knob_deltas: [{ [SYNTH_SNOWFLAKE]: 'x' }] } };
  assert.throws(() => s.assertShareable(payload, {}), (e) => e.code === 'EUNSHAREABLE');
});

test('assertShareable is fail-closed on a non-object payload', () => {
  assert.throws(() => s.assertShareable(null, {}), (e) => e.code === 'EUNSHAREABLE');
  assert.throws(() => s.assertShareable('a string', {}), (e) => e.code === 'EUNSHAREABLE');
  assert.throws(() => s.assertShareable(undefined, {}), (e) => e.code === 'EUNSHAREABLE');
});

test('assertShareable error NEVER echoes the offending value (only family + json-path)', () => {
  const secret = SYNTH_TOKEN;
  let thrown;
  try {
    s.assertShareable({ kind: 'abstract-rule-diff', rationale: `oops ${secret}` }, {});
  } catch (e) {
    thrown = e;
  }
  assert.ok(thrown, 'must throw');
  assert.ok(!thrown.message.includes(secret), 'message must not re-leak the secret');
  assert.ok(!JSON.stringify(thrown.offenders).includes(secret), 'offenders must not re-leak the secret');
  assert.ok(thrown.offenders[0].path.includes('rationale'), 'reports the json-path');
  assert.ok(thrown.offenders[0].families.includes('secret_shape'));
});

/* ---------------------------------------------------------------------------- env brand denylist */

test('config.improvement_sharing.private_terms is stripped + refused (regression: the deny-set must read its OWN block)', () => {
  // The bug: resolveDenySet read work_recap/trends/brand_dna but NOT improvement_sharing, so a term
  // declared in the documented place rode verbatim into a contribution package bound for an upstream PR.
  const cfg = { improvement_sharing: { private_terms: { terms: ['Project Dark Comet'], secret_literals: ['FAKE_TOKEN_do_not_use_0000'] } } };
  const rec = cleanRecord();
  rec.rationale = 'This was the Project Dark Comet change, gated behind FAKE_TOKEN_do_not_use_0000.';
  const p = s.sanitizeForSharing(rec, { config: cfg });
  const text = JSON.stringify(p);
  assert.ok(!/Project Dark Comet/.test(text), 'configured codename stripped from the shared payload');
  assert.ok(!/FAKE_TOKEN_do_not_use_0000/.test(text), 'configured secret_literal stripped from the shared payload');
  // and the guard refuses a residual configured term (not only the structural specifics).
  assert.throws(
    () => s.assertShareable({ kind: 'abstract-rule-diff', rationale: 'mentions Project Dark Comet' }, { config: cfg }),
    (e) => e.code === 'EUNSHAREABLE',
  );
});

test('$ENGINE_BRAND_DENYLIST is honored (a configured brand term is stripped + refused)', () => {
  const rec = cleanRecord();
  rec.rationale = 'Orbit Outfitters drove this change.';
  const env = { ENGINE_BRAND_DENYLIST: 'Orbit Outfitters, Other Codename' };
  const p = s.sanitizeForSharing(rec, { env });
  assert.ok(!/Orbit Outfitters/i.test(p.rationale));
  assert.ok(p['x-sharing'].families.includes('brand_term'));
  // and the guard refuses a payload carrying the env-denylisted term.
  assert.throws(
    () => s.assertShareable({ kind: 'abstract-rule-diff', rationale: 'Orbit Outfitters' }, { env }),
    (e) => e.code === 'EUNSHAREABLE',
  );
});

/* --------------------------------------------------------------------- input guards / determinism */

test('sanitizeForSharing throws on a missing record (fail-closed)', () => {
  assert.throws(() => s.sanitizeForSharing(null, {}), (e) => e.code === 'EUNSHAREABLE');
  assert.throws(() => s.sanitizeForSharing(undefined, {}), (e) => e.code === 'EUNSHAREABLE');
});

test('sanitizeForSharing is deterministic and does not mutate the input record', () => {
  const rec = cleanRecord();
  rec.rationale = 'Acme Cosmos lift.';
  const snapshot = JSON.stringify(rec);
  const a = s.sanitizeForSharing(rec, { brandTerms: ['Acme Cosmos'] });
  const b = s.sanitizeForSharing(rec, { brandTerms: ['Acme Cosmos'] });
  assert.deepEqual(a, b, 'deterministic');
  assert.equal(JSON.stringify(rec), snapshot, 'input record not mutated');
});

test('the neutral fallback rationale is used when none is supplied (no instance content)', () => {
  const rec = cleanRecord();
  delete rec.rationale;
  const p = s.sanitizeForSharing(rec, {});
  assert.match(p.rationale, /Generalizable adjustment/);
  assert.equal(s.assertShareable(p, {}), true);
});

/* ------------------------------------------------------------------------- a realistically dirty record */

test('a heavily-instance-bound record reduces to a clean abstract payload', () => {
  const rec = {
    id: 'lr-dirty',
    target_artifact: 'calendar.weights.builder_recap',
    target_mutability: 'learnable',
    proposed_diff: `context: Acme Cosmos builder recaps, see ${SYNTH_POSIX_PATH}`,
    machine_change: {
      kind: 'calendar-weighting',
      rationale: `Acme Cosmos builder recaps hit 50,000 impressions; @acmebuilder thread led. `
        + `Pulled from ${SYNTH_WIN_PATH}, channel ${SYNTH_SNOWFLAKE_B}, key ${SYNTH_TOKEN}.`,
      values: { builder_recap: 0.5 },
      baseline_values: { builder_recap: 0.3 },
    },
    source_signals: [{ type: 'edit', refs: ['decisions/d-1.json'], count: 6 }, { type: 'analytics', count: 8 }],
    shareability: 'candidate-for-upstream',
  };
  const p = s.sanitizeForSharing(rec, { brandTerms: ['Acme Cosmos'], config: { work_recap: { private_terms: [] } } });

  const json = JSON.stringify(p);
  assert.ok(!/Acme Cosmos/i.test(json));
  assert.ok(!/@acmebuilder/.test(json));
  assert.ok(!json.includes(SYNTH_SNOWFLAKE_B));
  assert.ok(!json.includes(SYNTH_TOKEN));
  assert.ok(!json.includes(SYNTH_WIN_PATH) && !json.includes(SYNTH_POSIX_PATH));
  assert.ok(!/50,000 impressions/i.test(json));
  // but the generalizable shape survives.
  assert.equal(p.target.kind, 'calendar-weighting');
  assert.equal(p.structural_diff.knob_deltas[0].direction, 'increase');
  assert.deepEqual(p.provenance.signal_kinds.sort(), ['analytics', 'edit']);
  assert.equal(p.provenance.signal_count, 14);
  // and it independently passes the guard.
  assert.equal(s.assertShareable(p, { brandTerms: ['Acme Cosmos'] }), true);
});
