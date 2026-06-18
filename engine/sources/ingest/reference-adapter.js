'use strict';

/**
 * engine/sources/ingest/reference-adapter.js  [A adapted — BYO reference, RD-9; production seed:
 *                                              the ad-hoc Apify "winner bank" / comparator-corpus
 *                                              pulls (content-team/research/x-comparator-corpus-*,
 *                                              competitor_lens.md "Apify is useful for refreshing
 *                                              winner banks") had bundled, per-call provider wiring
 *                                              and no declared interface; this is the gated seam.]
 *
 * The REFERENCE brand/competitor ingestion adapter (release-spec §2.4 step 2c BYO scraper; §12.2
 * scraper adapter interface; RD-9 "scraping is BYO adapter, manual-first, never bundled creds";
 * §3.3 optional scraping/trend provider, BYO). It reads a CONFIGURED scraper provider through an
 * INJECTABLE call and resolves credentials via engine/shared/secrets.js by env NAME only — it
 * bundles NO credentials and hardcodes no provider key. It ships DISABLED with the source's config
 * gate (the scraper path is off by default — the LAW).
 *
 * What "BYO" means here (RD-9 / DR Risk 17 — the design-review risk):
 *   - the operator supplies provider access — an Apify-class or xAI-class key — under one of
 *     the §4.3 NAMES (APIFY_API_KEY | XAI_API_KEY). The adapter reads it BY NAME via
 *     secrets.js and NEVER from a hardcoded value, a bundled file, or a path list.
 *   - the provider endpoint + request shape live in the operator's `ingest.provider` config block
 *     (§12.5-style: { kind, endpoint, key_env, timeout_ms, options }) — not baked per call-site
 *     (the exact thing the production per-call Apify wiring did wrong).
 *   - the network call is INJECTABLE (RD-12 / §12 seam): `fetch` takes a `fetchImpl` and an `env`,
 *     so tests run zero-key with a fake and CI carries no secrets.
 *   - if no provider is configured or the key is absent, `fetch` returns [] (no items) rather than
 *     throwing — the MANUAL submission + official-account EXPORT paths are always available, so a
 *     missing provider degrades to "no scraped items", never a broken setup (the cold-start
 *     fallback, DD-21). The operator is the data controller; ToS responsibility is theirs
 *     (docs/data-policy.md).
 *
 * TRUST + PRIVACY: everything returned is Zone U (model §8) — INCLUDING the operator's own scraped
 * account, per RD-8. The source layer FORCES trust_class=untrusted-scraped on every written item
 * regardless of what the adapter returns (defense in depth) and redacts at write. This adapter does
 * NOT set trust_class — it labels account_class ('own' for the configured `account`, 'competitor'
 * for each `competitors[]` handle) so the source can route own- vs competitor-corpus. Competitor
 * text is carried for PATTERN analysis only; it is never republished verbatim (the LAW — enforced
 * downstream on the derived DNA/archetype artifacts, not on the raw corpus).
 *
 * This adapter ships a GENERIC, provider-shape-tolerant mapper (it understands a small set of common
 * scraper payload shapes — Apify dataset rows, a bare array, {items|results|data|tweets}); a
 * provider with an unusual shape is handled by the operator setting `ingest.provider.options` hints
 * or registering their own adapter through the seam. Tier-3 clean: no IDs/handles/paths/brand
 * strings/codenames.
 *
 * Registers itself as "reference" on require.
 */

const { getSecret } = require('../../shared/secrets');
const { register } = require('./source');

const ADAPTER_NAME = 'reference';
const CONSUMER = 'ingestion adapter (reference)';
const DEFAULT_TIMEOUT_MS = 120_000; // a corpus pull can be slower than a trend poll

/** The §4.3 provider key NAMES this adapter knows how to resolve, in preference order. */
const KNOWN_KEY_ENVS = Object.freeze(['APIFY_API_KEY', 'XAI_API_KEY']);

/**
 * Resolve the provider credential by NAME via secrets.js. The name comes from the operator's
 * `provider.key_env` (explicit) or the first KNOWN_KEY_ENVS that resolves. Returns
 * { name, value } or null when none is configured/present — the caller then degrades to [].
 */
function resolveProviderKey(provider, env) {
  const explicit = provider && typeof provider.key_env === 'string' ? provider.key_env.trim() : '';
  const candidates = explicit ? [explicit] : KNOWN_KEY_ENVS;
  for (const name of candidates) {
    const value = getSecret(name, { env }); // by NAME, not required — absence => degrade, not throw
    if (value) return { name, value };
  }
  return null;
}

/**
 * Map a provider payload into raw corpus items, stamping account_class per the handle the row came
 * from. Tolerant of common scraper shapes:
 *   - a bare array of post rows
 *   - { items|results|data|tweets|posts: [...] }
 *   - Apify-style dataset rows: { text|full_text|content, createdAt|created_at, url, author{userName}|username }
 * Each row becomes a loose raw item; the source layer normalizes it into a corpus-item.schema.json
 * item and FORCES the Zone-U trust class.
 *
 * @param {*} payload      the provider response (already JSON-parsed).
 * @param {string} handle  the account this payload was pulled for.
 * @param {string} accountClass  'own' | 'competitor'.
 * @returns {object[]} loose raw items.
 */
function extractItems(payload, handle, accountClass) {
  if (!payload) return [];
  const arr =
    (Array.isArray(payload) && payload) ||
    payload.items ||
    payload.results ||
    payload.data ||
    payload.tweets ||
    payload.posts ||
    [];
  if (!Array.isArray(arr)) return [];

  const out = [];
  for (const row of arr) {
    if (!row || typeof row !== 'object') continue;
    const text = row.text || row.full_text || row.content || row.body || '';
    if (typeof text !== 'string' || !text.trim()) continue; // no text => not a corpus item
    // Author: prefer the row's own author, else the pulled handle. Minimized downstream (RD-9).
    const author =
      (row.author && (row.author.userName || row.author.username || row.author.handle)) ||
      row.username ||
      row.handle ||
      row.screen_name ||
      handle ||
      undefined;
    const item = {
      text,
      account_class: accountClass,
    };
    const createdAt = row.createdAt || row.created_at || row.date || row.timestamp;
    if (createdAt) item.captured_at = createdAt;
    if (author) item.author = author;
    const url = row.url || row.link || row.permalink || row.twitterUrl;
    if (url) item.url = url;
    const media = row.media || row.media_refs || row.media_keys || row.attachments;
    if (Array.isArray(media) && media.length) item.media_refs = media;
    out.push(item);
  }
  return out;
}

/**
 * Build the provider HTTP request for ONE handle pull. The endpoint and method/body/headers live in
 * config (§12.5-style), never baked here. The credential is injected into the header the provider
 * expects (`provider.auth_header` default 'Authorization', with an optional `provider.auth_scheme`
 * like 'Bearer '). The handle + since + max + platform are passed as query/body so the provider can
 * scope the pull; a provider that ignores them still works.
 */
function buildRequest(provider, key, pullArgs) {
  const endpoint = provider && typeof provider.endpoint === 'string' ? provider.endpoint.trim() : '';
  if (!endpoint) return null; // no endpoint configured => caller degrades to []
  const authHeader = (provider && provider.auth_header) || 'Authorization';
  const authScheme = (provider && provider.auth_scheme) || '';
  const headers = {
    Accept: 'application/json',
    ...(provider && provider.headers ? provider.headers : {}),
    [authHeader]: `${authScheme}${key}`,
  };
  const method = (provider && provider.method) || 'GET';
  let url = endpoint;
  let body;
  if (method.toUpperCase() === 'GET') {
    const params = new URLSearchParams();
    if (pullArgs.handle) params.set('handle', pullArgs.handle);
    if (pullArgs.since) params.set('since', pullArgs.since);
    if (pullArgs.platform) params.set('platform', pullArgs.platform);
    if (Number.isFinite(pullArgs.max)) params.set('max', String(pullArgs.max));
    if ([...params].length) url += (endpoint.includes('?') ? '&' : '?') + params.toString();
  } else {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify({
      handle: pullArgs.handle,
      since: pullArgs.since || null,
      platform: pullArgs.platform || null,
      max: pullArgs.max || null,
      ...(provider && provider.body ? provider.body : {}),
    });
  }
  return { url, method, headers, body };
}

/** Pull one handle through the injectable fetch; returns loose raw items (or [] / throws on error). */
async function pullHandle(handle, accountClass, ctx) {
  const req = buildRequest(ctx.provider, ctx.key, {
    handle,
    since: ctx.since,
    platform: ctx.platform,
    max: ctx.max,
  });
  if (!req) return []; // no endpoint => nothing to pull (manual/export paths remain)

  const timeoutMs = Number.isFinite(ctx.provider.timeout_ms) ? ctx.provider.timeout_ms : DEFAULT_TIMEOUT_MS;
  const res = await ctx.fetchImpl(req.url, {
    method: req.method,
    headers: req.headers,
    body: req.body,
    signal: ctx.signal || AbortSignal.timeout(timeoutMs),
  });

  const text = await res.text();
  if (!res.ok) {
    const err = new Error(
      `${CONSUMER}: provider request failed HTTP ${res.status} for handle "${handle}" (key ${ctx.keyName}).`,
    );
    err.httpStatus = res.status;
    throw err;
  }
  let payload;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  return extractItems(payload, handle, accountClass);
}

/**
 * fetch({ account, competitors, since, platform, max, env, fetchImpl, signal, provider })
 *   -> RawItem[]
 *
 * Pulls the operator's own account (labeled account_class 'own') and each competitor handle
 * (labeled 'competitor') through the injectable fetch, and returns loose raw items. Degrades to []
 * when no provider/key is configured — never fabricates. The source layer forces Zone-U trust on top
 * of this and writes one .json per item under corpora/<brand>/.
 */
async function fetch(args = {}) {
  const env = args.env || process.env;
  const fetchImpl = args.fetchImpl || globalThis.fetch;
  const provider = args.provider && typeof args.provider === 'object' ? args.provider : {};

  // BYO: resolve the credential by NAME. Absent => degrade gracefully (manual/export always there).
  const cred = resolveProviderKey(provider, env);
  if (!cred) return [];

  const ctx = {
    provider,
    key: cred.value,
    keyName: cred.name,
    since: args.since || null,
    platform: args.platform || provider.platform || 'twitter',
    max: Number.isFinite(args.max) ? args.max : null,
    fetchImpl,
    signal: args.signal,
  };

  const out = [];
  // Own account first (own-account corpus). RD-8: even the operator's own scraped data is Zone U.
  if (args.account && typeof args.account === 'string' && args.account.trim()) {
    const items = await pullHandle(args.account.trim(), 'own', ctx);
    out.push(...items);
  }
  // Competitor accounts (Zone U; carried for PATTERN analysis only, never republished verbatim).
  for (const handle of Array.isArray(args.competitors) ? args.competitors : []) {
    if (typeof handle !== 'string' || !handle.trim()) continue;
    const items = await pullHandle(handle.trim(), 'competitor', ctx);
    out.push(...items);
  }
  return out;
}

const adapter = {
  name: ADAPTER_NAME,
  fetch,
};

register(ADAPTER_NAME, adapter);

module.exports = adapter;
// Internals exported for the co-located tests (not part of the fetch contract).
module.exports._internal = {
  KNOWN_KEY_ENVS,
  resolveProviderKey,
  extractItems,
  buildRequest,
  pullHandle,
};
