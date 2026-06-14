'use strict';

/**
 * Executor cooldown-gate test (enforcement point 3, release-spec §8.6/§14.1; DD-14; §16.2 round-trip).
 *
 * The executor's `media_cooldown` gate reads the SAME canonical `library/usage-log.jsonl` the
 * retrieval filter and package validation read. This pins the publish-edge half of the cooldown
 * round-trip: an asset that a confirmed publish wrote to the ledger inside the hard window blocks a
 * same-asset re-publish here with `PKG.MEDIA_COOLDOWN_BLOCKED`; once outside the window (or never
 * used) it passes; re-gating the same content item does not block itself.
 *
 * Drives the gate end-to-end via the executor `main()` against a synthetic CONTENT_HOME so the gate
 * resolves the ledger through paths.js exactly as production does.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const executor = require('../engine/orchestrator/publish-executor.js');
const publishers = require('../engine/publishers/publisher.js');
const usageLog = require('../engine/library/usage-log.js');

// Many in-process main() runs; lift the listener cap for the test process only (see crash-safety
// suite note). Production runs each invocation as a fresh process.
process.setMaxListeners(0);

const REVIEWER_ID = '00000000000000001';
const ASSET = 'media/acme/launch-card.png';

const SYSTEM_CONFIG = {
  schema_version: '1.0.0',
  mode: 'LIVE',
  reviewers: [{ id: REVIEWER_ID, rights: ['approve', 'edit'] }],
  budget: { monthly_cap: 50, daily_cap: 5, per_item_generation_limit: 1, indexing_requires_estimate: true },
  publish: { draft_only: true, auto_publish_allowed: false },
  approval_surface: { adapter: 'discord', channels: { 'content-review': 'c1', 'content-published': 'c2', 'content-ops': 'c3', 'media-bank': 'c4' } },
  scheduler: { kickoff_time: '09:00' },
  cooldown: { hard_days: 14, target_days: 30 },
};

function buildHome(usageRecords) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'exec-cooldown-'));
  fs.mkdirSync(path.join(home, 'config'), { recursive: true });
  fs.mkdirSync(path.join(home, 'queue', 'locks'), { recursive: true });
  fs.mkdirSync(path.join(home, 'library'), { recursive: true });
  fs.writeFileSync(path.join(home, 'config', 'system.json'), JSON.stringify(SYSTEM_CONFIG, null, 2), 'utf8');
  const queueRaw = [
    '# Publish Queue',
    '',
    '## Entry - 2026-02-01-acme-reuse-01',
    '- content_id: 2026-02-01-acme-reuse-01',
    '- brand: acme-cosmos',
    '- platform: twitter',
    '- format: image',
    '- mode: LIVE',
    `- approved_by: ${REVIEWER_ID}`,
    '- approved_variant: recommended',
    '- approved_copy: Reusing the launch card.',
    `- media_refs: ${ASSET}`,
    '- state: approved',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(home, 'queue', 'publish-queue.md'), queueRaw, 'utf8');
  if (usageRecords && usageRecords.length) {
    fs.writeFileSync(
      path.join(home, 'library', 'usage-log.jsonl'),
      usageRecords.map((r) => JSON.stringify(r)).join('\n') + '\n',
      'utf8',
    );
  }
  const env = { CONTENT_HOME: home, WORKFLOW_LEDGER_DISABLE: '1' };
  return { env, home, queuePath: path.join(home, 'queue', 'publish-queue.md') };
}

function installStubPostiz() {
  const calls = [];
  publishers.register('postiz', {
    name: 'postiz',
    async handoff(pkg) {
      calls.push((pkg && (pkg.content_id || (pkg.audit_header && pkg.audit_header.content_id))) || 'unknown');
      return { external_ref: 'draft-x', state: publishers.PUBLISH_STATE.HANDED_OFF };
    },
    async verifyStatus() { return { state: publishers.PUBLISH_STATE.HANDED_OFF }; },
    async fetchMetrics() { return { supported: false, metrics: {} }; },
    capabilities() { return { name: 'postiz', draft_gate: true }; },
  });
  return { calls };
}

async function runExecutor(env) {
  const lines = [];
  const orig = console.log;
  console.log = (...args) => { lines.push(args.join(' ')); };
  let code;
  try {
    code = await executor.main(env);
  } finally {
    console.log = orig;
  }
  return { code, stdout: lines.join('\n') };
}

function entryBlock(raw, contentId) {
  const re = new RegExp(`## Entry - ${contentId}[\\s\\S]*?(?=\\n## Entry -|$)`, 'u');
  const m = raw.match(re);
  assert.ok(m, `entry ${contentId} present`);
  return m[0];
}

test('asset inside the 14-day window blocks the publish with PKG.MEDIA_COOLDOWN_BLOCKED', async () => {
  // A prior confirmed publish of the SAME asset, 3 days ago — inside the 14-day hard floor.
  const usedAt = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
  const { env, queuePath, home } = buildHome([
    { asset_id: ASSET, content_id: '2026-01-29-acme-prior-09', used_at: usedAt, platform: 'twitter' },
  ]);
  const stub = installStubPostiz();

  const r = await runExecutor(env);
  assert.equal(r.code, executor.EXIT.BLOCKED, `cooldown-blocked run exits BLOCKED. stdout:\n${r.stdout}`);
  assert.equal(stub.calls.length, 0, 'a cooldown-blocked item never reaches the publisher');

  const after = fs.readFileSync(queuePath, 'utf8');
  const block = entryBlock(after, '2026-02-01-acme-reuse-01');
  assert.match(block, /- state: manual_review/u, 'cooldown-blocked item parks for manual review');
  assert.match(block, /MEDIA_COOLDOWN_BLOCKED/u, 'carries the cooldown code at the publish edge');
  assert.match(r.stdout, /PKG\.MEDIA_COOLDOWN_BLOCKED/u);
  fs.rmSync(home, { recursive: true, force: true });
});

test('asset outside the window passes the cooldown gate and hands off', async () => {
  // Last use 40 days ago — outside both the 14-day floor and the 30-day target.
  const usedAt = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
  const { env, queuePath, home } = buildHome([
    { asset_id: ASSET, content_id: '2025-12-23-acme-old-03', used_at: usedAt, platform: 'twitter' },
  ]);
  const stub = installStubPostiz();

  const r = await runExecutor(env);
  assert.equal(stub.calls.length, 1, 'an out-of-window asset hands off normally');
  const after = fs.readFileSync(queuePath, 'utf8');
  assert.match(entryBlock(after, '2026-02-01-acme-reuse-01'), /- state: handed_off/u);
  fs.rmSync(home, { recursive: true, force: true });
});

test('no prior use ⇒ cooldown gate passes', async () => {
  const { env, queuePath, home } = buildHome([]);
  const stub = installStubPostiz();
  await runExecutor(env);
  assert.equal(stub.calls.length, 1, 'an unused asset hands off');
  const after = fs.readFileSync(queuePath, 'utf8');
  assert.match(entryBlock(after, '2026-02-01-acme-reuse-01'), /- state: handed_off/u);
  fs.rmSync(home, { recursive: true, force: true });
});

test('round-trip: a confirmed publish writes the ledger, then re-blocks the same asset', async () => {
  // Start clean, publish once (handoff → verify → published writes usage), then re-queue the same
  // asset and confirm the cooldown gate now blocks it (the §16.2 round-trip, executor half).
  const { env, home, queuePath } = buildHome([]);

  // Stub that publishes directly so the executor records the usage write-back in one pass.
  publishers.register('postiz', {
    name: 'postiz',
    async handoff() { return { external_ref: 'draft-rt', state: publishers.PUBLISH_STATE.PUBLISHED, post_url: 'https://example.test/p/rt', published_at: new Date().toISOString() }; },
    async verifyStatus() { return { state: publishers.PUBLISH_STATE.PUBLISHED }; },
    async fetchMetrics() { return { supported: false, metrics: {} }; },
    capabilities() { return { name: 'postiz', draft_gate: false }; },
  });

  const r1 = await runExecutor(env);
  assert.match(fs.readFileSync(queuePath, 'utf8'), /- state: published/u, 'first pass publishes');
  const ledgerAfter = usageLog.readLedger(env);
  assert.equal(ledgerAfter.length, 1, 'confirmed publish wrote one usage record');

  // Re-queue the same asset under a NEW content id.
  const requeue = [
    '# Publish Queue',
    '',
    '## Entry - 2026-02-02-acme-reuse-02',
    '- content_id: 2026-02-02-acme-reuse-02',
    '- brand: acme-cosmos',
    '- platform: twitter',
    '- format: image',
    '- mode: LIVE',
    `- approved_by: ${REVIEWER_ID}`,
    '- approved_variant: recommended',
    `- media_refs: ${ASSET}`,
    '- state: approved',
    '',
  ].join('\n');
  fs.writeFileSync(queuePath, requeue, 'utf8');

  const r2 = await runExecutor(env);
  assert.equal(r2.code, executor.EXIT.BLOCKED, 'the requeued same-asset item is cooldown-blocked');
  assert.match(fs.readFileSync(queuePath, 'utf8'), /MEDIA_COOLDOWN_BLOCKED/u, 'round-trip blocks the same asset post-publish');
  fs.rmSync(home, { recursive: true, force: true });
});
