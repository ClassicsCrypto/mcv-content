'use strict';

/**
 * engine/shared/queue.js  [E ported]
 *
 * The canonical publish-queue store: the single source of truth for the
 * `publish-queue.md` model (release-spec §1 tree `shared/queue.js`; §8.4 "queue
 * writes happen exclusively through engine entry points — no seat touches the
 * queue directly"; DD-4 durable state machine; DD-19 single-runner lock).
 *
 * It provides four things, each a tested production property:
 *   - the entry-header grammar + a canonical field order (queue-entry.schema.json,
 *     spec §7.1 — the documented v1 baseline);
 *   - a block-scalar-aware parser (parseQueue / parseFields) that round-trips
 *     multi-line YAML block bodies (the production single-line parsers silently
 *     dropped them — the data-loss bug this module's parser fixes);
 *   - a region-stable serializer (serializeEntry / serializeQueue) that rewrites
 *     ONLY mutated entries and leaves untouched entries byte-identical;
 *   - the ONE canonical write-lock (acquireLock / acquireLockBlocking /
 *     releaseLock / touchLock) with atomic O_EXCL acquisition, mtime-based
 *     staleness, a heartbeat for long-but-alive holders, and an ELOCKTIMEOUT
 *     guard for blocking callers (DD-19; spec §8.2 `skipped_on_overlap`).
 *
 * Crash-safety / ordering semantics preserved verbatim from the production module:
 *   - atomic tmp+rename writes with a bounded retry for transient Windows
 *     EPERM/EBUSY ("delete pending" / AV) on the rename;
 *   - per-entry write-ahead persistence via setEntryState (re-read fresh, mutate
 *     one entry, re-serialize through the canonical pair — no ad-hoc regex
 *     patching of state lines);
 *   - atomic append via appendEntryBlock with byte-identical separator semantics;
 *   - lock staleness judged by file MTIME (set atomically at create), never by
 *     parsing the possibly-mid-write JSON body — closes the lost-update race a
 *     content-window read could open;
 *   - the duplicate-header transition bug fix: setEntryState matches on
 *     content_id and re-serializes the SPECIFIC entry, so a transition can never
 *     leak onto a same-header sibling (the production "wrong block patched, draft
 *     re-polled forever" bug stays fixed).
 *
 * The lock helpers are intentionally PURE — they never call process.exit; the
 * caller decides how to react to a held lock (skip-and-log on overlap → the
 * `skipped_on_overlap` state, spec §8.2/DD-19). Pass { register:false } in tests
 * to skip the process-exit release handlers. `now` is injectable for
 * deterministic staleness tests.
 *
 * The queue file and its lock live under $CONTENT_HOME, resolved through
 * engine/shared/paths.js (RD-3) — never a hardcoded path. queueLockPath() is the
 * generic "lock basename in a given directory" helper; queueFilePath() and
 * queueLockFilePath() are the paths.js-backed convenience wrappers callers use.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const paths = require('./paths');

// Applied to a trimEnd()'d line so `$` matches after any trailing \r is stripped
// (queue files can be mixed CRLF/LF on Windows). Accepted separators between
// "Entry" and the id: ASCII hyphen, en-dash (U+2013), em-dash (U+2014), and the
// Unicode replacement char (U+FFFD) for historically mojibake'd headers. Kept as
// escapes so this file stays ASCII-clean.
const ENTRY_HEADER_RE = /^##\s+Entry\s+(?:-|–|—|�)\s+(.+)$/u;

// Canonical field order — the documented v1 baseline conforming to
// schemas/artifacts/queue-entry.schema.json (spec §7.1). It MAY change between
// minor versions with migration notes (§11.1); it is not a frozen interface.
// Fields the serializer does not recognize are preserved and emitted after these
// (the parser never drops a field), so instance/extension fields survive a
// canonicalization pass unchanged.
const FIELD_ORDER = [
  // Identity (§7.1).
  'content_id',
  'brand',
  'platform',
  'format',
  'mode',
  'content_form',
  'created_at',
  // State (§7.1, §8.2).
  'state',
  'state_updated_at',
  // Approval (DD-17).
  'approved_by',
  'approved_variant',
  'approved_at',
  'decision_message_ref',
  // Artifact refs (CONTENT_HOME-relative, §7.1).
  'package_ref',
  'media_refs',
  'preview_message_ref',
  // Gating (§7.2/§7.3).
  'gates',
  'validation_ref',
  // Form / trend (DD-15/DD-16).
  'trend_source_ref',
  'freshness_window',
  'expires_basis',
  // Execution (DD-4/DD-13).
  'attempt_count',
  'publish_intent',
  'external_post_ref',
  'published_at',
  'schedule_time',
  'error',
  'hold_reason',
];

function parseQueue(raw) {
  const entries = [];
  const lines = raw.split('\n');
  let currentStart = null;
  let currentHeader = null;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].trimEnd().match(ENTRY_HEADER_RE);
    if (m) {
      if (currentStart !== null) {
        entries.push({
          header: currentHeader,
          fields: parseFields(lines.slice(currentStart + 1, i)),
          rawStart: currentStart,
          rawEnd: i - 1,
        });
      }
      currentStart = i;
      currentHeader = m[1].trim();
    }
  }
  if (currentStart !== null) {
    entries.push({
      header: currentHeader,
      fields: parseFields(lines.slice(currentStart + 1, lines.length)),
      rawStart: currentStart,
      rawEnd: lines.length - 1,
    });
  }
  return entries;
}

function parseFields(lines) {
  // Supports two value shapes:
  //   - key: value                 (single-line)
  //   - key: |-                    (YAML block; collects subsequent indented lines)
  //     line one
  //     line two
  // The block form is needed for multi-paragraph approved-copy / caption blobs.
  // Without it the old single-line matcher silently produced the literal "|-" and
  // dropped the body, so the executor fell back to the package file and sometimes
  // reported "no approved content found".
  const fields = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // No trailing $ — mixed CRLF/LF endings mean $ would not match before \r.
    const single = line.match(/^-\s+([a-z_][a-z0-9_]*):\s*(.*)/i);
    if (!single) { i++; continue; }
    const key = single[1].trim();
    const rest = single[2].trim();
    const isBlockScalar = rest === '|' || rest === '|-' || rest === '>' || rest === '>-';
    if (isBlockScalar) {
      const blockLines = [];
      let j = i + 1;
      // Collect subsequent lines that are blank OR indented and not a new "- key:".
      while (j < lines.length) {
        const cur = lines[j];
        if (/^-\s+[a-z_][a-z0-9_]*:/i.test(cur)) break;
        if (/^##\s+/i.test(cur)) break;
        if (cur.trim() === '' || /^\s/.test(cur)) {
          // Strip leading 1-4 spaces of YAML-block indentation AND any trailing \r.
          blockLines.push(cur.replace(/^\s{1,4}/u, '').replace(/\r$/u, ''));
          j++;
          continue;
        }
        break;
      }
      const joined = rest === '|' || rest === '|-'
        ? blockLines.join('\n').replace(/\s+$/u, '')
        : blockLines.join(' ').replace(/\s+/gu, ' ').trim();
      fields[key] = joined;
      i = j;
      continue;
    }
    fields[key] = rest;
    i++;
  }
  return fields;
}

function serializeFieldValue(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function serializeEntry(entry) {
  const seen = new Set();
  const orderedKeys = [];

  for (const key of FIELD_ORDER) {
    if (Object.prototype.hasOwnProperty.call(entry.fields, key)) {
      orderedKeys.push(key);
      seen.add(key);
    }
  }

  for (const key of Object.keys(entry.fields)) {
    if (!seen.has(key)) orderedKeys.push(key);
  }

  const lines = [`## Entry - ${entry.header}`];
  for (const key of orderedKeys) {
    const sv = serializeFieldValue(entry.fields[key]);
    if (typeof sv === 'string' && sv.includes('\n')) {
      lines.push(`- ${key}: |-`);
      for (const inner of sv.split('\n')) lines.push(`  ${inner}`);
    } else {
      lines.push(`- ${key}: ${sv}`);
    }
  }
  return lines.join('\n');
}

function serializeQueue(raw, entries) {
  // Rewrite ONLY entries explicitly marked _mutated; every other entry's raw
  // region is copied through byte-for-byte (region stability — the tested
  // property that lets concurrent writers touch disjoint entries safely).
  const byStart = new Map(entries
    .filter((entry) => entry._mutated)
    .map((entry) => [entry.rawStart, entry]));
  const lines = raw.split('\n');
  const out = [];

  for (let i = 0; i < lines.length; i++) {
    const entry = byStart.get(i);
    if (!entry) {
      out.push(lines[i]);
      continue;
    }

    out.push(serializeEntry(entry));
    i = entry.rawEnd;
  }

  return out.join('\n').replace(/\s*$/u, '\n');
}

// ---------------------------------------------------------------------------
// Queue write-lock — the ONE canonical lock for publish-queue.md (DD-19; spec
// §8.2 single-runner lock with skip-and-log on overlap → `skipped_on_overlap`).
// Every queue writer holds this lock across its read-modify-write.
//
// Acquisition is ATOMIC via O_EXCL ({ flag: 'wx' }) so two processes can never
// both believe they hold it (a bare existsSync()+writeFileSync() has a TOCTOU
// gap). A lock older than staleMs (e.g. left by a crashed holder) is reclaimed.
//
//   acquireLock(path)          -> non-blocking; { acquired:true } or
//                                 { acquired:false, heldBy, ageMs }
//   acquireLockBlocking(path)  -> spins up to timeoutMs; throws ELOCKTIMEOUT
//   releaseLock(path)          -> unlink IF this process owns it ({force:true} overrides)
//   touchLock(path)            -> refresh owned lock mtime (heartbeat for long runs)
//   statSnapshot/statChanged   -> cheap refuse-to-overwrite change detection
//
// These helpers never call process.exit — the caller decides what to do when the
// lock is held. Pass { register:false } in tests to skip the process-exit
// release handlers. `now` is injectable for deterministic staleness tests.
// ---------------------------------------------------------------------------

// Lock basename derived from the public queue filename (publish-queue.md) — not a
// codename. queueLockFilePath() places it under $CONTENT_HOME/queue/ via paths.js.
const QUEUE_LOCK_BASENAME = '.publish-queue.lock';
// TTL: a holder older than this with no heartbeat is reclaimed (spec §8.4 lock
// TTL; executor heartbeats well within the window — see touchLock).
const DEFAULT_LOCK_STALE_MINUTES = 9;
const DEFAULT_LOCK_STALE_MS = DEFAULT_LOCK_STALE_MINUTES * 60 * 1000;
// Recommended heartbeat interval for long-running holders (well under the TTL so
// an alive holder is never judged stale). Callers schedule touchLock at this rate.
const LOCK_HEARTBEAT_MS = 30 * 1000;

// Path to the canonical queue lock, given the directory that holds the lock files.
function queueLockPath(lockDir) {
  return path.join(lockDir, QUEUE_LOCK_BASENAME);
}

// paths.js-backed convenience: the canonical queue file and its lock under
// $CONTENT_HOME. Callers should prefer these over constructing paths by hand
// (RD-3 — only paths.js derives instance paths).
function queueFilePath(env = process.env) {
  return paths.publishQueue(env);
}
function queueLockFilePath(env = process.env) {
  return path.join(paths.queueLocksDir(env), QUEUE_LOCK_BASENAME);
}

function readLockInfo(lockPath) {
  try { return JSON.parse(fs.readFileSync(lockPath, 'utf8')); } catch { return null; }
}

// Staleness is judged from the lock file's mtime (set atomically at create), NOT
// from its JSON `acquired_at`. Under concurrent acquisition another process can
// read the file in the tiny window after the wx-create but before the JSON body
// is written, get empty/partial content, and wrongly conclude the FRESH lock is
// "stale" — then reclaim it, letting two writers into the critical section (a
// real lost-update race). mtime is immune: a just-created lock has a fresh mtime.
function lockMtimeMs(lockPath) {
  try { return fs.statSync(lockPath).mtimeMs; } catch { return null; }
}

function lockAgeMs(info, now = Date.now()) {
  const acquiredAt = info && info.acquired_at ? new Date(info.acquired_at).getTime() : NaN;
  return Number.isFinite(acquiredAt) ? (now - acquiredAt) : Infinity;
}

function lockAgeMinutes(info, now = Date.now()) {
  const ms = lockAgeMs(info, now);
  return ms === Infinity ? Infinity : ms / 60000;
}

function writeLockFileExclusive(lockPath, owner, now) {
  // Throws EEXIST if the lock already exists (atomic create).
  fs.writeFileSync(lockPath, JSON.stringify({
    pid: process.pid,
    acquired_at: new Date(now()).toISOString(),
    host: os.hostname(),
    owner: owner || null,
  }, null, 2), { encoding: 'utf8', flag: 'wx' });
}

// Release/refresh helpers only ever act on a lock THIS process owns (pid match).
// Unconditionally unlinking could remove a lock another process legitimately
// reclaimed (e.g. after this holder was judged stale), silently letting a third
// writer into the critical section.
function ownsLock(lockPath) {
  const info = readLockInfo(lockPath);
  return Boolean(info && info.pid === process.pid);
}

// Refresh the owned lock file mtime so a long-but-alive holder is never judged
// stale and reclaimed mid-run (staleness is mtime-based — see lockMtimeMs).
// No-op (returns false) on a foreign or missing lock.
function touchLock(lockPath) {
  if (!ownsLock(lockPath)) return false;
  try {
    const now = new Date();
    fs.utimesSync(lockPath, now, now);
    return true;
  } catch { return false; }
}

function registerLockRelease(lockPath) {
  const release = () => { try { if (ownsLock(lockPath)) fs.unlinkSync(lockPath); } catch {} };
  process.on('exit', release);
  process.on('SIGINT', () => { release(); process.exit(130); });
  process.on('SIGTERM', () => { release(); process.exit(143); });
  process.on('uncaughtException', (e) => { release(); console.error(e.stack || e.message); process.exit(2); });
}

function resolveStaleMs(opts) {
  if (opts.staleMs != null) return opts.staleMs;
  if (opts.staleMinutes != null) return opts.staleMinutes * 60000;
  return DEFAULT_LOCK_STALE_MS;
}

// Non-blocking atomic acquire. Reclaims a stale lock once.
function acquireLock(lockPath, opts = {}) {
  const staleMs = resolveStaleMs(opts);
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const register = opts.register !== false;

  try {
    writeLockFileExclusive(lockPath, opts.owner, now);
    if (register) registerLockRelease(lockPath);
    return { acquired: true };
  } catch (e) {
    // EEXIST -> lock is held (check staleness below). EPERM/EACCES -> transient
    // filesystem contention, e.g. Windows "delete pending" on a just-unlinked
    // lock or an antivirus/indexer handle. Report not-acquired so a blocking
    // caller retries and a non-blocking caller backs off — never a lost write.
    if (e.code === 'EPERM' || e.code === 'EACCES') return { acquired: false, transient: true };
    if (e.code !== 'EEXIST') throw e;
  }

  // Lock exists — fresh or stale? Judge by mtime (see lockMtimeMs), never by
  // parsing the (possibly mid-write) JSON body.
  const mtimeMs = lockMtimeMs(lockPath);
  if (mtimeMs === null) {
    // Lock vanished between our create attempt and the stat (released
    // concurrently); report not-acquired so a blocking caller retries the create.
    return { acquired: false };
  }
  const ageMs = now() - mtimeMs;
  if (ageMs < staleMs) {
    return { acquired: false, heldBy: readLockInfo(lockPath), ageMs };
  }

  // Stale (or unparseable timestamp): reclaim it, then re-create atomically.
  try { fs.unlinkSync(lockPath); } catch {}
  try {
    writeLockFileExclusive(lockPath, opts.owner, now);
    if (register) registerLockRelease(lockPath);
    return { acquired: true };
  } catch (e) {
    if (e.code !== 'EEXIST' && e.code !== 'EPERM' && e.code !== 'EACCES') throw e;
    // Lost the reclaim race to another process, or transient Windows contention.
    const info2 = readLockInfo(lockPath);
    return { acquired: false, heldBy: info2, ageMs: lockAgeMs(info2, now()) };
  }
}

// Blocking acquire: retry the atomic acquire every pollMs until acquired or
// timeoutMs elapses (then throws ELOCKTIMEOUT). For writers that prefer to wait
// briefly for a contended write rather than skip a run. Uses real wall-clock for
// the spin; these are short cron writes so contention is rare.
function acquireLockBlocking(lockPath, opts = {}) {
  const timeoutMs = opts.timeoutMs != null ? opts.timeoutMs : 30000;
  const pollMs = opts.pollMs != null ? opts.pollMs : 250;
  const start = Date.now();
  for (;;) {
    const r = acquireLock(lockPath, opts);
    if (r.acquired) return r;
    if (Date.now() - start >= timeoutMs) {
      const held = r.heldBy || {};
      const e = new Error(`queue lock acquisition timed out after ${timeoutMs}ms (held by ${held.owner || 'unknown'} pid ${held.pid})`);
      e.code = 'ELOCKTIMEOUT';
      e.heldBy = r.heldBy;
      throw e;
    }
    const until = Date.now() + pollMs;
    while (Date.now() < until) { /* synchronous spin */ }
  }
}

function sleepSyncMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Atomic tmp+rename write with a small bounded retry for Windows AV/"delete
// pending" EPERM/EBUSY on the rename (the same transient class acquireLock
// tolerates). This is the ONE write primitive every queue writer uses.
function writeFileAtomic(filePath, content) {
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, content, 'utf8');
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try { fs.renameSync(tmpPath, filePath); return; }
    catch (e) {
      if (e.code !== 'EPERM' && e.code !== 'EBUSY' && e.code !== 'EACCES') throw e;
      lastErr = e;
      sleepSyncMs(100);
    }
  }
  throw lastErr;
}

// Append one pre-composed "## Entry - ..." block to the queue ATOMICALLY. The
// caller must hold the canonical queue lock. Separator semantics: a
// newline-terminated file gets one separator line; an unterminated file gets two;
// a missing file gets the block alone.
function appendEntryBlock(queuePath, entryBlock) {
  const cur = fs.existsSync(queuePath) ? fs.readFileSync(queuePath, 'utf8') : '';
  const sep = cur === '' ? '' : (cur.endsWith('\n') ? '\n' : '\n\n');
  writeFileAtomic(queuePath, cur + sep + entryBlock + '\n');
}

// Transition one entry's state (plus extra fields) by re-reading the queue fresh
// and re-serializing through the canonical parser — so ad-hoc writers stop
// regex-patching state lines. Caller must hold the canonical lock. The mutated
// entry is re-serialized canonically (FIELD_ORDER first, ASCII "-" header);
// matching is by content_id so a transition can never leak onto a same-header
// sibling. Returns { ok:false, reason } on a missing entry or a from-guard miss
// (and writes nothing in that case).
function setEntryState(queuePath, contentId, { from = null, to, fields = {} } = {}) {
  if (!to) return { ok: false, reason: 'missing target state' };
  const raw = fs.readFileSync(queuePath, 'utf8');
  const entries = parseQueue(raw);
  const entry = entries.find((e) => e.header === contentId || e.fields.content_id === contentId);
  if (!entry) return { ok: false, reason: `entry not found: ${contentId}` };
  const previous = entry.fields.state || '';
  if (from && previous !== from) return { ok: false, reason: `state is '${previous}', expected '${from}'` };
  entry.fields.state = to;
  for (const [key, value] of Object.entries(fields)) entry.fields[key] = value;
  entry._mutated = true;
  writeFileAtomic(queuePath, serializeQueue(raw, entries));
  return { ok: true, previous };
}

function releaseLock(lockPath, opts = {}) {
  if (!opts.force && !ownsLock(lockPath)) return false;
  try { fs.unlinkSync(lockPath); return true; } catch { return false; }
}

// Cheap change-detection for refuse-to-overwrite checks: a writer records a
// snapshot right after reading the queue and verifies it before every rewrite, so
// a foreign write (mtime or size delta) is detected instead of being clobbered by
// a stale-snapshot rewrite. null = file missing/unreadable (treated as changed).
function statSnapshot(filePath) {
  try {
    const s = fs.statSync(filePath);
    return { mtimeMs: s.mtimeMs, size: s.size };
  } catch { return null; }
}

function statChanged(filePath, snapshot) {
  const cur = statSnapshot(filePath);
  if (!snapshot || !cur) return true;
  return cur.mtimeMs !== snapshot.mtimeMs || cur.size !== snapshot.size;
}

module.exports = {
  ENTRY_HEADER_RE,
  FIELD_ORDER,
  parseQueue,
  parseFields,
  serializeFieldValue,
  serializeEntry,
  serializeQueue,
  QUEUE_LOCK_BASENAME,
  DEFAULT_LOCK_STALE_MINUTES,
  DEFAULT_LOCK_STALE_MS,
  LOCK_HEARTBEAT_MS,
  queueLockPath,
  queueFilePath,
  queueLockFilePath,
  readLockInfo,
  lockAgeMs,
  lockAgeMinutes,
  acquireLock,
  acquireLockBlocking,
  releaseLock,
  ownsLock,
  touchLock,
  statSnapshot,
  statChanged,
  writeFileAtomic,
  appendEntryBlock,
  setEntryState,
};
