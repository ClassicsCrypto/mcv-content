'use strict';

/**
 * engine/sources/ingest/apify-adapter.js  [N net-new — concrete BYO Apify ingest adapter]
 *
 * The APIFY brand/competitor ingestion adapter — the concrete, Apify-aware sibling of the generic
 * reference adapter (release-spec §2.4 step 2c BYO scraper; §12.2 scraper interface; RD-9 BYO,
 * manual-first, never-bundled-creds). Where the reference adapter is a generic per-handle HTTP
 * puller, this one knows Apify's run-actor-and-get-dataset mechanics (engine/sources/apify-client.js)
 * so an operator can wire a Twitter/X scraper actor by id and pull the brand's full history + the
 * competitors' last-year corpus cheaply.
 *
 * BYO (RD-9): the Apify token resolves BY NAME (APIFY_API_KEY / APIFY_TOKEN, or provider.key_env) via
 * secrets.js; the actor id + input shape live in the operator's `ingest.provider` block. NO bundled
 * credentials, no hardcoded actor. Absent token ⇒ `fetch` returns [] (degrade to the always-available
 * manual/export path, DD-21) — never throws on a missing key. The network call is INJECTABLE (RD-12):
 * tests pass a fake `fetchImpl`, so CI runs zero-key.
 *
 * Labeling + trust: this adapter sets account_class ('own' for the configured `account`, 'competitor'
 * for each competitor handle) by pulling the two groups separately, so labeling is exact. It does NOT
 * set trust_class — the source layer FORCES trust_class=untrusted-scraped on every item (Zone U,
 * including the operator's own scraped corpus, RD-8) and redacts at write. Each row is mapped to a
 * loose raw item (text/author/url/captured_at/media + public engagement metrics) that the source
 * layer normalizes into a corpus-item.schema.json item and filters to the allowed keys.
 *
 * Registers itself as "apify" on require. Tier-3 clean: no ids/handles/actors/brand strings.
 */

const apify = require('../apify-client');
const { register } = require('./source');

const ADAPTER_NAME = 'apify';

/**
 * Map an Apify Twitter/X dataset row into a loose raw corpus item (the shape source.normalizeItem
 * consumes). Tolerant of the common actor field names; carries public engagement counts through as
 * `metrics` so the analyzer can build the highest-engagement timeline. account_class is stamped by
 * the caller's group. A row with no usable text is dropped (returns null).
 */
function rowToRawItem(row, accountClass) {
  if (!row || typeof row !== 'object') return null;
  const text = row.text || row.full_text || row.fullText || row.content || row.body || '';
  if (typeof text !== 'string' || !text.trim()) return null;

  const author =
    (row.author && (row.author.userName || row.author.username || row.author.handle || row.author.screen_name)) ||
    row.username || row.userName || row.handle || row.screen_name || undefined;

  const item = { text, account_class: accountClass };
  const createdAt = row.createdAt || row.created_at || row.date || row.timestamp || row.time;
  if (createdAt) item.captured_at = createdAt;
  if (author) item.author = author;
  const url = row.url || row.twitterUrl || row.tweetUrl || row.link || row.permalink;
  if (url) item.url = url;
  const media = row.media || row.media_refs || row.mediaUrls || row.media_keys || row.attachments;
  if (Array.isArray(media) && media.length) item.media_refs = media;

  // Public engagement counts — passed through; source.coerceMetrics maps them into the schema shape.
  const likeCount = pickNum(row, ['likeCount', 'favoriteCount', 'favorite_count', 'likes']);
  const replyCount = pickNum(row, ['replyCount', 'reply_count', 'replies']);
  const retweetCount = pickNum(row, ['retweetCount', 'retweet_count', 'reposts']);
  const bookmarkCount = pickNum(row, ['bookmarkCount', 'bookmark_count', 'bookmarks']);
  const viewCount = pickNum(row, ['viewCount', 'view_count', 'views', 'impressions']);
  const metrics = {};
  if (likeCount != null) metrics.likes = likeCount;
  if (replyCount != null) metrics.replies = replyCount;
  if (retweetCount != null) metrics.reposts = retweetCount;
  if (bookmarkCount != null) metrics.bookmarks = bookmarkCount;
  if (viewCount != null) metrics.impressions = viewCount;
  if (Object.keys(metrics).length) item.metrics = metrics;

  return item;
}

function pickNum(obj, keys) {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v;
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) && Number(v) >= 0) return Number(v);
  }
  return undefined;
}

/** Run ONE Apify pull for a set of handles and return loose raw items labeled with accountClass. */
async function pullGroup(handles, accountClass, ctx) {
  const list = (Array.isArray(handles) ? handles : [handles]).filter((h) => typeof h === 'string' && h.trim());
  if (!list.length) return [];
  const input = apify.buildInput(ctx.provider, {
    handles: list,
    maxItems: ctx.max,
    since: ctx.since,
  });
  const { items } = await apify.runActorGetItems({
    actorId: ctx.actorId,
    input,
    token: ctx.token,
    fetchImpl: ctx.fetchImpl,
    timeoutMs: ctx.timeoutMs,
    datasetLimit: ctx.datasetLimit,
    signal: ctx.signal,
  });
  const out = [];
  for (const row of Array.isArray(items) ? items : []) {
    const raw = rowToRawItem(row, accountClass);
    if (raw) out.push(raw);
  }
  return out;
}

/**
 * fetch({ account, competitors, since, platform, max, env, fetchImpl, signal, provider }) -> RawItem[]
 *
 * Pulls the own account (account_class 'own') and the competitor handles (account_class 'competitor')
 * via Apify, as two separate runs for exact labeling. Degrades to [] when no token/actor is
 * configured — never fabricates. The source layer forces Zone-U trust + validates + filters + writes.
 */
async function fetch(args = {}) {
  const env = args.env || process.env;
  const provider = (args.provider && typeof args.provider === 'object') ? args.provider : {};

  const cred = apify.resolveToken(provider, env);
  const actorId = apify.resolveActorId(provider);
  // BYO: absent token OR no actor configured ⇒ degrade to [] (manual/export path always available).
  if (!cred || !actorId) return [];

  const ctx = {
    provider,
    actorId,
    token: cred.value,
    since: args.since || null,
    max: Number.isFinite(args.max) ? args.max : null,
    datasetLimit: Number.isFinite(provider.dataset_limit) ? provider.dataset_limit : null,
    timeoutMs: Number.isFinite(provider.timeout_ms) ? provider.timeout_ms : undefined,
    fetchImpl: args.fetchImpl || globalThis.fetch,
    signal: args.signal,
  };

  const out = [];
  if (args.account && typeof args.account === 'string' && args.account.trim()) {
    out.push(...(await pullGroup([args.account.trim()], 'own', ctx)));
  }
  const competitors = (Array.isArray(args.competitors) ? args.competitors : []).filter((h) => typeof h === 'string' && h.trim());
  if (competitors.length) {
    out.push(...(await pullGroup(competitors, 'competitor', ctx)));
  }
  return out;
}

const adapter = { name: ADAPTER_NAME, fetch };

register(ADAPTER_NAME, adapter);

module.exports = adapter;
module.exports._internal = { rowToRawItem, pullGroup, pickNum };
