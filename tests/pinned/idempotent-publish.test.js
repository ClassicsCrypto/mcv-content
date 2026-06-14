'use strict';

/**
 * tests/pinned/idempotent-publish.test.js  [PINNED — release-spec §16.2]
 *
 * Idempotent publish under interrupted/retried handoff (DR W#35; DD-4 write-ahead intent; DD-13
 * attempt-before-spend; §15.1 interrupted_hold quarantine). The named pinned guarantee:
 *
 *   1. A run that hands an approved item off persists the DD-4 write-ahead `publish_intent` BEFORE
 *      the external call, then advances to handed_off — exactly ONE handoff.
 *   2. A SECOND run never re-hands-off an item already past the write-ahead intent: it VERIFIES
 *      handed_off instead. The stub counts exactly one handoff across both runs.
 *   3. An entry found stranded in `publish_intent` (a previous run died mid-call) is parked in the
 *      dedicated `interrupted_hold` state and NEVER auto-retried — a replay could double-post.
 *
 * (The broader crash-safety series — retry bound, dead-letter, foreign-lock survival — is
 * characterized in tests/executor-crash-safety.test.js; this file is the named §16.2 anchor for
 * the idempotency invariant specifically.)
 *
 * Zero-key, no network: a registered stub publisher; state under a throwaway CONTENT_HOME.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const executor = require('../../engine/orchestrator/publish-executor.js');
const publishers = require('../../engine/publishers/publisher.js');

process.setMaxListeners(0);

const REVIEWER_ID = '00000000000000001';

const SYSTEM_CONFIG = {
  schema_version: '1.0.0',
  mode: 'LIVE',
  reviewers: [{ id: REVIEWER_ID, rights: ['approve', 'edit'] }],
  publish: { draft_only: true, auto_publish_allowed: false },
  approval_surface: { adapter: 'discord', channels: {} },
  cooldown: { hard_days: 14, target_days: 30 },
};

function buildHome(queueRaw) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pin-idem-'));
  fs.mkdirSync(path.join(home, 'config'), { recursive: true });
  fs.mkdirSync(path.join(home, 'queue', 'locks'), { recursive: true });
  fs.mkdirSync(path.join(home, 'library'), { recursive: true });
  fs.writeFileSync(path.join(home, 'config', 'system.json'), JSON.stringify(SYSTEM_CONFIG, null, 2), 'utf8');
  fs.writeFileSync(path.join(home, 'queue', 'publish-queue.md'), queueRaw, 'utf8');
  return { env: { CONTENT_HOME: home, WORKFLOW_LEDGER_DISABLE: '1' }, home, queuePath: path.join(home, 'queue', 'publish-queue.md') };
}

function cleanLiveEntry(id) {
  return [
    '# Publish Queue', '',
    `## Entry - ${id}`,
    `- content_id: ${id}`,
    '- brand: acme-cosmos',
    '- platform: twitter',
    '- format: text',
    '- mode: LIVE',
    `- approved_by: ${REVIEWER_ID}`,
    '- approved_variant: recommended',
    '- approved_copy: A clean approved post.',
    '- state: approved', '',
  ].join('\n');
}

function strandedIntentEntry(id) {
  return [
    '# Publish Queue', '',
    `## Entry - ${id}`,
    `- content_id: ${id}`,
    '- brand: acme-cosmos',
    '- platform: twitter',
    '- format: text',
    '- mode: LIVE',
    `- approved_by: ${REVIEWER_ID}`,
    '- approved_variant: recommended',
    '- approved_copy: An interrupted post.',
    '- attempt_count: 1',
    '- state: publish_intent', '',
  ].join('\n');
}

function installStub() {
  const calls = [];
  publishers.register('postiz', {
    name: 'postiz',
    async handoff(pkg) { calls.push((pkg && pkg.content_id) || 'x'); return { external_ref: `draft-${(pkg && pkg.content_id) || 'x'}`, state: publishers.PUBLISH_STATE.HANDED_OFF }; },
    async verifyStatus() { return { state: publishers.PUBLISH_STATE.HANDED_OFF }; },
    async fetchMetrics() { return { supported: false, metrics: {} }; },
    capabilities() { return { name: 'postiz', draft_gate: true }; },
  });
  return { calls };
}

async function runQuiet(env) {
  const orig = console.log;
  console.log = () => {};
  try { return await executor.main(env); } finally { console.log = orig; }
}

function entryBlock(raw, id) {
  const m = raw.match(new RegExp(`## Entry - ${id}[\\s\\S]*?(?=\\n## Entry -|$)`, 'u'));
  assert.ok(m, `entry ${id} present`);
  return m[0];
}

test('an approved item hands off exactly once; the write-ahead intent persists before the call', async () => {
  const id = '2026-01-01-acme-pass-01';
  const { env, queuePath, home } = buildHome(cleanLiveEntry(id));
  try {
    const stub = installStub();
    await runQuiet(env);
    assert.equal(stub.calls.length, 1, 'exactly one handoff');
    const after = fs.readFileSync(queuePath, 'utf8');
    assert.match(entryBlock(after, id), /- state: handed_off/u, 'reaches handed_off');
    assert.match(entryBlock(after, id), /- attempt_count: 1/u, 'attempt counter spent exactly once');

    // Static write-ahead ordering: the intent persist precedes the handoff call (DD-4).
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'engine', 'orchestrator', 'publish-executor.js'), 'utf8');
    assert.ok(src.indexOf("persistQueue('publish-intent')") < src.indexOf('await handoffOne(entry, ctx)'),
      'the publish-intent persist must land before the external handoff (write-ahead, DD-4)');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('a second run verifies handed_off instead of re-handing-off (idempotent, DR W#35)', async () => {
  const id = '2026-01-01-acme-pass-01';
  const { env, home } = buildHome(cleanLiveEntry(id));
  try {
    const stub = installStub();
    await runQuiet(env);          // → handed_off, 1 handoff
    await runQuiet(env);          // → verify only, no new handoff
    assert.equal(stub.calls.length, 1, 'no second handoff for an item already past the write-ahead intent');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('an entry stranded in publish_intent parks in interrupted_hold and is NEVER replayed', async () => {
  const id = '2026-01-01-acme-intent-03';
  const { env, queuePath, home } = buildHome(strandedIntentEntry(id));
  try {
    const stub = installStub();
    const code = await runQuiet(env);
    assert.equal(code, executor.EXIT.BLOCKED, 'a held entry exits BLOCKED');
    assert.equal(stub.calls.length, 0, 'the stranded intent entry never replays the handoff (no double-post)');
    const after = fs.readFileSync(queuePath, 'utf8');
    assert.match(entryBlock(after, id), /- state: interrupted_hold/u, 'parked in the dedicated hold state');
    assert.match(entryBlock(after, id), /interrupted_mid_publish/u, 'carries the interrupted reason');

    // Even the operator retry flag must not readmit it (only an explicit state reset does).
    const stub2 = installStub();
    await runQuiet({ ...env, RETRY_GATES_FAILED: '1' });
    assert.equal(stub2.calls.length, 0, 'RETRY_GATES_FAILED never replays an interrupted_hold entry');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
