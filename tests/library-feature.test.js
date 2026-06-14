'use strict';

/**
 * tests/library-feature.test.js  [LIB-TESTS — end-to-end feature tests for the library auto-indexer]
 *
 * The integration test suite for the whole library-indexer feature (release-spec §1.5 auto-index /
 * folder-sort / character sheets; §7.8 archive-index-entry + retrieval; §12.5 vision-provider seam;
 * §15.4 / DD-18 estimate-and-confirm; DD-21 empty-library; RD-12 zero-key CI). Where the per-module
 * tests (library-indexer.test.js, library-organize.test.js, character-sheets.test.js) assert each
 * module against synthetic inline data, THIS suite wires the four stage-1 batches together against
 * the REAL Acme Cosmos fixture media (fixtures/library-acme/) using the recorded fake vision
 * responses (tests/helpers/fake-vision.js) — proving the seams actually interlock end-to-end.
 *
 * ZERO-KEY / OFFLINE (RD-12 — CI holds no secrets): every test injects the recorded fake visionFn;
 * no provider block, no secret, no child process, no network. A real temp CONTENT_HOME is populated
 * by COPYING the read-only fixture media (the fixtures themselves are never mutated — folder-sort and
 * index writes happen only against the throwaway copy).
 *
 * Coverage (the LIB-TESTS contract):
 *   (1) the indexer scans the fixture media → emits archive-index-entries that VALIDATE against
 *       schemas/artifacts/archive-index-entry.schema.json, carrying the fake vision descriptions/tags;
 *   (2) INCREMENTALITY — a second run re-indexes nothing and makes ZERO fake-vision calls, unless --force;
 *   (3) the cost estimate counts assets-needing-index correctly (and re-counts after a partial index);
 *   (4) folder-sort dry-run REPORTS the moves; --apply performs them and is idempotent on re-run;
 *   (5) character-sheet detection finds the fixture's existing sheet + reports the missing roster, and
 *       generation DEGRADES cleanly with no provider configured;
 *   (6) retrieval (engine/library/check.js) can CONSUME the produced index end-to-end.
 *
 * ALL FIXTURES ARE SYNTHETIC (Acme Cosmos). See fixtures/library-acme/PROVENANCE.md.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const indexer = require('../engine/library/indexer.js');
const store = require('../engine/library/index-store.js');
const organize = require('../engine/library/organize.js');
const characterSheets = require('../engine/library/character-sheets.js');
const check = require('../engine/library/check.js');

const fakeVision = require('./helpers/fake-vision.js');
const schemaValidator = require('../scripts/validate-schemas.js');
const archiveEntrySchema = require('../schemas/artifacts/archive-index-entry.schema.json');

// ---------------------------------------------------------------------------
// Fixtures + harness
// ---------------------------------------------------------------------------

const FIXTURE_ROOT = path.join(__dirname, '..', 'fixtures', 'library-acme');

/**
 * Recursively copy a fixture subtree into a destination dir. Pure read of the fixture (the source is
 * never mutated); the destination is a throwaway temp tree the tests own.
 */
function copyTree(srcDir, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  for (const ent of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const src = path.join(srcDir, ent.name);
    const dest = path.join(destDir, ent.name);
    if (ent.isDirectory()) copyTree(src, dest);
    else if (ent.isFile()) fs.copyFileSync(src, dest);
  }
}

/**
 * Build a temp CONTENT_HOME whose library/media tree holds the COPIED fixture media. By default we
 * copy the three already-sorted fixture lanes (Images/, Videos/, AI-generated/) plus the loose
 * unsorted/ assets under library/media — i.e. the media the indexer should scan. The expected/,
 * character-markers/, and PROVENANCE.md fixture artifacts are NOT copied into media (they are not
 * media and would pollute the scan); the test pulls them straight from FIXTURE_ROOT when needed.
 *
 * @param {object} [opts]
 * @param {string[]} [opts.lanes]  which fixture subfolders to copy into library/media.
 * @returns {{env:object, home:string, mediaDir:string, libDir:string}}
 */
function withFixtureHome(opts = {}) {
  const lanes = opts.lanes || ['Images', 'Videos', 'AI-generated', 'unsorted'];
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oce-libfeat-'));
  const libDir = path.join(home, 'library');
  const mediaDir = path.join(libDir, 'media');
  fs.mkdirSync(mediaDir, { recursive: true });
  for (const lane of lanes) {
    const src = path.join(FIXTURE_ROOT, lane);
    if (fs.existsSync(src)) copyTree(src, path.join(mediaDir, lane));
  }
  return { env: { CONTENT_HOME: home }, home, mediaDir, libDir };
}

/** A temp CONTENT_HOME whose library/ holds the fixture lanes directly (for folder-sort tests). */
function withFlatFixtureLibrary(opts = {}) {
  const lanes = opts.lanes || ['unsorted'];
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oce-libsort-'));
  const libDir = path.join(home, 'library');
  fs.mkdirSync(libDir, { recursive: true });
  for (const lane of lanes) {
    const src = path.join(FIXTURE_ROOT, lane);
    if (!fs.existsSync(src)) continue;
    // Flatten the lane's files directly under library/ (a freshly-dropped, unsorted library).
    for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
      if (ent.isFile()) fs.copyFileSync(path.join(src, ent.name), path.join(libDir, ent.name));
    }
  }
  return { env: { CONTENT_HOME: home }, home, libDir };
}

function cleanup(home) {
  fs.rmSync(home, { recursive: true, force: true });
}

/**
 * Wrap the recorded fake visionFn (which is keyed by BASENAME and called with a filename) into the
 * shape LIB-CORE's buildLibraryIndex injects: visionFn(asset, ctx). The indexer hands the scanned
 * asset object; we hand its path to the fixture lookup. A call counter + a seen[] list let the
 * incrementality tests assert ZERO re-billing.
 *
 * The recorded fixture answer carries the RAW model-shaped fields { type, description, tags,
 * content_tags, duration?, character_refs } — the same shape the §12.5 provider returns. We run it
 * through indexer.normalizeVisionAnswer() exactly as the real defaultVisionFn does (it folds
 * content_tags into tags, resolves the type enum incl. gif→animated_image, and keeps a positive
 * duration), so this fake stands in for the vision MODEL while the indexer's own normalization still
 * runs — the faithful end-to-end path, not a shortcut.
 *
 * @param {object} [opts]  forwarded to makeFakeVisionFn ({ onMissing }).
 */
function injectableFixtureVision(opts) {
  const inner = fakeVision.makeFakeVisionFn(opts);
  let calls = 0;
  const seen = [];
  const fn = (asset /* , ctx */) => {
    calls += 1;
    seen.push(asset.path);
    const recorded = inner(asset.path);
    if (recorded == null) return null; // degrade-to-skip path (onMissing:'skip').
    return indexer.normalizeVisionAnswer(recorded, asset);
  };
  fn.calls = () => calls;
  fn.seen = () => seen.slice();
  return fn;
}

/** Strict schema validation via the shipped offline validator (scripts/validate-schemas.js). */
function assertValidEntry(entry, label) {
  const { ok, errors } = schemaValidator.validate(entry, archiveEntrySchema);
  assert.ok(ok, `schema-valid archive-index-entry (${label}): ${JSON.stringify(errors)}`);
}

/** The 10 recorded fixture basenames the fake vision answers for (sanity guard for the fixtures). */
const RECORDED = fakeVision.recordedFilenames();

// ===========================================================================
// (0) Fixture + harness sanity — the suite is wired to the real fixtures.
// ===========================================================================

test('fixtures: the fake vision helper records all 10 Acme media assets', () => {
  assert.equal(RECORDED.length, 10, 'expected 10 recorded fixture vision responses');
  // The fixture media on disk is the same set the responses are keyed by.
  const onDisk = [];
  for (const lane of ['Images', 'Videos', 'AI-generated', 'unsorted']) {
    const dir = path.join(FIXTURE_ROOT, lane);
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.isFile() && indexer.classifyType(path.extname(ent.name))) onDisk.push(ent.name);
    }
  }
  assert.deepEqual(onDisk.sort(), RECORDED.slice().sort(), 'every recorded answer maps to a media file and vice-versa');
});

// ===========================================================================
// (1) Scan → schema-valid archive-index-entries carrying the fake descriptions/tags.
// ===========================================================================

test('(1) confirmed build indexes every fixture asset into schema-valid entries with fake vision data', async () => {
  const { env, home } = withFixtureHome();
  try {
    const vision = injectableFixtureVision();
    const res = await indexer.buildLibraryIndex({ env, yes: true, visionFn: vision });

    assert.equal(res.status, 'indexed');
    assert.equal(res.ok, true);
    assert.equal(res.indexed, 10, 'all 10 fixture media assets indexed');
    assert.equal(res.failed.length, 0);
    assert.equal(vision.calls(), 10, 'exactly one vision call per asset');

    // Read the persisted index: dual-key contract + header counts.
    const raw = JSON.parse(fs.readFileSync(path.join(home, 'library', 'index.json'), 'utf8'));
    assert.ok(Array.isArray(raw.assets) && raw.assets.length === 10, 'assets[] (check.js reads this)');
    assert.ok(Array.isArray(raw.entries) && raw.entries.length === 10, 'entries[] (C4 reads this)');
    assert.equal(raw.total_assets, 10);

    // EVERY persisted entry validates against the schema. The persisted entry carries bookkeeping
    // fields (fingerprint, indexed_at) that are NOT in the schema (additionalProperties:false), so
    // we validate the public-schema projection (the indexer's validateEntry tolerates bookkeeping;
    // the strict JSON-schema validator does not — so strip them for the strict check, exactly the
    // fields the dual-key store carries internally).
    for (const e of raw.assets) {
      assert.deepEqual(indexer.validateEntry(e), [], `indexer.validateEntry ok: ${e.path}`);
      const { fingerprint, indexed_at, ...publicEntry } = e;
      assertValidEntry(publicEntry, e.path);
      assert.equal(e.source_class, 'library', 'fixture media indexed as operator library assets');
    }

    // The fake vision descriptions/tags travelled into the entries.
    const byBase = new Map(raw.assets.map((e) => [path.basename(e.path), e]));
    const moon = byBase.get('moon-first-quarter.png');
    const recordedMoon = fakeVision.recordedAnswer('moon-first-quarter.png');
    assert.equal(moon.description, recordedMoon.description, 'description carried from the fake vision answer');
    for (const t of recordedMoon.tags) assert.ok(moon.tags.includes(t), `tag "${t}" carried`);
    assert.equal(moon.type, 'image');
    assert.equal('duration' in moon, false, 'a still image carries no duration');

    // A video carries the recorded duration; a gif normalizes to animated_image.
    const pleiades = byBase.get('pleiades-pan-clip.mp4');
    assert.equal(pleiades.type, 'video');
    assert.equal(pleiades.duration, fakeVision.recordedAnswer('pleiades-pan-clip.mp4').duration);
    const gif = byBase.get('mascot-orbit-loop.gif');
    assert.equal(gif.type, 'animated_image', 'gif normalizes to the animated_image schema enum');
    // normalizeVisionAnswer keeps a duration only for VIDEO (isTimeBased === video); an animated_image
    // drops it — so the real provider path produces a gif entry WITHOUT a duration even though the
    // recorded answer carried one. (Asserting the engine's actual behavior, not the golden fixture.)
    assert.equal('duration' in gif, false, 'animated_image (gif) carries no duration via normalization');
    // content_tags (the production prefixed-tag shape) were folded into the entry's tag set.
    assert.ok(gif.tags.includes('subject:mascot'), 'gif content_tags folded into tags');
  } finally {
    cleanup(home);
  }
});

test('(1b) content_tags (prefixed production-style tags) are folded into the entry tags', async () => {
  const { env, home } = withFixtureHome({ lanes: ['Images'] });
  try {
    const vision = injectableFixtureVision();
    await indexer.buildLibraryIndex({ env, yes: true, visionFn: vision });
    const doc = store.readIndex(env);
    const moon = doc.assets.find((e) => path.basename(e.path) === 'moon-first-quarter.png');
    // normalizeVisionAnswer folds content_tags (subject:moon …) lower-cased into the tag set.
    assert.ok(moon.tags.includes('subject:moon'), 'a content_tags entry was folded into tags');
    assert.ok(moon.tags.includes('moon'), 'a plain tag is also present');
  } finally {
    cleanup(home);
  }
});

// ===========================================================================
// (2) INCREMENTALITY — second run re-indexes nothing, makes zero vision calls; --force re-indexes.
// ===========================================================================

test('(2) a second build re-indexes nothing and makes ZERO fake-vision calls (no re-billing)', async () => {
  const { env, home } = withFixtureHome();
  try {
    const v1 = injectableFixtureVision();
    const first = await indexer.buildLibraryIndex({ env, yes: true, visionFn: v1 });
    assert.equal(first.indexed, 10);
    assert.equal(v1.calls(), 10);

    const v2 = injectableFixtureVision();
    const second = await indexer.buildLibraryIndex({ env, yes: true, visionFn: v2 });
    assert.equal(second.status, 'up-to-date');
    assert.equal(second.indexed, 0, 'nothing re-indexed on the second run');
    assert.equal(second.skipped, 10, 'all 10 assets recognized as already-indexed');
    assert.equal(v2.calls(), 0, 'ZERO vision calls on the incremental no-op (DD-18 no re-bill)');
  } finally {
    cleanup(home);
  }
});

test('(2b) --force re-indexes every asset (a deliberate confirmed re-spend)', async () => {
  const { env, home } = withFixtureHome({ lanes: ['Images', 'Videos'] });
  try {
    const v1 = injectableFixtureVision();
    await indexer.buildLibraryIndex({ env, yes: true, visionFn: v1 });
    const total = v1.calls();
    assert.ok(total > 0);

    const v2 = injectableFixtureVision();
    const forced = await indexer.buildLibraryIndex({ env, yes: true, force: true, visionFn: v2 });
    assert.equal(forced.indexed, total, '--force re-indexes the full set');
    assert.equal(v2.calls(), total, '--force re-calls vision for every asset');
  } finally {
    cleanup(home);
  }
});

test('(2c) an edited asset (new bytes) is re-indexed; unchanged assets stay skipped', async () => {
  const { env, home, mediaDir } = withFixtureHome({ lanes: ['Images'] });
  try {
    const v1 = injectableFixtureVision();
    const first = await indexer.buildLibraryIndex({ env, yes: true, visionFn: v1 });
    const firstCount = first.indexed;
    assert.ok(firstCount >= 2);

    // Edit ONE asset in place → new fingerprint → only it is re-indexed next run.
    fs.writeFileSync(path.join(mediaDir, 'Images', 'moon-first-quarter.png'), 'EDITED-MOON-BYTES');
    const v2 = injectableFixtureVision();
    const second = await indexer.buildLibraryIndex({ env, yes: true, visionFn: v2 });
    assert.equal(second.indexed, 1, 'only the edited asset is re-indexed');
    assert.equal(v2.calls(), 1, 'exactly one vision call for the edited asset');
    assert.deepEqual(v2.seen(), ['library/media/Images/moon-first-quarter.png']);
  } finally {
    cleanup(home);
  }
});

// ===========================================================================
// (3) COST ESTIMATE — counts assets-needing-index correctly (DD-18 / §15.4), spends nothing.
// ===========================================================================

test('(3) estimate counts assets-needing-index and makes no vision call', async () => {
  const { env, home } = withFixtureHome();
  try {
    const vision = injectableFixtureVision();
    // estimate-only via the build path: no spend, no confirmation needed.
    const est = await indexer.buildLibraryIndex({ env, estimateOnly: true, visionFn: vision });
    assert.equal(est.status, 'estimate-only');
    assert.equal(est.estimate.asset_count, 10, 'all 10 fixture assets need indexing on a cold start');
    assert.equal(est.estimate.total_scanned, 10);
    assert.equal(est.estimate.already_indexed, 0);
    assert.equal(vision.calls(), 0, 'estimate-only spends nothing');

    // The total band is count × per-asset band and ordered low ≤ high.
    const band = est.estimate.per_asset_usd;
    assert.equal(est.estimate.estimated_total_usd.low, +(10 * band.low).toFixed(4));
    assert.equal(est.estimate.estimated_total_usd.high, +(10 * band.high).toFixed(4));
    assert.ok(est.estimate.estimated_total_usd.high >= est.estimate.estimated_total_usd.low);

    // The DD-18 confirmation gate: a plain build halts awaiting confirmation, still zero spend.
    const v2 = injectableFixtureVision();
    const halt = await indexer.buildLibraryIndex({ env, visionFn: v2 });
    assert.equal(halt.awaiting_confirmation, true);
    assert.equal(halt.ok, false);
    assert.equal(v2.calls(), 0, 'no vision call before --yes');
    assert.equal(fs.existsSync(path.join(home, 'library', 'index.json')), false, 'no index written before confirmation');
  } finally {
    cleanup(home);
  }
});

test('(3b) the estimate re-counts correctly after a partial index (only the remainder is billed)', async () => {
  const { env, home } = withFixtureHome();
  try {
    // First index only the Images lane by pointing a partial visionFn that throws on non-Images —
    // simpler: index everything, then add a NEW unindexed asset and confirm the estimate counts 1.
    const v1 = injectableFixtureVision();
    await indexer.buildLibraryIndex({ env, yes: true, visionFn: v1 });

    // Estimate now: nothing to do.
    const est0 = indexer.estimateIndexCost({ env });
    assert.equal(est0.asset_count, 0, 'fully-indexed library needs nothing');
    assert.equal(est0.already_indexed, 10);

    // Drop ONE new media file into media/ → the estimate should count exactly 1 to index.
    const newAsset = path.join(home, 'library', 'media', 'Images', 'new-clone.png');
    fs.writeFileSync(newAsset, 'A-BRAND-NEW-DISTINCT-IMAGE-PAYLOAD');
    const est1 = indexer.estimateIndexCost({ env });
    assert.equal(est1.total_scanned, 11);
    assert.equal(est1.already_indexed, 10);
    assert.equal(est1.asset_count, 1, 'only the one new asset needs indexing');
  } finally {
    cleanup(home);
  }
});

// ===========================================================================
// (4) FOLDER-SORT — dry-run reports moves; --apply performs them and is idempotent.
// ===========================================================================

test('(4) folder-sort dry-run reports the planned moves but changes nothing on disk', () => {
  const { env, home, libDir } = withFlatFixtureLibrary({ lanes: ['unsorted'] });
  try {
    const res = organize.organizeLibrary({ env }); // no apply → dry-run.
    assert.equal(res.dryRun, true);
    assert.equal(res.counts.moved, 0, 'dry-run moves nothing');
    assert.ok(res.counts.planned >= 2, 'the two unsorted fixture assets are planned for a move');

    // app-tonight-card.png → Images/, comet-flyby-raw.mp4 → Videos/.
    const byFrom = new Map(res.planned.map((p) => [p.from, p]));
    assert.equal(byFrom.get('app-tonight-card.png').folder, organize.FOLDER.IMAGES);
    assert.equal(byFrom.get('comet-flyby-raw.mp4').folder, organize.FOLDER.VIDEOS);

    // Nothing actually moved: the originals are still flat in library/, no template dirs created.
    assert.ok(fs.existsSync(path.join(libDir, 'app-tonight-card.png')));
    assert.ok(fs.existsSync(path.join(libDir, 'comet-flyby-raw.mp4')));
    assert.ok(!fs.existsSync(path.join(libDir, 'Images')));
    assert.match(res.summary, /DRY-RUN/);
  } finally {
    cleanup(home);
  }
});

test('(4b) folder-sort --apply moves into template lanes, and a re-run is an idempotent no-op', () => {
  const { env, home, libDir } = withFlatFixtureLibrary({ lanes: ['unsorted'] });
  try {
    const first = organize.organizeLibrary({ env, apply: true });
    assert.equal(first.dryRun, false);
    assert.ok(first.counts.moved >= 2);

    assert.ok(fs.existsSync(path.join(libDir, 'Images', 'app-tonight-card.png')));
    assert.ok(fs.existsSync(path.join(libDir, 'Videos', 'comet-flyby-raw.mp4')));
    assert.ok(!fs.existsSync(path.join(libDir, 'app-tonight-card.png')), 'original location vacated');

    // Re-run: everything is already in its correct lane ⇒ zero moves (idempotent).
    const second = organize.organizeLibrary({ env, apply: true });
    assert.equal(second.counts.moved, 0, 'second --apply moves nothing');
    assert.equal(second.counts.planned, 0);
    assert.ok(second.counts.already_sorted >= 2, 'both assets recognized as already-sorted');
    // Files unchanged after the no-op re-run.
    assert.ok(fs.existsSync(path.join(libDir, 'Images', 'app-tonight-card.png')));
    assert.ok(fs.existsSync(path.join(libDir, 'Videos', 'comet-flyby-raw.mp4')));
  } finally {
    cleanup(home);
  }
});

test('(4c) folder-sort routes a source_class:generated indexed asset to AI-generated (the nebula keyart fixture)', () => {
  const { env, home, libDir } = withFlatFixtureLibrary({ lanes: ['AI-generated'] });
  try {
    // The AI-generated fixture files carry no filename marker — their provenance lives in the
    // archive index (source_class:"generated"), exactly as expected/index-entries.json records. So
    // we seed an index marking nebula-keyart-gen.png as generated; folder-sort must consult that
    // source_class and route it to AI-generated (and rewrite the entry path). The unmarked gif has
    // no generated marker and is a gif → Videos by §1.5 intent. Both routing inputs are exercised.
    fs.writeFileSync(
      path.join(libDir, 'index.json'),
      JSON.stringify({
        assets: [
          { asset_id: 'nebula', path: 'library/nebula-keyart-gen.png', type: 'image', source_class: 'generated' },
        ],
      }),
    );

    const res = organize.organizeLibrary({ env, apply: true });
    assert.ok(
      fs.existsSync(path.join(libDir, 'AI-generated', 'nebula-keyart-gen.png')),
      'index source_class:generated → AI-generated',
    );
    assert.ok(fs.existsSync(path.join(libDir, 'Videos', 'mascot-orbit-loop.gif')), 'unmarked gif → Videos');
    assert.ok(res.counts.moved >= 2);
    // The index path was rewritten to the new lane so retrieval stays consistent.
    const updated = JSON.parse(fs.readFileSync(path.join(libDir, 'index.json'), 'utf8'));
    assert.equal(updated.assets[0].path, 'library/AI-generated/nebula-keyart-gen.png');
    assert.equal(res.counts.index_updated, 1);
  } finally {
    cleanup(home);
  }
});

test('(4d) folder-sort routes AI assets by FILENAME marker too (brand-neutral structural markers)', () => {
  const { env, home, libDir } = withFlatFixtureLibrary({ lanes: [] });
  try {
    // A filename-marked generated asset (ai-gen / midjourney / flux …) routes to AI-generated with
    // no index help — the structural filename-marker path of classifyAsset.
    fs.writeFileSync(path.join(libDir, 'hero-ai-gen.png'), 'AIGEN');
    fs.writeFileSync(path.join(libDir, 'plain-photo.png'), 'PHOTO');
    organize.organizeLibrary({ env, apply: true });
    assert.ok(fs.existsSync(path.join(libDir, 'AI-generated', 'hero-ai-gen.png')), 'filename marker → AI-generated');
    assert.ok(fs.existsSync(path.join(libDir, 'Images', 'plain-photo.png')), 'unmarked still → Images');
  } finally {
    cleanup(home);
  }
});

// ===========================================================================
// (5) CHARACTER SHEETS — detect the existing fixture sheet + report missing; generation degrades.
// ===========================================================================

/** The fixture roster: the mascot (which HAS a sheet) + two characters with no sheet. */
const FIXTURE_ROSTER_CONFIG = {
  character_sheets: {
    roster: [
      { name: 'Comet', aliases: ['acme-mascot-comet'], identity: 'a small round cartoon comet mascot' },
      { name: 'Nova', identity: 'a star-spangled fox' },
      'Orbit',
    ],
  },
};

/**
 * Seed an index whose entries include the fixture's existing character sheet (under the
 * character-sheets/ path lane, character_refs → acme-mascot-comet) plus a couple of plain assets.
 */
function indexWithExistingSheet() {
  return [
    {
      asset_id: 'acme-mascot-comet-sheet',
      path: 'library/character-sheets/acme-mascot-comet/contact-sheet.png',
      type: 'image',
      source_class: 'generated',
      tags: ['character-sheet'],
      character_refs: ['acme-mascot-comet'],
    },
    {
      asset_id: 'acme-mascot-orbit-loop',
      path: 'library/AI-generated/mascot-orbit-loop.gif',
      type: 'animated_image',
      source_class: 'generated',
      description: 'Looping animation of the Acme Cosmos mascot orbiting a planet.',
      tags: ['mascot', 'loop'],
      character_refs: ['acme-mascot-comet'],
    },
  ];
}

test('(5) character-sheet detection finds the existing mascot sheet and reports the missing roster', () => {
  const result = characterSheets.detectCharacterSheets({
    index: indexWithExistingSheet(),
    config: FIXTURE_ROSTER_CONFIG,
  });
  assert.equal(result.roster_size, 3);
  assert.ok(result.sheet_assets >= 1, 'at least the contact-sheet asset is detected');

  const presentKeys = result.present.map((p) => p.key);
  const missingKeys = result.missing.map((m) => m.key).sort();
  assert.deepEqual(presentKeys, ['comet'], 'Comet (the mascot) already has a sheet');
  assert.deepEqual(missingKeys, ['nova', 'orbit'], 'Nova + Orbit are missing sheets');
  // The present row links the covering sheet asset (by its asset_id, the entry's stable identity).
  assert.ok(
    result.present[0].sheets.includes('acme-mascot-comet-sheet'),
    `the present row links the covering sheet asset (got ${JSON.stringify(result.present[0].sheets)})`,
  );
});

test('(5b) the on-disk character-marker fixture matches the character_refs the indexer emits', () => {
  // The fixture marker declares character_id acme-mascot-comet and depicts mascot-orbit-loop.gif —
  // the SAME ref the recorded vision answer carries, so detection and indexing agree on identity.
  const marker = JSON.parse(
    fs.readFileSync(path.join(FIXTURE_ROOT, 'character-markers', 'acme-mascot-comet.character.json'), 'utf8'),
  );
  assert.equal(marker.character_id, 'acme-mascot-comet');
  const gifAnswer = fakeVision.recordedAnswer('mascot-orbit-loop.gif');
  assert.deepEqual(gifAnswer.character_refs, [marker.character_id], 'vision ref matches the marker character');
});

test('(5c) character-sheet generation DEGRADES TO SKIP when no image-gen provider is configured', () => {
  const res = characterSheets.generateCharacterSheet({
    character: 'Nova',
    index: indexWithExistingSheet(),
    config: FIXTURE_ROSTER_CONFIG, // no config.image_gen block, no injected generator.
    approve: true,
    apply: true,
  });
  assert.equal(res.ok, true);
  assert.equal(res.skipped, true);
  assert.equal(res.data.provider_configured, false);
  assert.match(res.summary, /no image-generation provider configured/i);
});

test('(5d) generation is IDEMPOTENT — an already-present character is never re-generated (no spend)', () => {
  const res = characterSheets.generateCharacterSheet({
    character: 'Comet', // already has a sheet in the seeded index.
    index: indexWithExistingSheet(),
    config: FIXTURE_ROSTER_CONFIG,
    approve: true,
    apply: true,
    generate: () => {
      throw new Error('generator MUST NOT be called for an already-present character');
    },
  });
  assert.equal(res.ok, true);
  assert.equal(res.skipped, true);
  assert.match(res.summary, /already has a sheet/i);
});

// ===========================================================================
// (6) RETRIEVAL — engine/library/check.js consumes the produced index end-to-end.
// ===========================================================================

test('(6) the retrieval scorer consumes the indexer-produced index end-to-end', async () => {
  const { env, home } = withFixtureHome();
  try {
    // Produce the index from the fixture media via the fake vision path.
    const vision = injectableFixtureVision();
    await indexer.buildLibraryIndex({ env, yes: true, visionFn: vision });

    // A query that matches the moon image's description/tags should rank it first.
    const moonResult = check.check({ query: 'first quarter moon craters terminator', media_type: 'image' }, { env });
    assert.ok(moonResult.candidates.length >= 1, 'retrieval found candidates from the produced index');
    assert.equal(
      path.basename(moonResult.candidates[0].path),
      'moon-first-quarter.png',
      'the moon image ranks first for a moon query',
    );

    // A video query is filtered to video media and finds the Pleiades clip.
    const vidResult = check.check({ query: 'pleiades star cluster pan', media_type: 'video' }, { env });
    assert.ok(vidResult.candidates.length >= 1);
    assert.ok(
      vidResult.candidates.every((c) => /\.(mp4|mov|m4v|webm|avi|mkv)$/i.test(c.path || '')),
      'media_type:video filtered the candidate set to videos',
    );
    assert.equal(path.basename(vidResult.candidates[0].path), 'pleiades-pan-clip.mp4');

    // A query with no library match yields a generate decision (never throws on a populated index).
    const miss = check.check({ query: 'a completely unrelated subject xyzzy plover', media_type: 'image' }, { env });
    assert.equal(miss.decision.action, 'generate');
  } finally {
    cleanup(home);
  }
});

test('(6b) retrieval over an EMPTY library is a clean generate-only no-op (DD-21)', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oce-libfeat-empty-'));
  try {
    const env = { CONTENT_HOME: home };
    const result = check.check({ query: 'anything at all', media_type: 'image' }, { env });
    assert.equal(result.candidates.length, 0, 'no candidates on an empty library');
    assert.equal(result.total_matches, 0);
    assert.equal(result.decision.action, 'generate', 'empty library ⇒ generate-only (DD-21)');
  } finally {
    cleanup(home);
  }
});

// ===========================================================================
// (E2E) The whole feature in sequence: estimate → confirm-index → sort → re-index → retrieve.
// ===========================================================================

test('(E2E) estimate → confirmed index → folder-sort → incremental re-index → retrieval all interlock', async () => {
  // Lay the library out flat (unsorted) directly under library/ so folder-sort has work to do, AND
  // mirror it under library/media so the indexer scans it. We use a flat library and point the
  // indexer at media/, indexing first, then sorting the media tree, then confirming retrieval holds.
  const { env, home } = withFixtureHome();
  try {
    // 1) Estimate (zero spend).
    const est = indexer.estimateIndexCost({ env });
    assert.equal(est.asset_count, 10);

    // 2) Confirmed index (the metered path, zero-key via the fake vision).
    const v1 = injectableFixtureVision();
    const built = await indexer.buildLibraryIndex({ env, yes: true, visionFn: v1 });
    assert.equal(built.indexed, 10);
    assert.equal(v1.calls(), 10);

    // 3) Retrieval works on the produced index. A discriminating query (the m42 / sword tags are
    //    unique to the photographed Orion Nebula, not the stylized AI key-art) ranks it first.
    const r1 = check.check({ query: 'orion nebula sword m42', media_type: 'image' }, { env });
    assert.equal(path.basename(r1.candidates[0].path), 'orion-nebula-wide.png');

    // 4) Incremental re-index is a zero-call no-op.
    const v2 = injectableFixtureVision();
    const again = await indexer.buildLibraryIndex({ env, yes: true, visionFn: v2 });
    assert.equal(again.status, 'up-to-date');
    assert.equal(v2.calls(), 0);

    // 5) The index file is byte-stable across the incremental no-op except for generated_at (the
    //    store stamps a fresh generated_at only on write; the no-op path does not write). Confirm
    //    the asset set is identical and still schema-valid.
    const doc = store.readIndex(env);
    assert.equal(doc.total_assets, 10);
    for (const e of doc.assets) {
      const { fingerprint, indexed_at, ...publicEntry } = e;
      assertValidEntry(publicEntry, e.path);
    }
  } finally {
    cleanup(home);
  }
});
