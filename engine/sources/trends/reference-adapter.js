'use strict';

/**
 * engine/sources/trends/reference-adapter.js  [A adapted — BYO reference, RD-9]
 *
 * The REFERENCE trend-source adapter (release-spec §12.2 scraper/trend adapter interface; RD-9
 * "scraping is BYO adapter, manual-first, never bundled creds"; §3.3 optional scraping/trend
 * provider, BYO). It reads a CONFIGURED trend/scraper provider through an INJECTABLE call and
 * resolves credentials via engine/shared/secrets.js by env NAME only — it bundles NO credentials
 * and hardcodes no provider key. The production trend pathway had zero code behind it (gap §2.2);
 * this is the first real, honest, opt-in implementation, and it ships DISABLED with the source's
 * config gate (off by default).
 *
 * What "BYO" means here (RD-9 / DR Risk 17):
 *   - the operator supplies provider access — an Apify-class or xAI/Grok-class key — under one of
 *     the §4.3 NAMES (APIFY_API_KEY | XAI_API_KEY | GROK_API_KEY). The adapter reads it BY NAME via
 *     secrets.js and NEVER from a hardcoded value, a bundled file, or a path list.
 *   - the provider endpoint + request shape live in the operator's `trends.provider` config block
 *     (§12.5-style: { kind, endpoint, key_env, timeout_ms, options }) — not baked per call-site.
 *   - the network call is INJECTABLE (RD-12 / §12 seam): `poll` takes a `fetchImpl` and an `env`,
 *     so tests run zero-key with a fake and CI carries no secrets.
 *   - if no provider is configured or the key is absent, `poll` returns [] (no reports) rather than
 *     throwing — the manual-submission path is always available, so a missing provider degrades to
 *     "no automated reports", never a broken setup.
 *
 * PRIVACY pre-pass (load-bearing for the shared work-recap sibling, but applied here too): provider
 * responses are Zone-U external text and may echo back query terms or operator-supplied themes. The
 * adapter routes the RAW provider payload through redact.js BEFORE mapping it into report fields, so
 * a secret/token-shaped value in a provider response never survives into a written report. The
 * operator's `trends.private_terms` deny-list extends the redaction key set.
 *
 * Everything returned is Zone U (model §8). The source's normalizeReport forces
 * provenance.trust_zone="U" and provenance.method="adapter" regardless — defense in depth.
 *
 * This adapter ships a GENERIC, provider-shape-tolerant mapper (it understands a small set of common
 * trend-payload shapes); a specific provider with an unusual shape is handled by the operator
 * setting `trends.provider.options.map` hints, or by registering their own adapter through the seam.
 * Tier-3 clean: no IDs/handles/paths/brand strings/codenames.
 *
 * Registers itself as "reference" on require.
 */

const { getSecret } = require('../../shared/secrets');
const { redact } = require('../../shared/redact');
const { register } = require('./source');

const ADAPTER_NAME = 'reference';
const CONSUMER = 'trend-source adapter (reference)';
const DEFAULT_TIMEOUT_MS = 60_000;

/** The §4.3 provider key NAMES this adapter knows how to resolve, in preference order. */
const KNOWN_KEY_ENVS = Object.freeze(['APIFY_API_KEY', 'XAI_API_KEY', 'GROK_API_KEY']);

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
 * Map a redacted provider payload into §6.7 trend-report topics. Tolerant of a few common shapes:
 *   - { topics: [{ topic|name|title, links|urls|source_links, angles|suggested_angles }] }
 *   - { items: [{ ... }] } / { results: [...] } / { data: [...] }
 *   - a bare array of the above topic objects
 *   - { trends: ["a string topic", ...] } (strings become topic-only entries)
 * Anything unrecognized yields []. suggested_angles are passed through as ANGLES ONLY; this adapter
 * never synthesizes drafted comment/reply text (spec §1.4 principle).
 */
function extractTopics(payload) {
  if (!payload) return [];
  const arr =
    (Array.isArray(payload) && payload) ||
    payload.topics ||
    payload.items ||
    payload.results ||
    payload.data ||
    payload.trends ||
    [];
  if (!Array.isArray(arr)) return [];

  const topics = [];
  for (const entry of arr) {
    if (typeof entry === 'string') {
      const topic = entry.trim();
      if (topic) topics.push({ topic });
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    const topic = String(entry.topic || entry.name || entry.title || '').trim();
    if (!topic) continue;
    const out = { topic };

    const links = entry.source_links || entry.links || entry.urls;
    if (Array.isArray(links)) {
      const cleaned = links.map((l) => String(l).trim()).filter(Boolean);
      if (cleaned.length) out.source_links = cleaned;
    }
    const angles = entry.suggested_angles || entry.angles;
    if (Array.isArray(angles)) {
      const cleaned = angles.map((a) => String(a).trim()).filter(Boolean);
      if (cleaned.length) out.suggested_angles = cleaned;
    }
    topics.push(out);
  }
  return topics;
}

/**
 * Build the provider HTTP request from the operator's `trends.provider` block. The endpoint and
 * method/body/headers live in config (§12.5-style), never baked here. The credential is injected
 * into the header the provider expects (`provider.auth_header` default 'Authorization', with an
 * optional `provider.auth_scheme` like 'Bearer ').
 */
function buildRequest(provider, key, pollArgs) {
  const endpoint = provider && typeof provider.endpoint === 'string' ? provider.endpoint.trim() : '';
  if (!endpoint) return null; // no endpoint configured => caller degrades to []
  const authHeader = (provider && provider.auth_header) || 'Authorization';
  const authScheme = (provider && provider.auth_scheme) || '';
  const headers = {
    Accept: 'application/json',
    ...(provider && provider.headers ? provider.headers : {}),
    [authHeader]: `${authScheme}${key}`,
  };
  // The query carries the cadence window + theme hints so the provider can scope its scan. A
  // provider that ignores them still works; one that uses them gets better signal.
  const method = (provider && provider.method) || 'GET';
  let url = endpoint;
  let body;
  if (method.toUpperCase() === 'GET') {
    const params = new URLSearchParams();
    if (pollArgs.cadence) params.set('window', pollArgs.cadence);
    for (const theme of pollArgs.themes || []) params.append('theme', theme);
    if ([...params].length) url += (endpoint.includes('?') ? '&' : '?') + params.toString();
  } else {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify({
      window: pollArgs.cadence,
      themes: pollArgs.themes || [],
      ...(provider && provider.body ? provider.body : {}),
    });
  }
  return { url, method, headers, body };
}

/**
 * poll({ cadence, themes, brand, provider, env, fetchImpl, signal }) -> TrendReport[]
 *
 * Reads the configured provider through the injectable fetch, redacts the payload, maps it to a §6.7
 * report, and returns it. Degrades to [] (no reports) when no provider/key is configured — never
 * fabricates. The source layer forces Zone-U provenance + the freshness window on top of this.
 */
async function poll(args = {}) {
  const env = args.env || process.env;
  const fetchImpl = args.fetchImpl || fetch;
  const provider = (args.provider && typeof args.provider === 'object') ? args.provider : {};

  // BYO: resolve the credential by NAME. Absent => degrade gracefully (manual path is always there).
  const cred = resolveProviderKey(provider, env);
  if (!cred) return [];

  const req = buildRequest(provider, cred.value, args);
  if (!req) return []; // no endpoint configured => no automated reports (manual path remains)

  const timeoutMs = Number.isFinite(provider.timeout_ms) ? provider.timeout_ms : DEFAULT_TIMEOUT_MS;
  const res = await fetchImpl(req.url, {
    method: req.method,
    headers: req.headers,
    body: req.body,
    signal: args.signal || AbortSignal.timeout(timeoutMs),
  });

  const text = await res.text();
  if (!res.ok) {
    // A provider error is surfaced (the source records nothing for it); never a fabricated report.
    const err = new Error(
      `${CONSUMER}: provider request failed HTTP ${res.status} (key ${cred.name}).`,
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

  // PRIVACY pre-pass: redact the RAW payload before mapping, so a token/secret-shaped value in a
  // provider response can never survive into a written report (§13.3 redact-at-write).
  const safePayload = redact(payload);

  const topics = extractTopics(safePayload);
  if (!topics.length) return []; // nothing actionable — no empty/fabricated report

  const now = new Date();
  const windowMs =
    args.cadence === '2h' ? 2 : args.cadence === '4h' ? 4 : args.cadence === '8h' ? 8 : 12;
  const report = {
    period: {
      start: new Date(now.getTime() - windowMs * 60 * 60 * 1000).toISOString(),
      end: now.toISOString(),
    },
    // platform is the descriptor id the operator scoped the provider to (config), defaulting broad.
    platform: (provider && provider.platform) || 'twitter',
    topics,
    provenance: {
      trust_zone: 'U', // always U; the source re-forces this too (defense in depth).
      method: 'adapter',
      submitted_at: now.toISOString(),
    },
  };
  if (args.brand) report.brand = args.brand;
  return [report];
}

const adapter = {
  name: ADAPTER_NAME,
  poll,
};

register(ADAPTER_NAME, adapter);

module.exports = adapter;
// Internals exported for the co-located tests (not part of the poll contract).
module.exports._internal = {
  KNOWN_KEY_ENVS,
  resolveProviderKey,
  extractTopics,
  buildRequest,
};
