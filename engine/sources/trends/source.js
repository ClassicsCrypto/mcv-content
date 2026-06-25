'use strict';

/**
 * engine/sources/trends/source.js  [A adapted — production trend pathway was prompt-only,
 *                                    gap §2.2 trend row "the one whole spec pillar with zero
 *                                    implementation"; this is its first real, gated seam]
 *
 * The TREND SOURCE — roadmap automation #1 (release-spec §8.8 trend pathway scope; §2.7;
 * original-design-spec §2.7 trend catching; §1.4 reporting). A CONTENT SOURCE that produces
 * SEEDS feeding the EXISTING chain; it does NOT bypass it. A trend report becomes an idea/argument
 * pre-seed (spec §2.1) that the matcher/brief → writer → hybrid gate → package → queue → the HUMAN
 * approval card (the double gate, §2.4) all process exactly as for any other slot. NOTHING here
 * auto-publishes; SAFE is the default mode.
 *
 * This module is the SEAM + the registry + the report writer (the §12.1 #1 scraper/trend seam,
 * "interface declared + manual-submission path first-class; reference adapter optional — RD-9").
 * It mirrors the publisher seam (engine/publishers/publisher.js): a duck-typed adapter contract, a
 * self-registration registry, and one orchestration entry point.
 *
 * CONFIG-GATED, OFF BY DEFAULT (the LAW): the trend pathway ships disabled. `pollTrends` refuses to
 * run unless the operator opts in via the `trends` block in config/system.json with `enabled: true`.
 * No adapter is contacted, no provider key is read, and no report is written until that opt-in.
 *
 * DD-16 honored: a trend fills RESERVED calendar slots, never out-of-calendar (this module produces
 * the REPORT only; slot routing is the orchestrator/calendar's job). Reports carry a
 * freshness_window so the downstream trend-card TTL (DD-15) and DD-16 quote-retweet content_form
 * work; suggested_angles only — NEVER drafted comment/reply text (spec §1.4 principle).
 *
 * RD-9 honored: scraping/trend fetching is BYO. The reference adapter (reference-adapter.js) reads
 * a CONFIGURED provider through an injectable call and resolves credentials via secrets.js by env
 * NAME — it bundles no creds. The manual-submission path (a hand-authored trend-report.schema.json
 * file dropped into $CONTENT_HOME/trends/, or RUN_TREND_MANUAL, §6.1) is contractually equal and
 * always available, so vendor breakage never blocks the trend pathway (DR Risk 17).
 *
 * RD-12 / §12 seam-testability: the external provider call is INJECTABLE exactly like the §12.5
 * vision seam — adapters take a `fetchImpl` (and read an injectable `env`), so tests run zero-key
 * with the fixture adapter and fakes. No secrets in CI.
 *
 * Trust zone: everything an adapter returns is Zone U (untrusted external input — model §8). The
 * schema pins provenance.trust_zone to the const "U"; this module enforces it on write.
 *
 * Tier-3 cleanliness (§0.3 r6 / RD-3): no hardcoded IDs/handles/paths (paths.js derives the trends
 * dir under $CONTENT_HOME), no production persona codenames (the production "Pulse" trend-monitor
 * name is retired), no brand strings. Report bodies are redacted at write through redact.js.
 */

const fs = require('fs');
const path = require('path');

const paths = require('../../shared/paths');
const { redact } = require('../../shared/redact');

/**
 * The config-gated cadences (release-spec §8.8 roadmap: "scheduled trend polling … 2/4/8/12h
 * cadences"). A cadence names how often the operator's scheduler recipe invokes pollTrends; it is
 * carried into the adapter poll so a provider can window its query, and it feeds the report's
 * default freshness window. Off-list cadences are rejected fail-closed.
 */
const CADENCE = Object.freeze({
  H1: '1h',
  H2: '2h',
  H4: '4h',
  H8: '8h',
  H12: '12h',
  D1: '24h',
});

const VALID_CADENCES = Object.freeze(new Set(Object.values(CADENCE)));

/** Map a cadence token to milliseconds (for the default freshness window). */
const CADENCE_MS = Object.freeze({
  '1h': 1 * 60 * 60 * 1000,
  '2h': 2 * 60 * 60 * 1000,
  '4h': 4 * 60 * 60 * 1000,
  '8h': 8 * 60 * 60 * 1000,
  '12h': 12 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
});

/** ISO-8601 duration token for a cadence (the trend-report freshness_window basis). */
const CADENCE_DURATION = Object.freeze({
  '1h': 'PT1H', '2h': 'PT2H', '4h': 'PT4H', '8h': 'PT8H', '12h': 'PT12H', '24h': 'PT24H',
});

/**
 * The single method every trend-source adapter MUST implement (the §12.2 scraper/trend adapter
 * interface, specialized to trends): `poll`. Kept to one method (vs the publisher's four) because a
 * trend source only fetches — it does not publish, verify, or report metrics.
 *
 *   poll({ cadence, themes, brand, env, fetchImpl, signal }) -> Promise<TrendReport[]>
 *     Fetch the current trends and return zero or more reports conforming to
 *     schemas/inputs/trend-report.schema.json (§6.7). Each report MUST set
 *     provenance.method = "adapter" and provenance.trust_zone = "U". An adapter that cannot reach
 *     its provider returns [] (no reports) or throws — it MUST NOT fabricate a report.
 */
const REQUIRED_METHODS = Object.freeze(['poll']);

/**
 * Thrown when a name is asked of the registry that no adapter is registered under, or when a
 * registration is malformed. Typed so the orchestrator surfaces a precise wiring error (§15.1) and
 * `engine status` can name the missing adapter.
 */
class TrendSourceNotRegisteredError extends Error {
  constructor(name, available) {
    const list = (available || []).join(', ') || '(none)';
    super(
      `No trend-source adapter registered as "${name}". Registered adapters: ${list}. ` +
        `Register one via engine/sources/trends/source.js#register, or set ` +
        `trends.adapter to a shipped adapter (reference | fixture) in config/system.json. ` +
        `The manual-submission path (a trend-report file in $CONTENT_HOME/trends/) needs no adapter.`,
    );
    this.name = 'TrendSourceNotRegisteredError';
    this.adapter = name;
    this.available = available || [];
  }
}

/** Thrown when the trend pathway is invoked while disabled (the config gate, off by default). */
class TrendsDisabledError extends Error {
  constructor() {
    super(
      'The trend pathway is disabled. It ships OFF by default; opt in by setting ' +
        '`trends.enabled: true` (and a `trends.adapter`) in config/system.json (§8.8). ' +
        'No provider is contacted and no credential is read while it is disabled.',
    );
    this.name = 'TrendsDisabledError';
  }
}

// ---------------------------------------------------------------------------
// Adapter shape validation (duck-typed, like the publisher seam)
// ---------------------------------------------------------------------------

/**
 * @param {object} adapter
 * @returns {string[]} the missing/invalid method names (empty when conformant).
 */
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
// fixture-adapter.js call register at module load), mirroring the publisher seam.
// ---------------------------------------------------------------------------

const _registry = new Map();

/**
 * Register a trend-source adapter under a name (the `trends.adapter` config value, e.g. 'reference').
 * @param {string} name
 * @param {object} adapter  must satisfy the one-method poll contract.
 * @throws {Error} when the adapter is malformed (names the missing methods).
 */
function register(name, adapter) {
  if (!name || typeof name !== 'string') {
    throw new Error('register(name, adapter): name must be a non-empty string.');
  }
  const missing = missingMethods(adapter);
  if (missing.length) {
    throw new Error(
      `Trend-source adapter "${name}" does not satisfy the poll contract; ` +
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
 * @throws {TrendSourceNotRegisteredError} when no adapter is registered under `name`.
 */
function get(name) {
  const adapter = _registry.get(name);
  if (!adapter) throw new TrendSourceNotRegisteredError(name, [..._registry.keys()]);
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
// Config gate (off by default) + cadence resolution
// ---------------------------------------------------------------------------

/**
 * The shape of the operator's opt-in `trends` block in config/system.json (P1-SCH-CONFIG owns the
 * authoritative schema; this is the field set this module reads, defensively):
 *   {
 *     enabled:   boolean   // default false — the OFF-by-default gate (the LAW)
 *     adapter:   string    // registered adapter name ("reference" | "fixture" | operator's)
 *     cadence:   "2h"|"4h"|"8h"|"12h"   // default "12h" (the most conservative)
 *     themes:    string[]  // optional theme/topic hints passed to the adapter
 *     provider:  object    // adapter-specific provider config (§12.5-style block); opaque here
 *     private_terms: string[]  // extra redaction deny-list terms (privacy pre-pass, §13.3)
 *   }
 */
function trendsConfig(config = {}) {
  const t = (config && config.trends) || {};
  const cleanList = (v) => (Array.isArray(v) ? v.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim()) : []);
  return {
    enabled: t.enabled === true, // strictly boolean true — anything else is OFF (fail-closed)
    adapter: typeof t.adapter === 'string' && t.adapter.trim() ? t.adapter.trim() : null,
    cadence: VALID_CADENCES.has(t.cadence) ? t.cadence : CADENCE.H12,
    themes: cleanList(t.themes),
    // Tracked accounts + keywords (suggested by the manual-Grok kit, operator-CONFIRMED). The
    // daily/hourly tracking targets the Apify trend adapter pulls; ignored by adapters that don't use them.
    tracked_accounts: cleanList(t.tracked_accounts),
    keywords: cleanList(t.keywords),
    provider: (t.provider && typeof t.provider === 'object') ? t.provider : {},
    private_terms: cleanList(t.private_terms),
  };
}

/** True when the operator has opted the trend pathway in. */
function isEnabled(config = {}) {
  return trendsConfig(config).enabled;
}

/** Validate + normalize a cadence token, defaulting to 12h (the most conservative). */
function resolveCadence(cadence) {
  if (cadence == null) return CADENCE.H12;
  const c = String(cadence).trim();
  if (!VALID_CADENCES.has(c)) {
    throw new Error(
      `unknown trend cadence "${c}"; expected one of ${[...VALID_CADENCES].join(', ')} (§8.8).`,
    );
  }
  return c;
}

// ---------------------------------------------------------------------------
// Report validation (conforms to schemas/inputs/trend-report.schema.json, §6.7)
// ---------------------------------------------------------------------------

/**
 * Structurally validate a report against the §6.7 trend-report shape WITHOUT a JSON-Schema runtime
 * (the engine ships no ajv dependency; the strict gate is scripts/validate-schemas.js in CI). This
 * checks the load-bearing invariants so a malformed adapter fails loudly at the source, not later
 * in the chain. The full schema is the contract; this is the fail-fast subset.
 *
 *   - required: period{start,end}, platform, topics[>=1]{topic}, provenance{trust_zone:"U", method}
 *   - the trust-zone invariant (always U) is enforced, not merely defaulted
 *   - suggested_angles are angles only; this is a SHAPE check (array of strings) — the no-drafted-
 *     text principle (spec §1.4) is a content rule the gate seat enforces, not a structural one.
 *
 * @param {object} report
 * @returns {string[]} list of problems (empty when conformant).
 */
function validateReport(report) {
  const errs = [];
  if (!report || typeof report !== 'object') return ['report is not an object'];

  const period = report.period;
  if (!period || typeof period !== 'object') errs.push('period is required');
  else {
    if (!period.start) errs.push('period.start is required');
    if (!period.end) errs.push('period.end is required');
  }

  if (typeof report.platform !== 'string' || !report.platform.trim()) {
    errs.push('platform is required (non-empty string)');
  }

  if (!Array.isArray(report.topics) || report.topics.length < 1) {
    errs.push('topics must be a non-empty array');
  } else {
    report.topics.forEach((topic, i) => {
      if (!topic || typeof topic !== 'object') {
        errs.push(`topics[${i}] is not an object`);
        return;
      }
      if (typeof topic.topic !== 'string' || !topic.topic.trim()) {
        errs.push(`topics[${i}].topic is required (non-empty string)`);
      }
      if (topic.suggested_angles != null && !Array.isArray(topic.suggested_angles)) {
        errs.push(`topics[${i}].suggested_angles must be an array of strings`);
      }
      if (topic.source_links != null && !Array.isArray(topic.source_links)) {
        errs.push(`topics[${i}].source_links must be an array`);
      }
    });
  }

  const prov = report.provenance;
  if (!prov || typeof prov !== 'object') {
    errs.push('provenance is required');
  } else {
    if (prov.trust_zone !== 'U') {
      errs.push('provenance.trust_zone MUST be "U" (trend reports are always Zone U — §6.7)');
    }
    if (prov.method !== 'manual' && prov.method !== 'adapter') {
      errs.push('provenance.method must be "manual" or "adapter"');
    }
  }

  return errs;
}

/**
 * Stamp the trust-zone + a default freshness window onto a report the adapter produced, then
 * validate it. The trust zone is FORCED to "U" (never trusting the adapter to set it) — defense in
 * depth for the model §8 untrusted-input invariant. A missing freshness window is defaulted from
 * the cadence so the downstream DD-15 TTL always has a basis.
 *
 * @param {object} report   a report from an adapter's poll().
 * @param {object} ctx      { cadence, nowMs }
 * @returns {object} the normalized report (input not mutated).
 */
function normalizeReport(report, ctx = {}) {
  const cadence = ctx.cadence || CADENCE.H12;
  const nowMs = Number.isFinite(ctx.nowMs) ? ctx.nowMs : Date.now();
  const out = { ...(report || {}) };

  // Force the Zone-U provenance invariant; mark method=adapter when an adapter produced it.
  const prov = { ...(out.provenance || {}) };
  prov.trust_zone = 'U';
  if (prov.method !== 'manual') prov.method = 'adapter';
  if (!prov.submitted_at) prov.submitted_at = new Date(nowMs).toISOString();
  out.provenance = prov;

  // Default the freshness window from the cadence when the adapter did not supply one (DD-15 basis).
  if (!out.freshness_window || typeof out.freshness_window !== 'object') {
    const ms = CADENCE_MS[cadence] || CADENCE_MS['12h'];
    out.freshness_window = {
      duration: CADENCE_DURATION[cadence] || 'PT12H',
      expires_at: new Date(nowMs + ms).toISOString(),
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Report writer — writes Trend Reports under CONTENT_HOME via paths.js (RD-3)
// ---------------------------------------------------------------------------

/** Sanitize an id into a filesystem-safe stem. */
function safeStem(s) {
  return String(s || 'report')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 120) || 'report';
}

/**
 * The target directory for a brand's trend reports under $CONTENT_HOME (RD-3 — derived ONLY via
 * paths.js, never constructed here). A brand-less report lands in the shared trends dir.
 */
function reportDir(brand, env = process.env) {
  return brand ? paths.brandTrendsDir(String(brand), env) : paths.trendsDir(env);
}

/**
 * Write one trend report to disk, redacted-at-write (§13.3). The report is the §6.7 artifact and is
 * INSTANCE DATA — it lives under $CONTENT_HOME, never in the repo (model §13.2). Atomic (tmp +
 * rename) so a crash never leaves a half-written report.
 *
 * @param {object} report   a normalized, validated report.
 * @param {object} [opts]   { env, brand, privateTerms }
 * @returns {string} the absolute path the report was written to.
 */
function writeReport(report, opts = {}) {
  const env = opts.env || process.env;
  const brand = opts.brand || (report && report.brand) || null;
  const dir = reportDir(brand, env);
  fs.mkdirSync(dir, { recursive: true });

  const period = (report && report.period) || {};
  const stamp = safeStem(period.end || period.start || new Date().toISOString());
  const platform = safeStem((report && report.platform) || 'all');
  const file = path.join(dir, `trend-${platform}-${stamp}.json`);

  // Redact at write: the report is Zone-U external text + may carry provider artifacts; the privacy
  // pre-pass (work-recap shares this discipline) extends the deny-list with operator private terms.
  const safe = redact(report, { extraKeys: opts.privateTerms || [] });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(safe, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
  return file;
}

// ---------------------------------------------------------------------------
// pollTrends — the one orchestration entry point (the seam's public verb)
// ---------------------------------------------------------------------------

/**
 * Poll the configured trend-source adapter for the current trends, normalize + validate the
 * reports, and (by default) write them under $CONTENT_HOME. This is the SOURCE step only — it
 * produces SEED artifacts (trend reports). It does NOT enqueue, draft, gate, or publish anything;
 * the orchestrator picks reports up for trend-RESERVED calendar slots (DD-16) and runs them through
 * the normal chain to the human approval card (§2.4). NOTHING here auto-publishes.
 *
 * CONFIG GATE (off by default): unless `trends.enabled === true` in config, this throws
 * TrendsDisabledError and contacts no provider, reads no credential.
 *
 * @param {object} [opts]
 * @param {object}   [opts.config]      parsed config/system.json — supplies the `trends` block.
 * @param {object}   [opts.env]         env to read (default process.env) — injectable for tests.
 * @param {function} [opts.fetchImpl]   injectable provider call (RD-12 seam) — passed to the adapter.
 * @param {string}   [opts.adapter]     adapter name override (else config.trends.adapter).
 * @param {string}   [opts.cadence]     cadence override (else config.trends.cadence).
 * @param {string[]} [opts.themes]      theme hints override (else config.trends.themes).
 * @param {string}   [opts.brand]       brand id the reports are for (routes the write dir).
 * @param {boolean}  [opts.write]       write reports to disk (default true; false = return only).
 * @param {AbortSignal} [opts.signal]   optional abort signal forwarded to the adapter.
 * @returns {Promise<{ ran:boolean, adapter:string, cadence:string, reports:object[],
 *                      written:string[], invalid:Array<{index:number, errors:string[]}> }>}
 * @throws {TrendsDisabledError}            when the pathway is disabled (the off-by-default gate).
 * @throws {TrendSourceNotRegisteredError}  when no adapter is configured/registered.
 */
async function pollTrends(opts = {}) {
  const env = opts.env || process.env;
  const config = opts.config || {};
  const cfg = trendsConfig(config);

  // The gate: off by default. Refuse before touching any adapter or credential.
  if (!cfg.enabled) throw new TrendsDisabledError();

  const adapterName = opts.adapter || cfg.adapter;
  if (!adapterName) {
    throw new TrendSourceNotRegisteredError(null, list());
  }
  const adapter = get(adapterName); // throws TrendSourceNotRegisteredError if absent

  const cadence = resolveCadence(opts.cadence != null ? opts.cadence : cfg.cadence);
  const themes = Array.isArray(opts.themes) ? opts.themes : cfg.themes;
  const privateTerms = cfg.private_terms;

  const pollArgs = {
    cadence,
    themes,
    // Tracking targets — passed to adapters that use them (the Apify trend adapter); others ignore them.
    tracked_accounts: Array.isArray(opts.tracked_accounts) ? opts.tracked_accounts : cfg.tracked_accounts,
    keywords: Array.isArray(opts.keywords) ? opts.keywords : cfg.keywords,
    brand: opts.brand || null,
    provider: cfg.provider,
    env,
    fetchImpl: opts.fetchImpl, // injectable provider call (RD-12); adapter defaults it to global fetch
    signal: opts.signal,
  };

  const raw = await adapter.poll(pollArgs);
  const reports = Array.isArray(raw) ? raw : raw == null ? [] : [raw];

  const nowMs = Date.now();
  const normalized = [];
  const invalid = [];
  reports.forEach((r, index) => {
    const norm = normalizeReport(r, { cadence, nowMs });
    const problems = validateReport(norm);
    if (problems.length) {
      invalid.push({ index, errors: problems });
      return; // a malformed report is dropped, not written — never feed a bad seed into the chain
    }
    normalized.push(norm);
  });

  const written = [];
  if (opts.write !== false) {
    for (const r of normalized) {
      written.push(writeReport(r, { env, brand: opts.brand, privateTerms }));
    }
  }

  return {
    ran: true,
    adapter: adapterName,
    cadence,
    reports: normalized,
    written,
    invalid,
  };
}

module.exports = {
  // Cadences (§8.8) + the off-by-default config gate.
  CADENCE,
  VALID_CADENCES,
  CADENCE_MS,
  CADENCE_DURATION,
  trendsConfig,
  isEnabled,
  resolveCadence,
  // The adapter contract + registry (mirrors the publisher seam).
  REQUIRED_METHODS,
  TrendSourceNotRegisteredError,
  TrendsDisabledError,
  missingMethods,
  isAdapter,
  register,
  get,
  has,
  list,
  unregister,
  // Report validation + normalization + write (under CONTENT_HOME via paths.js).
  validateReport,
  normalizeReport,
  reportDir,
  writeReport,
  // The orchestration entry point.
  pollTrends,
};
