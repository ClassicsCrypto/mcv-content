'use strict';

/**
 * Tests for engine/publishers/postiz.js — the reference draft-by-default adapter (§12.3; §8.3
 * second gate; §15.1 credential fail-fast; §18.2 fail-closed test guard). Adapted from the
 * production postiz key-loader test, refocused on the seam contract. No network, no credentials:
 * fetch and env are injected.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const postiz = require('../postiz.js');
const { PUBLISH_STATE } = require('../publisher.js');
const { CredentialMissingError } = require('../../shared/secrets.js');

const I = postiz._internal;

function pkg(contentId, overrides = {}) {
  return {
    audit_header: {
      content_id: contentId,
      brand: 'acme-cosmos',
      platform: 'twitter',
      format: 'single',
      integration_ref: 'integration-0001',
      schedule_time: new Date(Date.now() + 3600_000).toISOString(),
      ...overrides,
    },
    recommended: { text: 'Hello from Acme Cosmos.' },
    variant_a: { text: 'A' },
    variant_b: { text: 'B' },
  };
}

function okFetch(payload) {
  return () =>
    Promise.resolve({ ok: true, status: 200, statusText: 'OK', text: () => Promise.resolve(JSON.stringify(payload)) });
}

test('capabilities() declares the draft gate (the second gate) and the RD-7 platform set', () => {
  const cap = postiz.capabilities();
  assert.equal(cap.draft_gate, true);
  assert.equal(cap.direct_publish, false);
  assert.deepEqual(cap.platforms, ['twitter', 'instagram', 'facebook', 'youtube']);
});

test('handoff creates a DRAFT by default and returns state handed_off', async () => {
  const env = { POSTIZ_API_KEY: 'k', CONTENT_HOME: '' };
  const res = await postiz.handoff(pkg('synthetic-010'), { env, fetchImpl: okFetch({ id: 'd1' }) });
  assert.equal(res.type, 'draft');
  assert.equal(res.state, PUBLISH_STATE.HANDED_OFF);
  assert.equal(res.external_ref, 'd1');
  assert.equal(res.auto_publish, false);
});

test('auto-publish requires BOTH POSTIZ_DRAFT_ONLY=0 and POSTIZ_AUTO_PUBLISH_ALLOWED=1', () => {
  assert.equal(I.autoPublishAllowed({}), false, 'default: draft-only');
  assert.equal(I.autoPublishAllowed({ POSTIZ_AUTO_PUBLISH_ALLOWED: '1' }), false, 'one opt-in is not enough');
  assert.equal(I.autoPublishAllowed({ POSTIZ_DRAFT_ONLY: '0' }), false, 'one opt-in is not enough');
  assert.equal(
    I.autoPublishAllowed({ POSTIZ_DRAFT_ONLY: '0', POSTIZ_AUTO_PUBLISH_ALLOWED: '1' }),
    true,
    'both opt-ins => auto-publish allowed',
  );
});

test('handoff with both auto-publish opt-ins creates a schedule post', async () => {
  const env = { POSTIZ_API_KEY: 'k', CONTENT_HOME: '', POSTIZ_DRAFT_ONLY: '0', POSTIZ_AUTO_PUBLISH_ALLOWED: '1' };
  const res = await postiz.handoff(pkg('synthetic-011'), { env, fetchImpl: okFetch({ id: 's1' }) });
  assert.equal(res.type, 'schedule');
  assert.equal(res.auto_publish, true);
});

test('missing POSTIZ_API_KEY fails fast with CredentialMissingError naming the variable', async () => {
  await assert.rejects(
    () => postiz.handoff(pkg('synthetic-012'), { env: { CONTENT_HOME: '' }, fetchImpl: okFetch({ id: 'x' }) }),
    (err) => err instanceof CredentialMissingError && err.variable === 'POSTIZ_API_KEY',
  );
});

test('handoff refuses without an integration_ref', async () => {
  const env = { POSTIZ_API_KEY: 'k', CONTENT_HOME: '' };
  await assert.rejects(
    () => postiz.handoff(pkg('synthetic-013', { integration_ref: undefined }), { env, fetchImpl: okFetch({ id: 'x' }) }),
    /integration_ref/,
  );
});

test('ENGINE_TEST_MODE=1 guard: refuses any real publish', async () => {
  const env = { POSTIZ_API_KEY: 'k', CONTENT_HOME: '', ENGINE_TEST_MODE: '1' };
  await assert.rejects(
    () => postiz.handoff(pkg('synthetic-014'), { env, fetchImpl: okFetch({ id: 'x' }) }),
    /ENGINE_TEST_MODE GUARD/,
  );
});

test('TEST--prefixed content_id can never reach a real publish path', () => {
  assert.throws(() => I.assertNotTestPublish('TEST-abc', 'createPostizDraft', {}), /ENGINE_TEST_MODE GUARD/);
  assert.doesNotThrow(() => I.assertNotTestPublish('synthetic-1', 'createPostizDraft', {}));
});

test('a definite HTTP error tags the error phase "post" (no draft created)', async () => {
  function failFetch() {
    return Promise.resolve({ ok: false, status: 422, statusText: 'Unprocessable', text: () => Promise.resolve('{"error":"bad"}') });
  }
  const env = { POSTIZ_API_KEY: 'k', CONTENT_HOME: '' };
  await assert.rejects(
    () => postiz.handoff(pkg('synthetic-015'), { env, fetchImpl: failFetch }),
    (err) => err.phase === 'post' && err.httpStatus === 422,
  );
});

test('thread copy with N/M markers splits into segments; plain copy is one post', () => {
  assert.equal(I.splitThreadCopy('just one tweet').length, 1);
  const thread = '1/2\nfirst part\n2/2\nsecond part';
  assert.equal(I.splitThreadCopy(thread).length, 2);
});

test('valuesFor attaches media to the first segment only', () => {
  const vals = I.valuesFor({ content_id: 'c', format: 'single' }, 'body', 'https://cdn.example/m.png');
  assert.equal(vals.length, 1);
  assert.equal(vals[0].image.length, 1);
});

test('draftDateFor uses a future schedule_time, else a near-future offset', () => {
  const future = new Date(Date.now() + 7200_000).toISOString();
  assert.equal(I.draftDateFor({ schedule_time: future }, 0), future);
  const past = new Date(Date.now() - 7200_000).toISOString();
  assert.notEqual(I.draftDateFor({ schedule_time: past }, 0), past);
});

test('resolveApiUrl defaults when POSTIZ_API_URL is unset', () => {
  assert.equal(I.resolveApiUrl({ CONTENT_HOME: '' }), 'https://api.postiz.com');
  assert.equal(I.resolveApiUrl({ CONTENT_HOME: '', POSTIZ_API_URL: 'https://postiz.local' }), 'https://postiz.local');
});

test('fetchMetrics rejects an unknown checkpoint', async () => {
  await assert.rejects(
    () => postiz.fetchMetrics('ref', 'bogus', { env: { POSTIZ_API_KEY: 'k', CONTENT_HOME: '' } }),
    /unknown analytics checkpoint/,
  );
});
