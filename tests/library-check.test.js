'use strict';

/**
 * tests/library-check.test.js  [A — NEW tests; closes gap §2.1 "scorer had zero tests"]
 *
 * Covers the §7.8 retrieval contract (engine/library/check.js): scoring + ranking, the
 * reuse/modify/generate decision ladder, the cooldown filter (enforcement point 1, §8.6),
 * risk codes, the retrieval-result output shape, and empty-library mode (DD-21). Tests inject
 * the index + ledger + clock so they are deterministic and need no real CONTENT_HOME.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const check = require('../engine/library/check.js');
const usageLog = require('../engine/library/usage-log.js');

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 0, 15);

/** A small synthetic, brand-neutral index (Acme Cosmos placeholders only). */
const INDEX = [
  {
    asset_id: 'media/cosmos/nebula-bridge.png',
    path: 'media/cosmos/nebula-bridge.png',
    type: 'image',
    source_class: 'library',
    description: 'a cozy spaceship bridge interior with warm ambient lighting',
    tags: ['spaceship', 'bridge', 'cozy', 'interior'],
  },
  {
    asset_id: 'media/cosmos/arena-clip.mp4',
    path: 'media/cosmos/arena-clip.mp4',
    type: 'video',
    source_class: 'library',
    description: 'a fast arena battle scene',
    tags: ['arena', 'battle', 'action'],
  },
  {
    asset_id: 'media/cosmos/logo-banner.png',
    path: 'media/cosmos/logo-banner.png',
    type: 'image',
    source_class: 'library',
    description: 'an announcement banner with visible event text',
    tags: ['banner', 'announcement'],
    has_visible_text: true,
  },
];

function run(query, options = {}) {
  return check.check(query, { index: INDEX, ledger: [], now: NOW, ...options });
}

test('query returns ranked candidates with the §7.8 result shape', () => {
  const result = run({ query: 'cozy spaceship bridge', media_type: 'image' });
  assert.ok(Array.isArray(result.candidates));
  assert.ok(result.candidates.length >= 1);
  assert.equal(typeof result.total_matches, 'number');
  assert.ok(result.decision && typeof result.decision.action === 'string');

  const top = result.candidates[0];
  assert.equal(top.asset_id, 'media/cosmos/nebula-bridge.png');
  assert.ok(top.score > 0 && top.score <= 1);
  assert.equal(typeof top.rationale, 'string');
  assert.ok(top.cooldown_status && typeof top.cooldown_status.cooldown_blocked === 'boolean');
  assert.ok(Array.isArray(top.risk_codes));
  // Internal-only fields must NOT leak into the emitted candidate.
  assert.ok(!('_overused' in top));
  assert.ok(!('_matched_terms' in top));
});

test('media_type filter excludes mismatched assets', () => {
  const result = run({ query: 'arena battle', media_type: 'video' });
  assert.ok(result.candidates.every((c) => c.asset_id.endsWith('.mp4')));
});

test('strong match with no edit flags decides REUSE', () => {
  // Query nearly all the describable tokens of the bridge asset to clear the reuse threshold.
  const result = run({ query: 'cozy spaceship bridge interior', tags: ['spaceship', 'bridge', 'cozy', 'interior'] });
  assert.equal(result.decision.action, 'reuse');
  assert.equal(result.decision.chosen_asset_id, 'media/cosmos/nebula-bridge.png');
});

test('mid-similarity match decides MODIFY (crop/edit before use)', () => {
  // A query that scores in the [0.6, 0.85) band (default thresholds) auto-flags
  // REQUIRES_MODIFICATION, so the ladder lands on modify rather than reuse.
  // "warm lighting": both description words, but NOT a contiguous phrase (description reads
  // "warm ambient lighting"), so no phrase bonus — the score lands in the modify band.
  const result = run({ query: 'warm lighting' });
  const top = result.candidates[0];
  assert.ok(top.score >= 0.6 && top.score < 0.85, `score ${top.score} should be in modify band`);
  assert.equal(result.decision.action, 'modify');
  assert.equal(result.decision.chosen_asset_id, 'media/cosmos/nebula-bridge.png');
});

test('visible-text asset flags REQUIRES_MODIFICATION and is not directly reused', () => {
  const result = run(
    { query: 'announcement banner event', tags: ['banner', 'announcement'] },
    { config: { reuseSimilarity: 0.01 } },
  );
  const banner = result.candidates.find((c) => c.asset_id === 'media/cosmos/logo-banner.png');
  assert.ok(banner.risk_codes.includes(check.RISK.REQUIRES_MODIFICATION));
  assert.ok(banner.reuse_requires_modification);
  // Even with a very low reuse threshold, the edit-required flag forces modify, never reuse.
  assert.notEqual(result.decision.action, 'reuse');
});

test('cooldown filter (enforcement point 1): a recently-used top match is skipped', () => {
  const ledger = [
    {
      asset_id: 'media/cosmos/nebula-bridge.png',
      content_id: 'prev-1',
      used_at: new Date(NOW - 3 * DAY).toISOString(),
    },
  ];
  // Strong query for the cooled asset; the only other matches are weak/none ⇒ generate.
  const { result, mediaDecision } = check.decideMedia(
    { query: 'cozy spaceship bridge interior' },
    { content_id: 'c-now' },
    { index: INDEX, ledger, now: NOW },
  );
  const bridge = result.candidates.find((c) => c.asset_id === 'media/cosmos/nebula-bridge.png');
  assert.equal(bridge.cooldown_status.cooldown_blocked, true);
  assert.ok(bridge.risk_codes.includes(check.RISK.COOLDOWN_BLOCKED));
  assert.equal(result.decision.action, 'generate');
  // The retrieval-result decision stays minimal; the cooled top candidate is recorded as a
  // skipped candidate in the media-decision record.
  assert.equal(mediaDecision.action, 'generate');
  const skipped = (mediaDecision.skipped_candidates || []).find((s) => s.asset_id === 'media/cosmos/nebula-bridge.png');
  assert.ok(skipped);
  assert.equal(skipped.reason, 'cooldown');
});

test('allow_cooldown_override lets an in-cooldown asset be selected for MODIFY', () => {
  const ledger = [
    {
      asset_id: 'media/cosmos/nebula-bridge.png',
      content_id: 'prev-1',
      used_at: new Date(NOW - 3 * DAY).toISOString(),
    },
  ];
  const { result, mediaDecision } = check.decideMedia(
    { query: 'cozy spaceship bridge interior' },
    { content_id: 'c-ovr' },
    { index: INDEX, ledger, now: NOW, allow_cooldown_override: true, config: { reuseSimilarity: 0.99, modifySimilarity: 0.05 } },
  );
  assert.equal(result.decision.action, 'modify');
  assert.equal(result.decision.chosen_asset_id, 'media/cosmos/nebula-bridge.png');
  // The override flag rides the media-decision cooldown_ref, not the minimal retrieval result.
  assert.equal(mediaDecision.cooldown_ref.override_applied, true);
});

test('never_reuse asset hard-blocks and falls through to generate', () => {
  const idx = [{ ...INDEX[0], reuse_mode: 'never_reuse' }];
  const result = check.check({ query: 'cozy spaceship bridge interior' }, { index: idx, ledger: [], now: NOW });
  const top = result.candidates[0];
  assert.ok(top.hard_blocks.includes(check.RISK.NEVER_REUSE));
  assert.equal(result.decision.action, 'generate');
});

test('skipped_candidates records higher-ranked items passed over', () => {
  const ledger = [
    {
      asset_id: 'media/cosmos/nebula-bridge.png',
      content_id: 'prev-1',
      used_at: new Date(NOW - 1 * DAY).toISOString(),
    },
  ];
  // Two assets match the query; the strongest (nebula-bridge, 4 tags + description) is cooled,
  // so the weaker cabin (fewer matching tokens) is selected and the bridge is recorded skipped.
  const idx = [
    INDEX[0],
    {
      asset_id: 'media/cosmos/cabin.png',
      path: 'media/cosmos/cabin.png',
      type: 'image',
      source_class: 'library',
      description: 'a small cabin',
      tags: ['cabin', 'interior'],
    },
  ];
  const { mediaDecision } = check.decideMedia(
    { query: 'cozy spaceship bridge interior cabin', tags: ['spaceship', 'bridge', 'cozy', 'interior', 'cabin'] },
    { content_id: 'c-skip' },
    { index: idx, ledger, now: NOW, config: { reuseSimilarity: 0.99, modifySimilarity: 0.01 } },
  );
  // The cooled top asset should appear in the media-decision's skipped_candidates as cooldown.
  assert.ok(mediaDecision.skipped_candidates);
  const skipped = mediaDecision.skipped_candidates.find((s) => s.asset_id === 'media/cosmos/nebula-bridge.png');
  assert.ok(skipped);
  assert.equal(skipped.reason, 'cooldown');
});

test('empty-library mode (DD-21): no index ⇒ generate-only, never throws', () => {
  const result = check.check({ query: 'anything at all' }, { index: [], ledger: [], now: NOW });
  assert.equal(result.decision.action, 'generate');
  assert.equal(result.decision.reason, 'No matching assets in library.');
  assert.deepEqual(result.candidates, []);
  assert.equal(result.total_matches, 0);
});

test('loadIndex returns empty assets for a missing index (no throw)', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const env = { CONTENT_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'oce-idx-')) };
  assert.deepEqual(check.loadIndex(env), { assets: [] });
});

test('no query tokens ⇒ no candidates, generate decision', () => {
  const result = run({});
  assert.deepEqual(result.candidates, []);
  assert.equal(result.decision.action, 'generate');
});

test('cooldown round-trip: record a use, then retrieval blocks the same asset (§16.2)', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const env = { CONTENT_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'oce-rt-')) };

  // Confirmed publish writes the canonical ledger...
  usageLog.recordUse({ asset_id: 'media/cosmos/nebula-bridge.png', content_id: 'c-1' }, { env });
  // ...then retrieval (reading the same ledger via CONTENT_HOME) refuses direct reuse.
  const result = check.check({ query: 'cozy spaceship bridge interior' }, { index: INDEX, env });
  const bridge = result.candidates.find((c) => c.asset_id === 'media/cosmos/nebula-bridge.png');
  assert.equal(bridge.cooldown_status.cooldown_blocked, true);
  assert.equal(result.decision.action, 'generate');
});

// Minimal JSON-Schema (draft 2020-12 subset) validator: type / required / enum /
// additionalProperties:false / properties / items / min-max. Enough to prove the emitted
// shapes obey the schema's strict object contracts without adding a dependency.
function validate(schema, data, where = '$') {
  const t = schema.type;
  const isType = (ty) => {
    if (ty === 'object') return data && typeof data === 'object' && !Array.isArray(data);
    if (ty === 'array') return Array.isArray(data);
    if (ty === 'integer') return Number.isInteger(data);
    if (ty === 'number') return typeof data === 'number';
    if (ty === 'string') return typeof data === 'string';
    if (ty === 'boolean') return typeof data === 'boolean';
    if (ty === 'null') return data === null;
    return true;
  };
  if (t) {
    const types = Array.isArray(t) ? t : [t];
    assert.ok(types.some(isType), `${where}: type ${JSON.stringify(t)} (got ${JSON.stringify(data)})`);
  }
  if (schema.enum) assert.ok(schema.enum.includes(data), `${where}: ${data} not in enum`);
  if (typeof data === 'number') {
    if (schema.minimum != null) assert.ok(data >= schema.minimum, `${where}: < min`);
    if (schema.maximum != null) assert.ok(data <= schema.maximum, `${where}: > max`);
  }
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    for (const req of schema.required || []) assert.ok(req in data, `${where}: missing required ${req}`);
    const props = schema.properties || {};
    if (schema.additionalProperties === false) {
      for (const k of Object.keys(data)) assert.ok(k in props, `${where}: extra property ${k}`);
    }
    for (const [k, v] of Object.entries(data)) {
      if (props[k]) validate(props[k], v, `${where}.${k}`);
    }
  }
  if (Array.isArray(data) && schema.items) {
    data.forEach((el, i) => validate(schema.items, el, `${where}[${i}]`));
  }
}

test('check() output validates against retrieval-result.schema.json (strict)', () => {
  const schema = require('../schemas/artifacts/retrieval-result.schema.json');
  const ledger = [
    { asset_id: 'media/cosmos/nebula-bridge.png', content_id: 'p', used_at: new Date(NOW - 2 * DAY).toISOString() },
  ];
  for (const q of [
    { query: 'cozy spaceship bridge interior', tags: ['bridge'], brand: 'acme-cosmos', media_type: 'image' },
    { query: 'arena battle', media_type: 'video' },
    { query: 'nothing matches xyzzy' },
  ]) {
    const result = check.check(q, { index: INDEX, ledger, now: NOW });
    validate(schema, result, 'retrieval-result');
  }
});

test('buildMediaDecision output validates against media-decision.schema.json (strict)', () => {
  const schema = require('../schemas/artifacts/media-decision.schema.json');
  const ledger = [
    { asset_id: 'media/cosmos/nebula-bridge.png', content_id: 'p', used_at: new Date(NOW - 2 * DAY).toISOString() },
  ];
  const { mediaDecision } = check.decideMedia(
    { query: 'cozy spaceship bridge interior cabin', tags: ['spaceship', 'bridge'], media_type: 'image' },
    { content_id: 'c-md', brand: 'acme-cosmos', platform: 'twitter', candidates_ref: 'workspaces/media/c-md/retrieval.json' },
    { index: INDEX, ledger, now: NOW, config: { reuseSimilarity: 0.99, modifySimilarity: 0.01 } },
  );
  validate(schema, mediaDecision, 'media-decision');
});
