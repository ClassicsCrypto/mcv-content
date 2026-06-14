'use strict';

/**
 * tests/cli-index-library.test.js  [A — new tests, LIB-CLI verb smoke]
 *
 * Smoke coverage for the `engine index-library` verb (engine/cli/index-library.js) — the thin CLI
 * over the stage-1 library modules (engine/library/indexer.js, organize.js, character-sheets.js).
 * release-spec §1.5 asset management; original-design-spec §1.5 (auto-index / folder-sort /
 * character sheets); §12.5 provider seams; §15.4 / DD-18 estimate-and-confirm; DD-21 empty-library.
 *
 * ZERO-KEY (RD-12): every test runs against a throwaway temp CONTENT_HOME; the metered index path is
 * confirmed-but-no-provider (so it reports the honest missing-dependency exit, never spends), and the
 * character-sheet generate path degrades-to-skip with no image-gen provider. No network, no secrets.
 *
 * Asserts: the verb routes through the dispatcher (bin/engine.js) with the right exit codes; the
 * DD-18 estimate-and-confirm halt on the default index path; the folder-sort dry-run-by-default and
 * --apply; the character-sheet detect path; mutually-exclusive sub-action rejection; and that
 * --help works (already pinned generically in cli-engine.test.js, re-pinned here for the sub-flags).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const engine = require('../bin/engine.js');
const verb = require('../engine/cli/index-library.js');
const initVerb = require('../engine/cli/init.js');
const paths = require('../engine/shared/paths.js');

/** Fresh, initialized temp CONTENT_HOME; returns { env, home }. */
function tempInitHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oce-idxcli-'));
  const target = path.join(home, 'i');
  initVerb.run({ flags: { home: target, 'no-git': true }, env: { ...process.env } });
  return { env: { ...process.env, CONTENT_HOME: target }, home, target };
}

/** Write a media file under library/media (the scan/index root). */
function putMedia(env, rel, bytes = 'x') {
  const abs = path.join(paths.libraryMediaDir(env), rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, bytes);
  return abs;
}

/** Write a media file directly under library/ (the folder-sort root, not library/media). */
function putLib(env, rel, bytes = 'x') {
  const abs = path.join(paths.libraryDir(env), rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, bytes);
  return abs;
}

/** Capture stdout/stderr while running fn (which may be async). */
async function capture(fn) {
  const out = [];
  const err = [];
  const o = process.stdout.write.bind(process.stdout);
  const e = process.stderr.write.bind(process.stderr);
  process.stdout.write = (c) => { out.push(String(c)); return true; };
  process.stderr.write = (c) => { err.push(String(c)); return true; };
  try {
    const code = await fn();
    return { code, stdout: out.join(''), stderr: err.join('') };
  } finally {
    process.stdout.write = o;
    process.stderr.write = e;
  }
}

// ---------------------------------------------------------------------------
// AUTO-INDEX (default) — DD-18 estimate-and-confirm
// ---------------------------------------------------------------------------

test('default (no flags) halts awaiting confirmation with an estimate — never spends (DD-18)', async () => {
  const { env, home } = tempInitHome();
  try {
    putMedia(env, 'a.png');
    putMedia(env, 'clips/b.mp4');
    const res = await verb.run({ flags: {}, env });
    assert.equal(res.ok, false);
    assert.equal(res.exitCode, 0); // a confirmation halt is not an error
    assert.equal(res.data.awaiting_confirmation, true);
    assert.equal(res.data.action, 'index');
    assert.equal(res.data.estimate.asset_count, 2);
    assert.match(res.summary, /requires confirmation/);
    // No index written before confirmation.
    assert.equal(fs.existsSync(paths.libraryIndex(env)), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('--estimate-only prints the band and spends nothing (exit 0)', async () => {
  const { env, home } = tempInitHome();
  try {
    putMedia(env, 'a.png');
    const res = await verb.run({ flags: { 'estimate-only': true }, env });
    assert.equal(res.ok, true);
    assert.equal(res.data.status, 'estimate-only');
    assert.ok(res.data.estimate.estimated_total_usd.high >= res.data.estimate.estimated_total_usd.low);
    assert.equal(fs.existsSync(paths.libraryIndex(env)), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('--yes with media but NO vision provider is an honest missing-dependency exit 3 (no spend)', async () => {
  const { env, home } = tempInitHome();
  try {
    putMedia(env, 'a.png');
    const res = await verb.run({ flags: { yes: true }, env });
    assert.equal(res.ok, false);
    assert.equal(res.exitCode, 3); // genuine dependency absent (no §12.5 vision provider)
    assert.equal(res.data.status, 'no-provider');
    assert.match(res.summary, /no vision provider/i);
    assert.equal(fs.existsSync(paths.libraryIndex(env)), false); // nothing written
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('empty-library is a clean no-op pass (DD-21)', async () => {
  const { env, home } = tempInitHome();
  try {
    const res = await verb.run({ flags: { yes: true }, env });
    assert.equal(res.ok, true);
    assert.equal(res.data.status, 'empty-library');
    assert.equal(res.data.indexed, 0);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// FOLDER-SORT (--organize) — dry-run-by-default; --apply moves
// ---------------------------------------------------------------------------

test('--organize plans the folder-sort as a dry-run (changes nothing)', async () => {
  const { env, home } = tempInitHome();
  try {
    putLib(env, 'photo.png');
    putLib(env, 'clip.mp4');
    putLib(env, 'hero-ai-gen.png');
    const res = await verb.run({ flags: { organize: true }, env });
    assert.equal(res.data.action, 'organize');
    assert.equal(res.data.dryRun, true);
    assert.equal(res.data.counts.moved, 0);
    assert.equal(res.data.counts.planned, 3);
    // Nothing moved on disk.
    assert.ok(!fs.existsSync(path.join(paths.libraryDir(env), 'Images')));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('--organize --apply moves into template folders', async () => {
  const { env, home } = tempInitHome();
  try {
    putLib(env, 'photo.png');
    putLib(env, 'clip.mov');
    putLib(env, 'gen-flux.png');
    const res = await verb.run({ flags: { organize: true, apply: true }, env });
    assert.equal(res.data.dryRun, false);
    assert.equal(res.data.counts.moved, 3);
    const lib = paths.libraryDir(env);
    assert.ok(fs.existsSync(path.join(lib, 'Images', 'photo.png')));
    assert.ok(fs.existsSync(path.join(lib, 'Videos', 'clip.mov')));
    assert.ok(fs.existsSync(path.join(lib, 'AI-generated', 'gen-flux.png')));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// CHARACTER SHEETS (--character-sheets)
// ---------------------------------------------------------------------------

test('--character-sheets detects present/missing against the brand roster (zero-key)', async () => {
  const { env, home, target } = tempInitHome();
  try {
    // Configure a roster on the instance config; seed an index where one is present.
    const sys = JSON.parse(fs.readFileSync(paths.systemConfig(env), 'utf8'));
    sys.character_sheets = { roster: [{ name: 'Comet' }, { name: 'Nova' }] };
    fs.writeFileSync(paths.systemConfig(env), JSON.stringify(sys, null, 2));
    fs.mkdirSync(paths.libraryDir(env), { recursive: true });
    fs.writeFileSync(
      paths.libraryIndex(env),
      JSON.stringify({
        assets: [{
          asset_id: 'library/character-sheets/comet.png',
          path: 'library/character-sheets/comet.png',
          type: 'image', source_class: 'generated',
          tags: ['character-sheet'], character_refs: ['comet'],
        }],
      }),
    );
    void target;
    const res = await verb.run({ flags: { 'character-sheets': true }, env });
    assert.equal(res.ok, true);
    assert.equal(res.data.action, 'character-sheets');
    assert.equal(res.data.mode, 'detect');
    assert.equal(res.data.present.length, 1);
    assert.equal(res.data.missing.length, 1);
    assert.match(res.summary, /1\/2 present/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('--character-sheets --generate (no --yes) HALTS with an estimate (approval-gated, DD-18)', async () => {
  const { env, home } = tempInitHome();
  try {
    const sys = JSON.parse(fs.readFileSync(paths.systemConfig(env), 'utf8'));
    sys.character_sheets = { roster: [{ name: 'Nova' }] };
    fs.writeFileSync(paths.systemConfig(env), JSON.stringify(sys, null, 2));
    const res = await verb.run({ flags: { 'character-sheets': true, generate: true }, env });
    assert.equal(res.ok, false);
    assert.equal(res.exitCode, 0); // approval halt, not an error
    assert.equal(res.data.awaiting_approval, true);
    assert.ok(res.data.estimate.estimated_total_usd.low >= 0);
    assert.match(res.summary, /requires approval/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('--character-sheets --generate --yes degrades-to-skip with no image-gen provider (no spend)', async () => {
  const { env, home } = tempInitHome();
  try {
    const sys = JSON.parse(fs.readFileSync(paths.systemConfig(env), 'utf8'));
    sys.character_sheets = { roster: [{ name: 'Nova' }] };
    fs.writeFileSync(paths.systemConfig(env), JSON.stringify(sys, null, 2));
    const res = await verb.run({ flags: { 'character-sheets': true, generate: true, yes: true }, env });
    assert.equal(res.ok, true); // degrade-to-skip is an honest no-op success
    assert.equal(res.data.skipped.length, 1);
    assert.equal(res.data.generated.length, 0);
    assert.match(res.summary, /no image-gen provider configured/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// flag combos + dispatcher routing
// ---------------------------------------------------------------------------

test('--organize and --character-sheets together is a usage error (exit 2)', async () => {
  const { env, home } = tempInitHome();
  try {
    const res = await verb.run({ flags: { organize: true, 'character-sheets': true }, env });
    assert.equal(res.ok, false);
    assert.equal(res.exitCode, 2);
    assert.match(res.summary, /pick ONE sub-action/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('routes through the dispatcher (bin/engine.js) — empty-library --yes exits 0', async () => {
  const { home, target } = tempInitHome();
  const prev = process.env.CONTENT_HOME;
  process.env.CONTENT_HOME = target;
  try {
    const { code, stdout } = await capture(() =>
      engine.main(['node', 'engine.js', 'index-library', '--yes']));
    assert.equal(code, 0);
    assert.match(stdout, /empty-library/i);
  } finally {
    if (prev === undefined) delete process.env.CONTENT_HOME; else process.env.CONTENT_HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('--help exits 0 and documents every sub-action', async () => {
  const res = await verb.run({ flags: { help: true } });
  assert.equal(res.ok, true);
  for (const token of ['--organize', '--character-sheets', '--estimate-only', '--yes', '--force']) {
    assert.ok(res.detail.includes(token), `help mentions ${token}`);
  }
});
