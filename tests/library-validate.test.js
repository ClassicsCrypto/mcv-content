'use strict';

/**
 * tests/library-validate.test.js  [N — new tests, SETUP-CONTENT-LIBRARY]
 *
 * Covers engine/library/validate.js (the read-only library doctor — release-spec §1.5; §2.6 C4) and
 * its CLI wiring `engine index-library --check`. The validator is the "point at your library, check
 * it's in the right shape, flag empty folders / stray files / dead index entries" pass an operator
 * runs BEFORE spending on indexing. Deterministic + zero-key + read-only (it never moves/writes/spends).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const validate = require('../engine/library/validate.js');
const indexLibrary = require('../engine/cli/index-library.js');
const paths = require('../engine/shared/paths.js');

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'oce-libval-'));
}
function env(home) { return { CONTENT_HOME: home }; }
function libDir(home) { return paths.libraryDir(env(home)); }
function write(p, c) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, c ?? 'x'); }

test('no library/ dir → clean empty-library pass (never an error)', () => {
  const home = tempHome();
  const res = validate.validateLibrary({ env: env(home) });
  assert.equal(res.exists, false);
  assert.equal(res.ok, true);
  assert.equal(res.counts.files, 0);
  fs.rmSync(home, { recursive: true, force: true });
});

test('counts media by type, flags empty folders, non-media files, and unindexed media (warnings, ok)', () => {
  const home = tempHome();
  const lib = libDir(home);
  write(path.join(lib, 'Images', 'cat.png'));
  write(path.join(lib, 'Videos', 'clip.mp4'));
  write(path.join(lib, 'notes.txt')); // non-media
  fs.mkdirSync(path.join(lib, 'empty-folder'), { recursive: true }); // truly empty

  const res = validate.validateLibrary({ env: env(home) });
  assert.equal(res.exists, true);
  assert.equal(res.counts.images, 1);
  assert.equal(res.counts.videos, 1);
  assert.equal(res.counts.non_media, 1);
  assert.equal(res.counts.empty_dirs, 1);
  assert.ok(res.empty_dirs.includes('empty-folder'));
  // Only warnings (no index yet, empty folder, non-media) ⇒ still a clean (ok) scan.
  assert.equal(res.ok, true);
  const codes = res.issues.map((i) => i.code);
  assert.ok(codes.includes('empty_folders'));
  assert.ok(codes.includes('non_media'));
  assert.ok(codes.includes('not_indexed'));
  fs.rmSync(home, { recursive: true, force: true });
});

test('a stale index entry (file missing on disk) is an ERROR → ok:false', () => {
  const home = tempHome();
  const lib = libDir(home);
  write(path.join(lib, 'Images', 'real.png'));
  // Index references a file that does not exist on disk.
  write(paths.libraryIndex(env(home)), JSON.stringify({
    assets: [
      { path: 'library/Images/real.png', type: 'image' },
      { path: 'library/Images/ghost.png', type: 'image' },
    ],
  }));
  const res = validate.validateLibrary({ env: env(home) });
  assert.equal(res.ok, false, 'a dead index reference must fail the scan');
  const errors = res.issues.filter((i) => i.level === 'error');
  assert.ok(errors.some((e) => e.code === 'stale_index_entry'));
  assert.equal(res.counts.stale_index, 1);
  fs.rmSync(home, { recursive: true, force: true });
});

test('a fully-indexed clean library reports clean (no issues)', () => {
  const home = tempHome();
  const lib = libDir(home);
  write(path.join(lib, 'Images', 'a.png'));
  write(paths.libraryIndex(env(home)), JSON.stringify({ assets: [{ path: 'library/Images/a.png', type: 'image' }] }));
  const res = validate.validateLibrary({ env: env(home) });
  assert.equal(res.ok, true);
  assert.equal(res.counts.unindexed, 0);
  assert.equal(res.issues.length, 0, 'a clean, fully-indexed library has no notes');
  fs.rmSync(home, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// CLI wiring: engine index-library --check
// ---------------------------------------------------------------------------

test('`index-library --check` returns a read-only report; warnings exit 0, errors exit 1', async () => {
  const home = tempHome();
  const lib = libDir(home);
  write(path.join(lib, 'Images', 'a.png'));
  const warnRes = await indexLibrary.run({ flags: { check: true }, env: env(home) });
  assert.equal(warnRes.exitCode, 0); // unindexed is a warning, not a failure
  assert.equal(warnRes.data.action, 'check');

  // Now introduce a stale index entry → error → exit 1.
  write(paths.libraryIndex(env(home)), JSON.stringify({ assets: [{ path: 'library/Images/ghost.png', type: 'image' }] }));
  const errRes = await indexLibrary.run({ flags: { check: true }, env: env(home) });
  assert.equal(errRes.ok, false);
  assert.equal(errRes.exitCode, 1);
  fs.rmSync(home, { recursive: true, force: true });
});

test('`index-library --check --organize` is rejected as a contradictory combo (exit 2)', async () => {
  const home = tempHome();
  const res = await indexLibrary.run({ flags: { check: true, organize: true }, env: env(home) });
  assert.equal(res.exitCode, 2);
  assert.match(res.summary, /pick ONE sub-action/i);
  fs.rmSync(home, { recursive: true, force: true });
});
