'use strict';

/**
 * engine/library/index-store.js  [N net-new]
 *
 * The read / write / merge store for the media archive index that the retrieval path consumes
 * (release-spec §7.8 Archive index entry + retrieval contract; §1 tree engine/library/indexer.js
 * row; DD-14 index-on-confirmed-publish; DD-21 empty-library mode). This module owns the on-disk
 * shape of $CONTENT_HOME/library/index.json and NOTHING else — the indexer (indexer.js) produces
 * entries and calls in here to persist/merge them; the retrieval scorer (check.js) and the C4
 * setup verifier read the same file. Keeping the document shape in one place is why both consumers
 * keep working as the index grows (see the dual-key contract below).
 *
 * DUAL-KEY CONTRACT (load-bearing — do not drop either key):
 *   Two existing consumers read this file with DIFFERENT key names:
 *     - engine/library/check.js loadIndex() reads  `parsed.assets`  (the retrieval entries array);
 *     - engine/setup/checkpoints.js verifyC4()  reads `index.entries` (counts indexed assets).
 *   Rather than touch either consumer, the store ALWAYS writes both `assets` and `entries`
 *   pointing at the same array. readIndex() tolerates a file that has only one of them (a
 *   hand-authored index, or a future writer), so the store is forward/backward compatible.
 *
 * INCREMENTAL STATE (idempotency, no re-billing — release-spec §15.4 "MUST NOT re-bill indexing",
 * §2.6 setup idempotence): each entry carries a fingerprint the indexer computes (a content hash,
 * or a path+size+mtime signature when hashing is skipped). The store exposes a fast lookup map
 * (by asset path AND by fingerprint) so the indexer can decide, for each scanned file, whether it
 * is ALREADY indexed and must be skipped (no vision call, no spend). The store never calls a model
 * itself; it only persists what the indexer hands it and answers "is this already in the index?".
 *
 * MUTATION SAFETY: writes are atomic (temp file + rename) so a crash mid-write never truncates a
 * live index — a shell `>` redirect once truncated a live rule file to 0 bytes, which is exactly the
 * failure mode this avoids. merge() is order-independent and idempotent: re-merging the same entry
 * replaces it in place (keyed by asset_id, then path) rather than appending a duplicate.
 *
 * Tier-3 cleanliness (§0.3 r6 / RD-3): no hardcoded paths/ids/brand strings/codenames. The only
 * instance path used is paths.libraryIndex(env); this module constructs none of its own.
 */

const fs = require('fs');
const path = require('path');
const paths = require('../shared/paths.js');

/** Document format version persisted in the index header (bump on a breaking shape change). */
const INDEX_FORMAT_VERSION = 1;

/**
 * The canonical asset key for an entry: explicit asset_id, else its CONTENT_HOME-relative path.
 * Mirrors check.js's entryAssetId() so the store and the scorer agree on identity.
 * @param {object} entry
 * @returns {string}
 */
function entryKey(entry) {
  if (!entry || typeof entry !== 'object') return '';
  if (typeof entry.asset_id === 'string' && entry.asset_id) return entry.asset_id;
  return normalizePathKey(entry.path || '');
}

/** Normalize a path to a forward-slash, library/-relative comparison key (no I/O). */
function normalizePathKey(p) {
  return String(p || '')
    .trim()
    .replace(/\\/gu, '/')
    .replace(/^\.?\//u, '')
    .replace(/^library\//iu, '');
}

/**
 * Read the archive index from $CONTENT_HOME/library/index.json. Empty-library mode (DD-21): a
 * missing, empty, or unparseable index returns a fresh empty document — NEVER throws. Tolerates a
 * file that carries `assets`, `entries`, both, or neither (forward/backward compatible).
 * @param {object} [env]  default process.env (injectable for tests).
 * @returns {{version:number, generated_at:(string|null), assets:Array<object>, entries:Array<object>, by_type:object, total_assets:number}}
 */
function readIndex(env = process.env) {
  let file;
  try {
    file = paths.libraryIndex(env);
  } catch {
    return emptyDoc(); // CONTENT_HOME unset — behave as empty-library (callers gate on this).
  }
  if (!fs.existsSync(file)) return emptyDoc();
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return emptyDoc(); // a corrupt index degrades to empty-library, never a hard crash (DD-21).
  }
  // Accept either key; prefer `assets` when both are present and disagree only by reference.
  const arr = Array.isArray(parsed.assets)
    ? parsed.assets
    : Array.isArray(parsed.entries)
      ? parsed.entries
      : [];
  return normalizeDoc(parsed, arr);
}

/** A fresh empty index document (both keys present so either consumer sees an empty array). */
function emptyDoc() {
  return {
    version: INDEX_FORMAT_VERSION,
    generated_at: null,
    assets: [],
    entries: [],
    by_type: {},
    total_assets: 0,
  };
}

/** Re-derive the header counts from the entries array and keep `assets`/`entries` in lockstep. */
function normalizeDoc(parsed, arr) {
  const assets = Array.isArray(arr) ? arr : [];
  const byType = {};
  for (const e of assets) {
    const t = e && typeof e.type === 'string' ? e.type : 'unknown';
    byType[t] = (byType[t] || 0) + 1;
  }
  return {
    version: Number.isFinite(parsed && parsed.version) ? Number(parsed.version) : INDEX_FORMAT_VERSION,
    generated_at: parsed && typeof parsed.generated_at === 'string' ? parsed.generated_at : null,
    assets,
    entries: assets, // same reference — the dual-key contract.
    by_type: byType,
    total_assets: assets.length,
  };
}

/**
 * Build a fast membership index for the indexer's incremental skip decision. Returns lookups keyed
 * by (a) the normalized asset path and (b) the per-asset fingerprint, so a re-run can answer
 * "already indexed?" in O(1) without re-reading the file per asset.
 * @param {{assets:Array<object>}} doc  a document from readIndex().
 * @returns {{byPath:Map<string,object>, byFingerprint:Map<string,object>, byKey:Map<string,object>}}
 */
function buildLookup(doc) {
  const byPath = new Map();
  const byFingerprint = new Map();
  const byKey = new Map();
  for (const entry of (doc && doc.assets) || []) {
    if (!entry || typeof entry !== 'object') continue;
    const pk = normalizePathKey(entry.path || '');
    if (pk) byPath.set(pk, entry);
    const k = entryKey(entry);
    if (k) byKey.set(k, entry);
    const fp = entry.fingerprint || entry.content_hash || null;
    if (fp) byFingerprint.set(String(fp), entry);
  }
  return { byPath, byFingerprint, byKey };
}

/**
 * Is an asset already indexed AND unchanged? An asset matches when its path is present and its
 * fingerprint equals the stored one (so an edited-in-place file with the same path but a new
 * fingerprint is correctly treated as NOT current, and will be re-indexed). When the caller has no
 * fingerprint (hashing disabled and no signature), path presence alone counts as indexed.
 * @param {{byPath:Map,byFingerprint:Map}} lookup  from buildLookup().
 * @param {{path:string, fingerprint?:string}} asset
 * @returns {boolean}
 */
function isIndexed(lookup, asset) {
  if (!lookup || !asset) return false;
  const fp = asset.fingerprint || asset.content_hash || null;
  if (fp && lookup.byFingerprint.has(String(fp))) return true;
  const pk = normalizePathKey(asset.path || '');
  if (!pk) return false;
  const existing = lookup.byPath.get(pk);
  if (!existing) return false;
  // Path is present: if both sides have a fingerprint, they must match to count as current.
  const existingFp = existing.fingerprint || existing.content_hash || null;
  if (fp && existingFp) return String(fp) === String(existingFp);
  // No fingerprint to compare on one side ⇒ path presence is the only signal we have.
  return true;
}

/**
 * Merge new/updated entries into an index document, idempotently. An incoming entry REPLACES an
 * existing one with the same key (asset_id, else normalized path); otherwise it is appended. Order
 * of the result is: existing entries (kept in place, possibly updated), then genuinely-new entries
 * in input order — deterministic so repeated merges of the same input produce byte-identical output.
 * Pure: returns a new document, mutates nothing.
 * @param {{assets:Array<object>}} doc       base document (from readIndex()).
 * @param {Array<object>} newEntries         entries the indexer produced this run.
 * @returns {{...doc, assets:Array, entries:Array, by_type:object, total_assets:number}}
 */
function merge(doc, newEntries) {
  const base = (doc && Array.isArray(doc.assets)) ? doc.assets.slice() : [];
  const incoming = Array.isArray(newEntries) ? newEntries : [];

  // Index existing entries by key for in-place replacement.
  const indexByKey = new Map();
  base.forEach((e, i) => {
    const k = entryKey(e);
    if (k) indexByKey.set(k, i);
  });

  const appended = [];
  for (const entry of incoming) {
    if (!entry || typeof entry !== 'object') continue;
    const k = entryKey(entry);
    if (k && indexByKey.has(k)) {
      base[indexByKey.get(k)] = entry; // replace in place (idempotent).
    } else {
      if (k) indexByKey.set(k, base.length + appended.length);
      appended.push(entry);
    }
  }
  const assets = base.concat(appended);
  return normalizeDoc({ ...(doc || {}), version: INDEX_FORMAT_VERSION }, assets);
}

/**
 * Persist an index document atomically to $CONTENT_HOME/library/index.json. Writes BOTH `assets`
 * and `entries` (dual-key contract) plus header counts, then renames a temp file over the target so
 * a crash mid-write never leaves a truncated index. Ensures the library/ dir exists first.
 * @param {{assets:Array<object>}} doc
 * @param {object} [options]  `{ env }`.
 * @returns {{path:string, total_assets:number, by_type:object}}
 */
function writeIndex(doc, options = {}) {
  const env = options.env || process.env;
  const file = paths.libraryIndex(env);
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });

  const normalized = normalizeDoc({ ...(doc || {}) }, (doc && doc.assets) || []);
  const out = {
    version: INDEX_FORMAT_VERSION,
    generated_at: new Date().toISOString(),
    total_assets: normalized.total_assets,
    by_type: normalized.by_type,
    assets: normalized.assets,
    entries: normalized.assets, // dual-key: C4 reads `entries`, retrieval reads `assets`.
  };
  const body = `${JSON.stringify(out, null, 2)}\n`;
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, body, 'utf8');
  fs.renameSync(tmp, file); // atomic on the same filesystem.
  return { path: file, total_assets: out.total_assets, by_type: out.by_type };
}

module.exports = {
  INDEX_FORMAT_VERSION,
  entryKey,
  normalizePathKey,
  readIndex,
  emptyDoc,
  buildLookup,
  isIndexed,
  merge,
  writeIndex,
};
