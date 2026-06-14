'use strict';

/**
 * Tests for the canonical queue-writer primitives (spec §16.1):
 *  - writeFileAtomic: the ONE atomic write primitive (tmp+rename, EPERM-retry)
 *  - appendEntryBlock: atomic append with stable separator semantics
 *  - setEntryState: transition by content_id with an optional from-state guard,
 *    via the canonical parse/serialize pair (no regex patching of state lines).
 *    Includes the duplicate-header safety case: matching by content_id and
 *    re-serializing the specific entry means a transition never leaks onto a
 *    same-header sibling.
 *
 * All fixture ids/values are synthetic placeholders (no instance data).
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const q = require('../queue.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'queue-writers-'));
}

const FIXTURE = [
  '## Entry - 2026-01-01-qa-one',
  '- content_id: 2026-01-01-qa-one',
  '- brand: acme-cosmos',
  '- platform: twitter',
  '- state: handed_off',
  '- external_post_ref: draft-111',
  '- media_path: library/media/foo bar.png', // unknown-to-FIELD_ORDER field
  '- approved_copy: |-',
  '  line one of the copy',
  '',
  '  line three after a blank',
  '',
  '## Entry - 2026-01-02-qa-two',
  '- content_id: 2026-01-02-qa-two',
  '- brand: acme-cosmos',
  '- platform: giphy',
  '- state: awaiting_approval',
  '',
].join('\n');

test('writeFileAtomic replaces content and leaves no tmp file', () => {
  const file = path.join(tmpDir(), 'f.md');
  q.writeFileAtomic(file, 'one\n');
  q.writeFileAtomic(file, 'two\n');
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'two\n');
  assert.ok(!fs.existsSync(`${file}.tmp`), 'tmp cleaned up by rename');
});

test('appendEntryBlock matches the documented separator semantics byte-for-byte', () => {
  const block = '## Entry - 2026-01-03-qa-new\n- content_id: 2026-01-03-qa-new\n- state: awaiting_approval';
  const oldAlgo = (cur) => cur + (cur.endsWith('\n') ? '\n' : '\n\n') + block + '\n';

  // Case 1: newline-terminated existing file
  const f1 = path.join(tmpDir(), 'q.md');
  fs.writeFileSync(f1, FIXTURE, 'utf8');
  q.appendEntryBlock(f1, block);
  assert.strictEqual(fs.readFileSync(f1, 'utf8'), oldAlgo(FIXTURE));

  // Case 2: no trailing newline
  const f2 = path.join(tmpDir(), 'q.md');
  fs.writeFileSync(f2, FIXTURE.trimEnd(), 'utf8');
  q.appendEntryBlock(f2, block);
  assert.strictEqual(fs.readFileSync(f2, 'utf8'), oldAlgo(FIXTURE.trimEnd()));

  // Case 3: missing file
  const f3 = path.join(tmpDir(), 'q.md');
  q.appendEntryBlock(f3, block);
  assert.strictEqual(fs.readFileSync(f3, 'utf8'), block + '\n');

  // Appended entry parses back
  const entries = q.parseQueue(fs.readFileSync(f1, 'utf8'));
  assert.strictEqual(entries.length, 3);
  assert.strictEqual(entries[2].fields.content_id, '2026-01-03-qa-new');
});

test('setEntryState transitions with from-guard and preserves untouched entries byte-identically', () => {
  const file = path.join(tmpDir(), 'q.md');
  fs.writeFileSync(file, FIXTURE, 'utf8');

  // from-guard mismatch refuses and writes nothing
  const before = fs.readFileSync(file, 'utf8');
  const refused = q.setEntryState(file, '2026-01-01-qa-one', { from: 'awaiting_approval', to: 'published' });
  assert.strictEqual(refused.ok, false);
  assert.match(refused.reason, /expected 'awaiting_approval'/u);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), before, 'refused transition writes nothing');

  // unknown entry
  assert.strictEqual(q.setEntryState(file, 'nope', { to: 'published' }).ok, false);

  // happy path with extra fields
  const r = q.setEntryState(file, '2026-01-01-qa-one', {
    from: 'handed_off',
    to: 'published',
    fields: { published_at: '2026-06-11T00:00:00.000Z', external_post_ref: 'post-1' },
  });
  assert.deepStrictEqual(r, { ok: true, previous: 'handed_off' });

  const after = fs.readFileSync(file, 'utf8');
  const entries = q.parseQueue(after);
  const one = entries.find((e) => e.header === '2026-01-01-qa-one');
  assert.strictEqual(one.fields.state, 'published');
  assert.strictEqual(one.fields.published_at, '2026-06-11T00:00:00.000Z');
  assert.strictEqual(one.fields.media_path, 'library/media/foo bar.png', 'unknown field preserved');
  assert.strictEqual(one.fields.approved_copy, 'line one of the copy\n\nline three after a blank', 'block scalar preserved');

  // untouched entry's raw block is byte-identical
  const blockTwoBefore = before.slice(before.indexOf('## Entry - 2026-01-02-qa-two'));
  const blockTwoAfter = after.slice(after.indexOf('## Entry - 2026-01-02-qa-two'));
  assert.strictEqual(blockTwoAfter, blockTwoBefore);
});

test('setEntryState from-guard protects same-header siblings: the wrong-state twin is refused, leaving the queue unchanged', () => {
  // Two entries share a header (a real production shape). setEntryState matches the
  // FIRST entry by content_id; the from-guard then refuses if that first match is
  // not in the expected state, so a transition cannot silently land on the wrong
  // block (the safety the from-guard provides for duplicate-header groups).
  const raw = [
    '## Entry - 2026-01-05-qa-dup',
    '- content_id: 2026-01-05-qa-dup',
    '- state: hard_failed',
    '- error: first attempt failed',
    '',
    '## Entry - 2026-01-05-qa-dup',
    '- content_id: 2026-01-05-qa-dup',
    '- state: handed_off',
    '- external_post_ref: draft-555',
    '',
  ].join('\n');
  const file = path.join(tmpDir(), 'q.md');
  fs.writeFileSync(file, raw, 'utf8');
  const before = fs.readFileSync(file, 'utf8');

  // The first content_id match is the hard_failed twin; with from='handed_off'
  // the guard refuses and nothing is written — the wrong block is never patched.
  const r = q.setEntryState(file, '2026-01-05-qa-dup', {
    from: 'handed_off',
    to: 'published',
    fields: { external_post_ref: 'post-5' },
  });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /expected 'handed_off'/u);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), before, 'refused transition writes nothing');

  // Both twins are intact.
  const out = q.parseQueue(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0].fields.state, 'hard_failed');
  assert.strictEqual(out[0].fields.error, 'first attempt failed');
  assert.strictEqual(out[1].fields.state, 'handed_off');
  assert.strictEqual(out[1].fields.external_post_ref, 'draft-555');
});
