'use strict';

/**
 * Tests for engine/orchestrator/reaction-listener.js — the surface-neutral approval-decision
 * capture core (release-spec §16.1 entry-point coverage; §7.6 decision; DD-17 allowlist;
 * §14.5/DD-12 re-gate; §8.2 queue states).
 *
 * Zero-key, CONTENT_HOME-injected: every call passes a temp-dir env so the suite needs no real
 * instance and never touches a developer's $CONTENT_HOME, and the allowlist is supplied inline
 * (no live config file). node:test + node:assert only — no external test deps.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const listener = require('../engine/orchestrator/reaction-listener.js');
const queue = require('../engine/shared/queue.js');

function tmpEnv(extra = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oce-react-'));
  return { CONTENT_HOME: home, ...extra };
}

// A reviewer allowlist with one full-rights reviewer + one edit-only reviewer (DD-17 / §11.2).
const CONFIG = {
  reviewers: [
    { id: 'rev-full', name: 'Lead Reviewer', rights: ['approve', 'edit'] },
    { id: 'rev-edit', name: 'Copy Editor', rights: ['edit'] },
  ],
};

/** Three distinct, length-valid variants so the deterministic pre-gate passes clean. */
function cleanDraft(contentId) {
  return {
    content_id: contentId,
    variants: [
      { label: 'recommended', text: 'A genuinely fresh opener about deep space travel and what it costs to dream big.' },
      { label: 'a', text: 'Different angle entirely on orbital stations, gravity wells, and frontier living today.' },
      { label: 'b', text: 'Third distinct take exploring comets, telescopes, and the quiet patience of astronomers.' },
    ],
  };
}

function readQueueEntry(env, contentId) {
  const raw = fs.readFileSync(queue.queueFilePath(env), 'utf8');
  return queue.parseQueue(raw).find((e) => (e.fields.content_id || e.header) === contentId) || null;
}

// ── Authorization (DD-17) ──────────────────────────────────────────────────

test('approves an item when the reviewer is on the allowlist with approve rights', () => {
  const env = tmpEnv();
  const res = listener.processInteraction(
    { surface: 'discord', reviewer_id: 'rev-full', action: 'approve_recommended', content_id: 'c-1', card_ref: 'card-1', package_ref: 'workspaces/packager/c-1.md' },
    { env, config: CONFIG },
  );
  assert.equal(res.ok, true);
  assert.equal(res.outcome, listener.QUEUE_STATE.APPROVED);
  const entry = readQueueEntry(env, 'c-1');
  assert.equal(entry.fields.state, 'approved');
  assert.equal(entry.fields.approved_by, 'rev-full');
  assert.equal(entry.fields.approved_variant, 'recommended');
});

test('refuses a reviewer not on the allowlist (nothing recorded or queued)', () => {
  const env = tmpEnv();
  const res = listener.processInteraction(
    { surface: 'discord', reviewer_id: 'stranger', action: 'approve_recommended', content_id: 'c-2', card_ref: 'card-2' },
    { env, config: CONFIG },
  );
  assert.equal(res.ok, false);
  assert.equal(res.outcome, 'unauthorized');
  assert.equal(fs.existsSync(queue.queueFilePath(env)), false);
});

test('refuses an allowlisted reviewer lacking the right the action needs (edit-only cannot approve)', () => {
  const env = tmpEnv();
  const res = listener.processInteraction(
    { surface: 'discord', reviewer_id: 'rev-edit', action: 'approve_recommended', content_id: 'c-3', card_ref: 'card-3' },
    { env, config: CONFIG },
  );
  assert.equal(res.ok, false);
  assert.equal(res.outcome, 'unauthorized');
  assert.match(res.reason, /approve/);
});

test('an empty allowlist authorizes no one (fail-closed)', () => {
  const env = tmpEnv();
  const res = listener.processInteraction(
    { surface: 'discord', reviewer_id: 'rev-full', action: 'approve_recommended', content_id: 'c-4', card_ref: 'card-4' },
    { env, config: { reviewers: [] } },
  );
  assert.equal(res.outcome, 'unauthorized');
});

test('rightForAction: edit and attach_media require the edit right; approve/reject require approve', () => {
  assert.equal(listener.rightForAction('edit'), 'edit');
  assert.equal(listener.rightForAction('attach_media'), 'edit');
  assert.equal(listener.rightForAction('approve_a'), 'approve');
  assert.equal(listener.rightForAction('reject'), 'approve');
});

// ── §7.6 decision artifact shape ────────────────────────────────────────────

test('buildDecision conforms to the §7.6 required fields and action-conditional fields', () => {
  const env = tmpEnv();
  const approve = listener.buildDecision({ reviewer_id: 'rev-full', action: 'approve_a', content_id: 'c-5', card_ref: 'card-5' }, env);
  for (const k of ['card_ref', 'content_id', 'reviewer_id', 'timestamp', 'action']) {
    assert.ok(approve[k] != null, `decision missing required field ${k}`);
  }
  assert.equal(approve.selected_variant, 'a');

  const reject = listener.buildDecision({ reviewer_id: 'rev-full', action: 'reject', content_id: 'c-5', card_ref: 'card-5', rejection_reason: 'off-brand' }, env);
  assert.equal(reject.rejection_reason, 'off-brand');
  assert.equal(reject.selected_variant, undefined);

  const attach = listener.buildDecision({ reviewer_id: 'rev-full', action: 'attach_media', content_id: 'c-5', card_ref: 'card-5', attached_media_ref: 'library/media/x.png' }, env);
  assert.equal(attach.attached_media_ref, 'library/media/x.png');
});

// ── Reject path (audit trail, no publish) ───────────────────────────────────

test('reject records an attributed rejected queue entry (audit trail)', () => {
  const env = tmpEnv();
  const res = listener.processInteraction(
    { surface: 'discord', reviewer_id: 'rev-full', action: 'reject', content_id: 'c-6', card_ref: 'card-6', rejection_reason: 'tone' },
    { env, config: CONFIG },
  );
  assert.equal(res.ok, true);
  assert.equal(res.outcome, listener.QUEUE_STATE.REJECTED);
  const entry = readQueueEntry(env, 'c-6');
  assert.equal(entry.fields.state, 'rejected');
});

// ── Duplicate guard ─────────────────────────────────────────────────────────

test('refuses to re-queue an item already in a live post-approval state', () => {
  const env = tmpEnv();
  listener.processInteraction(
    { surface: 'discord', reviewer_id: 'rev-full', action: 'approve_recommended', content_id: 'c-7', card_ref: 'card-7' },
    { env, config: CONFIG },
  );
  const dup = listener.processInteraction(
    { surface: 'discord', reviewer_id: 'rev-full', action: 'approve_a', content_id: 'c-7', card_ref: 'card-7' },
    { env, config: CONFIG },
  );
  assert.equal(dup.ok, false);
  assert.equal(dup.outcome, 'duplicate');
  // Still exactly one entry for c-7.
  const raw = fs.readFileSync(queue.queueFilePath(env), 'utf8');
  const count = queue.parseQueue(raw).filter((e) => (e.fields.content_id || e.header) === 'c-7').length;
  assert.equal(count, 1);
});

// ── Dry-run (writes nothing) ────────────────────────────────────────────────

test('REACTION_LISTENER_DRY_RUN records the decision but writes no queue entry', () => {
  const env = tmpEnv({ REACTION_LISTENER_DRY_RUN: '1' });
  const res = listener.processInteraction(
    { surface: 'discord', reviewer_id: 'rev-full', action: 'approve_recommended', content_id: 'c-8', card_ref: 'card-8' },
    { env, config: CONFIG },
  );
  assert.equal(res.ok, true);
  assert.equal(fs.existsSync(queue.queueFilePath(env)), false);
});

test('opts.dryRun overrides the env flag', () => {
  const env = tmpEnv();
  const res = listener.processInteraction(
    { surface: 'discord', reviewer_id: 'rev-full', action: 'approve_recommended', content_id: 'c-8b', card_ref: 'card-8b' },
    { env, config: CONFIG, dryRun: true },
  );
  assert.equal(res.ok, true);
  assert.equal(fs.existsSync(queue.queueFilePath(env)), false);
});

// ── Edit-as-approval re-gate (DD-12 / §14.5) ────────────────────────────────

test('edit with a clean re-gate counts as approval → edited_approved', () => {
  const env = tmpEnv();
  const res = listener.processInteraction(
    { surface: 'discord', reviewer_id: 'rev-edit', action: 'edit', content_id: 'c-9', card_ref: 'card-9', edited_draft: cleanDraft('c-9'), edit_diff: 'tightened hook' },
    { env, config: CONFIG },
  );
  assert.equal(res.ok, true);
  assert.equal(res.outcome, listener.QUEUE_STATE.EDITED_APPROVED);
  assert.equal(readQueueEntry(env, 'c-9').fields.state, 'edited_approved');
});

test('edit whose re-gate FAILS returns the card with the reason and queues nothing (no silent publish/block)', () => {
  const env = tmpEnv();
  // Only two variants → VARIANT_COUNT hard fail in the deterministic pre-gate.
  const bad = { content_id: 'c-10', variants: [{ label: 'recommended', text: 'one' }, { label: 'a', text: 'two' }] };
  const res = listener.processInteraction(
    { surface: 'discord', reviewer_id: 'rev-edit', action: 'edit', content_id: 'c-10', card_ref: 'card-10', edited_draft: bad },
    { env, config: CONFIG },
  );
  assert.equal(res.ok, false);
  assert.equal(res.outcome, 're_gate_failed');
  assert.ok(res.reason && res.reason.length > 0);
  assert.equal(fs.existsSync(queue.queueFilePath(env)), false);
});

// ── Action vocabulary + content-id guards ───────────────────────────────────

test('an unknown action is ignored (not part of the bounded §7.5 set)', () => {
  const env = tmpEnv();
  const res = listener.processInteraction(
    { surface: 'discord', reviewer_id: 'rev-full', action: 'nuke', content_id: 'c-11' },
    { env, config: CONFIG },
  );
  assert.equal(res.outcome, 'ignored');
});

test('a missing content_id is invalid (cannot transition an unidentified item)', () => {
  const env = tmpEnv();
  const res = listener.processInteraction(
    { surface: 'discord', reviewer_id: 'rev-full', action: 'approve_recommended' },
    { env, config: CONFIG },
  );
  assert.equal(res.outcome, 'invalid');
});

test('exposes the public §8.2 queue-state vocabulary, not raw production state names', () => {
  assert.deepEqual(
    Object.values(listener.QUEUE_STATE).sort(),
    ['approved', 'approved_pending_media', 'edited_approved', 'rejected'].sort(),
  );
  // The retired production state name must not appear.
  assert.equal(Object.values(listener.QUEUE_STATE).includes('queued'), false);
});
