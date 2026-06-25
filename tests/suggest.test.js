'use strict';

/**
 * tests/suggest.test.js  [N — new tests, GROK-SUGGEST]
 *
 * Covers the FREE manual-Grok suggestion path (release-spec §1.2 / §8.8):
 *   - engine/sources/suggestions/parse.js  — extract the oce-suggestions block from pasted text
 *     (fenced / prose-wrapped / bare), validate it, dedup handles/terms, fail loudly on garbage.
 *   - engine/cli/suggest.js  — `prompt <kind>` prints a template; `apply` is dry-run by default and
 *     APPENDS + DEDUPS into config only on --yes; competitors need --brand.
 *   - the shipped prompt templates each contain the strict oce-suggestions output block.
 *
 * Deterministic + zero-key. Config writes target a throwaway temp CONTENT_HOME.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const parse = require('../engine/sources/suggestions/parse.js');
const suggest = require('../engine/cli/suggest.js');
const paths = require('../engine/shared/paths.js');
const { validate } = require('../scripts/validate-schemas.js');
const SET_SCHEMA = require('../schemas/inputs/suggestion-set.schema.json');

function initHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oce-suggest-'));
  const env = { CONTENT_HOME: home };
  require('../engine/setup/init.js').initHome({ home, env });
  return { home, env };
}

// ---------------------------------------------------------------------------
// parser
// ---------------------------------------------------------------------------

test('parse: extracts the oce-suggestions block from prose, dedups handles, normalizes @', () => {
  const text = 'Here you go!\n\n```oce-suggestions\n{"kind":"tracked_accounts","items":[{"handle":"creatorone"},{"handle":"@creatorone"},{"handle":"@rival"}]}\n```\nHope this helps.';
  const r = parse.parseSuggestions(text);
  assert.equal(r.ok, true);
  assert.equal(r.set.kind, 'tracked_accounts');
  assert.deepEqual(r.handles, ['@creatorone', '@rival']); // deduped + @-normalized
});

test('parse: tolerates a bare JSON object (no fence) carrying a kind', () => {
  const r = parse.parseSuggestions('garbage before {"kind":"keywords","items":[{"term":"ai agents"}]} garbage after');
  assert.equal(r.ok, true);
  assert.deepEqual(r.terms, ['ai agents']);
});

test('parse: fails loudly on no block, bad JSON, bad kind, and an item with neither handle nor term', () => {
  assert.equal(parse.parseSuggestions('no block here').ok, false);
  assert.equal(parse.parseSuggestions('```oce-suggestions\n{not json}\n```').ok, false);
  assert.equal(parse.parseSuggestions('{"kind":"bogus","items":[{"handle":"@a"}]}').ok, false);
  const noKey = parse.parseSuggestions('{"kind":"keywords","items":[{"why":"x"}]}');
  assert.equal(noKey.ok, false);
  assert.ok(noKey.errors.some((e) => /handle or a term/.test(e)));
});

test('parse: a validated set conforms to the published suggestion-set schema', () => {
  const r = parse.parseSuggestions('{"kind":"competitors","brand":"acme","items":[{"handle":"@rival","name":"Rival","why":"direct"}]}');
  assert.equal(r.ok, true);
  const res = validate(r.set, SET_SCHEMA);
  assert.ok(res.ok, `set must validate:\n${res.errors.join('\n')}`);
});

// ---------------------------------------------------------------------------
// prompt subcommand + templates
// ---------------------------------------------------------------------------

test('suggest prompt: prints the template for a kind; rejects an unknown kind', () => {
  for (const kind of ['competitors', 'tracked_accounts', 'keywords', 'breakout']) {
    const res = suggest.run({ positionals: ['prompt', kind] });
    assert.equal(res.ok, true);
    assert.match(res.data.prompt, /```oce-suggestions/);
    assert.match(res.data.prompt, new RegExp(`"kind":\\s*"${kind}"`));
  }
  assert.equal(suggest.run({ positionals: ['prompt', 'nope'] }).exitCode, 2);
});

// ---------------------------------------------------------------------------
// apply subcommand
// ---------------------------------------------------------------------------

function writeReply(home, obj) {
  const f = path.join(home, 'reply.txt');
  fs.writeFileSync(f, '```oce-suggestions\n' + JSON.stringify(obj) + '\n```\n');
  return f;
}

test('apply tracked_accounts: dry-run writes nothing; --yes appends + dedups into system.json', () => {
  const { home, env } = initHome();
  const file = writeReply(home, { kind: 'tracked_accounts', items: [{ handle: '@a' }, { handle: '@b' }] });

  const dry = suggest.run({ positionals: ['apply'], flags: { file }, env });
  assert.equal(dry.data.applied, false);
  const sysBefore = JSON.parse(fs.readFileSync(paths.systemConfig(env), 'utf8'));
  assert.ok(!sysBefore.trends || !Array.isArray(sysBefore.trends.tracked_accounts) || sysBefore.trends.tracked_accounts.length === 0);

  suggest.run({ positionals: ['apply'], flags: { file, yes: true }, env });
  // append-dedup: a second apply with an overlap adds only the new one.
  const file2 = writeReply(home, { kind: 'tracked_accounts', items: [{ handle: '@b' }, { handle: '@c' }] });
  suggest.run({ positionals: ['apply'], flags: { file: file2, yes: true }, env });
  const sys = JSON.parse(fs.readFileSync(paths.systemConfig(env), 'utf8'));
  assert.deepEqual(sys.trends.tracked_accounts, ['@a', '@b', '@c']);
  fs.rmSync(home, { recursive: true, force: true });
});

test('apply competitors: requires --brand; --yes appends to brand.json ingestion.competitors', () => {
  const { home, env } = initHome();
  // Register a minimal brand.
  const brandFile = paths.brandConfig('acme', env);
  fs.mkdirSync(path.dirname(brandFile), { recursive: true });
  fs.writeFileSync(brandFile, JSON.stringify({ id: 'acme', display_name: 'Acme', account_class: 'brand', platforms: [{ platform: 'twitter', publisher: 'manual' }] }));
  const file = writeReply(home, { kind: 'competitors', items: [{ handle: '@rival', name: 'Rival' }] });

  // No --brand → usage error.
  const noBrand = suggest.run({ positionals: ['apply'], flags: { file }, env });
  assert.equal(noBrand.exitCode, 2);

  suggest.run({ positionals: ['apply'], flags: { file, brand: 'acme', yes: true }, env });
  const brand = JSON.parse(fs.readFileSync(brandFile, 'utf8'));
  assert.equal(brand.ingestion.competitors.length, 1);
  assert.equal(brand.ingestion.competitors[0].handles[0].handle, '@rival');
  fs.rmSync(home, { recursive: true, force: true });
});

test('apply breakout: keywords go to trends, handles go to competitors (with --brand)', () => {
  const { home, env } = initHome();
  const brandFile = paths.brandConfig('acme', env);
  fs.mkdirSync(path.dirname(brandFile), { recursive: true });
  fs.writeFileSync(brandFile, JSON.stringify({ id: 'acme', display_name: 'Acme', account_class: 'brand', platforms: [{ platform: 'twitter', publisher: 'manual' }] }));
  const file = writeReply(home, { kind: 'breakout', items: [{ term: '#newtrend' }, { handle: '@newrival', name: 'New Rival' }] });

  suggest.run({ positionals: ['apply'], flags: { file, brand: 'acme', yes: true }, env });
  const sys = JSON.parse(fs.readFileSync(paths.systemConfig(env), 'utf8'));
  const brand = JSON.parse(fs.readFileSync(brandFile, 'utf8'));
  assert.deepEqual(sys.trends.keywords, ['#newtrend']);
  assert.equal(brand.ingestion.competitors[0].handles[0].handle, '@newrival');
  fs.rmSync(home, { recursive: true, force: true });
});
