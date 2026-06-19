'use strict';

/**
 * tests/ingest-text-mode.test.js  [N — new tests, SETUP-CONTENT-LIBRARY]
 *
 * Covers the C2 intake text-mode knob (release-spec §1.1/§2.4; the "keep as raw or stripped" choice):
 * engine/sources/ingest/source.js stripText + normalizeItem text mode + ingestConfig resolution, and
 * the `engine ingest-brand --store` flag validation. The guarantees that matter:
 *   - `raw` (default) stores post text verbatim; `stripped` stores a cleaned, smaller form.
 *   - stripping is DETERMINISTIC and voice-preserving: it removes URLs + collapses whitespace, and
 *     NEVER summarizes/paraphrases or changes word choice.
 *   - stripping NEVER drops an otherwise-textful item (URL-only falls back to the trimmed original).
 *   - the Zone-U governance contract is untouched: trust_class + retention_class still stamped.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const source = require('../engine/sources/ingest/source.js');
const ingestBrand = require('../engine/cli/ingest-brand.js');

test('stripText removes URLs + collapses whitespace, preserves words (no summarizing)', () => {
  const out = source.stripText('Big   news!\n\nRead: https://t.co/abc and www.example.com/x  now');
  assert.equal(out, 'Big news! Read: and now');
  // word choice preserved (no paraphrase), just URLs + whitespace gone.
  assert.ok(out.includes('Big news!') && out.includes('Read:') && out.includes('now'));
});

test('normalizeItem: raw keeps text verbatim; stripped cleans it', () => {
  const raw = source.normalizeItem({ text: 'hello   world https://t.co/z' }, { textMode: 'raw' });
  assert.equal(raw.item.text, 'hello   world https://t.co/z'.trim());
  const stripped = source.normalizeItem({ text: 'hello   world https://t.co/z' }, { textMode: 'stripped' });
  assert.equal(stripped.item.text, 'hello world');
});

test('stripped NEVER drops an otherwise-textful item (URL-only falls back to trimmed original)', () => {
  const item = source.normalizeItem({ text: '  https://t.co/onlyalink  ' }, { textMode: 'stripped' });
  assert.ok(item, 'a post that is only a URL still becomes a corpus item');
  assert.equal(item.item.text, 'https://t.co/onlyalink'); // fell back to the trimmed original (non-empty)
});

test('text mode does NOT weaken the Zone-U governance contract (trust + retention still stamped)', () => {
  const item = source.normalizeItem({ text: 'a post   with   spaces' }, { textMode: 'stripped', retention_class: 'transient' });
  assert.equal(item.item.trust_class, source.TRUST_CLASS.UNTRUSTED_SCRAPED);
  assert.equal(item.item.retention_class, 'transient');
  assert.equal(item.item.text, 'a post with spaces');
});

test('ingestConfig resolves text_mode: default raw, stripped honored, bogus falls back to raw', () => {
  assert.equal(source.ingestConfig({}).text_mode, 'raw');
  assert.equal(source.ingestConfig({ ingest: { text_mode: 'stripped' } }).text_mode, 'stripped');
  assert.equal(source.ingestConfig({ ingest: { text_mode: 'nonsense' } }).text_mode, 'raw');
});

test('ingestRawItems threads textMode through to every item', () => {
  const res = source.ingestRawItems(
    [{ text: 'one   two https://t.co/a' }, { text: 'three\n\nfour' }],
    { brand: 'b', textMode: 'stripped', write: false, source: source.SOURCE.MANUAL },
  );
  assert.deepEqual(res.items.map((i) => i.text), ['one two', 'three four']);
});

test('engine ingest-brand --store rejects an invalid mode (exit 2)', async () => {
  const res = await ingestBrand.run({ flags: { brand: 'demo', store: 'bogus' }, env: {} });
  assert.equal(res.exitCode, 2);
  assert.match(res.summary, /invalid --store/i);
});
