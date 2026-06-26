'use strict';

/**
 * engine/brand-dna/engagement-timeline.js  [N net-new — deterministic engagement-timeline analyzer]
 *
 * Builds the ENGAGEMENT TIMELINE + PROJECT-FACTS artifact from a brand's OWN ingested history
 * (release-spec §1.1/§1.2 — "full historical data of the brand … timeline of highest-engagement info
 * and project summary/facts"). It is the deterministic, auditable counterpart to the brand-DNA voice
 * analysis: given the own-account corpus (whose items now carry public engagement `metrics`), it
 * computes a chronological monthly timeline, the highest-engagement posts, and a project-facts
 * summary (window, totals, peak period, media lift, engagement rate).
 *
 * Pure + deterministic + zero-key (RD-12): items in, artifact out — NO LLM, NO network, NO disk. The
 * CLI verb (engine/cli/engagement-timeline.js) reads the corpus and writes the artifact; this module
 * only computes. It reuses the shared corpus helpers (corpus-util) so the engagement normalization
 * here agrees with the brand-DNA analyzer's.
 *
 * Engagement SCORE (the one heuristic — documented so it is auditable, DD-9: no calibrated secret
 * weights): a composite of the public interaction counts, weighting amplification + deeper engagement
 * above a passive like. Impressions are REACH, not engagement, so they are reported separately and
 * used only for the optional engagement-RATE (engagement / impressions), never folded into the score.
 *
 *   score = 1·likes + 2·replies + 3·reposts + 2·bookmarks
 *
 * Tier-3 cleanliness (§0.3 r6): no IDs/handles/paths/brand strings; the brand id is a passed value.
 */

const { metricsOf, median, mean, round2, collapseWhitespace, stripUrls, hasMedia } = require('./corpus-util');

/** The composite engagement-score weights (auditable; reposts = amplification weighted highest). */
const SCORE_WEIGHTS = Object.freeze({ likes: 1, replies: 2, reposts: 3, bookmarks: 2 });
const SCORE_FORMULA = '1·likes + 2·replies + 3·reposts + 2·bookmarks (impressions excluded — reach, not engagement)';
const EXCERPT_MAX = 160;
const DEFAULT_TOP = 10;

/** Composite engagement score for a normalized metrics object (0 when metrics are absent/all-zero). */
function scoreOf(m) {
  if (!m) return 0;
  return (
    SCORE_WEIGHTS.likes * (m.likes || 0) +
    SCORE_WEIGHTS.replies * (m.replies || 0) +
    SCORE_WEIGHTS.reposts * (m.reposts || 0) +
    SCORE_WEIGHTS.bookmarks * (m.bookmarks || 0)
  );
}

/** The 'YYYY-MM' (or 'YYYY-Www' for weekly) period key for an ISO timestamp; 'undated' when unparseable. */
function periodKeyOf(iso, granularity) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 'undated';
  const d = new Date(t);
  if (granularity === 'week') {
    // ISO week number (UTC), stable + deterministic.
    const dt = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    const day = dt.getUTCDay() || 7;
    dt.setUTCDate(dt.getUTCDate() + 4 - day);
    const yearStart = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
    const week = Math.ceil(((dt - yearStart) / 86400000 + 1) / 7);
    return `${dt.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
  }
  return new Date(t).toISOString().slice(0, 7); // YYYY-MM
}

/** A clean, URL-stripped, truncated excerpt of OWN post text (own content — safe to excerpt). */
function excerpt(text) {
  const clean = collapseWhitespace(stripUrls(text));
  return clean.length <= EXCERPT_MAX ? clean : `${clean.slice(0, EXCERPT_MAX - 1)}…`;
}

/** Build a per-post enriched record (score + normalized metrics + period). */
function enrich(item, granularity) {
  const m = metricsOf(item);
  return {
    captured_at: typeof item.captured_at === 'string' ? item.captured_at : null,
    period: periodKeyOf(item.captured_at, granularity),
    has_metrics: m != null,
    metrics: m,
    score: scoreOf(m),
    impressions: m ? m.impressions || 0 : 0,
    has_media: hasMedia(item),
    text_excerpt: excerpt(item.text),
    url: typeof item.url === 'string' && item.url ? item.url : null,
    author: typeof item.author === 'string' && item.author ? item.author : null,
  };
}

/** Chronological period sort with 'undated' always last. */
function comparePeriods(a, b) {
  if (a === b) return 0;
  if (a === 'undated') return 1;
  if (b === 'undated') return -1;
  return a < b ? -1 : 1;
}

/**
 * Build the engagement-timeline artifact from a brand's OWN corpus items.
 *
 * @param {object[]} ownItems  corpus-item.schema.json items (the OWN slice — caller partitions).
 * @param {object} [opts]
 * @param {string} [opts.brand]        brand id (recorded on the artifact).
 * @param {number} [opts.top]          how many highest-engagement posts to list (default 10).
 * @param {string} [opts.granularity]  'month' (default) | 'week'.
 * @param {string} [opts.generatedAt]  ISO stamp to record (the CLI passes one; pure-callers omit).
 * @returns {object} an artifact conforming to schemas/artifacts/engagement-timeline.schema.json.
 */
function buildEngagementTimeline(ownItems, opts = {}) {
  const granularity = opts.granularity === 'week' ? 'week' : 'month';
  const top = Number.isFinite(opts.top) && opts.top > 0 ? Math.floor(opts.top) : DEFAULT_TOP;
  const items = (Array.isArray(ownItems) ? ownItems : []).filter((it) => it && typeof it === 'object' && typeof it.text === 'string');

  const enriched = items.map((it) => enrich(it, granularity));
  const withMetrics = enriched.filter((e) => e.has_metrics);

  // Window (earliest..latest captured_at across all items that have one).
  const dates = enriched.map((e) => e.captured_at).filter(Boolean).map((s) => Date.parse(s)).filter(Number.isFinite).sort((a, b) => a - b);
  const window = dates.length
    ? { start: new Date(dates[0]).toISOString(), end: new Date(dates[dates.length - 1]).toISOString() }
    : { start: null, end: null };

  const totals = {
    posts: enriched.length,
    posts_with_metrics: withMetrics.length,
    posts_without_metrics: enriched.length - withMetrics.length,
    with_media: enriched.filter((e) => e.has_media).length,
  };

  // Per-period buckets.
  const byPeriod = new Map();
  for (const e of enriched) {
    if (!byPeriod.has(e.period)) byPeriod.set(e.period, []);
    byPeriod.get(e.period).push(e);
  }
  const timeline = [...byPeriod.keys()].sort(comparePeriods).map((period) => {
    const bucket = byPeriod.get(period);
    const scores = bucket.filter((e) => e.has_metrics).map((e) => e.score);
    const totalEng = scores.reduce((s, n) => s + n, 0);
    const topPost = bucket.slice().sort((a, b) => b.score - a.score)[0] || null;
    return {
      period,
      posts: bucket.length,
      posts_with_metrics: scores.length,
      total_engagement: totalEng,
      avg_score: round2(mean(scores)),
      median_score: round2(median(scores)),
      top_post: topPost && topPost.has_metrics
        ? { score: topPost.score, captured_at: topPost.captured_at, text_excerpt: topPost.text_excerpt, url: topPost.url }
        : null,
    };
  });

  // Top posts overall (by score, then recency as a stable tiebreak). Only metric-bearing posts rank.
  const ranked = withMetrics.slice().sort((a, b) => b.score - a.score || String(b.captured_at || '').localeCompare(String(a.captured_at || '')));
  const top_posts = ranked.slice(0, top).map((e, i) => ({
    rank: i + 1,
    captured_at: e.captured_at,
    score: e.score,
    metrics: e.metrics,
    has_media: e.has_media,
    text_excerpt: e.text_excerpt,
    url: e.url,
    author: e.author,
  }));

  // Project-facts summary.
  const allScores = withMetrics.map((e) => e.score);
  const totalEngagement = allScores.reduce((s, n) => s + n, 0);
  const peakPeriod = timeline.filter((t) => t.posts_with_metrics > 0).slice().sort((a, b) => b.total_engagement - a.total_engagement)[0] || null;
  const busiestPeriod = timeline.slice().sort((a, b) => b.posts - a.posts)[0] || null;

  // Media lift: avg score with vs without media (only when both groups have metric-bearing posts).
  const mediaScores = withMetrics.filter((e) => e.has_media).map((e) => e.score);
  const noMediaScores = withMetrics.filter((e) => !e.has_media).map((e) => e.score);
  let media_lift = null;
  if (mediaScores.length && noMediaScores.length) {
    const withAvg = mean(mediaScores);
    const withoutAvg = mean(noMediaScores);
    media_lift = {
      with_media_avg: round2(withAvg),
      without_media_avg: round2(withoutAvg),
      lift_ratio: withoutAvg > 0 ? round2(withAvg / withoutAvg) : null,
    };
  }

  // Engagement rate (engagement / impressions) over posts with impressions > 0.
  const rated = withMetrics.filter((e) => e.impressions > 0);
  const avg_engagement_rate = rated.length ? round2(mean(rated.map((e) => e.score / e.impressions))) : null;

  const summary = {
    total_engagement: totalEngagement,
    avg_score: round2(mean(allScores)),
    median_score: round2(median(allScores)),
    peak_period: peakPeriod ? { period: peakPeriod.period, posts: peakPeriod.posts, total_engagement: peakPeriod.total_engagement, avg_score: peakPeriod.avg_score } : null,
    busiest_period: busiestPeriod ? { period: busiestPeriod.period, posts: busiestPeriod.posts } : null,
    media_lift,
    avg_engagement_rate,
  };

  // Honest notes (the analysis must be self-describing about what it could/couldn't compute).
  const notes = [];
  if (totals.posts === 0) notes.push('No own-account corpus found — ingest the brand history first (engine ingest-brand). The timeline is empty until there is history.');
  else if (totals.posts_with_metrics === 0) notes.push('Corpus has posts but NO engagement metrics — re-ingest with an adapter that carries public counts (e.g. the apify adapter) to populate the highest-engagement timeline. Volume-by-period is still shown.');
  if (window.start == null && totals.posts > 0) notes.push('No usable timestamps on the corpus items — periods could not be derived (all bucketed as "undated").');

  return {
    artifact: 'engagement-timeline',
    generated_with: 'deterministic-no-llm',
    brand: opts.brand || null,
    generated_at: opts.generatedAt || null,
    granularity,
    window,
    totals,
    engagement_basis: { score_formula: SCORE_FORMULA, weights: { ...SCORE_WEIGHTS } },
    summary,
    top_posts,
    timeline,
    notes,
  };
}

module.exports = {
  SCORE_WEIGHTS,
  SCORE_FORMULA,
  scoreOf,
  periodKeyOf,
  excerpt,
  buildEngagementTimeline,
};
