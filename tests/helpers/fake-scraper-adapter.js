'use strict';

/**
 * tests/helpers/fake-scraper-adapter.js  [BD-FIXTURES]
 *
 * Zero-key fake SCRAPER adapter for the data-ingestion / brand-identity pathway (release-spec
 * §1.1 Content Scraping, §1.2 Market Scraping; RD-9 scraping is BYO — NEVER bundled creds, the
 * operator is the data controller; RD-12 "CI holds no secrets — the external call MUST be
 * dependency-injectable so tests run ZERO-KEY with a fake").
 *
 * This is the ingestion counterpart of tests/helpers/fake-trend-adapter.js. The production
 * scraper is a BYO ADAPTER behind the §1.2/DD-10 adapter seam; a scrape returns Zone-U
 * (untrusted-scraped, RD-8) corpus items the engine trust-class-tags at write and stores under
 * $CONTENT_HOME/corpora/<brand>/. Scraping is a METERED action gated by a pre-run cost estimate
 * (DD-18); manual submission + official-account EXPORTS are the first-class, ungated path.
 *
 * The fake replays the canned arrays recorded in
 *   fixtures/brand-dna-acme/recorded/scrape-responses.json
 * keyed by a normalized `${platform}:${handle}` (handle lowercased, leading '@' stripped) — so a
 * test can drive the WHOLE ingest -> deterministic-analysis -> archetype -> DNA path with zero
 * keys, zero network, and zero real provider calls. The recordings MIRROR the on-disk fixture
 * corpora under fixtures/brand-dna-acme/corpora/acme-cosmos/ so the scraped path and the
 * manual-submission path yield the SAME expected analysis.
 *
 * Injection shape (matches a BYO scraper-adapter interface — RD-9 / DD-10):
 *   makeFakeScraperAdapter() -> { name, scrape, estimate, capabilities }
 *     scrape({ platform, handle, max_items }) => Promise<CorpusItem[]>
 *       Returns the recorded array (deep-cloned), each a corpus-item.schema.json item (Zone U).
 *       Respects max_items (slice). An unknown key THROWS (a test asking for an unrecorded scrape
 *       is a test bug, not a silent pass) — matching the engine's "never fabricate" rule; pass
 *       { onMissing: 'empty' } to instead resolve [] (degrade / cold-start path, DD-21).
 *     estimate({ handles, max_items_per_handle }) => { max_items, est_cost_usd, requires_confirm }
 *       The zero-spend pre-run cost estimate the DD-18 gate presents before scraping.
 *     capabilities() => static { name, methods, requires_key: false, platforms }.
 *
 * makeFakeScrape() returns just the scrape fn for code that injects the function directly.
 *
 * ALL FIXTURES ARE SYNTHETIC. The adapter holds NO credentials and performs NO I/O beyond reading
 * the recorded JSON. See fixtures/brand-dna-acme/PROVENANCE.md and fixtures/PROVENANCE.md.
 */

const fs = require('node:fs');
const path = require('node:path');

const RESPONSES_PATH = path.join(
  __dirname, '..', '..', 'fixtures', 'brand-dna-acme', 'recorded', 'scrape-responses.json',
);

/** Load + cache the recorded responses, stripping the documentation $comment key. */
let _cache = null;
function loadResponses() {
  if (_cache) return _cache;
  const raw = JSON.parse(fs.readFileSync(RESPONSES_PATH, 'utf8'));
  const out = {};
  for (const [key, val] of Object.entries(raw)) {
    if (key === '$comment') continue;
    out[key] = val;
  }
  _cache = out;
  return out;
}

/** Normalize a scrape query to the recording key `${platform}:${handle}` (handle lc, no '@'). */
function toKey(query = {}) {
  const platform = String(query.platform || '').trim().toLowerCase();
  const handle = String(query.handle || '').trim().toLowerCase().replace(/^@/, '');
  return `${platform}:${handle}`;
}

/** Deep clone via JSON so callers can mutate returned items without poisoning the fixture. */
function clone(obj) {
  return obj == null ? obj : JSON.parse(JSON.stringify(obj));
}

/**
 * Build the fake scrape(query) the ingestion flow injects.
 * @param {object} [opts]
 * @param {'throw'|'empty'} [opts.onMissing='throw']  behavior for an unrecorded query key.
 * @returns {function(object): Promise<object[]>}
 */
function makeFakeScrape(opts = {}) {
  const onMissing = opts.onMissing === 'empty' ? 'empty' : 'throw';
  const responses = loadResponses();
  return async function fakeScrape(query) {
    const key = toKey(query);
    let items;
    if (Object.prototype.hasOwnProperty.call(responses, key)) {
      items = clone(responses[key]);
    } else if (onMissing === 'empty') {
      return [];
    } else {
      throw new Error(
        `fake-scraper-adapter: no recorded response for "${key}" (have: ${Object.keys(responses).join(', ')})`,
      );
    }
    const max = Number(query && query.max_items);
    if (Number.isFinite(max) && max >= 0) items = items.slice(0, max);
    return items;
  };
}

/**
 * The zero-spend pre-run cost estimate the DD-18 gate presents before a scrape.
 * @param {object} [q]  { handles, max_items_per_handle }
 */
function estimate(q = {}) {
  const handles = Number(q.handles) || 0;
  const per = Number(q.max_items_per_handle) || 0;
  return {
    action: 'scrape',
    max_items: handles * per,
    est_cost_usd: 0,
    requires_confirm: true,
    note: 'fixture adapter — zero spend; a real BYO adapter quotes its own per-item cost',
  };
}

/**
 * Build a full fake adapter object conforming to a BYO scraper-adapter interface (RD-9 / DD-10).
 * @param {object} [opts]  same { onMissing } contract as makeFakeScrape.
 */
function makeFakeScraperAdapter(opts = {}) {
  const scrape = makeFakeScrape(opts);
  return {
    name: 'fixture-scraper-stub',
    scrape,
    estimate,
    capabilities() {
      return {
        name: 'fixture-scraper-stub',
        methods: ['scrape', 'estimate'],
        requires_key: false,
        platforms: recordedPlatforms(),
      };
    },
  };
}

/** All recorded query keys (handy for a test that iterates the fixture set). */
function recordedKeys() {
  return Object.keys(loadResponses());
}

/** Distinct platforms present across the recorded keys. */
function recordedPlatforms() {
  return [...new Set(recordedKeys().map((k) => k.split(':')[0]).filter(Boolean))];
}

module.exports = {
  RESPONSES_PATH,
  makeFakeScraperAdapter,
  makeFakeScrape,
  estimate,
  recordedKeys,
  recordedPlatforms,
  toKey,
};
