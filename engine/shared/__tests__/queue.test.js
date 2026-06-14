'use strict';

/**
 * Characterization + round-trip tests for engine/shared/queue.js  (spec §16.1).
 *
 * These pin the parser/serializer's correct, tested properties so any future
 * change to the canonical queue module stays byte-stable for downstream writers:
 *   - block-scalar (multi-line) field bodies round-trip (the data-loss bug a
 *     single-line parser introduces);
 *   - CRLF endings parse without trailing \r;
 *   - serializeQueue rewrites ONLY mutated entries, leaving others byte-identical;
 *   - the canonical write-lock is atomic, mtime-stale-reclaiming, and blocking
 *     acquire raises ELOCKTIMEOUT on a fresh held lock.
 *
 * All fixture ids are synthetic placeholders (spec §16.1 — no instance data).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const q = require('../queue.js');

// A representative queue: two entries; the second carries a multi-line
// block-scalar field (the shape a single-line parser would corrupt).
const FIXTURE = [
  '# Publish Queue',
  '',
  '## Entry - 2026-05-14-acme-thu-01',
  '- content_id: 2026-05-14-acme-thu-01',
  '- brand: acme-cosmos',
  '- platform: twitter',
  '- state: awaiting_approval',
  '- approved_copy: A single-line approved post.',
  '',
  '## Entry - 2026-05-14-acme-thu-02',
  '- content_id: 2026-05-14-acme-thu-02',
  '- brand: acme-cosmos',
  '- platform: twitter',
  '- approved_copy: |-',
  '  First paragraph of the approved copy.',
  '  ',
  '  Second paragraph with a number like 42.',
  '- state: awaiting_approval',
  '',
].join('\n');

// The old single-line matcher, reproduced to document the divergence it caused.
function legacySingleLineParseFields(lines) {
  const fields = {};
  for (const line of lines) {
    const m = line.match(/^-\s+([a-z_][a-z0-9_]*):\s*(.*)/i);
    if (m) fields[m[1].trim()] = m[2].trim().replace(/\r$/u, '');
  }
  return fields;
}

test('parseQueue splits entries and captures headers', () => {
  const entries = q.parseQueue(FIXTURE);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].header, '2026-05-14-acme-thu-01');
  assert.equal(entries[1].header, '2026-05-14-acme-thu-02');
});

test('parseFields reads single-line values', () => {
  const entries = q.parseQueue(FIXTURE);
  assert.equal(entries[0].fields.brand, 'acme-cosmos');
  assert.equal(entries[0].fields.platform, 'twitter');
  assert.equal(entries[0].fields.approved_copy, 'A single-line approved post.');
});

test('parseFields collects multi-line block-scalar values (the key fix)', () => {
  const entries = q.parseQueue(FIXTURE);
  const copy = entries[1].fields.approved_copy;
  assert.equal(
    copy,
    'First paragraph of the approved copy.\n\nSecond paragraph with a number like 42.',
  );
  // The `state` field after the block must still be read (block collection stops
  // at the next `- key:` line).
  assert.equal(entries[1].fields.state, 'awaiting_approval');
});

test('REGRESSION: the legacy single-line parser corrupts block scalars', () => {
  const lines = FIXTURE.split('\n').slice(10); // entry 2 body
  const legacy = legacySingleLineParseFields(lines);
  // The bug: the block indicator becomes the literal value and the body is dropped.
  assert.equal(legacy.approved_copy, '|-');
  assert.notEqual(legacy.approved_copy, q.parseQueue(FIXTURE)[1].fields.approved_copy);
});

test('CRLF line endings parse without trailing \\r', () => {
  const crlf = FIXTURE.replace(/\n/g, '\r\n');
  const entries = q.parseQueue(crlf);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].fields.platform, 'twitter');
  assert.equal(entries[0].fields.state, 'awaiting_approval');
  assert.equal(
    entries[1].fields.approved_copy,
    'First paragraph of the approved copy.\n\nSecond paragraph with a number like 42.',
  );
});

test('serializeEntry -> parse round-trips a block-scalar value', () => {
  const entries = q.parseQueue(FIXTURE);
  const serialized = q.serializeEntry(entries[1]);
  const reparsed = q.parseQueue(serialized);
  assert.equal(reparsed.length, 1);
  assert.deepEqual(reparsed[0].fields, entries[1].fields);
});

test('serializeQueue with no mutations is a verbatim passthrough', () => {
  const entries = q.parseQueue(FIXTURE);
  // No entry marked _mutated -> output equals input (modulo trailing-newline norm).
  const out = q.serializeQueue(FIXTURE, entries);
  assert.equal(out, FIXTURE.replace(/\s*$/u, '\n'));
});

test('serializeQueue rewrites ONLY mutated entries, leaving others byte-identical', () => {
  const entries = q.parseQueue(FIXTURE);
  entries[1]._mutated = true;
  entries[1].fields.state = 'published';
  const out = q.serializeQueue(FIXTURE, entries);

  // Entry 0's region is untouched.
  assert.ok(out.includes('- approved_copy: A single-line approved post.'));
  // Entry 1 reflects the mutation and preserves its block scalar.
  const reparsed = q.parseQueue(out);
  assert.equal(reparsed[1].fields.state, 'published');
  assert.equal(
    reparsed[1].fields.approved_copy,
    'First paragraph of the approved copy.\n\nSecond paragraph with a number like 42.',
  );
});

test('idempotent canonicalization: parse -> mark all mutated -> serialize -> re-parse', () => {
  const first = q.parseQueue(FIXTURE);
  assert.ok(first.length > 0);
  const marked = first.map((e) => ({ ...e, _mutated: true }));
  const rewritten = q.serializeQueue(FIXTURE, marked);
  const second = q.parseQueue(rewritten);

  assert.equal(second.length, first.length, 'entry count changed under round-trip');
  for (let i = 0; i < first.length; i++) {
    assert.equal(second[i].header, first[i].header, `header drift at entry ${i}`);
    assert.deepEqual(
      second[i].fields, first[i].fields,
      `field drift at entry ${i} (${first[i].header})`,
    );
  }
});

// ---- Lock helpers (DD-19) ----

test('acquireLock writes a fresh lock and reports acquired', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'q-lock-'));
  const lock = path.join(dir, '.q.lock');
  try {
    const r = q.acquireLock(lock, { register: false });
    assert.equal(r.acquired, true);
    assert.ok(fs.existsSync(lock));
    const info = q.readLockInfo(lock);
    assert.equal(info.pid, process.pid);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('acquireLock backs off when a FRESH lock is held by someone else', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'q-lock-'));
  const lock = path.join(dir, '.q.lock');
  try {
    fs.writeFileSync(lock, JSON.stringify({
      pid: 999999, acquired_at: new Date().toISOString(), host: 'other',
    }));
    const r = q.acquireLock(lock, { register: false });
    assert.equal(r.acquired, false);
    assert.equal(r.heldBy.pid, 999999);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('acquireLock reclaims a STALE lock', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'q-lock-'));
  const lock = path.join(dir, '.q.lock');
  try {
    const old = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h ago
    fs.writeFileSync(lock, JSON.stringify({ pid: 1, acquired_at: old, host: 'other' }));
    const oldDate = new Date(Date.now() - 60 * 60 * 1000);
    fs.utimesSync(lock, oldDate, oldDate); // staleness is judged by mtime, so age the file
    const r = q.acquireLock(lock, { register: false, staleMinutes: 9 });
    assert.equal(r.acquired, true);
    assert.equal(q.readLockInfo(lock).pid, process.pid);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('releaseLock removes the lock file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'q-lock-'));
  const lock = path.join(dir, '.q.lock');
  try {
    q.acquireLock(lock, { register: false });
    assert.ok(fs.existsSync(lock));
    assert.equal(q.releaseLock(lock), true);
    assert.ok(!fs.existsSync(lock));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('acquireLock is atomic: a second acquire fails while the lock is held', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'q-lock-'));
  const lock = path.join(dir, '.q.lock');
  try {
    const first = q.acquireLock(lock, { register: false });
    assert.equal(first.acquired, true);
    const second = q.acquireLock(lock, { register: false });
    assert.equal(second.acquired, false);
    assert.equal(second.heldBy.pid, process.pid);
    // ageMs derives from file mtime vs Date.now(); FS-timestamp precision can make
    // it a hair negative — only its finiteness matters here.
    assert.ok(Number.isFinite(second.ageMs));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('queueLockPath places the canonical basename in the given dir', () => {
  const p = q.queueLockPath(path.join('a', 'b', 'locks'));
  assert.equal(path.basename(p), q.QUEUE_LOCK_BASENAME);
  assert.equal(q.QUEUE_LOCK_BASENAME, '.publish-queue.lock');
});

test('acquireLockBlocking acquires immediately when free', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'q-lock-'));
  const lock = path.join(dir, '.q.lock');
  try {
    const r = q.acquireLockBlocking(lock, { register: false, timeoutMs: 1000 });
    assert.equal(r.acquired, true);
    assert.ok(fs.existsSync(lock));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('acquireLockBlocking throws ELOCKTIMEOUT when a fresh lock is held', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'q-lock-'));
  const lock = path.join(dir, '.q.lock');
  try {
    fs.writeFileSync(lock, JSON.stringify({
      pid: 4242, acquired_at: new Date().toISOString(), owner: 'holder',
    }));
    assert.throws(
      () => q.acquireLockBlocking(lock, { register: false, timeoutMs: 60, pollMs: 20 }),
      (e) => e.code === 'ELOCKTIMEOUT',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('acquireLockBlocking reclaims a stale lock', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'q-lock-'));
  const lock = path.join(dir, '.q.lock');
  try {
    const old = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    fs.writeFileSync(lock, JSON.stringify({ pid: 1, acquired_at: old, owner: 'dead' }));
    const oldDate = new Date(Date.now() - 60 * 60 * 1000);
    fs.utimesSync(lock, oldDate, oldDate); // staleness is judged by mtime, so age the file
    const r = q.acquireLockBlocking(lock, { register: false, timeoutMs: 1000, staleMinutes: 9 });
    assert.equal(r.acquired, true);
    assert.equal(q.readLockInfo(lock).pid, process.pid);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
