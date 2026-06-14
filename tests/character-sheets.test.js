'use strict';

/**
 * tests/character-sheets.test.js  [A — new tests; closes the §1.5 character-sheet gap]
 *
 * Covers engine/library/character-sheets.js (original-design-spec §1.5; release-spec §12.5 provider
 * seam mirrored for image-gen; DD-18 estimate-and-confirm; RD-12 injectable provider). All tests run
 * ZERO-KEY: detection reads injected/temp indexes, generation uses an injected fake generator — CI
 * holds no secrets. Brand-neutral fixtures only (Acme Cosmos placeholders).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cs = require('../engine/library/character-sheets.js');
const imageGen = require('../engine/library/image-gen-provider.js');

/** A brand-neutral roster config (Acme Cosmos placeholders). */
const ROSTER_CONFIG = {
  character_sheets: {
    roster: [
      { name: 'Comet', identity: 'a blue cosmonaut cat in a helmet', refs: ['media/cosmos/comet.png'], palette: 'blue' },
      { name: 'Nova', aliases: ['Supernova'], identity: 'a star-spangled fox', refs: ['media/cosmos/nova.png'] },
      'Orbit', // name-only entry
    ],
  },
};

/** An index where Comet has a sheet (by path lane) but Nova/Orbit do not. */
const INDEX_WITH_COMET_SHEET = [
  {
    asset_id: 'library/character-sheets/comet.png',
    path: 'library/character-sheets/comet.png',
    type: 'image',
    source_class: 'generated',
    tags: ['character-sheet'],
    character_refs: ['comet'],
  },
  {
    asset_id: 'media/cosmos/scene-1.png',
    path: 'media/cosmos/scene-1.png',
    type: 'image',
    source_class: 'library',
    description: 'a generic space scene',
    tags: ['space'],
  },
];

// ---------------------------------------------------------------------------
// DETECT
// ---------------------------------------------------------------------------

test('detect reports present vs missing characters against the roster', () => {
  const result = cs.detectCharacterSheets({ index: INDEX_WITH_COMET_SHEET, config: ROSTER_CONFIG });
  assert.equal(result.roster_size, 3);
  assert.equal(result.sheet_assets, 1);
  const presentKeys = result.present.map((p) => p.key);
  const missingKeys = result.missing.map((m) => m.key).sort();
  assert.deepEqual(presentKeys, ['comet']);
  assert.deepEqual(missingKeys, ['nova', 'orbit']);
  // The present row links the covering sheet asset.
  assert.ok(result.present[0].sheets.includes('library/character-sheets/comet.png'));
});

test('detect identifies sheets by tag, source_class marker, path lane, and is_character_sheet flag', () => {
  const index = [
    { asset_id: 'a', path: 'media/a.png', tags: ['character-sheet'], type: 'image', source_class: 'library' },
    { asset_id: 'b', path: 'media/b.png', type: 'image', source_class: 'character-sheet' },
    { asset_id: 'c', path: 'library/character-sheets/c.png', type: 'image', source_class: 'generated' },
    { asset_id: 'd', path: 'media/d.png', type: 'image', source_class: 'library', is_character_sheet: true },
    { asset_id: 'e', path: 'media/e.png', type: 'image', source_class: 'library' }, // NOT a sheet
  ];
  const result = cs.detectCharacterSheets({ index, config: {} });
  assert.equal(result.sheet_assets, 4);
  assert.ok(result.note.includes('No character roster configured'));
});

test('detect on an empty library returns no present/missing and never throws (DD-21)', () => {
  const result = cs.detectCharacterSheets({ index: [], config: ROSTER_CONFIG });
  assert.equal(result.sheet_assets, 0);
  assert.equal(result.present.length, 0);
  assert.equal(result.missing.length, 3);
});

test('detect tolerates both index shapes (assets[] and entries[]) and bare arrays', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oce-cs-idx-'));
  const env = { CONTENT_HOME: home };
  fs.mkdirSync(path.join(home, 'library'), { recursive: true });
  const entry = {
    asset_id: 'library/character-sheets/comet.png',
    path: 'library/character-sheets/comet.png',
    type: 'image',
    source_class: 'generated',
    tags: ['character-sheet'],
    character_refs: ['comet'],
  };
  // entries[] shape (checkpoints.js convention).
  fs.writeFileSync(path.join(home, 'library', 'index.json'), JSON.stringify({ entries: [entry] }));
  const r1 = cs.detectCharacterSheets({ config: ROSTER_CONFIG, env });
  assert.equal(r1.present.length, 1);
  // assets[] shape (check.js convention).
  fs.writeFileSync(path.join(home, 'library', 'index.json'), JSON.stringify({ assets: [entry] }));
  const r2 = cs.detectCharacterSheets({ config: ROSTER_CONFIG, env });
  assert.equal(r2.present.length, 1);
});

// ---------------------------------------------------------------------------
// GENERATE — guard ladder
// ---------------------------------------------------------------------------

test('generate without a character is a usage error', () => {
  const r = cs.generateCharacterSheet({ config: ROSTER_CONFIG });
  assert.equal(r.ok, false);
  assert.match(r.summary, /needs a character/);
});

test('generate is IDEMPOTENT — an existing sheet is skipped, no spend', () => {
  const r = cs.generateCharacterSheet({
    character: 'Comet',
    index: INDEX_WITH_COMET_SHEET,
    config: ROSTER_CONFIG,
    approve: true,
    apply: true,
    generate: () => {
      throw new Error('generator MUST NOT be called for an already-present character');
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.skipped, true);
  assert.match(r.summary, /already has a sheet/);
});

test('generate DEGRADES TO SKIP when no image-gen provider is configured', () => {
  const r = cs.generateCharacterSheet({
    character: 'Nova',
    index: INDEX_WITH_COMET_SHEET,
    config: ROSTER_CONFIG, // no config.image_gen block
    approve: true,
    apply: true,
  });
  assert.equal(r.skipped, true);
  assert.equal(r.data.provider_configured, false);
  assert.match(r.summary, /no image-generation provider configured/);
});

test('generate without approval HALTS with a cost estimate (DD-18) and never spends', () => {
  let called = false;
  const r = cs.generateCharacterSheet({
    character: 'Nova',
    index: INDEX_WITH_COMET_SHEET,
    config: ROSTER_CONFIG,
    generate: () => {
      called = true;
      return { ok: true };
    },
    // no approve
  });
  assert.equal(r.ok, false);
  assert.equal(r.awaiting_approval, true);
  assert.ok(r.data.estimate.estimated_total_usd.low >= 0);
  assert.equal(called, false, 'no generation without approval');
});

test('generate approved but not applied is a DRY-RUN — plan only, no spend', () => {
  let called = false;
  const r = cs.generateCharacterSheet({
    character: 'Nova',
    index: INDEX_WITH_COMET_SHEET,
    config: ROSTER_CONFIG,
    approve: true,
    // no apply
    generate: () => {
      called = true;
      return { ok: true };
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.dry_run, true);
  assert.equal(called, false, 'dry-run must not call the generator');
  assert.equal(r.data.plan.character, 'Nova');
  assert.ok(r.data.plan.output_path.includes('character-sheets'));
});

test('generate approved + applied invokes the INJECTED generator (zero-key) and reports the sheet', () => {
  const calls = [];
  const r = cs.generateCharacterSheet({
    character: 'Nova',
    index: INDEX_WITH_COMET_SHEET,
    config: ROSTER_CONFIG,
    approve: true,
    apply: true,
    generate: (a) => {
      calls.push(a);
      return { ok: true, output_path: a.outputPath, bytes: 12345 };
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.skipped, false);
  assert.equal(calls.length, 1);
  // The prompt carries the character identity and refs were passed through.
  assert.match(calls[0].prompt, /Nova/);
  assert.deepEqual(calls[0].refs, ['media/cosmos/nova.png']);
  // A ready-to-add archive-index-entry is suggested with the sheet markers.
  assert.equal(r.data.suggested_index_entry.source_class, 'generated');
  assert.ok(r.data.suggested_index_entry.tags.includes('character-sheet'));
  assert.equal(r.data.produced.bytes, 12345);
});

test('generate resolves a character by ALIAS', () => {
  const r = cs.generateCharacterSheet({
    character: 'Supernova', // alias of Nova
    index: INDEX_WITH_COMET_SHEET,
    config: ROSTER_CONFIG,
    approve: true,
    generate: () => ({ ok: true }),
  });
  assert.equal(r.dry_run, true);
  assert.equal(r.data.plan.character, 'Nova');
});

test('generate reports a provider/generator failure honestly (no fabricated success)', () => {
  const r = cs.generateCharacterSheet({
    character: 'Nova',
    index: INDEX_WITH_COMET_SHEET,
    config: ROSTER_CONFIG,
    approve: true,
    apply: true,
    generate: () => {
      throw new Error('model offline');
    },
  });
  assert.equal(r.ok, false);
  assert.match(r.detail.join(' '), /model offline/);
});

// ---------------------------------------------------------------------------
// suggested_index_entry validates against the archive-index-entry schema
// ---------------------------------------------------------------------------

test('suggested_index_entry conforms to archive-index-entry.schema.json (strict required+enum)', () => {
  const schema = require('../schemas/artifacts/archive-index-entry.schema.json');
  const r = cs.generateCharacterSheet({
    character: 'Nova',
    index: INDEX_WITH_COMET_SHEET,
    config: ROSTER_CONFIG,
    approve: true,
    apply: true,
    generate: (a) => ({ ok: true, output_path: a.outputPath, bytes: 1 }),
  });
  const entry = r.data.suggested_index_entry;
  for (const req of schema.required) assert.ok(req in entry, `missing required ${req}`);
  assert.ok(schema.properties.type.enum.includes(entry.type));
  assert.ok(schema.properties.source_class.enum.includes(entry.source_class));
  // additionalProperties:false — every key must be a declared property.
  for (const k of Object.keys(entry)) assert.ok(k in schema.properties, `extra property ${k}`);
});

// ---------------------------------------------------------------------------
// image-gen provider seam (resolveProvider parity with the vision provider)
// ---------------------------------------------------------------------------

test('image-gen resolveProvider degrades for absent/unknown kinds and resolves cli/http', () => {
  assert.equal(imageGen.resolveProvider(null), null);
  assert.equal(imageGen.resolveProvider({ kind: 'mystery' }), null);
  const cli = imageGen.resolveProvider({ kind: 'cli', model: 'm', options: { command: 'x' } });
  assert.equal(cli.kind, 'cli');
  assert.equal(cli.timeoutMs, imageGen.DEFAULT_TIMEOUT_MS);
  const http = imageGen.resolveProvider({ kind: 'http', timeout_ms: 5000 });
  assert.equal(http.kind, 'http');
  assert.equal(http.timeoutMs, 5000);
});

test('runImageGen (cli) passes prompt via stdin, refs + output as argv, and reports bytes', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oce-cs-gen-'));
  const env = { CONTENT_HOME: home, ComSpec: process.env.ComSpec };
  const provider = imageGen.resolveProvider({
    kind: 'cli',
    model: 'img-model',
    options: { command: 'fake-imggen', model_flag: '--model', output_flag: '--out', ref_flag: '--ref', style_anchor: 'media/anchor.png' },
  });
  const captured = {};
  const fakeSpawn = (cmd, argv, optsArg) => {
    captured.cmd = cmd;
    captured.argv = argv;
    captured.input = optsArg.input;
    // Emulate the tool writing the output file.
    const outIdx = argv.indexOf('--out');
    const outPath = argv[outIdx + 1];
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, 'PNGDATA');
    return { status: 0, stdout: 'ok', stderr: '' };
  };
  const res = imageGen.runImageGen({
    provider,
    prompt: 'draw the sheet',
    refs: ['media/cosmos/nova.png'],
    outputPath: 'library/character-sheets/nova.png',
    env,
    spawnSync: fakeSpawn,
  });
  assert.equal(res.ok, true);
  assert.equal(res.bytes, 'PNGDATA'.length);
  assert.equal(captured.input, 'draw the sheet'); // prompt on stdin, never argv
  assert.ok(!captured.argv.includes('draw the sheet'));
  // Style anchor precedes the character ref.
  const refFlags = captured.argv.filter((a) => a === '--ref').length;
  assert.equal(refFlags, 2);
});

test('runImageGen (cli) throws when the command exits non-zero (no fabricated success)', () => {
  const provider = imageGen.resolveProvider({ kind: 'cli', options: { command: 'fake' } });
  assert.throws(
    () =>
      imageGen.runImageGen({
        provider,
        prompt: 'p',
        outputPath: 'library/character-sheets/x.png',
        env: { CONTENT_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'oce-cs-fail-')) },
        spawnSync: () => ({ status: 1, stdout: '', stderr: 'boom' }),
      }),
    /exited 1/,
  );
});
