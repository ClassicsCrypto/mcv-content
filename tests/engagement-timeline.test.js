'use strict';

/**
 * tests/engagement-timeline.test.js  [N — new tests, ENGAGEMENT-TIMELINE]
 *
 * Covers the deterministic engagement-timeline + project-facts artifact (release-spec §1.1/§1.2):
 *   - engine/brand-dna/engagement-timeline.js  — score formula, monthly/weekly buckets, top posts,
 *     peak/busiest period, media lift, engagement rate, empty + no-metrics degradation.
 *   - engine/cli/engagement-timeline.js  — reads the OWN slice only (competitors excluded), writes
 *     the JSON artifact + the markdown, --no-write previews, the artifact validates against schema.
 *
 * Deterministic + zero-key. Corpus is synthetic; writes go to a throwaway temp CONTENT_HOME.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const et = require('../engine/brand-dna/engagement-timeline.js');
const verb = require('../engine/cli/engagement-timeline.js');
const paths = require('../engine/shared/paths.js');
const { validate } = require('../scripts/validate-schemas.js');
const SCHEMA = require('../schemas/artifacts/engagement-timeline.schema.json');

function mk(id, date, text, { likes = 0, replies = 0, reposts = 0, bookmarks = 0, impressions = 0, media = false } = {}) {
  return {
    source: 'platform', captured_at: date, text, trust_class: 'untrusted-scraped', retention_class: 'standard',
    url: `https://x.com/acmecosmos/${id}`, metrics: { likes, replies, reposts, bookmarks, impressions },
    ...(media ? { media_refs: [`m${id}.jpg`] } : {}),
  };
}

function initHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oce-et-'));
  const env = { CONTENT_HOME: home };
  require('../engine/setup/init.js').initHome({ home, env });
  return { home, env };
}

// ---------------------------------------------------------------------------
// builder
// ---------------------------------------------------------------------------

test('scoreOf applies the documented weights (reposts=3, replies/bookmarks=2, likes=1)', () => {
  assert.equal(et.scoreOf({ likes: 10, replies: 2, reposts: 3, bookmarks: 1 }), 10 + 4 + 9 + 2);
  assert.equal(et.scoreOf(null), 0);
});

test('buildEngagementTimeline: monthly buckets, top posts ranked, peak period, window', () => {
  const items = [
    mk(1, '2025-11-02T10:00:00Z', 'Nov launch', { likes: 1200, replies: 40, reposts: 300, media: true }),
    mk(2, '2025-12-05T10:00:00Z', 'Dec recap', { likes: 800, replies: 30, reposts: 120 }),
    mk(3, '2026-01-15T10:00:00Z', 'Jan roadmap', { likes: 2000, replies: 80, reposts: 500, media: true }),
    mk(4, '2026-01-20T10:00:00Z', 'Jan note', { likes: 30, replies: 1, reposts: 2 }),
  ];
  const a = et.buildEngagementTimeline(items, { brand: 'acme', top: 3 });
  assert.equal(a.totals.posts, 4);
  assert.equal(a.totals.posts_with_metrics, 4);
  // top post = Jan roadmap: 2000 + 80*2 + 500*3 = 3660.
  assert.equal(a.top_posts[0].score, 3660);
  assert.match(a.top_posts[0].text_excerpt, /Jan roadmap/);
  assert.equal(a.top_posts.length, 3);
  // monthly buckets chronological.
  assert.deepEqual(a.timeline.map((t) => t.period), ['2025-11', '2025-12', '2026-01']);
  // peak period (most total engagement) = 2026-01 (3660 + small).
  assert.equal(a.summary.peak_period.period, '2026-01');
  assert.equal(a.window.start, '2025-11-02T10:00:00.000Z');
  assert.equal(a.window.end, '2026-01-20T10:00:00.000Z');
});

test('media lift compares with-media vs without; engagement rate uses impressions', () => {
  const items = [
    mk(1, '2026-01-02T10:00:00Z', 'with media', { likes: 1000, impressions: 10000, media: true }),
    mk(2, '2026-01-03T10:00:00Z', 'no media', { likes: 100, impressions: 10000 }),
  ];
  const a = et.buildEngagementTimeline(items);
  assert.equal(a.summary.media_lift.with_media_avg, 1000);
  assert.equal(a.summary.media_lift.without_media_avg, 100);
  assert.equal(a.summary.media_lift.lift_ratio, 10);
  // engagement rate = avg(score/impressions) = avg(1000/10000, 100/10000) = avg(0.1, 0.01) = 0.055 → round2 0.06.
  assert.equal(a.summary.avg_engagement_rate, 0.06);
});

test('empty corpus → clean no-op artifact with a note (DD-21), validates against schema', () => {
  const a = et.buildEngagementTimeline([], { brand: 'acme' });
  assert.equal(a.totals.posts, 0);
  assert.deepEqual(a.timeline, []);
  assert.deepEqual(a.top_posts, []);
  assert.ok(a.notes.some((n) => /No own-account corpus/i.test(n)));
  assert.ok(validate(a, SCHEMA).ok);
});

test('corpus with NO metrics → volume timeline + a note, no fabricated engagement', () => {
  const items = [
    { source: 'platform', captured_at: '2026-01-02T10:00:00Z', text: 'text only', trust_class: 'untrusted-scraped', retention_class: 'standard' },
    { source: 'platform', captured_at: '2026-01-03T10:00:00Z', text: 'also text only', trust_class: 'untrusted-scraped', retention_class: 'standard' },
  ];
  const a = et.buildEngagementTimeline(items);
  assert.equal(a.totals.posts, 2);
  assert.equal(a.totals.posts_with_metrics, 0);
  assert.equal(a.top_posts.length, 0);
  assert.equal(a.timeline[0].posts, 2); // volume still bucketed
  assert.equal(a.summary.total_engagement, 0);
  assert.ok(a.notes.some((n) => /NO engagement metrics/i.test(n)));
  assert.ok(validate(a, SCHEMA).ok);
});

test('weekly granularity buckets by ISO week', () => {
  const a = et.buildEngagementTimeline([
    mk(1, '2026-01-05T10:00:00Z', 'week A', { likes: 10 }),
    mk(2, '2026-01-12T10:00:00Z', 'week B', { likes: 20 }),
  ], { granularity: 'week' });
  assert.equal(a.granularity, 'week');
  assert.equal(a.timeline.length, 2);
  assert.ok(a.timeline.every((t) => /^\d{4}-W\d{2}$/.test(t.period)));
});

// ---------------------------------------------------------------------------
// CLI verb
// ---------------------------------------------------------------------------

test('verb reads the OWN slice only (competitors excluded) and writes JSON + markdown', () => {
  const { home, env } = initHome();
  const corp = paths.brandCorpusDir('demo', env);
  fs.mkdirSync(path.join(corp, 'competitors'), { recursive: true });
  fs.writeFileSync(path.join(corp, 'own1.json'), JSON.stringify(mk(1, '2026-01-15T10:00:00Z', 'own big', { likes: 1000, reposts: 100 })));
  fs.writeFileSync(path.join(corp, 'competitors', 'rival.json'), JSON.stringify(mk(9, '2026-01-18T10:00:00Z', 'rival huge', { likes: 999999, reposts: 99999 })));

  const res = verb.run({ flags: { brand: 'demo' }, env });
  assert.equal(res.ok, true);
  assert.equal(res.data.totals.posts, 1, 'competitor item must be excluded from the own timeline');
  assert.match(res.data.top_posts[0].text_excerpt, /own big/);

  const dir = paths.brandDir('demo', env);
  const artifact = JSON.parse(fs.readFileSync(path.join(dir, 'engagement-timeline.json'), 'utf8'));
  assert.ok(validate(artifact, SCHEMA).ok, 'written artifact must validate against the schema');
  const md = fs.readFileSync(path.join(dir, 'engagement-timeline.md'), 'utf8');
  assert.match(md, /# Engagement timeline & project facts — demo/);
  assert.match(md, /Highest-engagement posts/);
  fs.rmSync(home, { recursive: true, force: true });
});

test('verb --no-write previews without writing; --brand is required', () => {
  const { home, env } = initHome();
  const corp = paths.brandCorpusDir('demo', env);
  fs.mkdirSync(corp, { recursive: true });
  fs.writeFileSync(path.join(corp, 'own1.json'), JSON.stringify(mk(1, '2026-01-15T10:00:00Z', 'p', { likes: 5 })));

  const res = verb.run({ flags: { brand: 'demo', 'no-write': true }, env });
  assert.equal(res.ok, true);
  assert.ok(!fs.existsSync(path.join(paths.brandDir('demo', env), 'engagement-timeline.json')));

  const noBrand = verb.run({ flags: {}, env });
  assert.equal(noBrand.exitCode, 2);
  fs.rmSync(home, { recursive: true, force: true });
});
