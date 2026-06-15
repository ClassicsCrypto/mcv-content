'use strict';

/**
 * engine/sources/ingest/fixture-adapter.js  [N net-new]
 *
 * The FIXTURE brand/competitor ingestion adapter (release-spec §5 zero-key fixture set; model §13.1
 * zero-key Tests bar; RD-12 "tests run zero-key with fakes, no secrets in CI"). It satisfies the
 * same one-method `fetch` contract as the reference adapter but contacts NO provider and reads NO
 * credential — it returns a deterministic, synthetic set of raw items (one synthetic OWN account +
 * synthetic COMPETITOR accounts) so the ingestion pathway can be exercised end-to-end
 * (fetch → normalize → trust-tag → validate → write) on a fresh clone with zero keys.
 *
 * This is the ingestion analogue of the recorded-fixture stages in `engine fixture-run` (§5.4): the
 * deterministic spine runs live; the external scrape is replaced by canned synthetic data.
 *
 * SYNTHETIC ONLY (the LAW / model §13.3 r1): the sample uses the fixtures' "Acme Cosmos" world and
 * clearly invented competitor names ("Nova Drift", "Comet Forge") and handles — NO real handles, NO
 * real brand/competitor names, NO real post data. Competitor items are carried for PATTERN analysis
 * only; nothing here is real copy. Everything is Zone U (the source forces trust_class).
 *
 * Registers itself as "fixture" on require.
 */

const { register } = require('./source');

const ADAPTER_NAME = 'fixture';

/**
 * Synthetic OWN-account items (the "Acme Cosmos" brand's own posts). Kept here (not in fixtures/ on
 * disk) so the adapter is self-contained for unit tests; the on-disk fixture brand mirrors the same
 * "Acme Cosmos" world (§5.1). account_class 'own' => own-account corpus.
 */
const FIXTURE_OWN = Object.freeze([
  {
    text: 'We shipped the synthetic star-map this week. Three new constellations, all explorable.',
    account_class: 'own',
    author: 'acme_cosmos',
    captured_at: '2026-06-01T14:00:00.000Z',
    url: 'https://example.test/acme-cosmos/star-map',
  },
  {
    text: 'GM explorers. The synthetic comet returns to the timeline at dawn — who is watching?',
    account_class: 'own',
    author: 'acme_cosmos',
    captured_at: '2026-06-02T11:30:00.000Z',
    url: 'https://example.test/acme-cosmos/gm-comet',
  },
]);

/**
 * Synthetic COMPETITOR items (invented comparator accounts). account_class 'competitor' => competitor
 * corpus (Zone U; PATTERNS only — never republished). These are the "what the market rewards" signal
 * the analyzer reads, mirroring the production comparator-corpus archetype work — but fully synthetic.
 */
const FIXTURE_COMPETITORS = Object.freeze([
  {
    text: 'Introducing the Nova Drift season pass — now live. Limited synthetic edition, only 500.',
    account_class: 'competitor',
    author: 'nova_drift',
    captured_at: '2026-06-01T16:00:00.000Z',
    url: 'https://example.test/nova-drift/season-pass',
  },
  {
    text: 'Soon. 👀',
    account_class: 'competitor',
    author: 'nova_drift',
    captured_at: '2026-06-02T09:00:00.000Z',
    url: 'https://example.test/nova-drift/teaser',
  },
  {
    text: 'Comet Forge x Acme-adjacent collab teaser. Something synthetic is coming this week.',
    account_class: 'competitor',
    author: 'comet_forge',
    captured_at: '2026-06-03T13:00:00.000Z',
    url: 'https://example.test/comet-forge/collab',
  },
]);

/**
 * fetch(args) -> RawItem[] — returns a deterministic synthetic mix of OWN + COMPETITOR raw items.
 * Honors `account` (returns the OWN items when an own account is requested) and `competitors`
 * (returns the COMPETITOR items when any competitor handles are requested); with neither it returns
 * the full set so the pathway can always be exercised. Honors `max` as a per-class cap. Zero network,
 * zero credentials.
 *
 * @param {object} [args]  { account, competitors, since, platform, max, env }
 * @returns {Promise<object[]>}
 */
async function fetch(args = {}) {
  const wantOwn = !!(args && args.account);
  const wantCompetitors = !!(args && Array.isArray(args.competitors) && args.competitors.length);
  const max = Number.isFinite(args.max) && args.max > 0 ? Math.floor(args.max) : Infinity;

  let own = [];
  let competitors = [];
  if (wantOwn || (!wantOwn && !wantCompetitors)) own = FIXTURE_OWN.slice(0, max);
  if (wantCompetitors || (!wantOwn && !wantCompetitors)) competitors = FIXTURE_COMPETITORS.slice(0, max);

  // Optional `since` filter — drop items captured at/before the bound (exercises the plumbing).
  const sinceMs = args.since ? Date.parse(args.since) : NaN;
  const afterSince = (it) => !Number.isFinite(sinceMs) || Date.parse(it.captured_at) > sinceMs;

  return [...own, ...competitors].filter(afterSince).map((it) => ({ ...it }));
}

const adapter = {
  name: ADAPTER_NAME,
  fetch,
};

register(ADAPTER_NAME, adapter);

module.exports = adapter;
module.exports._internal = { FIXTURE_OWN, FIXTURE_COMPETITORS };
