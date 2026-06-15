'use strict';

/*
 * fixtures/self-improve-acme/_generate.js  [SI-FIXTURES]
 *
 * Maintainer-only GENERATOR for the synthetic Acme Cosmos performance corpus this fixture ships
 * (release-spec roadmap #3 governed self-improvement; §7.9 performance report; §8.9 v1 analytics;
 * DD-6). Run once by a maintainer to (re)materialize analytics/raw-*.json deterministically;
 * NOT part of the test path (tests read the committed JSON). Regenerate-never-redact (§0.3 r6):
 * every value here is invented for this repo — fictional brand "Acme Cosmos", invented content ids.
 *
 * The corpus is shaped so the engine's deterministic analytics (engine/analytics/engagement
 * baselines + performance-report) produce, hand-verifiably:
 *   - a per-content-type / per-archetype group with ENOUGH samples (n >= evidence.min_sample_size)
 *     AND a clear lift over baseline => crosses the evidence threshold (basis of learning-record (a),
 *     the MACHINE-ALLOWED calendar-weighting bump that should auto-apply -> canary);
 *   - a group with TOO FEW samples / too small an effect => MISSES the threshold (basis of
 *     learning-record (d), which must stay PROPOSED / human-applied — never act on thin evidence).
 *
 * Usage:  node fixtures/self-improve-acme/_generate.js
 */

const fs = require('node:fs');
const path = require('node:path');

const OUT = path.join(__dirname, 'analytics');
const BRAND = 'acme-cosmos';
const PLATFORM = 'twitter';

// Future-dated week so a fixture record is never mistaken for a real observation and the
// week-window math in performance-report.js is deterministic in tests.
const WEEK = [
  '2099-04-01', '2099-04-01', '2099-04-02', '2099-04-02', '2099-04-03', '2099-04-03',
  '2099-04-04', '2099-04-04', '2099-04-05', '2099-04-05', '2099-04-06', '2099-04-06',
  '2099-04-07',
];

/**
 * One content item -> one 7d checkpoint record (latest-per-content uses 7d for ranking; baselines
 * aggregate the brand×platform×checkpoint group). `type`, `format`, `theme`, `hook` are the §7.9
 * aggregate dimensions; we also carry `archetype` + `content_type` as instance fields the analyst
 * seat reads (the performance-report strips to the schema; baselines ignore extra keys).
 */
function rec(id, dayIdx, contentType, archetype, likes) {
  const capturedAt = `${WEEK[dayIdx % WEEK.length]}T12:00:00.000Z`;
  return {
    content_id: id,
    brand: BRAND,
    platform: PLATFORM,
    external_post_ref: `acme-${id}`,
    captured_at: capturedAt,
    checkpoint: '7d',
    // §7.9 aggregate dimensions:
    type: contentType,
    format: contentType,
    theme: 'sky-events',
    hook: archetype,
    // instance fields the deterministic proposer / analyst seat group on (stripped by the report):
    archetype,
    content_type: contentType,
    metrics: {
      likes,
      comments: Math.round(likes / 12),
      shares: Math.round(likes / 20),
      views: likes * 22,
      impressions: likes * 30,
    },
  };
}

const records = [];

// --- BASELINE-SETTER population: a broad "thread" content-type baseline around ~100 likes. ----
// 16 thread items establish the rolling baseline (median ~100) the lift is measured against.
const baselineLikes = [
  88, 92, 95, 97, 99, 100, 100, 101, 103, 104, 96, 98, 102, 105, 90, 94,
];
baselineLikes.forEach((lk, i) => {
  records.push(rec(`thread-base-${String(i + 1).padStart(2, '0')}`, i, 'thread', 'how-to-explainer', lk));
});

// --- HIGH-EVIDENCE group: content_type "sky-event-alert" / archetype "timely-observation". ----
// 14 items (>= evidence.min_sample_size default 12), all clearly above the ~100 baseline median
// (median here ~215 => ~2.15x baseline => effect ~1.15, well over min_effect_size 0.2), tight
// spread => high direction-agreement (confidence). Crosses the threshold -> auto-applicable.
const highEvidenceLikes = [
  205, 210, 212, 214, 215, 216, 218, 220, 222, 208, 211, 217, 219, 221,
];
highEvidenceLikes.forEach((lk, i) => {
  records.push(rec(`alert-high-${String(i + 1).padStart(2, '0')}`, i, 'sky-event-alert', 'timely-observation', lk));
});

// --- LOW-EVIDENCE group: content_type "longform-essay" / archetype "deep-dive". --------------
// Only 4 items (< min_sample_size 12) AND a small/noisy effect (some above, some below baseline;
// median barely above ~100 => effect < min_effect_size). MISSES the threshold on BOTH sample size
// and effect size -> must stay PROPOSED (human-applied). Never act on thin evidence (DD-6 (3)).
const lowEvidenceLikes = [108, 96, 120, 90];
lowEvidenceLikes.forEach((lk, i) => {
  records.push(rec(`essay-low-${String(i + 1).padStart(2, '0')}`, i, 'longform-essay', 'deep-dive', lk));
});

fs.mkdirSync(OUT, { recursive: true });
for (const r of records) {
  const file = path.join(OUT, `raw-${r.content_id}-7d.json`);
  fs.writeFileSync(file, `${JSON.stringify(r, null, 2)}\n`, 'utf8');
}
console.log(`wrote ${records.length} raw checkpoint records to ${OUT}`);
