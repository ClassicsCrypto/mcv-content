'use strict';

/**
 * tests/apify-trends.test.js  [N — new tests, APIFY-TRENDS]
 *
 * Covers the BYO Apify daily/hourly tracking feed (release-spec §8.8; RD-9; RD-12):
 *   - engine/sources/trends/source.js  — new 1h/24h cadences + tracked_accounts/keywords config.
 *   - engine/sources/trends/apify-adapter.js  — poll: tracked accounts + keywords → §6.7 topics
 *     (volume-labeled, source-linked, NO fabricated angles), degrade-to-[] when no token/actor.
 *   - engine/sources/verify-output.js#verifyTrendOutput  — ran-properly + topic-field filtering,
 *     hard failure on an expected-but-empty poll and on a non-schema topic field.
 *
 * Deterministic + zero-key: a fake fetchImpl returns staged rows; no network, no key.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');

const trends = require('../engine/sources/trends');
const source = require('../engine/sources/trends/source.js');
const apifyTrend = require('../engine/sources/trends/apify-adapter.js');
const { verifyTrendOutput } = require('../engine/sources/verify-output.js');

function tmpEnv(extra = {}) {
  return { CONTENT_HOME: path.join(os.tmpdir(), `oce-trends-${process.pid}-${Math.random().toString(36).slice(2)}`), ...extra };
}

const ROWS = [
  { text: 'big news about ai agents today', twitterUrl: 'https://x.com/a/1', author: { userName: 'creatorone' } },
  { text: 'ai agents are reshaping content', url: 'https://x.com/b/2', author: { username: 'rivalcosmos' } },
  { text: 'an unrelated post from the same creator', url: 'https://x.com/c/3', author: { userName: 'creatorone' } },
];
function fakeFetch(rows = ROWS) {
  return async () => ({ ok: true, status: 200, text: async () => JSON.stringify(rows) });
}

// ---------------------------------------------------------------------------
// source: cadences + config
// ---------------------------------------------------------------------------

test('source: 1h + 24h cadences resolve and carry the right freshness duration', () => {
  assert.equal(source.resolveCadence('1h'), '1h');
  assert.equal(source.resolveCadence('24h'), '24h');
  assert.equal(source.CADENCE_DURATION['1h'], 'PT1H');
  assert.equal(source.CADENCE_DURATION['24h'], 'PT24H');
  const norm = source.normalizeReport({ topics: [{ topic: 't' }], provenance: {} }, { cadence: '1h', nowMs: 0 });
  assert.equal(norm.freshness_window.duration, 'PT1H');
});

test('source: trendsConfig parses tracked_accounts + keywords (cleaned)', () => {
  const cfg = source.trendsConfig({ trends: { tracked_accounts: ['@a', ' ', 'b '], keywords: ['x', 2, ''] } });
  assert.deepEqual(cfg.tracked_accounts, ['@a', 'b']);
  assert.deepEqual(cfg.keywords, ['x']);
});

// ---------------------------------------------------------------------------
// apify trend adapter: poll
// ---------------------------------------------------------------------------

test('apify trend adapter: builds volume-labeled, source-linked topics with NO fabricated angles', async () => {
  const res = await trends.pollTrends({
    config: { trends: { enabled: true, adapter: 'apify', cadence: '1h', provider: { actor_id: 'apidojo/tweet-scraper' }, tracked_accounts: ['@creatorone'], keywords: ['ai agents'] } },
    env: tmpEnv({ APIFY_API_KEY: 'fake' }),
    write: false,
    fetchImpl: fakeFetch(),
  });
  assert.equal(res.reports.length, 1);
  const topics = res.reports[0].topics;
  const kw = topics.find((t) => /^ai agents/.test(t.topic));
  assert.ok(kw, 'a keyword topic is present');
  assert.match(kw.topic, /\(2 posts\)/);
  assert.deepEqual(kw.source_links, ['https://x.com/a/1', 'https://x.com/b/2']);
  const acct = topics.find((t) => /^@creatorone/.test(t.topic));
  assert.ok(acct, 'a tracked-account topic is present');
  assert.deepEqual(acct.source_links, ['https://x.com/a/1', 'https://x.com/c/3']);
  // No fabricated angles anywhere (the §1.4 no-drafted-text principle).
  for (const t of topics) assert.ok(!('suggested_angles' in t) || t.suggested_angles.length === 0);
});

test('apify trend adapter: degrades to [] when no token/actor; and when nothing is tracked', async () => {
  // No token.
  const a = await apifyTrend.poll({ provider: { actor_id: 'a/b' }, tracked_accounts: ['@x'], env: tmpEnv(), fetchImpl: fakeFetch() });
  assert.deepEqual(a, []);
  // Token but nothing to track.
  const b = await apifyTrend.poll({ provider: { actor_id: 'a/b' }, env: tmpEnv({ APIFY_API_KEY: 'fake' }), fetchImpl: fakeFetch() });
  assert.deepEqual(b, []);
});

test('apify trend adapter: a target with zero matched posts produces no empty topic', async () => {
  const res = await apifyTrend.poll({
    provider: { actor_id: 'a/b' },
    keywords: ['nonexistent-keyword'],
    env: tmpEnv({ APIFY_API_KEY: 'fake' }),
    fetchImpl: fakeFetch(),
  });
  assert.deepEqual(res, [], 'no matches ⇒ no report (never a fabricated/empty topic)');
});

// ---------------------------------------------------------------------------
// verifyTrendOutput
// ---------------------------------------------------------------------------

test('verifyTrendOutput: a clean poll is ok; an expected-but-empty poll is a HARD FAILURE', async () => {
  const res = await trends.pollTrends({
    config: { trends: { enabled: true, adapter: 'apify', provider: { actor_id: 'a/b' }, keywords: ['ai agents'] } },
    env: tmpEnv({ APIFY_API_KEY: 'fake' }), write: false, fetchImpl: fakeFetch(),
  });
  const ok = verifyTrendOutput(res, { requested: { keywords: ['ai agents'] } });
  assert.equal(ok.ok, true);
  assert.ok(ok.counts.topics >= 1);

  const empty = verifyTrendOutput({ reports: [], invalid: [] }, { requested: { tracked_accounts: ['@x'] } });
  assert.equal(empty.ok, false);
  assert.ok(empty.errors.some((e) => /NO topics/i.test(e)));
});

test('verifyTrendOutput: a topic with a non-schema field fails the field filter', () => {
  const dirty = { reports: [{ topics: [{ topic: 'x', volume: 9 }] }] };
  const v = verifyTrendOutput(dirty, {});
  assert.equal(v.field_check.ok, false);
  assert.ok(v.field_check.offending[0].problems.some((p) => /extra key "volume"/.test(p)));
});
