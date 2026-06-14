'use strict';

/**
 * engine/library/organize.js  [N net-new]
 *
 * Library folder AUTO-SORT (original-design-spec §1.5 "Folder Sorting": split content into
 * template folders — Images / Videos / AI-generated; release-spec §1.5 asset management).
 *
 * Classifies every media asset under $CONTENT_HOME/library/ and sorts it into a template
 * subfolder by kind:
 *   Images/        stills (png/jpg/jpeg/webp/bmp/tiff/svg/heic …)
 *   Videos/        time-based media (mp4/mov/m4v/webm/avi/mkv/gif animations …)
 *   AI-generated/  anything marked as model-generated (precedence over kind)
 *
 * AI-generated detection (marker-first, then kind-folder):
 *   - a sibling sidecar (<file>.json / <file>.meta.json / <file>.txt) declaring the asset as
 *     generated (source_class:"generated"|"modified", ai_generated:true, generator/model set,
 *     or a literal "generated"/"ai-generated" token in a .txt sidecar), OR
 *   - a generation marker in the filename (ai-gen / aigen / ai_generated / generated /
 *     gpt-image / dalle / sdxl / midjourney / flux / imagen … — brand-neutral, structural), OR
 *   - an archive-index entry whose source_class is "generated" or "modified".
 *
 * SAFETY (LIBRARY-INDEXER FEATURE LAW / DD-18 mutation-safety, RD-3 containment):
 *   - DRY-RUN BY DEFAULT: reports the planned moves and changes nothing. Pass --apply (alias
 *     --yes / opts.apply) to perform them.
 *   - IDEMPOTENT: an asset already living in its correct template subfolder is left in place;
 *     a second run is a no-op. Name collisions in the destination get a numeric suffix so a
 *     move never overwrites an existing file (no data loss).
 *   - CONTAINMENT (RD-3): operates ONLY inside $CONTENT_HOME/library. Every source and every
 *     destination is verified to resolve inside the library root; anything that would escape is
 *     refused and reported, never moved. This is a pure FS reorganization — no spend, no network.
 *   - TOLERANT: an unreadable/unstattable file is reported and skipped — never fatal. One bad
 *     file never aborts the sort.
 *   - INDEX CONSISTENCY: when an archive-index entry (schemas/artifacts/archive-index-entry)
 *     references a moved asset by its $CONTENT_HOME-relative `path`, that path is rewritten on
 *     --apply so retrieval (engine/library/check.js) stays pointing at the file.
 *
 * Tier-3 cleanliness (§0.3 r6): no hardcoded instance paths/ids/brand names; the library root
 * resolves through engine/shared/paths.js (RD-3). The only constants are file-extension and
 * generation-marker vocabularies, which are structural, not brand-specific.
 */

const fs = require('fs');
const path = require('path');
const paths = require('../shared/paths.js');

/** Template subfolder names (original-design-spec §1.5). */
const FOLDER = Object.freeze({
  IMAGES: 'Images',
  VIDEOS: 'Videos',
  AI_GENERATED: 'AI-generated',
});
const TEMPLATE_FOLDERS = Object.freeze([FOLDER.IMAGES, FOLDER.VIDEOS, FOLDER.AI_GENERATED]);

/** Still-image extensions ⇒ Images/. */
const IMAGE_EXT = new Set([
  'png', 'jpg', 'jpeg', 'webp', 'bmp', 'tif', 'tiff', 'svg', 'heic', 'heif', 'avif', 'ico',
]);
/** Time-based extensions ⇒ Videos/ (gif is animated ⇒ Videos by §1.5 intent). */
const VIDEO_EXT = new Set([
  'mp4', 'mov', 'm4v', 'webm', 'avi', 'mkv', 'gif', 'mpg', 'mpeg', 'wmv', 'flv', '3gp',
]);

/** Sidecar extensions probed for a generation marker, in order. */
const SIDECAR_SUFFIXES = ['.json', '.meta.json', '.txt'];

/**
 * Filename tokens that mark a generated asset (brand-neutral, structural). Matched on a
 * separator-bounded basis so "imagen" never matches inside "imagenuity" etc.
 */
const GEN_FILENAME_MARKERS = [
  'ai-gen', 'aigen', 'ai_gen', 'ai-generated', 'ai_generated', 'aigenerated',
  'generated', 'gen-img', 'genimg',
  'gpt-image', 'gptimage', 'dalle', 'dall-e', 'sdxl', 'stable-diffusion', 'sd-',
  'midjourney', 'mj-', 'flux', 'imagen', 'firefly', 'ideogram',
];

/** A reusable regex matching any generation marker on a separator boundary. */
const GEN_FILENAME_RE = new RegExp(
  `(?:^|[-_. ])(?:${GEN_FILENAME_MARKERS.map((m) => m.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('|')})(?:[-_. ]|$)`,
  'iu',
);

/** Lower-case extension without the dot, or '' for none. */
function extOf(file) {
  const e = path.extname(file);
  return e ? e.slice(1).toLowerCase() : '';
}

/** The §1.5 KIND for a file by extension: 'image' | 'video' | null (non-media). */
function kindByExtension(file) {
  const ext = extOf(file);
  if (IMAGE_EXT.has(ext)) return 'image';
  if (VIDEO_EXT.has(ext)) return 'video';
  return null;
}

/** Does the filename itself carry a generation marker? */
function nameLooksGenerated(file) {
  return GEN_FILENAME_RE.test(path.basename(file));
}

/**
 * Read a sibling sidecar (if present) and decide whether it marks the asset as generated.
 * Tolerant: a missing/unreadable/malformed sidecar simply yields false. The fs reader is
 * injectable for zero-IO tests.
 * @param {string} absFile  absolute path to the media file.
 * @param {object} io       { readFileSync, existsSync } (default node fs).
 * @returns {boolean}
 */
function sidecarMarksGenerated(absFile, io) {
  const readFileSync = io.readFileSync || fs.readFileSync;
  const existsSync = io.existsSync || fs.existsSync;
  const base = absFile.replace(/\.[^.\\/]+$/u, ''); // strip the media extension
  const candidates = [
    ...SIDECAR_SUFFIXES.map((s) => base + s),
    ...SIDECAR_SUFFIXES.map((s) => absFile + s), // also <file.ext>.json style
  ];
  for (const sc of candidates) {
    let raw;
    try {
      if (!existsSync(sc)) continue;
      raw = String(readFileSync(sc, 'utf8'));
    } catch {
      continue; // unreadable sidecar never decides anything
    }
    if (sc.toLowerCase().endsWith('.json')) {
      try {
        const meta = JSON.parse(raw);
        if (metaMarksGenerated(meta)) return true;
      } catch {
        /* malformed json sidecar — ignore */
      }
    } else if (/(?:^|[\s,;])(?:ai[-_ ]?generated|generated|ai[-_ ]?gen)(?:[\s,;]|$)/iu.test(raw)) {
      return true;
    }
  }
  return false;
}

/** Does a parsed sidecar/index metadata object mark the asset as generated? */
function metaMarksGenerated(meta) {
  if (!meta || typeof meta !== 'object') return false;
  const sc = String(meta.source_class || '').toLowerCase();
  if (sc === 'generated' || sc === 'modified') return true;
  if (meta.ai_generated === true || meta.aiGenerated === true || meta.generated === true) return true;
  if (typeof meta.generator === 'string' && meta.generator.trim()) return true;
  if (typeof meta.generation_model === 'string' && meta.generation_model.trim()) return true;
  return false;
}

/**
 * Classify ONE asset into a target template folder.
 * AI-generated takes precedence over kind; otherwise kind ⇒ Images/Videos. Non-media ⇒ null
 * (skipped — never moved). Index source_class (when supplied) is consulted for the marker too.
 * @param {string} absFile           absolute path.
 * @param {object} [opts]
 * @param {string} [opts.indexSourceClass]  source_class from an archive-index entry for this asset.
 * @param {object} [opts.io]         injectable { readFileSync, existsSync }.
 * @returns {{folder:(string|null), kind:(string|null), generated:boolean}}
 */
function classifyAsset(absFile, opts = {}) {
  const io = opts.io || {};
  const kind = kindByExtension(absFile);
  if (!kind) return { folder: null, kind: null, generated: false };

  const indexGenerated = metaMarksGenerated({ source_class: opts.indexSourceClass });
  const generated = indexGenerated || nameLooksGenerated(absFile) || sidecarMarksGenerated(absFile, io);
  if (generated) return { folder: FOLDER.AI_GENERATED, kind, generated: true };
  return { folder: kind === 'video' ? FOLDER.VIDEOS : FOLDER.IMAGES, kind, generated: false };
}

/** Is `child` inside (or equal to) `root`? Both must be absolute. Containment guard (RD-3). */
function isInside(root, child) {
  const rel = path.relative(root, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** $CONTENT_HOME-relative POSIX path for an absolute path under the home (for index `path`). */
function homeRelative(absFile, env) {
  const rel = path.relative(paths.contentHome(env), absFile);
  return rel.split(path.sep).join('/');
}

/**
 * Walk the library tree and yield candidate media files (absolute paths). The three template
 * folders are descended into ONLY to detect already-sorted assets — files already in their
 * correct template folder are still yielded so the caller can confirm the no-op (idempotency).
 * Hidden dotfiles and the structured index/metadata/tags machinery are not media and are skipped.
 * Tolerant: an unreadable directory is reported via `onError` and skipped, never fatal.
 */
function* walkLibrary(libraryRoot, onError) {
  const SKIP_DIRS = new Set(['tags', 'metadata']); // structured index inputs/outputs, not media
  const stack = [libraryRoot];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      onError({ path: dir, reason: `unreadable directory: ${err.message}` });
      continue;
    }
    for (const ent of entries) {
      const abs = path.join(dir, ent.name);
      if (ent.name.startsWith('.')) continue; // dotfiles/sidecar dirs
      if (ent.isDirectory()) {
        if (dir === libraryRoot && SKIP_DIRS.has(ent.name)) continue;
        stack.push(abs);
      } else if (ent.isFile()) {
        yield abs;
      } else {
        // symlink / special — stat to resolve type, tolerate failures
        try {
          if (fs.statSync(abs).isFile()) yield abs;
        } catch (err) {
          onError({ path: abs, reason: `unstattable entry: ${err.message}` });
        }
      }
    }
  }
}

/** Pick a non-colliding destination under destDir for `basename` (numeric suffix on collision). */
function nonCollidingDest(destDir, basename, plannedDests) {
  const ext = path.extname(basename);
  const stem = basename.slice(0, basename.length - ext.length);
  let candidate = path.join(destDir, basename);
  let n = 1;
  // Avoid clashing with an on-disk file OR another move already planned this run.
  while (fs.existsSync(candidate) || plannedDests.has(candidate.toLowerCase())) {
    candidate = path.join(destDir, `${stem}-${n}${ext}`);
    n += 1;
  }
  return candidate;
}

/**
 * Load the archive index (if any) as a path→entry lookup, so a move can carry the entry's
 * `source_class` into classification AND rewrite the entry `path` on --apply. Missing/unreadable
 * index ⇒ empty lookup (empty-library mode, DD-21) — never throws.
 */
function loadIndexLookup(env) {
  const file = paths.libraryIndex(env);
  let parsed = null;
  try {
    if (!fs.existsSync(file)) return { file, raw: null, assets: [], byRel: new Map() };
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { file, raw: null, assets: [], byRel: new Map() };
  }
  const assets = Array.isArray(parsed.assets) ? parsed.assets : [];
  const byRel = new Map();
  for (const a of assets) {
    if (a && typeof a.path === 'string') byRel.set(a.path.replace(/\\/gu, '/'), a);
  }
  return { file, raw: parsed, assets, byRel };
}

/**
 * Sort the content library into Images / Videos / AI-generated template folders.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.apply=false]  perform the moves. Default false ⇒ DRY-RUN (DD-18).
 * @param {boolean} [opts.yes]          alias for apply (CLI --yes confirmation).
 * @param {object}  [opts.env]          environment (default process.env) — injectable for tests.
 * @param {object}  [opts.io]           injectable { readFileSync, existsSync } for sidecar reads.
 * @returns {{
 *   dryRun:boolean, libraryRoot:string,
 *   planned:Array<{from:string,to:string,folder:string,kind:string,generated:boolean,indexUpdated:boolean}>,
 *   moved:Array<object>, skipped:Array<{path:string,reason:string}>,
 *   errors:Array<{path:string,reason:string}>,
 *   counts:{scanned:number,planned:number,moved:number,already_sorted:number,non_media:number,errors:number,index_updated:number},
 *   summary:string
 * }}
 */
function organizeLibrary(opts = {}) {
  const env = opts.env || process.env;
  const apply = Boolean(opts.apply || opts.yes);
  const io = opts.io || {};

  const libraryRoot = paths.libraryDir(env);
  const result = {
    dryRun: !apply,
    libraryRoot,
    planned: [],
    moved: [],
    skipped: [],
    errors: [],
    counts: { scanned: 0, planned: 0, moved: 0, already_sorted: 0, non_media: 0, errors: 0, index_updated: 0 },
    summary: '',
  };

  if (!fs.existsSync(libraryRoot)) {
    result.summary = 'library/ does not exist yet — nothing to sort (empty-library mode).';
    return result;
  }

  const onError = (e) => {
    result.errors.push(e);
    result.counts.errors += 1;
  };

  const index = loadIndexLookup(env);
  const plannedDests = new Set(); // lower-cased absolute dests reserved this run (collision-safe)
  // Pending index-path rewrites: oldRel(posix) → newRel(posix). Applied at the end.
  const indexRewrites = new Map();

  for (const absFile of walkLibrary(libraryRoot, onError)) {
    result.counts.scanned += 1;

    // Stat-tolerance: a file that vanished or is unreadable mid-walk is reported, not fatal.
    try {
      fs.statSync(absFile);
    } catch (err) {
      onError({ path: absFile, reason: `unstattable file: ${err.message}` });
      continue;
    }

    const rel = homeRelative(absFile, env);
    const libRel = path.relative(libraryRoot, absFile).split(path.sep).join('/');
    const indexEntry = index.byRel.get(rel) || null;

    const { folder, kind, generated } = classifyAsset(absFile, {
      indexSourceClass: indexEntry ? indexEntry.source_class : undefined,
      io,
    });

    if (!folder) {
      result.counts.non_media += 1;
      result.skipped.push({ path: libRel, reason: 'non-media file (left in place)' });
      continue;
    }

    // Idempotency: already directly inside its correct template folder ⇒ no-op.
    const topSegment = libRel.split('/')[0];
    const inCorrectFolder = topSegment === folder && libRel.split('/').length === 2;
    if (inCorrectFolder) {
      result.counts.already_sorted += 1;
      result.skipped.push({ path: libRel, reason: `already sorted into ${folder}/` });
      continue;
    }

    const destDir = path.join(libraryRoot, folder);
    const dest = nonCollidingDest(destDir, path.basename(absFile), plannedDests);

    // CONTAINMENT (RD-3): never move outside the library root. Both ends must resolve inside.
    if (!isInside(libraryRoot, absFile) || !isInside(libraryRoot, dest)) {
      onError({ path: libRel, reason: 'refused: would move outside $CONTENT_HOME/library (RD-3)' });
      continue;
    }

    plannedDests.add(dest.toLowerCase());
    const newRel = homeRelative(dest, env);
    const indexUpdated = Boolean(indexEntry);
    if (indexEntry) indexRewrites.set(rel, newRel);

    const plan = { from: libRel, to: path.relative(libraryRoot, dest).split(path.sep).join('/'), folder, kind, generated, indexUpdated };
    result.planned.push(plan);
    result.counts.planned += 1;

    if (apply) {
      try {
        fs.mkdirSync(destDir, { recursive: true });
        moveFile(absFile, dest);
        result.moved.push(plan);
        result.counts.moved += 1;
      } catch (err) {
        // Roll the reservation back so a later collision check stays honest, then report.
        plannedDests.delete(dest.toLowerCase());
        indexRewrites.delete(rel);
        onError({ path: libRel, reason: `move failed: ${err.message}` });
      }
    }
  }

  // Apply index path rewrites once. indexRewrites only holds entries whose move SUCCEEDED
  // (a failed move deletes its rewrite above), so every key here is safe to apply.
  if (apply && indexRewrites.size > 0 && index.raw && Array.isArray(index.raw.assets)) {
    let changed = 0;
    for (const a of index.raw.assets) {
      if (!a || typeof a.path !== 'string') continue;
      const key = a.path.replace(/\\/gu, '/');
      if (indexRewrites.has(key)) {
        a.path = indexRewrites.get(key);
        changed += 1;
      }
    }
    if (changed > 0) {
      try {
        fs.writeFileSync(index.file, `${JSON.stringify(index.raw, null, 2)}\n`, 'utf8');
        result.counts.index_updated = changed;
      } catch (err) {
        onError({ path: 'library/index.json', reason: `index path rewrite failed: ${err.message}` });
      }
    }
  } else if (!apply) {
    // In dry-run, report how many index entries WOULD be rewritten.
    result.counts.index_updated = result.planned.filter((p) => p.indexUpdated).length;
  }

  result.summary = buildSummary(result, apply);
  return result;
}

/**
 * Move a file, preferring an atomic rename and falling back to copy+unlink across devices
 * (EXDEV) — the library may straddle volumes on some operator setups.
 */
function moveFile(src, dest) {
  try {
    fs.renameSync(src, dest);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    fs.copyFileSync(src, dest);
    fs.unlinkSync(src);
  }
}

/** Human one-line summary for CLI/agent output. */
function buildSummary(result, apply) {
  const c = result.counts;
  const verb = apply ? 'moved' : 'would move';
  const idx = c.index_updated ? `, ${c.index_updated} index ${apply ? 'updated' : 'to update'}` : '';
  const errs = c.errors ? `, ${c.errors} error(s)` : '';
  return (
    `${apply ? 'APPLY' : 'DRY-RUN'}: ${verb} ${apply ? c.moved : c.planned} asset(s) ` +
    `(scanned ${c.scanned}, already-sorted ${c.already_sorted}, non-media ${c.non_media}${idx}${errs}). ` +
    `Templates: ${TEMPLATE_FOLDERS.join(' / ')}.` +
    (apply ? '' : ' Re-run with --apply to perform the moves (DD-18).')
  );
}

module.exports = {
  FOLDER,
  TEMPLATE_FOLDERS,
  IMAGE_EXT,
  VIDEO_EXT,
  extOf,
  kindByExtension,
  nameLooksGenerated,
  metaMarksGenerated,
  sidecarMarksGenerated,
  classifyAsset,
  isInside,
  organizeLibrary,
};
