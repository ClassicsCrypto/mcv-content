'use strict';

/**
 * engine/library/usage-log.js  [A adapted — canonical redesign]
 *
 * THE single canonical cooldown ledger (release-spec §7.8, §8.6; DD-14).
 *
 * Every confirmed publish appends one record to $CONTENT_HOME/library/usage-log.jsonl;
 * the three cooldown enforcement points (release-spec §8.6 / §14.1) — the retrieval
 * filter (engine/library/check.js), package validation (engine/gate/validate-package.js),
 * and the publish executor (engine/orchestrator/publish-executor.js) — all read this one
 * ledger through this module's API. There is no second usage source: this redesign
 * replaces the production module's multi-source read (a dangling usage-log.json plus a
 * scrape of the live queue file and Discord preview residue), which coupled cooldown to
 * private workflow artifacts and could not be reasoned about. Here the ledger is the only
 * truth, written once on confirmed publish, reconciled when a publish is killed at the
 * second gate (DD-14).
 *
 * Cooldown semantics (release-spec §8.6, DD-14):
 *   - 14-day hard floor, 30-day target window (shipped defaults; per-brand configurable
 *     via config/system.json `cooldown` / brand `cooldown_overrides`). This module does NOT
 *     own those defaults — callers pass the window in days. The values 14/30 live in config
 *     and the cooldown rule artifact (P3-COOLDOWN); the constants here are only the fallback
 *     a bare call uses so a missing config never silently disables cooldown.
 *   - Asset identity includes FAMILY / DESCENDANT matching: re-crops and modifications of an
 *     asset inherit the original's cooldown (DR W#48). Matching is path-equality first, then
 *     a normalized family key (strips platform/size/variant suffixes and derivative-folder
 *     segments) so a derivative under a different name still matches its ancestor.
 *
 * Storage: append-only JSON Lines. Each line is one record:
 *   { asset_id, content_id, used_at, platform?, family_key?, base_asset_id? }
 * `used_at` is an ISO-8601 timestamp. Reconciliation (second-gate kill) rewrites the file
 * minus the matching record(s); this is the only non-append operation (DD-14).
 *
 * Paths are resolved exclusively through engine/shared/paths.js (RD-3); this module never
 * constructs an instance path itself. It is pure of brand specifics — no account enums, no
 * hardcoded directories, no codenames.
 */

const fs = require('fs');
const path = require('path');
const paths = require('../shared/paths.js');

/** Shipped cooldown defaults (release-spec §8.6). Config overrides these per brand. */
const DEFAULT_HARD_DAYS = 14;
const DEFAULT_TARGET_DAYS = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Match-reason vocabulary surfaced to callers (mirrors retrieval-result cooldown_status). */
const MATCH_REASON = Object.freeze({
  ASSET: 'asset_path',
  BASE: 'base_asset_path',
  FAMILY: 'asset_family',
  BASE_FAMILY: 'base_asset_family',
});

/** Media file extensions an asset id/path may carry. */
const MEDIA_EXT_RE = /\.(png|jpe?g|webp|gif|mp4|mov|m4v|webm)$/iu;

/**
 * Normalize an asset id/path to a comparable, $CONTENT_HOME-relative-ish key.
 * Strips quoting, backslashes, and any leading library/ prefix so equal assets compare
 * equal regardless of how the caller spelled the reference. NOT a redaction step — purely
 * structural normalization for matching.
 * @param {string} value
 * @returns {string}
 */
function normalizeAssetId(value) {
  return String(value || '')
    .trim()
    .replace(/^`|`$/gu, '')
    .replace(/^['"]|['"]$/gu, '')
    .replace(/\\/gu, '/')
    .replace(/^library\//iu, '');
}

/**
 * Compute the FAMILY key for an asset (release-spec §8.6 family/descendant matching).
 * Two assets share a family when their derivative-stripped scope + stem match, so that a
 * crop/resize/platform variant inherits its ancestor's cooldown. Returns '' for non-media
 * or unkeyable inputs (which then only match on exact path equality).
 * @param {string} value
 * @returns {string}
 */
function assetFamilyKey(value) {
  const normalized = normalizeAssetId(value).toLowerCase();
  if (!normalized || !MEDIA_EXT_RE.test(normalized)) return '';

  // Drop derivative/output folder segments so a derivative under exports/ or optimized/
  // resolves to the same scope as its source.
  const dirParts = path.posix
    .dirname(normalized)
    .split('/')
    .filter(Boolean)
    .filter(
      (part) =>
        ![
          'optimized',
          'optimised',
          'exports',
          'export',
          'resized',
          'resize',
          'preview',
          'previews',
          'cdn',
          'upload',
          'derivatives',
        ].includes(part),
    );
  const scope = dirParts.slice(0, 2).join('/');

  // Strip platform/size/variant/derivative suffixes from the filename stem.
  let stem = path.posix.basename(normalized).replace(/\.[a-z0-9]+$/iu, '');
  stem = stem
    .replace(/[_\s]+/gu, '-')
    .replace(/--+/gu, '-')
    .replace(/(?:^|-)copy(?:-\d+)?$/iu, '')
    .replace(
      /-(?:instagram|insta|twitter|tweet|x|facebook|fb|giphy|youtube|yt|tiktok|tt|optimized|optimised|preview|cdn|upload|export|asset|card|fresh|live|draft|final|revised|variant|thumbnail|thumb|cover|story|feed|square|portrait|landscape|wide|mobile)(?=-|$)/giu,
      '-',
    )
    .replace(/-(?:\d{3,4}x\d{3,4}|512|768|1024|1080|1200|1350|1440|1920|2048|2160|4096)(?=-|$)/gu, '-')
    .replace(/-(?:v|r)\d+(?=-|$)/giu, '-')
    .replace(/--+/gu, '-')
    .replace(/^-+|-+$/gu, '');

  return [scope, stem].filter(Boolean).join('/');
}

/**
 * Parse the ledger file into records. Missing file ⇒ []. Malformed lines are skipped
 * (a single bad line never poisons the whole ledger). Pure read; no side effects.
 * @param {object} [env]
 * @returns {Array<object>}
 */
function readLedger(env = process.env) {
  const file = paths.usageLog(env);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

/** Ensure the library dir exists before a ledger write. */
function ensureLibraryDir(env) {
  fs.mkdirSync(paths.libraryDir(env), { recursive: true });
}

/**
 * Does a ledger record reference the given asset (by id, base, or family)?
 * Family matching makes derivatives inherit the cooldown (release-spec §8.6).
 * @returns {string|null} the match reason, or null if no match.
 */
function matchReason(record, assetId) {
  const target = normalizeAssetId(assetId);
  if (!target) return null;
  if (normalizeAssetId(record.asset_id) === target) return MATCH_REASON.ASSET;
  if (record.base_asset_id && normalizeAssetId(record.base_asset_id) === target) {
    return MATCH_REASON.BASE;
  }

  const family = assetFamilyKey(assetId);
  if (!family) return null;
  if (assetFamilyKey(record.asset_id) === family) return MATCH_REASON.FAMILY;
  if (record.base_asset_id && assetFamilyKey(record.base_asset_id) === family) {
    return MATCH_REASON.BASE_FAMILY;
  }
  return null;
}

/**
 * All records that reference the asset (family-aware), newest first.
 * @param {string} assetId
 * @param {object} [options]
 * @param {string} [options.excludeContentId]  skip uses from this content item (so re-gating
 *   the same item does not block itself).
 * @param {Array<object>} [options.records]    pre-read ledger (avoids re-reading the file).
 * @param {object} [options.env]
 * @returns {Array<{record: object, reason: string, usedAt: number}>}
 */
function matchingUses(assetId, options = {}) {
  const records = options.records || readLedger(options.env);
  const exclude = options.excludeContentId || null;
  return records
    .map((record) => ({ record, reason: matchReason(record, assetId), usedAt: Date.parse(record.used_at) }))
    .filter(({ record, reason, usedAt }) => {
      if (!reason) return false;
      if (exclude && record.content_id === exclude) return false;
      return Number.isFinite(usedAt);
    })
    .sort((a, b) => b.usedAt - a.usedAt);
}

/**
 * Whole days since the asset (or family) was last used; Infinity if never.
 * @param {string} assetId
 * @param {object} [options]  see matchingUses; plus `now` (ms) for deterministic tests.
 * @returns {number}
 */
function daysSinceLastUse(assetId, options = {}) {
  const uses = matchingUses(assetId, options);
  if (uses.length === 0) return Infinity;
  const now = options.now ?? Date.now();
  return (now - uses[0].usedAt) / MS_PER_DAY;
}

/**
 * Count uses of the asset (or family) inside a window.
 * @param {string} assetId
 * @param {number} [days=DEFAULT_TARGET_DAYS]
 * @param {object} [options]  see matchingUses; plus `now`.
 * @returns {number}
 */
function recentUseCount(assetId, days = DEFAULT_TARGET_DAYS, options = {}) {
  const now = options.now ?? Date.now();
  const cutoff = now - days * MS_PER_DAY;
  return matchingUses(assetId, options).filter(({ usedAt }) => usedAt > cutoff).length;
}

/**
 * Is the asset currently inside its cooldown window? The primary predicate the three
 * enforcement points call (release-spec §8.6/§14.1).
 * @param {string} assetId
 * @param {number} [windowDays=DEFAULT_HARD_DAYS]  the hard floor (config-supplied; default 14).
 * @param {object} [options]  see matchingUses; plus `now`.
 * @returns {boolean} true ⇒ reuse is blocked.
 */
function isInCooldown(assetId, windowDays = DEFAULT_HARD_DAYS, options = {}) {
  return recentUseCount(assetId, windowDays, options) > 0;
}

/**
 * Full cooldown status for a candidate, shaped to match the retrieval-result
 * `cooldown_status` block (schemas/artifacts/retrieval-result.schema.json) and the
 * media-decision `cooldown_ref` block. This is what the retrieval scorer and the gate
 * attach to their outputs.
 * @param {string} assetId
 * @param {object} [options]  `hardDays` (default 14), `targetDays` (default 30),
 *   `excludeContentId`, `records`, `now`, `env`.
 * @returns {object}
 */
function cooldownStatus(assetId, options = {}) {
  const hardDays = options.hardDays ?? DEFAULT_HARD_DAYS;
  const now = options.now ?? Date.now();
  const cutoff = now - hardDays * MS_PER_DAY;
  const uses = matchingUses(assetId, { ...options, now });
  const recentUses = uses.filter(({ usedAt }) => usedAt > cutoff);
  const last = uses[0] || null;

  return {
    asset_id: normalizeAssetId(assetId),
    asset_family_key: assetFamilyKey(assetId) || null,
    cooldown_days: hardDays,
    recent_use_count: recentUses.length,
    days_since_last_use: last ? Math.round((now - last.usedAt) / MS_PER_DAY) : null,
    eligible: recentUses.length === 0,
    cooldown_blocked: recentUses.length > 0,
    last_use: last
      ? {
          content_id: last.record.content_id || 'unknown',
          platform: last.record.platform || 'unknown',
          used_at: last.record.used_at,
          match_reason: last.reason,
        }
      : null,
  };
}

/**
 * Append one confirmed-publish use to the canonical ledger (DD-14). The ONLY write path
 * the executor calls on a confirmed publish. Append-only: never rewrites existing lines.
 * @param {object} use
 * @param {string} use.asset_id     the used asset (CONTENT_HOME-relative id/path).
 * @param {string} use.content_id   the content item that used it.
 * @param {string} [use.used_at]    ISO timestamp (default: now).
 * @param {string} [use.platform]   platform descriptor id.
 * @param {string} [use.base_asset_id]  for modify lanes, the ancestor asset (family root).
 * @param {object} [options]  `env`.
 * @returns {object} the persisted record.
 * @throws {Error} when required fields are missing (fail-fast — a use without an asset or
 *   content id corrupts cooldown integrity; release-spec §15 archive-write row).
 */
function recordUse(use, options = {}) {
  const env = options.env || process.env;
  const assetId = normalizeAssetId(use && use.asset_id);
  const contentId = use && use.content_id ? String(use.content_id) : '';
  if (!assetId) {
    throw new Error('usage-log.recordUse: asset_id is required (cooldown integrity, DD-14).');
  }
  if (!contentId) {
    throw new Error('usage-log.recordUse: content_id is required (cooldown integrity, DD-14).');
  }
  const usedAt = use.used_at && !Number.isNaN(Date.parse(use.used_at))
    ? new Date(use.used_at).toISOString()
    : new Date().toISOString();

  const record = {
    asset_id: assetId,
    content_id: contentId,
    used_at: usedAt,
  };
  if (use.platform) record.platform = String(use.platform);
  if (use.base_asset_id) record.base_asset_id = normalizeAssetId(use.base_asset_id);
  record.family_key = assetFamilyKey(assetId) || null;

  ensureLibraryDir(env);
  fs.appendFileSync(paths.usageLog(env), `${JSON.stringify(record)}\n`, 'utf8');
  return record;
}

/**
 * Remove ledger records for a content item that was killed at the publisher's second gate
 * (DD-14 reconciliation). The only non-append operation: rewrites the file minus the
 * matching lines so a kill does not leave a phantom cooldown block. Idempotent.
 * @param {string} contentId
 * @param {object} [options]  `assetId` (narrow to one asset), `env`.
 * @returns {number} how many records were removed.
 */
function reconcileRemove(contentId, options = {}) {
  const env = options.env || process.env;
  const file = paths.usageLog(env);
  if (!fs.existsSync(file)) return 0;
  const targetAsset = options.assetId ? normalizeAssetId(options.assetId) : null;

  const kept = [];
  let removed = 0;
  for (const record of readLedger(env)) {
    const sameItem = String(record.content_id) === String(contentId);
    const sameAsset = !targetAsset || normalizeAssetId(record.asset_id) === targetAsset;
    if (sameItem && sameAsset) {
      removed += 1;
    } else {
      kept.push(record);
    }
  }
  if (removed > 0) {
    const body = kept.map((r) => JSON.stringify(r)).join('\n');
    fs.writeFileSync(file, body ? `${body}\n` : '', 'utf8');
  }
  return removed;
}

module.exports = {
  DEFAULT_HARD_DAYS,
  DEFAULT_TARGET_DAYS,
  MATCH_REASON,
  normalizeAssetId,
  assetFamilyKey,
  readLedger,
  matchingUses,
  daysSinceLastUse,
  recentUseCount,
  isInCooldown,
  cooldownStatus,
  recordUse,
  reconcileRemove,
};
