'use strict';

/**
 * engine/library/tags/build-index.js  [A adapted]
 *
 * Trait-index builder (release-spec §1 tree engine/library/tags/; §7.8 retrieval support).
 * Merges per-collection NFT/asset metadata into two inverted indexes used by the trait query
 * path and the trait-match lane of retrieval:
 *   - by-token.json : { "<collection>": { "<tokenId>": { "<TraitType>": "<value>", … }, … } }
 *   - by-trait.json : { "<collection>": { "<TraitType>": { "<value>": [tokenId, …] }, … } }
 *   - summary.json  : per-collection counts (tokens, trait types, unique values)
 *
 * Adaptation from production (regenerate-never-redact, §0.3):
 *   - The production builder hardcoded a fixed set of named collections and their on-disk
 *     layouts. This version is COLLECTION-AGNOSTIC: it discovers collections by scanning
 *     $CONTENT_HOME/library/metadata/<collection>/ and supports the two metadata layouts the
 *     production loaders used (one JSON file per token with an `attributes` array, OR a
 *     `traits.csv` with token_id/trait_type/value columns). No brand names, no fixed roster.
 *   - All paths resolve through engine/shared/paths.js (RD-3). Inputs and outputs live under
 *     $CONTENT_HOME/library/{metadata,tags}; nothing is read from or written to the checkout.
 *
 * This is a build tool (run via the library tooling / engine CLI), not a per-request hot path.
 */

const fs = require('fs');
const path = require('path');
const paths = require('../../shared/paths.js');

/**
 * Add one token's trait map to both inverted indexes (mutates `byToken`/`byTrait`).
 */
function addToken(byToken, byTrait, collection, tokenId, traits) {
  if (!byToken[collection]) byToken[collection] = {};
  if (!byTrait[collection]) byTrait[collection] = {};
  byToken[collection][tokenId] = traits;
  for (const [traitType, value] of Object.entries(traits)) {
    if (value == null || value === '') continue;
    const v = String(value);
    if (!byTrait[collection][traitType]) byTrait[collection][traitType] = {};
    if (!byTrait[collection][traitType][v]) byTrait[collection][traitType][v] = [];
    byTrait[collection][traitType][v].push(tokenId);
  }
}

/** Convert a token's `attributes` array (OpenSea-style) to a flat {traitType: value} map. */
function attributesToTraits(attributes) {
  const traits = {};
  for (const attr of attributes || []) {
    if (attr && attr.trait_type != null) traits[attr.trait_type] = attr.value;
  }
  return traits;
}

/**
 * Load a collection laid out as one JSON file per token (filename = token id, with or without
 * a .json extension), each containing an `attributes` array. Returns count loaded.
 */
function loadJsonPerToken(dir, byToken, byTrait, collection) {
  if (!fs.existsSync(dir)) return 0;
  let count = 0;
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (!fs.statSync(full).isFile()) continue;
    const tokenId = name.replace(/\.json$/iu, '');
    if (!/^\w[\w-]*$/u.test(tokenId)) continue;
    try {
      const data = JSON.parse(fs.readFileSync(full, 'utf8'));
      addToken(byToken, byTrait, collection, tokenId, attributesToTraits(data.attributes));
      count += 1;
    } catch {
      // Skip malformed token file — one bad file never aborts the build.
    }
  }
  return count;
}

/**
 * Load a collection laid out as a single traits.csv with token_id/trait_type/value columns
 * (one row per trait). Returns count of tokens loaded. Simple split-on-comma parse, matching
 * the production loader's contract (values do not contain commas in these files).
 */
function loadCsv(file, byToken, byTrait, collection) {
  if (!fs.existsSync(file)) return 0;
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/u).filter((l) => l.trim());
  if (lines.length < 2) return 0;
  const header = lines[0].split(',').map((h) => h.trim());
  const tokenIdx = header.indexOf('token_id');
  const typeIdx = header.indexOf('trait_type');
  const valueIdx = header.indexOf('value');
  if (tokenIdx < 0 || typeIdx < 0 || valueIdx < 0) return 0;

  const tokens = {};
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    const tokenId = (cols[tokenIdx] || '').trim();
    const traitType = (cols[typeIdx] || '').trim();
    const value = (cols[valueIdx] || '').trim();
    if (!tokenId || !traitType) continue;
    if (!tokens[tokenId]) tokens[tokenId] = {};
    tokens[tokenId][traitType] = value;
  }
  for (const [tokenId, traits] of Object.entries(tokens)) {
    addToken(byToken, byTrait, collection, tokenId, traits);
  }
  return Object.keys(tokens).length;
}

/**
 * Discover collection directories under <metadataRoot> and load each by auto-detecting its
 * layout (traits.csv if present, else JSON-per-token). If the collection dir holds no token
 * files directly, a single nested subdir is also probed for JSON-per-token, supporting
 * collections whose per-token files live one level down.
 * @returns {object} the in-memory indexes { byToken, byTrait, summary }.
 */
function build(metadataRoot) {
  const byToken = {};
  const byTrait = {};

  if (fs.existsSync(metadataRoot)) {
    for (const collection of fs.readdirSync(metadataRoot)) {
      const dir = path.join(metadataRoot, collection);
      let stat;
      try {
        stat = fs.statSync(dir);
      } catch {
        continue;
      }
      if (!stat.isDirectory()) continue;

      const csv = path.join(dir, 'traits.csv');
      if (fs.existsSync(csv)) {
        loadCsv(csv, byToken, byTrait, collection);
        continue;
      }
      // JSON-per-token, either directly in the collection dir or in a single nested subdir.
      let loaded = loadJsonPerToken(dir, byToken, byTrait, collection);
      if (loaded === 0) {
        for (const sub of fs.readdirSync(dir)) {
          const subDir = path.join(dir, sub);
          try {
            if (fs.statSync(subDir).isDirectory()) {
              loaded += loadJsonPerToken(subDir, byToken, byTrait, collection);
            }
          } catch {
            /* skip */
          }
        }
      }
    }
  }

  const summary = {};
  for (const [coll, tokens] of Object.entries(byToken)) {
    const traitTypes = Object.keys(byTrait[coll] || {});
    const uniqueValues = traitTypes.reduce((sum, tt) => sum + Object.keys(byTrait[coll][tt]).length, 0);
    summary[coll] = {
      total_tokens: Object.keys(tokens).length,
      trait_types: traitTypes.length,
      trait_type_names: traitTypes,
      unique_trait_values: uniqueValues,
    };
  }

  return { byToken, byTrait, summary };
}

/** Where the trait indexes live: $CONTENT_HOME/library/tags/. */
function tagsDir(env = process.env) {
  return path.join(paths.libraryDir(env), 'tags');
}

/** Where collection metadata lives: $CONTENT_HOME/library/metadata/. */
function metadataDir(env = process.env) {
  return path.join(paths.libraryDir(env), 'metadata');
}

/**
 * Build the trait indexes from $CONTENT_HOME/library/metadata and write them to
 * $CONTENT_HOME/library/tags. Returns the summary. Empty metadata ⇒ empty indexes, no throw.
 * @param {object} [options]  `env`, `metadataRoot` (override input), `outDir` (override output).
 * @returns {object} summary.
 */
function buildAndWrite(options = {}) {
  const env = options.env || process.env;
  const metadataRoot = options.metadataRoot || metadataDir(env);
  const outDir = options.outDir || tagsDir(env);
  const { byToken, byTrait, summary } = build(metadataRoot);

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'by-token.json'), JSON.stringify(byToken), 'utf8');
  fs.writeFileSync(path.join(outDir, 'by-trait.json'), JSON.stringify(byTrait), 'utf8');
  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8');
  return summary;
}

module.exports = {
  addToken,
  attributesToTraits,
  loadJsonPerToken,
  loadCsv,
  build,
  buildAndWrite,
  tagsDir,
  metadataDir,
};

if (require.main === module) {
  const summary = buildAndWrite();
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}
