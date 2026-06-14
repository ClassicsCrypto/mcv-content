'use strict';

/**
 * tests/tags.test.js  [A — new tests]
 *
 * Covers the trait-index build + query (engine/library/tags/*; release-spec §7.8 retrieval
 * support). Builds indexes from a synthetic, brand-neutral metadata tree (both layouts:
 * JSON-per-token and traits.csv) under a temp CONTENT_HOME, then queries them. The production
 * scripts were hardcoded to a fixed collection roster and untested; this verifies the
 * collection-agnostic redesign.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const buildIndex = require('../engine/library/tags/build-index.js');
const traitQuery = require('../engine/library/tags/query.js');

/** Build a temp CONTENT_HOME with a synthetic metadata tree (two collections, two layouts). */
function tempHomeWithMetadata() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oce-tags-'));
  const env = { CONTENT_HOME: home };
  const metaDir = path.join(home, 'library', 'metadata');

  // Collection A: JSON-per-token (attributes array).
  const aDir = path.join(metaDir, 'cosmos-cats');
  fs.mkdirSync(aDir, { recursive: true });
  fs.writeFileSync(
    path.join(aDir, '1.json'),
    JSON.stringify({ attributes: [{ trait_type: 'Fur', value: 'Black' }, { trait_type: 'Hat', value: 'Helmet' }] }),
  );
  fs.writeFileSync(
    path.join(aDir, '2.json'),
    JSON.stringify({ attributes: [{ trait_type: 'Fur', value: 'Black' }, { trait_type: 'Hat', value: 'Cap' }] }),
  );
  fs.writeFileSync(path.join(aDir, 'broken.json'), '{ not valid json');

  // Collection B: traits.csv.
  const bDir = path.join(metaDir, 'star-pups');
  fs.mkdirSync(bDir, { recursive: true });
  fs.writeFileSync(
    path.join(bDir, 'traits.csv'),
    ['token_id,trait_type,value', '10,Background,Orange', '10,Eyes,Laser', '11,Background,Orange', '11,Eyes,Calm'].join('\n'),
  );

  return env;
}

test('build discovers collections in both layouts and ignores malformed token files', () => {
  const env = tempHomeWithMetadata();
  const summary = buildIndex.buildAndWrite({ env });

  assert.equal(summary['cosmos-cats'].total_tokens, 2); // broken.json skipped
  assert.equal(summary['star-pups'].total_tokens, 2);
  assert.ok(summary['cosmos-cats'].trait_type_names.includes('Fur'));
  assert.ok(summary['star-pups'].trait_type_names.includes('Background'));

  // Outputs were written under $CONTENT_HOME/library/tags.
  const tagsDir = buildIndex.tagsDir(env);
  for (const f of ['by-token.json', 'by-trait.json', 'summary.json']) {
    assert.ok(fs.existsSync(path.join(tagsDir, f)), `${f} written`);
  }
});

test('queryTraits intersects multiple filters (AND semantics)', () => {
  const env = tempHomeWithMetadata();
  buildIndex.buildAndWrite({ env });
  const idx = traitQuery.loadIndexes({ env });

  // Fur:Black AND Hat:Helmet ⇒ only token 1.
  assert.deepEqual(traitQuery.queryTraits(idx.byTrait, 'cosmos-cats', { Fur: 'Black', Hat: 'Helmet' }), ['1']);
  // Fur:Black (alone) ⇒ both tokens.
  assert.deepEqual(traitQuery.queryTraits(idx.byTrait, 'cosmos-cats', { Fur: 'Black' }).sort(), ['1', '2']);
});

test('query is case-insensitive on trait type and value', () => {
  const env = tempHomeWithMetadata();
  buildIndex.buildAndWrite({ env });
  const idx = traitQuery.loadIndexes({ env });

  const result = traitQuery.query(idx, 'star-pups', { background: 'orange' });
  assert.equal(result.total, 2);
  assert.equal(result.tokens.length, 2);
  assert.ok(result.tokens[0].traits.Background, 'token trait map attached');
});

test('query honors the limit', () => {
  const env = tempHomeWithMetadata();
  buildIndex.buildAndWrite({ env });
  const idx = traitQuery.loadIndexes({ env });
  const result = traitQuery.query(idx, 'star-pups', { Background: 'Orange' }, { limit: 1 });
  assert.equal(result.total, 2);
  assert.equal(result.tokens.length, 1);
});

test('unknown collection / no filters / missing index return empty, no throw', () => {
  const env = { CONTENT_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'oce-tags-empty-')) };
  // No metadata at all: build yields empty summary, query yields empty indexes.
  const summary = buildIndex.buildAndWrite({ env });
  assert.deepEqual(summary, {});
  const idx = traitQuery.loadIndexes({ env });
  assert.deepEqual(traitQuery.queryTraits(idx.byTrait, 'nope', { X: 'Y' }), []);
  assert.deepEqual(traitQuery.queryTraits(idx.byTrait, 'nope', {}), []);
});
