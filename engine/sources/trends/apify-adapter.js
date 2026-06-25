'use strict';

/**
 * engine/sources/trends/apify-adapter.js  [N net-new — concrete BYO Apify trend adapter]
 *
 * The APIFY trend-source adapter — the daily/hourly tracking feed (release-spec §8.8 trend pathway;
 * §12.2 trend adapter interface; RD-9 BYO). It pulls RECENT posts from the operator's CONFIRMED
 * tracked accounts + keywords via Apify (engine/sources/apify-client.js) and shapes them into a §6.7
 * trend report: one topic per keyword / tracked account, backed by the matched posts' links, with a
 * volume count in the topic label. It is an HONEST SIGNAL FEED — it surfaces "here is what your
 * tracked accounts and keywords are posting right now," and it deliberately fabricates NOTHING: no
 * "breakout" claims and NO suggested_angles (the no-drafted-text principle, §1.4). The chain still
 * runs every topic through the matcher → writer → gate → the human approval card (§2.4).
 *
 * Tracking targets are FIRST-CLASS operator config (`trends.tracked_accounts`, `trends.keywords`),
 * suggested by the manual-Grok kit and operator-CONFIRMED — never auto-added. They arrive on the poll
 * args (source.pollTrends threads them through); `themes` is folded in as extra keywords for
 * backward compatibility.
 *
 * BYO (RD-9): the Apify token resolves BY NAME (APIFY_API_KEY/APIFY_TOKEN or provider.key_env); the
 * actor id + input shape live in `trends.provider`. Absent token/actor ⇒ poll returns [] (degrade to
 * the always-available manual trend-report path, DR Risk 17). Injectable fetch (RD-12) ⇒ zero-key
 * tests. The source layer re-forces Zone-U provenance + the freshness window + redaction on write.
 *
 * Registers itself as "apify" on require. Tier-3 clean: no ids/handles/actors/brand strings.
 */

const apify = require('../apify-client');
const { register } = require('./source');

const ADAPTER_NAME = 'apify';
const MAX_LINKS_PER_TOPIC = 10; // cap source_links so a report stays compact
const DEFAULT_MAX_ITEMS = 100;  // a tracking poll is small by design (recent window, not an archive)

/** Bare username (strip a leading '@'). */
function bare(h) { return String(h || '').trim().replace(/^@+/, ''); }

/** Pull the post URL from a row (tolerant of common actor field names). */
function rowUrl(row) {
  return row.url || row.twitterUrl || row.tweetUrl || row.link || row.permalink || null;
}
/** Pull the post text. */
function rowText(row) {
  return row.text || row.full_text || row.fullText || row.content || row.body || '';
}
/** Pull the author handle (lower-cased, bare). */
function rowAuthor(row) {
  const a = (row.author && (row.author.userName || row.author.username || row.author.handle || row.author.screen_name))
    || row.username || row.userName || row.handle || row.screen_name || '';
  return bare(a).toLowerCase();
}

/**
 * Build §6.7 topics from the pulled rows: one topic per keyword (posts whose text contains it) and
 * one per tracked account (posts authored by it). source_links = the matched post URLs (capped). The
 * topic label carries the volume. No suggested_angles are produced (no fabrication, §1.4). A target
 * with zero matched posts is omitted (no empty topic).
 */
function buildTopics({ rows, keywords, trackedAccounts }) {
  const topics = [];

  for (const kw of keywords) {
    const needle = kw.toLowerCase();
    const links = [];
    for (const r of rows) {
      if (rowText(r).toLowerCase().includes(needle)) {
        const u = rowUrl(r);
        if (u && !links.includes(u)) links.push(u);
      }
    }
    if (links.length) {
      const topic = { topic: `${kw} (${links.length} post${links.length === 1 ? '' : 's'})` };
      topic.source_links = links.slice(0, MAX_LINKS_PER_TOPIC);
      topics.push(topic);
    }
  }

  for (const handle of trackedAccounts) {
    const h = bare(handle).toLowerCase();
    const links = [];
    for (const r of rows) {
      if (rowAuthor(r) === h) {
        const u = rowUrl(r);
        if (u && !links.includes(u)) links.push(u);
      }
    }
    if (links.length) {
      const topic = { topic: `@${bare(handle)} (${links.length} recent post${links.length === 1 ? '' : 's'})` };
      topic.source_links = links.slice(0, MAX_LINKS_PER_TOPIC);
      topics.push(topic);
    }
  }

  return topics;
}

/**
 * poll({ cadence, themes, tracked_accounts, keywords, brand, provider, env, fetchImpl, signal })
 *   -> TrendReport[]
 *
 * Pulls recent posts for the tracked accounts + keywords via Apify and returns a single §6.7 report
 * (or [] when nothing is configured / nothing matched). Degrades to [] when no token/actor — never
 * fabricates. The source layer forces Zone-U provenance + freshness window + redaction.
 */
async function poll(args = {}) {
  const env = args.env || process.env;
  const provider = (args.provider && typeof args.provider === 'object') ? args.provider : {};

  const cred = apify.resolveToken(provider, env);
  const actorId = apify.resolveActorId(provider);
  if (!cred || !actorId) return []; // BYO degrade — manual trend-report path always available.

  const trackedAccounts = uniqStrings([
    ...(Array.isArray(args.tracked_accounts) ? args.tracked_accounts : []),
    ...(Array.isArray(provider.tracked_accounts) ? provider.tracked_accounts : []),
  ]);
  const keywords = uniqStrings([
    ...(Array.isArray(args.keywords) ? args.keywords : []),
    ...(Array.isArray(args.themes) ? args.themes : []), // themes fold in as keywords (back-compat)
    ...(Array.isArray(provider.keywords) ? provider.keywords : []),
  ]);
  if (!trackedAccounts.length && !keywords.length) return []; // nothing to track

  const input = apify.buildInput(provider, {
    handles: trackedAccounts,
    search: keywords,
    maxItems: Number.isFinite(provider.max_items) ? provider.max_items : DEFAULT_MAX_ITEMS,
  });
  const { items } = await apify.runActorGetItems({
    actorId,
    input,
    token: cred.value,
    fetchImpl: args.fetchImpl || globalThis.fetch,
    timeoutMs: Number.isFinite(provider.timeout_ms) ? provider.timeout_ms : undefined,
    datasetLimit: Number.isFinite(provider.dataset_limit) ? provider.dataset_limit : null,
    signal: args.signal,
  });
  const rows = Array.isArray(items) ? items : [];

  const topics = buildTopics({ rows, keywords, trackedAccounts });
  if (!topics.length) return []; // nothing actionable — no empty/fabricated report

  const now = new Date();
  const report = {
    period: {
      start: new Date(now.getTime() - windowMs(args.cadence)).toISOString(),
      end: now.toISOString(),
    },
    platform: (provider && provider.platform) || 'twitter',
    topics,
    provenance: { trust_zone: 'U', method: 'adapter', submitted_at: now.toISOString() },
  };
  if (args.brand) report.brand = args.brand;
  return [report];
}

function uniqStrings(arr) {
  const out = [];
  const seen = new Set();
  for (const s of arr) {
    if (typeof s !== 'string' || !s.trim()) continue;
    const v = s.trim();
    const k = v.toLowerCase();
    if (!seen.has(k)) { seen.add(k); out.push(v); }
  }
  return out;
}

/** Cadence → window milliseconds (defaults to 12h for an unknown token). */
function windowMs(cadence) {
  const map = { '1h': 1, '2h': 2, '4h': 4, '8h': 8, '12h': 12, '24h': 24 };
  return (map[cadence] || 12) * 60 * 60 * 1000;
}

const adapter = { name: ADAPTER_NAME, poll };

register(ADAPTER_NAME, adapter);

module.exports = adapter;
module.exports._internal = { buildTopics, rowUrl, rowText, rowAuthor, uniqStrings, windowMs };
