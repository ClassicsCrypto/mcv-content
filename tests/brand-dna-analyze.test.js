'use strict';

/**
 * tests/brand-dna-analyze.test.js  [BD-ANALYZE]
 *
 * Coverage for the deterministic brand-DNA analyzer (engine/brand-dna/analyze.js) + archetype
 * categorizer (engine/brand-dna/archetypes.js) — original-design-spec 1.1 (Brand DNA Generation)
 * + 1.2 (Context & Competitor Analysis). Proves, ZERO-KEY (RD-12, no secrets/no network/no LLM):
 *   - analyzeCorpus computes cadence / length distribution / format mix / top hooks / themes and is
 *     fully DETERMINISTIC (same corpus => byte-identical output) and pure (no I/O);
 *   - own vs competitor are sliced separately (BRAND-DNA LAW); competitor content feeds counts +
 *     engagement + structure, never copied copy;
 *   - engagement-weighted lift is computed when items carry metrics, suppressed below the cell min;
 *   - categorizeArchetypes multi-labels by brand-NEUTRAL signals, captures idea seeds from OWN
 *     content only, and surfaces hooks + argument patterns per archetype;
 *   - assertNoVerbatimCompetitorCopy PASSES on a clean catalog and THROWS (EVERBATIMCOPY) if a
 *     competitor item's text is embedded — the verbatim guard the feature law requires.
 *
 * Synthetic corpus only (no real handles/brands/competitors). Runner: node:test (Node >= 22).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { analyzeCorpus, deriveFormat, topK, tokenize } = require('../engine/brand-dna/analyze.js');
const {
  categorizeArchetypes, assertNoVerbatimCompetitorCopy, classifyItem, primaryArchetype,
} = require('../engine/brand-dna/archetypes.js');

// ---------------------------------------------------------------------------
// Synthetic corpus (own = operator-curated; competitor = untrusted-scraped)
// ---------------------------------------------------------------------------

function item(over) {
  return {
    source: 'manual',
    captured_at: '2099-01-01T12:00:00Z',
    text: 'placeholder',
    trust_class: 'untrusted-scraped',
    retention_class: 'standard',
    ...over,
  };
}

const OWN = [
  item({ trust_class: 'operator-curated', captured_at: '2099-01-01T09:00:00Z', text: 'gm friends, clear skies tonight' }),
  item({ trust_class: 'operator-curated', captured_at: '2099-01-02T10:00:00Z', text: 'Here is why aperture beats magnification for faint targets. 1/ a short thread.' }),
  item({ trust_class: 'operator-curated', captured_at: '2099-01-03T11:00:00Z', text: '3 reasons your focus drifts at high power, and how to fix each one quickly.' }),
  item({ trust_class: 'operator-curated', captured_at: '2099-01-04T20:00:00Z', text: 'Introducing our new beginner eyepiece. Now available today.' }),
];

const COMPETITOR = [
  item({ captured_at: '2099-02-01T14:00:00Z', text: 'Only 5 left. Last chance before the window closes tonight.', metrics: { like_count: 20, reply_count: 5, impression_count: 900 } }),
  item({ captured_at: '2099-02-02T15:00:00Z', text: 'Here is why dark skies matter more than expensive glass. 1/ thread', metrics: { like_count: 300, reply_count: 90, impression_count: 20000 } }),
  item({ captured_at: '2099-02-03T15:00:00Z', text: '3 ways to align your finder scope in under a minute each.', metrics: { like_count: 250, reply_count: 80, impression_count: 18000 } }),
  item({ captured_at: '2099-02-04T16:00:00Z', text: 'gm', metrics: { like_count: 10, reply_count: 2, impression_count: 400 } }),
  item({ captured_at: '2099-02-05T16:00:00Z', text: 'Thank you to everyone who came to the star party last night.', metrics: { like_count: 50, reply_count: 12, impression_count: 2200 } }),
];

const CORPUS = [...OWN, ...COMPETITOR];

// ---------------------------------------------------------------------------

test('analyzeCorpus is deterministic / reproducible and never calls an LLM', () => {
  const a = analyzeCorpus(CORPUS);
  const b = analyzeCorpus(CORPUS);
  assert.equal(a.generated_with, 'deterministic-no-llm');
  assert.deepEqual(a, b, 'same corpus must yield byte-identical analysis (reproducible)');
});

test('totals slice own vs competitor by trust_class (default predicate)', () => {
  const a = analyzeCorpus(CORPUS);
  assert.equal(a.totals.items, CORPUS.length);
  assert.equal(a.totals.own, OWN.length);
  assert.equal(a.totals.competitor, COMPETITOR.length);
  assert.equal(a.totals.with_metrics, COMPETITOR.length); // only competitor carry metrics here
});

test('cadence derives day-of-week + hour + posts-per-active-day from captured_at', () => {
  const a = analyzeCorpus(CORPUS);
  assert.equal(a.own.cadence.active_days, OWN.length); // four distinct own days
  assert.ok(a.own.cadence.by_day_of_week.length === 7);
  assert.ok(a.own.cadence.by_hour_utc.length === 24);
  // own item at 09:00 UTC must be counted in hour 9.
  assert.equal(a.own.cadence.by_hour_utc[9].count, 1);
});

test('length distribution carries quantiles + fixed buckets', () => {
  const a = analyzeCorpus(CORPUS);
  assert.ok(a.all.length.median >= a.all.length.min);
  assert.ok(a.all.length.p90 >= a.all.length.median);
  const bucketTotal = a.all.length.buckets.reduce((s, b) => s + b.count, 0);
  assert.equal(bucketTotal, CORPUS.length, 'every item lands in exactly one length bucket');
});

test('format mix derives format structurally (thread/media/text/...)', () => {
  // a thread opener
  assert.equal(deriveFormat(item({ text: '1/ first beat of a thread' })), 'thread');
  // a media item
  assert.equal(deriveFormat(item({ text: 'look at this', media_refs: ['m/1.png'] })), 'media');
  // explicit format field wins
  assert.equal(deriveFormat(item({ text: 'x', format: 'Reply' })), 'reply');
  const a = analyzeCorpus(CORPUS);
  const sum = a.all.format_mix.reduce((s, f) => s + f.count, 0);
  assert.equal(sum, CORPUS.length);
});

test('top hooks are leading n-grams; themes are stop-worded term frequencies', () => {
  const a = analyzeCorpus(CORPUS);
  assert.ok(a.all.top_hooks.length > 0);
  // every hook term is a non-empty opener string with a count
  for (const h of a.all.top_hooks) {
    assert.equal(typeof h.term, 'string');
    assert.ok(h.count >= 1);
  }
  // 'the','is','to' are stop words and must NOT appear as theme unigrams
  const uni = a.all.themes.unigrams.map((t) => t.term);
  assert.ok(!uni.includes('the') && !uni.includes('is') && !uni.includes('to'));
});

test('engagement-weighted lift computes when metrics present, suppressed below cell min', () => {
  const a = analyzeCorpus(CORPUS);
  assert.equal(a.competitor.engagement.available, true);
  assert.equal(a.competitor.engagement.n, COMPETITOR.length);
  // baseline + per-dimension lift tables exist
  assert.ok(a.competitor.engagement.baseline);
  assert.ok(Array.isArray(a.competitor.engagement.by_format));
  // own slice has no metrics → engagement unavailable
  assert.equal(a.own.engagement.available, false);
  // a high minEngagementCell suppresses everything
  const strict = analyzeCorpus(CORPUS, { minEngagementCell: 999 });
  for (const row of strict.competitor.engagement.by_format) assert.fail('should be suppressed');
  assert.equal(strict.competitor.engagement.by_format.length, 0);
});

test('classifyItem multi-labels with brand-neutral signals; primary picks the specific one', () => {
  const matches = classifyItem(item({ text: 'Introducing our launch. Only 5 left, last chance!' }));
  assert.ok(matches.includes('ANNOUNCEMENT'));
  assert.ok(matches.includes('SCARCITY_FOMO'));
  // ANNOUNCEMENT outranks SCARCITY_FOMO in primary priority
  assert.equal(primaryArchetype(matches), 'ANNOUNCEMENT');
  // a pure ritual
  assert.deepEqual(classifyItem(item({ text: 'gm' })), ['RITUAL']);
});

test('categorizeArchetypes captures hooks + argument patterns, own-only idea seeds', () => {
  const cat = categorizeArchetypes(CORPUS);
  assert.ok(cat.archetypes.length > 0);
  const numbered = cat.archetypes.find((x) => x.code === 'NUMBERED_THESIS');
  assert.ok(numbered, 'NUMBERED_THESIS should be present');
  assert.ok(numbered.hooks.length > 0 && numbered.argument_patterns.length > 0);
  // own has a NUMBERED_THESIS item → at least one own idea seed, all tagged own-curated
  assert.ok(numbered.idea_seeds.length >= 1);
  for (const seed of numbered.idea_seeds) {
    assert.equal(seed.provenance.trust_class, 'operator-curated', 'idea seeds must be OWN content only');
  }
  // counts split own vs competitor
  assert.ok(numbered.counts.own >= 1 && numbered.counts.competitor >= 1);
});

test('assertNoVerbatimCompetitorCopy passes clean, throws on embedded competitor copy', () => {
  const a = analyzeCorpus(CORPUS);
  // clean catalog (idea seeds are own-only) → passes
  assert.deepEqual(assertNoVerbatimCompetitorCopy(a.archetypes, CORPUS), { ok: true });
  // inject a competitor item's text → must throw EVERBATIMCOPY
  const tainted = { ...a.archetypes, leaked_field: COMPETITOR[1].text };
  assert.throws(
    () => assertNoVerbatimCompetitorCopy(tainted, CORPUS),
    (e) => e.code === 'EVERBATIMCOPY' && Array.isArray(e.leaks) && e.leaks.length >= 1,
  );
});

test('tolerant of an empty / malformed corpus (never throws)', () => {
  assert.equal(analyzeCorpus([]).totals.items, 0);
  assert.equal(analyzeCorpus(null).totals.items, 0);
  const messy = analyzeCorpus([null, 42, {}, { text: 5 }, item({ text: 'gm' })]);
  assert.ok(messy.totals.items === 5);
  assert.deepEqual(classifyItem(null), []);
  assert.equal(primaryArchetype([]), null);
});

test('custom ownPredicate overrides the default trust_class rule', () => {
  // declare EVERYTHING own → competitor slice empty, no items excluded from idea seeds
  const a = analyzeCorpus(CORPUS, { ownPredicate: () => true });
  assert.equal(a.totals.competitor, 0);
  assert.equal(a.totals.own, CORPUS.length);
  // with no competitor items, the verbatim guard is vacuously satisfied
  assert.deepEqual(assertNoVerbatimCompetitorCopy(a.archetypes, CORPUS, { ownPredicate: () => true }), { ok: true });
});
