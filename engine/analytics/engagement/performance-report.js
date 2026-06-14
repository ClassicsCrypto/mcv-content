'use strict';

/**
 * engine/analytics/engagement/performance-report.js  [A adapted]
 *
 * The REQUIRED weekly performance report — the analyst→operator handoff artifact
 * (release-spec §7.9 "the weekly summary is a REQUIRED output of the analytics loop"; §9.2
 * analyst→operator handoff; §8.9 v1 scope). Emits a `performance-report.schema.json`-conformant
 * object and writes it under $CONTENT_HOME/analytics/.
 *
 * Adapted from the production `maybeWriteWeeklySummary` (the per-account top/bottom ranking and
 * the 7-day window), with the production caveat fixed (gap §2.1 analytics row): the production
 * writer was Sunday-best-effort and emitted free-form Markdown; the public report is emitted on
 * demand for any week and is a structured §7.9 artifact (checkpoints + baselines + weekly
 * summary with by-dimension aggregates + recommendations). De-localized: the production `account`
 * grouping is the public `brand` field (§7.4 / DD-10).
 *
 * v1 scope (honest, §8.9): aggregation over locally-collected checkpoints. `recommendations[]`
 * are human-facing inputs to learning records — never auto-applied (DD-6). The report mutates
 * nothing but its own output file.
 *
 * Pure of brand specifics (§1 per-path rule): no account enums, no hardcoded paths, no codename.
 */

const fs = require('fs');
const path = require('path');

const paths = require('../../shared/paths.js');
const { redact } = require('../../shared/redact.js');
const { readRawCorpus, computeBaselines } = require('./baselines.js');

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
/** Dimensions the weekly summary aggregates by (§7.9 schema enum: type|theme|format|hook). */
const AGGREGATE_DIMENSIONS = Object.freeze(['type', 'theme', 'format', 'hook']);
/** Top/bottom N surfaced as recommendations (production surfaced top-3/bottom-3). */
const RANK_N = 3;

/** ISO date (YYYY-MM-DD) from an ms timestamp. */
function isoDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/** The latest checkpoint per content_id (prefer 7d, then 24h, then 1h), for ranking. */
function latestPerContent(records) {
  const rank = { '7d': 3, '24h': 2, '1h': 1 };
  const byContent = new Map();
  for (const r of records) {
    const prev = byContent.get(r.content_id);
    if (!prev || (rank[r.checkpoint] || 0) > (rank[prev.checkpoint] || 0)) {
      byContent.set(r.content_id, r);
    }
  }
  return [...byContent.values()];
}

/** Primary metric for ranking: likes, else impressions, else views, else 0. */
function primaryValue(metrics = {}) {
  if (typeof metrics.likes === 'number') return metrics.likes;
  if (typeof metrics.impressions === 'number') return metrics.impressions;
  if (typeof metrics.views === 'number') return metrics.views;
  return 0;
}

/** Aggregate latest-per-content records by a dimension field; returns §7.9 aggregate rows. */
function aggregateByDimension(latest, dimension) {
  const buckets = new Map();
  for (const r of latest) {
    const key = r[dimension];
    if (key == null || key === '') continue;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(r);
  }
  const rows = [];
  for (const [key, arr] of buckets) {
    const metrics = {};
    for (const mk of ['likes', 'comments', 'shares', 'views', 'impressions']) {
      const vals = arr.map((r) => r.metrics && r.metrics[mk]).filter((v) => typeof v === 'number');
      if (vals.length) {
        metrics[`${mk}_mean`] = Math.round(vals.reduce((s, v) => s + v, 0) / vals.length);
      }
    }
    rows.push({ dimension, key: String(key), sample_size: arr.length, metrics });
  }
  return rows;
}

/**
 * Human-facing recommendations from the week's top/bottom performers + outlier flags. These are
 * INPUTS to proposed learning records (§8.9), never auto-applied (DD-6). Plain, neutral strings.
 */
function buildRecommendations(latest, outliers) {
  const ranked = latest
    .map((r) => ({ content_id: r.content_id, format: r.format, value: primaryValue(r.metrics) }))
    .sort((a, b) => b.value - a.value);
  const recs = [];
  for (const top of ranked.slice(0, RANK_N)) {
    recs.push(`Top performer: ${top.content_id} (${top.format || 'unknown format'}) reached ${top.value} on its primary metric — consider reinforcing this pattern.`);
  }
  for (const bottom of ranked.slice(-RANK_N).reverse()) {
    if (ranked.length <= RANK_N) break; // avoid double-listing tiny corpora
    recs.push(`Underperformer: ${bottom.content_id} (${bottom.format || 'unknown format'}) reached only ${bottom.value} — review against the format baseline.`);
  }
  for (const o of outliers) {
    recs.push(`${o.outlier} (${o.ratio}x baseline): ${o.content_id} on ${o.platform || 'unknown platform'} at ${o.checkpoint}.`);
  }
  return recs;
}

/**
 * buildWeeklyReport — the public entry point (plan P3-BASELINES export).
 *
 * Builds a §7.9-conformant performance report for the week ending `weekEnding` (default now),
 * covering the prior 7 days of collected checkpoints, the rolling baselines, and a per-brand
 * weekly summary with by-dimension aggregates + recommendations. Writes the report under
 * $CONTENT_HOME/analytics/ (redacted at write, §13.3) unless `opts.write === false`.
 *
 * @param {object} [opts]
 * @param {object}   [opts.env]         env for paths resolution (default process.env).
 * @param {number}   [opts.now]         injected clock (ms).
 * @param {number}   [opts.weekEnding]  end-of-week timestamp (ms); default opts.now / now.
 * @param {Array}    [opts.records]     raw checkpoint records; default reads the analytics dir.
 * @param {string}   [opts.brand]       single-brand report; default all brands in the corpus.
 * @param {boolean}  [opts.write]       write the report file (default true).
 * @returns {{report:object, written:(string|null)}}  report is schema-conformant.
 */
function buildWeeklyReport(opts = {}) {
  const env = opts.env || process.env;
  const now = typeof opts.now === 'number' ? opts.now : Date.now();
  const weekEnding = typeof opts.weekEnding === 'number' ? opts.weekEnding : now;
  const weekStart = weekEnding - WEEK_MS;
  const allRecords = opts.records || readRawCorpus(env);

  // Window to the week; if a single brand is requested, filter to it.
  const inWeek = allRecords.filter((r) => {
    const t = Date.parse(r.captured_at);
    if (!Number.isFinite(t) || t <= weekStart || t > weekEnding) return false;
    return opts.brand == null || r.brand === opts.brand;
  });

  // Baselines + outliers over the (full) corpus, with the week's records as the new set.
  const base = computeBaselines({ env, records: allRecords, newRecords: inWeek, now });
  const latest = latestPerContent(inWeek);

  const aggregates = [];
  for (const dim of AGGREGATE_DIMENSIONS) {
    aggregates.push(...aggregateByDimension(latest, dim));
  }

  const report = {
    checkpoints: inWeek.map((r) => stripToCheckpointSchema(r)),
    baselines: base.baselines,
    weekly_summary: {
      period: { start: isoDate(weekStart), end: isoDate(weekEnding) },
      ...(opts.brand != null ? { brand: opts.brand } : {}),
      aggregates,
      recommendations: buildRecommendations(latest, base.outliers),
    },
  };

  let written = null;
  if (opts.write !== false) {
    written = writeReport(report, weekEnding, opts.brand, env);
  }
  return { report, written };
}

/** Keep only the §7.9 checkpoint fields the schema declares (drop any stray instance fields). */
function stripToCheckpointSchema(r) {
  const out = {
    content_id: r.content_id,
    platform: r.platform,
    captured_at: r.captured_at,
    checkpoint: r.checkpoint,
    metrics: r.metrics || {},
  };
  if (r.brand != null) out.brand = r.brand;
  if (r.external_post_ref != null) out.external_post_ref = r.external_post_ref;
  if (r.partial === true) out.partial = true;
  return out;
}

/** Write the report to $CONTENT_HOME/analytics/performance-report-<week>[-brand].json. */
function writeReport(report, weekEnding, brand, env = process.env) {
  const dir = paths.analyticsDir(env);
  fs.mkdirSync(dir, { recursive: true });
  const stem = brand
    ? `performance-report-${isoDate(weekEnding)}-${String(brand).replace(/[^A-Za-z0-9_.-]+/gu, '-')}`
    : `performance-report-${isoDate(weekEnding)}`;
  const outPath = path.join(dir, `${stem}.json`);
  const tmp = `${outPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(redact(report), null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, outPath);
  return outPath;
}

module.exports = {
  AGGREGATE_DIMENSIONS,
  buildWeeklyReport,
  // internals for tests
  latestPerContent,
  aggregateByDimension,
  buildRecommendations,
  stripToCheckpointSchema,
  writeReport,
};
