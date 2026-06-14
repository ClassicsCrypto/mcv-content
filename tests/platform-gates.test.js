'use strict';

/**
 * tests/platform-gates.test.js  [A adapted]
 *
 * Characterization for the per-platform deterministic gate registry (engine/gate/platform-gates.js;
 * release-spec §14.1 layer 3; §10.2 PLAT.*). Ported from the production platform-gates test, with
 * the ctx contract rebound from the production `failures[]` string tokens to the §7.2 detected_codes
 * shape (PLAT.*-namespaced) and brand strings replaced by synthetic copy (spec §0.3 r6).
 *
 * Locks: the five-gate registry + its order, the per-gate match/alias rules, the emitted PLAT.*
 * codes + their push order, and the details mutations (instagram_hashtag_count) the downstream
 * union-of-codes consumer depends on.
 *
 * Runner: node:test (zero-dependency, Node >= 22). Standalone:
 *   node --test tests/platform-gates.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { PLATFORM_GATES, runPlatformGates, CODES } = require('../engine/gate/platform-gates.js');

function makeCtx({ platform, raw = '', sections = {}, fields = {} }) {
  return {
    platform,
    raw,
    detected: [],
    details: {},
    sectionBody: (name) => sections[name] || '',
    hasField: (key) => Boolean(fields[key]),
  };
}

/** The PLAT.* codes a ctx run produced, in push order. */
function codes(ctx) {
  return ctx.detected.map((d) => d.code);
}

test('registry has exactly the 5 platform gates in order', () => {
  assert.equal(PLATFORM_GATES.length, 5);
  assert.deepEqual(PLATFORM_GATES.map((g) => g.id), ['twitter', 'instagram', 'tiktok', 'youtube', 'facebook']);
});

test('every emitted PLAT.* code carries the §7.2 detected_codes shape', () => {
  const ctx = makeCtx({ platform: 'twitter', sections: { Recommended: 'gm fam #web3 lfg' } });
  runPlatformGates(ctx);
  assert.equal(ctx.detected.length, 1);
  const d = ctx.detected[0];
  assert.equal(d.code, 'PLAT.TWITTER_HASHTAG_PRESENT');
  assert.equal(d.family, 'PLAT');
  assert.equal(d.source, 'platform');
  assert.equal(d.tier, 'hard');
  assert.equal(d.disposition, 'block');
  assert.ok(d.rule_ref && d.explanation);
});

test('twitter: hashtag in a variant body fails; clean passes; no details mutation', () => {
  const dirty = makeCtx({ platform: 'Twitter/X', sections: { Recommended: 'gm fam #web3 lfg' } });
  runPlatformGates(dirty);
  assert.deepEqual(codes(dirty), ['PLAT.TWITTER_HASHTAG_PRESENT']);
  assert.deepEqual(dirty.details, {});

  const clean = makeCtx({ platform: 'Twitter/X', sections: { Recommended: 'gm fam lfg', 'Variant A': 'no tags here', 'Variant B': 'still none' } });
  runPlatformGates(clean);
  assert.deepEqual(codes(clean), []);
  assert.deepEqual(clean.details, {});
});

test('twitter alias "X" (exact, lowercased) also matches', () => {
  const ctx = makeCtx({ platform: 'X', sections: { 'Variant A': 'breaking #news' } });
  runPlatformGates(ctx);
  assert.deepEqual(codes(ctx), ['PLAT.TWITTER_HASHTAG_PRESENT']);
});

test('instagram: over-30 hashtags fails with count; <=30 passes; always records the count', () => {
  const over = makeCtx({ platform: 'Instagram', sections: { Recommended: '#tag '.repeat(31) } });
  runPlatformGates(over);
  assert.deepEqual(codes(over), ['PLAT.INSTAGRAM_HASHTAG_OVER_LIMIT']);
  assert.equal(over.details.instagram_hashtag_count, 31);
  assert.match(over.detected[0].explanation, /31 hashtags/);

  const ok = makeCtx({ platform: 'IG', sections: { Recommended: '#a #b #c #d #e' } });
  runPlatformGates(ok);
  assert.deepEqual(codes(ok), []);
  assert.equal(ok.details.instagram_hashtag_count, 5);
  // only key the instagram gate sets
  assert.deepEqual(Object.keys(ok.details), ['instagram_hashtag_count']);
});

test('tiktok: both hook + cover missing → both codes in order; present → none', () => {
  const missing = makeCtx({ platform: 'TikTok' });
  runPlatformGates(missing);
  assert.deepEqual(codes(missing), ['PLAT.TIKTOK_HOOK_3S_MISSING', 'PLAT.TIKTOK_COVER_FRAME_MISSING']);

  const present = makeCtx({ platform: 'TikTok', fields: { hook_3s: true, cover_frame: true } });
  runPlatformGates(present);
  assert.deepEqual(codes(present), []);

  // the canonical field names also satisfy the gate
  const canonical = makeCtx({ platform: 'TikTok', fields: { first_3s_hook_pass: true, cover_frame_timestamp: true } });
  runPlatformGates(canonical);
  assert.deepEqual(codes(canonical), []);
});

test('youtube: missing source-sense fails; field OR raw mention satisfies it', () => {
  const missing = makeCtx({ platform: 'YouTube' });
  runPlatformGates(missing);
  assert.deepEqual(codes(missing), ['PLAT.YOUTUBE_SOURCE_SENSE_MISSING']);

  const byField = makeCtx({ platform: 'YT', fields: { source_sense_check: true } });
  runPlatformGates(byField);
  assert.deepEqual(codes(byField), []);

  const byRaw = makeCtx({ platform: 'YouTube', raw: 'notes: source sense check done' });
  runPlatformGates(byRaw);
  assert.deepEqual(codes(byRaw), []);
});

test('facebook: missing community_bridge fails; present passes', () => {
  const missing = makeCtx({ platform: 'Facebook' });
  runPlatformGates(missing);
  assert.deepEqual(codes(missing), ['PLAT.FACEBOOK_COMMUNITY_BRIDGE_MISSING']);

  const present = makeCtx({ platform: 'FB', fields: { community_bridge: true } });
  runPlatformGates(present);
  assert.deepEqual(codes(present), []);
});

test('giphy / unknown / empty platform run no gate (no codes, no details) — the intentional asymmetry', () => {
  for (const platform of ['Giphy', 'Mastodon', '', null, undefined]) {
    const ctx = makeCtx({ platform, sections: { Recommended: '#would-fail-on-twitter' }, fields: {} });
    runPlatformGates(ctx);
    assert.deepEqual(codes(ctx), [], `platform=${platform}`);
    assert.deepEqual(ctx.details, {}, `platform=${platform}`);
  }
});

test('the CODES table covers every code the registry can emit (registry integrity)', () => {
  const emittable = new Set();
  // Drive each gate to emit, then assert each emitted code is a known PLAT.* registry entry.
  const drivers = [
    makeCtx({ platform: 'twitter', sections: { Recommended: '#x' } }),
    makeCtx({ platform: 'instagram', sections: { Recommended: '#x '.repeat(31) } }),
    makeCtx({ platform: 'tiktok' }),
    makeCtx({ platform: 'youtube' }),
    makeCtx({ platform: 'facebook' }),
  ];
  for (const ctx of drivers) {
    runPlatformGates(ctx);
    for (const d of ctx.detected) emittable.add(d.code);
  }
  const registered = new Set(Object.values(CODES).map((c) => c.code));
  for (const code of emittable) assert.ok(registered.has(code), `emitted code not in CODES table: ${code}`);
  // Every code is PLAT.*-namespaced.
  for (const code of registered) assert.match(code, /^PLAT\./);
});
