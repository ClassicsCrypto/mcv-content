'use strict';

/**
 * engine/sources/verify-output.js  [N net-new — ingest output verification]
 *
 * Verifies the OUTPUT of a corpus ingest (the Apify/BYO pulls especially): did the run produce data,
 * and is every written item FILTERED TO ONLY THE REQUIRED VARIABLES (the corpus-item.schema.json
 * field set)? This is the "make sure it ran properly and the output is properly filtered" gate — a
 * read-only check over an `ingestCorpus` result, producing a structured report the CLI surfaces and
 * a hard ok/fail the operator (or a scheduler) can branch on.
 *
 * Why this exists even though the source layer already validates: ingestCorpus normalizes + validates
 * each item against the schema and drops malformed ones, so the WRITTEN corpus is already schema-clean
 * — but that success is silent. A scraper that returns nothing (wrong actor input, an auth problem
 * surfaced as an empty dataset, a handle that yielded zero rows) would otherwise look like a clean
 * "0 items" success. This layer makes run health + the field-filtering guarantee EXPLICIT and
 * fail-fast: an expected-but-empty pull is a verification failure, not a silent no-op.
 *
 * The allowed key set is the corpus-item.schema.json property set (the schema is the source of truth;
 * this mirrors it so the check is dependency-free — the CI strict gate is scripts/validate-schemas.js).
 */

/** The corpus-item.schema.json top-level property set — the "required variables" an item may carry. */
const ALLOWED_ITEM_KEYS = Object.freeze(new Set([
  'source', 'captured_at', 'author', 'text', 'url', 'media_refs', 'metrics', 'trust_class', 'attestation', 'retention_class',
]));
const REQUIRED_ITEM_KEYS = Object.freeze(['source', 'captured_at', 'text', 'trust_class', 'retention_class']);

/** Allowed metric sub-keys (schema names; the schema additionally allows additive numeric keys). */
const KNOWN_METRIC_KEYS = Object.freeze(new Set(['likes', 'replies', 'reposts', 'bookmarks', 'impressions']));

/**
 * Check one normalized item against the corpus-item field contract: only allowed keys, all required
 * keys present, metrics (if any) are an object of non-negative numbers. Returns a list of problems.
 */
function checkItemFields(item) {
  const problems = [];
  if (!item || typeof item !== 'object') return ['item is not an object'];
  for (const k of Object.keys(item)) {
    if (!ALLOWED_ITEM_KEYS.has(k)) problems.push(`extra key "${k}" (not a corpus-item variable)`);
  }
  for (const k of REQUIRED_ITEM_KEYS) {
    if (!(k in item)) problems.push(`missing required key "${k}"`);
  }
  if ('metrics' in item) {
    const m = item.metrics;
    if (!m || typeof m !== 'object' || Array.isArray(m)) {
      problems.push('metrics is not an object');
    } else {
      for (const [mk, mv] of Object.entries(m)) {
        if (typeof mv !== 'number' || !Number.isFinite(mv) || mv < 0) problems.push(`metrics.${mk} is not a non-negative number`);
      }
    }
  }
  return problems;
}

/**
 * Verify an ingest result. Read-only; never writes or spends.
 *
 * @param {object} result  the return of source.ingestCorpus / ingestRawItems:
 *                         { items:object[], written?:string[], invalid?:Array, by_class?:object }.
 * @param {object} [opts]
 * @param {object} [opts.requested]  { account?:string, competitors?:string[] } — what was asked for,
 *                                   so "expected data but got none" can be a hard failure.
 * @param {boolean} [opts.expectItems]  override: require >=1 item regardless of requested (default:
 *                                   true when a requested account/competitor was supplied).
 * @returns {{
 *   ok:boolean,
 *   ran:boolean,
 *   counts:{ normalized:number, written:number, invalid:number, own:number, competitor:number },
 *   field_check:{ ok:boolean, checked:number, offending:Array<{index:number, problems:string[]}> },
 *   metrics_coverage:{ with_metrics:number, without_metrics:number },
 *   warnings:string[],
 *   errors:string[],
 *   summary:string
 * }}
 */
function verifyIngestOutput(result = {}, opts = {}) {
  const items = Array.isArray(result.items) ? result.items : [];
  const invalid = Array.isArray(result.invalid) ? result.invalid : [];
  const written = Array.isArray(result.written) ? result.written : [];
  const byClass = (result.by_class && typeof result.by_class === 'object') ? result.by_class : {};
  const requested = opts.requested || {};
  const requestedTargets =
    (requested.account ? 1 : 0) + (Array.isArray(requested.competitors) ? requested.competitors.length : 0);
  const expectItems = opts.expectItems != null ? opts.expectItems : requestedTargets > 0;

  const warnings = [];
  const errors = [];

  // --- run health ---
  if (expectItems && items.length === 0) {
    errors.push(
      'the pull was requested but returned ZERO items — check the actor id / input shape, the handle(s), '
      + 'the date range, and the provider credential (an auth problem can surface as an empty dataset).',
    );
  }
  if (invalid.length > 0) {
    warnings.push(`${invalid.length} raw item(s) were dropped as malformed/textless (not written) — see result.invalid.`);
  }
  if (requested.account && !(byClass.own > 0)) {
    warnings.push('an own-account pull was requested but produced no own-class items.');
  }
  if (Array.isArray(requested.competitors) && requested.competitors.length && !(byClass.competitor > 0)) {
    warnings.push('a competitor pull was requested but produced no competitor-class items.');
  }

  // --- field filtering: every item must carry ONLY corpus-item variables ---
  const offending = [];
  let withMetrics = 0;
  items.forEach((entry, index) => {
    // ingestRawItems carries an in-memory _account_class on items; the WRITTEN schema item is the
    // entry minus that internal marker. Check the schema-facing shape (strip the known internal key).
    const item = stripInternal(entry);
    const problems = checkItemFields(item);
    if (problems.length) offending.push({ index, problems });
    if (item.metrics) withMetrics += 1;
  });
  const fieldOk = offending.length === 0;
  if (!fieldOk) {
    errors.push(`${offending.length} item(s) carried fields outside the corpus-item contract (filtering failed).`);
  }

  const ok = errors.length === 0;
  const counts = {
    normalized: items.length,
    written: written.length,
    invalid: invalid.length,
    own: Number(byClass.own || 0),
    competitor: Number(byClass.competitor || 0),
  };
  const summary =
    `ingest verify: ${ok ? 'OK' : 'FAILED'} — ${counts.normalized} item(s) ` +
    `(own ${counts.own}, competitor ${counts.competitor}; ${counts.invalid} dropped); ` +
    `fields ${fieldOk ? 'clean (only corpus-item variables)' : `OFFENDING ${offending.length}`}; ` +
    `metrics on ${withMetrics}/${counts.normalized}.`;

  return {
    ok,
    ran: items.length > 0 || invalid.length > 0,
    counts,
    field_check: { ok: fieldOk, checked: items.length, offending: offending.slice(0, 20) },
    metrics_coverage: { with_metrics: withMetrics, without_metrics: counts.normalized - withMetrics },
    warnings,
    errors,
    summary,
  };
}

/** Strip the in-memory-only _account_class marker ingestRawItems attaches (not a schema field). */
function stripInternal(entry) {
  if (!entry || typeof entry !== 'object') return entry;
  if (!('_account_class' in entry)) return entry;
  const { _account_class, ...schemaItem } = entry; // eslint-disable-line no-unused-vars
  return schemaItem;
}

// ---------------------------------------------------------------------------
// Trend output verification (the daily/hourly tracking pull)
// ---------------------------------------------------------------------------

/** The trend-report topic field set (trend-report.schema.json topic items, additionalProperties:false). */
const ALLOWED_TOPIC_KEYS = Object.freeze(new Set(['topic', 'source_links', 'suggested_angles']));

/**
 * Verify a trend poll result (the Apify/BYO daily-hourly tracking feed). Confirms the poll ran +
 * produced reports when tracking targets were requested (zero = hard failure, not a silent no-op),
 * and that every topic is filtered to ONLY the trend-report topic variables with a non-empty topic
 * label. Read-only; never writes or spends.
 *
 * @param {object} result   the return of source.pollTrends: { reports:object[], invalid?:Array, written?:string[] }.
 * @param {object} [opts]
 * @param {object} [opts.requested]  { tracked_accounts?:string[], keywords?:string[] } — so an
 *                                   expected-but-empty poll is a hard failure.
 * @returns {{ ok:boolean, counts:{reports:number, topics:number, invalid:number}, field_check:{ok:boolean, offending:Array}, warnings:string[], errors:string[], summary:string }}
 */
function verifyTrendOutput(result = {}, opts = {}) {
  const reports = Array.isArray(result.reports) ? result.reports : [];
  const invalid = Array.isArray(result.invalid) ? result.invalid : [];
  const requested = opts.requested || {};
  const targets =
    (Array.isArray(requested.tracked_accounts) ? requested.tracked_accounts.length : 0) +
    (Array.isArray(requested.keywords) ? requested.keywords.length : 0);
  const warnings = [];
  const errors = [];

  let topicCount = 0;
  const offending = [];
  reports.forEach((report, ri) => {
    const topics = Array.isArray(report.topics) ? report.topics : [];
    topics.forEach((topic, ti) => {
      topicCount += 1;
      const problems = [];
      if (!topic || typeof topic !== 'object') problems.push('topic is not an object');
      else {
        for (const k of Object.keys(topic)) if (!ALLOWED_TOPIC_KEYS.has(k)) problems.push(`extra key "${k}"`);
        if (typeof topic.topic !== 'string' || !topic.topic.trim()) problems.push('topic.topic is missing/empty');
        if (topic.source_links != null && !Array.isArray(topic.source_links)) problems.push('source_links is not an array');
      }
      if (problems.length) offending.push({ report: ri, topic: ti, problems });
    });
  });

  if (targets > 0 && topicCount === 0) {
    errors.push('tracking targets were configured but the poll produced NO topics — check the actor input, the handles/keywords, and the credential.');
  }
  if (invalid.length) warnings.push(`${invalid.length} report(s) were dropped as malformed (not written).`);
  const fieldOk = offending.length === 0;
  if (!fieldOk) errors.push(`${offending.length} topic(s) carried fields outside the trend-report contract.`);

  const ok = errors.length === 0;
  return {
    ok,
    counts: { reports: reports.length, topics: topicCount, invalid: invalid.length },
    field_check: { ok: fieldOk, offending: offending.slice(0, 20) },
    warnings,
    errors,
    summary: `trend verify: ${ok ? 'OK' : 'FAILED'} — ${reports.length} report(s), ${topicCount} topic(s)${invalid.length ? `, ${invalid.length} dropped` : ''}; fields ${fieldOk ? 'clean' : `OFFENDING ${offending.length}`}.`,
  };
}

module.exports = {
  ALLOWED_ITEM_KEYS,
  REQUIRED_ITEM_KEYS,
  KNOWN_METRIC_KEYS,
  ALLOWED_TOPIC_KEYS,
  checkItemFields,
  verifyIngestOutput,
  verifyTrendOutput,
};
