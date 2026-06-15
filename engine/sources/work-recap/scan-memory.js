'use strict';

/**
 * engine/sources/work-recap/scan-memory.js  [N net-new]
 *
 * The MEMORY SOURCE for the work-recap / build-in-public pathway (release-spec §2.1 seeding;
 * §3.3 operator/founder accounts; §12 seams; original-design-spec §1.4 reporting).
 *
 * WHAT THIS IS (and is NOT):
 *   - This module SCANS a CONFIGURED EXTERNAL memory path and extracts recent WORK ITEMS
 *     (what was built / shipped / worked on). It is a CONTENT SOURCE that produces a SEED
 *     (an idea/argument pre-seed, §2.1) for the EXISTING chain: source -> seed -> matcher ->
 *     brief -> writer -> hybrid gate -> package -> queue -> the HUMAN approval card (the double
 *     gate, §2.4). It does NOT bypass the chain and NOTHING here auto-publishes (SAFE default).
 *   - It is CONFIG-GATED and OFF BY DEFAULT (work_recap.enabled). The operator opts in via the
 *     new `work_recap` config block. With no config / no path / a missing path it is a clean
 *     NO-OP (returns an empty result), never an error.
 *
 * PRIVACY IS LOAD-BEARING (the prompt's MEMORY-SOURCE law; §13.3 redact-at-write):
 *   - Project memory is SENSITIVE (secrets, partner names, unreleased codenames, financials,
 *     internal ids). This module READS the configured memory path ONLY — it NEVER bundles,
 *     copies, or commits real memory into the repo. The repo ships the MECHANISM pointed at a
 *     CONFIGURED path; the privacy PRE-PASS (privacy-filter.js, reused by build-seed.js) is what
 *     sanitizes anything before it can become a shareable seed.
 *   - scanMemory itself returns the RAW extracted work items (pre-sanitization) so the caller
 *     (buildWorkRecapSeed) can run the privacy pre-pass and carry privacy_flags. The raw result
 *     never leaves the engine boundary as content — only the sanitized seed does, and only after
 *     the gate's privacy/leak check and the human approval card (§2.4).
 *
 * TESTABILITY (RD-12, §12.5 vision-seam pattern):
 *   - All file-system access is injectable through `opts.fs` (a minimal { existsSync, readFileSync,
 *     readdirSync, statSync } shape). Tests run zero-key with an in-memory fake; production passes
 *     nothing and the real node:fs is used. No secrets, no network, no real paths.
 *
 * Tier-3 cleanliness (§0.3 r6 / RD-3): no IDs/handles/absolute paths/brand strings; no production
 * persona codenames. The memory path is operator-configured, never hardcoded.
 */

const nodeFs = require('fs');
const nodePath = require('path');

/** Default files-glob the source scans, relative to the configured memory_path (§ work_recap). */
const DEFAULT_FILES = ['MEMORY.md', 'memory/*.md'];

/** Default lookback window in days (§ work_recap.lookback_days; spec note "default 1-3"). */
const DEFAULT_LOOKBACK_DAYS = 3;

/**
 * Verbs/markers that flag a memory line as a shippable WORK ITEM (what was built / shipped /
 * worked on). Brand-neutral and synthetic — no production tokens. Mirrors the production
 * SHIP_IT signal shape (ported from the snapshot's ship-it miner, regenerated clean).
 */
const WORK_SIGNAL_RE =
  /(\bshipped\b|\bbuilt\b|\bbuild(?:ing)?\b|\blaunch(?:ed|ing)?\b|\breleas(?:ed|ing|e)\b|\bdeploy(?:ed|ing)?\b|\bmerged?\b|\bfixed?\b|\bfix(?:ing|es)?\b|\badded?\b|\bwrote\b|\bwrit(?:ten|ing)\b|\bimplement(?:ed|ing)?\b|\brefactor(?:ed|ing)?\b|\bwired?\b|\bset up\b|\bcompleted?\b|\bfinished?\b|\bdone\b|\bworked on\b|\bwork(?:ing)? on\b|\bnow live\b|\brolled out\b|\bpushed?\b|\bcut(?:over)?\b|\bvalidated?\b|\btested?\b|\bdesigned?\b|\bscaffold(?:ed)?\b|✅|🚀)/i;

/**
 * Lines to skip even when they carry a work signal — pure status/skip log entries, headers,
 * and obvious non-work chatter. (The agent boot-protocol logs "⏭️ skipped …" lines; those are
 * decisions-not-to-do, not shippable work.)
 */
const SKIP_LINE_RE = /(^#{1,6}\s)|(⏭️)|(\bskipp?ed\b.*\bbecause\b)|(^\s*[-*]?\s*deferred\b)/i;

/**
 * Recognize a leading timestamp/date marker the agent memory format uses:
 *   "[HH:MM] ✅ did X"  or  "- [HH:MM] …"  or a markdown date heading "## 2026-06-14".
 * Returns { time } when an "[HH:MM]" marker is present (null otherwise). Used only to strip the
 * marker from the extracted summary text; the file's DATE comes from its name/path (see below).
 */
const TIME_MARKER_RE = /^[-*\s]*\[(\d{1,2}:\d{2})\]\s*/;

/** A daily-log file name encodes its date: "YYYY-MM-DD.md". */
const DAILY_FILE_DATE_RE = /(\d{4})-(\d{2})-(\d{2})\.md$/i;

/**
 * Resolve the injectable fs facade. Production uses node:fs; tests pass a fake. Only the four
 * methods this module needs are required.
 * @param {object} [injected]
 * @returns {{existsSync:Function, readFileSync:Function, readdirSync:Function, statSync:Function}}
 */
function resolveFs(injected) {
  if (injected) return injected;
  return {
    existsSync: nodeFs.existsSync,
    readFileSync: nodeFs.readFileSync,
    readdirSync: nodeFs.readdirSync,
    statSync: nodeFs.statSync,
  };
}

/**
 * Read the `work_recap` config block off a system-config object, applying defaults. Honors the
 * off-by-default contract: `enabled` defaults to false.
 * @param {object} [config]  the parsed system config (config/system.json contents) or a subset.
 * @returns {object} the normalized work_recap settings.
 */
function workRecapConfig(config) {
  const wr = (config && (config.work_recap || (config.sources && config.sources.work_recap))) || {};
  return {
    enabled: wr.enabled === true,
    memory_path: typeof wr.memory_path === 'string' ? wr.memory_path.trim() : '',
    files: Array.isArray(wr.files) && wr.files.length ? wr.files.slice() : DEFAULT_FILES.slice(),
    lookback_days: Number.isFinite(wr.lookback_days) && wr.lookback_days > 0
      ? Math.floor(wr.lookback_days)
      : DEFAULT_LOOKBACK_DAYS,
    // Scoping (§3.3): which brand/account this recap targets. Operator/founder/team accounts.
    brand: typeof wr.brand === 'string' ? wr.brand : null,
    account: typeof wr.account === 'string' ? wr.account : null,
    // Config-extendable private-term deny list (carried through to the privacy pre-pass).
    private_terms: Array.isArray(wr.private_terms) ? wr.private_terms.slice() : [],
    // Optional cap on how many work items to extract (keeps a seed focused).
    max_items: Number.isFinite(wr.max_items) && wr.max_items > 0 ? Math.floor(wr.max_items) : 40,
  };
}

/**
 * Expand a files-glob list against the memory root. Only the two shapes the § work_recap default
 * uses are supported (an exact file, and a single "dir/*.md" wildcard) — deliberately minimal, no
 * glob dependency (zero deps, §package.json). Returns absolute-ish paths joined under root.
 * Missing dirs/files are simply absent from the result (clean no-op contract).
 * @returns {Array<{path:string, rel:string}>}
 */
function expandFiles(root, globs, fs) {
  const out = [];
  const seen = new Set();
  const add = (rel) => {
    if (seen.has(rel)) return;
    seen.add(rel);
    out.push({ path: nodePath.join(root, rel), rel });
  };

  for (const g of globs) {
    const glob = String(g);
    const starIdx = glob.indexOf('*');
    if (starIdx === -1) {
      // Exact file.
      const full = nodePath.join(root, glob);
      if (safeExists(fs, full) && !safeIsDir(fs, full)) add(glob);
      continue;
    }
    // Single "dir/*.ext" wildcard.
    const dir = nodePath.dirname(glob);
    const base = nodePath.basename(glob); // e.g. "*.md"
    const ext = base.startsWith('*') ? base.slice(1) : base; // ".md"
    const dirFull = nodePath.join(root, dir);
    if (!safeExists(fs, dirFull) || !safeIsDir(fs, dirFull)) continue;
    let entries;
    try {
      entries = fs.readdirSync(dirFull);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!String(name).toLowerCase().endsWith(ext.toLowerCase())) continue;
      const rel = dir === '.' ? name : nodePath.join(dir, name);
      const full = nodePath.join(root, rel);
      if (safeExists(fs, full) && !safeIsDir(fs, full)) add(rel);
    }
  }
  return out;
}

function safeExists(fs, p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}
function safeIsDir(fs, p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Determine a file's date for lookback filtering. Daily-log files ("YYYY-MM-DD.md") get their
 * date from the name (the agent boot protocol's canonical layout); everything else falls back to
 * the file mtime when statSync is available, else null (treated as "within window" so a curated
 * MEMORY.md is never dropped purely for lacking a date).
 * @returns {Date|null}
 */
function fileDate(fs, file) {
  const m = DAILY_FILE_DATE_RE.exec(file.rel) || DAILY_FILE_DATE_RE.exec(file.path);
  if (m) {
    const d = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
    if (!Number.isNaN(d.getTime())) return d;
  }
  try {
    const st = fs.statSync(file.path);
    if (st && st.mtime) return new Date(st.mtime);
  } catch {
    /* no stat available */
  }
  return null;
}

/** Inclusive lookback cutoff: items dated on/after (now - lookback_days) qualify. */
function withinLookback(date, lookbackDays, now) {
  if (date == null) return true; // undated curated memory is kept (see fileDate note).
  const cutoff = new Date(now.getTime() - lookbackDays * 24 * 60 * 60 * 1000);
  // Compare on the date floor so a same-day entry at any clock time qualifies.
  const dayFloor = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const cutoffFloor = new Date(
    Date.UTC(cutoff.getUTCFullYear(), cutoff.getUTCMonth(), cutoff.getUTCDate()),
  );
  return dayFloor.getTime() >= cutoffFloor.getTime();
}

/**
 * Extract candidate work-item lines from a memory file's text. A work item is one line carrying a
 * work signal and not on the skip list. The leading "[HH:MM]"/bullet/✅ markers are stripped to a
 * clean summary; the file's date is attached for ordering/lookback.
 * @returns {Array<{summary:string, raw:string, time:string|null, source_rel:string, date:string|null}>}
 */
function extractItems(text, file, dateObj) {
  const items = [];
  const dateIso = dateObj ? dateObj.toISOString().slice(0, 10) : null;
  for (const rawLine of String(text).split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (SKIP_LINE_RE.test(line)) continue;
    if (!WORK_SIGNAL_RE.test(line)) continue;

    const timeM = TIME_MARKER_RE.exec(line);
    const time = timeM ? timeM[1] : null;
    let summary = line
      .replace(TIME_MARKER_RE, '')
      .replace(/^[-*]\s+/, '')
      .replace(/^[✅🚀]\s*/u, '')
      .trim();
    // Drop a leading status emoji that survived (e.g. "✅" mid-marker).
    summary = summary.replace(/^[✅🚀]\s*/u, '').trim();
    if (!summary) continue;

    items.push({ summary, raw: line, time, source_rel: file.rel, date: dateIso });
  }
  return items;
}

/**
 * Scan the configured memory path and extract recent WORK ITEMS (RAW, pre-sanitization).
 *
 * Contract:
 *   - OFF BY DEFAULT: if work_recap.enabled !== true, returns a disabled no-op result.
 *   - CLEAN NO-OP: missing/empty memory_path, or a path that does not exist, returns an
 *     empty (enabled-but-empty) result — never throws for an absent path.
 *   - INJECTABLE: opts.fs overrides node:fs for tests (RD-12, zero-key).
 *   - RAW OUTPUT: returns un-sanitized work items; the privacy pre-pass runs in buildWorkRecapSeed
 *     (or may be applied by the caller). scanMemory NEVER writes anything and NEVER emits content
 *     past the engine boundary.
 *
 * @param {object} [opts]
 * @param {object} [opts.config]    parsed system config carrying the `work_recap` block.
 * @param {object} [opts.work_recap] explicit work_recap settings (overrides config.work_recap).
 * @param {object} [opts.fs]        injectable fs facade (default node:fs).
 * @param {Date}   [opts.now]       reference "now" for lookback (default new Date()).
 * @returns {{
 *   enabled:boolean, scanned:boolean, reason:string|null,
 *   memory_path:string|null, files_scanned:string[], lookback_days:number,
 *   brand:string|null, account:string|null, private_terms:string[],
 *   items:Array<{summary:string, raw:string, time:string|null, source_rel:string, date:string|null}>
 * }}
 */
function scanMemory(opts = {}) {
  const cfg = opts.work_recap
    ? workRecapConfig({ work_recap: opts.work_recap })
    : workRecapConfig(opts.config);
  const fs = resolveFs(opts.fs);
  const now = opts.now instanceof Date ? opts.now : new Date();

  const base = {
    enabled: cfg.enabled,
    scanned: false,
    reason: null,
    memory_path: cfg.memory_path || null,
    files_scanned: [],
    lookback_days: cfg.lookback_days,
    brand: cfg.brand,
    account: cfg.account,
    private_terms: cfg.private_terms,
    items: [],
  };

  // OFF BY DEFAULT.
  if (!cfg.enabled) return { ...base, reason: 'disabled' };

  // CLEAN NO-OP: no configured path.
  if (!cfg.memory_path) return { ...base, reason: 'no_memory_path' };

  const root = cfg.memory_path;
  if (!safeExists(fs, root)) return { ...base, reason: 'memory_path_missing' };

  const files = expandFiles(root, cfg.files, fs);
  if (!files.length) return { ...base, scanned: true, reason: 'no_files_matched' };

  const allItems = [];
  const filesScanned = [];
  for (const file of files) {
    const dateObj = fileDate(fs, file);
    if (!withinLookback(dateObj, cfg.lookback_days, now)) continue;
    let text;
    try {
      text = fs.readFileSync(file.path, 'utf8');
    } catch {
      continue; // unreadable file is skipped, never fatal (clean no-op discipline).
    }
    filesScanned.push(file.rel);
    for (const item of extractItems(text, file, dateObj)) allItems.push(item);
  }

  // Newest-first ordering (date desc, then time desc) so the seed leads with the latest work.
  allItems.sort((a, b) => {
    const da = a.date || '';
    const db = b.date || '';
    if (da !== db) return db.localeCompare(da);
    return String(b.time || '').localeCompare(String(a.time || ''));
  });

  const items = allItems.slice(0, cfg.max_items);

  return {
    ...base,
    scanned: true,
    reason: items.length ? null : 'no_work_items',
    files_scanned: filesScanned,
    items,
  };
}

module.exports = {
  DEFAULT_FILES,
  DEFAULT_LOOKBACK_DAYS,
  WORK_SIGNAL_RE,
  workRecapConfig,
  expandFiles,
  fileDate,
  withinLookback,
  extractItems,
  scanMemory,
};
