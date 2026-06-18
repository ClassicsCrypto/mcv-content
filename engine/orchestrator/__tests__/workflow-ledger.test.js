'use strict';

/**
 * Tests for engine/orchestrator/workflow-ledger.js (release-spec §16.1 entry-point coverage;
 * §13.1 event-ledger substrate; §13.3 redact-at-write).
 *
 * Zero-key, CONTENT_HOME-injected: every call passes a temp-dir env so the suite needs no
 * real instance and never touches a developer's $CONTENT_HOME. Uses node:test + node:assert
 * (no external test deps — the engine ships dependencies with in-tree consumers only).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ledger = require('../workflow-ledger');

/** Build a throwaway CONTENT_HOME and an env object pointing at it. */
function tmpEnv() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oce-ledger-'));
  return { CONTENT_HOME: home };
}

function readEventsFile(env) {
  return fs
    .readFileSync(ledger.eventsPath(env), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

test('records under $CONTENT_HOME/ledger via paths.js (no path constants)', () => {
  const env = tmpEnv();
  ledger.recordEvent('c-1', 'planned', { status: 'planned' }, {}, env);
  assert.ok(ledger.recordsDir(env).startsWith(env.CONTENT_HOME));
  assert.ok(ledger.eventsPath(env).startsWith(env.CONTENT_HOME));
  assert.ok(fs.existsSync(path.join(env.CONTENT_HOME, 'ledger', 'records', 'c-1.json')));
  assert.ok(fs.existsSync(path.join(env.CONTENT_HOME, 'ledger', 'events.jsonl')));
});

test('append + query round-trip: record rollup and event stream', () => {
  const env = tmpEnv();
  ledger.runDispatched({ content_id: 'c-2', slot_id: 'slot-a', platform: 'twitter' }, env);
  ledger.previewPosted({ content_id: 'c-2', preview_message_id: 'm1' }, env);

  const rec = ledger.readRecord('c-2', env);
  assert.equal(rec.content_id, 'c-2');
  assert.equal(rec.run.slot_id, 'slot-a');
  assert.equal(rec.discord.preview_message_id, 'm1');
  assert.equal(rec.last_event.event_type, 'preview_posted');

  const events = ledger.readEvents('c-2', env);
  assert.equal(events.length, 2);
  assert.equal(events[0].event_type, 'run_dispatched');
  assert.equal(events[1].event_type, 'preview_posted');
});

test('state vocabulary: production labels normalize to §8.2 states', () => {
  const env = tmpEnv();
  assert.equal(ledger.runDispatched({ content_id: 'c-3' }, env).status, 'seeded');
  assert.equal(ledger.previewPosted({ content_id: 'c-3' }, env).status, 'awaiting_approval');
  assert.equal(ledger.approvedQueued({ content_id: 'c-3' }, env).status, 'approved');
  assert.equal(ledger.rejected({ content_id: 'c-4' }, env).status, 'rejected');
  assert.equal(
    ledger.handoffUpdated({ content_id: 'c-5', queue_state: 'published' }, env).status,
    'published',
  );
  // Unknown labels pass through unchanged (never silently swallowed).
  assert.equal(ledger.mapState('some_future_state'), 'some_future_state');
});

test('redact-at-write: secrets never reach the record or the event stream', () => {
  const env = tmpEnv();
  const token = 'abcdefghijklmnopqrstuvwx.yzABCD.efghijklmnopqrstuvwxyz0123456';
  ledger.recordEvent(
    'c-6',
    'dispatch',
    { run: { POSTIZ_API_KEY: token, note: `Bearer ${token}` } },
    { POSTIZ_API_KEY: token },
    env,
  );
  const recRaw = fs.readFileSync(
    path.join(env.CONTENT_HOME, 'ledger', 'records', 'c-6.json'),
    'utf8',
  );
  const evRaw = fs.readFileSync(ledger.eventsPath(env), 'utf8');
  assert.ok(!recRaw.includes(token), 'token must not appear in the record file');
  assert.ok(!evRaw.includes(token), 'token must not appear in events.jsonl');
  assert.ok(recRaw.includes('[REDACTED]'), 'sensitive field is masked in the record');
});

test('CONTENT_HOME-relative artifact paths (no absolute leak)', () => {
  const env = tmpEnv();
  const abs = path.join(env.CONTENT_HOME, 'queue', 'publish-queue.md');
  const rec = ledger.approvedQueued(
    { content_id: 'c-7', package_path: abs, queue_path: abs },
    env,
  );
  assert.equal(rec.handoff.queue_path, 'queue/publish-queue.md');
  assert.equal(rec.package.path, 'queue/publish-queue.md');
  assert.ok(!JSON.stringify(rec).includes(env.CONTENT_HOME));
});

test('WORKFLOW_LEDGER_DISABLE=1 is a no-op', () => {
  const env = { ...tmpEnv(), WORKFLOW_LEDGER_DISABLE: '1' };
  assert.equal(ledger.recordEvent('c-8', 'planned', {}, {}, env), null);
  assert.ok(!fs.existsSync(ledger.eventsPath(env)));
});

test('atomic rollup merges deeply across multiple events', () => {
  const env = tmpEnv();
  ledger.packageValidation(
    { content_id: 'c-9', pass: true, platform: 'twitter', package_path: 'pkg.json', details: {} },
    env,
  );
  ledger.executorGateResults({ content_id: 'c-9', failed: [], results: { approver: 'ok' } }, env);
  const rec = ledger.readRecord('c-9', env);
  assert.equal(rec.package.platform, 'twitter');
  assert.equal(rec.gates.executor.results.approver, 'ok');
  assert.equal(rec.status, 'publish_intent');
  assert.equal(ledger.statusOf('c-9', env), 'publish_intent');
  assert.deepEqual(ledger.listContentIds(env), ['c-9']);
});

test('empty content id is rejected (no record written)', () => {
  const env = tmpEnv();
  assert.equal(ledger.recordEvent('   ', 'x', {}, {}, env), null);
  assert.equal(ledger.readEvents(null, env).length, 0);
});
