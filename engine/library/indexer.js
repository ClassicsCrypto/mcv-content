'use strict';

/**
 * engine/library/indexer.js  [N net-new]
 *
 * The CORE media archive indexer (release-spec §1 tree engine/library/indexer.js: "Library
 * indexing runner behind the visual-model seam (§12.5), resumable batches + pre-run cost estimate
 * (DD-18; model §12)"; §1.5 original-design-spec "Auto-Indexing: run a script to automatically
 * index and tag library assets with a visual model — what is in the content, what it's about, a
 * description, duration, and archive tags"; §7.8 Archive index entry + retrieval contract; §15.4
 * cost; DD-18 estimate-and-confirm; DD-21 empty-library mode).
 *
 * WHAT THIS PORTS FROM PRODUCTION (the production index producers are local-only — release-spec
 * gap §2.5 producer/consumer split — so this is a clean rebuild of their REAL behavior, not a copy):
 *   - scan the media tree by extension into image/video assets;
 *   - per asset, ask a VISION MODEL for a description + searchable tags + a media-type read (+ a
 *     video duration when the model reports one), exactly the fields the production index.json /
 *     index.captioned.json carried (`caption`→description, `content_tags`/`visual_*`→tags,
 *     `media_kind`→type, `duration`), distilled down to the public archive-index-entry schema;
 *   - INCREMENTAL by a per-asset content hash (the production hash-index.json pattern) so a re-run
 *     never re-captions — and never re-bills — an already-indexed, unchanged asset.
 *   - DROPPED (regenerate-never-redact, §0.3): every brand-specific caption-prompt, the named
 *     collection layouts, the operator-OAuth single-vendor image CLI. The vision call now goes
 *     through the §12.5 provider seam (engine/gate/visual-check/provider.js), which the visual gate
 *     already uses; model/timeout/command come from config, never a vendor-named env var.
 *
 * TESTABILITY (RD-12 / mandatory): the vision call is dependency-injectable. buildLibraryIndex and
 * estimateIndexCost accept `opts.visionFn`; the default wraps the real provider seam. CI runs
 * ZERO-KEY by injecting a fake visionFn (no provider block, no secret, no network/child process).
 *
 * MUTATION SAFETY (DD-18): indexing SPENDS (the vision model is metered), so the build path is
 * estimate-and-confirm — the same contract as engine/cli/calibrate.js. buildLibraryIndex requires
 * an explicit confirmation (opts.yes / --yes) before any vision call; without it, it returns the
 * pre-run cost estimate and indexes NOTHING. It is idempotent and never re-bills already-processed
 * assets (the content-hash skip). --force re-indexes everything (a deliberate, confirmed re-spend).
 *
 * EMPTY-LIBRARY (DD-21): an absent or empty $CONTENT_HOME/library/media tree is a clean no-op — no
 * throw, no spend, an empty index left untouched. Nothing in the chain hard-depends on an index.
 *
 * Tier-3 cleanliness (§0.3 r6 / RD-3): no hardcoded paths/ids/brand strings/codenames. Every
 * instance path resolves through engine/shared/paths.js; the only model/credential references are
 * the §4 variable NAMES the operator's provider block declares.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const paths = require('../shared/paths.js');
const store = require('./index-store.js');

/** Media extensions the scanner recognizes, grouped by media kind (archive-index-entry `type`). */
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'bmp', 'tiff', 'tif']);
const ANIMATED_EXT = new Set(['gif']);
const VIDEO_EXT = new Set(['mp4', 'mov', 'm4v', 'webm', 'avi', 'mkv']);

/**
 * Indicative per-asset vision cost band (USD), used ONLY for the pre-run estimate preface. Marked
 * INDICATIVE / measured-as-of-release (§3.3/§17.6); config overrides it. NEVER a fabricated "real"
 * number — it is a documented placeholder until Step 8 measures the live figure into docs/cost.md.
 * Mirrors calibrate.js's DEFAULT_PER_SAMPLE_USD convention.
 */
const DEFAULT_PER_ASSET_USD = Object.freeze({ low: 0.001, high: 0.01 });

/** Hard ceiling on how many bytes of an asset we hash for the fingerprint (full hash for small
 * files; head+tail+size for large ones, so a 200MB video does not stall the scan). */
const FULL_HASH_MAX_BYTES = 8 * 1024 * 1024; // 8 MiB.

/** Classify a file extension into an archive-index-entry `type`, or null when not media. */
function classifyType(ext) {
  const e = String(ext || '').toLowerCase().replace(/^\./u, '');
  if (IMAGE_EXT.has(e)) return 'image';
  if (ANIMATED_EXT.has(e)) return 'animated_image';
  if (VIDEO_EXT.has(e)) return 'video';
  return null;
}

/** Is this a video (time-based) media type? (used to request/keep a duration). */
function isTimeBased(type) {
  return type === 'video';
}

/**
 * Compute a stable per-asset fingerprint. Small files are hashed in full (sha1, the production
 * hash-index algorithm); large files use a head+tail+size signature so the scan stays fast while
 * still changing when the file changes. The fingerprint is what makes re-runs skip-and-don't-rebill.
 * @param {string} absPath
 * @param {fs.Stats} stat
 * @returns {string}
 */
function fingerprintFile(absPath, stat) {
  const h = crypto.createHash('sha1');
  try {
    if (stat.size <= FULL_HASH_MAX_BYTES) {
      h.update(fs.readFileSync(absPath));
    } else {
      // Head + tail + size: bounded I/O, still sensitive to edits at either end or a size change.
      const fd = fs.openSync(absPath, 'r');
      try {
        const chunk = Buffer.allocUnsafe(1024 * 1024);
        const read1 = fs.readSync(fd, chunk, 0, chunk.length, 0);
        h.update(chunk.subarray(0, read1));
        const tailStart = Math.max(0, stat.size - chunk.length);
        const read2 = fs.readSync(fd, chunk, 0, chunk.length, tailStart);
        h.update(chunk.subarray(0, read2));
      } finally {
        fs.closeSync(fd);
      }
      h.update(`:${stat.size}`);
    }
  } catch {
    // Unreadable file: fall back to a path+size+mtime signature so it still gets a stable id.
    h.update(`${absPath}:${stat.size}:${stat.mtimeMs}`);
  }
  return h.digest('hex');
}

/**
 * Recursively scan $CONTENT_HOME/library/media for media files. Returns a flat list of scanned
 * assets with their CONTENT_HOME-relative path, media type, size, mtime, and fingerprint. An
 * absent media dir returns [] (empty-library — DD-21). Symlinks are NOT followed (avoids cycles /
 * escaping the library root). Hidden files/dirs (dotfiles) and the index/ledger files are skipped.
 * @param {object} [options]  `{ env, hash }` — hash:false uses a path+size+mtime signature only.
 * @returns {Array<{path:string, abs:string, type:string, ext:string, size:number, mtime:string, fingerprint:string}>}
 */
function scanMedia(options = {}) {
  const env = options.env || process.env;
  const useHash = options.hash !== false;
  const mediaDir = paths.libraryMediaDir(env);
  if (!fs.existsSync(mediaDir)) return []; // empty-library mode (DD-21).

  const homeRel = (abs) => {
    let rel;
    try {
      rel = path.relative(paths.contentHome(env), abs);
    } catch {
      rel = abs;
    }
    return rel.split(path.sep).join('/');
  };

  const out = [];
  const stack = [mediaDir];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable dir — skip, never throw.
    }
    for (const dirent of entries) {
      const name = dirent.name;
      if (name.startsWith('.')) continue; // dotfiles/dirs.
      const abs = path.join(dir, name);
      if (dirent.isSymbolicLink()) continue; // never follow symlinks out of the root.
      if (dirent.isDirectory()) {
        stack.push(abs);
        continue;
      }
      if (!dirent.isFile()) continue;
      const ext = path.extname(name).slice(1).toLowerCase();
      const type = classifyType(ext);
      if (!type) continue; // not a media file.
      let stat;
      try {
        stat = fs.statSync(abs);
      } catch {
        continue;
      }
      const fingerprint = useHash
        ? fingerprintFile(abs, stat)
        : crypto.createHash('sha1').update(`${homeRel(abs)}:${stat.size}:${stat.mtimeMs}`).digest('hex');
      out.push({
        path: homeRel(abs),
        abs,
        type,
        ext,
        size: stat.size,
        mtime: new Date(stat.mtimeMs).toISOString(),
        fingerprint,
      });
    }
  }
  // Deterministic order (stable index output, deterministic tests).
  out.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
  return out;
}

/**
 * Partition scanned assets into those needing indexing vs. those already current. An asset is
 * "needed" when --force is set, or it is not already indexed at its current fingerprint (per the
 * index-store membership test). This is the input to both the cost estimate and the build loop, so
 * the estimate and the actual spend can never disagree.
 * @param {Array<object>} scanned   from scanMedia().
 * @param {object} doc              from store.readIndex().
 * @param {boolean} force
 * @returns {{needed:Array<object>, current:Array<object>}}
 */
function partitionWork(scanned, doc, force) {
  const lookup = store.buildLookup(doc);
  const needed = [];
  const current = [];
  for (const asset of scanned) {
    if (!force && store.isIndexed(lookup, asset)) current.push(asset);
    else needed.push(asset);
  }
  return { needed, current };
}

/** Per-asset cost band (config.cost.per_asset_usd override → default). Mirrors calibrate.js. */
function costBandFor(env) {
  let band = null;
  try {
    // Lazy require so the module has no hard dependency on the CLI util at load time.
    // eslint-disable-next-line global-require
    const util = require('../cli/util.js');
    const config = util.loadSystemConfig(env);
    const c = config && config.cost && (config.cost.per_asset_usd || config.cost.per_index_asset_usd);
    if (c && Number.isFinite(Number(c.low)) && Number.isFinite(Number(c.high))) {
      band = { low: Number(c.low), high: Number(c.high) };
    }
  } catch {
    band = null;
  }
  return band || DEFAULT_PER_ASSET_USD;
}

/**
 * Estimate the cost of indexing (DD-18 / §15.4). Scans, partitions, and returns the count of
 * assets that WOULD be indexed × the configured per-asset band → a total band. Spends NOTHING and
 * makes NO vision call — safe to run any time (mirrors `engine calibrate --estimate-only`).
 * @param {object} [opts]
 * @param {object}   [opts.env]
 * @param {boolean}  [opts.force]   estimate a full re-index.
 * @param {boolean}  [opts.hash]    fingerprint by content hash (default true) vs path+size+mtime.
 * @param {Array}    [opts.scanned] pre-scanned assets (tests / re-use a prior scan).
 * @param {object}   [opts.index]   pre-read index document (tests).
 * @returns {{asset_count:number, total_scanned:number, already_indexed:number, per_asset_usd:object, estimated_total_usd:object, note:string}}
 */
function estimateIndexCost(opts = {}) {
  const env = opts.env || process.env;
  const scanned = opts.scanned || scanMedia({ env, hash: opts.hash });
  const doc = opts.index || store.readIndex(env);
  const { needed, current } = partitionWork(scanned, doc, Boolean(opts.force));
  const band = costBandFor(env);
  const n = needed.length;
  return {
    asset_count: n,
    total_scanned: scanned.length,
    already_indexed: current.length,
    per_asset_usd: band,
    estimated_total_usd: { low: +(n * band.low).toFixed(4), high: +(n * band.high).toFixed(4) },
    note:
      'INDICATIVE per-asset band (measured as of release; see docs/cost.md). The vision model is ' +
      'metered and host-runtime-owned (RD-2); already-indexed assets are skipped and never re-billed.',
  };
}

/**
 * Default vision function: ask the configured §12.5 provider to describe + tag ONE asset, returning
 * a normalized { description, tags, type, duration } object. This is the REAL seam (the same
 * provider.js the visual gate uses). It is the injectable default — tests pass their own visionFn
 * and never touch a provider, secret, or child process.
 *
 * @param {object} asset   a scanned asset { path, abs, type, ext, ... }.
 * @param {object} ctx     { provider (resolved), env, spawnSync?, httpPost? }.
 * @returns {{description:string, tags:string[], type:string, duration?:number}}
 */
function defaultVisionFn(asset, ctx) {
  // eslint-disable-next-line global-require
  const provider = require('../gate/visual-check/provider.js');
  // eslint-disable-next-line global-require
  const visualCheck = require('../gate/visual-check/index.js');
  const prompt = buildIndexPrompt(asset);
  const raw = provider.runVision(ctx.provider, {
    prompt,
    imagePath: asset.abs,
    env: ctx.env,
    spawnSync: ctx.spawnSync,
    httpPost: ctx.httpPost,
  });
  const answer = visualCheck.parseVisionAnswer(raw); // reuse the seam's JSON-line tolerant parser.
  return normalizeVisionAnswer(answer, asset);
}

/**
 * The indexing prompt: ask for a description, searchable tags, a media-type read, and (for video) a
 * duration — the §1.5 "what is in it, what it's about, a description, duration, archive tags" set.
 * Brand-neutral (no codenames). The prompt travels via stdin in the CLI provider (provider.js).
 */
function buildIndexPrompt(asset) {
  return [
    'Inspect the attached media asset and answer ONLY with a single JSON object on one line.',
    '',
    'Schema (every field required):',
    '{',
    '  "description": "one or two sentences describing what is visually in the asset and what it is about",',
    '  "tags": ["lowercase", "searchable", "keywords", "subjects, scene, mood, style"],',
    `  "type": "image | video | gif | animated_image (this asset looks like '${asset.type}')",`,
    isTimeBased(asset.type)
      ? '  "duration_seconds": number   // best estimate of the clip length in seconds, 0 if unknown'
      : '  "duration_seconds": 0',
    '}',
    '',
    'Rules:',
    '- Describe the IMAGE/VIDEO itself. Output JSON only. No prose, no markdown, no preamble.',
  ].join('\n');
}

/** Normalize whatever the vision model returned into { description, tags, type, duration? }. */
function normalizeVisionAnswer(answer, asset) {
  const a = answer && typeof answer === 'object' ? answer : {};
  const description = typeof a.description === 'string'
    ? a.description.trim()
    : (typeof a.caption === 'string' ? a.caption.trim() : '');
  // Tags: accept an array, or fold the production-style content_tags / visual_* fields.
  const tagSet = new Set();
  const pushTags = (v) => {
    if (Array.isArray(v)) v.forEach((t) => { if (t != null && String(t).trim()) tagSet.add(String(t).trim().toLowerCase()); });
    else if (typeof v === 'string' && v.trim()) v.split(/[,;]/u).forEach((t) => { if (t.trim()) tagSet.add(t.trim().toLowerCase()); });
  };
  pushTags(a.tags);
  pushTags(a.content_tags);
  pushTags(a.visual_subjects);
  pushTags(a.visual_scene);
  pushTags(a.visual_mood);
  pushTags(a.visual_style);
  const tags = [...tagSet];

  // Type: trust the model's read if it is a valid enum, else keep the extension-based classification.
  const VALID = new Set(['image', 'video', 'gif', 'animated_image']);
  let type = typeof a.type === 'string' && VALID.has(a.type.toLowerCase()) ? a.type.toLowerCase() : asset.type;
  if (type === 'gif') type = 'animated_image'; // schema enum prefers animated_image for gifs.

  const out = { description, tags, type };
  const dur = Number(a.duration_seconds ?? a.duration);
  if (isTimeBased(type) && Number.isFinite(dur) && dur > 0) out.duration = dur;
  return out;
}

/**
 * Compose a schema-conformant archive-index-entry from a scanned asset + a vision result. Carries
 * source_class (default 'library' — these are operator-owned library assets; §7.8 enum). Adds the
 * internal `fingerprint` field the store uses for incremental skip (not part of the persisted public
 * schema's required set, but allowed alongside it for the store; see validateEntry which checks the
 * SCHEMA-required/typed fields, not the bookkeeping fields).
 */
function composeEntry(asset, vision, opts) {
  const entry = {
    asset_id: asset.path, // CONTENT_HOME-relative path is the stable id (matches check.js entryAssetId).
    path: asset.path,
    type: vision.type || asset.type,
    source_class: opts.sourceClass || 'library',
  };
  if (vision.description) entry.description = vision.description;
  if (vision.tags && vision.tags.length) entry.tags = vision.tags;
  if (typeof vision.duration === 'number' && vision.duration > 0) entry.duration = vision.duration;
  if (Array.isArray(opts.characterRefs) && opts.characterRefs.length) entry.character_refs = opts.characterRefs;
  // Bookkeeping for incremental re-runs (store reads these; not in the §7.8 required set).
  entry.fingerprint = asset.fingerprint;
  entry.indexed_at = new Date().toISOString();
  return entry;
}

/** archive-index-entry source_class enum (schemas/artifacts/archive-index-entry.schema.json). */
const SOURCE_CLASS = new Set(['library', 'generated', 'modified', 'user-attached']);
/** archive-index-entry type enum. */
const ENTRY_TYPE = new Set(['image', 'video', 'gif', 'animated_image']);

/**
 * Lightweight, dependency-free structural validation of an archive-index-entry (the engine ships no
 * ajv — §1 zero-deps). Enforces the schema's required fields, enums, and field types. Does NOT
 * reject the bookkeeping fields (fingerprint/indexed_at) the store needs — those are additive
 * runtime metadata, validated separately from the public-schema contract. Returns an array of
 * human-readable errors ([] ⇒ valid).
 * @param {object} entry
 * @returns {string[]}
 */
function validateEntry(entry) {
  const errs = [];
  if (!entry || typeof entry !== 'object') return ['entry is not an object'];
  if (typeof entry.asset_id !== 'string' || !entry.asset_id) errs.push('asset_id (string) is required');
  if (typeof entry.path !== 'string' || !entry.path) errs.push('path (string) is required');
  if (!ENTRY_TYPE.has(entry.type)) errs.push(`type must be one of ${[...ENTRY_TYPE].join('|')}`);
  if (!SOURCE_CLASS.has(entry.source_class)) errs.push(`source_class must be one of ${[...SOURCE_CLASS].join('|')}`);
  if (entry.description != null && typeof entry.description !== 'string') errs.push('description must be a string');
  if (entry.tags != null && !Array.isArray(entry.tags)) errs.push('tags must be an array');
  if (entry.duration != null && !(Number.isFinite(entry.duration) && entry.duration >= 0)) errs.push('duration must be a number >= 0');
  if (entry.character_refs != null && !Array.isArray(entry.character_refs)) errs.push('character_refs must be an array');
  return errs;
}

/**
 * Resolve the §12.5 provider block from config the same way the visual-gate CLI does, so the
 * default visionFn uses the operator's configured provider. Absent/unknown ⇒ null (degrade).
 */
function resolveProviderBlock(env) {
  try {
    // eslint-disable-next-line global-require
    const util = require('../cli/util.js');
    // eslint-disable-next-line global-require
    const provider = require('../gate/visual-check/provider.js');
    const sys = util.loadSystemConfig(env);
    const block = (sys && sys.visual_provider) || (sys && sys.providers && sys.providers.visual) || null;
    return provider.resolveProvider(block);
  } catch {
    return null;
  }
}

/**
 * BUILD the library index (the metered path). Scans media, skips already-indexed assets, and for
 * each remaining asset calls the (injectable) vision function to produce a description + tags +
 * type (+ duration), validates the resulting archive-index-entry, and merges it into the index
 * (written atomically via index-store). DD-18: requires confirmation (opts.yes) before any vision
 * call; without it, returns the cost estimate and indexes nothing. Idempotent; --force re-indexes.
 *
 * @param {object} [opts]
 * @param {object}   [opts.env]
 * @param {boolean}  [opts.yes]          DD-18 confirmation — REQUIRED before any spend.
 * @param {boolean}  [opts.estimateOnly] return the estimate and exit (no spend, no confirmation).
 * @param {boolean}  [opts.force]        re-index every asset (a deliberate confirmed re-spend).
 * @param {boolean}  [opts.hash]         fingerprint by content hash (default true).
 * @param {number}   [opts.batchSize]    persist the index every N indexed assets (resumable; default 25).
 * @param {string}   [opts.sourceClass]  source_class for new entries (default 'library').
 * @param {function} [opts.visionFn]     injectable vision call (asset, ctx) ⇒ {description,tags,type,duration?}.
 *                                        Default wraps the §12.5 provider seam (zero-key in tests).
 * @param {object}   [opts.provider]     pre-resolved provider (else resolved from config).
 * @param {function} [opts.spawnSync]    forwarded to the default visionFn's CLI provider (tests).
 * @param {function} [opts.httpPost]     forwarded to the default visionFn's HTTP provider (tests).
 * @returns {Promise<{ok:boolean, status:string, summary:string, estimate:object, indexed:number, skipped:number, failed:Array, total_assets:number, awaiting_confirmation?:boolean}>}
 */
async function buildLibraryIndex(opts = {}) {
  const env = opts.env || process.env;
  const hash = opts.hash;
  const force = Boolean(opts.force);

  const scanned = scanMedia({ env, hash });
  const doc = store.readIndex(env);

  // Empty-library / nothing-to-do fast paths (DD-21): never throw, never spend.
  if (scanned.length === 0) {
    return {
      ok: true,
      status: 'empty-library',
      summary: 'no media found under library/media — empty-library mode (DD-21); nothing to index.',
      estimate: estimateIndexCost({ env, force, hash, scanned, index: doc }),
      indexed: 0,
      skipped: 0,
      failed: [],
      total_assets: doc.total_assets,
    };
  }

  const estimate = estimateIndexCost({ env, force, hash, scanned, index: doc });
  const { needed } = partitionWork(scanned, doc, force);

  if (needed.length === 0) {
    return {
      ok: true,
      status: 'up-to-date',
      summary: `all ${scanned.length} assets already indexed — nothing to do (no re-billing).`,
      estimate,
      indexed: 0,
      skipped: scanned.length,
      failed: [],
      total_assets: doc.total_assets,
    };
  }

  // Estimate-only: report and exit (no spend, no confirmation needed) — mirrors calibrate.js.
  if (opts.estimateOnly) {
    return {
      ok: true,
      status: 'estimate-only',
      summary: `index estimate: ${needed.length} assets ≈ $${estimate.estimated_total_usd.low}–$${estimate.estimated_total_usd.high} (indicative)`,
      estimate,
      indexed: 0,
      skipped: scanned.length - needed.length,
      failed: [],
      total_assets: doc.total_assets,
    };
  }

  // DD-18: REQUIRE confirmation before any vision call (the metered action). No --yes ⇒ halt with
  // the estimate; the agent re-invokes with yes:true. The engine never spends silently.
  if (!opts.yes) {
    return {
      ok: false,
      status: 'awaiting-confirmation',
      awaiting_confirmation: true,
      summary: `indexing requires confirmation: ${needed.length} assets ≈ $${estimate.estimated_total_usd.low}–$${estimate.estimated_total_usd.high} (indicative)`,
      estimate,
      indexed: 0,
      skipped: scanned.length - needed.length,
      failed: [],
      total_assets: doc.total_assets,
    };
  }

  // Resolve the vision function: injected fake (tests/host) OR the real §12.5 provider seam.
  const visionFn = typeof opts.visionFn === 'function' ? opts.visionFn : defaultVisionFn;
  const provider = opts.provider || resolveProviderBlock(env);
  // When using the DEFAULT vision function, a provider MUST be configured (else there is nothing to
  // call). An injected visionFn bypasses this entirely (zero-key tests).
  if (!opts.visionFn && !provider) {
    return {
      ok: false,
      status: 'no-provider',
      summary: 'confirmed, but no vision provider is configured (§12.5) — set a provider block or pass an injected visionFn.',
      estimate,
      indexed: 0,
      skipped: scanned.length - needed.length,
      failed: [],
      total_assets: doc.total_assets,
    };
  }

  const ctx = { provider, env, spawnSync: opts.spawnSync, httpPost: opts.httpPost };
  const batchSize = Number.isFinite(opts.batchSize) && opts.batchSize > 0 ? Number(opts.batchSize) : 25;

  let working = doc;
  let pending = [];
  let indexed = 0;
  const failed = [];

  const flush = () => {
    if (pending.length === 0) return;
    working = store.merge(working, pending);
    store.writeIndex(working, { env });
    pending = [];
  };

  for (const asset of needed) {
    let vision;
    try {
      vision = await visionFn(asset, ctx);
    } catch (err) {
      // A single asset's vision failure NEVER aborts the run or corrupts the index — record it and
      // move on (already-indexed assets stay billed-once; this asset can be retried next run).
      failed.push({ path: asset.path, error: err && err.message ? err.message : String(err) });
      continue;
    }
    const entry = composeEntry(asset, vision || {}, opts);
    const errs = validateEntry(entry);
    if (errs.length) {
      failed.push({ path: asset.path, error: `invalid entry: ${errs.join('; ')}` });
      continue;
    }
    pending.push(entry);
    indexed += 1;
    if (pending.length >= batchSize) flush(); // resumable: persist progress in batches.
  }
  flush();

  return {
    ok: failed.length === 0,
    status: failed.length === 0 ? 'indexed' : 'indexed-with-errors',
    summary:
      `indexed ${indexed} asset${indexed === 1 ? '' : 's'}` +
      (failed.length ? `, ${failed.length} failed (retry next run)` : '') +
      `; ${scanned.length - needed.length} already current.`,
    estimate,
    indexed,
    skipped: scanned.length - needed.length,
    failed,
    total_assets: working.total_assets,
  };
}

module.exports = {
  DEFAULT_PER_ASSET_USD,
  IMAGE_EXT,
  ANIMATED_EXT,
  VIDEO_EXT,
  classifyType,
  fingerprintFile,
  scanMedia,
  partitionWork,
  estimateIndexCost,
  buildLibraryIndex,
  // Exposed for the CLI verb + tests.
  buildIndexPrompt,
  normalizeVisionAnswer,
  composeEntry,
  validateEntry,
  defaultVisionFn,
  resolveProviderBlock,
  costBandFor,
  // Re-export the store read/merge API so callers have a single entry point (task export contract).
  readIndex: store.readIndex,
  writeIndex: store.writeIndex,
  mergeIndex: store.merge,
  buildLookup: store.buildLookup,
  isIndexed: store.isIndexed,
};
