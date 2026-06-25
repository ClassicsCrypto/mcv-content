'use strict';

/**
 * engine/sources/ingest/source.js  [A adapted — production competitor-watch/comparator-corpus
 *                                    pulls (content-team/research/x-comparator-corpus-*, the Apify
 *                                    "winner bank" refresh path, competitor_lens.md intake) were
 *                                    ad-hoc one-off scripts with no declared interface and no
 *                                    retention/trust tagging; this is their first real, gated,
 *                                    schema-conformant seam.]
 *
 * The BRAND/COMPETITOR INGESTION SOURCE — release-spec §2.4 C2 corpus intake (the three supported
 * paths, RD-9); original-design-spec §1.1 Data Ingestion & Brand Identity + §1.2 Context &
 * Competitor Analysis; roadmap #2. It produces the CORPUS the deterministic analyzer (a sibling
 * batch) and the DNA-synthesis HOST seat consume; it does NOT analyze, draft, or publish anything.
 *
 * This module is the SEAM + the registry + the corpus-item writer (the §12.2 scraper adapter
 * interface; DD-10 "minimal adapter interface for scraper"). It mirrors the trend-source seam
 * (engine/sources/trends/source.js) and the publisher seam: a duck-typed adapter contract, a
 * self-registration registry, one orchestration entry point (ingestCorpus), and a deterministic
 * writer that lands artifacts under $CONTENT_HOME via paths.js.
 *
 * THREE FIRST-CLASS INTAKE PATHS (release-spec §2.4 step 2, in order of preference — RD-9):
 *   a. MANUAL submission (first-class, model §10 #1) — operator drops corpus-item files; see
 *      ./manual.js importManualSubmission. No adapter, no credential, no network.
 *   b. OFFICIAL-ACCOUNT export — the platform's own archive/export, converted by ./manual.js
 *      importAccountExport. No third-party scraper; the operator is the data subject.
 *   c. BYO SCRAPER adapter (./reference-adapter.js) — the operator supplies provider access; the
 *      repo ships the adapter interface + a reference adapter, NO bundled creds (credentials by env
 *      NAME via secrets.js). Scraping is the LAST resort and is metered (cost-estimate + confirm).
 *
 * SCRAPING POSTURE (RD-9 / the design-review risk): manual + official exports are FIRST-CLASS;
 * scraping is BYO (no bundled creds, operator is the data controller, ToS responsibility disclosed
 * in docs/data-policy.md). A missing/unconfigured scraper NEVER blocks onboarding — the cold-start
 * fallback (DD-21) is the manual path, always available. The scraper pathway ships CONFIG-GATED and
 * OFF BY DEFAULT (the LAW): ingestCorpus refuses to run a scrape adapter until the operator opts in
 * via the `ingest` block in config/system.json with `enabled: true`. Manual/export imports need no
 * opt-in (they are operator-supplied data, not a metered third-party action).
 *
 * TRUST ZONE (load-bearing — model §8): the ingested corpus is Zone U (untrusted third-party input,
 * INCLUDING competitors). Every written item is trust-class-tagged at WRITE time
 * (schemas/inputs/corpus-item.schema.json `trust_class`): scraped/competitor material is
 * `untrusted-scraped`; only an explicit operator attestation promotes a curated subset to
 * `operator-curated` (RD-8 U->S). This module FORCES `untrusted-scraped` on adapter output (never
 * trusting the adapter to self-promote) and labels own-account vs competitor on every item.
 *
 * PATTERNS-ONLY (load-bearing — RD-9 / the LAW): competitor content is ingested so the analyzer can
 * extract PATTERNS (cadence, archetype mix, hook shapes — the production competitor_analysis.md /
 * archetype-matrix work) — it is NEVER republished verbatim. The corpus carries the source text for
 * analysis, but a check (./guards.js assertNoVerbatimCarryover, applied by the analyzer/DNA seat)
 * enforces that no derived DNA/archetype artifact copies competitor copy. Here, ingestion's job is
 * to land the corpus correctly tagged so that downstream rule has the trust signal to enforce it.
 *
 * RETENTION (RD-9 / DD-18 / §11.2): every item is written with `captured_at` + `retention_class` so
 * engine/cli/purge-corpora.js manages it on the operator's purge cadence — one `.json` file per
 * item under $CONTENT_HOME/corpora/<brand>/ (the exact on-disk shape purge-corpora scans). Scraped
 * items default to `standard` retention; manual/export default to `retained` (operator-supplied
 * keepers). The operator overrides per call / per config.
 *
 * METERED-ACTION GATE (DD-18): a scrape is a metered action (it spends a provider quota). Before any
 * scrape, the caller presents a pre-run COST ESTIMATE (item count × per-item indicative estimate)
 * and requires confirmation — exactly the estimate-and-confirm contract `engine calibrate` /
 * `engine index-library` use. estimateScrapeCost() computes the indicative figure; ingestCorpus
 * refuses a metered scrape unless `opts.confirmed === true` (or `--yes` upstream).
 *
 * RD-12 / §12 seam-testability: the external provider call is INJECTABLE exactly like the §12.5
 * vision seam and the trend seam — adapters take a `fetchImpl` (and read an injectable `env`), so
 * tests run zero-key with the fixture adapter and fakes. No secrets in CI.
 *
 * Tier-3 cleanliness (§0.3 r6 / RD-3): paths via paths.js (never constructed here); no hardcoded
 * IDs/handles/absolute paths; no production persona codenames (the production "Pulse" trend-monitor
 * and the comparator-corpus one-off script names are retired); the only example brand downstream is
 * the synthetic "Acme Cosmos". Corpus item text is redacted at write through redact.js so a
 * secret-shaped value in a provider response can never survive into a written corpus item.
 */

const fs = require('fs');
const path = require('path');

const paths = require('../../shared/paths');
const { redact } = require('../../shared/redact');

// ---------------------------------------------------------------------------
// Vocabulary — corpus-item.schema.json enums + the account-side labels
// ---------------------------------------------------------------------------

/** corpus-item.schema.json `source` enum (how an item entered the corpus). */
const SOURCE = Object.freeze({
  PLATFORM: 'platform', // pulled via an adapter (scraper)
  MANUAL: 'manual', // operator hand-dropped a file
  EXPORT: 'export', // imported from an official account archive/export
});

/** corpus-item.schema.json `trust_class` enum (RD-8). Ingestion always writes untrusted-scraped. */
const TRUST_CLASS = Object.freeze({
  UNTRUSTED_SCRAPED: 'untrusted-scraped', // Zone U — the default for anything scraped/third-party
  OPERATOR_CURATED: 'operator-curated', // the promoted class — requires an attestation (RD-8)
});

/** corpus-item.schema.json `retention_class` enum (RD-9; drives purge-corpora windows). */
const RETENTION_CLASS = Object.freeze({
  TRANSIENT: 'transient', // shortest window (purge-corpora default 7d)
  STANDARD: 'standard', // config retention.raw_corpus_days (default 90d)
  RETAINED: 'retained', // never auto-purged
});

const VALID_RETENTION = Object.freeze(new Set(Object.values(RETENTION_CLASS)));

/**
 * The account class an ingested item belongs to. NOT a corpus-item.schema.json field (the schema is
 * additionalProperties:false) — it is carried in the RESULT and used to ROUTE the write into the
 * own/competitor sub-corpus and to set sensible retention defaults. own-account corpus is the
 * operator's own data (kept); competitor corpus is third-party analysis material.
 */
const ACCOUNT_CLASS = Object.freeze({
  OWN: 'own', // the operator's own account(s) — own-account corpus
  COMPETITOR: 'competitor', // a competitor/comparator account — competitor corpus (still Zone U)
});

const VALID_ACCOUNT_CLASS = Object.freeze(new Set(Object.values(ACCOUNT_CLASS)));

/**
 * Indicative per-item cost (USD) for a metered scrape — used ONLY for the pre-run estimate +
 * confirm gate (DD-18). It is deliberately a coarse, conservative placeholder: real provider
 * pricing varies wildly (an Apify-class actor bills per result / per compute unit), so the estimate
 * is marked indicative and the operator's `ingest.cost.per_item_usd` config overrides it. The point
 * is the GATE (show a number, require confirm before spend), not pricing accuracy (docs/cost.md).
 */
const DEFAULT_PER_ITEM_USD = 0.002;

// ---------------------------------------------------------------------------
// The adapter interface (the §12.2 scraper adapter contract, specialized to ingestion)
// ---------------------------------------------------------------------------

/**
 * The single method every ingestion adapter MUST implement. Kept to one method (like the trend
 * seam) because an ingestion source only FETCHES — it does not analyze, publish, or report.
 *
 *   fetch({ account, competitors, since, platform, max, env, fetchImpl, signal }) -> Promise<RawItem[]>
 *
 *     account      string|null   the operator's own-account handle to pull (own-account corpus).
 *     competitors  string[]      competitor/comparator handles to pull (competitor corpus, Zone U).
 *     since        string|null   ISO date-time lower bound; the adapter pulls items captured after it.
 *     platform     string        the platform descriptor id the pull is scoped to (e.g. 'twitter').
 *     max          number|null   per-account cap (also feeds the cost estimate).
 *     env          object        injectable env (default process.env) — credentials read BY NAME.
 *     fetchImpl    function      injectable network call (RD-12 seam) — adapter defaults to global fetch.
 *     signal       AbortSignal   optional abort signal.
 *
 *   Returns zero or more RAW items (loose provider shapes); the source layer normalizes each into a
 *   schemas/inputs/corpus-item.schema.json item, FORCES trust_class=untrusted-scraped, stamps the
 *   account_class, redacts, and writes one .json per item. An adapter that cannot reach its provider
 *   returns [] (degrade — the manual path remains) or throws — it MUST NOT fabricate items.
 *
 *   A RAW item is duck-typed and tolerant (normalizeItem maps common shapes):
 *     { text|content|full_text, captured_at|created_at|date, url|link, author|handle|username,
 *       media_refs|media|media_keys, account_class('own'|'competitor'), account|handle }
 */
const REQUIRED_METHODS = Object.freeze(['fetch']);

/** Thrown when ingestCorpus is asked to run a scrape adapter while the pathway is disabled. */
class IngestDisabledError extends Error {
  constructor() {
    super(
      'The scraper ingestion pathway is disabled. It ships OFF by default; opt in by setting ' +
        '`ingest.enabled: true` (and an `ingest.adapter`) in config/system.json (§2.4 / RD-9). ' +
        'No provider is contacted and no credential is read while it is disabled. The MANUAL ' +
        'submission and OFFICIAL-ACCOUNT EXPORT intake paths need no opt-in and are always available.',
    );
    this.name = 'IngestDisabledError';
  }
}

/** Thrown when a metered scrape is attempted without the DD-18 estimate-and-confirm. */
class IngestNotConfirmedError extends Error {
  constructor(estimate) {
    super(
      `A scrape is a metered action and was not confirmed. Estimated ~${estimate.item_estimate} ` +
        `item(s) at ~$${estimate.per_item_usd}/item ≈ $${estimate.total_usd_estimate} (indicative; ` +
        `docs/cost.md). Re-run with confirmation (opts.confirmed=true / the CLI --yes flag) to spend. ` +
        `The manual-submission and export paths are free and need no confirmation.`,
    );
    this.name = 'IngestNotConfirmedError';
    this.estimate = estimate;
  }
}

/** Thrown when a name is asked of the registry that no adapter is registered under. */
class IngestAdapterNotRegisteredError extends Error {
  constructor(name, available) {
    const list = (available || []).join(', ') || '(none)';
    super(
      `No ingestion adapter registered as "${name}". Registered adapters: ${list}. ` +
        `Register one via engine/sources/ingest/source.js#register, or set ingest.adapter to a ` +
        `shipped adapter (reference | fixture) in config/system.json. The MANUAL submission and ` +
        `EXPORT import paths (see engine/sources/ingest/manual.js) need no adapter.`,
    );
    this.name = 'IngestAdapterNotRegisteredError';
    this.adapter = name;
    this.available = available || [];
  }
}

// ---------------------------------------------------------------------------
// Adapter shape validation (duck-typed, like the trend/publisher seams)
// ---------------------------------------------------------------------------

/** @param {object} adapter @returns {string[]} missing/invalid method names (empty when conformant). */
function missingMethods(adapter) {
  if (!adapter || typeof adapter !== 'object') return [...REQUIRED_METHODS];
  return REQUIRED_METHODS.filter((m) => typeof adapter[m] !== 'function');
}

/** @param {object} adapter @returns {boolean} */
function isAdapter(adapter) {
  return missingMethods(adapter).length === 0;
}

// ---------------------------------------------------------------------------
// The registry — adapters self-register on require (reference-adapter.js,
// fixture-adapter.js call register at module load), mirroring the trend seam.
// ---------------------------------------------------------------------------

const _registry = new Map();

/**
 * Register an ingestion adapter under a name (the `ingest.adapter` config value, e.g. 'reference').
 * @param {string} name
 * @param {object} adapter must satisfy the one-method fetch contract.
 * @throws {Error} when the adapter is malformed (names the missing methods).
 */
function register(name, adapter) {
  if (!name || typeof name !== 'string') {
    throw new Error('register(name, adapter): name must be a non-empty string.');
  }
  const missing = missingMethods(adapter);
  if (missing.length) {
    throw new Error(
      `Ingestion adapter "${name}" does not satisfy the fetch contract; ` +
        `missing or non-function: ${missing.join(', ')}.`,
    );
  }
  _registry.set(name, adapter);
  return adapter;
}

/**
 * Resolve a registered adapter by name.
 * @param {string} name
 * @returns {object} the adapter.
 * @throws {IngestAdapterNotRegisteredError} when no adapter is registered under `name`.
 */
function get(name) {
  const adapter = _registry.get(name);
  if (!adapter) throw new IngestAdapterNotRegisteredError(name, [..._registry.keys()]);
  return adapter;
}

/** @param {string} name @returns {boolean} */
function has(name) {
  return _registry.has(name);
}

/** @returns {string[]} the names of all registered adapters. */
function list() {
  return [..._registry.keys()];
}

/** Test/teardown helper: drop a registration (or all, with no arg). */
function unregister(name) {
  if (name == null) {
    _registry.clear();
    return;
  }
  _registry.delete(name);
}

// ---------------------------------------------------------------------------
// Config gate (off by default) — the `ingest` block in config/system.json
// ---------------------------------------------------------------------------

/**
 * The shape of the operator's opt-in `ingest` block in config/system.json (the sibling config-schema
 * batch owns the authoritative schema; this is the field set this module reads, defensively):
 *   {
 *     enabled:  boolean    // default false — the OFF-by-default gate for the SCRAPER path (the LAW)
 *     adapter:  string     // registered adapter name ("reference" | "fixture" | operator's)
 *     platform: string     // descriptor id the pull is scoped to (default "twitter")
 *     max_per_account: number  // per-account cap (also feeds the cost estimate)
 *     retention_class: "transient"|"standard"|"retained"  // default "standard" for scraped items
 *     private_terms: string[]  // extra redaction deny-list terms (privacy pre-pass, §13.3)
 *     provider: object     // adapter-specific provider config (§12.5-style block); opaque here
 *     cost: { per_item_usd: number }  // override the indicative per-item estimate (DD-18)
 *   }
 */
function ingestConfig(config = {}) {
  const i = (config && config.ingest) || {};
  const cost = (i.cost && typeof i.cost === 'object') ? i.cost : {};
  return {
    enabled: i.enabled === true, // strictly boolean true — anything else is OFF (fail-closed)
    adapter: typeof i.adapter === 'string' && i.adapter.trim() ? i.adapter.trim() : null,
    platform: typeof i.platform === 'string' && i.platform.trim() ? i.platform.trim() : 'twitter',
    max_per_account: Number.isFinite(i.max_per_account) && i.max_per_account > 0 ? Math.floor(i.max_per_account) : null,
    retention_class: VALID_RETENTION.has(i.retention_class) ? i.retention_class : RETENTION_CLASS.STANDARD,
    text_mode: resolveTextMode(i.text_mode),
    private_terms: Array.isArray(i.private_terms)
      ? i.private_terms.filter((s) => typeof s === 'string' && s.trim())
      : [],
    provider: (i.provider && typeof i.provider === 'object') ? i.provider : {},
    per_item_usd: Number.isFinite(cost.per_item_usd) && cost.per_item_usd >= 0 ? cost.per_item_usd : DEFAULT_PER_ITEM_USD,
  };
}

/** True when the operator has opted the SCRAPER ingestion pathway in. */
function isEnabled(config = {}) {
  return ingestConfig(config).enabled;
}

// ---------------------------------------------------------------------------
// Cost estimate for a metered scrape (DD-18 estimate-and-confirm)
// ---------------------------------------------------------------------------

/**
 * Compute the indicative pre-run cost of a scrape (count + per-item estimate). This is the DD-18
 * estimate the caller shows BEFORE spending and the gate ingestCorpus enforces (refuse unless
 * confirmed). The item estimate = (1 own-account + N competitor accounts) × per-account max.
 *
 * It is INDICATIVE (docs/cost.md): real provider pricing varies; the override is
 * config.ingest.cost.per_item_usd. The contract being honest is the gate, not the number.
 *
 * @param {object} opts { account, competitors, max, perItemUsd }
 * @returns {{ accounts:number, max_per_account:number, item_estimate:number,
 *             per_item_usd:number, total_usd_estimate:number, indicative:true }}
 */
function estimateScrapeCost(opts = {}) {
  const ownCount = opts.account ? 1 : 0;
  const competitorCount = Array.isArray(opts.competitors) ? opts.competitors.length : 0;
  const accounts = ownCount + competitorCount;
  const max = Number.isFinite(opts.max) && opts.max > 0 ? Math.floor(opts.max) : 100; // estimate default
  const perItemUsd = Number.isFinite(opts.perItemUsd) && opts.perItemUsd >= 0 ? opts.perItemUsd : DEFAULT_PER_ITEM_USD;
  const itemEstimate = accounts * max;
  const total = itemEstimate * perItemUsd;
  return {
    accounts,
    max_per_account: max,
    item_estimate: itemEstimate,
    per_item_usd: perItemUsd,
    total_usd_estimate: Math.round(total * 100) / 100,
    indicative: true,
  };
}

// ---------------------------------------------------------------------------
// Raw-item normalization -> schemas/inputs/corpus-item.schema.json
// ---------------------------------------------------------------------------

/** First defined of a set of candidate keys on an object (tolerant provider-shape mapping). */
function pick(obj, keys) {
  for (const k of keys) {
    if (obj && obj[k] != null && obj[k] !== '') return obj[k];
  }
  return undefined;
}

/** Coerce a media-ref-ish value into a string[] (CONTENT_HOME-relative refs). */
function coerceMediaRefs(value) {
  if (!Array.isArray(value)) return [];
  return value.map((m) => (typeof m === 'string' ? m : (m && (m.ref || m.url || m.key)) || '')).filter(Boolean);
}

/**
 * Map common engagement-count fields (or a pre-built `metrics` object) into the corpus-item.schema
 * `metrics` shape ({ likes, replies, reposts, bookmarks, impressions, … }, all non-negative numbers).
 * These public counts are what the ingestion analyzer uses to compute per-archetype engagement lift
 * and the highest-engagement timeline (release-spec §1.1/§1.2). Tolerant of provider field naming
 * (Apify/X variants); only numeric, non-negative values are kept; absent ⇒ undefined (item stays
 * text-only and the analyzer falls back to structural stats). The author/handle are NOT metrics.
 *
 * @param {object} raw  a loose provider item.
 * @returns {object|undefined} a metrics object, or undefined when no usable counts were found.
 */
function coerceMetrics(raw) {
  const num = (...keys) => {
    for (const k of keys) {
      const v = raw[k];
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v;
      if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) && Number(v) >= 0) return Number(v);
    }
    return undefined;
  };
  const pre = (raw && typeof raw.metrics === 'object' && raw.metrics) || {};
  const preNum = (...keys) => {
    for (const k of keys) {
      const v = pre[k];
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v;
    }
    return undefined;
  };
  const out = {};
  const likes = preNum('likes') ?? num('likeCount', 'favoriteCount', 'favorite_count', 'likes', 'like_count');
  const replies = preNum('replies') ?? num('replyCount', 'reply_count', 'replies');
  const reposts = preNum('reposts') ?? num('retweetCount', 'retweet_count', 'reposts', 'repostCount');
  const bookmarks = preNum('bookmarks') ?? num('bookmarkCount', 'bookmark_count', 'bookmarks');
  const impressions = preNum('impressions') ?? num('viewCount', 'view_count', 'views', 'impressions', 'impression_count');
  if (likes != null) out.likes = likes;
  if (replies != null) out.replies = replies;
  if (reposts != null) out.reposts = reposts;
  if (bookmarks != null) out.bookmarks = bookmarks;
  if (impressions != null) out.impressions = impressions;
  return Object.keys(out).length ? out : undefined;
}

/** Corpus text-storage modes (the C2 "keep as raw or stripped" intake choice). */
const TEXT_MODE = Object.freeze({
  RAW: 'raw',        // store the post text verbatim (default) — the fullest signal for voice analysis.
  STRIPPED: 'stripped', // store a cleaned, smaller form: URLs removed, whitespace collapsed.
});
const VALID_TEXT_MODE = Object.freeze(new Set(Object.values(TEXT_MODE)));

/**
 * DETERMINISTIC text cleanup for the `stripped` intake mode — shrink stored corpus text without
 * touching voice: drop URLs (noise for voice analysis), collapse whitespace/newline runs to single
 * spaces, strip zero-width characters, and trim. NEVER summarizes or paraphrases (that is the LLM
 * DNA-synthesis step, not this) and never changes word choice — it only removes non-voice bulk so the
 * corpus is smaller/cheaper to keep. Pure + lossless-for-voice. Returns '' only if the input was
 * URL/whitespace-only (the caller falls back to the trimmed original so an item is never lost here).
 */
function stripText(text) {
  return String(text == null ? '' : text)
    .replace(/https?:\/\/\S+/giu, ' ') // URLs → space (noise for voice)
    .replace(/\bwww\.\S+/giu, ' ')
    .replace(/[​-‍﻿]/gu, '') // zero-width chars
    .replace(/\s+/gu, ' ') // collapse all whitespace/newline runs
    .trim();
}

/** Resolve a text_mode token to a valid mode (default RAW; anything unknown falls back to RAW). */
function resolveTextMode(value) {
  return VALID_TEXT_MODE.has(value) ? value : TEXT_MODE.RAW;
}

/**
 * Normalize one RAW adapter item into a schemas/inputs/corpus-item.schema.json item. FORCES the
 * Zone-U trust class (never trusting the adapter to self-promote — model §8 defense in depth),
 * stamps captured_at + retention_class so purge-corpora manages it, and minimizes the author per the
 * RD-9 data-minimization posture (author is OPTIONAL and only carried when present). The input is
 * never mutated.
 *
 * The account_class ('own'|'competitor') is NOT a schema field (additionalProperties:false) — it is
 * returned on the side so the writer can route into the own/competitor sub-corpus. The schema item
 * itself carries only the public corpus-item fields.
 *
 * @param {object} raw  a loose provider/manual/export item.
 * @param {object} ctx  { source, retention_class, nowMs, accountClass }
 * @returns {{ item:object, accountClass:string }|null}  null when the item has no usable text.
 */
function normalizeItem(raw, ctx = {}) {
  if (!raw || typeof raw !== 'object') return null;

  const text = pick(raw, ['text', 'content', 'full_text', 'body']);
  if (typeof text !== 'string' || !text.trim()) return null; // no text => not a corpus item

  const source = SOURCE[String(ctx.source || '').toUpperCase()] || ctx.source || SOURCE.PLATFORM;
  const validSource = Object.values(SOURCE).includes(source) ? source : SOURCE.PLATFORM;

  const capturedRaw = pick(raw, ['captured_at', 'created_at', 'createdAt', 'date', 'timestamp']);
  const capturedAt = (() => {
    if (capturedRaw == null) return new Date(Number.isFinite(ctx.nowMs) ? ctx.nowMs : Date.now()).toISOString();
    const t = Date.parse(capturedRaw);
    return Number.isFinite(t) ? new Date(t).toISOString() : new Date(Number.isFinite(ctx.nowMs) ? ctx.nowMs : Date.now()).toISOString();
  })();

  const retentionClass = VALID_RETENTION.has(ctx.retention_class) ? ctx.retention_class : RETENTION_CLASS.STANDARD;

  // account_class label: explicit on the raw item wins, else the ctx default, else competitor (the
  // conservative default — an unlabeled scraped item is treated as third-party, not own).
  const rawAccountClass = pick(raw, ['account_class', 'accountClass']);
  const accountClass = VALID_ACCOUNT_CLASS.has(rawAccountClass)
    ? rawAccountClass
    : (VALID_ACCOUNT_CLASS.has(ctx.accountClass) ? ctx.accountClass : ACCOUNT_CLASS.COMPETITOR);

  // The schema item — additionalProperties:false, so ONLY the allowed keys. Optional keys are
  // omitted (not nulled) when absent — the schema wants a string when present, and absence validates.
  // Intake text mode (C2 "raw vs stripped"): `stripped` stores a cleaned, smaller form; if stripping
  // would empty an otherwise-textful item (URL-only post), keep the trimmed original — never drop here.
  const textMode = resolveTextMode(ctx.textMode);
  const finalText = textMode === TEXT_MODE.STRIPPED ? (stripText(text) || text.trim()) : text.trim();

  const item = {
    source: validSource,
    captured_at: capturedAt,
    text: finalText,
    // FORCED Zone U — ingestion never self-promotes; operator attestation (a later, explicit action)
    // is the only path to operator-curated (RD-8). attestation is therefore absent here.
    trust_class: TRUST_CLASS.UNTRUSTED_SCRAPED,
    retention_class: retentionClass,
  };

  const author = pick(raw, ['author', 'handle', 'username', 'screen_name']);
  if (typeof author === 'string' && author.trim()) item.author = author.trim();

  const url = pick(raw, ['url', 'link', 'permalink']);
  if (typeof url === 'string' && url.trim()) item.url = url.trim();

  const mediaRefs = coerceMediaRefs(pick(raw, ['media_refs', 'media', 'media_keys', 'attachments']));
  if (mediaRefs.length) item.media_refs = mediaRefs;

  // Public engagement counts (likes/replies/reposts/bookmarks/impressions) — the signal the
  // analyzer uses for per-archetype lift + the highest-engagement timeline (§1.1/§1.2). Optional.
  const metrics = coerceMetrics(raw);
  if (metrics) item.metrics = metrics;

  return { item, accountClass };
}

// ---------------------------------------------------------------------------
// Corpus-item validation (the fail-fast subset of corpus-item.schema.json, §6.2)
// ---------------------------------------------------------------------------

/**
 * Structurally validate a corpus item against the §6.2 shape WITHOUT a JSON-Schema runtime (the
 * engine ships no ajv dependency; the strict gate is scripts/validate-schemas.js in CI). Checks the
 * load-bearing invariants so a malformed item fails loudly at the source, not later. Mirrors the
 * trend seam's validateReport.
 *
 *   - required: source(enum), captured_at, text, trust_class(enum), retention_class(enum)
 *   - the Zone-U invariant: trust_class MUST be untrusted-scraped here (ingestion never writes
 *     operator-curated — that needs an attestation the operator adds later).
 *   - operator-curated would require an attestation; ingestion never emits it, so we assert against it.
 *
 * @param {object} item
 * @returns {string[]} list of problems (empty when conformant).
 */
function validateItem(item) {
  const errs = [];
  if (!item || typeof item !== 'object') return ['item is not an object'];

  if (!Object.values(SOURCE).includes(item.source)) {
    errs.push(`source must be one of ${Object.values(SOURCE).join(', ')}`);
  }
  if (typeof item.captured_at !== 'string' || !Number.isFinite(Date.parse(item.captured_at))) {
    errs.push('captured_at must be an ISO date-time string');
  }
  if (typeof item.text !== 'string' || !item.text.trim()) {
    errs.push('text is required (non-empty string)');
  }
  if (item.trust_class !== TRUST_CLASS.UNTRUSTED_SCRAPED) {
    // Ingestion ALWAYS writes Zone U; operator-curated is reached only by a later attestation.
    errs.push('trust_class MUST be "untrusted-scraped" on ingest (Zone U — RD-8; promotion is a later operator action)');
  }
  if (!VALID_RETENTION.has(item.retention_class)) {
    errs.push(`retention_class must be one of ${[...VALID_RETENTION].join(', ')} (RD-9 — so purge-corpora manages it)`);
  }
  return errs;
}

// ---------------------------------------------------------------------------
// Corpus-item writer — writes Zone-U items under CONTENT_HOME via paths.js (RD-3)
// ---------------------------------------------------------------------------

/** Sanitize a string into a filesystem-safe stem. */
function safeStem(s, fallback = 'item') {
  return (
    String(s == null ? fallback : s)
      .trim()
      .replace(/[^a-zA-Z0-9._-]+/gu, '-')
      .replace(/^-+|-+$/gu, '')
      .slice(0, 120) || fallback
  );
}

/**
 * The target directory for a brand's corpus under $CONTENT_HOME (RD-3 — derived ONLY via paths.js,
 * never constructed here). Items are routed into an own/ or competitor/ sub-corpus so the analyzer
 * and the operator can tell them apart at a glance; purge-corpora still scans the whole tree under
 * corpora/<brand>/ (it recurses brand dirs and reads every .json) — the sub-dir is a label, not a
 * retention boundary.
 *
 * NOTE: purge-corpora.js (current) lists *.json directly under corpora/<brand>/. To keep BOTH the
 * own/competitor labeling AND purge-corpora coverage, the writer ALSO encodes the account_class in
 * the FILENAME (own-… / competitor-…) and writes flat under corpora/<brand>/. This guarantees
 * purge-corpora manages every item today, while the filename prefix preserves the own/competitor
 * label for the analyzer and the operator.
 */
function corpusDir(brand, env = process.env) {
  if (!brand) {
    throw new Error('corpusDir: a brand id is required (corpora are brand-keyed, DD-10).');
  }
  return paths.brandCorpusDir(String(brand), env);
}

/**
 * Write one corpus item to disk, redacted-at-write (§13.3). The item is INSTANCE DATA — it lives
 * under $CONTENT_HOME/corpora/<brand>/, never in the repo (model §13.2 — scraped corpora never enter
 * the repo, §18.2(3)). Atomic (tmp + rename) so a crash never leaves a half-written item. One file
 * per item is the shape engine/cli/purge-corpora.js scans (it reads every .json under the brand dir
 * and purges by captured_at + retention_class).
 *
 * The filename encodes account_class + a stable-ish stem so re-running ingestion is idempotent for
 * the same source item (same url/author/captured_at => same filename => overwrite, not duplicate —
 * §2.1 "re-running setup MUST NOT re-bill scrapes" is the caller's gate; this keeps the on-disk set
 * de-duplicated when the same item is seen twice).
 *
 * @param {object} item         a normalized, validated corpus item.
 * @param {object} opts         { env, brand, accountClass, privateTerms }
 * @returns {string} the absolute path the item was written to.
 */
function writeItem(item, opts = {}) {
  const env = opts.env || process.env;
  const brand = opts.brand;
  const accountClass = VALID_ACCOUNT_CLASS.has(opts.accountClass) ? opts.accountClass : ACCOUNT_CLASS.COMPETITOR;
  const dir = corpusDir(brand, env);
  fs.mkdirSync(dir, { recursive: true });

  // A stable filename: account_class + author + a short content/url fingerprint + captured stamp.
  // This makes re-ingesting the SAME item overwrite rather than duplicate (idempotent on disk).
  const stamp = safeStem(item.captured_at, 'undated');
  const who = safeStem(item.author || 'anon', 'anon');
  const fp = fingerprint(item);
  const file = path.join(dir, `${accountClass}-${who}-${stamp}-${fp}.json`);

  // Redact at write: corpus items are Zone-U external text and may carry provider artifacts; the
  // privacy pre-pass extends the deny-list with operator private terms (§13.3 redact-at-write).
  const safe = redact(item, { extraKeys: opts.privateTerms || [] });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(safe, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
  return file;
}

/** A short, stable fingerprint of an item (url || text), for the idempotent filename. No crypto dep. */
function fingerprint(item) {
  const basis = String((item && (item.url || item.text)) || '');
  let h = 5381;
  for (let i = 0; i < basis.length; i += 1) {
    h = ((h << 5) + h + basis.charCodeAt(i)) >>> 0; // djb2
  }
  return h.toString(36).slice(0, 10);
}

// ---------------------------------------------------------------------------
// Shared normalize-validate-write pipeline (used by adapters AND manual/export)
// ---------------------------------------------------------------------------

/**
 * Normalize, validate, (optionally) write a batch of RAW items. The ONE place every intake path —
 * adapter, manual, export — funnels through, so the trust-tagging, redaction, retention stamping,
 * and corpora layout are identical regardless of how an item arrived (RD-8/RD-9 uniformity). Used by
 * ingestCorpus and by manual.js's importers.
 *
 * @param {object[]} rawItems  loose items from any source.
 * @param {object} ctx  { env, brand, source, retention_class, accountClass, privateTerms, write, nowMs }
 * @returns {{ items:object[], written:string[], invalid:Array<{index,errors}>,
 *             by_class:{own:number, competitor:number} }}
 */
function ingestRawItems(rawItems, ctx = {}) {
  const env = ctx.env || process.env;
  const list = Array.isArray(rawItems) ? rawItems : rawItems == null ? [] : [rawItems];
  const nowMs = Number.isFinite(ctx.nowMs) ? ctx.nowMs : Date.now();

  const items = [];
  const written = [];
  const invalid = [];
  const byClass = { own: 0, competitor: 0 };

  list.forEach((raw, index) => {
    const norm = normalizeItem(raw, {
      source: ctx.source,
      retention_class: ctx.retention_class,
      accountClass: ctx.accountClass,
      textMode: ctx.textMode,
      nowMs,
    });
    if (!norm) {
      invalid.push({ index, errors: ['item has no usable text (skipped)'] });
      return;
    }
    const problems = validateItem(norm.item);
    if (problems.length) {
      invalid.push({ index, errors: problems });
      return; // a malformed item is dropped, not written — never land a bad corpus item
    }
    items.push({ ...norm.item, _account_class: norm.accountClass }); // _account_class is in-memory only
    byClass[norm.accountClass] = (byClass[norm.accountClass] || 0) + 1;

    if (ctx.write !== false) {
      written.push(
        writeItem(norm.item, {
          env,
          brand: ctx.brand,
          accountClass: norm.accountClass,
          privateTerms: ctx.privateTerms || [],
        }),
      );
    }
  });

  return { items, written, invalid, by_class: byClass };
}

// ---------------------------------------------------------------------------
// ingestCorpus — the one orchestration entry point (the seam's public verb)
// ---------------------------------------------------------------------------

/**
 * Ingest a brand/competitor corpus from the configured SCRAPER adapter, normalize + validate +
 * trust-tag each item, and (by default) write one .json per item under $CONTENT_HOME/corpora/<brand>/.
 * This is the SOURCE step only — it produces the CORPUS; it does NOT analyze, draft, or publish.
 *
 * NOTE on the three paths: this verb covers intake path (c) — the BYO SCRAPER. Paths (a) MANUAL and
 * (b) EXPORT do not run an adapter or spend a metered quota; they are in ./manual.js
 * (importManualSubmission, importAccountExport) and are always available (the cold-start fallback,
 * DD-21). ingestCorpus re-exports them via the index so callers have one import surface.
 *
 * CONFIG GATE (off by default): unless `ingest.enabled === true` in config, this throws
 * IngestDisabledError and contacts no provider, reads no credential.
 *
 * METERED-ACTION GATE (DD-18): a scrape spends a provider quota. ingestCorpus computes the cost
 * estimate and REFUSES (IngestNotConfirmedError) unless opts.confirmed === true. The caller (the C2
 * setup checkpoint / a CLI verb) shows estimate first, then re-calls with confirmed:true.
 *
 * @param {object} [opts]
 * @param {object}   [opts.config]       parsed config/system.json — supplies the `ingest` block.
 * @param {object}   [opts.env]          env to read (default process.env) — injectable for tests.
 * @param {function} [opts.fetchImpl]    injectable provider call (RD-12 seam) — passed to the adapter.
 * @param {string}   [opts.adapter]      adapter name override (else config.ingest.adapter).
 * @param {string}   [opts.brand]        REQUIRED brand id (corpora are brand-keyed, DD-10).
 * @param {string}   [opts.account]      the operator's own-account handle (own-account corpus).
 * @param {string[]} [opts.competitors]  competitor/comparator handles (competitor corpus, Zone U).
 * @param {string}   [opts.since]        ISO lower-bound; the adapter pulls items captured after it.
 * @param {string}   [opts.platform]     platform descriptor id (else config.ingest.platform).
 * @param {number}   [opts.max]          per-account cap (else config.ingest.max_per_account).
 * @param {string}   [opts.retention_class] retention class for written items (else config default).
 * @param {boolean}  [opts.confirmed]    DD-18 estimate-and-confirm — REQUIRED true to spend.
 * @param {boolean}  [opts.write]        write items to disk (default true; false = return only).
 * @param {AbortSignal} [opts.signal]    optional abort signal forwarded to the adapter.
 * @returns {Promise<{ ran:boolean, adapter:string, platform:string, estimate:object,
 *                      items:object[], written:string[], invalid:Array, by_class:object }>}
 * @throws {IngestDisabledError}              when the scraper pathway is disabled (off-by-default).
 * @throws {IngestNotConfirmedError}          when a metered scrape is unconfirmed (DD-18).
 * @throws {IngestAdapterNotRegisteredError}  when no adapter is configured/registered.
 */
async function ingestCorpus(opts = {}) {
  const env = opts.env || process.env;
  const config = opts.config || {};
  const cfg = ingestConfig(config);

  // The gate: scraper path is off by default. Refuse before touching any adapter or credential.
  if (!cfg.enabled) throw new IngestDisabledError();

  if (!opts.brand) {
    throw new Error('ingestCorpus: opts.brand is required — corpora are brand-keyed (DD-10).');
  }

  const adapterName = opts.adapter || cfg.adapter;
  if (!adapterName) throw new IngestAdapterNotRegisteredError(null, list());
  const adapter = get(adapterName); // throws IngestAdapterNotRegisteredError if absent

  const platform = opts.platform || cfg.platform;
  const competitors = Array.isArray(opts.competitors) ? opts.competitors.filter((c) => typeof c === 'string' && c.trim()) : [];
  const max = Number.isFinite(opts.max) && opts.max > 0 ? Math.floor(opts.max) : cfg.max_per_account;
  const retentionClass = VALID_RETENTION.has(opts.retention_class) ? opts.retention_class : cfg.retention_class;

  // DD-18 metered-action gate: estimate, then refuse unless confirmed.
  const estimate = estimateScrapeCost({
    account: opts.account,
    competitors,
    max,
    perItemUsd: cfg.per_item_usd,
  });
  if (opts.confirmed !== true) throw new IngestNotConfirmedError(estimate);

  const fetchArgs = {
    account: opts.account || null,
    competitors,
    since: opts.since || null,
    platform,
    max,
    provider: cfg.provider,
    env,
    fetchImpl: opts.fetchImpl, // injectable provider call (RD-12); adapter defaults to global fetch
    signal: opts.signal,
  };

  const raw = await adapter.fetch(fetchArgs);
  const rawItems = Array.isArray(raw) ? raw : raw == null ? [] : [raw];

  const textMode = resolveTextMode(opts.textMode != null ? opts.textMode : cfg.text_mode);
  const result = ingestRawItems(rawItems, {
    env,
    brand: opts.brand,
    source: SOURCE.PLATFORM, // adapter pulls are `platform`-sourced
    retention_class: retentionClass,
    textMode,
    accountClass: null, // each item self-labels own/competitor; unlabeled => competitor (conservative)
    privateTerms: cfg.private_terms,
    write: opts.write,
    nowMs: Date.now(),
  });

  return {
    ran: true,
    adapter: adapterName,
    platform,
    estimate,
    items: result.items,
    written: result.written,
    invalid: result.invalid,
    by_class: result.by_class,
  };
}

module.exports = {
  // Vocabulary (corpus-item.schema.json enums + account-side labels).
  SOURCE,
  TRUST_CLASS,
  RETENTION_CLASS,
  VALID_RETENTION,
  ACCOUNT_CLASS,
  VALID_ACCOUNT_CLASS,
  TEXT_MODE,
  VALID_TEXT_MODE,
  stripText,
  resolveTextMode,
  DEFAULT_PER_ITEM_USD,
  // Config gate (off by default for the scraper path).
  ingestConfig,
  isEnabled,
  // The adapter contract + registry (mirrors the trend/publisher seams).
  REQUIRED_METHODS,
  IngestDisabledError,
  IngestNotConfirmedError,
  IngestAdapterNotRegisteredError,
  missingMethods,
  isAdapter,
  register,
  get,
  has,
  list,
  unregister,
  // Cost estimate (DD-18).
  estimateScrapeCost,
  // Normalize / validate / write (under CONTENT_HOME via paths.js).
  normalizeItem,
  coerceMetrics,
  validateItem,
  corpusDir,
  writeItem,
  fingerprint,
  ingestRawItems,
  // The orchestration entry point (the LAW: export ingestCorpus).
  ingestCorpus,
};
