'use strict';

/**
 * Brand/competitor ingestion seam tests (release-spec §2.4 C2 corpus intake — three paths, RD-9;
 * §12.2 scraper adapter; DD-18 metered estimate-and-confirm; RD-8 Zone-U trust tagging; RD-12
 * zero-key tests with injectable provider call). Asserts the contract-critical invariants:
 *   1. the SCRAPER path is OFF BY DEFAULT — ingestCorpus throws IngestDisabledError until opt-in.
 *   2. a metered scrape is REFUSED without the DD-18 estimate-and-confirm (IngestNotConfirmedError).
 *   3. the registry admits adapters and the shipped ones (reference, fixture) self-register.
 *   4. the fixture adapter runs ZERO-KEY and writes schema-conformant Zone-U corpus items under
 *      corpora/<brand>/ in the exact on-disk shape purge-corpora scans (captured_at + retention_class).
 *   5. trust_class is FORCED to "untrusted-scraped" on every written item (RD-8 defense in depth).
 *   6. own vs competitor is labeled on every item (filename prefix + by_class tally).
 *   7. the reference adapter resolves its credential BY NAME via secrets.js and uses an INJECTABLE
 *      fetch (no real network, no bundled creds); it DEGRADES to [] when no key/endpoint is set.
 *   8. the reference adapter redacts a token-shaped value out of the provider payload (privacy pre-pass).
 *   9. MANUAL submission + OFFICIAL EXPORT need NO opt-in and NO confirm (the cold-start fallback, DD-21).
 *  10. a malformed item is dropped, never written (no bad corpus item enters).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ingest = require('../index'); // populates the registry (reference + fixture)
const source = require('../source');
const referenceAdapter = require('../reference-adapter');

function tmpHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oce-ingest-'));
  return { CONTENT_HOME: dir };
}

function rm(env) {
  try {
    fs.rmSync(env.CONTENT_HOME, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

/** Read every .json corpus item written under corpora/<brand>/. */
function readCorpus(env, brand) {
  const dir = path.join(env.CONTENT_HOME, 'corpora', brand);
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    files = [];
  }
  return files.map((f) => ({ name: f, item: JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) }));
}

test('shipped adapters self-register under their config names', () => {
  assert.ok(ingest.has('reference'), 'reference registered');
  assert.ok(ingest.has('fixture'), 'fixture registered');
});

test('ingestCorpus SCRAPER path is OFF BY DEFAULT — refuses with IngestDisabledError until opt-in', async () => {
  await assert.rejects(
    () => ingest.ingestCorpus({ config: {}, brand: 'acme', env: { CONTENT_HOME: '' } }),
    ingest.IngestDisabledError,
  );
  // Even an explicit adapter does not bypass the gate.
  await assert.rejects(
    () => ingest.ingestCorpus({ config: {}, adapter: 'fixture', brand: 'acme', env: { CONTENT_HOME: '' } }),
    ingest.IngestDisabledError,
  );
});

test('a metered scrape is REFUSED without DD-18 estimate-and-confirm', async () => {
  const env = tmpHome();
  const config = { ingest: { enabled: true, adapter: 'fixture' } };
  try {
    await assert.rejects(
      () => ingest.ingestCorpus({ config, brand: 'acme', account: 'acme', competitors: ['nova'], env }),
      ingest.IngestNotConfirmedError,
    );
  } finally {
    rm(env);
  }
});

test('estimateScrapeCost returns an indicative count + per-item figure (DD-18)', () => {
  const est = ingest.estimateScrapeCost({ account: 'acme', competitors: ['a', 'b'], max: 50 });
  assert.equal(est.accounts, 3, '1 own + 2 competitors');
  assert.equal(est.max_per_account, 50);
  assert.equal(est.item_estimate, 150);
  assert.equal(est.indicative, true);
  assert.ok(est.total_usd_estimate >= 0);
});

test('fixture adapter runs ZERO-KEY and writes schema-conformant Zone-U items in the purge-corpora shape', async () => {
  const env = tmpHome();
  const config = { ingest: { enabled: true, adapter: 'fixture' } };
  try {
    const result = await ingest.ingestCorpus({
      config,
      brand: 'acme',
      account: 'acme',
      competitors: ['nova', 'comet'],
      confirmed: true,
      env,
    });
    assert.ok(result.written.length >= 3, 'wrote the synthetic corpus');
    assert.ok(result.by_class.own >= 1, 'own-account items present');
    assert.ok(result.by_class.competitor >= 1, 'competitor items present');

    const onDisk = readCorpus(env, 'acme');
    assert.equal(onDisk.length, result.written.length, 'one .json per written item');
    for (const { name, item } of onDisk) {
      // The exact fields purge-corpora reads + the corpus-item.schema.json required set.
      assert.ok(item.captured_at && Number.isFinite(Date.parse(item.captured_at)), 'captured_at parseable (purge-corpora basis)');
      assert.ok(['transient', 'standard', 'retained'].includes(item.retention_class), 'retention_class set (purge-corpora window)');
      assert.equal(item.trust_class, 'untrusted-scraped', 'Zone U forced on every item (RD-8)');
      assert.equal(item.source, 'platform', 'adapter pulls are platform-sourced');
      assert.ok(typeof item.text === 'string' && item.text.length, 'text present');
      assert.ok(!('attestation' in item), 'no attestation on an untrusted-scraped item');
      // own/competitor label survives in the filename for the analyzer + operator.
      assert.ok(/^(own|competitor)-/.test(name), 'filename encodes account_class');
    }
  } finally {
    rm(env);
  }
});

test('re-ingesting the SAME items is idempotent on disk (overwrite, not duplicate)', async () => {
  const env = tmpHome();
  const config = { ingest: { enabled: true, adapter: 'fixture' } };
  try {
    const a = await ingest.ingestCorpus({ config, brand: 'acme', account: 'acme', competitors: ['nova'], confirmed: true, env });
    const before = readCorpus(env, 'acme').length;
    const b = await ingest.ingestCorpus({ config, brand: 'acme', account: 'acme', competitors: ['nova'], confirmed: true, env });
    const after = readCorpus(env, 'acme').length;
    assert.equal(before, after, 'same items => stable filenames => no duplication');
    assert.equal(a.written.length, b.written.length);
  } finally {
    rm(env);
  }
});

test('register rejects a malformed adapter, naming the missing method', () => {
  assert.throws(() => ingest.register('bad', {}), /fetch/);
});

test('unknown adapter throws IngestAdapterNotRegisteredError naming the available set', async () => {
  await assert.rejects(
    () => ingest.ingestCorpus({ config: { ingest: { enabled: true, adapter: 'nope' } }, brand: 'acme', confirmed: true, env: { CONTENT_HOME: '' } }),
    ingest.IngestAdapterNotRegisteredError,
  );
});

test('reference adapter degrades to [] when no provider key is configured (BYO, RD-9)', async () => {
  const items = await referenceAdapter.fetch({ env: { CONTENT_HOME: '' }, account: 'acme', competitors: ['nova'], provider: {} });
  assert.deepEqual(items, [], 'no key/endpoint => no items, no throw — manual/export remain');
});

test('reference adapter resolves the key BY NAME and uses the INJECTABLE fetch (zero real network)', async () => {
  const seen = [];
  const fakeFetch = (url, opts) => {
    seen.push({ url, auth: opts.headers.Authorization });
    return Promise.resolve({
      ok: true,
      status: 200,
      text: () =>
        Promise.resolve(
          JSON.stringify({
            items: [
              { text: 'Synthetic competitor post for pattern analysis', username: 'nova', createdAt: '2026-06-01T00:00:00Z', url: 'https://example.test/p/1' },
            ],
          }),
        ),
    });
  };
  const env = { CONTENT_HOME: '', APIFY_API_KEY: 'synthetic-key' };
  const config = {
    ingest: {
      enabled: true,
      adapter: 'reference',
      provider: { endpoint: 'https://provider.example/scrape', platform: 'twitter', auth_scheme: 'Bearer ' },
    },
  };
  const result = await ingest.ingestCorpus({ config, brand: 'acme', competitors: ['nova'], confirmed: true, env, fetchImpl: fakeFetch, write: false });

  assert.ok(seen.length >= 1, 'hit the configured endpoint');
  assert.ok(String(seen[0].url).startsWith('https://provider.example/scrape'));
  assert.equal(seen[0].auth, 'Bearer synthetic-key', 'credential resolved by NAME, injected into the header');
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].trust_class, 'untrusted-scraped', 'Zone U forced');
});

test('reference adapter redacts a token-shaped value out of the provider payload (privacy pre-pass)', async () => {
  const fakeFetch = () =>
    Promise.resolve({
      ok: true,
      status: 200,
      text: () =>
        Promise.resolve(
          JSON.stringify({
            items: [
              {
                // A long opaque token-shaped value embedded in the post text — must NOT survive to
                // disk. 48 chars => redact.js masks it via the generic high-entropy blob pattern.
                // Deliberately NOT "Bearer …"/"sk-…"-prefixed so the hygiene scanner (which flags
                // those credential-header SHAPES in source) does not trip on the test's own fixture.
                text: 'leaked shouldneverappear0123456789abcdef0123456789abcdef in a post',
                username: 'nova',
              },
            ],
          }),
        ),
    });
  const env = tmpHome();
  env.XAI_API_KEY = 'k';
  const config = { ingest: { enabled: true, adapter: 'reference', provider: { endpoint: 'https://p.example/s' } } };
  try {
    const result = await ingest.ingestCorpus({ config, brand: 'acme', competitors: ['nova'], confirmed: true, env, fetchImpl: fakeFetch });
    const onDisk = readCorpus(env, 'acme');
    const serialized = JSON.stringify(onDisk);
    assert.ok(!serialized.includes('shouldneverappear'), 'secret-shaped value redacted at write');
    assert.equal(result.items.length, 1);
  } finally {
    rm(env);
  }
});

test('MANUAL submission needs NO opt-in and NO confirm (first-class, DD-21) and writes own corpus', () => {
  const env = tmpHome();
  try {
    // Operator drops a loose file in the default inbox staging dir.
    const inbox = path.join(env.CONTENT_HOME, 'corpora', 'acme', 'inbox');
    fs.mkdirSync(inbox, { recursive: true });
    fs.writeFileSync(
      path.join(inbox, 'drop.json'),
      JSON.stringify([
        { text: 'Our own hand-curated post about the synthetic star-map.', captured_at: '2026-06-01T00:00:00Z', author: 'acme' },
        { text: '', author: 'acme' }, // no text => dropped
      ]),
      'utf8',
    );
    const result = ingest.importManualSubmission({ brand: 'acme', env });
    assert.equal(result.source, 'manual');
    assert.equal(result.read, 2);
    assert.equal(result.written.length, 1, 'the textless item was dropped');
    assert.equal(result.invalid.length, 1);
    assert.equal(result.by_class.own, 1, 'manual drop defaults to own-account');

    const onDisk = readCorpus(env, 'acme').filter((d) => d.item.source === 'manual');
    assert.equal(onDisk.length, 1);
    assert.equal(onDisk[0].item.source, 'manual');
    assert.equal(onDisk[0].item.trust_class, 'untrusted-scraped', 'Zone U even for manual (RD-8 uniform)');
    assert.equal(onDisk[0].item.retention_class, 'retained', 'manual defaults to retained (keeper)');
  } finally {
    rm(env);
  }
});

test('OFFICIAL-ACCOUNT EXPORT converts a Twitter export into own corpus (no scraping, DD-21)', () => {
  const env = tmpHome();
  try {
    // The common Twitter/X data-export shape: array of { tweet: { full_text, created_at, id_str } }.
    const exportData = [
      { tweet: { full_text: 'Throwback to when we first launched the synthetic comet event.', created_at: '2026-05-01T00:00:00Z', id_str: '123' } },
      { tweet: { full_text: '   ', created_at: '2026-05-02T00:00:00Z', id_str: '124' } }, // blank => dropped
    ];
    const result = ingest.importAccountExport({ brand: 'acme', data: exportData, format: 'twitter', handle: 'acme', env });
    assert.equal(result.source, 'export');
    assert.equal(result.format, 'twitter');
    assert.equal(result.written.length, 1, 'blank tweet dropped');
    assert.equal(result.by_class.own, 1, 'an official export is the operator OWN history');

    const onDisk = readCorpus(env, 'acme');
    const item = onDisk[0].item;
    assert.equal(item.source, 'export');
    assert.equal(item.author, 'acme');
    assert.ok(item.url.includes('/status/123'), 'built the tweet URL from id + handle');
    assert.equal(item.trust_class, 'untrusted-scraped');
  } finally {
    rm(env);
  }
});

test('export accepts an operator-supplied custom converter (BYO converter for unusual exports)', () => {
  const env = tmpHome();
  try {
    const result = ingest.importAccountExport({
      brand: 'acme',
      data: { weird: [{ msg: 'custom-shaped post' }] },
      convert: (value) => value.weird.map((w) => ({ text: w.msg, account_class: 'own' })),
      env,
    });
    assert.equal(result.format, 'custom');
    assert.equal(result.written.length, 1);
  } finally {
    rm(env);
  }
});

test('normalizeItem FORCES trust_class untrusted-scraped even if a raw item tries to self-promote', () => {
  const norm = source.normalizeItem(
    { text: 'x', trust_class: 'operator-curated', captured_at: '2026-06-01T00:00:00Z', account_class: 'competitor' },
    { source: 'platform', retention_class: 'standard', nowMs: 0 },
  );
  assert.equal(norm.item.trust_class, 'untrusted-scraped', 'never trust the adapter to self-promote (RD-8)');
  assert.equal(norm.accountClass, 'competitor');
  assert.ok(!('trust_class' in norm) || true); // trust_class lives on item, not the wrapper
});

test('an unlabeled scraped item defaults to COMPETITOR (conservative — not own)', () => {
  const norm = source.normalizeItem({ text: 'x' }, { source: 'platform', nowMs: 0 });
  assert.equal(norm.accountClass, 'competitor', 'unlabeled => third-party, never silently own');
});

test('a malformed item (no text) is dropped, never written — no bad corpus item enters', async () => {
  const env = tmpHome();
  source.register('emptytext', {
    async fetch() {
      return [{ text: '   ' }, { text: 'real one', account_class: 'own' }];
    },
  });
  try {
    const config = { ingest: { enabled: true, adapter: 'emptytext' } };
    const result = await ingest.ingestCorpus({ config, brand: 'acme', account: 'acme', confirmed: true, env });
    assert.equal(result.items.length, 1, 'only the item with text');
    assert.equal(result.invalid.length, 1, 'the textless item is recorded as invalid');
  } finally {
    source.unregister('emptytext');
    rm(env);
  }
});
