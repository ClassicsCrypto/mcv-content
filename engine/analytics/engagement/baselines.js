'use strict';

/**
 * engine/analytics/engagement/baselines.js  [A adapted]
 *
 * Rolling per-brand baselines + outlier detection over the raw checkpoint corpus the
 * collector writes (release-spec §7.9 "rolling baselines"; §8.9 v1 scope). Adapted from the
 * production `recomputeBaselines` / `checkOutliers` (the rolling last-N window + the
 * >2x/<0.5x outlier bands), de-localized: the production grouping key embedded an `account`
 * literal — here it is the public `brand` field (§7.4 / DD-10), and the emitted baseline rows
 * conform to the §7.9 performance-report `baselines[]` shape (`{dimension, key, window,
 * metrics}`) rather than the production ad-hoc `account|platform|checkpoint` map.
 *
 * v1 scope (honest, §8.9): baselines are an aggregation over LOCALLY-collected checkpoints.
 * Outliers are flagged as report inputs (and feed `recommendations[]` → proposed learning
 * records); nothing here mutates rules or config — DD-6's human-only mutability stands.
 *
 * Pure of brand specifics (§1 per-path rule): no account enums, no hardcoded paths (the corpus
 * is supplied by the caller or read via paths.js), no production codename.
 */

const fs = require('fs');
const path = require('path');

const paths = require('../../shared/paths.js');

/** Rolling window: last N checkpoint records per (brand, platform, checkpoint) group. */
const DEFAULT_BASELINE_WINDOW = 20;
/** Minimum sample before a group can flag outliers (production guard: <3 is "not enough"). */
const MIN_OUTLIER_SAMPLE = 3;
/** Outlier bands (§7.9 / production): >=2x baseline = high performer; <=0.5x = underperformer. */
const HIGH_RATIO = 2.0;
const LOW_RATIO = 0.5;
/** The metric the outlier check ranks on, in fallback order. */
const PRIMARY_METRIC_ORDER = Object.freeze(['likes', 'impressions', 'views']);
/** Metric keys baselines summarize (provider-extra keys are ignored for baseline math). */
const BASELINE_METRIC_KEYS = Object.freeze(['likes', 'comments', 'shares', 'views', 'impressions']);
/** ISO-8601 duration label for the rolling window (last-N is count-based; this is descriptive). */
const WINDOW_LABEL = 'last_20';

/** mean rounded to an integer; median (lower-middle for even counts, matching production). */
function summarize(values) {
  if (values.length === 0) return null;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const sorted = [...values].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  return { mean: Math.round(mean), median };
}

/** Read every raw-*.json checkpoint record from $CONTENT_HOME/analytics/ (best-effort). */
function readRawCorpus(env = process.env) {
  let dir;
  try {
    dir = paths.analyticsDir(env);
  } catch {
    return [];
  }
  let files;
  try {
    files = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const records = [];
  for (const f of files) {
    if (!f.startsWith('raw-') || !f.endsWith('.json')) continue;
    try {
      records.push(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
    } catch {
      // tolerate a torn/partial record file; it simply doesn't contribute
    }
  }
  return records;
}

/** Group key for a baseline: brand × platform × checkpoint (brand replaces the production account). */
function groupKey(record) {
  return `${record.brand || ''}|${record.platform || ''}|${record.checkpoint || ''}`;
}

/**
 * computeBaselines — the public entry point (plan P3-ANALYTICS export).
 *
 * Computes rolling baselines (mean + median per metric over the last N records per
 * brand×platform×checkpoint group) and flags outliers among a set of new records.
 *
 * @param {object} [opts]
 * @param {object}   [opts.env]         env for paths resolution (default process.env).
 * @param {Array}    [opts.records]     raw checkpoint records; default reads the analytics dir.
 * @param {Array}    [opts.newRecords]  records to outlier-check against the baselines (default []).
 * @param {number}   [opts.window]      rolling window size (default DEFAULT_BASELINE_WINDOW).
 * @returns {{
 *   generated_at:string,
 *   window:string,
 *   groups:Object.<string,{brand,platform,checkpoint,sample_size,metrics}>,
 *   baselines:Array<{dimension:'overall',key:string,window:string,metrics:Object}>,
 *   outliers:Array<{content_id,brand,platform,checkpoint,outlier,ratio,baseline,value}>
 * }}
 */
function computeBaselines(opts = {}) {
  const env = opts.env || process.env;
  const window = opts.window || DEFAULT_BASELINE_WINDOW;
  const records = opts.records || readRawCorpus(env);

  // Group, sort newest-first by captured_at, keep the last N (production rolling-window).
  const groups = {};
  for (const r of records) {
    const key = groupKey(r);
    (groups[key] = groups[key] || []).push(r);
  }

  const groupSummaries = {};
  const baselines = [];
  for (const [key, arr] of Object.entries(groups)) {
    arr.sort((a, b) => String(b.captured_at || '').localeCompare(String(a.captured_at || '')));
    const slice = arr.slice(0, window);
    const [brand, platform, checkpoint] = key.split('|');
    const metrics = {};
    for (const mk of BASELINE_METRIC_KEYS) {
      const vals = slice.map((w) => w.metrics && w.metrics[mk]).filter((v) => typeof v === 'number');
      const s = summarize(vals);
      if (s) {
        metrics[`${mk}_mean`] = s.mean;
        metrics[`${mk}_median`] = s.median;
      }
    }
    groupSummaries[key] = {
      brand, platform, checkpoint, sample_size: slice.length, metrics,
    };
    // §7.9 baselines[] row: one per group, dimension 'overall' (the group is the key).
    baselines.push({
      dimension: 'overall', key, window: WINDOW_LABEL, metrics,
    });
  }

  const outliers = checkOutliers(opts.newRecords || [], groupSummaries);
  return {
    generated_at: new Date(typeof opts.now === 'number' ? opts.now : Date.now()).toISOString(),
    window: WINDOW_LABEL,
    groups: groupSummaries,
    baselines,
    outliers,
  };
}

/**
 * Flag records whose primary metric is >=2x (HIGH_PERFORMER) or <=0.5x (UNDERPERFORMER) the
 * group's baseline median. Groups with fewer than MIN_OUTLIER_SAMPLE records are skipped
 * (not enough history to judge). Pure — returns flags, writes nothing (report-input only).
 *
 * @param {Array}  newRecords      checkpoint records to evaluate.
 * @param {Object} groupSummaries  output of computeBaselines().groups.
 * @returns {Array<object>} outlier flags.
 */
function checkOutliers(newRecords, groupSummaries) {
  const flags = [];
  for (const r of newRecords) {
    const key = groupKey(r);
    const base = groupSummaries[key];
    if (!base || base.sample_size < MIN_OUTLIER_SAMPLE) continue;
    const primary = pickPrimary(r.metrics);
    if (primary == null) continue;
    const baselinePrimary = pickBaselineMedian(base.metrics);
    if (baselinePrimary == null || baselinePrimary === 0) continue;
    const ratio = primary.value / baselinePrimary;
    if (ratio >= HIGH_RATIO) {
      flags.push(outlierFlag(r, 'HIGH_PERFORMER', ratio, baselinePrimary, primary));
    } else if (ratio <= LOW_RATIO) {
      flags.push(outlierFlag(r, 'UNDERPERFORMER', ratio, baselinePrimary, primary));
    }
  }
  return flags;
}

function pickPrimary(metrics = {}) {
  for (const mk of PRIMARY_METRIC_ORDER) {
    if (typeof metrics[mk] === 'number') return { metric: mk, value: metrics[mk] };
  }
  return null;
}

function pickBaselineMedian(metrics = {}) {
  for (const mk of PRIMARY_METRIC_ORDER) {
    if (typeof metrics[`${mk}_median`] === 'number') return metrics[`${mk}_median`];
  }
  return null;
}

function outlierFlag(record, kind, ratio, baseline, primary) {
  return {
    content_id: record.content_id,
    brand: record.brand,
    platform: record.platform,
    checkpoint: record.checkpoint,
    outlier: kind,
    ratio: Number(ratio.toFixed(2)),
    metric: primary.metric,
    value: primary.value,
    baseline,
  };
}

module.exports = {
  DEFAULT_BASELINE_WINDOW,
  MIN_OUTLIER_SAMPLE,
  HIGH_RATIO,
  LOW_RATIO,
  WINDOW_LABEL,
  computeBaselines,
  checkOutliers,
  // internals for tests
  readRawCorpus,
  groupKey,
  summarize,
};
