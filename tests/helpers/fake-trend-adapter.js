'use strict';

/**
 * tests/helpers/fake-trend-adapter.js  [SRC-FIXTURES]
 *
 * Zero-key fake TREND adapter for the trend-pathway source (release-spec §8.8 trend pathway;
 * §3.3 scraping/trend provider is BYO per RD-9 — never bundled creds; §6.7 trend report;
 * §2.1 seeding; §12 injectable seams; RD-12 "CI holds no secrets — the external call MUST be
 * dependency-injectable so tests run ZERO-KEY with a fake").
 *
 * This is the trend-pathway counterpart of tests/helpers/fake-vision.js. The production trend
 * pathway is a CONTENT SOURCE: a poll returns Zone-U TrendReports that become pre-seeds (§2.1),
 * NOT published comments — the reports feed the EXISTING chain (matcher → brief → writer → gate →
 * package → queue → the human approval card). NOTHING here auto-publishes; SAFE is the default.
 *
 * The fake replays the canned reports recorded in
 *   fixtures/trends-acme/recorded/trend-poll-responses.json
 * keyed by a normalized query key `${platform}:${window}` — so a test can exercise the WHOLE
 * source→seed path with zero keys, zero network, and zero real provider calls.
 *
 * Injection shape (matches a BYO trend-adapter interface — RD-9):
 *   makeFakeTrendAdapter() -> { poll, capabilities }
 *     poll({ platform, window }) => Promise<TrendReport[]>
 *       Returns the recorded array (deep-cloned) of objects shaped like
 *       schemas/inputs/trend-report.schema.json (provenance.method = 'adapter', Zone U).
 *       `window` defaults to 'daily'. An unknown key THROWS (a test asking for an unrecorded
 *       poll is a test bug, not a silent pass) — matching the engine's "never fabricate" rule;
 *       pass { onMissing: 'empty' } to instead resolve [] (degrade-to-no-trends path).
 *     capabilities() => static declaration { name, methods, requires_key: false }.
 *
 * makeFakePoll() returns just the poll fn for code that injects the function directly.
 *
 * ALL FIXTURES ARE SYNTHETIC. The adapter holds NO credentials and performs NO I/O beyond reading
 * the recorded JSON. See fixtures/trends-acme/PROVENANCE.md and fixtures/PROVENANCE.md.
 */

const fs = require('node:fs');
const path = require('node:path');

const RESPONSES_PATH = path.join(
  __dirname, '..', '..', 'fixtures', 'trends-acme', 'recorded', 'trend-poll-responses.json',
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

/** Normalize a poll query to the recording key `${platform}:${window}` (window defaults daily). */
function toKey(query = {}) {
  const platform = String(query.platform || '').trim().toLowerCase();
  const window = String(query.window || 'daily').trim().toLowerCase();
  return `${platform}:${window}`;
}

/** Deep clone via JSON so callers can mutate returned reports without poisoning the fixture. */
function clone(obj) {
  return obj == null ? obj : JSON.parse(JSON.stringify(obj));
}

/**
 * Build the fake poll(query) the trend source injects.
 * @param {object} [opts]
 * @param {'throw'|'empty'} [opts.onMissing='throw']  behavior for an unrecorded query key.
 * @returns {function(object): Promise<object[]>}
 */
function makeFakePoll(opts = {}) {
  const onMissing = opts.onMissing === 'empty' ? 'empty' : 'throw';
  const responses = loadResponses();
  return async function fakePoll(query) {
    const key = toKey(query);
    if (Object.prototype.hasOwnProperty.call(responses, key)) {
      return clone(responses[key]);
    }
    if (onMissing === 'empty') return [];
    throw new Error(
      `fake-trend-adapter: no recorded response for "${key}" (have: ${Object.keys(responses).join(', ')})`,
    );
  };
}

/**
 * Build a full fake adapter object conforming to a BYO trend-adapter interface (RD-9).
 * @param {object} [opts]  same { onMissing } contract as makeFakePoll.
 * @returns {{ poll: function, capabilities: function }}
 */
function makeFakeTrendAdapter(opts = {}) {
  const poll = makeFakePoll(opts);
  return {
    name: 'fixture-trend-stub',
    poll,
    capabilities() {
      return {
        name: 'fixture-trend-stub',
        methods: ['poll'],
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
  makeFakeTrendAdapter,
  makeFakePoll,
  recordedKeys,
  recordedPlatforms,
  toKey,
};
