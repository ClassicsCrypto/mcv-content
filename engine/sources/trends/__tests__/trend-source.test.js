'use strict';

/**
 * Trend-source seam tests (release-spec §8.8 trend pathway; §12.1 #1 scraper/trend seam; RD-9 BYO;
 * RD-12 zero-key tests with injectable provider call). Asserts the contract-critical invariants:
 *   1. the pathway is OFF BY DEFAULT — pollTrends throws TrendsDisabledError until opt-in.
 *   2. the registry admits adapters and the shipped ones (reference, fixture) self-register.
 *   3. the fixture adapter runs ZERO-KEY and writes a schema-conformant report under CONTENT_HOME.
 *   4. the reference adapter resolves its credential BY NAME via secrets.js and uses an INJECTABLE
 *      fetch (no real network, no bundled creds); it DEGRADES to [] when no key/endpoint is set.
 *   5. provenance.trust_zone is FORCED to "U" and a freshness window is always present (DD-15 basis).
 *   6. a malformed report is dropped, never written (no bad seed enters the chain).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const trends = require('../index'); // populates the registry (reference + fixture)
const source = require('../source');
const referenceAdapter = require('../reference-adapter');

function tmpHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oce-trends-'));
  return { CONTENT_HOME: dir };
}

test('shipped adapters self-register under their config names', () => {
  assert.ok(trends.has('reference'), 'reference registered');
  assert.ok(trends.has('fixture'), 'fixture registered');
});

test('pollTrends is OFF BY DEFAULT — refuses with TrendsDisabledError until opt-in', async () => {
  await assert.rejects(
    () => trends.pollTrends({ config: {}, env: { CONTENT_HOME: '' } }),
    trends.TrendsDisabledError,
  );
  // Even an explicit adapter does not bypass the gate.
  await assert.rejects(
    () => trends.pollTrends({ config: { trends: { enabled: false } }, adapter: 'fixture', env: { CONTENT_HOME: '' } }),
    trends.TrendsDisabledError,
  );
});

test('enabled fixture adapter runs zero-key and writes a schema-conformant report', async () => {
  const env = tmpHome();
  const config = { trends: { enabled: true, adapter: 'fixture', cadence: '4h' } };
  const result = await trends.pollTrends({ config, env, brand: 'acme-cosmos' });

  assert.equal(result.ran, true);
  assert.equal(result.adapter, 'fixture');
  assert.equal(result.cadence, '4h');
  assert.equal(result.invalid.length, 0, 'no invalid reports');
  assert.equal(result.reports.length, 1);
  assert.equal(result.written.length, 1, 'one report written');

  // The written file exists, under $CONTENT_HOME/trends/<brand>/, and validates.
  const file = result.written[0];
  assert.ok(file.includes(path.join('trends', 'acme-cosmos')), 'written under the brand trends dir');
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(source.validateReport(onDisk), [], 'on-disk report conforms to §6.7');
  assert.equal(onDisk.provenance.trust_zone, 'U', 'always Zone U');
  assert.equal(onDisk.provenance.method, 'adapter');
  assert.ok(onDisk.freshness_window && onDisk.freshness_window.expires_at, 'freshness window present (DD-15 basis)');

  fs.rmSync(env.CONTENT_HOME, { recursive: true, force: true });
});

test('write:false returns reports without touching disk', async () => {
  const config = { trends: { enabled: true, adapter: 'fixture' } };
  const result = await trends.pollTrends({ config, env: { CONTENT_HOME: '' }, write: false });
  assert.equal(result.reports.length, 1);
  assert.equal(result.written.length, 0);
});

test('unknown adapter throws TrendSourceNotRegisteredError naming the available set', async () => {
  await assert.rejects(
    () => trends.pollTrends({ config: { trends: { enabled: true, adapter: 'nope' } }, env: { CONTENT_HOME: '' } }),
    trends.TrendSourceNotRegisteredError,
  );
});

test('register rejects a malformed adapter, naming the missing method', () => {
  assert.throws(() => trends.register('bad', {}), /poll/);
});

test('reference adapter degrades to [] when no provider key is configured (BYO, RD-9)', async () => {
  // No APIFY/XAI/GROK key in env, no endpoint => no reports, no throw, manual path remains.
  const reports = await referenceAdapter.poll({ env: { CONTENT_HOME: '' }, cadence: '12h', provider: {} });
  assert.deepEqual(reports, []);
});

test('reference adapter resolves the key BY NAME and uses the INJECTABLE fetch (zero real network)', async () => {
  let seenAuth = null;
  let seenUrl = null;
  const fakeFetch = (url, opts) => {
    seenUrl = url;
    seenAuth = opts.headers.Authorization;
    return Promise.resolve({
      ok: true,
      status: 200,
      text: () =>
        Promise.resolve(
          JSON.stringify({
            topics: [
              { topic: 'Synthetic provider topic', urls: ['https://example.test/x'], angles: ['an angle, not a draft'] },
            ],
          }),
        ),
    });
  };
  const env = { CONTENT_HOME: '', APIFY_API_KEY: 'synthetic-key' };
  const config = {
    trends: {
      enabled: true,
      adapter: 'reference',
      cadence: '8h',
      provider: { endpoint: 'https://provider.example/trends', platform: 'twitter', auth_scheme: 'Bearer ' },
    },
  };
  const result = await trends.pollTrends({ config, env, fetchImpl: fakeFetch, write: false });

  assert.ok(String(seenUrl).startsWith('https://provider.example/trends'), 'hit the configured endpoint');
  assert.equal(seenAuth, 'Bearer synthetic-key', 'credential resolved by NAME, injected into the header');
  assert.equal(result.reports.length, 1);
  assert.equal(result.reports[0].topics[0].topic, 'Synthetic provider topic');
  assert.equal(result.reports[0].provenance.trust_zone, 'U');
});

test('reference adapter redacts a token-shaped value out of the provider payload (privacy pre-pass)', async () => {
  // The provider echoes a secret-bearing field; it must NOT survive into the report.
  const fakeFetch = () =>
    Promise.resolve({
      ok: true,
      status: 200,
      text: () =>
        Promise.resolve(
          JSON.stringify({
            // Redacted two ways: the `access_token` KEY is in the deny-list, and the value is a
            // long opaque blob the value-shape pattern also catches. Synthetic, not a real-key shape.
            access_token: 'shouldneverappear0123456789abcdef0123456789abcdef',
            topics: [{ topic: 'Clean synthetic topic' }],
          }),
        ),
    });
  const env = { CONTENT_HOME: '', XAI_API_KEY: 'k' };
  const config = {
    trends: { enabled: true, adapter: 'reference', provider: { endpoint: 'https://p.example/t' } },
  };
  const result = await trends.pollTrends({ config, env, fetchImpl: fakeFetch, write: false });
  const serialized = JSON.stringify(result.reports);
  assert.ok(!serialized.includes('shouldneverappear'), 'secret-shaped value redacted before mapping');
});

test('cadences 2/4/8/12h are accepted; an off-list cadence is rejected', () => {
  for (const c of ['2h', '4h', '8h', '12h']) {
    assert.equal(source.resolveCadence(c), c);
  }
  assert.throws(() => source.resolveCadence('3h'), /unknown trend cadence/);
  assert.equal(source.resolveCadence(undefined), '12h', 'defaults to the most conservative cadence');
});

test('a malformed report is dropped (never written) — no bad seed enters the chain', async () => {
  // A stub adapter that emits a report missing the required platform field.
  trends.register('broken', {
    async poll() {
      return [{ period: { start: 'a', end: 'b' }, topics: [{ topic: 't' }], provenance: { trust_zone: 'U', method: 'adapter' } }];
    },
  });
  try {
    const env = tmpHome();
    const config = { trends: { enabled: true, adapter: 'broken' } };
    const result = await trends.pollTrends({ config, env });
    assert.equal(result.reports.length, 0, 'no valid reports');
    assert.equal(result.written.length, 0, 'nothing written');
    assert.equal(result.invalid.length, 1, 'the malformed report is recorded as invalid');
    assert.ok(result.invalid[0].errors.some((e) => /platform/.test(e)));
    fs.rmSync(env.CONTENT_HOME, { recursive: true, force: true });
  } finally {
    trends.unregister('broken');
  }
});

test('normalizeReport FORCES trust_zone U even if an adapter tries to set otherwise', () => {
  const norm = source.normalizeReport(
    { period: { start: 'a', end: 'b' }, platform: 'twitter', topics: [{ topic: 't' }], provenance: { trust_zone: 'O', method: 'adapter' } },
    { cadence: '2h', nowMs: 0 },
  );
  assert.equal(norm.provenance.trust_zone, 'U', 'trust zone forced to U (model §8 defense in depth)');
  assert.ok(norm.freshness_window.expires_at, 'freshness window defaulted from cadence');
});
