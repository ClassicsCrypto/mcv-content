'use strict';

/**
 * engine/sources/ingest/manual.js  [N net-new — the FIRST-CLASS, no-scraper intake paths]
 *
 * The MANUAL-SUBMISSION and OFFICIAL-ACCOUNT-EXPORT import helpers (release-spec §2.4 step 2 paths
 * (a) and (b); RD-9 "manual submission + official-account exports are FIRST-CLASS; scraping is BYO";
 * DD-21 cold-start fallback). These are the intake paths that need NO adapter, NO credential, NO
 * network, and NO config opt-in — they ingest data the OPERATOR supplies (they are not a metered
 * third-party action), so they are ALWAYS available and never blocked by an absent scraper. This is
 * what makes onboarding never stall (the LAW / DD-21).
 *
 *   (a) MANUAL submission (model §10 #1, first-class): the operator drops corpus-item files — either
 *       already conforming to schemas/inputs/corpus-item.schema.json, OR loose objects this helper
 *       normalizes — into a staging path; importManualSubmission reads them, normalizes, trust-tags,
 *       and writes them into $CONTENT_HOME/corpora/<brand>/ (the canonical layout purge-corpora
 *       manages). The degenerate path — an operator who hand-authored conformant files directly into
 *       corpora/<brand>/ — already works with zero code; this helper is the convenience for loose
 *       drops and for routing a staging dir.
 *
 *   (b) OFFICIAL-ACCOUNT export: the platform's own archive/export (e.g. a Twitter/X data export's
 *       tweets.js / tweets.json) is converted by a shipped CONVERTER into corpus items. The operator
 *       is the data subject of their own export — this is the privacy-clean way to ingest one's OWN
 *       history without scraping. importAccountExport runs a converter (a shipped one keyed by
 *       `format`, or an operator-supplied function) and writes the items as account_class 'own'.
 *
 * TRUST: items from BOTH paths are still written Zone U (`untrusted-scraped`) by the source layer —
 * RD-8 is uniform: ALL ingested corpora enter untrusted, and only an explicit operator ATTESTATION
 * promotes a curated subset to operator-curated later. (Manual/export items are LIKELIER to be
 * promoted — they default to `retained` retention so purge-corpora keeps them — but they are not
 * auto-trusted. The promotion is a separate, deliberate operator action, not an import side effect.)
 *
 * RETENTION: manual + export items default to `retained` (operator-supplied keepers — purge-corpora
 * never auto-purges them); scraped items default to `standard` (they age out). The operator overrides
 * per call. captured_at is taken from the item / export, defaulted to now when absent, so
 * purge-corpora always has a basis.
 *
 * TESTABILITY (RD-12): pure mapping + filesystem reads under an injectable env. No network, no
 * credential, no LLM. Tests drive it with a temp CONTENT_HOME and synthetic files, zero keys.
 *
 * Tier-3 cleanliness (§0.3 r6 / RD-3): paths via the source/paths layer; no hardcoded
 * ids/handles/paths/brand strings/codenames.
 */

const fs = require('fs');
const path = require('path');

const source = require('./source');

const { SOURCE, RETENTION_CLASS, ACCOUNT_CLASS } = source;

// ---------------------------------------------------------------------------
// (a) Manual submission — operator drops corpus-item files
// ---------------------------------------------------------------------------

/** Read + JSON-parse one file into a value (or null on read/parse failure — never throws). */
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Read a .jsonl file into an array of parsed rows (skips unparseable lines). */
function readJsonl(file) {
  let raw = '';
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  return raw
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/** Flatten a parsed file value into an array of candidate items (object, array, or {items:[…]}). */
function itemsFromValue(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (Array.isArray(value.items)) return value.items;
  if (typeof value === 'object') return [value];
  return [];
}

/**
 * Import a MANUAL submission: read corpus-item files from a directory (or an explicit file list),
 * normalize + trust-tag + write each into $CONTENT_HOME/corpora/<brand>/. First-class, no adapter,
 * no credential, no opt-in (RD-9 / DD-21 — always available).
 *
 * Accepted file shapes (tolerant): a single corpus-item object, an array of them, a {items:[…]}
 * wrapper, or .jsonl with one item per line. Each item may already be schema-conformant or a loose
 * object normalizeItem maps. Items with no usable text are skipped (reported as invalid).
 *
 * @param {object} opts
 * @param {string}   opts.brand            REQUIRED brand id (corpora are brand-keyed, DD-10).
 * @param {string}   [opts.dir]            directory of corpus-item files to import (default: a
 *                                          per-brand `inbox/` staging dir under the corpus dir).
 * @param {string[]} [opts.files]          explicit file paths to import (overrides dir scan).
 * @param {string}   [opts.account_class]  'own' | 'competitor' default for unlabeled items
 *                                          (default 'own' — a manual drop is usually the operator's).
 * @param {string}   [opts.retention_class] default retention (default 'retained' — operator keeper).
 * @param {string[]} [opts.private_terms]  extra redaction deny-list terms (§13.3).
 * @param {boolean}  [opts.write]          write to disk (default true; false = return only).
 * @param {object}   [opts.env]            injectable env (default process.env).
 * @returns {{ source:'manual', read:number, items:object[], written:string[], invalid:Array,
 *             by_class:object }}
 */
function importManualSubmission(opts = {}) {
  const env = opts.env || process.env;
  if (!opts.brand) {
    throw new Error('importManualSubmission: opts.brand is required — corpora are brand-keyed (DD-10).');
  }

  // Resolve the input file set: explicit list, else scan the dir (default: corpora/<brand>/inbox).
  let files = [];
  if (Array.isArray(opts.files) && opts.files.length) {
    files = opts.files.slice();
  } else {
    const dir = opts.dir || path.join(source.corpusDir(opts.brand, env), 'inbox');
    try {
      files = fs
        .readdirSync(dir)
        .filter((f) => /\.(json|jsonl)$/iu.test(f))
        .map((f) => path.join(dir, f));
    } catch {
      files = []; // missing staging dir => nothing to import (not an error — manual path is optional)
    }
  }

  const raw = [];
  for (const file of files) {
    if (/\.jsonl$/iu.test(file)) {
      raw.push(...readJsonl(file));
    } else {
      raw.push(...itemsFromValue(readJson(file)));
    }
  }

  const accountClass = source.VALID_ACCOUNT_CLASS.has(opts.account_class)
    ? opts.account_class
    : ACCOUNT_CLASS.OWN;
  const retentionClass = source.VALID_RETENTION.has(opts.retention_class)
    ? opts.retention_class
    : RETENTION_CLASS.RETAINED;

  const result = source.ingestRawItems(raw, {
    env,
    brand: opts.brand,
    source: SOURCE.MANUAL,
    retention_class: retentionClass,
    accountClass,
    privateTerms: opts.private_terms || [],
    write: opts.write,
    nowMs: Date.now(),
  });

  return {
    source: SOURCE.MANUAL,
    read: raw.length,
    items: result.items,
    written: result.written,
    invalid: result.invalid,
    by_class: result.by_class,
  };
}

// ---------------------------------------------------------------------------
// (b) Official-account export — convert a platform's own archive into corpus items
// ---------------------------------------------------------------------------

/**
 * Shipped converters keyed by `format`. Each takes the parsed export value and returns loose raw
 * items (account_class 'own' — an official export is the operator's own history). Conservative,
 * shape-tolerant; an operator with an unusual export supplies their own converter via opts.convert.
 *
 * `twitter` understands the common Twitter/X data-export shapes:
 *   - the export's array of `{ tweet: { full_text|text, created_at, id_str, entities... } }` wrappers
 *   - a bare array of `{ full_text|text, created_at, id_str }`
 *   - { tweets: [...] }
 */
const CONVERTERS = Object.freeze({
  twitter(value, ctx = {}) {
    const handle = ctx.handle || undefined;
    const arr =
      (Array.isArray(value) && value) ||
      (value && Array.isArray(value.tweets) && value.tweets) ||
      [];
    const out = [];
    for (const row of arr) {
      const t = (row && (row.tweet || row)) || {};
      const text = t.full_text || t.text || '';
      if (typeof text !== 'string' || !text.trim()) continue;
      const item = { text, account_class: ACCOUNT_CLASS.OWN };
      if (t.created_at) item.captured_at = t.created_at;
      if (handle) item.author = handle;
      const id = t.id_str || t.id;
      if (id && handle) item.url = `https://x.com/${handle}/status/${id}`;
      out.push(item);
    }
    return out;
  },
  /** A generic pass-through: the export is already an array of loose items (or {items:[…]}). */
  generic(value) {
    if (Array.isArray(value)) return value;
    if (value && Array.isArray(value.items)) return value.items;
    if (value && typeof value === 'object') return [value];
    return [];
  },
});

/** @returns {string[]} the shipped converter format names. */
function exportFormats() {
  return Object.keys(CONVERTERS);
}

/**
 * Import an OFFICIAL-ACCOUNT export: convert the platform's own archive/export into corpus items and
 * write them as the operator's OWN-account corpus. First-class, no adapter, no credential, no
 * scraping — the operator is the data subject of their own export (RD-9). Always available.
 *
 * @param {object} opts
 * @param {string}   opts.brand            REQUIRED brand id (corpora are brand-keyed, DD-10).
 * @param {string}   [opts.file]           path to the export file to convert (JSON or JSONL).
 * @param {*}        [opts.data]           the parsed export value directly (overrides file).
 * @param {string}   [opts.format]         shipped converter name (default 'generic'; e.g. 'twitter').
 * @param {function} [opts.convert]        operator-supplied converter (value, ctx) -> rawItems[];
 *                                          overrides `format` (BYO converter for unusual exports).
 * @param {string}   [opts.handle]         the account handle (stamped as author; builds tweet URLs).
 * @param {string}   [opts.retention_class] default retention (default 'retained' — operator keeper).
 * @param {string[]} [opts.private_terms]  extra redaction deny-list terms (§13.3).
 * @param {boolean}  [opts.write]          write to disk (default true; false = return only).
 * @param {object}   [opts.env]            injectable env (default process.env).
 * @returns {{ source:'export', format:string, converted:number, items:object[], written:string[],
 *             invalid:Array, by_class:object }}
 */
function importAccountExport(opts = {}) {
  const env = opts.env || process.env;
  if (!opts.brand) {
    throw new Error('importAccountExport: opts.brand is required — corpora are brand-keyed (DD-10).');
  }

  // Resolve the export value: explicit data, else read the file (json or jsonl).
  let value = opts.data;
  if (value == null && opts.file) {
    value = /\.jsonl$/iu.test(opts.file) ? readJsonl(opts.file) : readJson(opts.file);
  }
  if (value == null) {
    throw new Error('importAccountExport: provide opts.data or a readable opts.file (the official export).');
  }

  // Pick the converter: operator-supplied wins, else shipped by format, else generic.
  let convert;
  let formatName;
  if (typeof opts.convert === 'function') {
    convert = opts.convert;
    formatName = 'custom';
  } else {
    formatName = typeof opts.format === 'string' && CONVERTERS[opts.format] ? opts.format : 'generic';
    convert = CONVERTERS[formatName];
  }

  const raw = convert(value, { handle: opts.handle }) || [];

  const retentionClass = source.VALID_RETENTION.has(opts.retention_class)
    ? opts.retention_class
    : RETENTION_CLASS.RETAINED;

  const result = source.ingestRawItems(raw, {
    env,
    brand: opts.brand,
    source: SOURCE.EXPORT,
    retention_class: retentionClass,
    accountClass: ACCOUNT_CLASS.OWN, // an official export is the operator's own history
    privateTerms: opts.private_terms || [],
    write: opts.write,
    nowMs: Date.now(),
  });

  return {
    source: SOURCE.EXPORT,
    format: formatName,
    converted: raw.length,
    items: result.items,
    written: result.written,
    invalid: result.invalid,
    by_class: result.by_class,
  };
}

module.exports = {
  // The first-class no-scraper import helpers (the LAW: export the manual import helpers).
  importManualSubmission,
  importAccountExport,
  // Export converters (shipped + introspection).
  CONVERTERS,
  exportFormats,
  // Small file helpers (exported for tests / sibling batches).
  readJson,
  readJsonl,
  itemsFromValue,
};
