'use strict';

/**
 * Publisher seam contract tests (release-spec §12.3; DD-10; the §16.2 pinned idempotent-publish
 * test, DR W#35). Runs both shipped adapters AND a stub against the four-method interface, and
 * asserts the two contract-critical invariants:
 *   1. handoff is idempotent by content_id — the same content_id MUST NOT double-post.
 *   2. verifyStatus is HONEST — an adapter whose backend cannot confirm a publish returns an
 *      UNVERIFIABLE state, never a fabricated `published` (the RD-7 cautionary contract that
 *      excludes TikTok from v1).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const publisher = require('../publisher.js');
const postiz = require('../postiz.js');
const giphy = require('../giphy.js');

const { PUBLISH_STATE, REQUIRED_METHODS } = publisher;

function makePackage(contentId, overrides = {}) {
  return {
    audit_header: {
      content_id: contentId,
      brand: 'acme-cosmos',
      platform: 'twitter',
      format: 'single',
      mode: 'LIVE',
      schedule_time: new Date(Date.now() + 3600_000).toISOString(),
      integration_ref: 'integration-0001',
      ...overrides,
    },
    recommended: { text: 'A synthetic recommended variant for the contract test.' },
    variant_a: { text: 'Variant A.' },
    variant_b: { text: 'Variant B.' },
  };
}

// A minimal in-memory stub adapter that records handoffs by content_id to prove the seam admits
// third-party adapters and to exercise the contract harness uniformly.
function makeStubAdapter() {
  const posts = new Map(); // content_id -> external_ref
  let seq = 0;
  return {
    name: 'stub',
    posts,
    async handoff(pkg) {
      const cid = pkg.audit_header.content_id;
      if (posts.has(cid)) {
        return { external_ref: posts.get(cid), state: PUBLISH_STATE.HANDED_OFF, idempotent_hit: true };
      }
      const ref = `stub-${++seq}`;
      posts.set(cid, ref);
      return { external_ref: ref, state: PUBLISH_STATE.HANDED_OFF, idempotent_hit: false };
    },
    async verifyStatus(ref) {
      // Honest: the stub backend cannot confirm a real publish.
      return ref ? { state: PUBLISH_STATE.UNVERIFIABLE, external_ref: ref } : { state: PUBLISH_STATE.UNVERIFIABLE, external_ref: null };
    },
    async fetchMetrics(ref, checkpoint) {
      return { supported: false, external_ref: ref, checkpoint, metrics: {} };
    },
    capabilities() {
      return { name: 'stub', draft_gate: true, direct_publish: false, platforms: ['stub'], media_types: [] };
    },
  };
}

test('shipped adapters self-register under their §11.3 names', () => {
  assert.ok(publisher.has('postiz'), 'postiz registered');
  assert.ok(publisher.has('giphy'), 'giphy registered');
  assert.equal(publisher.get('postiz'), postiz);
  assert.equal(publisher.get('giphy'), giphy);
});

test('every registered adapter satisfies the four-method §12.3 contract', () => {
  for (const name of ['postiz', 'giphy']) {
    const adapter = publisher.get(name);
    assert.deepEqual(publisher.missingMethods(adapter), [], `${name} implements all required methods`);
    for (const m of REQUIRED_METHODS) assert.equal(typeof adapter[m], 'function', `${name}.${m}`);
  }
});

test('register rejects a malformed adapter, naming the missing methods', () => {
  assert.throws(
    () => publisher.register('bad', { handoff() {} }),
    /verifyStatus|fetchMetrics|capabilities/,
  );
});

test('factory get() throws PublisherNotRegisteredError for an unknown adapter', () => {
  assert.throws(() => publisher.get('does-not-exist'), publisher.PublisherNotRegisteredError);
});

test('stub adapter: handoff is idempotent by content_id (no double-post — DR W#35)', async () => {
  const stub = makeStubAdapter();
  publisher.register('stub', stub);
  try {
    const pkg = makePackage('synthetic-001');
    const first = await stub.handoff(pkg);
    const second = await stub.handoff(pkg);
    assert.equal(first.external_ref, second.external_ref, 'same external_ref on re-handoff');
    assert.equal(second.idempotent_hit, true);
    assert.equal(stub.posts.size, 1, 'exactly one post created for the content_id');
  } finally {
    publisher.unregister('stub');
  }
});

test('Postiz handoff is idempotent: a retried/ambiguous handoff resolves to the SAME draft', async () => {
  // First handoff: the create response has no id, so the adapter looks the draft up.
  const created = { posts: [{}] }; // no id field
  const listing = {
    posts: [
      {
        id: 'draft-123',
        state: 'DRAFT',
        integration: { id: 'integration-0001' },
        publishDate: new Date(Date.now() + 3600_000).toISOString(),
        content: 'A synthetic recommended variant for the contract test.',
      },
    ],
  };
  function fakeFetch(url, opts) {
    const isList = String(url).includes('/public/v1/posts?');
    const payload = isList ? listing : created;
    return Promise.resolve({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: () => Promise.resolve(JSON.stringify(payload)),
    });
  }
  const env = { POSTIZ_API_KEY: 'k', CONTENT_HOME: '' };
  const pkg = makePackage('synthetic-002');
  const r1 = await postiz.handoff(pkg, { env, fetchImpl: fakeFetch });
  const r2 = await postiz.handoff(pkg, { env, fetchImpl: fakeFetch });
  assert.equal(r1.external_ref, 'draft-123');
  assert.equal(r2.external_ref, 'draft-123', 'second handoff resolves to the same draft id');
  assert.equal(r1.state, PUBLISH_STATE.HANDED_OFF);
  assert.equal(r1.type, 'draft', 'draft-by-default (the second gate)');
});

test('verifyStatus is honest: a still-draft post is handed_off, not published', async () => {
  function fakeFetch() {
    return Promise.resolve({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: () => Promise.resolve(JSON.stringify({ post: { state: 'DRAFT' } })),
    });
  }
  const env = { POSTIZ_API_KEY: 'k', CONTENT_HOME: '' };
  const res = await postiz.verifyStatus('draft-123', { env, fetchImpl: fakeFetch });
  assert.equal(res.state, PUBLISH_STATE.HANDED_OFF);
});

test('verifyStatus is honest: an uninterpretable backend state is UNVERIFIABLE, never published', async () => {
  // The RD-7 / TikTok cautionary contract: a backend that cannot confirm publish must NOT claim it.
  function fakeFetch() {
    return Promise.resolve({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: () => Promise.resolve(JSON.stringify({ post: { state: 'WAT' } })),
    });
  }
  const env = { POSTIZ_API_KEY: 'k', CONTENT_HOME: '' };
  const res = await postiz.verifyStatus('ref-x', { env, fetchImpl: fakeFetch });
  assert.equal(res.state, PUBLISH_STATE.UNVERIFIABLE);
  assert.notEqual(res.state, PUBLISH_STATE.PUBLISHED);
});

test('verifyStatus advances handed_off -> published only on a backend-confirmed live post', async () => {
  function fakeFetch() {
    return Promise.resolve({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: () =>
        Promise.resolve(JSON.stringify({ post: { state: 'PUBLISHED', url: 'https://x.example/p/1', publishedAt: '2026-06-14T00:00:00Z' } })),
    });
  }
  const env = { POSTIZ_API_KEY: 'k', CONTENT_HOME: '' };
  const res = await postiz.verifyStatus('ref-pub', { env, fetchImpl: fakeFetch });
  assert.equal(res.state, PUBLISH_STATE.PUBLISHED);
  assert.equal(res.post_url, 'https://x.example/p/1');
});
