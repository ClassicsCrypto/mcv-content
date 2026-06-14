'use strict';

/**
 * Unit tests for the lock-ownership + heartbeat hardening (spec §16.1):
 *  - ownsLock / touchLock: only the owning process (pid match) can refresh a
 *    lock's mtime; a foreign or missing lock is never touched (this is the
 *    heartbeat that keeps a long-but-alive holder from being judged stale).
 *  - releaseLock: refuses to unlink a lock owned by another pid unless
 *    { force: true } (an unconditional unlink could remove a legitimately
 *    reclaimed lock and let a third writer into the critical section).
 *  - statSnapshot / statChanged: the refuse-to-overwrite change detector used
 *    before every queue rewrite.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const q = require('../queue.js');

function tmpFile(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-ownership-'));
  return path.join(dir, name);
}

test('touchLock refreshes mtime on an owned lock (heartbeat)', () => {
  const lockPath = tmpFile('.publish-queue.lock');
  const r = q.acquireLock(lockPath, { owner: 'test', register: false });
  assert.strictEqual(r.acquired, true);
  assert.strictEqual(q.ownsLock(lockPath), true);

  // Age the lock artificially, then heartbeat it back to fresh.
  const past = new Date(Date.now() - 8 * 60 * 1000);
  fs.utimesSync(lockPath, past, past);
  const agedMtime = fs.statSync(lockPath).mtimeMs;

  assert.strictEqual(q.touchLock(lockPath), true);
  const freshMtime = fs.statSync(lockPath).mtimeMs;
  assert.ok(freshMtime > agedMtime + 7 * 60 * 1000, `mtime should jump to ~now (was ${agedMtime}, now ${freshMtime})`);
});

test('touchLock and releaseLock refuse a foreign lock; force overrides', () => {
  const lockPath = tmpFile('.publish-queue.lock');
  fs.writeFileSync(lockPath, JSON.stringify({
    pid: process.pid + 99991,
    acquired_at: new Date().toISOString(),
    owner: 'someone-else',
  }), 'utf8');

  assert.strictEqual(q.ownsLock(lockPath), false);

  const before = fs.statSync(lockPath).mtimeMs;
  assert.strictEqual(q.touchLock(lockPath), false);
  assert.strictEqual(fs.statSync(lockPath).mtimeMs, before, 'foreign lock mtime must not change');

  assert.strictEqual(q.releaseLock(lockPath), false);
  assert.ok(fs.existsSync(lockPath), 'foreign lock must survive a non-forced release');

  assert.strictEqual(q.releaseLock(lockPath, { force: true }), true);
  assert.ok(!fs.existsSync(lockPath), 'forced release unlinks');
});

test('touchLock/ownsLock on a missing lock are safe no-ops', () => {
  const lockPath = tmpFile('.publish-queue.lock'); // never created
  assert.strictEqual(q.ownsLock(lockPath), false);
  assert.strictEqual(q.touchLock(lockPath), false);
  assert.strictEqual(q.releaseLock(lockPath), false);
});

test('an owned lock still releases normally', () => {
  const lockPath = tmpFile('.publish-queue.lock');
  q.acquireLock(lockPath, { owner: 'test', register: false });
  assert.strictEqual(q.releaseLock(lockPath), true);
  assert.ok(!fs.existsSync(lockPath));
});

test('statSnapshot/statChanged detect foreign writes and missing files', () => {
  const filePath = tmpFile('queue.md');
  fs.writeFileSync(filePath, 'one\n', 'utf8');
  const snap = q.statSnapshot(filePath);
  assert.ok(snap && typeof snap.mtimeMs === 'number' && snap.size === 4);

  assert.strictEqual(q.statChanged(filePath, snap), false, 'untouched file is unchanged');

  fs.appendFileSync(filePath, 'two\n');
  assert.strictEqual(q.statChanged(filePath, snap), true, 'size delta detected');

  // mtime-only delta (same size): rewrite same content with a future mtime
  fs.writeFileSync(filePath, 'one\n', 'utf8');
  const snap2 = q.statSnapshot(filePath);
  const future = new Date(Date.now() + 5000);
  fs.utimesSync(filePath, future, future);
  assert.strictEqual(q.statChanged(filePath, snap2), true, 'mtime delta detected');

  assert.strictEqual(q.statSnapshot(path.join(path.dirname(filePath), 'missing.md')), null);
  assert.strictEqual(q.statChanged(path.join(path.dirname(filePath), 'missing.md'), snap), true);
  assert.strictEqual(q.statChanged(filePath, null), true, 'null snapshot treated as changed');
});
