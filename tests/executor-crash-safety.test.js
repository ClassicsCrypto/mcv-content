'use strict';

/**
 * Characterization tests for the publish executor's crash-safety series
 * (engine/orchestrator/publish-executor.js; release-spec §16.1 pinned core; §8.3; §15.1; DD-4/13).
 *
 * Ported from the production executor-crash-safety suite, adapted to the public seam:
 *   - state runs under a test-scoped CONTENT_HOME (no instance paths, no repo writes);
 *   - the publisher is a registered STUB adapter (no network), so LIVE-mode handoff is exercised
 *     without any external effect;
 *   - all fixture content ids are synthetic `0…01`-class placeholders (no instance data).
 *
 * What is pinned:
 *   - per-entry persistence: every state transition hits disk WHEN it happens (the "queue
 *     persisted (<reason>)" log lines + the on-disk file state), not at end-of-run;
 *   - crash-recovery hold: an entry found in the write-ahead intent state (`publish_intent`) is
 *     parked in `interrupted_hold` and NEVER re-processed (no replay) — and is not readmitted by
 *     RETRY_GATES_FAILED;
 *   - idempotent publish under interruption: a second run never issues a second handoff for an
 *     entry already past the write-ahead intent (the stub counts exactly one handoff);
 *   - idempotence: a second run over a settled queue changes the held/terminal entries byte-for-byte;
 *   - lock ownership: a fresh FOREIGN lock makes the run skip cleanly and the foreign lock SURVIVES;
 *   - write-ahead ordering (static): the intent persist lands before the external handoff call.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const executor = require('../engine/orchestrator/publish-executor.js');
const publishers = require('../engine/publishers/publisher.js');
const queue = require('../engine/shared/queue.js');

// This suite runs main() many times in ONE process; each acquireLock registers a process-exit
// release handler (a per-invocation crash-safety net that is harmless across runs but trips the
// EventEmitter listener-cap warning when reused in-process). Lift the cap for the test process only
// — production runs each invocation as a fresh process.
process.setMaxListeners(0);

const REVIEWER_ID = '00000000000000001';

const SYSTEM_CONFIG = {
  schema_version: '1.0.0',
  mode: 'LIVE',
  reviewers: [{ id: REVIEWER_ID, name: 'Test Reviewer', rights: ['approve', 'edit'] }],
  budget: { monthly_cap: 50, daily_cap: 5, per_item_generation_limit: 1, indexing_requires_estimate: true },
  publish: { draft_only: true, auto_publish_allowed: false },
  approval_surface: { adapter: 'discord', channels: { 'content-review': 'c1', 'content-published': 'c2', 'content-ops': 'c3', 'media-bank': 'c4' } },
  scheduler: { kickoff_time: '09:00' },
  cooldown: { hard_days: 14, target_days: 30 },
};

// A queue with: a clean LIVE entry (hands off → handed_off), a non-LIVE entry (gated, no handoff),
// an entry stranded in the write-ahead intent state (must HOLD, never replay), and a terminal entry.
function fixtureQueue() {
  return [
    '# Publish Queue',
    '',
    '## Entry - 2026-01-01-acme-pass-01',
    '- content_id: 2026-01-01-acme-pass-01',
    '- brand: acme-cosmos',
    '- platform: twitter',
    '- format: text',
    '- mode: LIVE',
    `- approved_by: ${REVIEWER_ID}`,
    '- approved_variant: recommended',
    '- approved_copy: A clean approved post.',
    '- state: approved',
    '',
    '## Entry - 2026-01-01-acme-preview-02',
    '- content_id: 2026-01-01-acme-preview-02',
    '- brand: acme-cosmos',
    '- platform: twitter',
    '- format: text',
    '- mode: LIVE_PREVIEW',
    `- approved_by: ${REVIEWER_ID}`,
    '- approved_variant: recommended',
    '- approved_copy: A preview-only post.',
    '- state: approved',
    '',
    '## Entry - 2026-01-01-acme-intent-03',
    '- content_id: 2026-01-01-acme-intent-03',
    '- brand: acme-cosmos',
    '- platform: twitter',
    '- format: text',
    '- mode: LIVE',
    `- approved_by: ${REVIEWER_ID}`,
    '- approved_variant: recommended',
    '- approved_copy: An interrupted post.',
    '- attempt_count: 1',
    '- state: publish_intent',
    '',
    '## Entry - 2026-01-01-acme-done-04',
    '- content_id: 2026-01-01-acme-done-04',
    '- brand: acme-cosmos',
    '- platform: twitter',
    '- format: text',
    '- mode: LIVE',
    `- approved_by: ${REVIEWER_ID}`,
    '- approved_variant: recommended',
    '- state: published',
    '- external_post_ref: existing-ref',
    '',
  ].join('\n');
}

// Build a hermetic CONTENT_HOME with config + queue. Returns { env, home, queuePath }.
function buildHome(queueRaw = fixtureQueue()) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'exec-crash-safety-'));
  fs.mkdirSync(path.join(home, 'config'), { recursive: true });
  fs.mkdirSync(path.join(home, 'queue', 'locks'), { recursive: true });
  fs.mkdirSync(path.join(home, 'library'), { recursive: true });
  fs.mkdirSync(path.join(home, 'ledger'), { recursive: true });
  fs.writeFileSync(path.join(home, 'config', 'system.json'), JSON.stringify(SYSTEM_CONFIG, null, 2), 'utf8');
  fs.writeFileSync(path.join(home, 'queue', 'publish-queue.md'), queueRaw, 'utf8');
  const env = { CONTENT_HOME: home, WORKFLOW_LEDGER_DISABLE: '1' };
  return { env, home, queuePath: path.join(home, 'queue', 'publish-queue.md') };
}

// A stub publisher adapter that records every handoff (so we can assert idempotency) and returns a
// draft handoff (the second gate). Registered under 'postiz' (twitter's default binding).
function installStubPostiz() {
  const calls = [];
  const adapter = {
    name: 'postiz',
    async handoff(pkg) {
      const id = (pkg && (pkg.content_id || (pkg.audit_header && pkg.audit_header.content_id))) || 'unknown';
      calls.push(id);
      return { external_ref: `draft-${id}`, state: publishers.PUBLISH_STATE.HANDED_OFF, type: 'draft' };
    },
    async verifyStatus() {
      return { state: publishers.PUBLISH_STATE.HANDED_OFF, post_url: null };
    },
    async fetchMetrics() {
      return { supported: false, metrics: {} };
    },
    capabilities() {
      return { name: 'postiz', draft_gate: true };
    },
  };
  publishers.register('postiz', adapter);
  return { calls };
}

// Run main() in-process, capturing the executor's log lines.
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
  assert.ok(m, `entry ${contentId} present in queue`);
  return m[0];
}

test('per-entry persistence, interrupted-mid-publish holds, second-gate handoff', async () => {
  const { env, queuePath, home } = buildHome();
  const stub = installStubPostiz();

  const r1 = await runExecutor(env);
  assert.equal(r1.code, executor.EXIT.BLOCKED, `first run exits BLOCKED (held entry). stdout:\n${r1.stdout}`);

  // Per-entry persistence — transitions wrote when they happened.
  assert.match(r1.stdout, /queue persisted \(interrupted-hold\)/u, 'the intent entry persisted its hold per-entry');
  assert.match(r1.stdout, /queue persisted \(publish-intent\)/u, 'the clean entry persisted its write-ahead intent per-entry');
  assert.match(r1.stdout, /queue persisted \(handed-off\)/u, 'the handoff result persisted per-entry');

  const after1 = fs.readFileSync(queuePath, 'utf8');

  // Clean LIVE entry: write-ahead intent → handoff → handed_off (the second gate).
  const pass = entryBlock(after1, '2026-01-01-acme-pass-01');
  assert.match(pass, /- state: handed_off/u, 'clean entry reaches handed_off');
  assert.match(pass, /- external_post_ref: draft-2026-01-01-acme-pass-01/u, 'handoff ref recorded');
  assert.match(pass, /- attempt_count: 1/u, 'attempt counter spent exactly one attempt');

  // LIVE_PREVIEW entry: gated, NO publisher call, left in approved.
  const preview = entryBlock(after1, '2026-01-01-acme-preview-02');
  assert.match(preview, /- state: approved/u, 'preview-mode item is not handed off');

  // The stranded write-ahead intent is HELD (interrupted_hold), never re-processed.
  const intent = entryBlock(after1, '2026-01-01-acme-intent-03');
  assert.match(intent, /- state: interrupted_hold/u, 'intent entry parked in the dedicated hold state');
  assert.match(intent, /interrupted_mid_publish/u, 'intent entry carries the interrupted error');
  assert.ok(!r1.stdout.includes('PROCESS 2026-01-01-acme-intent-03'), 'intent entry must not be re-processed');

  // The stub handed off the clean entry exactly once; the held intent entry triggered NO handoff.
  assert.deepEqual(stub.calls, ['2026-01-01-acme-pass-01'], 'exactly one handoff; the held intent entry never replays');

  // Terminal entry untouched and skipped.
  assert.match(entryBlock(after1, '2026-01-01-acme-done-04'), /- state: published/u);
  assert.match(r1.stdout, /SKIP 2026-01-01-acme-done-04/u);

  fs.rmSync(home, { recursive: true, force: true });
});

test('idempotent publish under interruption: rerun verifies, never re-hands-off', async () => {
  const { env, queuePath, home } = buildHome();
  const stub = installStubPostiz();

  // First run: clean entry → handed_off; intent entry → interrupted_hold.
  await runExecutor(env);
  assert.equal(stub.calls.length, 1, 'first run hands off once');
  const after1 = fs.readFileSync(queuePath, 'utf8');

  // Second run: the now-handed_off entry is VERIFIED (not re-handed); the stub.verifyStatus keeps it
  // handed_off; the held entry is not replayed; the published entry stays published.
  const r2 = await runExecutor(env);
  assert.equal(stub.calls.length, 1, 'second run issues NO new handoff (idempotent)');
  assert.match(r2.stdout, /VERIFY 2026-01-01-acme-pass-01 \(state=handed_off\)/u, 'handed_off entry is verified, not re-handed');
  assert.ok(!r2.stdout.includes('PROCESS 2026-01-01-acme-intent-03'), 'held entry not replayed on rerun');

  const after2 = fs.readFileSync(queuePath, 'utf8');
  // The held + terminal entries are byte-identical across the rerun (no replay, no churn).
  for (const id of ['2026-01-01-acme-intent-03', '2026-01-01-acme-done-04']) {
    assert.equal(entryBlock(after2, id), entryBlock(after1, id), `${id} byte-identical on rerun`);
  }
  fs.rmSync(home, { recursive: true, force: true });
});

test('second-gate completion: verifyStatus advances handed_off → published + usage write-back', async () => {
  const { env, queuePath, home } = buildHome();
  // A single entry already handed off; the stub will report PUBLISHED on verify.
  const raw = [
    '# Publish Queue',
    '',
    '## Entry - 2026-01-01-acme-handed-01',
    '- content_id: 2026-01-01-acme-handed-01',
    '- brand: acme-cosmos',
    '- platform: twitter',
    '- format: image',
    '- mode: LIVE',
    `- approved_by: ${REVIEWER_ID}`,
    '- approved_variant: recommended',
    '- media_refs: media/acme/launch-card.png',
    '- external_post_ref: draft-acme-handed-01',
    '- state: handed_off',
    '',
  ].join('\n');
  fs.writeFileSync(queuePath, raw, 'utf8');

  publishers.register('postiz', {
    name: 'postiz',
    async handoff() { throw new Error('handoff must not be called for a handed_off entry'); },
    async verifyStatus(ref) {
      return { state: publishers.PUBLISH_STATE.PUBLISHED, external_ref: ref, post_url: 'https://example.test/p/1', published_at: '2026-01-02T00:00:00.000Z' };
    },
    async fetchMetrics() { return { supported: false, metrics: {} }; },
    capabilities() { return { name: 'postiz', draft_gate: true }; },
  });

  const r = await runExecutor(env);
  assert.equal(r.code, executor.EXIT.OK, `verify run exits OK. stdout:\n${r.stdout}`);
  const after = fs.readFileSync(queuePath, 'utf8');
  assert.match(entryBlock(after, '2026-01-01-acme-handed-01'), /- state: published/u, 'advanced to published');
  assert.match(after, /- post_url: https:\/\/example\.test\/p\/1/u, 'post_url recorded');

  // Usage write-back (DD-14): the published asset appended one record to the canonical ledger.
  const ledger = require('../engine/library/usage-log.js').readLedger(env);
  assert.equal(ledger.length, 1, 'one usage record written on confirmed publish');
  assert.equal(ledger[0].content_id, '2026-01-01-acme-handed-01');
  fs.rmSync(home, { recursive: true, force: true });
});

test('a fresh foreign lock makes the executor skip and SURVIVES its exit', async () => {
  const { env, queuePath, home } = buildHome();
  installStubPostiz();
  const lockPath = queue.queueLockFilePath(env);
  fs.writeFileSync(lockPath, JSON.stringify({
    pid: process.pid + 99991,
    acquired_at: new Date().toISOString(),
    owner: 'reaction-listener',
  }), 'utf8');

  const before = fs.readFileSync(queuePath, 'utf8');
  const r = await runExecutor(env);
  assert.equal(r.code, executor.EXIT.OK, `lock-held run exits OK (clean skip). stdout:\n${r.stdout}`);
  assert.match(r.stdout, /SKIP: queue lock held/u);
  assert.ok(fs.existsSync(lockPath), 'foreign lock survives the executor exit (ownership-checked release)');
  assert.equal(fs.readFileSync(queuePath, 'utf8'), before, 'queue untouched under a held lock');
  fs.rmSync(home, { recursive: true, force: true });
});

test('RETRY_GATES_FAILED never readmits an interrupted_hold entry', async () => {
  const { env, queuePath, home } = buildHome();
  installStubPostiz();
  await runExecutor(env); // settles: intent entry → interrupted_hold

  const r2 = await runExecutor({ ...env, RETRY_GATES_FAILED: '1' });
  assert.ok(!r2.stdout.includes('PROCESS 2026-01-01-acme-intent-03'), 'interrupted_hold must not be retried by the flag');
  const after = fs.readFileSync(queuePath, 'utf8');
  assert.match(entryBlock(after, '2026-01-01-acme-intent-03'), /- state: interrupted_hold/u);
  fs.rmSync(home, { recursive: true, force: true });
});

test('PAUSED sentinel halts the run before any processing', async () => {
  const { env, home } = buildHome();
  installStubPostiz();
  fs.writeFileSync(path.join(home, 'PAUSED'), '', 'utf8');
  const r = await runExecutor(env);
  assert.equal(r.code, executor.EXIT.PAUSED, 'PAUSED sentinel returns the paused exit code');
  assert.match(r.stdout, /PAUSED sentinel present/u);
  fs.rmSync(home, { recursive: true, force: true });
});

test('ENGINE_TEST_MODE=1 refuses to run', async () => {
  const { env, home } = buildHome();
  const r = await runExecutor({ ...env, ENGINE_TEST_MODE: '1' });
  assert.equal(r.code, executor.EXIT.TEST_MODE, 'ENGINE_TEST_MODE=1 returns the test-mode exit code');
  fs.rmSync(home, { recursive: true, force: true });
});

test('retry bound: a definite handoff failure marks failed_handoff, then dead-letters at the bound (DD-13)', async () => {
  const { env, queuePath, home } = buildHome([
    '# Publish Queue',
    '',
    '## Entry - 2026-03-01-acme-flaky-01',
    '- content_id: 2026-03-01-acme-flaky-01',
    '- brand: acme-cosmos',
    '- platform: twitter',
    '- format: text',
    '- mode: LIVE',
    `- approved_by: ${REVIEWER_ID}`,
    '- approved_variant: recommended',
    '- approved_copy: A post whose backend rejects it.',
    '- state: approved',
    '',
  ].join('\n'));

  // An adapter whose backend DEFINITELY rejects (httpStatus present ⇒ no artifact ⇒ retryable fail).
  let calls = 0;
  publishers.register('postiz', {
    name: 'postiz',
    async handoff() { calls++; const e = new Error('backend rejected'); e.httpStatus = 400; e.phase = 'post'; throw e; },
    async verifyStatus() { return { state: publishers.PUBLISH_STATE.HANDED_OFF }; },
    async fetchMetrics() { return { supported: false, metrics: {} }; },
    capabilities() { return { name: 'postiz', draft_gate: true }; },
  });

  // Run 1: attempt_count 0 → 1, definite fail → failed_handoff.
  let r = await runExecutor(env);
  assert.equal(r.code, executor.EXIT.BLOCKED);
  assert.match(entryBlock(fs.readFileSync(queuePath, 'utf8'), '2026-03-01-acme-flaky-01'), /- state: failed_handoff/u);
  assert.match(fs.readFileSync(queuePath, 'utf8'), /- attempt_count: 1/u, 'attempt counter spent before the call');

  // Runs 2 and 3 (with the operator retry flag): 1→2, 2→3.
  r = await runExecutor({ ...env, RETRY_GATES_FAILED: '1' });
  assert.match(fs.readFileSync(queuePath, 'utf8'), /- attempt_count: 2/u);
  r = await runExecutor({ ...env, RETRY_GATES_FAILED: '1' });
  assert.match(fs.readFileSync(queuePath, 'utf8'), /- attempt_count: 3/u);

  // Run 4: attempt_count is now at the bound (3) → dead-lettered + unfilled-slot notice; no 4th call.
  const callsBefore = calls;
  r = await runExecutor({ ...env, RETRY_GATES_FAILED: '1' });
  assert.equal(calls, callsBefore, 'no handoff attempt once the retry bound is reached');
  const after = fs.readFileSync(queuePath, 'utf8');
  assert.match(entryBlock(after, '2026-03-01-acme-flaky-01'), /- state: dead_lettered/u, 'dead-lettered at the bound');
  assert.match(r.stdout, /UNFILLED-SLOT NOTICE/u, 'unfilled-slot notice emitted on dead-letter (DD-13/DD-15)');
  assert.equal(calls, 3, 'exactly RETRY_BOUND handoff attempts were made');
  fs.rmSync(home, { recursive: true, force: true });
});

test('write-ahead ordering: persist lands before the external handoff call (static)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'engine', 'orchestrator', 'publish-executor.js'), 'utf8');
  const intentPersist = src.indexOf("persistQueue('publish-intent')");
  const handoffCall = src.indexOf('await handoffOne(entry, ctx)');
  assert.ok(intentPersist > -1 && handoffCall > -1 && intentPersist < handoffCall,
    'the publish-intent persist must precede the handoff call (write-ahead intent, DD-4)');

  const handedPersist = src.indexOf("persistQueue('handed-off')");
  const handoffNotify = src.indexOf('notifyHandoff(entry, ctx,');
  assert.ok(handedPersist > -1 && handoffNotify > -1 && handedPersist < handoffNotify,
    'the handoff result must persist before the best-effort notify');

  const publishedPersist = src.indexOf("persistQueue('published')");
  // The call sites carry a trailing ';'; the function definition does not — so this targets a call.
  const usageWriteback = src.indexOf('recordUsageOnPublish(entry, ctx);');
  assert.ok(publishedPersist > -1 && usageWriteback > -1 && publishedPersist < usageWriteback,
    'the published record must persist before the usage write-back (DD-14)');
});
