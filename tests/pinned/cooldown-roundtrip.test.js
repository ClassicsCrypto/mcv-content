'use strict';

/**
 * tests/pinned/cooldown-roundtrip.test.js  [PINNED — release-spec §16.2]
 *
 * The full 3-point cooldown round-trip (DD-14; §8.6 "one canonical mechanism plus a test of it";
 * §14.1 enforcement points). One confirmed publish writes the SINGLE canonical cooldown ledger
 * (library/usage-log.jsonl), and ALL THREE enforcement points then observe it through the same
 * usage-log API:
 *
 *   point 1 — retrieval filter      (engine/library/check.js)         blocks the in-cooldown asset
 *   point 2 — package validation    (engine/gate/validate-package.js) emits PKG.MEDIA_COOLDOWN_BLOCKED
 *   point 3 — publish executor       (engine/orchestrator/publish-executor.js) blocks at the edge
 *
 * Plus the DD-14 reconciliation leg: a second-gate KILL (reconcileRemove) deletes the record so the
 * phantom cooldown lifts and all three points pass again. The round-trip closes only if every point
 * reads the same ledger — which is exactly what this pins.
 *
 * Zero-key, no network: writes go to a throwaway CONTENT_HOME; the executor leg uses a stub adapter.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const usageLog = require('../../engine/library/usage-log.js');
const retrieval = require('../../engine/library/check.js');
const validatePackage = require('../../engine/gate/validate-package.js');
const executor = require('../../engine/orchestrator/publish-executor.js');
const publishers = require('../../engine/publishers/publisher.js');

process.setMaxListeners(0);

const REVIEWER_ID = '00000000000000001';
const ASSET = 'media/acme/launch-card.png';
const HARD_DAYS = 14;

const SYSTEM_CONFIG = {
  schema_version: '1.0.0',
  mode: 'LIVE',
  reviewers: [{ id: REVIEWER_ID, rights: ['approve', 'edit'] }],
  publish: { draft_only: true, auto_publish_allowed: false },
  approval_surface: { adapter: 'discord', channels: {} },
  cooldown: { hard_days: HARD_DAYS, target_days: 30 },
};

function buildHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pin-cooldown-'));
  fs.mkdirSync(path.join(home, 'config'), { recursive: true });
  fs.mkdirSync(path.join(home, 'queue', 'locks'), { recursive: true });
  fs.mkdirSync(path.join(home, 'library'), { recursive: true });
  fs.writeFileSync(path.join(home, 'config', 'system.json'), JSON.stringify(SYSTEM_CONFIG, null, 2), 'utf8');
  return { env: { CONTENT_HOME: home, WORKFLOW_LEDGER_DISABLE: '1' }, home };
}

// A reusable image candidate the retrieval scorer can match (point 1 reads this index).
function index() {
  return [{
    asset_id: ASSET,
    path: ASSET,
    type: 'image',
    source_class: 'library',
    description: 'the acme launch card hero still',
    tags: ['launch', 'card', 'hero'],
  }];
}

// A visual-format package binding the same asset (point 2 cooldown-checks bound media).
function packageWithAsset(contentId) {
  return {
    audit_header: {
      content_id: contentId,
      brand: 'acme-cosmos',
      platform: 'twitter',
      mode: 'LIVE',
      format: 'tweet + image',
      visual_state: 'reviewed',
      gate_verdict: 'PASS',
      media: [ASSET],
    },
    recommended: { text: 'Reusing the launch card.', scores: { brand: 90, stepps: 7 } },
    variant_a: { text: 'The launch card returns for a fresh recap today.' },
    variant_b: { text: 'A look back at launch, anchored by the same hero card.' },
  };
}

function queueWithAsset(contentId) {
  return [
    '# Publish Queue', '',
    `## Entry - ${contentId}`,
    `- content_id: ${contentId}`,
    '- brand: acme-cosmos',
    '- platform: twitter',
    '- format: image',
    '- mode: LIVE',
    `- approved_by: ${REVIEWER_ID}`,
    '- approved_variant: recommended',
    `- media_refs: ${ASSET}`,
    '- state: approved', '',
  ].join('\n');
}

function installStub() {
  const calls = [];
  publishers.register('postiz', {
    name: 'postiz',
    async handoff(pkg) { calls.push((pkg && pkg.content_id) || 'x'); return { external_ref: 'draft-x', state: publishers.PUBLISH_STATE.HANDED_OFF }; },
    async verifyStatus() { return { state: publishers.PUBLISH_STATE.HANDED_OFF }; },
    async fetchMetrics() { return { supported: false, metrics: {} }; },
    capabilities() { return { name: 'postiz', draft_gate: true }; },
  });
  return { calls };
}

async function runExecutorQuiet(env) {
  const orig = console.log;
  console.log = () => {};
  try { return await executor.main(env); } finally { console.log = orig; }
}

test('3-point cooldown round-trip: confirmed publish blocks all three points; a kill reconciles them', async () => {
  const { env, home } = buildHome();
  try {
    // ---- BEFORE the publish: every point sees a free asset ----
    const r0 = retrieval.check({ query: 'launch card hero', media_type: 'image' }, { index: index(), env });
    assert.equal(r0.candidates[0].cooldown_status.cooldown_blocked, false, 'point 1: asset free before use');

    const v0 = validatePackage.validate(packageWithAsset('acme-pre-01'), { platform: 'twitter', env, recordLedger: false });
    assert.ok(!v0.detected_codes.some((c) => c.code === 'PKG.MEDIA_COOLDOWN_BLOCKED'), 'point 2: no cooldown code before use');

    // ---- THE WRITE: one confirmed publish appends to the SINGLE canonical ledger (DD-14) ----
    usageLog.recordUse({ asset_id: ASSET, content_id: 'acme-published-01', platform: 'twitter' }, { env });
    assert.equal(usageLog.readLedger(env).length, 1, 'exactly one canonical usage record written');

    // ---- AFTER the publish: all three points observe the same ledger ----
    // point 1 — retrieval filter blocks the now-cooled asset.
    const r1 = retrieval.check({ query: 'launch card hero', media_type: 'image' }, { index: index(), env, excludeContentId: 'acme-new-02' });
    assert.equal(r1.candidates[0].cooldown_status.cooldown_blocked, true, 'point 1: retrieval filter blocks the cooled asset');

    // point 2 — package validation emits PKG.MEDIA_COOLDOWN_BLOCKED for a fresh item reusing it.
    const v1 = validatePackage.validate(packageWithAsset('acme-new-02'), { platform: 'twitter', env, recordLedger: false });
    assert.ok(v1.detected_codes.some((c) => c.code === 'PKG.MEDIA_COOLDOWN_BLOCKED'), 'point 2: package gate blocks the reuse');

    // point 3 — the publish executor blocks at the edge with the same code.
    const queuePath = path.join(home, 'queue', 'publish-queue.md');
    fs.writeFileSync(queuePath, queueWithAsset('acme-new-02'), 'utf8');
    installStub();
    const code = await runExecutorQuiet(env);
    assert.equal(code, executor.EXIT.BLOCKED, 'point 3: executor blocks the reuse');
    assert.match(fs.readFileSync(queuePath, 'utf8'), /MEDIA_COOLDOWN_BLOCKED/u, 'point 3: cooldown code on the entry');

    // re-gating the SAME content item does not block itself (excludeContentId).
    const vSelf = validatePackage.validate(packageWithAsset('acme-published-01'), { platform: 'twitter', contentId: 'acme-published-01', env, recordLedger: false });
    assert.ok(!vSelf.detected_codes.some((c) => c.code === 'PKG.MEDIA_COOLDOWN_BLOCKED'), 're-gating the same item never blocks on its own prior use');

    // ---- THE KILL: second-gate reconciliation removes the record; the phantom cooldown lifts ----
    const removed = usageLog.reconcileRemove('acme-published-01', { env });
    assert.equal(removed, 1, 'reconcileRemove deletes the killed item record (DD-14)');
    assert.equal(usageLog.readLedger(env).length, 0, 'ledger empty after reconciliation');

    const r2 = retrieval.check({ query: 'launch card hero', media_type: 'image' }, { index: index(), env });
    assert.equal(r2.candidates[0].cooldown_status.cooldown_blocked, false, 'point 1: asset free again after the kill');
    const v2 = validatePackage.validate(packageWithAsset('acme-after-kill-03'), { platform: 'twitter', env, recordLedger: false });
    assert.ok(!v2.detected_codes.some((c) => c.code === 'PKG.MEDIA_COOLDOWN_BLOCKED'), 'point 2: package gate passes after the kill');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
