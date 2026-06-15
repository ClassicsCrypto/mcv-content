'use strict';

/**
 * engine/brand-dna/analyze.js  [A adapted — production seed: research/x-comparator-corpus
 *   corpus-summary / archetype-engagement scoring, regenerated brand-clean]
 *
 * The DETERMINISTIC corpus analyzer for the Brand-DNA / competitor-ingestion flow
 * (original-design-spec 1.1 Brand DNA Generation + 1.2 Context & Competitor Analysis): "analyze
 * the pulled content to establish a baseline identity, tone, and voice" and "scan both the user's
 * and comparators'/competitors' content … capture idea seeds, strong argument patterns, hooks".
 *
 * NO LLM, NO network — AUDITABLE STATS only (BRAND-DNA FEATURE LAW / RD-2: the engine never calls
 * chain/analysis LLMs directly; the deterministic analyzer is the engine seat, the DNA-prose
 * SYNTHESIS is a HOST seat the runtime wires). Pure functions over an array of
 * schemas/inputs/corpus-item.schema.json items; reproducible (no Date.now / no randomness / no I/O).
 *
 * SIGNALS COMPUTED (release-spec brand-DNA batch contract):
 *   - posting cadence            — counts + gaps by day-of-week / hour-of-day / week, derived from
 *                                  captured_at (the only timestamp the schema guarantees).
 *   - length distribution        — char-length histogram + quantiles (URL-stripped + raw).
 *   - format mix                 — share by format (text-only / has-media / link / thread / reply),
 *                                  derived structurally when an explicit `format` field is absent.
 *   - top hooks / openers        — leading n-gram frequency over the first words of each item.
 *   - recurring themes           — term + n-gram frequency across the corpus (stop-worded).
 *   - engagement-weighted        — when items carry metrics: which lengths / formats / hooks /
 *                                  themes over-index vs the corpus baseline (median + lift).
 *
 * OWN vs COMPETITOR (BRAND-DNA LAW): the analyzer reports an OWN slice and a COMPETITOR slice
 * separately (competitor = Zone-U third-party). Competitor content is analyzed for PATTERNS only;
 * the analyzer surfaces frequencies/structure, never copied competitor copy. Idea-seed snippets (a
 * verbatim-bearing field) live in engine/brand-dna/archetypes.js and are own-content-only there.
 *
 * Tier-3 cleanliness (§0.3 r6 / RD-3): no IDs/handles/absolute paths/brand strings/persona
 * codenames; no $CONTENT_HOME path is constructed here (the CLI orchestration reads the corpus and
 * hands this module a plain array — like the §12.5 vision seam, the read is the caller's job).
 */

const {
  collapseWhitespace, stripUrls, hasMedia, isOwn, metricsOf, median, mean, round2,
} = require('./corpus-util');
const archetypesMod = require('./archetypes');

// ---------------------------------------------------------------------------
// Tokenization + stop words (brand-neutral; deterministic)
// ---------------------------------------------------------------------------

/** Brand-neutral English stop words for theme extraction. No brand/instance vocabulary. */
const STOP_WORDS = new Set([
  'a', 'an', 'and', 'the', 'of', 'to', 'in', 'on', 'for', 'with', 'at', 'by', 'from', 'up', 'out',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am', 'do', 'does', 'did', 'have', 'has', 'had',
  'i', 'you', 'he', 'she', 'it', 'we', 'they', 'me', 'him', 'her', 'us', 'them', 'my', 'your', 'our',
  'their', 'his', 'its', 'this', 'that', 'these', 'those', 'as', 'so', 'if', 'or', 'but', 'not', 'no',
  'yes', 'all', 'any', 'can', 'will', 'just', 'now', 'then', 'than', 'too', 'very', 'get', 'got',
  'one', 'two', 'who', 'what', 'when', 'where', 'why', 'how', 'which', 'about', 'into', 'over', 'more',
  'most', 'some', 'such', 'only', 'own', 'same', 'other', 'there', 'here', 'also', 'like', 'via', 're',
  's', 't', 'm', 'd', 'll', 'don', 'im', 'us', 'go', 'going', 'gonna', 'wanna', 'lets', 'let',
]);

/** Lowercase word tokens (letters/digits/apostrophes), URL-stripped, length >= 2. */
function tokenize(text) {
  return stripUrls(String(text == null ? '' : text))
    .toLowerCase()
    .replace(/[^a-z0-9'\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 2);
}

/** Content tokens = tokens minus stop words and pure numbers. */
function contentTokens(text) {
  return tokenize(text).filter((w) => !STOP_WORDS.has(w) && !/^\d+$/.test(w));
}

/** The first N words of an item (URL-stripped, lowercased) — the opener for hook n-grams. */
function leadingWords(text, n) {
  return tokenize(text).slice(0, n);
}

// ---------------------------------------------------------------------------
// Frequency helpers — n-grams, top-K (deterministic tie-break by term)
// ---------------------------------------------------------------------------

/** Build n-grams (joined by space) from a token list. */
function ngrams(tokens, n) {
  const out = [];
  for (let i = 0; i + n <= tokens.length; i += 1) out.push(tokens.slice(i, i + n).join(' '));
  return out;
}

/** Tally a list of strings → Map<term, count>. */
function tally(list) {
  const m = new Map();
  for (const s of list) m.set(s, (m.get(s) || 0) + 1);
  return m;
}

/**
 * Top-K of a tally, as [{ term, count, share }]. Deterministic: sorted by count desc, then term
 * asc (so equal counts are stably ordered — reproducibility requirement). `total` scales `share`.
 */
function topK(tallyMap, k, total) {
  const denom = total || Array.from(tallyMap.values()).reduce((s, c) => s + c, 0) || 1;
  return Array.from(tallyMap.entries())
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, k)
    .map(([term, count]) => ({ term, count, share: round2(count / denom) }));
}

// ---------------------------------------------------------------------------
// Per-item structural derivation (format, length, opener, hour/day)
// ---------------------------------------------------------------------------

/**
 * Derive the structural FORMAT of an item. Prefers an explicit `format` field when present
 * (real exports carry it); otherwise classifies structurally. Returns one of:
 *   'thread' | 'reply' | 'media' | 'link' | 'text'.
 */
function deriveFormat(item) {
  if (item && typeof item.format === 'string' && item.format.trim()) return item.format.trim().toLowerCase();
  const text = (item && item.text) || '';
  const noUrl = stripUrls(text).trim();
  if (item && item.is_quote_tweet === true) return 'reply';
  if (/^\s*(1\/|1\.|🧵)/u.test(text) || /\bthread\s*🧵/u.test(text)) return 'thread';
  if (hasMedia(item)) return 'media';
  if (noUrl.length < text.length - 5 && noUrl.length <= 40) return 'link'; // mostly a link
  return 'text';
}

/** UTC day-of-week index (0=Sun..6=Sat) of captured_at, or null when unparseable. */
function dowOf(capturedAt) {
  const t = Date.parse(capturedAt || '');
  if (!Number.isFinite(t)) return null;
  return new Date(t).getUTCDay();
}

/** UTC hour (0..23) of captured_at, or null when unparseable. */
function hourOf(capturedAt) {
  const t = Date.parse(capturedAt || '');
  if (!Number.isFinite(t)) return null;
  return new Date(t).getUTCHours();
}

/** ISO date (YYYY-MM-DD, UTC) of captured_at, or null. */
function isoDayOf(capturedAt) {
  const t = Date.parse(capturedAt || '');
  if (!Number.isFinite(t)) return null;
  return new Date(t).toISOString().slice(0, 10);
}

const DOW_NAMES = Object.freeze(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']);

// ---------------------------------------------------------------------------
// Quantiles (deterministic, no interpolation surprises)
// ---------------------------------------------------------------------------

/** Quantile (0..1) of a numeric array via nearest-rank on a sorted copy. */
function quantile(sortedAsc, q) {
  if (!sortedAsc.length) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.round(q * (sortedAsc.length - 1))));
  return sortedAsc[idx];
}

// ---------------------------------------------------------------------------
// The per-slice analyzer (own OR competitor OR all)
// ---------------------------------------------------------------------------

const DEFAULTS = Object.freeze({
  topHooks: 15,
  topThemes: 25,
  hookWords: 3,     // leading-tri-gram openers (production used first-line openers)
  themeNgrams: [1, 2], // unigrams + bigrams for recurring themes
  minEngagementCell: 3,
});

/**
 * Analyze ONE slice of corpus items (already filtered to own / competitor / all).
 * Returns the deterministic signal block for that slice.
 */
function analyzeSlice(items, opts) {
  const lengths = [];      // URL-stripped char length per item
  const rawLengths = [];   // raw char length per item
  const dowCounts = new Array(7).fill(0);
  const hourCounts = new Array(24).fill(0);
  const dayTally = new Map();          // ISO day -> count (for cadence/posts-per-active-day)
  const formatTally = new Map();
  const hookTally = new Map();         // leading n-gram -> count
  const themeUni = new Map();
  const themeBi = new Map();
  let timed = 0;                       // items with a parseable timestamp

  // engagement: collect metric rows tagged by their length-bucket / format / opener so we can
  // compute which patterns over-index. The corpus baseline is the median across all metric rows.
  const metricRows = [];               // { m, len, format, opener, themes[] }

  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const text = typeof item.text === 'string' ? item.text : '';
    const noUrl = collapseWhitespace(stripUrls(text));
    lengths.push(noUrl.length);
    rawLengths.push(collapseWhitespace(text).length);

    const dow = dowOf(item.captured_at);
    const hour = hourOf(item.captured_at);
    const day = isoDayOf(item.captured_at);
    if (dow != null) { dowCounts[dow] += 1; }
    if (hour != null) { hourCounts[hour] += 1; }
    if (day != null) { dayTally.set(day, (dayTally.get(day) || 0) + 1); timed += 1; }

    const format = deriveFormat(item);
    formatTally.set(format, (formatTally.get(format) || 0) + 1);

    const lead = leadingWords(text, opts.hookWords);
    const opener = lead.join(' ');
    if (opener) hookTally.set(opener, (hookTally.get(opener) || 0) + 1);

    const ct = contentTokens(text);
    for (const g of ngrams(ct, 1)) themeUni.set(g, (themeUni.get(g) || 0) + 1);
    for (const g of ngrams(ct, 2)) themeBi.set(g, (themeBi.get(g) || 0) + 1);

    const m = metricsOf(item);
    if (m) {
      metricRows.push({
        m,
        len: noUrl.length,
        format,
        opener,
        themes: ct.slice(0, 12),
      });
    }
  }

  const n = items.length;
  const sortedLen = [...lengths].sort((a, b) => a - b);

  // Cadence: active days, posts/active-day, day-of-week + hour distribution.
  const activeDays = dayTally.size;
  const perActiveDay = activeDays ? round2(timed / activeDays) : 0;
  const daySpan = computeDaySpan(dayTally);

  return {
    count: n,
    timed,
    cadence: {
      active_days: activeDays,
      posts_per_active_day: perActiveDay,
      day_span_days: daySpan,
      posts_per_day_overall: daySpan ? round2(timed / daySpan) : null,
      by_day_of_week: DOW_NAMES.map((name, i) => ({ day: name, count: dowCounts[i] })),
      by_hour_utc: hourCounts.map((count, hour) => ({ hour, count })),
    },
    length: {
      n: lengths.length,
      min: sortedLen[0] || 0,
      max: sortedLen[sortedLen.length - 1] || 0,
      mean: round2(mean(lengths)),
      median: median(lengths),
      p25: quantile(sortedLen, 0.25),
      p75: quantile(sortedLen, 0.75),
      p90: quantile(sortedLen, 0.90),
      raw_mean: round2(mean(rawLengths)),
      buckets: lengthBuckets(lengths),
    },
    format_mix: topK(formatTally, 20, n),
    top_hooks: topK(hookTally, opts.topHooks, n),
    themes: {
      unigrams: topK(themeUni, opts.topThemes, sumCounts(themeUni)),
      bigrams: topK(themeBi, opts.topThemes, sumCounts(themeBi)),
    },
    engagement: analyzeEngagement(metricRows, opts),
  };
}

/** Days between the earliest and latest active day (inclusive), or 0/1 for trivial corpora. */
function computeDaySpan(dayTally) {
  const days = Array.from(dayTally.keys()).map((d) => Date.parse(d)).filter(Number.isFinite);
  if (!days.length) return 0;
  const min = Math.min(...days);
  const max = Math.max(...days);
  return Math.max(1, Math.round((max - min) / 86400000) + 1);
}

/** Fixed brand-neutral length buckets (chars), as [{ bucket, count, share }]. */
function lengthBuckets(lengths) {
  const edges = [0, 50, 100, 150, 200, 280, Infinity];
  const labels = ['0-49', '50-99', '100-149', '150-199', '200-279', '280+'];
  const counts = new Array(labels.length).fill(0);
  for (const len of lengths) {
    for (let i = 0; i < labels.length; i += 1) {
      if (len >= edges[i] && len < edges[i + 1]) { counts[i] += 1; break; }
    }
  }
  const total = lengths.length || 1;
  return labels.map((bucket, i) => ({ bucket, count: counts[i], share: round2(counts[i] / total) }));
}

function sumCounts(map) {
  let s = 0;
  for (const v of map.values()) s += v;
  return s;
}

// ---------------------------------------------------------------------------
// Engagement-weighted patterns (ported from production lift scoring)
// ---------------------------------------------------------------------------

const METRIC_KEYS = archetypesMod.METRIC_KEYS;

/**
 * Engagement-weighted patterns: for each dimension (length-bucket, format, opener/hook), compute
 * the median per metric within the group and its LIFT vs the corpus baseline (group-median /
 * corpus-median). Lift > 1 over-indexes. Groups below minEngagementCell are suppressed (a thin
 * group never yields a confident number — production used ≥3).
 */
function analyzeEngagement(metricRows, opts) {
  if (!metricRows.length) return { available: false, n: 0 };
  const minCell = opts.minEngagementCell;

  const baseline = {};
  for (const k of METRIC_KEYS) baseline[k] = median(metricRows.map((r) => r.m[k]));
  baseline.n = metricRows.length;

  // Group helper: groups[key] = rows; emits sorted lift table (by reply lift, the dominant signal,
  // matching the production score-archetype-engagement default sort).
  const liftTable = (keyFn) => {
    const groups = new Map();
    for (const r of metricRows) {
      const key = keyFn(r);
      if (key == null || key === '') continue;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    }
    const rows = [];
    for (const [key, list] of groups) {
      if (list.length < minCell) continue;
      const medianM = {};
      const lift = {};
      for (const k of METRIC_KEYS) {
        medianM[k] = median(list.map((r) => r.m[k]));
        lift[k] = baseline[k] ? round2(medianM[k] / baseline[k]) : null;
      }
      rows.push({ key: String(key), n: list.length, median: medianM, lift });
    }
    // Deterministic order: by reply lift desc, then n desc, then key asc.
    return rows.sort((a, b) =>
      (b.lift.replies || 0) - (a.lift.replies || 0)
      || b.n - a.n
      || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  };

  // Length is continuous → bucket it the same way length.buckets does.
  const lenBucket = (len) => {
    const edges = [0, 50, 100, 150, 200, 280, Infinity];
    const labels = ['0-49', '50-99', '100-149', '150-199', '200-279', '280+'];
    for (let i = 0; i < labels.length; i += 1) if (len >= edges[i] && len < edges[i + 1]) return labels[i];
    return '280+';
  };

  return {
    available: true,
    n: metricRows.length,
    baseline,
    by_length_bucket: liftTable((r) => lenBucket(r.len)),
    by_format: liftTable((r) => r.format),
    by_hook: liftTable((r) => r.opener).slice(0, opts.topHooks),
  };
}

// ---------------------------------------------------------------------------
// The analyzer — the exported entry point
// ---------------------------------------------------------------------------

/**
 * Analyze a brand corpus (own + competitor) into deterministic, auditable signals
 * (original-design-spec 1.1/1.2). Pure + reproducible: same corpus => byte-identical output.
 *
 * @param {Array<object>} corpus  corpus-item.schema.json items (own + competitor mixed).
 * @param {object} [opts]
 * @param {(item:object)=>boolean} [opts.ownPredicate]  own vs competitor (default: trust_class
 *   === 'operator-curated' is own — see corpus-util.isOwn).
 * @param {number} [opts.topHooks]          top-K openers to surface (default 15).
 * @param {number} [opts.topThemes]         top-K theme terms to surface (default 25).
 * @param {number} [opts.hookWords]         leading-word count for opener n-grams (default 3).
 * @param {number} [opts.minEngagementCell] min group size for engagement lift (default 3).
 * @returns {{ generated_with:'deterministic-no-llm', totals:object, all:object, own:object,
 *   competitor:object, archetypes:object }}  `all/own/competitor` each carry the per-slice signal
 *   block; `archetypes` is the categorizeArchetypes() catalog (own+competitor bucketed).
 */
function analyzeCorpus(corpus, opts = {}) {
  const items = Array.isArray(corpus) ? corpus : [];
  const ownPredicate = typeof opts.ownPredicate === 'function' ? opts.ownPredicate : isOwn;
  const cfg = {
    topHooks: Number(opts.topHooks) > 0 ? Number(opts.topHooks) : DEFAULTS.topHooks,
    topThemes: Number(opts.topThemes) > 0 ? Number(opts.topThemes) : DEFAULTS.topThemes,
    hookWords: Number(opts.hookWords) > 0 ? Number(opts.hookWords) : DEFAULTS.hookWords,
    minEngagementCell: Number.isFinite(opts.minEngagementCell) && opts.minEngagementCell >= 0
      ? Number(opts.minEngagementCell) : DEFAULTS.minEngagementCell,
  };

  const ownItems = items.filter((it) => it && typeof it === 'object' && ownPredicate(it));
  const competitorItems = items.filter((it) => it && typeof it === 'object' && !ownPredicate(it));

  return {
    generated_with: 'deterministic-no-llm', // BRAND-DNA LAW: auditable stats, never an LLM call
    totals: {
      items: items.length,
      own: ownItems.length,
      competitor: competitorItems.length,
      with_metrics: items.filter((it) => metricsOf(it)).length,
    },
    all: analyzeSlice(items, cfg),
    own: analyzeSlice(ownItems, cfg),
    competitor: analyzeSlice(competitorItems, cfg),
    // The archetype catalog is part of the analysis surface (spec §1.2). Competitor copy is never
    // embedded (idea seeds are own-only inside categorizeArchetypes).
    archetypes: archetypesMod.categorizeArchetypes(items, {
      ownPredicate,
      minEngagementCell: cfg.minEngagementCell,
    }),
  };
}

module.exports = {
  analyzeCorpus,
  // primitives exported for analyze-side reuse + tests (pure, deterministic)
  analyzeSlice,
  tokenize,
  contentTokens,
  leadingWords,
  ngrams,
  tally,
  topK,
  deriveFormat,
  lengthBuckets,
  quantile,
  STOP_WORDS,
  DEFAULTS,
};
