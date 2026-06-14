'use strict';

/**
 * tests/validate-package.test.js  [A adapted]
 *
 * Characterization for the deterministic pre-publish gate (engine/gate/validate-package.js;
 * release-spec §14.1 layer 3; §8.6 cooldown enforcement point 2; §10.2 PKG.*). Two source
 * tests fold in here:
 *   - the production live-gate-wiring guard → a public wiring guard: the gate is importable,
 *     emits §7.2-shaped PKG.* codes, and every emitted code is registered;
 *   - the §16.2 cooldown round-trip (DETERMINISTIC half): a synthetic usage-log makes a media
 *     package FAIL with PKG.MEDIA_COOLDOWN_BLOCKED, then clears after the 14-day hard floor —
 *     proving the rebind to the canonical usage-log keeps the 14/30-day semantics (DD-14).
 *
 * Brand strings are synthetic Acme Cosmos copy (spec §0.3 r6). CONTENT_HOME is injected per test
 * via the env option so no real instance is touched, and recordLedger:false keeps the gate off
 * the ledger. Runner: node:test (Node >= 22).  node --test tests/validate-package.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const vp = require('../engine/gate/validate-package.js');
const usageLog = require('../engine/library/usage-log.js');

const DAY = 24 * 60 * 60 * 1000;
const ENV_BASE = { recordLedgerDummy: true }; // no CONTENT_HOME ⇒ usage-log reads empty.

function tempHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oce-vp-'));
  return { CONTENT_HOME: dir };
}
function iso(msAgo, now = Date.now()) {
  return new Date(now - msAgo).toISOString();
}

/** A clean, complete text package (object form, per package.schema.json). */
function cleanTextPackage(over = {}) {
  return {
    audit_header: {
      content_id: 'acme-2026-01-01-01',
      brand: 'acme-cosmos',
      platform: 'twitter',
      mode: 'SAFE',
      format: 'text',
      ...((over.audit_header) || {}),
    },
    recommended: { text: 'The Acme Cosmos beta wrapped with sixty builders shipping live demos.', scores: { brand: 90, stepps: 7 } },
    variant_a: { text: 'Sixty builders. One weekend. Every demo went out as a working link.', scores: { brand: 88, stepps: 6 } },
    variant_b: { text: 'We asked for usable demos and got sixty. Here is what the beta produced.', scores: { brand: 87, stepps: 6 } },
    ...over,
  };
}

function codes(result) {
  return result.detected_codes.map((d) => d.code);
}

// --- Wiring guard + clean baseline ----------------------------------------------------------

test('the gate is importable and exposes validate() returning a §7.2 validation-result', () => {
  assert.equal(typeof vp.validate, 'function');
  const r = vp.validate(cleanTextPackage(), { env: ENV_BASE, recordLedger: false });
  assert.equal(r.stage, 'package');
  assert.equal(r.verdict, 'PASS');
  assert.ok(Array.isArray(r.detected_codes));
  assert.equal(r.content_id, 'acme-2026-01-01-01');
});

test('a clean, complete text package PASSes with zero codes', () => {
  const r = vp.validate(cleanTextPackage(), { env: ENV_BASE, recordLedger: false });
  assert.deepEqual(codes(r), []);
});

test('every emitted PKG.* code is registered + §7.2-shaped (registry integrity)', () => {
  // Drive a maximally-broken package so many PKG codes fire at once.
  const broken = { audit_header: { mode: 'LIVE', format: 'image, video' } };
  const r = vp.validate(broken, { env: ENV_BASE, platform: 'twitter', recordLedger: false });
  const registered = new Set(Object.values(vp.CODES).map((c) => c.code));
  assert.ok(r.detected_codes.length > 0);
  for (const d of r.detected_codes) {
    // PKG codes must be registered; PLAT codes come from the platform registry.
    if (d.family === 'PKG') assert.ok(registered.has(d.code), `unregistered PKG code: ${d.code}`);
    assert.ok(['PKG', 'PLAT'].includes(d.family));
    assert.ok(d.code && d.tier && d.source && d.disposition);
  }
  for (const code of registered) assert.match(code, /^PKG\./);
});

// --- Structural PKG.* checks ----------------------------------------------------------------

test('missing audit header fails PKG.AUDIT_HEADER_MISSING', () => {
  const pkg = cleanTextPackage();
  delete pkg.audit_header;
  const r = vp.validate(pkg, { env: ENV_BASE, platform: 'twitter', contentId: 'x', recordLedger: false });
  assert.ok(codes(r).includes('PKG.AUDIT_HEADER_MISSING'));
  assert.equal(r.verdict, 'FAIL');
});

test('missing variants fail RECOMMENDED/VARIANT_A/VARIANT_B', () => {
  const pkg = cleanTextPackage();
  delete pkg.recommended;
  delete pkg.variant_b;
  const r = vp.validate(pkg, { env: ENV_BASE, recordLedger: false });
  assert.ok(codes(r).includes('PKG.RECOMMENDED_MISSING'));
  assert.ok(codes(r).includes('PKG.VARIANT_B_MISSING'));
  assert.ok(!codes(r).includes('PKG.VARIANT_A_MISSING'));
});

test('missing scores fails PKG.SCORES_MISSING', () => {
  const pkg = cleanTextPackage();
  delete pkg.recommended.scores;
  delete pkg.variant_a.scores;
  delete pkg.variant_b.scores;
  const r = vp.validate(pkg, { env: ENV_BASE, recordLedger: false });
  assert.ok(codes(r).includes('PKG.SCORES_MISSING'));
});

test('LIVE package requires an explicit PASS gate verdict (renamed from the production token)', () => {
  const missing = cleanTextPackage({ audit_header: { content_id: 'a', brand: 'b', platform: 'twitter', mode: 'LIVE', format: 'text' } });
  const rMissing = vp.validate(missing, { env: ENV_BASE, recordLedger: false });
  assert.ok(codes(rMissing).includes('PKG.GATE_VERDICT_MISSING_FOR_LIVE'));

  const failing = cleanTextPackage({ audit_header: { content_id: 'a', brand: 'b', platform: 'twitter', mode: 'LIVE', format: 'text', gate_verdict: 'FAIL' } });
  const rFail = vp.validate(failing, { env: ENV_BASE, recordLedger: false });
  assert.ok(codes(rFail).includes('PKG.GATE_VERDICT_NOT_PASSING_FOR_LIVE'));

  const passing = cleanTextPackage({ audit_header: { content_id: 'a', brand: 'b', platform: 'twitter', mode: 'LIVE', format: 'text', gate_verdict: 'PASS' } });
  const rPass = vp.validate(passing, { env: ENV_BASE, recordLedger: false });
  assert.ok(!codes(rPass).some((c) => c.startsWith('PKG.GATE_VERDICT')));
});

test('enrichment packet leak in public copy fails PKG.ENRICHMENT_PACKET_LEAK', () => {
  const pkg = cleanTextPackage();
  pkg.recommended.text = 'thesis: builders ship\nThe Acme Cosmos beta wrapped this weekend.';
  const r = vp.validate(pkg, { env: ENV_BASE, recordLedger: false });
  assert.ok(codes(r).includes('PKG.ENRICHMENT_PACKET_LEAK'));
});

test('not-ready readiness fields fail their PKG codes', () => {
  const pkg = cleanTextPackage({ audit_header: {
    content_id: 'a', brand: 'b', platform: 'twitter', mode: 'SAFE', format: 'text',
    package_status: 'revision_requested', publish_state: 'blocked',
  } });
  const r = vp.validate(pkg, { env: ENV_BASE, recordLedger: false });
  assert.ok(codes(r).includes('PKG.PACKAGE_STATUS_NOT_READY'));
  assert.ok(codes(r).includes('PKG.PUBLISH_STATE_NOT_READY'));
});

// --- Visual-format gates --------------------------------------------------------------------

test('a visual-format package with no visual_state + no media fails both', () => {
  const pkg = cleanTextPackage({ audit_header: { content_id: 'a', brand: 'b', platform: 'instagram', mode: 'SAFE', format: 'image' } });
  const r = vp.validate(pkg, { env: ENV_BASE, recordLedger: false });
  assert.ok(codes(r).includes('PKG.VISUAL_STATE_MISSING'));
  assert.ok(codes(r).includes('PKG.MEDIA_MISSING'));
});

test('a visual-format package with bound media + visual_state and a free asset PASSes the media block', () => {
  const env = tempHome();
  const pkg = cleanTextPackage({ audit_header: {
    content_id: 'a', brand: 'acme-cosmos', platform: 'instagram', mode: 'SAFE', format: 'image',
    visual_state: 'reuse', media: ['library/media/hero-01.png'],
  } });
  const r = vp.validate(pkg, { env, recordLedger: false });
  assert.ok(!codes(r).includes('PKG.VISUAL_STATE_MISSING'));
  assert.ok(!codes(r).includes('PKG.MEDIA_MISSING'));
  assert.ok(!codes(r).includes('PKG.MEDIA_COOLDOWN_BLOCKED'));
});

// --- Cooldown round-trip (DETERMINISTIC half of the §16.2 pinned test; DD-14) ---------------

test('cooldown enforcement point 2: an asset used 3 days ago blocks the package (14-day floor)', () => {
  const env = tempHome();
  const now = Date.now();
  usageLog.recordUse({ asset_id: 'library/media/hero-01.png', content_id: 'prev-1', used_at: iso(3 * DAY, now) }, { env });

  const pkg = cleanTextPackage({ audit_header: {
    content_id: 'new-2', brand: 'acme-cosmos', platform: 'instagram', mode: 'SAFE', format: 'image',
    visual_state: 'reuse', media: ['library/media/hero-01.png'],
  } });
  // The gate reads the canonical ledger; cooldownStatus uses Date.now(), so a 3-day-old use is in-floor.
  const r = vp.validate(pkg, { env, recordLedger: false });
  assert.ok(codes(r).includes('PKG.MEDIA_COOLDOWN_BLOCKED'), `expected cooldown block; got ${codes(r)}`);
  assert.equal(r.verdict, 'FAIL');
  // The media_cooldown detail is ledger-shaped (asset_path + family + last_use).
  const detail = r['x-pre-publish'].details.media_cooldown[0];
  assert.equal(detail.asset_path, 'media/hero-01.png');
  assert.equal(detail.cooldown_blocked, true);
  assert.equal(detail.last_use.content_id, 'prev-1');
});

test('cooldown clears once the asset is older than the 14-day hard floor', () => {
  const env = tempHome();
  const now = Date.now();
  // Used 20 days ago: past the 14-day floor.
  usageLog.recordUse({ asset_id: 'library/media/hero-01.png', content_id: 'prev-1', used_at: iso(20 * DAY, now) }, { env });

  const pkg = cleanTextPackage({ audit_header: {
    content_id: 'new-2', brand: 'acme-cosmos', platform: 'instagram', mode: 'SAFE', format: 'image',
    visual_state: 'reuse', media: ['library/media/hero-01.png'],
  } });
  const r = vp.validate(pkg, { env, recordLedger: false });
  assert.ok(!codes(r).includes('PKG.MEDIA_COOLDOWN_BLOCKED'), `expected no cooldown block; got ${codes(r)}`);
});

test('cooldown is family-aware: a derivative of a recently-used asset is also blocked (DR W#48)', () => {
  const env = tempHome();
  const now = Date.now();
  usageLog.recordUse({ asset_id: 'library/media/launch/hero.png', content_id: 'prev-1', used_at: iso(2 * DAY, now) }, { env });

  const pkg = cleanTextPackage({ audit_header: {
    content_id: 'new-2', brand: 'acme-cosmos', platform: 'instagram', mode: 'SAFE', format: 'image',
    visual_state: 'modify', media: ['library/media/launch/exports/hero-twitter-1600x900.png'],
  } });
  const r = vp.validate(pkg, { env, recordLedger: false });
  assert.ok(codes(r).includes('PKG.MEDIA_COOLDOWN_BLOCKED'), `expected family cooldown block; got ${codes(r)}`);
});

test('excludeContentId: re-gating the SAME item does not block on its own prior use', () => {
  const env = tempHome();
  const now = Date.now();
  // The item's own prior use (a re-gate after an edit) must not self-block.
  usageLog.recordUse({ asset_id: 'library/media/hero-01.png', content_id: 'same-item', used_at: iso(1 * DAY, now) }, { env });

  const pkg = cleanTextPackage({ audit_header: {
    content_id: 'same-item', brand: 'acme-cosmos', platform: 'instagram', mode: 'SAFE', format: 'image',
    visual_state: 'reuse', media: ['library/media/hero-01.png'],
  } });
  const r = vp.validate(pkg, { env, recordLedger: false });
  assert.ok(!codes(r).includes('PKG.MEDIA_COOLDOWN_BLOCKED'), `same-item re-gate should not self-block; got ${codes(r)}`);
});

// --- Platform-gate integration (PLAT.* travel in the same union) ----------------------------

test('platform gates contribute PLAT.* codes into the same detected_codes union', () => {
  const pkg = cleanTextPackage();
  pkg.recommended.text = 'gm Acme Cosmos fam #web3';
  const r = vp.validate(pkg, { env: ENV_BASE, platform: 'twitter', recordLedger: false });
  assert.ok(codes(r).includes('PLAT.TWITTER_HASHTAG_PRESENT'));
  const platCode = r.detected_codes.find((d) => d.code === 'PLAT.TWITTER_HASHTAG_PRESENT');
  assert.equal(platCode.source, 'platform');
  assert.equal(r.verdict, 'FAIL');
});

test('config supplies the cooldown hard-floor; a 30-day brand override blocks a 20-day-old asset', () => {
  const env = tempHome();
  const now = Date.now();
  usageLog.recordUse({ asset_id: 'library/media/hero-01.png', content_id: 'prev-1', used_at: iso(20 * DAY, now) }, { env });

  const pkg = cleanTextPackage({ audit_header: {
    content_id: 'new-2', brand: 'acme-cosmos', platform: 'instagram', mode: 'SAFE', format: 'image',
    visual_state: 'reuse', media: ['library/media/hero-01.png'],
  } });
  // Brand override raises the hard floor to 30 days ⇒ a 20-day-old use is back inside cooldown.
  const config = { cooldown: { hard_days: 14 }, brands: { 'acme-cosmos': { cooldown_overrides: { hard_days: 30 } } } };
  const r = vp.validate(pkg, { env, config, recordLedger: false });
  assert.ok(codes(r).includes('PKG.MEDIA_COOLDOWN_BLOCKED'), `30-day override should block; got ${codes(r)}`);
  assert.equal(vp.cooldownDays(config, 'acme-cosmos'), 30);
  assert.equal(vp.cooldownDays(config, 'other-brand'), 14);
});
