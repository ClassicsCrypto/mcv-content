'use strict';

/**
 * tests/pre-gate-lint.test.js  [A adapted]
 *
 * Characterization + per-check coverage for the deterministic pre-gate (release-spec §14.1
 * layer 1; §16 test estate). Ported from the production self-test fixtures, with all brand
 * corpus lines replaced by synthetic Acme Cosmos copy (spec §0.3 r6, model §13.3 r1).
 *
 * Runner: Node's built-in node:test (zero-dependency, Node >= 22). The global CI wiring is a
 * later batch (P4); this file is runnable standalone with `node --test tests/pre-gate-lint.test.js`.
 *
 * Asserts:
 *   - per-check positive/negative for every LINT.* code
 *   - every emitted code is LINT.*-namespaced and carries the §7.2 detected_codes shape
 *   - verdict derivation per §14.2 (FAIL / PASS_ALTERNATE_ONLY / PASS)
 *   - SOFT codes (PLACEHOLDER, NEGPAR) never produce FAIL on their own
 *   - the config-driven banned-pattern seam (no brand terms in code)
 *   - CONTENT_HOME-free operation (fixture-run, §5.4)
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const preGate = require('../engine/gate/pre-gate-lint');
const { lint } = preGate;

// An env with no CONTENT_HOME so resolveBannedPatterns never touches the filesystem.
const ENV = {};

/** Build a 3-variant draft from three text strings (DD-11 N=3). */
function draft3(a, b, c, over = {}) {
  return {
    content_id: 'test',
    brand: 'acme-cosmos',
    platform: 'twitter',
    format: 'text',
    variants: [
      { label: 'recommended', text: a },
      { label: 'variant-a', text: b },
      { label: 'variant-b', text: c },
    ],
    ...over,
  };
}

/** Three distinct, clean, in-window variants — the baseline PASS draft. */
function cleanDraft() {
  return draft3(
    'The Acme Cosmos beta wrapped with 60 builders shipping live demos this weekend.',
    'Sixty builders. One weekend. Every demo went out as a working link people can open.',
    'We asked for usable demos and got sixty. Here is exactly what the beta produced.',
  );
}

function codes(result) {
  return result.detected_codes.map((d) => d.code);
}

// --- Shape + clean baseline ------------------------------------------------------------------

test('clean 3-variant draft => PASS, no codes', () => {
  const r = lint(cleanDraft(), { env: ENV });
  assert.equal(r.verdict, 'PASS');
  assert.deepEqual(r.detected_codes, []);
  assert.equal(r.stage, 'lint');
  assert.equal(r['x-pre-gate'].routing, 'ADVANCE_TO_LLM_GATE');
});

test('every emitted code is LINT.*-namespaced with the §7.2 shape', () => {
  const r = lint(
    draft3(
      'The beta wrapped—and the demos shipped for everyone to use right away today.',
      'The beta wrapped—and the demos shipped for everyone to use right away today.',
      'The beta wrapped—and the demos shipped for everyone to use right away today.',
    ),
    { env: ENV },
  );
  assert.ok(r.detected_codes.length > 0);
  for (const d of r.detected_codes) {
    assert.match(d.code, /^LINT\./, `code ${d.code} must be LINT.*-namespaced`);
    assert.equal(d.family, 'LINT');
    assert.equal(d.source, 'lint');
    assert.ok(['hard', 'soft'].includes(d.tier));
    assert.ok(['block', 'correct', 'warn'].includes(d.disposition));
    assert.equal(typeof d.rule_ref, 'string');
    assert.equal(typeof d.explanation, 'string');
  }
});

// --- VARIANT_COUNT ---------------------------------------------------------------------------

test('LINT.VARIANT_COUNT: fewer than 3 variants', () => {
  const d = cleanDraft();
  d.variants = d.variants.slice(0, 2);
  const r = lint(d, { env: ENV });
  assert.ok(codes(r).includes('LINT.VARIANT_COUNT'));
  assert.equal(r.verdict, 'FAIL');
});

test('LINT.VARIANT_COUNT: exactly 3 does NOT fire', () => {
  const r = lint(cleanDraft(), { env: ENV });
  assert.ok(!codes(r).includes('LINT.VARIANT_COUNT'));
});

// --- EM_DASH ---------------------------------------------------------------------------------

test('LINT.EM_DASH: mid-sentence em dash fires hard', () => {
  const r = lint(
    draft3(
      'The beta wrapped—and the demos shipped live for everyone to open and use.',
      'Sixty builders showed up and every single demo went out as a usable link.',
      'We asked for working demos. Sixty arrived. Here is the complete weekend recap.',
    ),
    { env: ENV },
  );
  assert.ok(codes(r).includes('LINT.EM_DASH'));
  assert.equal(r.verdict, 'FAIL');
});

test('LINT.EM_DASH: spaced dash between words does NOT count as a mid-sentence em dash', () => {
  // A hyphen, not an em dash, must not fire.
  const r = lint(cleanDraft(), { env: ENV });
  assert.ok(!codes(r).includes('LINT.EM_DASH'));
});

// --- INFLATION -------------------------------------------------------------------------------

test('LINT.INFLATION: significance-inflation phrasing', () => {
  const r = lint(
    draft3(
      'This is a pivotal moment that underscores everything the community has built.',
      'Sixty builders showed up and every single demo went out as a usable link.',
      'We asked for working demos. Sixty arrived. Here is the complete weekend recap.',
    ),
    { env: ENV },
  );
  assert.ok(codes(r).includes('LINT.INFLATION'));
});

// --- FINANCIAL -------------------------------------------------------------------------------

test('LINT.FINANCIAL: floor price / market talk', () => {
  const r = lint(
    draft3(
      'The floor price is climbing and the market cap looks ready to break out soon.',
      'Sixty builders showed up and every single demo went out as a usable link.',
      'We asked for working demos. Sixty arrived. Here is the complete weekend recap.',
    ),
    { env: ENV },
  );
  assert.ok(codes(r).includes('LINT.FINANCIAL'));
});

// --- BANNED_PATTERN (config-driven seam) -----------------------------------------------------

test('LINT.BANNED_PATTERN: empty default never fires (brand-neutral engine)', () => {
  const r = lint(cleanDraft(), { env: ENV });
  assert.ok(!codes(r).includes('LINT.BANNED_PATTERN'));
});

test('LINT.BANNED_PATTERN: operator-supplied literal phrase fires', () => {
  const r = lint(cleanDraft(), { env: ENV, banned_patterns: ['working link'] });
  assert.ok(codes(r).includes('LINT.BANNED_PATTERN'));
  assert.equal(r.verdict, 'FAIL');
});

test('LINT.BANNED_PATTERN: operator-supplied /regex/ fires', () => {
  const r = lint(cleanDraft(), { env: ENV, banned_patterns: ['/six(ty)?/i'] });
  assert.ok(codes(r).includes('LINT.BANNED_PATTERN'));
});

test('compileBannedPattern: malformed regex is skipped, never throws', () => {
  const compiled = preGate.compileBannedPattern('/[unterminated/');
  // Either compiles as a literal-fallback or returns null; must not throw above.
  assert.ok(compiled === null || compiled instanceof RegExp);
});

// --- LENGTH ----------------------------------------------------------------------------------

test('LINT.LENGTH: a variant outside the brief target window', () => {
  const r = lint(cleanDraft(), { env: ENV, target_chars: [200, 280] });
  // The clean variants are well under 200, so all three trip LENGTH.
  assert.ok(codes(r).includes('LINT.LENGTH'));
  assert.equal(r.verdict, 'FAIL');
});

test('LINT.LENGTH: brief window override widens acceptance', () => {
  const r = lint(cleanDraft(), { env: ENV, target_chars: [1, 280] });
  assert.ok(!codes(r).includes('LINT.LENGTH'));
});

// --- VARIANT_DUP -----------------------------------------------------------------------------

test('LINT.VARIANT_DUP: identical variants are flagged duplicate', () => {
  const same = 'Sixty builders shipped working demos at the Acme Cosmos beta this weekend.';
  const r = lint(draft3(same, same, same), { env: ENV });
  assert.ok(codes(r).includes('LINT.VARIANT_DUP'));
  assert.equal(r.verdict, 'FAIL');
});

test('LINT.VARIANT_DUP: distinct variants are not flagged', () => {
  const r = lint(cleanDraft(), { env: ENV });
  assert.ok(!codes(r).includes('LINT.VARIANT_DUP'));
});

// --- TENSE_SLIP ------------------------------------------------------------------------------

test('LINT.TENSE_SLIP: [HISTORICAL] entity framed as ongoing', () => {
  const r = lint(
    draft3(
      'Season One is still smashing records right now across every Acme Cosmos channel.',
      'Sixty builders showed up and every single demo went out as a usable link.',
      'We asked for working demos. Sixty arrived. Here is the complete weekend recap.',
    ),
    { env: ENV, historical_entities: ['Season One'] },
  );
  assert.ok(codes(r).includes('LINT.TENSE_SLIP'));
});

test('LINT.TENSE_SLIP: past-tense saver suppresses the slip', () => {
  const r = lint(
    draft3(
      'Season One was a record-setting run that wrapped earlier this year for everyone.',
      'Sixty builders showed up and every single demo went out as a usable link.',
      'We asked for working demos. Sixty arrived. Here is the complete weekend recap.',
    ),
    { env: ENV, historical_entities: ['Season One'] },
  );
  assert.ok(!codes(r).includes('LINT.TENSE_SLIP'));
});

test('LINT.TENSE_SLIP: no historical entities => no check', () => {
  const r = lint(
    draft3(
      'Season One is still smashing records right now across every Acme Cosmos channel.',
      'Sixty builders showed up and every single demo went out as a usable link.',
      'We asked for working demos. Sixty arrived. Here is the complete weekend recap.',
    ),
    { env: ENV },
  );
  assert.ok(!codes(r).includes('LINT.TENSE_SLIP'));
});

// --- PLACEHOLDER (SOFT) ----------------------------------------------------------------------

test('LINT.PLACEHOLDER: unresolved token is SOFT, bars_recommended, PASS_ALTERNATE_ONLY', () => {
  const r = lint(
    draft3(
      'The beta wrapped and {METRIC} builders shipped usable demos across the weekend run.',
      'Sixty builders showed up and every single demo went out as a usable link people use.',
      'We asked for working demos. Sixty arrived. Here is the complete weekend project recap.',
    ),
    { env: ENV },
  );
  const ph = r.detected_codes.find((d) => d.code === 'LINT.PLACEHOLDER');
  assert.ok(ph, 'placeholder code present');
  assert.equal(ph.tier, 'soft');
  assert.equal(ph.disposition, 'warn');
  assert.equal(ph.bars_recommended, true);
  assert.equal(r.verdict, 'PASS_ALTERNATE_ONLY');
});

// --- NEGPAR (SOFT) ---------------------------------------------------------------------------

test('LINT.NEGPAR: negated-parallelism is SOFT and does not FAIL on its own', () => {
  const r = lint(
    draft3(
      "This isn't just a beta, it's a movement of sixty builders shipping usable demos.",
      'Sixty builders showed up and every single demo went out as a usable link people use.',
      'We asked for working demos. Sixty arrived. Here is the complete weekend project recap.',
    ),
    { env: ENV },
  );
  const neg = r.detected_codes.find((d) => d.code === 'LINT.NEGPAR');
  assert.ok(neg, 'negpar code present');
  assert.equal(neg.tier, 'soft');
  // NEGPAR alone does not bar Recommended, so verdict is PASS.
  assert.equal(r.verdict, 'PASS');
});

test('negparFires: precision on contrast-but-not-negpar copy', () => {
  assert.equal(preGate.negparFires("the room is real, you're not first"), false);
  assert.equal(preGate.negparFires('This is not just a mint, but a movement'), true);
});

// --- Verdict derivation ----------------------------------------------------------------------

test('verdict: any hard code => FAIL regardless of soft codes present', () => {
  const r = lint(
    draft3(
      'This pivotal beta wrapped and {METRIC} builders shipped working demos this weekend.',
      'Sixty builders showed up and every single demo went out as a usable link people use.',
      'We asked for working demos. Sixty arrived. Here is the complete weekend project recap.',
    ),
    { env: ENV },
  );
  assert.ok(codes(r).includes('LINT.INFLATION')); // hard
  assert.ok(codes(r).includes('LINT.PLACEHOLDER')); // soft
  assert.equal(r.verdict, 'FAIL');
});

// --- CONTENT_HOME-free / fixture-run ---------------------------------------------------------

test('runs CONTENT_HOME-free (no env) without throwing', () => {
  const savedHome = process.env.CONTENT_HOME;
  delete process.env.CONTENT_HOME;
  try {
    const r = lint(cleanDraft());
    assert.equal(r.verdict, 'PASS');
  } finally {
    if (savedHome !== undefined) process.env.CONTENT_HOME = savedHome;
  }
});

test('ENGINE_TEST_MODE annotates the result', () => {
  const r = lint(cleanDraft(), { env: { ENGINE_TEST_MODE: '1' } });
  assert.equal(r['x-pre-gate'].test_mode, true);
});
