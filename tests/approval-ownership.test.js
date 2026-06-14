'use strict';

/**
 * Approval-ownership + publish-edge gate tests for the publish executor
 * (engine/orchestrator/publish-executor.js; release-spec §16.1 pinned core; DD-17; model §2 invariant).
 *
 * The production approval-ownership suite pinned that exactly one component owns the approval append
 * (the listener) and the legacy bot / agent docs do not double-append. In the public engine that
 * concern collapses onto the executor's own publish-edge invariants — the single enforcement point
 * before any handoff:
 *   - the approver gate reads the DD-17 reviewers allowlist from config (no hardcoded approver id —
 *     a non-allowlisted approver, a missing approver, or a reviewer lacking `approve` rights all
 *     block the handoff);
 *   - the no_duplicate gate refuses a second publish of an already-published content id (the
 *     idempotency backstop against a double-append);
 *   - the test-content guard blocks any TEST- id from publishing.
 *
 * All ids are synthetic placeholders.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const executor = require('../engine/orchestrator/publish-executor.js');
const publishers = require('../engine/publishers/publisher.js');

const ALLOWED_REVIEWER = '00000000000000001';
const EDIT_ONLY_REVIEWER = '00000000000000002';
const STRANGER = '00000000000000099';

function ctxFor(reviewers, extraEntries = []) {
  return {
    env: { CONTENT_HOME: '/tmp/does-not-matter-gates-are-pure' },
    config: {
      reviewers,
      cooldown: { hard_days: 14, target_days: 30 },
      approval_surface: { channels: {} },
    },
    cooldownHardDays: 14,
    usageRecords: [],
    entries: extraEntries,
  };
}

function entry(fields) {
  return { header: fields.content_id, fields: { state: 'approved', ...fields } };
}

// Ensure a publisher named 'postiz' is registered so publisher_registered passes in these tests.
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

test('approver gate passes only for an allowlisted reviewer with approve rights (DD-17)', () => {
  ensureStubPostiz();
  const reviewers = [
    { id: ALLOWED_REVIEWER, rights: ['approve', 'edit'] },
    { id: EDIT_ONLY_REVIEWER, rights: ['edit'] },
  ];
  const gates = executor.buildGates(ctxFor(reviewers));

  const allowed = gates.approver_allowlisted(entry({ content_id: 'c-allowed', mode: 'LIVE', approved_by: ALLOWED_REVIEWER }));
  assert.equal(allowed.ok, true, 'allowlisted approver with approve rights passes');

  const editOnly = gates.approver_allowlisted(entry({ content_id: 'c-edit', mode: 'LIVE', approved_by: EDIT_ONLY_REVIEWER }));
  assert.equal(editOnly.ok, false, 'a reviewer with only edit rights cannot approve a publish');
  assert.match(editOnly.reason, /approve rights/u);

  const stranger = gates.approver_allowlisted(entry({ content_id: 'c-stranger', mode: 'LIVE', approved_by: STRANGER }));
  assert.equal(stranger.ok, false, 'a non-allowlisted approver is rejected');
  assert.match(stranger.reason, /not on the reviewers allowlist/u);

  const none = gates.approver_allowlisted(entry({ content_id: 'c-none', mode: 'LIVE', approved_by: '' }));
  assert.equal(none.ok, false, 'an entry with no recorded approver is rejected (model §2 invariant)');
});

test('approver gate fails closed when the allowlist is empty (no hardcoded approver)', () => {
  const gates = executor.buildGates(ctxFor([]));
  const r = gates.approver_allowlisted(entry({ content_id: 'c1', mode: 'LIVE', approved_by: ALLOWED_REVIEWER }));
  assert.equal(r.ok, false, 'empty allowlist ⇒ no approver passes (fail-closed, no hardcoded id)');
});

test('no_duplicate blocks a second publish of an already-published content id', () => {
  const published = entry({ content_id: 'dup-1', mode: 'LIVE', state: 'published', approved_by: ALLOWED_REVIEWER });
  const candidate = entry({ content_id: 'dup-1', mode: 'LIVE', approved_by: ALLOWED_REVIEWER });
  const gates = executor.buildGates(ctxFor([{ id: ALLOWED_REVIEWER, rights: ['approve'] }], [published, candidate]));
  const r = gates.no_duplicate(candidate);
  assert.equal(r.ok, false, 'duplicate publish is refused (idempotency backstop)');
  assert.match(r.reason, /already published/u);
});

test('the mode ladder is a flow decision, NOT a gate failure (no false manual_review)', () => {
  // §8.3: a non-LIVE item must not publish, but that is the expected mode-ladder behavior — it is
  // handled in the run flow (the item is left in place), never as a publish-edge gate failure that
  // would falsely route a clean preview item to manual_review. So no mode gate exists in the set.
  const gates = executor.buildGates(ctxFor([{ id: ALLOWED_REVIEWER, rights: ['approve'] }]));
  assert.equal(typeof gates.mode_live, 'undefined', 'there is no mode gate — mode is a flow decision');
  // The crash-safety suite proves the flow leaves a LIVE_PREVIEW item in `approved`, not failed.
});

test('test-content guard blocks any TEST- id from publishing', () => {
  const gates = executor.buildGates(ctxFor([{ id: ALLOWED_REVIEWER, rights: ['approve'] }]));
  const r = gates.not_test_content(entry({ content_id: 'TEST-abc', mode: 'LIVE', approved_by: ALLOWED_REVIEWER }));
  assert.equal(r.ok, false);
  assert.equal(r.code, executor.CODE.TEST_PUBLISH_BLOCKED);

  // And the hard handoff guard throws regardless (no override).
  assert.throws(
    () => executor.assertNotTestPublish('TEST-abc', 'handoff', {}),
    (e) => e.code === executor.CODE.TEST_PUBLISH_BLOCKED,
  );
});
