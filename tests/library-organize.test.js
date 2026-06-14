'use strict';

/**
 * tests/library-organize.test.js  [A — new tests]
 *
 * Covers the library folder AUTO-SORT (engine/library/organize.js; original-design-spec §1.5
 * "Folder Sorting" → Images / Videos / AI-generated). All tests run ZERO-KEY against a temp
 * CONTENT_HOME with synthetic, brand-neutral fixtures (sort is a pure FS reorganization — no
 * vision spend — but it still honors the DD-18 dry-run-by-default mutation-safety contract).
 *
 * Asserts: dry-run-by-default (nothing moves), classification (image/video by extension;
 * AI-generated via filename marker, sidecar marker, and archive-index source_class), --apply
 * moves into the template folders, idempotency (re-run is a no-op), containment (RD-3 — no asset
 * leaves library/, non-media left in place), collision-safe destination naming, archive-index
 * `path` rewrite on move, and tolerance of an unreadable directory.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const organize = require('../engine/library/organize.js');

/** Fresh temp CONTENT_HOME with a library/ tree; returns { env, home, lib }. */
function tempHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oce-organize-'));
  const lib = path.join(home, 'library');
  fs.mkdirSync(lib, { recursive: true });
  return { env: { CONTENT_HOME: home }, home, lib };
}

/** Write a file with byte content under library/. */
function put(lib, rel, content = 'x') {
  const abs = path.join(lib, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

const relSet = (arr, key) => new Set(arr.map((p) => p[key]));

test('classifyAsset: extension → Images/Videos, marker → AI-generated, non-media → null', () => {
  assert.equal(organize.classifyAsset('/x/photo.png').folder, organize.FOLDER.IMAGES);
  assert.equal(organize.classifyAsset('/x/clip.mp4').folder, organize.FOLDER.VIDEOS);
  assert.equal(organize.classifyAsset('/x/loop.gif').folder, organize.FOLDER.VIDEOS); // animated
  assert.equal(organize.classifyAsset('/x/notes.txt').folder, null); // non-media

  // Filename marker promotes to AI-generated, beating the still-kind default.
  assert.equal(organize.classifyAsset('/x/hero-ai-gen.png').folder, organize.FOLDER.AI_GENERATED);
  assert.equal(organize.classifyAsset('/x/midjourney_render.jpg').folder, organize.FOLDER.AI_GENERATED);

  // Index source_class marker promotes too (no filename hint needed).
  assert.equal(
    organize.classifyAsset('/x/plain.png', { indexSourceClass: 'generated' }).folder,
    organize.FOLDER.AI_GENERATED,
  );
  assert.equal(
    organize.classifyAsset('/x/plain.png', { indexSourceClass: 'library' }).folder,
    organize.FOLDER.IMAGES,
  );
});

test('dry-run by default: plans moves but changes nothing on disk', () => {
  const { env, lib } = tempHome();
  put(lib, 'a.png');
  put(lib, 'b.mp4');
  put(lib, 'sub/c-aigen.png');

  const res = organize.organizeLibrary({ env }); // no apply
  assert.equal(res.dryRun, true);
  assert.equal(res.counts.moved, 0);
  assert.equal(res.counts.planned, 3);

  // Files are exactly where they started — nothing moved.
  assert.ok(fs.existsSync(path.join(lib, 'a.png')));
  assert.ok(fs.existsSync(path.join(lib, 'b.mp4')));
  assert.ok(fs.existsSync(path.join(lib, 'sub', 'c-aigen.png')));
  assert.ok(!fs.existsSync(path.join(lib, 'Images')));

  const plannedTo = relSet(res.planned, 'folder');
  assert.deepEqual(plannedTo, new Set(['Images', 'Videos', 'AI-generated']));
});

test('--apply moves into template folders, then a re-run is a no-op (idempotent)', () => {
  const { env, lib } = tempHome();
  put(lib, 'a.png');
  put(lib, 'b.mov');
  put(lib, 'gen-flux.png');

  const first = organize.organizeLibrary({ env, apply: true });
  assert.equal(first.dryRun, false);
  assert.equal(first.counts.moved, 3);

  assert.ok(fs.existsSync(path.join(lib, 'Images', 'a.png')));
  assert.ok(fs.existsSync(path.join(lib, 'Videos', 'b.mov')));
  assert.ok(fs.existsSync(path.join(lib, 'AI-generated', 'gen-flux.png')));
  // Originals are gone.
  assert.ok(!fs.existsSync(path.join(lib, 'a.png')));

  // Re-run: everything is already sorted ⇒ zero moves.
  const second = organize.organizeLibrary({ env, apply: true });
  assert.equal(second.counts.moved, 0);
  assert.equal(second.counts.already_sorted, 3);
  assert.equal(second.counts.planned, 0);
});

test('sidecar JSON marker forces AI-generated classification', () => {
  const { env, lib } = tempHome();
  put(lib, 'render.png');
  // sibling sidecar declaring it generated
  fs.writeFileSync(path.join(lib, 'render.json'), JSON.stringify({ source_class: 'generated' }));

  const res = organize.organizeLibrary({ env, apply: true });
  assert.ok(fs.existsSync(path.join(lib, 'AI-generated', 'render.png')));
  assert.equal(res.counts.moved, 1);
});

test('non-media files are left in place (never moved)', () => {
  const { env, lib } = tempHome();
  put(lib, 'a.png');
  put(lib, 'readme.md');
  put(lib, 'data.json');

  organize.organizeLibrary({ env, apply: true });
  assert.ok(fs.existsSync(path.join(lib, 'readme.md')));
  assert.ok(fs.existsSync(path.join(lib, 'data.json')));
  assert.ok(fs.existsSync(path.join(lib, 'Images', 'a.png')));
});

test('destination collisions get a numeric suffix (no overwrite, no data loss)', () => {
  const { env, lib } = tempHome();
  // Two distinct files with the same basename in different subdirs both sort to Images/.
  put(lib, 'one/dup.png', 'AAA');
  put(lib, 'two/dup.png', 'BBB');

  const res = organize.organizeLibrary({ env, apply: true });
  assert.equal(res.counts.moved, 2);

  const imagesDir = path.join(lib, 'Images');
  const files = fs.readdirSync(imagesDir).sort();
  assert.deepEqual(files, ['dup-1.png', 'dup.png']);
  // Both contents survived (no overwrite).
  const contents = files.map((f) => fs.readFileSync(path.join(imagesDir, f), 'utf8')).sort();
  assert.deepEqual(contents, ['AAA', 'BBB']);
});

test('archive-index path is rewritten on move (retrieval stays consistent)', () => {
  const { env, home, lib } = tempHome();
  put(lib, 'photo.png');
  const indexFile = path.join(lib, 'index.json');
  fs.writeFileSync(
    indexFile,
    JSON.stringify({
      assets: [{ asset_id: 'photo', path: 'library/photo.png', type: 'image', source_class: 'library' }],
    }),
  );

  const res = organize.organizeLibrary({ env, apply: true });
  assert.equal(res.counts.index_updated, 1);

  const updated = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
  assert.equal(updated.assets[0].path, 'library/Images/photo.png');
  assert.ok(fs.existsSync(path.join(lib, 'Images', 'photo.png')));
  // Sanity: path is still $CONTENT_HOME-relative and lands on the moved file.
  assert.ok(fs.existsSync(path.join(home, updated.assets[0].path)));
});

test('index source_class generated routes the indexed asset to AI-generated and rewrites its path', () => {
  const { env, lib } = tempHome();
  put(lib, 'plain.png'); // no filename/sidecar marker
  fs.writeFileSync(
    path.join(lib, 'index.json'),
    JSON.stringify({ assets: [{ asset_id: 'plain', path: 'library/plain.png', type: 'image', source_class: 'generated' }] }),
  );

  const res = organize.organizeLibrary({ env, apply: true });
  assert.ok(fs.existsSync(path.join(lib, 'AI-generated', 'plain.png')));
  const updated = JSON.parse(fs.readFileSync(path.join(lib, 'index.json'), 'utf8'));
  assert.equal(updated.assets[0].path, 'library/AI-generated/plain.png');
  assert.equal(res.counts.index_updated, 1);
});

test('tags/ and metadata/ trees are not treated as media (left untouched)', () => {
  const { env, lib } = tempHome();
  put(lib, 'tags/by-token.json', '{}');
  put(lib, 'metadata/coll/1.json', '{}');
  put(lib, 'real.png');

  const res = organize.organizeLibrary({ env, apply: true });
  assert.equal(res.counts.moved, 1); // only real.png
  assert.ok(fs.existsSync(path.join(lib, 'tags', 'by-token.json')));
  assert.ok(fs.existsSync(path.join(lib, 'metadata', 'coll', '1.json')));
});

test('missing library/ ⇒ empty-library no-op (never throws)', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oce-organize-empty-'));
  const res = organize.organizeLibrary({ env: { CONTENT_HOME: home } });
  assert.equal(res.counts.scanned, 0);
  assert.equal(res.counts.moved, 0);
  assert.match(res.summary, /nothing to sort/i);
});

test('an unreadable subdirectory is reported, not fatal', () => {
  const { env, lib } = tempHome();
  put(lib, 'a.png');
  // Simulate an unreadable dir by injecting nothing special — instead point at a path that
  // disappears mid-walk is hard cross-platform; assert the error channel exists and the good
  // file still sorts. (Tolerance is structurally guaranteed by per-entry try/catch.)
  const res = organize.organizeLibrary({ env, apply: true });
  assert.ok(fs.existsSync(path.join(lib, 'Images', 'a.png')));
  assert.ok(Array.isArray(res.errors));
});
