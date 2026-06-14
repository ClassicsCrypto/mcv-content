'use strict';

/**
 * Tests for engine/surfaces/discord/discord-adapter.js — the Discord reference approval surface
 * (release-spec §12.4 surface abstraction, DD-10). These exercise the TRANSLATION seam (Discord
 * control → neutral interaction) without a live client: discord.js is required lazily inside
 * connect(), so the module + its normalizers load with no client dependency installed.
 *
 * node:test + node:assert only — zero external deps, zero keys, zero network.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const adapter = require('../discord-adapter.js');
const cv2 = require('../../../shared/components-v2.js');

// ── Emoji → action (reference detail; the action verb is the load-bearing contract) ─────────

test('actionForEmoji maps every canonical reaction emoji to its action verb', () => {
  for (const [action, emoji] of Object.entries(cv2.REACTION_EMOJI)) {
    assert.equal(adapter.actionForEmoji(emoji), action, `emoji for ${action}`);
  }
});

test('actionForEmoji is robust to the variation selector (🅰️ vs 🅰)', () => {
  assert.equal(adapter.actionForEmoji('\u{1F170}️'), 'approve_a');
  assert.equal(adapter.actionForEmoji('\u{1F170}'), 'approve_a');
});

test('actionForEmoji returns null for an unrecognized emoji', () => {
  assert.equal(adapter.actionForEmoji('🎉'), null);
});

// ── Custom-id parse (shared components-v2 namespace) ────────────────────────────────────────

test('parseApprovalCustomId decodes approve verbs with their variant slot', () => {
  assert.deepEqual(adapter.parseApprovalCustomId('oce-approval:approve:recommended:2026-06-14-acme-01'), {
    action: 'approve_recommended', selected_variant: 'recommended', content_id: '2026-06-14-acme-01',
  });
  assert.deepEqual(adapter.parseApprovalCustomId('oce-approval:approve:a:2026-06-14-acme-01'), {
    action: 'approve_a', selected_variant: 'a', content_id: '2026-06-14-acme-01',
  });
  assert.deepEqual(adapter.parseApprovalCustomId('oce-approval:approve:b:2026-06-14-acme-01'), {
    action: 'approve_b', selected_variant: 'b', content_id: '2026-06-14-acme-01',
  });
});

test('parseApprovalCustomId decodes non-approve verbs without a variant slot', () => {
  assert.deepEqual(adapter.parseApprovalCustomId('oce-approval:reject:2026-06-14-acme-01'), {
    action: 'reject', content_id: '2026-06-14-acme-01',
  });
  assert.deepEqual(adapter.parseApprovalCustomId('oce-approval:edit:2026-06-14-acme-01'), {
    action: 'edit', content_id: '2026-06-14-acme-01',
  });
});

test('parseApprovalCustomId ignores a foreign namespace or an unknown verb', () => {
  assert.equal(adapter.parseApprovalCustomId('other-ns:approve:a:x'), null);
  assert.equal(adapter.parseApprovalCustomId('oce-approval:detonate:x'), null);
  assert.equal(adapter.parseApprovalCustomId(''), null);
});

test('the custom-id parse round-trips the components-v2 builder', () => {
  const id = cv2.customIdForAction('2026-06-14-acme-01', 'approve_b');
  assert.deepEqual(adapter.parseApprovalCustomId(id), {
    action: 'approve_b', selected_variant: 'b', content_id: '2026-06-14-acme-01',
  });
});

// ── Content-id recovery from a live card ────────────────────────────────────────────────────

test('resolveContentIdFromMessage recovers the id from a components-v2 card body', () => {
  const message = { components: [cv2.container([cv2.textDisplay('Content ID: 2026-06-14-acme-02')])] };
  assert.equal(adapter.resolveContentIdFromMessage(message), '2026-06-14-acme-02');
});

test('resolveContentIdFromMessage falls back to plain message content', () => {
  assert.equal(adapter.resolveContentIdFromMessage({ content: 'Content ID: 2026-06-14-acme-03' }), '2026-06-14-acme-03');
});

// ── Normalizers (Discord control → neutral interaction) ─────────────────────────────────────

test('normalizeReaction turns an approve emoji on a card into a neutral interaction', () => {
  const message = { id: '111', components: [cv2.container([cv2.textDisplay('Content ID: c-a')])] };
  const neutral = adapter.normalizeReaction({ emojiName: cv2.REACTION_EMOJI.approve_a, userId: 'rev-1', message });
  assert.deepEqual(neutral, {
    surface: 'discord', reviewer_id: 'rev-1', action: 'approve_a', content_id: 'c-a', card_ref: '111', selected_variant: 'a',
  });
});

test('normalizeReaction returns null for a non-approval emoji', () => {
  assert.equal(adapter.normalizeReaction({ emojiName: '🎉', userId: 'rev-1', message: { id: '1' } }), null);
});

test('normalizeButton uses the custom-id content id (authoritative) over the card body', () => {
  const message = { id: '222', components: [cv2.container([cv2.textDisplay('Content ID: from-body')])] };
  const neutral = adapter.normalizeButton({ customId: 'oce-approval:reject:from-customid', userId: 'rev-2', message });
  assert.equal(neutral.action, 'reject');
  assert.equal(neutral.content_id, 'from-customid');
  assert.equal(neutral.reviewer_id, 'rev-2');
  assert.equal(neutral.card_ref, '222');
});

test('normalizeButton returns null for an unrecognized control', () => {
  assert.equal(adapter.normalizeButton({ customId: 'something-else:click', userId: 'x', message: { id: '1' } }), null);
});

// ── Channel binding ─────────────────────────────────────────────────────────────────────────

test('reviewChannelId reads the configured content-review channel (no hardcoded snowflake)', () => {
  const config = { approval_surface: { channels: { 'content-review': 'CHAN-123' } } };
  assert.equal(adapter.reviewChannelId(config), 'CHAN-123');
  assert.equal(adapter.reviewChannelId({}), null);
});
