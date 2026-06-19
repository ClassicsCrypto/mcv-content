'use strict';

/**
 * engine/library/validate.js  [N net-new]
 *
 * Library SCAN/VALIDATE — the "point me at my library, check it's in the right shape, and flag what's
 * wrong" pass (release-spec §1.5 asset management; §2.6 / C4 library checkpoint; original-design-spec
 * §1.5). This is the read-only doctor that runs BEFORE (or instead of) indexing: an operator who
 * already has a media library wants to know it scans cleanly — correct media types, no empty/dead
 * folders, no unreadable files, and whether it's indexed — before spending on `engine index-library`.
 *
 * Pure read-only + tolerant + zero-key (RD-12): it never moves, writes, indexes, or spends; it walks
 * the configured library root and reports. An unreadable file/dir is a reported issue, never fatal.
 * Empty-library mode (DD-21): a missing library root is a clean "nothing here yet" pass, not an error.
 *
 * It complements the two sibling library verbs without overlapping them: organize.js MOVES files into
 * template folders; indexer.js INDEXES (metered, vision). validate.js only LOOKS and reports, so it is
 * the safe first action on an unknown library.
 *
 * Issue levels (the C4 "scan to make sure it's in the right format, then check for errors / empty
 * folders / lack of content" contract):
 *   - error  blocks a clean scan: an unreadable file/dir, or a stale index entry pointing at a file
 *            that no longer exists on disk (a dead reference retrieval would chase).
 *   - warn   worth surfacing but not blocking: empty folders, non-media files mixed in, media files
 *            not yet in the index, or a library with no media at all (lack of content).
 *
 * Tier-3 cleanliness (§0.3 r6): no hardcoded instance paths/ids/brand names — the library root
 * resolves via engine/shared/paths.js (RD-3); media-type vocab is reused from organize.js (structural).
 */

const fs = require('fs');
const path = require('path');

const paths = require('../shared/paths.js');
const organize = require('./organize.js');

/** Directories at the library root that hold index/tag machinery, not media (skip in the scan). */
const SKIP_ROOT_DIRS = new Set(['tags', 'metadata']);

/** Files at the library root that are engine machinery, not operator media (never flagged as stray). */
const SKIP_ROOT_FILES = new Set(['index.json']);

const MAX_LIST = 25; // cap each reported list so a huge library never floods the report

/** POSIX, library-root-relative path for an absolute path under the library. */
function libRel(libraryRoot, abs) {
  return path.relative(libraryRoot, abs).split(path.sep).join('/') || '.';
}

/**
 * Recursively walk the library tree. Returns { files, dirsWithNoFiles, unreadable } where files is a
 * list of { abs, rel, kind } (kind: 'image'|'video'|null), dirsWithNoFiles is the list of directories
 * that contain no regular file anywhere beneath them (truly empty / dead folders), and unreadable is
 * the list of { rel, reason } for dirs/files that could not be read. Dotfiles and the root skip-dirs
 * are ignored. Tolerant: a single unreadable node is recorded and the walk continues.
 */
function walk(libraryRoot) {
  const files = [];
  const unreadable = [];
  const dirsWithNoFiles = [];

  // Depth-first; returns whether the subtree under `dir` contained at least one regular file.
  function visit(dir, isRoot) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      unreadable.push({ rel: libRel(libraryRoot, dir), reason: `unreadable directory: ${err.message}` });
      return false;
    }
    let sawFile = false;
    for (const ent of entries) {
      if (ent.name.startsWith('.')) continue; // dotfiles / sidecar dirs
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (isRoot && SKIP_ROOT_DIRS.has(ent.name)) continue;
        const childHadFile = visit(abs, false);
        if (childHadFile) sawFile = true;
        else dirsWithNoFiles.push(libRel(libraryRoot, abs));
      } else if (ent.isFile()) {
        if (isRoot && SKIP_ROOT_FILES.has(ent.name)) continue; // the archive index itself, not media
        sawFile = true;
        files.push({ abs, rel: libRel(libraryRoot, abs), kind: organize.kindByExtension(ent.name) });
      } else {
        // symlink / special — stat to resolve, tolerate failures.
        try {
          if (fs.statSync(abs).isFile()) {
            sawFile = true;
            files.push({ abs, rel: libRel(libraryRoot, abs), kind: organize.kindByExtension(ent.name) });
          }
        } catch (err) {
          unreadable.push({ rel: libRel(libraryRoot, abs), reason: `unstattable entry: ${err.message}` });
        }
      }
    }
    return sawFile;
  }

  visit(libraryRoot, true);
  return { files, dirsWithNoFiles, unreadable };
}

/** Load the archive index as { present, entries:[], byRel:Map } — tolerant (empty on miss). */
function loadIndex(env) {
  const file = paths.libraryIndex(env);
  if (!fs.existsSync(file)) return { present: false, entries: [], byRel: new Map() };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const entries = Array.isArray(parsed.assets) ? parsed.assets : [];
    const byRel = new Map();
    for (const a of entries) {
      if (a && typeof a.path === 'string') byRel.set(a.path.replace(/\\/gu, '/'), a);
    }
    return { present: true, entries, byRel };
  } catch {
    return { present: false, entries: [], byRel: new Map(), parse_error: true };
  }
}

/**
 * Validate the content library. Read-only; never spends.
 *
 * @param {object} [opts]
 * @param {object} [opts.env]  environment (default process.env) — injectable for tests.
 * @returns {{
 *   libraryRoot:string, exists:boolean, ok:boolean,
 *   counts:{ files:number, images:number, videos:number, non_media:number, empty_dirs:number,
 *            unreadable:number, indexed:number, unindexed:number, stale_index:number },
 *   empty_dirs:string[], non_media:string[], unreadable:Array<{rel:string,reason:string}>,
 *   index:{ present:boolean, entries:number, stale:string[], unindexed:string[] },
 *   issues:Array<{ level:'error'|'warn', code:string, detail:string }>,
 *   summary:string
 * }}
 */
function validateLibrary(opts = {}) {
  const env = opts.env || process.env;
  const libraryRoot = paths.libraryDir(env);
  const issues = [];
  const addIssue = (level, code, detail) => issues.push({ level, code, detail });

  if (!fs.existsSync(libraryRoot)) {
    return {
      libraryRoot,
      exists: false,
      ok: true, // empty-library mode is a clean pass (DD-21) — nothing to validate yet.
      counts: { files: 0, images: 0, videos: 0, non_media: 0, empty_dirs: 0, unreadable: 0, indexed: 0, unindexed: 0, stale_index: 0 },
      empty_dirs: [],
      non_media: [],
      unreadable: [],
      index: { present: false, entries: 0, stale: [], unindexed: [] },
      issues,
      summary: 'library/ does not exist yet — empty-library mode (nothing to validate). Add media here, then re-run.',
    };
  }

  const { files, dirsWithNoFiles, unreadable } = walk(libraryRoot);
  const index = loadIndex(env);

  const images = files.filter((f) => f.kind === 'image');
  const videos = files.filter((f) => f.kind === 'video');
  const nonMedia = files.filter((f) => f.kind === null);

  // Index cross-check: a media file's CONTENT_HOME-relative path is `library/<libRel>`. Compare the
  // index's entry paths (already CONTENT_HOME-relative) against the media files we found on disk.
  const homeRel = (f) => `library/${f.rel}`;
  const mediaOnDisk = new Set([...images, ...videos].map(homeRel));
  const unindexed = index.present ? [...mediaOnDisk].filter((p) => !index.byRel.has(p)) : [];
  const stale = index.present
    ? [...index.byRel.keys()].filter((p) => {
        try { return !fs.existsSync(path.join(paths.contentHome(env), p)); } catch { return false; }
      })
    : [];

  // --- Build the issue list (the format/health verdict) ---
  for (const u of unreadable) addIssue('error', 'unreadable', `${u.rel}: ${u.reason}`);
  for (const s of stale) addIssue('error', 'stale_index_entry', `index references a missing file: ${s}`);
  if (index.parse_error) addIssue('error', 'index_unparseable', 'library/index.json exists but does not parse as JSON');

  if (images.length + videos.length === 0) {
    addIssue('warn', 'no_media', 'no image or video files found — the library has no content yet (empty-library mode is fine; add media or skip).');
  }
  if (dirsWithNoFiles.length) {
    addIssue('warn', 'empty_folders', `${dirsWithNoFiles.length} empty folder(s): ${dirsWithNoFiles.slice(0, MAX_LIST).join(', ')}${dirsWithNoFiles.length > MAX_LIST ? ' …' : ''}`);
  }
  if (nonMedia.length) {
    addIssue('warn', 'non_media', `${nonMedia.length} non-media file(s) mixed in (left alone): ${nonMedia.slice(0, MAX_LIST).map((f) => f.rel).join(', ')}${nonMedia.length > MAX_LIST ? ' …' : ''}`);
  }
  if (!index.present && images.length + videos.length > 0) {
    addIssue('warn', 'not_indexed', `${images.length + videos.length} media file(s) present but no index yet — run \`engine index-library\` (estimate-and-confirm) so posts can reuse them.`);
  } else if (unindexed.length) {
    addIssue('warn', 'partially_indexed', `${unindexed.length} media file(s) not yet in the index: ${unindexed.slice(0, MAX_LIST).join(', ')}${unindexed.length > MAX_LIST ? ' …' : ''}`);
  }

  const errors = issues.filter((i) => i.level === 'error');
  const ok = errors.length === 0;
  const counts = {
    files: files.length,
    images: images.length,
    videos: videos.length,
    non_media: nonMedia.length,
    empty_dirs: dirsWithNoFiles.length,
    unreadable: unreadable.length,
    indexed: index.present ? mediaOnDisk.size - unindexed.length : 0,
    unindexed: unindexed.length,
    stale_index: stale.length,
  };

  const summary =
    `library scan: ${counts.images} image(s) + ${counts.videos} video(s)` +
    (counts.non_media ? `, ${counts.non_media} non-media` : '') +
    `, ${counts.empty_dirs} empty folder(s); index ${index.present ? `present (${index.entries} entries${counts.unindexed ? `, ${counts.unindexed} unindexed` : ''}${counts.stale_index ? `, ${counts.stale_index} stale` : ''})` : 'not built'}. ` +
    (ok ? (issues.length ? `${issues.length} note(s) — see issues.` : 'clean.') : `${errors.length} error(s) to fix.`);

  return {
    libraryRoot,
    exists: true,
    ok,
    counts,
    empty_dirs: dirsWithNoFiles.slice(0, MAX_LIST),
    non_media: nonMedia.slice(0, MAX_LIST).map((f) => f.rel),
    unreadable,
    index: { present: index.present, entries: index.entries.length, stale: stale.slice(0, MAX_LIST), unindexed: unindexed.slice(0, MAX_LIST) },
    issues,
    summary,
  };
}

module.exports = { validateLibrary, SKIP_ROOT_DIRS, MAX_LIST };
