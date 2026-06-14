'use strict';

/**
 * tests/components-v2.test.js  [E — adapted from the co-located characterization suite]
 *
 * Characterization tests for engine/shared/components-v2.js (release-spec §7.5 card /
 * §12.4 approval-surface abstraction; §16 test layer).
 *
 * Pins:
 *   A. component-tree walker behavior (the readback executable spec),
 *   B. renderDiscord emits exactly the component types the readback walker gates on,
 *   C. message payload + CV2 flag,
 *   D. the bounded approval-action row (surface-neutral verbs → controls),
 *   E. element-builder on-wire shapes,
 *   F. buildCard surface-neutral normalization/validation,
 *   G. surface separability — the neutral card carries NO Discord/channel/emoji detail.
 *
 * All ids are synthetic; the placeholder brand is "Acme Cosmos". No real snowflake ids.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const cv2 = require('../engine/shared/components-v2.js');

// A representative CV2 tree: container(17) > [ text(10), mediaGallery(12, 2 items),
// text with the Content ID, the approval row(1) > buttons(2), and a nested `.children`
// node to exercise the defensive recursion branch ].
function fixture() {
  return [{
    type: 17,
    components: [
      { type: 10, content: 'Acme Cosmos daily — three lines of hook.' },
      { type: 12, items: [{ media: { url: 'https://cdn.example/x/a.png' } }, { media: { url: 'https://cdn.example/x/b.png' } }] },
      { type: 10, content: 'Content ID: 2026-05-15-acme-thu-01\nRecommended variant text.' },
      cv2.buildApprovalRow('2026-05-15-acme-thu-01'),
      { type: 99, children: [{ type: 10, text: 'nested via children' }] },
    ],
  }];
}

// A schema-conformant neutral card for the builder/render tests.
function neutralCard(over = {}) {
  return {
    content_id: '2026-05-15-acme-thu-01',
    title: 'Content preview',
    brand: 'acme-cosmos',
    platform: 'x',
    format: 'single',
    variants: [
      { label: 'a', text: 'Variant A copy', score: 88, delta: -4 },
      { label: 'recommended', text: 'Recommended copy', score: 92, delta: 0, rationale: 'strongest room texture' },
      { label: 'b', text: 'Variant B copy', score: 85, delta: -7 },
    ],
    provenance: 'Built from a manual-submission brief; concrete community proof.',
    ...over,
  };
}

// ---- A. Walker behavior ----

test('countTypes keys by type_<n> and recurses components + children', () => {
  const counts = cv2.countTypes(fixture());
  assert.equal(counts.type_17, 1);
  assert.equal(counts.type_10, 3); // 2 top-level + 1 nested via children
  assert.equal(counts.type_12, 1);
  assert.equal(counts.type_1, 1);
  assert.equal(counts.type_2, 6); // full default action set
});

test('collectButtons returns the full action set incl. disabled flag', () => {
  const buttons = cv2.collectButtons(fixture());
  assert.equal(buttons.length, 6);
  assert.ok(buttons.every((b) => 'disabled' in b && b.disabled === false));
  // canonical order: success, primary, primary, secondary(edit), secondary(attach), danger
  assert.deepEqual(buttons.map((b) => b.style), [3, 1, 1, 2, 2, 4]);
});

test('collectMediaUrls dedups and reads items[].media.url + direct media.url', () => {
  const tree = [{ type: 12, items: [{ media: { url: 'u1' } }, { media: { url: 'u1' } }, { url: 'u2' }] },
    { type: 11, media: { url: 'u3' } }];
  assert.deepEqual(cv2.collectMediaUrls(tree), ['u1', 'u2', 'u3']);
});

test('findContentId reads content/text only — NOT button labels', () => {
  assert.equal(cv2.findContentId(fixture()), '2026-05-15-acme-thu-01');
  // ID only in a button label must NOT be matched (canonical scoping).
  const labelOnly = [{ type: 1, components: [{ type: 2, label: 'Content ID: should-not-match' }] }];
  assert.equal(cv2.findContentId(labelOnly), null);
});

test('extractText joins content/text/label/description', () => {
  const tree = [{ type: 10, content: 'C' }, { type: 2, label: 'L' }, { type: 10, text: 'T', description: 'D' }];
  assert.equal(cv2.extractText(tree), 'C\nL\nT\nD');
});

test('inferFormatFromCounts classifies by type_12 / type_13', () => {
  assert.equal(cv2.inferFormatFromCounts({ type_12: 1 }), 'image_or_video');
  assert.equal(cv2.inferFormatFromCounts({ type_13: 1 }), 'thread');
  assert.equal(cv2.inferFormatFromCounts({ type_10: 4 }), 'text');
});

test('walkComponents visits every node depth-first across components + children', () => {
  const seen = [];
  cv2.walkComponents(fixture(), (c) => seen.push(c.type));
  assert.ok(seen.includes(17) && seen.includes(12) && seen.includes(2) && seen.includes(99));
  assert.equal(seen.filter((t) => t === 2).length, 6);
});

// ---- B. renderDiscord emits the walker-gated shape ----

test('renderDiscord (with media) emits 1 container + exactly 1 media gallery + the action row', () => {
  const card = cv2.buildCard(neutralCard({ media: [{ ref: 'media/acme/a.png', media_type: 'image' }] }));
  const components = cv2.renderDiscord(card, { mediaUrls: ['https://cdn.example/a.png'] });
  const counts = cv2.countTypes(components);
  assert.equal(counts.type_17, 1, 'one container');
  assert.equal(counts.type_12, 1, 'exactly one media gallery (the live gate)');
  assert.equal(cv2.inferFormatFromCounts(counts), 'image_or_video');
  // media present → attach_media dropped → 5 buttons
  assert.equal(cv2.collectButtons(components).length, 5);
  assert.equal(cv2.findContentId(components), '2026-05-15-acme-thu-01');
});

test('renderDiscord (text-only) emits a container, no media gallery, the full action row', () => {
  const card = cv2.buildCard(neutralCard());
  const components = cv2.renderDiscord(card);
  const counts = cv2.countTypes(components);
  assert.equal(counts.type_17, 1);
  assert.equal(counts.type_12 || 0, 0, 'no media gallery for a text card');
  assert.equal(cv2.inferFormatFromCounts(counts), 'text');
  assert.equal(cv2.collectButtons(components).length, 6); // attach_media offered
  assert.equal(cv2.findContentId(components), '2026-05-15-acme-thu-01');
});

test('renderDiscord renders all three variants strongest-first', () => {
  const card = cv2.buildCard(neutralCard());
  const text = cv2.extractText(cv2.renderDiscord(card));
  assert.ok(text.indexOf('Recommended copy') < text.indexOf('Variant A copy'));
  assert.ok(text.indexOf('Variant A copy') < text.indexOf('Variant B copy'));
});

test('renderDiscord surfaces warnings as a card block', () => {
  const card = cv2.buildCard(neutralCard({
    warnings: [{ code: 'FM.UNVERIFIED_CAUSAL', family: 'FM', explanation: 'advisory causal claim', bars_recommended: true }],
  }));
  const text = cv2.extractText(cv2.renderDiscord(card));
  assert.match(text, /Warnings:/u);
  assert.match(text, /FM\.UNVERIFIED_CAUSAL/u);
  assert.match(text, /bars Recommended/u);
});

// ---- C. Payload + flag ----

test('renderDiscordPayload sets the V2 flag, empty allowed_mentions, top-level container', () => {
  const payload = cv2.renderDiscordPayload(cv2.buildCard(neutralCard()));
  assert.equal(payload.flags, 32768);
  assert.equal(cv2.FLAGS_IS_COMPONENTS_V2, 32768);
  assert.deepEqual(payload.allowed_mentions, { parse: [] });
  assert.equal(payload.components[0].type, 17);
});

// ---- D. Approval-row contract (surface-neutral verbs → controls) ----

test('buildApprovalRow produces the bounded action custom_ids with canonical styles', () => {
  const row = cv2.buildApprovalRow('XYZ');
  assert.equal(row.type, 1);
  assert.deepEqual(row.components.map((b) => b.custom_id), [
    'oce-approval:approve:recommended:XYZ',
    'oce-approval:approve:a:XYZ',
    'oce-approval:approve:b:XYZ',
    'oce-approval:edit:XYZ',
    'oce-approval:attach_media:XYZ',
    'oce-approval:reject:XYZ',
  ]);
  assert.deepEqual(row.components.map((b) => b.style), [3, 1, 1, 2, 2, 4]);
  assert.equal(cv2.buttonCustomId('XYZ', 'edit'), 'oce-approval:edit:XYZ');
});

test('buildApprovalRow honors a bounded subset of actions in canonical order', () => {
  const row = cv2.buildApprovalRow('ID', ['reject', 'approve_recommended', 'edit']);
  assert.deepEqual(row.components.map((b) => b.custom_id), [
    'oce-approval:approve:recommended:ID',
    'oce-approval:edit:ID',
    'oce-approval:reject:ID',
  ]);
});

test('customIdForAction maps each schema verb to its control id', () => {
  assert.equal(cv2.customIdForAction('ID', 'approve_recommended'), 'oce-approval:approve:recommended:ID');
  assert.equal(cv2.customIdForAction('ID', 'approve_a'), 'oce-approval:approve:a:ID');
  assert.equal(cv2.customIdForAction('ID', 'approve_b'), 'oce-approval:approve:b:ID');
  assert.equal(cv2.customIdForAction('ID', 'attach_media'), 'oce-approval:attach_media:ID');
  assert.equal(cv2.customIdForAction('ID', 'reject'), 'oce-approval:reject:ID');
});

// ---- E. Element-builder shapes ----

test('element builders produce the exact on-wire shapes', () => {
  assert.deepEqual(cv2.mediaGallery(['u']), { type: 12, items: [{ media: { url: 'u' } }] });
  assert.deepEqual(cv2.separator(), { type: 14 });
  assert.deepEqual(cv2.textDisplay('hi'), { type: 10, content: 'hi' });
  assert.deepEqual(cv2.container([]), { type: 17, components: [] });
  assert.deepEqual(cv2.thumbnail('u'), { type: 11, media: { url: 'u' } });
  assert.deepEqual(cv2.linkButton('go', 'https://x.example'), { type: 2, style: 5, label: 'go', url: 'https://x.example' });
  // button() omits empty fields and only sets disabled when true
  assert.deepEqual(cv2.button({ style: 1, label: 'L', customId: 'c' }), { type: 2, style: 1, label: 'L', custom_id: 'c' });
  assert.deepEqual(cv2.button({ style: 4, label: 'X', customId: 'c', disabled: true }), { type: 2, style: 4, label: 'X', custom_id: 'c', disabled: true });
});

// ---- F. buildCard surface-neutral normalization/validation ----

test('buildCard ranks variants strongest-first regardless of input order', () => {
  const card = cv2.buildCard(neutralCard());
  assert.deepEqual(card.variants.map((v) => v.label), ['recommended', 'a', 'b']);
});

test('buildCard defaults actions by media presence and bounds them to the schema set', () => {
  assert.deepEqual(cv2.buildCard(neutralCard()).actions,
    ['approve_recommended', 'approve_a', 'approve_b', 'edit', 'attach_media', 'reject']);
  assert.deepEqual(cv2.buildCard(neutralCard({ media: [{ ref: 'media/a.png' }] })).actions,
    ['approve_recommended', 'approve_a', 'approve_b', 'edit', 'reject']);
  // explicit actions are filtered to the enum + canonical order
  assert.deepEqual(cv2.buildCard(neutralCard({ actions: ['reject', 'bogus', 'approve_recommended'] })).actions,
    ['approve_recommended', 'reject']);
});

test('buildCard requires content_id and at least one variant', () => {
  assert.throws(() => cv2.buildCard({ variants: [{ label: 'recommended', text: 'x' }] }), /content_id/u);
  assert.throws(() => cv2.buildCard({ content_id: 'x', variants: [] }), /variant/u);
});

test('buildCard rejects absolute / URL media refs (schema forbids them)', () => {
  assert.throws(() => cv2.buildCard(neutralCard({ media: [{ ref: 'D:/abs/a.png' }] })), /\$CONTENT_HOME-relative/u);
  assert.throws(() => cv2.buildCard(neutralCard({ media: [{ ref: '/abs/a.png' }] })), /\$CONTENT_HOME-relative/u);
  assert.throws(() => cv2.buildCard(neutralCard({ media: [{ ref: 'https://cdn.example/a.png' }] })), /\$CONTENT_HOME-relative/u);
  // a relative ref is accepted
  assert.equal(cv2.buildCard(neutralCard({ media: [{ ref: 'media/acme/a.png' }] })).media[0].ref, 'media/acme/a.png');
});

test('buildCard normalizes status to the pending|decided|expired enum', () => {
  assert.equal(cv2.buildCard(neutralCard()).status, 'pending');
  assert.equal(cv2.buildCard(neutralCard({ status: 'decided' })).status, 'decided');
  assert.equal(cv2.buildCard(neutralCard({ status: 'nonsense' })).status, 'pending');
});

test('buildCard output is frozen and carries optional passthrough fields', () => {
  const card = cv2.buildCard(neutralCard({ scheduled_time: '2026-05-15T14:00:00Z', ttl: 'PT24H', package_ref: 'packages/p.json' }));
  assert.ok(Object.isFrozen(card));
  assert.equal(card.scheduled_time, '2026-05-15T14:00:00Z');
  assert.equal(card.ttl, 'PT24H');
  assert.equal(card.package_ref, 'packages/p.json');
});

// ---- G. Surface separability (the §12.4 contract) ----

test('the neutral card holds NO Discord/channel/emoji/component detail', () => {
  const card = cv2.buildCard(neutralCard({ media: [{ ref: 'media/a.png' }] }));
  const json = JSON.stringify(card);
  assert.doesNotMatch(json, /type_1[027]|custom_id|allowed_mentions|32768|oce-approval|✅|🅰️/u);
  // it carries only the schema fields
  for (const k of Object.keys(card)) {
    assert.ok([
      'content_id', 'title', 'brand', 'platform', 'format', 'content_form', 'variants',
      'media', 'warnings', 'actions', 'status', 'scheduled_time', 'provenance', 'ttl',
      'expires_at', 'package_ref', 'created_at',
    ].includes(k), `unexpected neutral-card field: ${k}`);
  }
});
