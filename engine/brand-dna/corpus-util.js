'use strict';

/**
 * engine/brand-dna/corpus-util.js  [N net-new — shared pure helpers for the brand-DNA analyzers]
 *
 * Small, dependency-free, deterministic helpers shared by engine/brand-dna/analyze.js and
 * engine/brand-dna/archetypes.js (release-spec 1.1/1.2 Data Ingestion & Brand Identity; the
 * deterministic auditable core of the brand-DNA flow). NO LLM, NO network, NO disk — pure
 * value-in/value-out so the analyzers stay reproducible and zero-key testable (RD-12).
 *
 * Corpus items conform to schemas/inputs/corpus-item.schema.json. The schema's REQUIRED fields are
 * { source, captured_at, text, trust_class, retention_class }; OPTIONAL fields the analyzers read
 * WHEN PRESENT are `author`, `url`, `media_refs`, plus extension fields real exports/scrapers carry
 * (`metrics`, `format`, `media_keys`, `is_quote_tweet`, `first_line`). Everything here is tolerant:
 * a missing/odd field degrades to a safe default, never a throw — the analysis must survive a messy
 * real-world corpus.
 *
 * Tier-3 cleanliness (§0.3 r6): no IDs/handles/paths/brand strings/persona codenames.
 */

/** Collapse all runs of whitespace (incl. newlines) to single spaces; trim. */
function collapseWhitespace(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
}

/** Strip http(s) URLs from a string (used so URL noise does not skew length/hook signals). */
function stripUrls(s) {
  return String(s == null ? '' : s).replace(/https?:\/\/\S+/g, '');
}

/**
 * Does the item carry media? Tolerant of the two shapes seen in practice:
 *   - corpus-item.schema.json `media_refs: string[]`, and
 *   - exporter/scraper `media_keys: string[]` (the production corpus shape).
 * Also treats a t.co-style short link as a media indicator (matches production heuristic).
 */
function hasMedia(item) {
  if (!item || typeof item !== 'object') return false;
  if (Array.isArray(item.media_refs) && item.media_refs.length > 0) return true;
  if (Array.isArray(item.media_keys) && item.media_keys.length > 0) return true;
  if (typeof item.text === 'string' && /https?:\/\/t\.co\/\S+/.test(item.text)) return true;
  return false;
}

/**
 * Is this item OWN (operator) content vs competitor (Zone-U third-party)?
 * Default rule: trust_class === 'operator-curated' is OWN (the promoted, attested class per
 * corpus-item.schema.json); everything else (incl. 'untrusted-scraped') is competitor/third-party.
 * Callers with explicit own/competitor knowledge pass their own predicate to the analyzers.
 */
function isOwn(item) {
  return Boolean(item && item.trust_class === 'operator-curated');
}

/**
 * Normalize an item's engagement metrics into a flat { likes, replies, reposts, impressions,
 * bookmarks } object, or null when the item carries NO metrics. Accepts the common shapes:
 *   - item.metrics: { like_count, reply_count, retweet_count|repost_count, impression_count,
 *                     bookmark_count } (the production/X export shape), OR
 *   - item.metrics: { likes, replies, reposts|retweets, impressions, bookmarks } (already-flat).
 * Missing sub-metrics default to 0; an item with a metrics object but all-zero is still "has
 * metrics" (a real zero-engagement post), distinct from null (no metrics captured at all).
 */
function metricsOf(item) {
  const m = item && typeof item === 'object' ? item.metrics : null;
  if (!m || typeof m !== 'object') return null;
  const pick = (...keys) => {
    for (const k of keys) {
      if (m[k] != null && Number.isFinite(Number(m[k]))) return Number(m[k]);
    }
    return 0;
  };
  return {
    likes: pick('like_count', 'likes'),
    replies: pick('reply_count', 'replies'),
    reposts: pick('retweet_count', 'repost_count', 'reposts', 'retweets'),
    impressions: pick('impression_count', 'impressions', 'views'),
    bookmarks: pick('bookmark_count', 'bookmarks'),
  };
}

/** Median of a numeric array (0 for empty). Pure; does not mutate the input. */
function median(arr) {
  const nums = (Array.isArray(arr) ? arr : []).map(Number).filter(Number.isFinite);
  if (!nums.length) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** Arithmetic mean of a numeric array (0 for empty). */
function mean(arr) {
  const nums = (Array.isArray(arr) ? arr : []).map(Number).filter(Number.isFinite);
  if (!nums.length) return 0;
  return nums.reduce((s, n) => s + n, 0) / nums.length;
}

/** Round to 2 decimals (stable, EPSILON-corrected). */
function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

module.exports = {
  collapseWhitespace,
  stripUrls,
  hasMedia,
  isOwn,
  metricsOf,
  median,
  mean,
  round2,
};
