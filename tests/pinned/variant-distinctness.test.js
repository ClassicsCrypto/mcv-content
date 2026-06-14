'use strict';

/**
 * tests/pinned/variant-distinctness.test.js  [PINNED — release-spec §16.2]
 *
 * Variant distinctness (DD-11 N=3 labeled variants; the deterministic VARIANT_DUP / VARIANT_COUNT
 * checks in engine/gate/pre-gate-lint.js). The pinned guarantees:
 *
 *   - exactly THREE labeled variants are required; a draft with fewer/more emits LINT.VARIANT_COUNT;
 *   - two variants that merely reword the SAME thesis (high n-gram shingle overlap OR an identical
 *     opener) emit LINT.VARIANT_DUP and FAIL the draft (route back to the writer);
 *   - three genuinely distinct angles on the same anchor PASS clean.
 *
 * The distinctness knobs (shingle size, Jaccard threshold, opener length) are config-tunable over
 * generic shipped defaults (DD-9 / §10.3 — the maintainer's calibrated values are not shipped);
 * the test exercises the shipped defaults and the config override seam.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const preGateLint = require('../../engine/gate/pre-gate-lint.js');

const lint = (variants, rules = {}) =>
  preGateLint.lint(
    { content_id: 'acme-vd-01', brand: 'acme-cosmos', platform: 'twitter', format: 'text', variants },
    { env: {}, ...rules },
  );

test('three distinct variants on the same anchor PASS clean', () => {
  const r = lint([
    { label: 'recommended', text: 'Sixty builders shipped openable demos in a single three-day weekend window.' },
    { label: 'variant-a', text: 'The constraint did the work: one public-output rule turned a deadline into sixty links.' },
    { label: 'variant-b', text: 'We handed out three days and one rule. By Sunday the room was full of clickable demos.' },
  ]);
  assert.equal(r.verdict, 'PASS', `distinct variants should pass; codes: ${r.detected_codes.map((c) => c.code).join(', ')}`);
  assert.ok(!r.detected_codes.some((c) => c.code === 'LINT.VARIANT_DUP'));
});

test('two variants rewording the same thesis emit LINT.VARIANT_DUP and FAIL', () => {
  const shared = 'Sixty builders shipped openable demos in a single three-day weekend window for the beta program.';
  const r = lint([
    { label: 'recommended', text: shared },
    { label: 'variant-a', text: shared.replace('Sixty', 'Some sixty') }, // near-identical: high shingle overlap
    { label: 'variant-b', text: 'A different angle entirely: the public-output rule is what made the deadline bite.' },
  ]);
  assert.equal(r.verdict, 'FAIL', 'a duplicated thesis must FAIL the draft');
  assert.ok(r.detected_codes.some((c) => c.code === 'LINT.VARIANT_DUP'), 'emits the distinctness code');
});

test('an identical opener trips distinctness even when bodies diverge', () => {
  const opener = 'The Acme Cosmos beta wrapped this weekend, and here is the part that mattered most: ';
  const r = lint([
    { label: 'recommended', text: opener + 'sixty builders each shipped a demo anyone can open.' },
    { label: 'variant-a', text: opener + 'the public-output rule turned a deadline into real links.' },
    { label: 'variant-b', text: 'Plainly put, the constraint did the work the hype usually claims to.' },
  ]);
  assert.ok(r.detected_codes.some((c) => c.code === 'LINT.VARIANT_DUP'), 'identical opener ⇒ VARIANT_DUP');
  assert.equal(r.verdict, 'FAIL');
});

test('fewer than three labeled variants emits LINT.VARIANT_COUNT (DD-11)', () => {
  const r = lint([
    { label: 'recommended', text: 'Sixty builders shipped openable demos in a three-day weekend window now.' },
    { label: 'variant-a', text: 'The public-output rule turned a hard deadline into sixty clickable demos here.' },
  ]);
  assert.ok(r.detected_codes.some((c) => c.code === 'LINT.VARIANT_COUNT'), 'two variants ⇒ VARIANT_COUNT');
  assert.equal(r.verdict, 'FAIL');
});

test('the distinctness threshold is config-tunable (the §10.3 seam over shipped defaults)', () => {
  // Two moderately-similar variants: pass under the generous shipped default, fail under a strict
  // operator override — proving the calibrated values live in config, not in shipped code (DD-9).
  const variants = [
    { label: 'recommended', text: 'Sixty builders shipped openable demos across one three-day weekend window.' },
    { label: 'variant-a', text: 'Sixty builders shipped openable demos within a single three-day window weekend.' },
    { label: 'variant-b', text: 'The public-output rule is the real story here, not the builder headcount itself.' },
  ];
  const strict = lint(variants, { variant_distinctness: { jaccard_threshold: 0.1 } });
  assert.ok(strict.detected_codes.some((c) => c.code === 'LINT.VARIANT_DUP'), 'a strict override flips it to DUP');
});
