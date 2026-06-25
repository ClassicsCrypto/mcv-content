'use strict';

/**
 * engine/sources/apify-client.js  [N net-new — shared BYO Apify transport]
 *
 * A small, dependency-free Apify transport shared by the ingest + trend Apify adapters (release-spec
 * §12.2 scraper/trend adapter interface; RD-9 "scraping is BYO adapter, manual-first, never bundled
 * creds"; RD-12 injectable network seam). It owns ONE thing: run an Apify actor and return its
 * dataset items. It bundles NO credentials and hardcodes no actor — the token resolves BY NAME via
 * secrets.js and the actor id + input come from the operator's `provider` config block.
 *
 * Transport: Apify's run-sync-get-dataset-items endpoint (one call → the dataset items array):
 *   POST https://api.apify.com/v2/acts/<actor>/run-sync-get-dataset-items?clean=true[&limit=N]
 *   Authorization: Bearer <token>          (the token never rides the URL — kept out of logs)
 *   body: the actor input JSON
 * The sync endpoint waits for the run (Apify caps it around 300s); a very large historical pull may
 * truncate — the VERIFICATION layer (engine/sources/verify-output.js) reports item-count-vs-expected
 * so a short run is visible, never silent. Operators bound large pulls with `max` (per-account cap).
 *
 * Injectable (RD-12): `runActorGetItems` takes a `fetchImpl` so tests run zero-key with a fake and CI
 * carries no secrets. The default is global fetch (Node >=22). Tier-3 clean: no ids/handles/actors.
 */

const { getSecret } = require('../shared/secrets');

const DEFAULT_TIMEOUT_MS = 180_000; // a corpus pull is slower than a trend poll; bounded, never infinite.
const APIFY_API_BASE = 'https://api.apify.com/v2';

/** The §4.3 provider key NAMES this transport resolves, in preference order (BYO — never bundled). */
const KNOWN_KEY_ENVS = Object.freeze(['APIFY_API_KEY', 'APIFY_TOKEN']);

class ApifyConfigError extends Error {
  constructor(message) { super(message); this.name = 'ApifyConfigError'; }
}
class ApifyRunError extends Error {
  constructor(message, httpStatus) { super(message); this.name = 'ApifyRunError'; this.httpStatus = httpStatus; }
}

/** Resolve the Apify token BY NAME (provider.key_env, else the known names). null when absent. */
function resolveToken(provider, env = process.env) {
  const explicit = provider && typeof provider.key_env === 'string' ? provider.key_env.trim() : '';
  const candidates = explicit ? [explicit] : KNOWN_KEY_ENVS;
  for (const name of candidates) {
    const value = getSecret(name, { env });
    if (value) return { name, value };
  }
  return null;
}

/** The actor id from the provider block (required for an Apify pull). */
function resolveActorId(provider) {
  const id = provider && typeof provider.actor_id === 'string' ? provider.actor_id.trim() : '';
  return id || null;
}

/** Apify path-encodes an actor id by replacing the `username/name` slash with a tilde. */
function actorPathId(actorId) {
  return String(actorId).replace('/', '~');
}

/** Strip a leading '@' from a handle (search syntax wants the bare username). */
function bareHandle(h) {
  return String(h || '').trim().replace(/^@+/, '');
}

/**
 * Build the actor INPUT from the operator's provider block + the dynamic pull params. Actors differ
 * wildly in their input shape, so this is generic + operator-overridable:
 *   - provider.input        a STATIC input template merged underneath (actor-specific knobs).
 *   - provider.field_map    rename the dynamic keys to the actor's field names. Defaults:
 *                           { search:'searchTerms', handles:'twitterHandles', maxItems:'maxItems', since:'start' }
 *   - provider.handles_as_search  (default true) fold handles into searchTerms as `from:<handle>` —
 *                           works out of the box with the common search-based Twitter actors; set
 *                           false (and field_map.handles) for an actor with a dedicated handles field.
 *
 * @param {object} provider  the §12.5 provider block.
 * @param {object} params    { handles?:string[], search?:string[], maxItems?:number, since?:string }
 * @returns {object} the actor input.
 */
function buildInput(provider = {}, params = {}) {
  const fm = (provider.field_map && typeof provider.field_map === 'object') ? provider.field_map : {};
  const key = (logical, def) => (typeof fm[logical] === 'string' && fm[logical] ? fm[logical] : def);
  const handlesAsSearch = provider.handles_as_search !== false; // default true

  const handles = (Array.isArray(params.handles) ? params.handles : []).map(bareHandle).filter(Boolean);
  const search = (Array.isArray(params.search) ? params.search : []).map((s) => String(s).trim()).filter(Boolean);

  const input = { ...(provider.input && typeof provider.input === 'object' ? provider.input : {}) };

  if (handlesAsSearch) {
    const terms = [...handles.map((h) => `from:${h}`), ...search];
    if (terms.length) input[key('search', 'searchTerms')] = terms;
  } else {
    if (handles.length) input[key('handles', 'twitterHandles')] = handles;
    if (search.length) input[key('search', 'searchTerms')] = search;
  }
  if (Number.isFinite(params.maxItems) && params.maxItems > 0) input[key('maxItems', 'maxItems')] = Math.floor(params.maxItems);
  if (params.since) input[key('since', 'start')] = params.since;
  return input;
}

/**
 * Run an Apify actor and return its dataset items (one sync call).
 *
 * @param {object}   args
 * @param {string}   args.actorId     'username/actor-name' (required).
 * @param {object}   args.input       the actor input JSON.
 * @param {string}   args.token       the Apify token (resolved by the caller via resolveToken).
 * @param {function} [args.fetchImpl] injectable fetch (default global fetch) — RD-12 zero-key tests.
 * @param {number}   [args.timeoutMs] hard ceiling (default 180s).
 * @param {number}   [args.datasetLimit] cap on items returned (?limit=).
 * @param {AbortSignal} [args.signal]
 * @returns {Promise<{ items: object[], http_status: number }>}
 * @throws {ApifyConfigError} missing actor/token. {ApifyRunError} non-2xx or unparseable response.
 */
async function runActorGetItems(args = {}) {
  const actorId = args.actorId;
  if (!actorId) throw new ApifyConfigError('apify: provider.actor_id is required (the "username/actor-name" to run).');
  if (!args.token) throw new ApifyConfigError('apify: no token resolved (set APIFY_API_KEY or provider.key_env).');

  const fetchImpl = args.fetchImpl || globalThis.fetch;
  const timeoutMs = Number.isFinite(args.timeoutMs) && args.timeoutMs > 0 ? args.timeoutMs : DEFAULT_TIMEOUT_MS;
  const params = new URLSearchParams({ clean: 'true', format: 'json' });
  if (Number.isFinite(args.datasetLimit) && args.datasetLimit > 0) params.set('limit', String(Math.floor(args.datasetLimit)));
  const url = `${APIFY_API_BASE}/acts/${actorPathId(actorId)}/run-sync-get-dataset-items?${params.toString()}`;

  const res = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${args.token}`, // header auth — token never in the URL/logs
    },
    body: JSON.stringify(args.input || {}),
    signal: args.signal || AbortSignal.timeout(timeoutMs),
  });

  const text = await res.text();
  if (!res.ok) {
    let detail = '';
    try { detail = (JSON.parse(text).error || {}).message || ''; } catch { detail = text.slice(0, 200); }
    throw new ApifyRunError(`apify run failed HTTP ${res.status} for actor "${actorId}"${detail ? `: ${detail}` : ''}.`, res.status);
  }
  let items;
  try { items = text ? JSON.parse(text) : []; } catch {
    throw new ApifyRunError(`apify returned an unparseable dataset for actor "${actorId}".`, res.status);
  }
  if (!Array.isArray(items)) items = Array.isArray(items.items) ? items.items : [];
  return { items, http_status: res.status };
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  KNOWN_KEY_ENVS,
  ApifyConfigError,
  ApifyRunError,
  resolveToken,
  resolveActorId,
  actorPathId,
  bareHandle,
  buildInput,
  runActorGetItems,
};
