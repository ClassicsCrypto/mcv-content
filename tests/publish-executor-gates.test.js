'use strict';

/**
 * tests/publish-executor-gates.test.js  [N net-new — P4-TEST / P4-COV-ORCH]
 *
 * Entry-point coverage for the publish executor's publish-edge GATE WALK (release-spec §16.1
 * "coverage MUST extend beyond shared/ to every entry point" — the executor publish-gate set is
 * the production coverage hole, gap §2.7 row 1; §14.1 layer-3 publish edge). It walks EVERY named
 * gate the executor builds (buildGates) with one failing fixture per gate plus the all-clear case,
 * so a gate silently dropping or inverting is caught.
 *
 * Gates are PURE (read the entry + ctx, return { ok, reason, code? } with no side effects), so they
 * are exercised directly via executor.buildGates(ctx) — no CONTENT_HOME, no network. (The end-to-end
 * flow through main() is characterized in executor-crash-safety + executor-cooldown-gate; the
 * approver + idempotency edges are pinned in tests/pinned/. This file is the per-gate enumeration.)
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const executor = require('../engine/orchestrator/publish-executor.js');
const publishers = require('../engine/publishers/publisher.js');

const ALLOWED = '00000000000000001';
const ASSET = 'media/acme/reused.png';

function ctxFor(over = {}) {
  return {
    env: { CONTENT_HOME: '/tmp/pure-gate-no-io' },
    config: { reviewers: [{ id: ALLOWED, rights: ['approve', 'edit'] }], cooldown: { hard_days: 14 }, approval_surface: { channels: {} } },
    cooldownHardDays: 14,
    usageRecords: [],
    entries: [],
    ...over,
  };
}
const entry = (fields) => ({ header: fields.content_id, fields: { state: 'approved', ...fields } });

function ensureStubPostiz() {
  if (!publishers.has('postiz')) {
    publishers.register('postiz', {
      name: 'postiz',
      async handoff() { return { external_ref: 'x', state: publishers.PUBLISH_STATE.HANDED_OFF }; },
      async verifyStatus() { return { state: publishers.PUBLISH_STATE.HANDED_OFF }; },
      async fetchMetrics() { return { supported: false, metrics: {} }; },
      capabilities() { return { name: 'postiz' }; },
    });
  }
}

test('buildGates exposes exactly the expected named publish-edge gate set', () => {
  const gates = executor.buildGates(ctxFor());
  assert.deepEqual(
    Object.keys(gates).sort(),
    ['approver_allowlisted', 'media_complete', 'media_cooldown', 'no_duplicate', 'not_test_content', 'publisher_registered'].sort(),
    'the full publish-edge gate set is present (a missing gate is a coverage/contract regression)',
  );
});

test('a fully clean entry passes EVERY publish-edge gate', () => {
  ensureStubPostiz();
  const gates = executor.buildGates(ctxFor());
  const e = entry({ content_id: 'acme-clean-01', platform: 'twitter', approved_by: ALLOWED });
  for (const [name, fn] of Object.entries(gates)) {
    assert.equal(fn(e).ok, true, `clean entry should pass ${name}: ${fn(e).reason}`);
  }
});

test('approver_allowlisted fails for a non-allowlisted approver (DD-17)', () => {
  const gates = executor.buildGates(ctxFor());
  const r = gates.approver_allowlisted(entry({ content_id: 'c1', approved_by: '00000000000000099' }));
  assert.equal(r.ok, false);
  assert.match(r.reason, /not on the reviewers allowlist/u);
});

test('media_complete fails for an item still pending real media (no placeholder publish)', () => {
  const gates = executor.buildGates(ctxFor());
  const r = gates.media_complete(entry({ content_id: 'c1', approved_by: ALLOWED, state: 'approved_pending_media' }));
  assert.equal(r.ok, false);
  assert.match(r.reason, /pending/i);
  // The hold_reason variant also trips it.
  assert.equal(gates.media_complete(entry({ content_id: 'c2', approved_by: ALLOWED, hold_reason: 'pending_media' })).ok, false);
});

test('media_cooldown fails for an asset inside its hard window (enforcement point 3, DD-14)', () => {
  const usedAt = new Date(Date.now() - 3 * 86400000).toISOString(); // 3 days ago — inside 14
  const ctx = ctxFor({ usageRecords: [{ asset_id: ASSET, content_id: 'prior-09', used_at: usedAt }] });
  const gates = executor.buildGates(ctx);
  const r = gates.media_cooldown(entry({ content_id: 'c-new', approved_by: ALLOWED, media_refs: ASSET }));
  assert.equal(r.ok, false);
  assert.equal(r.code, executor.CODE.MEDIA_COOLDOWN_BLOCKED);
  // Re-gating the SAME content item does not block on its own prior use.
  const self = gates.media_cooldown(entry({ content_id: 'prior-09', approved_by: ALLOWED, media_refs: ASSET }));
  assert.equal(self.ok, true, 'excludeContentId: an item never blocks itself');
});

test('publisher_registered fails when the platform binds to an unregistered adapter (§12.3 wiring)', () => {
  publishers.unregister(); // clear the registry
  const gates = executor.buildGates(ctxFor());
  const r = gates.publisher_registered(entry({ content_id: 'c1', approved_by: ALLOWED, platform: 'twitter' }));
  assert.equal(r.ok, false, 'no adapter registered ⇒ a precise wiring error, not a publish-time crash');
  assert.match(r.reason, /no publisher adapter registered/u);
  ensureStubPostiz(); // restore for other suites
});

test('not_test_content blocks any TEST- id from publishing (defense in depth)', () => {
  const gates = executor.buildGates(ctxFor());
  const r = gates.not_test_content(entry({ content_id: 'TEST-abc', approved_by: ALLOWED }));
  assert.equal(r.ok, false);
  assert.equal(r.code, executor.CODE.TEST_PUBLISH_BLOCKED);
});

test('no_duplicate refuses a second publish of an already-published content id (idempotency backstop)', () => {
  const published = entry({ content_id: 'dup-1', state: 'published', approved_by: ALLOWED });
  const candidate = entry({ content_id: 'dup-1', approved_by: ALLOWED });
  const gates = executor.buildGates(ctxFor({ entries: [published, candidate] }));
  const r = gates.no_duplicate(candidate);
  assert.equal(r.ok, false);
  assert.match(r.reason, /already published/u);
});
