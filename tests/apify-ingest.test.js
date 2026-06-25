'use strict';

/**
 * tests/apify-ingest.test.js  [N — new tests, APIFY-INGEST]
 *
 * Covers the BYO Apify ingest path (release-spec §2.4 BYO scraper; RD-9; RD-12 injectable seam):
 *   - engine/sources/apify-client.js  — token resolve, actor-id path encoding, input building.
 *   - engine/sources/ingest/apify-adapter.js  — fetch: own/competitor labeling, metric mapping,
 *     junk-field filtering, degrade-to-[] when no token/actor, all zero-key via an injected fetch.
 *   - engine/sources/verify-output.js  — the output verification: ran-properly + filtered-to-only-the
 *     -required-variables, with hard failure on zero-when-expected and on an extra (non-schema) field.
 *
 * Deterministic + zero-key: a fake fetchImpl returns recorded Apify dataset rows; no network, no key.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');

const apify = require('../engine/sources/apify-client.js');
const ingest = require('../engine/sources/ingest');
const { verifyIngestOutput } = require('../engine/sources/verify-output.js');
const REC = require('../fixtures/apify-acme/recorded/dataset-responses.json');

function tmpEnv(extra = {}) {
  return { CONTENT_HOME: path.join(os.tmpdir(), `oce-apify-${process.pid}-${Math.abs(hash(JSON.stringify(extra)))}`), ...extra };
}
function hash(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; }

/** A fake fetch that returns the own rows for the own pull (searchTerms has from:acmecosmos), else competitor. */
function fakeApify(rows = REC) {
  return async (url, opts) => {
    const body = JSON.parse(opts.body || '{}');
    const isOwn = JSON.stringify(body).includes('from:acmecosmos');
    const items = isOwn ? rows.own : rows.competitor;
    return { ok: true, status: 200, text: async () => JSON.stringify(items) };
  };
}

// ---------------------------------------------------------------------------
// apify-client
// ---------------------------------------------------------------------------

test('apify-client: actor path id replaces the slash; token resolves by name (degrades to null)', () => {
  assert.equal(apify.actorPathId('apidojo/tweet-scraper'), 'apidojo~tweet-scraper');
  assert.equal(apify.resolveToken({}, {}), null);
  assert.deepEqual(apify.resolveToken({}, { APIFY_API_KEY: 'k' }), { name: 'APIFY_API_KEY', value: 'k' });
  assert.equal(apify.resolveToken({ key_env: 'MY_TOKEN' }, { MY_TOKEN: 'x' }).name, 'MY_TOKEN');
});

test('apify-client: buildInput folds handles into searchTerms (from:) by default + honors field_map', () => {
  const def = apify.buildInput({}, { handles: ['@acmecosmos'], search: ['space'], maxItems: 50, since: '2025-01-01' });
  assert.deepEqual(def.searchTerms, ['from:acmecosmos', 'space']);
  assert.equal(def.maxItems, 50);
  assert.equal(def.start, '2025-01-01');

  const mapped = apify.buildInput(
    { handles_as_search: false, field_map: { handles: 'twitterHandles', maxItems: 'maxTweets' }, input: { sort: 'Latest' } },
    { handles: ['acmecosmos'], maxItems: 10 },
  );
  assert.deepEqual(mapped.twitterHandles, ['acmecosmos']);
  assert.equal(mapped.maxTweets, 10);
  assert.equal(mapped.sort, 'Latest'); // static input template preserved
});

test('apify-client: a non-2xx run throws ApifyRunError with the status', async () => {
  const fetchImpl = async () => ({ ok: false, status: 402, text: async () => JSON.stringify({ error: { message: 'payment required' } }) });
  await assert.rejects(
    () => apify.runActorGetItems({ actorId: 'a/b', input: {}, token: 't', fetchImpl }),
    (e) => e.name === 'ApifyRunError' && e.httpStatus === 402,
  );
});

// ---------------------------------------------------------------------------
// apify ingest adapter (through ingestCorpus)
// ---------------------------------------------------------------------------

test('apify adapter: pulls own + competitor, labels them, maps metrics, FILTERS junk fields', async () => {
  const provider = { actor_id: 'apidojo/tweet-scraper', key_env: 'APIFY_API_KEY' };
  const res = await ingest.ingestCorpus({
    config: { ingest: { enabled: true, adapter: 'apify', provider } },
    env: tmpEnv({ APIFY_API_KEY: 'fake' }),
    brand: 'demo',
    account: '@acmecosmos',
    competitors: ['@rivalcosmos'],
    confirmed: true,
    write: false,
    fetchImpl: fakeApify(),
  });
  assert.equal(res.by_class.own, 2);
  assert.equal(res.by_class.competitor, 1);
  // the high-engagement own item carries mapped metrics…
  const launch = res.items.find((i) => /Launch day/.test(i.text));
  assert.deepEqual(launch.metrics, { likes: 1240, replies: 38, reposts: 210, bookmarks: 95, impressions: 88000 });
  // …and NONE of the junk actor fields leaked through (filtered to corpus-item variables only).
  for (const item of res.items) {
    assert.ok(!('conversationId' in item) && !('internalScore' in item) && !('isRetweet' in item) && !('lang' in item));
  }
});

test('apify adapter: degrades to [] (no throw) when the token or actor is absent', async () => {
  // No token.
  const a = await ingest.ingestCorpus({
    config: { ingest: { enabled: true, adapter: 'apify', provider: { actor_id: 'a/b' } } },
    env: tmpEnv(), brand: 'demo', account: '@acmecosmos', confirmed: true, write: false, fetchImpl: fakeApify(),
  });
  assert.equal(a.items.length, 0);
  // Token present but no actor_id.
  const b = await ingest.ingestCorpus({
    config: { ingest: { enabled: true, adapter: 'apify', provider: {} } },
    env: tmpEnv({ APIFY_API_KEY: 'fake' }), brand: 'demo', account: '@acmecosmos', confirmed: true, write: false, fetchImpl: fakeApify(),
  });
  assert.equal(b.items.length, 0);
});

// ---------------------------------------------------------------------------
// verify-output
// ---------------------------------------------------------------------------

test('verifyIngestOutput: a clean pull is ok, fields clean, metrics covered', async () => {
  const provider = { actor_id: 'apidojo/tweet-scraper' };
  const res = await ingest.ingestCorpus({
    config: { ingest: { enabled: true, adapter: 'apify', provider } },
    env: tmpEnv({ APIFY_API_KEY: 'fake' }), brand: 'demo', account: '@acmecosmos', competitors: ['@rivalcosmos'],
    confirmed: true, write: false, fetchImpl: fakeApify(),
  });
  const v = verifyIngestOutput(res, { requested: { account: '@acmecosmos', competitors: ['@rivalcosmos'] } });
  assert.equal(v.ok, true);
  assert.equal(v.field_check.ok, true);
  assert.equal(v.counts.normalized, 3);
  assert.equal(v.metrics_coverage.with_metrics, 3);
});

test('verifyIngestOutput: a requested-but-empty pull is a HARD FAILURE (not a silent no-op)', () => {
  const v = verifyIngestOutput({ items: [], invalid: [], written: [], by_class: { own: 0, competitor: 0 } },
    { requested: { account: '@acmecosmos', competitors: ['@rivalcosmos'] } });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /ZERO items/i.test(e)));
});

test('verifyIngestOutput: an item carrying a non-schema field fails the field filter', () => {
  const dirty = { items: [{ source: 'platform', captured_at: '2026-01-01T00:00:00Z', text: 'x', trust_class: 'untrusted-scraped', retention_class: 'standard', leakedField: 'oops' }] };
  const v = verifyIngestOutput(dirty, { expectItems: false });
  assert.equal(v.ok, false);
  assert.equal(v.field_check.ok, false);
  assert.ok(v.field_check.offending[0].problems.some((p) => /extra key "leakedField"/.test(p)));
});

test('verifyIngestOutput: the in-memory _account_class marker is NOT treated as a leaked field', () => {
  const withMarker = { items: [{ source: 'platform', captured_at: '2026-01-01T00:00:00Z', text: 'x', trust_class: 'untrusted-scraped', retention_class: 'standard', _account_class: 'own' }] };
  const v = verifyIngestOutput(withMarker, { expectItems: false });
  assert.equal(v.field_check.ok, true);
});
