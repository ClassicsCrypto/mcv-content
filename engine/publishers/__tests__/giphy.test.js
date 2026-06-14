'use strict';

/**
 * Tests for engine/publishers/giphy.js — the platform-direct adapter (§12.3; RD-11; §4.5
 * fail-closed dual env-gate). The contract-critical behavior is that neither gate => dry-run,
 * one gate => BLOCKED (fail-closed), both gates => live. No network, no credentials: fetch and
 * env are injected.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const giphy = require('../giphy.js');
const { PUBLISH_STATE } = require('../publisher.js');
const { CredentialMissingError } = require('../../shared/secrets.js');

const I = giphy._internal;

function pkg(contentId, overrides = {}) {
  return {
    audit_header: {
      content_id: contentId,
      brand: 'acme-cosmos',
      platform: 'giphy',
      format: 'gif',
      source_image_url: 'https://cdn.example/animation.gif',
      tags: ['acme', 'cosmos'],
      ...overrides,
    },
  };
}

function okUpload(data) {
  return () => Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify({ data })) });
}

test('capabilities() declares platform-direct, no draft gate', () => {
  const cap = giphy.capabilities();
  assert.equal(cap.draft_gate, false);
  assert.equal(cap.direct_publish, true);
  assert.deepEqual(cap.platforms, ['giphy']);
});

test('neither env gate set => dry-run (validated, nothing live, no fetch call)', async () => {
  let called = false;
  const fetchImpl = () => {
    called = true;
    return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('{}') });
  };
  const res = await giphy.handoff(pkg('synthetic-020'), { env: { CONTENT_HOME: '' }, fetchImpl });
  assert.equal(res.dry_run, true);
  assert.equal(res.handed_off, false);
  assert.equal(res.state, PUBLISH_STATE.HANDED_OFF);
  assert.equal(called, false, 'no network call on a dry-run');
});

test('UPLOAD_LIVE without APPROVED_LIVE => BLOCKED (fail-closed), never uploads', async () => {
  let called = false;
  const fetchImpl = () => {
    called = true;
    return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('{}') });
  };
  await assert.rejects(
    () => giphy.handoff(pkg('synthetic-021'), { env: { CONTENT_HOME: '', GIPHY_UPLOAD_LIVE: '1' }, fetchImpl }),
    (err) => err.code === 'PLAT.GIPHY_LIVE_UNAPPROVED',
  );
  assert.equal(called, false, 'no upload attempted when only one gate is set');
});

test('both gates set + key => live upload, state published (Giphy has no draft)', async () => {
  const env = { CONTENT_HOME: '', GIPHY_API_KEY: 'gk', GIPHY_UPLOAD_LIVE: '1', GIPHY_APPROVED_LIVE: '1' };
  const res = await giphy.handoff(pkg('synthetic-022'), { env, fetchImpl: okUpload({ id: 'gif-99' }) });
  assert.equal(res.dry_run, false);
  assert.equal(res.handed_off, true);
  assert.equal(res.state, PUBLISH_STATE.PUBLISHED);
  assert.equal(res.external_ref, 'gif-99');
  assert.equal(res.post_url, 'https://giphy.com/gifs/gif-99');
});

test('both gates set but GIPHY_API_KEY missing => CredentialMissingError naming the variable', async () => {
  const env = { CONTENT_HOME: '', GIPHY_UPLOAD_LIVE: '1', GIPHY_APPROVED_LIVE: '1' };
  await assert.rejects(
    () => giphy.handoff(pkg('synthetic-023'), { env, fetchImpl: okUpload({ id: 'x' }) }),
    (err) => err instanceof CredentialMissingError && err.variable === 'GIPHY_API_KEY',
  );
});

test('options.live + options.confirmed_live are equivalent to the env gates', async () => {
  const env = { CONTENT_HOME: '', GIPHY_API_KEY: 'gk' };
  const res = await giphy.handoff(pkg('synthetic-024'), {
    env,
    fetchImpl: okUpload({ id: 'gif-7' }),
    live: true,
    confirmed_live: true,
  });
  assert.equal(res.state, PUBLISH_STATE.PUBLISHED);
});

test('validation: an upload with zero tags is rejected before any gate logic', async () => {
  await assert.rejects(
    () => giphy.handoff(pkg('synthetic-025', { tags: [] }), { env: { CONTENT_HOME: '' }, fetchImpl: okUpload({ id: 'x' }) }),
    (err) => err.code === 'PLAT.GIPHY_INVALID',
  );
});

test('ENGINE_TEST_MODE=1 guard refuses any real upload', async () => {
  const env = { CONTENT_HOME: '', ENGINE_TEST_MODE: '1', GIPHY_API_KEY: 'gk', GIPHY_UPLOAD_LIVE: '1', GIPHY_APPROVED_LIVE: '1' };
  await assert.rejects(
    () => giphy.handoff(pkg('synthetic-026'), { env, fetchImpl: okUpload({ id: 'x' }) }),
    /ENGINE_TEST_MODE GUARD/,
  );
});

test('tag normalization: dedup case-insensitively, trim, cap at 20', () => {
  const tags = I.normalizeTags('Cat, cat,  Dog ,dog', []);
  assert.deepEqual(tags, ['Cat', 'Dog']);
  const many = I.normalizeTags(Array.from({ length: 30 }, (_, i) => `t${i}`), []);
  assert.equal(many.length, I.MAX_TAGS);
});

test('username @-strip', () => {
  assert.equal(I.normalizeUsername('@acme'), 'acme');
  assert.equal(I.normalizeUsername('acme'), 'acme');
});

test('verifyStatus: a resolvable gif id is published; unknown is not_found', async () => {
  const env = { CONTENT_HOME: '', GIPHY_API_KEY: 'gk' };
  const found = await giphy.verifyStatus('gif-99', {
    env,
    fetchImpl: () => Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify({ data: { id: 'gif-99', url: 'https://giphy.com/gifs/gif-99' } })) }),
  });
  assert.equal(found.state, PUBLISH_STATE.PUBLISHED);
  const missing = await giphy.verifyStatus('gif-x', {
    env,
    fetchImpl: () => Promise.resolve({ ok: false, status: 404, text: () => Promise.resolve(JSON.stringify({ meta: { status: 404 } })) }),
  });
  assert.equal(missing.state, PUBLISH_STATE.NOT_FOUND);
});

test('fetchMetrics is honestly declared unsupported for Giphy', async () => {
  const res = await giphy.fetchMetrics('gif-99', '24h');
  assert.equal(res.supported, false);
  assert.deepEqual(res.metrics, {});
});
