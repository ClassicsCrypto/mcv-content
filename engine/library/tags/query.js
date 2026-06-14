'use strict';

/**
 * engine/library/tags/query.js  [A adapted]
 *
 * Trait-index query (release-spec §1 tree engine/library/tags/; §7.8 retrieval support).
 * Queries the inverted trait indexes built by build-index.js to find tokens in a collection
 * that match a set of trait filters. This is the deterministic trait-match path that
 * complements free-text retrieval (engine/library/check.js) for collections that carry
 * structured per-token traits.
 *
 * Adaptation from production (regenerate-never-redact, §0.3):
 *   - Collection-agnostic: no fixed collection roster, no brand names. The collection id and
 *     trait types are whatever build-index.js discovered from $CONTENT_HOME/library/metadata.
 *   - Indexes load through engine/shared/paths.js from $CONTENT_HOME/library/tags (RD-3);
 *     the production version read sibling files relative to the module's own directory.
 *   - Pure query functions are exported and unit-testable on injected indexes; file loading is
 *     a thin wrapper, so an empty/missing index returns empty results and never throws.
 */

const fs = require('fs');
const path = require('path');
const { tagsDir } = require('./build-index.js');

/** Read a tags-dir JSON file, returning `fallback` on missing/malformed. */
function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/**
 * Load the three trait indexes from $CONTENT_HOME/library/tags. Missing files ⇒ empty objects.
 * @param {object} [options]  `env`, `dir` (override the tags dir).
 * @returns {{byToken: object, byTrait: object, summary: object}}
 */
function loadIndexes(options = {}) {
  const dir = options.dir || tagsDir(options.env || process.env);
  return {
    byToken: readJson(path.join(dir, 'by-token.json'), {}),
    byTrait: readJson(path.join(dir, 'by-trait.json'), {}),
    summary: readJson(path.join(dir, 'summary.json'), {}),
  };
}

/**
 * Find token ids in `collection` matching ALL of `filters` (case-insensitive on trait type and
 * value). Pure: operates on the supplied `byTrait` index. Unknown collection / no filters ⇒ [].
 * @param {object} byTrait
 * @param {string} collection
 * @param {object} filters  { "<TraitType>": "<value>", … }
 * @returns {string[]} matching token ids (intersection across all filters).
 */
function queryTraits(byTrait, collection, filters) {
  const coll = byTrait[collection];
  if (!coll || !filters || Object.keys(filters).length === 0) return [];

  let matching = null;
  for (const [traitType, value] of Object.entries(filters)) {
    // Case-insensitive trait-type resolution.
    const resolvedType =
      Object.keys(coll).find((t) => t.toLowerCase() === String(traitType).toLowerCase()) || traitType;
    const valueMap = coll[resolvedType] || {};
    // Case-insensitive value resolution.
    const ids =
      valueMap[value] ||
      Object.entries(valueMap).find(([k]) => k.toLowerCase() === String(value).toLowerCase())?.[1] ||
      [];
    matching = matching === null ? new Set(ids) : new Set(ids.filter((id) => matching.has(id)));
  }
  return matching ? [...matching] : [];
}

/**
 * Full query: resolve filters to token ids and attach each token's full trait map.
 * @param {object} indexes  { byToken, byTrait } (from loadIndexes or injected).
 * @param {string} collection
 * @param {object} filters
 * @param {object} [options]  `limit` (default 20).
 * @returns {{collection: string, filters: object, total: number, tokens: Array<{token_id, traits}>}}
 */
function query(indexes, collection, filters, options = {}) {
  const limit = options.limit ?? 20;
  const ids = queryTraits(indexes.byTrait, collection, filters);
  const byToken = indexes.byToken[collection] || {};
  const tokens = ids.slice(0, limit).map((id) => ({ token_id: id, traits: byToken[id] || {} }));
  return { collection, filters, total: ids.length, tokens };
}

/** List the trait types (and value counts) available for a collection. */
function traitTypes(byTrait, collection) {
  const coll = byTrait[collection] || {};
  return Object.fromEntries(Object.entries(coll).map(([tt, values]) => [tt, Object.keys(values).length]));
}

module.exports = {
  loadIndexes,
  queryTraits,
  query,
  traitTypes,
};
