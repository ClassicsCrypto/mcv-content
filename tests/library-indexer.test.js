'use strict';

/**
 * tests/library-indexer.test.js  [N — NEW tests for the LIB-CORE media indexer]
 *
 * Covers engine/library/indexer.js + engine/library/index-store.js (release-spec §1.5 auto-index;
 * §7.8 archive-index-entry contract; §15.4 / DD-18 estimate-and-confirm; DD-21 empty-library).
 *
 * ZERO-KEY (RD-12): every test injects a FAKE visionFn — no provider block, no secret, no child
 * process, no network. CI holds no keys. A real temp CONTENT_HOME with real (tiny) media files
 * exercises the scan + fingerprint + atomic write paths; the clock/IO are real but isolated.
 *
 * Asserts:
 *   - DD-18: build halts awaiting confirmation (no vision call) until yes:true;
 *   - estimate-only spends nothing and reports the asset count × band;
 *   - a confirmed build produces schema-valid archive-index-entries with description/tags/type;
 *   - the written index carries BOTH `assets` (check.js reads) and `entries` (C4 reads);
 *   - incremental/idempotent: a second run skips all assets and NEVER re-calls the vision fn;
 *   - an edited asset (new bytes) is re-indexed; --force re-indexes everything;
 *   - empty/absent media dir is a clean no-op (DD-21), no throw;
 *   - a per-asset vision failure is recorded and never aborts the run / corrupts the index.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const indexer = require('../engine/library/indexer.js');
const store = require('../engine/library/index-store.js');
const check = require('../engine/library/check.js');

/** Spin up an isolated CONTENT_HOME with a media tree; returns { env, home, mediaDir }. */
function withHome(files) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oce-idx-'));
  const mediaDir = path.join(home, 'library', 'media');
  fs.mkdirSync(mediaDir, { recursive: true });
  for (const [rel, bytes] of Object.entries(files || {})) {
    const abs = path.join(mediaDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, bytes);
  }
  return { env: { CONTENT_HOME: home }, home, mediaDir };
}

function cleanup(home) {
  fs.rmSync(home, { recursive: true, force: true });
}

/** A counting fake vision fn that returns a deterministic description/tags per asset. */
function fakeVision() {
  let calls = 0;
  const seen = [];
  const fn = (asset) => {
    calls += 1;
    seen.push(asset.path);
    return {
      description: `a synthetic asset at ${asset.path}`,
      tags: ['synthetic', asset.type, path.basename(asset.path, path.extname(asset.path))],
      type: asset.type,
      ...(asset.type === 'video' ? { duration: 12 } : {}),
    };
  };
  fn.calls = () => calls;
  fn.seen = () => seen.slice();
  return fn;
}

test('DD-18: build halts awaiting confirmation and makes NO vision call until yes', async () => {
  const { env, home } = withHome({ 'a.png': 'img-a', 'b.jpg': 'img-b' });
  try {
    const vision = fakeVision();
    const res = await indexer.buildLibraryIndex({ env, visionFn: vision });
    assert.equal(res.awaiting_confirmation, true);
    assert.equal(res.ok, false);
    assert.equal(res.indexed, 0);
    assert.equal(vision.calls(), 0, 'no vision call before confirmation');
    assert.equal(res.estimate.asset_count, 2);
    // Index file not written.
    assert.equal(fs.existsSync(path.join(home, 'library', 'index.json')), false);
  } finally {
    cleanup(home);
  }
});

test('estimate-only reports count × band and spends nothing', async () => {
  const { env, home } = withHome({ 'a.png': 'x', 'sub/b.mp4': 'y' });
  try {
    const vision = fakeVision();
    const res = await indexer.buildLibraryIndex({ env, estimateOnly: true, visionFn: vision });
    assert.equal(res.status, 'estimate-only');
    assert.equal(res.estimate.asset_count, 2);
    assert.equal(vision.calls(), 0);
    assert.ok(res.estimate.estimated_total_usd.high >= res.estimate.estimated_total_usd.low);
  } finally {
    cleanup(home);
  }
});

test('confirmed build writes schema-valid entries + dual-key index readable by check.js and C4', async () => {
  const { env, home } = withHome({ 'cat.png': 'imgbytes', 'clips/intro.mp4': 'vidbytes' });
  try {
    const vision = fakeVision();
    const res = await indexer.buildLibraryIndex({ env, yes: true, visionFn: vision });
    assert.equal(res.status, 'indexed');
    assert.equal(res.indexed, 2);
    assert.equal(vision.calls(), 2);

    // Read raw file: both keys present, same content.
    const raw = JSON.parse(fs.readFileSync(path.join(home, 'library', 'index.json'), 'utf8'));
    assert.ok(Array.isArray(raw.assets) && raw.assets.length === 2, 'assets[] present (check.js)');
    assert.ok(Array.isArray(raw.entries) && raw.entries.length === 2, 'entries[] present (C4)');
    assert.equal(raw.total_assets, 2);

    // Every entry is schema-valid.
    for (const e of raw.assets) {
      assert.deepEqual(indexer.validateEntry(e), [], `entry valid: ${e.path}`);
      assert.ok(['library'].includes(e.source_class));
      assert.ok(e.description && e.tags.length);
    }
    // The video carries a duration; the image does not.
    const vid = raw.assets.find((e) => e.type === 'video');
    const img = raw.assets.find((e) => e.type === 'image');
    assert.equal(vid.duration, 12);
    assert.equal('duration' in img, false);

    // The retrieval scorer can consume the produced index end-to-end.
    const result = check.check({ query: 'synthetic cat', media_type: 'image' }, { env });
    assert.ok(result.candidates.length >= 1);
    assert.equal(result.candidates[0].path, 'library/media/cat.png');
  } finally {
    cleanup(home);
  }
});

test('incremental + idempotent: a second run skips everything and never re-calls vision', async () => {
  const { env, home } = withHome({ 'a.png': 'aa', 'b.png': 'bb' });
  try {
    const v1 = fakeVision();
    await indexer.buildLibraryIndex({ env, yes: true, visionFn: v1 });
    assert.equal(v1.calls(), 2);

    const v2 = fakeVision();
    const res2 = await indexer.buildLibraryIndex({ env, yes: true, visionFn: v2 });
    assert.equal(res2.status, 'up-to-date');
    assert.equal(res2.indexed, 0);
    assert.equal(res2.skipped, 2);
    assert.equal(v2.calls(), 0, 'no re-billing of already-indexed assets');
  } finally {
    cleanup(home);
  }
});

test('an edited asset is re-indexed; --force re-indexes everything', async () => {
  const { env, home, mediaDir } = withHome({ 'a.png': 'orig', 'b.png': 'static' });
  try {
    const v1 = fakeVision();
    await indexer.buildLibraryIndex({ env, yes: true, visionFn: v1 });

    // Edit a.png (new bytes ⇒ new fingerprint).
    fs.writeFileSync(path.join(mediaDir, 'a.png'), 'EDITED-CONTENT');
    const v2 = fakeVision();
    const res2 = await indexer.buildLibraryIndex({ env, yes: true, visionFn: v2 });
    assert.equal(res2.indexed, 1, 'only the edited asset re-indexed');
    assert.deepEqual(v2.seen(), ['library/media/a.png']);

    // --force re-indexes both.
    const v3 = fakeVision();
    const res3 = await indexer.buildLibraryIndex({ env, yes: true, force: true, visionFn: v3 });
    assert.equal(res3.indexed, 2);
    assert.equal(v3.calls(), 2);
  } finally {
    cleanup(home);
  }
});

test('empty / absent media dir is a clean no-op (DD-21), never throws', async () => {
  // Absent media dir.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oce-empty-'));
  try {
    const env = { CONTENT_HOME: home };
    const res = await indexer.buildLibraryIndex({ env, yes: true, visionFn: fakeVision() });
    assert.equal(res.status, 'empty-library');
    assert.equal(res.indexed, 0);
    assert.equal(res.ok, true);
    // estimateIndexCost also no-ops cleanly.
    const est = indexer.estimateIndexCost({ env });
    assert.equal(est.asset_count, 0);
  } finally {
    cleanup(home);
  }
});

test('a per-asset vision failure is recorded and never aborts the run', async () => {
  const { env, home } = withHome({ 'good.png': 'g', 'bad.png': 'b', 'good2.png': 'g2' });
  try {
    const failingVision = (asset) => {
      if (asset.path.endsWith('bad.png')) throw new Error('vision boom');
      return { description: 'ok', tags: ['ok'], type: asset.type };
    };
    const res = await indexer.buildLibraryIndex({ env, yes: true, visionFn: failingVision });
    assert.equal(res.status, 'indexed-with-errors');
    assert.equal(res.indexed, 2);
    assert.equal(res.failed.length, 1);
    assert.match(res.failed[0].error, /vision boom/);
    // The two good assets are still persisted and schema-valid.
    const doc = store.readIndex(env);
    assert.equal(doc.total_assets, 2);
  } finally {
    cleanup(home);
  }
});

test('index-store.merge is idempotent (re-merging same entry replaces, never duplicates)', () => {
  const e1 = { asset_id: 'media/x.png', path: 'media/x.png', type: 'image', source_class: 'library', tags: ['a'] };
  const e1b = { ...e1, tags: ['a', 'b'] };
  const e2 = { asset_id: 'media/y.png', path: 'media/y.png', type: 'image', source_class: 'library' };
  let doc = store.emptyDoc();
  doc = store.merge(doc, [e1, e2]);
  assert.equal(doc.total_assets, 2);
  doc = store.merge(doc, [e1b]); // replace e1 in place.
  assert.equal(doc.total_assets, 2, 'no duplicate appended');
  const x = doc.assets.find((e) => e.asset_id === 'media/x.png');
  assert.deepEqual(x.tags, ['a', 'b']);
  // assets and entries reference the same array (dual-key invariant).
  assert.equal(doc.assets, doc.entries);
});
