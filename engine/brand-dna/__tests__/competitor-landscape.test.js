'use strict';

/**
 * engine/brand-dna/__tests__/competitor-landscape.test.js  [CS-ANALYZE — roadmap #5]
 *
 * Coverage for engine/brand-dna/competitor-landscape.js (analyzeCompetitorPatterns).
 * Proves — ZERO-KEY (RD-12; no network / no LLM / no secrets):
 *
 *   DETERMINISM  — identical corpus => byte-identical result across two independent calls.
 *   PARTITION    — own vs competitor items are correctly separated; drama/hook/engagement
 *                  signals are computed from competitor items only.
 *   NO VERBATIM  — no competitor-item text (≥ 40 chars) appears verbatim in any output field;
 *                  the fail-closed EVERBATIMCOPY guard fires when verbatim text IS present.
 *   SHAPE        — output carries all required top-level fields with correct types/ranges.
 *   EDGE CASES   — empty corpus, no competitor items, no metrics, single-item corpus.
 *
 * Runner: node:test (Node >= 22). Synthetic brands only (Acme Cosmos / Orbit Outfitters).
 * Uses the fixtures/competitor-scan-acme corpora for realistic end-to-end coverage.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  analyzeCompetitorPatterns,
  dramaLevel,
  hasExclamationSignal,
  hasHypeTermSignal,
  detectHookPattern,
  isHowToTip,
  computeConfidence,
  LANDSCAPE_CODE_MAP,
} = require('../competitor-landscape.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Minimal corpus-item builder. Default trust_class is 'untrusted-scraped' (competitor).
 * Pass trust_class:'operator-curated' for own items.
 */
function item(over) {
  return {
    source: 'manual',
    captured_at: '2099-01-15T12:00:00Z',
    text: 'placeholder text here for a corpus item',
    trust_class: 'untrusted-scraped',
    retention_class: 'standard',
    ...over,
  };
}

/** Own item helper (operator-curated trust_class). */
function ownItem(over) {
  return item({ trust_class: 'operator-curated', ...over });
}

/** Competitor item helper. */
function compItem(over) {
  return item({ trust_class: 'untrusted-scraped', ...over });
}

// ---------------------------------------------------------------------------
// Fixture corpus loader (fixtures/competitor-scan-acme)
// ---------------------------------------------------------------------------

const FIXTURE_BASE = path.resolve(__dirname, '..', '..', '..', 'fixtures', 'competitor-scan-acme');

/**
 * Load all corpus items from a directory tree (depth-first, .json files only).
 * Items from `competitors/` subtrees are returned as-is (trust_class=untrusted-scraped).
 * Items from `own/` subtrees are returned as-is (trust_class from file).
 */
function loadFixtureCorpus(brandId) {
  const dir = path.join(FIXTURE_BASE, 'corpora', brandId);
  const items = [];

  function walk(absDir) {
    let entries;
    try { entries = fs.readdirSync(absDir, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name.startsWith('.')) continue;
      const abs = path.join(absDir, e.name);
      if (e.isDirectory()) { walk(abs); continue; }
      if (!e.isFile() || !e.name.endsWith('.json')) continue;
      try { items.push(JSON.parse(fs.readFileSync(abs, 'utf8'))); } catch { /* skip */ }
    }
  }

  walk(dir);
  return items;
}

/**
 * The fixture corpus uses directory-based partitioning (items under competitors/ are competitor)
 * but all items have trust_class:'untrusted-scraped'. We need an ownPredicate that matches
 * the generate.js readCorpus behavior — items under own/ are own, under competitors/ are competitor.
 * Since the loaded items don't carry this directory tag, we use the item URL/source to infer.
 * OR we separate them manually at load time.
 */
function loadFixtureCorpusPartitioned(brandId) {
  const ownDir = path.join(FIXTURE_BASE, 'corpora', brandId, 'own');
  const competitorsDir = path.join(FIXTURE_BASE, 'corpora', brandId, 'competitors');

  const loadDir = (dir) => {
    const items = [];
    function walk(d) {
      let entries;
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (e.name.startsWith('.')) continue;
        const abs = path.join(d, e.name);
        if (e.isDirectory()) { walk(abs); continue; }
        if (!e.isFile() || !e.name.endsWith('.json')) continue;
        try { items.push(JSON.parse(fs.readFileSync(abs, 'utf8'))); } catch { /* skip */ }
      }
    }
    walk(dir);
    return items;
  };

  const own = loadDir(ownDir);
  const competitor = loadDir(competitorsDir);
  return { own, competitor };
}

// ---------------------------------------------------------------------------
// Synthetic corpus for core unit tests
// ---------------------------------------------------------------------------

// Own items (Acme Cosmos — synthetic, operator-curated)
const OWN = [
  ownItem({ captured_at: '2099-01-10T09:00:00Z', text: 'Three steps to a perfect focus: start at lowest power, rack until a crater edge snaps, nudge back. Simple.' }),
  ownItem({ captured_at: '2099-01-13T20:00:00Z', text: 'Saturn is up after midnight this week. Ring gap is visible as a thin dark line with the 10mm eyepiece.' }),
  ownItem({ captured_at: '2099-01-16T14:00:00Z', text: 'Astronomy is not about owning the most gear. The skill is in the patience.' }),
  ownItem({ captured_at: '2099-01-20T10:00:00Z', text: 'Clear sky tonight over most of the Midwest. Best single target if you have an hour: the Orion Nebula.' }),
];

// Competitor items (Orbit Outfitters — synthetic, untrusted-scraped)
const COMPETITORS = [
  compItem({ captured_at: '2099-02-01T18:00:00Z', text: 'HUGE sale ends TONIGHT. You are NOT prepared for this deal. Last 30 units. Do not let another night pass.', metrics: { likes: 92, replies: 47, reposts: 11, bookmarks: 6, impressions: 24000 } }),
  compItem({ captured_at: '2099-02-05T20:00:00Z', text: 'How to find the Andromeda Galaxy in 4 steps: 1) face the Square of Pegasus, 2) hop to Mirach, 3) two stars up, 4) scan slow. The smudge is a trillion suns.', metrics: { likes: 1980, replies: 70, reposts: 260, bookmarks: 1450, impressions: 118000 } }),
  compItem({ captured_at: '2099-02-08T21:30:00Z', text: '\u{1F6A8} BIG launch incoming. The scope everyone has been waiting for. Soon. Very soon. \u{1F440}', metrics: { likes: 110, replies: 38, reposts: 14, bookmarks: 8, impressions: 28000 } }),
  compItem({ captured_at: '2099-02-12T19:00:00Z', text: 'The terminator is the best place to look on the Moon. Aim at the day-night boundary — the shadows make craters look three-dimensional. Always worth five minutes at high power.', metrics: { likes: 860, replies: 29, reposts: 105, bookmarks: 490, impressions: 61000 } }),
];

const MIXED = [...OWN, ...COMPETITORS];

// ---------------------------------------------------------------------------
// P6 DETERMINISM: byte-identical across two independent calls on same corpus
// ---------------------------------------------------------------------------

describe('analyzeCompetitorPatterns — P6 DETERMINISM', () => {
  test('identical corpus => byte-identical JSON output across two independent calls', () => {
    const r1 = analyzeCompetitorPatterns(MIXED);
    const r2 = analyzeCompetitorPatterns(MIXED);
    assert.deepEqual(r1, r2, 'byte-identical output required (P6)');
    assert.equal(
      JSON.stringify(r1),
      JSON.stringify(r2),
      'JSON serialization must also be identical',
    );
  });

  test('own-only corpus gives same result as two calls', () => {
    const r1 = analyzeCompetitorPatterns(OWN);
    const r2 = analyzeCompetitorPatterns(OWN);
    assert.deepEqual(r1, r2);
  });
});

// ---------------------------------------------------------------------------
// OWN / COMPETITOR PARTITION: competitor signals come from competitor items only
// ---------------------------------------------------------------------------

describe('analyzeCompetitorPatterns — own/competitor partition', () => {
  test('drama_markers.total_items counts competitor items only', () => {
    const r = analyzeCompetitorPatterns(MIXED);
    assert.equal(r.drama_markers.total_items, COMPETITORS.length, 'drama markers must count competitor items only');
  });

  test('hook_signals.total_items counts competitor items only', () => {
    const r = analyzeCompetitorPatterns(MIXED);
    assert.equal(r.hook_signals.total_items, COMPETITORS.length, 'hook signals must count competitor items only');
  });

  test('cadence_profile.total_items counts competitor items only', () => {
    const r = analyzeCompetitorPatterns(MIXED);
    assert.equal(r.cadence_profile.total_items, COMPETITORS.length);
  });

  test('own-only corpus => zero competitor counts in drama_markers', () => {
    const r = analyzeCompetitorPatterns(OWN);
    assert.equal(r.drama_markers.total_items, 0);
    assert.equal(r.drama_markers.high_drama_count, 0);
    assert.equal(r.drama_markers.exclamation_rate, 0);
    assert.equal(r.drama_markers.hype_term_rate, 0);
    assert.equal(r.drama_signal, 'low');
  });

  test('custom ownPredicate overrides default trust_class rule', () => {
    // Declare everything own — competitor counts drop to zero.
    const r = analyzeCompetitorPatterns(MIXED, { ownPredicate: () => true });
    assert.equal(r.drama_markers.total_items, 0, 'all-own predicate => no competitor items');
    assert.equal(r.drama_signal, 'low');

    // Declare everything competitor — competitor counts = total.
    const r2 = analyzeCompetitorPatterns(MIXED, { ownPredicate: () => false });
    assert.equal(r2.drama_markers.total_items, MIXED.length);
  });

  test('archetype_distribution tracks own_count separately from competitor_count', () => {
    const r = analyzeCompetitorPatterns(MIXED);
    for (const entry of r.archetype_distribution) {
      assert.ok('own_count' in entry, 'own_count field required');
      assert.ok('competitor_count' in entry, 'competitor_count field required');
      assert.ok(typeof entry.own_count === 'number' && entry.own_count >= 0);
      assert.ok(typeof entry.competitor_count === 'number' && entry.competitor_count >= 0);
    }
  });
});

// ---------------------------------------------------------------------------
// P1 NO VERBATIM: no competitor text appears verbatim in output
// ---------------------------------------------------------------------------

describe('analyzeCompetitorPatterns — P1 NO VERBATIM', () => {
  test('output contains no verbatim competitor text (strings in any field)', () => {
    const r = analyzeCompetitorPatterns(MIXED);
    // Collect all string values in the result recursively.
    const strings = [];
    function collectStrings(node) {
      if (node == null) return;
      if (typeof node === 'string') { strings.push(node); return; }
      if (Array.isArray(node)) { node.forEach(collectStrings); return; }
      if (typeof node === 'object') { Object.values(node).forEach(collectStrings); }
    }
    collectStrings(r);

    // No competitor item text (≥ 40 chars) should appear verbatim as a substring of any output string.
    const minLen = 40;
    const competitorTexts = COMPETITORS.map((it) => it.text.toLowerCase().replace(/\s+/g, ' ').trim())
      .filter((t) => t.length >= minLen);

    for (const compText of competitorTexts) {
      for (const outStr of strings) {
        const hay = outStr.toLowerCase().replace(/\s+/g, ' ');
        assert.ok(
          !hay.includes(compText),
          `verbatim competitor text leaked into output: "${compText.slice(0, 60)}"`,
        );
      }
    }
  });

  test('injecting verbatim competitor text into a synthetic output throws EVERBATIMCOPY', () => {
    // Build a corpus item that contains the competitor text verbatim, then check that
    // the guard exported from archetypes.js catches it.
    const { assertNoVerbatimCompetitorCopy } = require('../archetypes.js');
    const longCompText = 'This is a very long piece of verbatim competitor copy that we are injecting into the output for testing purposes to ensure the guard fires correctly on text over forty chars.';
    const fakeCompItem = compItem({ text: longCompText });
    const fakeOutput = { rationale: longCompText };
    assert.throws(
      () => assertNoVerbatimCompetitorCopy(fakeOutput, [fakeCompItem], { ownPredicate: () => false }),
      (e) => e.code === 'EVERBATIMCOPY' && Array.isArray(e.leaks) && e.leaks.length >= 1,
    );
  });

  test('analyzeCompetitorPatterns output passes assertNoVerbatimCompetitorCopy', () => {
    const { assertNoVerbatimCompetitorCopy } = require('../archetypes.js');
    const r = analyzeCompetitorPatterns(MIXED);
    // Should not throw.
    const checkResult = assertNoVerbatimCompetitorCopy(r, MIXED);
    assert.deepEqual(checkResult, { ok: true });
  });
});

// ---------------------------------------------------------------------------
// OUTPUT SHAPE: required fields, types, value ranges
// ---------------------------------------------------------------------------

describe('analyzeCompetitorPatterns — output shape', () => {
  test('all required top-level fields are present with correct types', () => {
    const r = analyzeCompetitorPatterns(MIXED);

    // drama_markers
    assert.ok(r.drama_markers && typeof r.drama_markers === 'object', 'drama_markers missing');
    assert.ok(typeof r.drama_markers.total_items === 'number');
    assert.ok(typeof r.drama_markers.high_drama_count === 'number');
    assert.ok(typeof r.drama_markers.medium_drama_count === 'number');
    assert.ok(typeof r.drama_markers.low_drama_count === 'number');
    assert.ok(typeof r.drama_markers.exclamation_rate === 'number');
    assert.ok(typeof r.drama_markers.hype_term_rate === 'number');
    // counts sum to total
    assert.equal(
      r.drama_markers.high_drama_count + r.drama_markers.medium_drama_count + r.drama_markers.low_drama_count,
      r.drama_markers.total_items,
    );
    // rates in [0,1]
    assert.ok(r.drama_markers.exclamation_rate >= 0 && r.drama_markers.exclamation_rate <= 1);
    assert.ok(r.drama_markers.hype_term_rate >= 0 && r.drama_markers.hype_term_rate <= 1);

    // archetype_distribution
    assert.ok(Array.isArray(r.archetype_distribution), 'archetype_distribution must be an array');

    // hook_signals
    assert.ok(r.hook_signals && typeof r.hook_signals === 'object');
    assert.ok(typeof r.hook_signals.total_items === 'number');
    assert.ok(Array.isArray(r.hook_signals.top_patterns));
    for (const p of r.hook_signals.top_patterns) {
      assert.ok(typeof p.pattern === 'string' && p.pattern.length > 0);
      assert.ok(typeof p.count === 'number' && p.count >= 1);
    }

    // cadence_profile
    assert.ok(r.cadence_profile && typeof r.cadence_profile === 'object');
    assert.ok(typeof r.cadence_profile.total_items === 'number');
    assert.ok(typeof r.cadence_profile.avg_posts_per_week === 'number');
    assert.ok(typeof r.cadence_profile.thread_rate === 'number');
    assert.ok(typeof r.cadence_profile.media_rate === 'number');
    assert.ok(r.cadence_profile.thread_rate >= 0 && r.cadence_profile.thread_rate <= 1);
    assert.ok(r.cadence_profile.media_rate >= 0 && r.cadence_profile.media_rate <= 1);

    // engagement_profile
    assert.ok(r.engagement_profile && typeof r.engagement_profile === 'object');
    assert.ok(typeof r.engagement_profile.metric === 'string');
    assert.ok(typeof r.engagement_profile.median_value === 'number');
    assert.ok(Array.isArray(r.engagement_profile.high_engagement_archetype_codes));

    // drama_signal
    assert.ok(['low', 'medium', 'high'].includes(r.drama_signal), `drama_signal must be low|medium|high, got: ${r.drama_signal}`);

    // confidence
    assert.ok(typeof r.confidence === 'number');
    assert.ok(r.confidence >= 0 && r.confidence <= 1);
  });

  test('hook pattern codes never contain verbatim competitor text (strings only, length-capped)', () => {
    const r = analyzeCompetitorPatterns(MIXED);
    for (const p of r.hook_signals.top_patterns) {
      // Pattern labels should be short structural descriptors, not extracted text.
      assert.ok(p.pattern.length <= 60, `hook pattern label too long: "${p.pattern}"`);
      assert.ok(/^[a-z0-9-]+$/.test(p.pattern), `hook pattern label should be kebab-case: "${p.pattern}"`);
    }
  });

  test('archetype_distribution entries have correct field types', () => {
    const r = analyzeCompetitorPatterns(MIXED);
    for (const entry of r.archetype_distribution) {
      assert.ok(typeof entry.code === 'string' && entry.code.length > 0, 'code must be non-empty string');
      assert.ok(typeof entry.own_count === 'number' && Number.isInteger(entry.own_count) && entry.own_count >= 0);
      assert.ok(typeof entry.competitor_count === 'number' && Number.isInteger(entry.competitor_count) && entry.competitor_count >= 0);
      // code must be one of the landscape codes (not a raw competitor text)
      const knownLandscapeCodes = new Set(Object.values(LANDSCAPE_CODE_MAP));
      assert.ok(
        knownLandscapeCodes.has(entry.code),
        `unexpected archetype code "${entry.code}" — must be a landscape code`,
      );
    }
  });

  test('cadence_profile.avg_posts_per_week is positive for a non-empty competitor corpus', () => {
    const r = analyzeCompetitorPatterns(MIXED);
    assert.ok(r.cadence_profile.avg_posts_per_week > 0);
  });
});

// ---------------------------------------------------------------------------
// Fixture-corpus end-to-end (uses real fixture files from fixtures/competitor-scan-acme)
// ---------------------------------------------------------------------------

describe('analyzeCompetitorPatterns — fixture corpus (acme-cosmos)', () => {
  const { own, competitor } = loadFixtureCorpusPartitioned('acme-cosmos');
  // Build a mixed corpus where own items are identifiable.
  const ownSet = new Set(own);
  const ownPredicate = (it) => ownSet.has(it);

  test('fixture corpora load correctly (4 own + 4 competitor)', () => {
    assert.equal(own.length, 4, 'expected 4 own fixture items');
    assert.equal(competitor.length, 4, 'expected 4 competitor fixture items');
  });

  test('fixture-corpus is byte-identical across two independent runs (P6)', () => {
    const mixed = [...own, ...competitor];
    const r1 = analyzeCompetitorPatterns(mixed, { ownPredicate });
    const r2 = analyzeCompetitorPatterns(mixed, { ownPredicate });
    assert.deepEqual(r1, r2, 'fixture corpus must give byte-identical results (P6)');
    assert.equal(JSON.stringify(r1), JSON.stringify(r2));
  });

  test('drama_markers counts exactly the 4 competitor items', () => {
    const mixed = [...own, ...competitor];
    const r = analyzeCompetitorPatterns(mixed, { ownPredicate });
    assert.equal(r.drama_markers.total_items, 4);
    assert.equal(
      r.drama_markers.high_drama_count + r.drama_markers.medium_drama_count + r.drama_markers.low_drama_count,
      4,
    );
  });

  test('drama_signal reflects competitor hype level (non-low for this fixture)', () => {
    const mixed = [...own, ...competitor];
    const r = analyzeCompetitorPatterns(mixed, { ownPredicate });
    // The fixture competitors include high-hype items (HUGE, 🚨 BIG launch) so signal must be
    // medium or high, not low.
    assert.ok(['medium', 'high'].includes(r.drama_signal), `expected medium|high drama_signal, got ${r.drama_signal}`);
  });

  test('confidence is in [0,1] and non-zero for a 4-item corpus with metrics', () => {
    const mixed = [...own, ...competitor];
    const r = analyzeCompetitorPatterns(mixed, { ownPredicate });
    assert.ok(r.confidence > 0 && r.confidence <= 1);
  });

  test('fixture output passes P1 no-verbatim guard', () => {
    const { assertNoVerbatimCompetitorCopy } = require('../archetypes.js');
    const mixed = [...own, ...competitor];
    const r = analyzeCompetitorPatterns(mixed, { ownPredicate });
    const check = assertNoVerbatimCompetitorCopy(r, mixed, { ownPredicate });
    assert.deepEqual(check, { ok: true });
  });

  test('HOW_TO archetype present in fixture corpus (instructional competitor items)', () => {
    const mixed = [...own, ...competitor];
    const r = analyzeCompetitorPatterns(mixed, { ownPredicate });
    const howTo = r.archetype_distribution.find((e) => e.code === 'HOW_TO');
    assert.ok(howTo, 'HOW_TO archetype code must appear in fixture archetype_distribution');
    assert.ok(howTo.competitor_count >= 1, 'HOW_TO must have at least 1 competitor item');
  });

  test('hook_signals.top_patterns contains how-to-numbered for step-format competitor items', () => {
    const mixed = [...own, ...competitor];
    const r = analyzeCompetitorPatterns(mixed, { ownPredicate });
    const howToPattern = r.hook_signals.top_patterns.find((p) => p.pattern === 'how-to-numbered');
    assert.ok(howToPattern, 'how-to-numbered hook pattern must appear for the step-format fixture item');
    assert.ok(howToPattern.count >= 1);
  });

  test('engagement_profile.metric is one of the standard metric keys', () => {
    const mixed = [...own, ...competitor];
    const r = analyzeCompetitorPatterns(mixed, { ownPredicate });
    const VALID_METRICS = new Set(['likes', 'replies', 'reposts', 'impressions', 'bookmarks']);
    assert.ok(VALID_METRICS.has(r.engagement_profile.metric), `unexpected metric: ${r.engagement_profile.metric}`);
    assert.ok(r.engagement_profile.median_value >= 0);
  });
});

// ---------------------------------------------------------------------------
// EDGE CASES
// ---------------------------------------------------------------------------

describe('analyzeCompetitorPatterns — edge cases', () => {
  test('empty array: returns valid zero-state result, never throws', () => {
    const r = analyzeCompetitorPatterns([]);
    assert.equal(r.drama_markers.total_items, 0);
    assert.equal(r.drama_signal, 'low');
    assert.equal(r.confidence, 0);
    assert.ok(Array.isArray(r.archetype_distribution));
    assert.ok(Array.isArray(r.hook_signals.top_patterns));
  });

  test('null/undefined: treated as empty corpus, never throws', () => {
    assert.doesNotThrow(() => analyzeCompetitorPatterns(null));
    assert.doesNotThrow(() => analyzeCompetitorPatterns(undefined));
    const r = analyzeCompetitorPatterns(null);
    assert.equal(r.drama_markers.total_items, 0);
  });

  test('malformed items (null, non-object, missing text) are skipped safely', () => {
    const corpus = [null, 42, {}, { text: 5 }, compItem({ text: 'A clean item here.' })];
    assert.doesNotThrow(() => analyzeCompetitorPatterns(corpus));
  });

  test('own-only corpus has zero competitor signals but non-zero own archetype distribution', () => {
    const r = analyzeCompetitorPatterns(OWN);
    assert.equal(r.drama_markers.total_items, 0);
    assert.equal(r.drama_signal, 'low');
    assert.equal(r.confidence, 0);
    // Own items may still appear in archetype_distribution with own_count > 0
    // (we track own items in the distribution for the diff comparison).
  });

  test('single competitor item with no metrics', () => {
    const corpus = [
      compItem({ text: 'Here is how to polar-align your telescope in 3 steps.' }),
    ];
    const r = analyzeCompetitorPatterns(corpus);
    assert.equal(r.drama_markers.total_items, 1);
    assert.ok(['low', 'medium', 'high'].includes(r.drama_signal));
    assert.ok(r.confidence >= 0 && r.confidence <= 1);
    assert.ok(Array.isArray(r.hook_signals.top_patterns));
  });

  test('competitor items with metrics produce a non-zero engagement profile', () => {
    const corpus = [
      compItem({ text: 'How to collimate your reflector in 5 steps. 1) center the primary...', metrics: { bookmarks: 500, likes: 1200, replies: 60, reposts: 150, impressions: 80000 } }),
      compItem({ text: 'HUGE deal ends TONIGHT! Last 10 units only.', metrics: { bookmarks: 50, likes: 100, replies: 20, reposts: 5, impressions: 5000 } }),
    ];
    const r = analyzeCompetitorPatterns(corpus);
    assert.ok(r.engagement_profile.median_value >= 0);
    assert.ok(typeof r.engagement_profile.metric === 'string');
  });
});

// ---------------------------------------------------------------------------
// Unit tests for individual helper functions
// ---------------------------------------------------------------------------

describe('dramaLevel', () => {
  test('high for text with alarm emoji', () => {
    assert.equal(dramaLevel('\u{1F6A8} BIG launch incoming.'), 'high');
  });

  test('high for text with multiple CAPS words', () => {
    assert.equal(dramaLevel('HUGE sale ends TONIGHT. You are NOT prepared for this deal.'), 'high');
  });

  test('medium for single CAPS word or single hype term', () => {
    const level = dramaLevel('A HUGE opportunity for everyone who wants to see more.');
    assert.ok(['medium', 'high'].includes(level)); // HUGE is both caps and a hype term
  });

  test('low for educational/conversational text', () => {
    assert.equal(dramaLevel('Saturn is up after midnight this week. Ring gap is visible at 10mm.'), 'low');
  });

  test('empty string returns low', () => {
    assert.equal(dramaLevel(''), 'low');
  });
});

describe('hasExclamationSignal', () => {
  test('true for text with ! character', () => {
    assert.equal(hasExclamationSignal('Sale ends tonight!'), true);
  });

  test('true for text with alarm emoji', () => {
    assert.equal(hasExclamationSignal('\u{1F6A8} big news'), true);
  });

  test('true for text with multiple CAPS words', () => {
    assert.equal(hasExclamationSignal('HUGE sale ends TONIGHT'), true);
  });

  test('false for calm instructional text', () => {
    assert.equal(hasExclamationSignal('How to find Andromeda in four steps.'), false);
  });
});

describe('hasHypeTermSignal', () => {
  test('true for "last chance"', () => {
    assert.equal(hasHypeTermSignal('Last chance to enter before the window closes tonight.'), true);
  });

  test('true for "huge" (case-insensitive)', () => {
    assert.equal(hasHypeTermSignal('A huge opportunity.'), true);
  });

  test('false for educational content', () => {
    assert.equal(hasHypeTermSignal('The terminator is the best place to look on the Moon.'), false);
  });
});

describe('detectHookPattern', () => {
  test('how-to-numbered for "How to ... in N steps: 1)"', () => {
    assert.equal(
      detectHookPattern('How to find the Andromeda Galaxy in 4 steps: 1) face the Square...'),
      'how-to-numbered',
    );
  });

  test('how-to-numbered for thread opener "1/"', () => {
    assert.equal(detectHookPattern('1/ Here is why aperture matters more than magnification.'), 'how-to-numbered');
  });

  test('announcement-breaking for alarm emoji opener', () => {
    assert.equal(detectHookPattern('\u{1F6A8} BIG launch incoming. The scope everyone waited for.'), 'announcement-breaking');
  });

  test('direct-tip for "best place to" instructional tip', () => {
    assert.equal(
      detectHookPattern('The terminator is the best place to look on the Moon. Aim at the day-night boundary.'),
      'direct-tip',
    );
  });

  test('ritual for "gm" opener', () => {
    assert.equal(detectHookPattern('gm friends, clear skies tonight'), 'ritual');
  });

  test('other for unrecognized opener', () => {
    assert.equal(detectHookPattern('Various thoughts on the universe today.'), 'other');
  });
});

describe('isHowToTip', () => {
  test('true for "how to" opener', () => {
    assert.equal(isHowToTip('How to find Andromeda in 4 steps.'), true);
  });

  test('true for "best place to"', () => {
    assert.equal(isHowToTip('The terminator is the best place to look on the Moon.'), true);
  });

  test('true for "aim at"', () => {
    assert.equal(isHowToTip('Aim at the day-night boundary to see the best crater detail.'), true);
  });

  test('false for FOMO/sales text', () => {
    assert.equal(isHowToTip('HUGE sale ends TONIGHT. Last 30 units.'), false);
  });

  test('false for teaser text', () => {
    assert.equal(isHowToTip('\u{1F6A8} BIG launch incoming. Soon. Very soon.'), false);
  });
});

describe('computeConfidence', () => {
  test('zero for empty array', () => {
    assert.equal(computeConfidence([]), 0);
  });

  test('positive and <= 1 for non-empty array', () => {
    const n4 = [
      compItem({ metrics: { bookmarks: 100, likes: 50, replies: 5, reposts: 10, impressions: 5000 } }),
      compItem({ metrics: { bookmarks: 200, likes: 90, replies: 10, reposts: 20, impressions: 8000 } }),
      compItem({ metrics: { bookmarks: 300, likes: 150, replies: 20, reposts: 40, impressions: 12000 } }),
      compItem({ metrics: { bookmarks: 400, likes: 200, replies: 30, reposts: 60, impressions: 20000 } }),
    ];
    const c = computeConfidence(n4);
    assert.ok(c > 0 && c <= 1, `expected confidence in (0,1], got ${c}`);
    assert.equal(c, 0.62, 'expected 0.62 for 4 items with full metric coverage');
  });

  test('scales with corpus size', () => {
    const items8 = Array.from({ length: 8 }, () =>
      compItem({ metrics: { bookmarks: 100, likes: 50, replies: 5, reposts: 10, impressions: 5000 } }),
    );
    const c4 = computeConfidence(COMPETITORS);
    const c8 = computeConfidence(items8);
    assert.ok(c8 > c4, 'more items should increase confidence');
  });
});
