'use strict';

/**
 * engine/sources/trends/fixture-adapter.js  [N net-new]
 *
 * The FIXTURE trend-source adapter (release-spec §5 zero-key fixture set; model §13.1 zero-key
 * Tests bar; RD-12 "tests run zero-key with fakes, no secrets in CI"). It satisfies the same
 * one-method poll contract as the reference adapter but contacts NO provider and reads NO
 * credential — it returns a deterministic, synthetic §6.7 trend report so the trend pathway can be
 * exercised end-to-end (poll → normalize → validate → write → seed) on a fresh clone with zero keys.
 *
 * This is the trend-pathway analogue of the recorded-fixture stages in `engine fixture-run` (§5.4):
 * the deterministic spine runs live; the external fetch is replaced by canned synthetic data.
 *
 * SYNTHETIC ONLY (the LAW / model §13.3 r1): the sample uses the fixtures' "Acme Cosmos" brand and
 * clearly invented topics — no real handles, no real brand names, no real trend data. suggested_
 * angles are ANGLES ONLY, never drafted comment/reply text (spec §1.4 principle). Everything is
 * Zone U.
 *
 * Registers itself as "fixture" on require.
 */

const { register } = require('./source');

const ADAPTER_NAME = 'fixture';

/**
 * The synthetic fixture corpus — a small set of invented topics. Kept here (not in fixtures/ on
 * disk) so the adapter is self-contained for unit tests; the on-disk fixture brand mirrors the same
 * "Acme Cosmos" world (§5.1).
 */
const FIXTURE_TOPICS = Object.freeze([
  {
    topic: 'Synthetic comet flyby trends on the synthetic timeline',
    source_links: ['https://example.test/acme-cosmos/comet'],
    suggested_angles: [
      'Tie the comet imagery to the brand’s exploration pillar',
      'Ask the audience which synthetic constellation they would name after it',
    ],
  },
  {
    topic: 'Community speculation about a synthetic season-two reveal',
    source_links: ['https://example.test/acme-cosmos/season-two'],
    suggested_angles: [
      'Acknowledge the speculation without confirming unreleased details',
      'Resurface an evergreen lore thread that the speculation echoes',
    ],
  },
]);

/**
 * poll(args) -> TrendReport[] — returns one deterministic synthetic report. Honors the requested
 * cadence for the period window and accepts (but does not require) themes/brand. Zero network, zero
 * credentials. The `nowMs`/`fetchImpl` injectables let tests pin the timestamps without a real clock.
 *
 * @param {object} [args]  { cadence, themes, brand, env, nowMs }
 * @returns {Promise<object[]>}
 */
async function poll(args = {}) {
  const cadence = args.cadence || '12h';
  const windowHours =
    cadence === '2h' ? 2 : cadence === '4h' ? 4 : cadence === '8h' ? 8 : 12;
  const nowMs = Number.isFinite(args.nowMs) ? args.nowMs : Date.now();
  const now = new Date(nowMs);

  // Optionally filter the fixture topics by the supplied themes (substring match) so a test can
  // exercise the themes plumbing; with no themes, all fixture topics are returned.
  const themes = Array.isArray(args.themes) ? args.themes.map((t) => String(t).toLowerCase()) : [];
  const topics = themes.length
    ? FIXTURE_TOPICS.filter((t) => themes.some((th) => t.topic.toLowerCase().includes(th)))
    : [...FIXTURE_TOPICS];
  const selected = topics.length ? topics : [...FIXTURE_TOPICS]; // never return an empty topic set

  const report = {
    period: {
      start: new Date(nowMs - windowHours * 60 * 60 * 1000).toISOString(),
      end: now.toISOString(),
    },
    platform: (args && args.platform) || 'twitter',
    topics: selected.map((t) => ({ ...t })),
    provenance: {
      trust_zone: 'U',
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
module.exports._internal = { FIXTURE_TOPICS };
