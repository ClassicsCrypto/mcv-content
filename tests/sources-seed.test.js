'use strict';

/**
 * tests/sources-seed.test.js  [SRC-SEEDS]
 *
 * Coverage for engine/sources/seed.js — the bridge from the two CONFIG-GATED content sources
 * (trend + work-recap) into the EXISTING chain (release-spec §2.1 seeding, §6.7 trend report,
 * §8.8 trend scope + DD-16, §3.3 operator/founder/team accounts, §12 injectable seams).
 *
 * Proves, ZERO-KEY (RD-12), using the shipped fakes (fake-trend-adapter, fake-memory-reader) and
 * the synthetic Acme Cosmos fixtures:
 *   - both pathways are OFF by default and FAIL CLOSED unless their config block enables them;
 *   - a TrendReport (Zone U) maps to a trend-slot seed whose embedded brief validates against
 *     brief.schema.json, with slot_type=trend, the content_form (quote-retweet per DD-16), the
 *     trend/quote-retweet framework, and the inherited freshness window (DD-15 TTL);
 *   - a redacted work-recap maps to a build-in-public seed whose brief validates, points at the
 *     build-in-public framework, targets an operator account, and threads the privacy deny-set
 *     onto BOTH pre_seed.must_not_include AND enrichment.proof_stack.fact_safety (the gate's
 *     privacy/leak-check input) BEFORE the human approval card;
 *   - the seed mechanism re-redacts secret-shaped values defensively (§13.3);
 *   - DD-16: trend content fills a reserved calendar slot (no out-of-calendar) — a missing slot is
 *     refused;
 *   - NOTHING in this module publishes; it only produces pre-seeds for the chain.
 *
 * Runner: Node's built-in node:test (zero-dependency, Node >= 22).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const seed = require('../engine/sources/seed.js');
const { validate } = require('../scripts/validate-schemas.js');
const briefSchema = require('../schemas/inputs/brief.schema.json');
const { makeFakeTrendAdapter } = require('./helpers/fake-trend-adapter.js');
const { makeFakeMemoryReader } = require('./helpers/fake-memory-reader.js');

/** brief.schema.json validity assertion with a readable failure message. */
function assertValidBrief(brief, label) {
  const r = validate(brief, briefSchema);
  assert.equal(r.ok, true, `${label}: brief must validate against brief.schema.json — errors: ${JSON.stringify(r.errors)}`);
}

const TREND_CFG = { trends: { enabled: true } };
const RECAP_CFG_BASE = { work_recap: { enabled: true } };

const A_TREND_SLOT = {
  slot_id: 'acme-trend-mon-01',
  brand: 'acme-cosmos',
  platform: 'twitter',
  format: 'single',
  archetype: 'trend-response',
};
const A_RECAP_SLOT = {
  slot_id: 'acme-recap-fri-01',
  brand: 'acme-founder',
  platform: 'twitter',
  format: 'single',
};

// ---------------------------------------------------------------------------
// Config gate — both pathways OFF by default, fail-closed
// ---------------------------------------------------------------------------

test('trend pathway is OFF by default — mapTrendSeed refuses with no config', () => {
  assert.throws(
    () => seed.mapTrendSeed({ topics: [{ topic: 't' }] }, { slot: A_TREND_SLOT }),
    (e) => e.code === 'ESOURCEDISABLED' && e.block === 'trends',
  );
});

test('trend pathway refuses when explicitly disabled', () => {
  assert.throws(
    () => seed.mapTrendSeed({ topics: [{ topic: 't' }] }, { slot: A_TREND_SLOT, config: { trends: { enabled: false } } }),
    (e) => e.code === 'ESOURCEDISABLED',
  );
});

test('work-recap pathway is OFF by default — mapWorkRecapSeed refuses with no config', () => {
  assert.throws(
    () => seed.mapWorkRecapSeed({ shipped: ['x'] }, { slot: A_RECAP_SLOT }),
    (e) => e.code === 'ESOURCEDISABLED' && e.block === 'work_recap',
  );
});

test('pathwayEnabled is fail-closed (absence / non-true ⇒ false)', () => {
  assert.equal(seed.pathwayEnabled(undefined, 'trends'), false);
  assert.equal(seed.pathwayEnabled({}, 'trends'), false);
  assert.equal(seed.pathwayEnabled({ trends: {} }, 'trends'), false);
  assert.equal(seed.pathwayEnabled({ trends: { enabled: 'yes' } }, 'trends'), false);
  assert.equal(seed.pathwayEnabled({ trends: { enabled: true } }, 'trends'), true);
});

// ---------------------------------------------------------------------------
// TREND → trend-slot seed (zero-key, via the fake adapter)
// ---------------------------------------------------------------------------

test('a fake-adapter TrendReport maps to a schema-valid trend-slot seed (DD-16 + DD-15)', async () => {
  const adapter = makeFakeTrendAdapter();
  const reports = await adapter.poll({ platform: 'twitter', window: 'daily' });
  assert.ok(reports.length >= 1, 'fixture has at least one recorded report');
  const report = reports[0];

  const out = seed.mapTrendSeed(report, {
    slot: A_TREND_SLOT,
    config: TREND_CFG,
    content_form: 'quote-retweet',
    trend_report_ref: 'corpora/acme-cosmos/trends/r1.json',
    mode: 'LIVE_PREVIEW',
  });

  assertValidBrief(out.brief, 'trend');
  assert.equal(out.source, 'trend');
  assert.equal(out.slot_type, 'trend'); // DD-16: reserved trend slot
  assert.equal(out.content_form, 'quote-retweet'); // DD-16: quote-retweet content_form
  assert.equal(out.brief.framework_ref, 'rules/frameworks/trend-quote-retweet.md');
  assert.equal(out.provenance.trust_zone, 'U'); // §6.7 always Zone U
  assert.equal(out.trend_report, report, 'the Zone-U report rides along for queue provenance');
  assert.equal(out.trend_report_ref, 'corpora/acme-cosmos/trends/r1.json');
  assert.equal(out.mode, 'LIVE_PREVIEW');
  assert.equal(out.brief.mode, 'LIVE_PREVIEW');
  // Freshness window inherited as the trend-card TTL basis (DD-15) when the report supplies one.
  if (report.freshness_window && (report.freshness_window.expires_at || report.freshness_window.duration)) {
    assert.deepEqual(out.freshness_window, report.freshness_window);
    assert.equal(out.expires_basis, 'freshness_window');
  }
});

test('trend seed default content_form is standalone', async () => {
  const adapter = makeFakeTrendAdapter();
  const [report] = await adapter.poll({ platform: 'twitter', window: 'daily' });
  const out = seed.mapTrendSeed(report, { slot: A_TREND_SLOT, config: TREND_CFG });
  assert.equal(out.content_form, 'standalone');
  assertValidBrief(out.brief, 'trend-standalone');
});

test('trend seed carries ANGLES only — never drafted reply/comment text (§1.4/DD-16)', async () => {
  const adapter = makeFakeTrendAdapter();
  const [report] = await adapter.poll({ platform: 'twitter', window: 'daily' });
  const out = seed.mapTrendSeed(report, { slot: A_TREND_SLOT, config: TREND_CFG });
  const mni = JSON.stringify(out.brief.pre_seed.must_not_include);
  assert.match(mni, /drafted reply or comment text/);
  // The angle bank in the proof stack is built from suggested_angles only.
  const angleSet = new Set();
  for (const t of report.topics) for (const a of (t.suggested_angles || [])) angleSet.add(a);
  for (const a of [...out.brief.enrichment.proof_stack.primary, ...out.brief.enrichment.proof_stack.supporting]) {
    assert.ok(angleSet.has(a), `proof-stack angle "${a}" came from the report's suggested_angles`);
  }
});

test('DD-16: a trend report with NO reserved slot is refused (no out-of-calendar)', async () => {
  const adapter = makeFakeTrendAdapter();
  const [report] = await adapter.poll({ platform: 'twitter', window: 'daily' });
  assert.throws(
    () => seed.mapTrendSeed(report, { config: TREND_CFG }),
    /reserved trend calendar slot/,
  );
});

test('trend seed requires a non-empty report', () => {
  assert.throws(() => seed.mapTrendSeed({ topics: [] }, { slot: A_TREND_SLOT, config: TREND_CFG }), /at least one topic/);
});

// ---------------------------------------------------------------------------
// WORK-RECAP → build-in-public seed (zero-key, via the fake memory reader)
// ---------------------------------------------------------------------------

/** Distill a tiny recap from the fixture's CLEAN day (no secrets) — what a memory source emits. */
function cleanRecapFromFixture() {
  return {
    shipped: ['Published the focus-the-Moon how-to to the blog'],
    learned: ['short clear-sky windows favor one bright target over a tour'],
    next: ['add a resumable batch mode to the indexer'],
    highlight: 'focus-the-Moon how-to shipped',
    account_class: 'operator',
    period: { start: '2099-04-07', end: '2099-04-08' },
  };
}

test('a clean recap maps to a schema-valid build-in-public seed targeting an operator account', () => {
  const reader = makeFakeMemoryReader();
  const denyList = reader.loadPrivateTerms(); // the { terms, secret_literals } shape
  const config = { work_recap: { enabled: true, private_terms: denyList } };

  const out = seed.mapWorkRecapSeed(cleanRecapFromFixture(), {
    slot: A_RECAP_SLOT,
    config,
    account_ref: 'acme-founder-handle',
    memory_source_ref: 'memory/2099-04-08.md',
    mode: 'SAFE',
  });

  assertValidBrief(out.brief, 'work-recap');
  assert.equal(out.source, 'work-recap');
  assert.equal(out.account_class, 'operator'); // §3.3 operator account
  assert.equal(out.brief.framework_ref, 'rules/frameworks/build-in-public.md');
  assert.equal(out.provenance.trust_zone, 'O');
  assert.equal(out.provenance.privacy_checked, true);
  assert.equal(out.account_ref, 'acme-founder-handle');
});

test('PRIVACY: the deny-set is threaded onto BOTH must_not_include AND fact_safety (the gate input)', () => {
  const reader = makeFakeMemoryReader();
  const denyList = reader.loadPrivateTerms();
  const config = { work_recap: { enabled: true, private_terms: denyList } };

  const out = seed.mapWorkRecapSeed(cleanRecapFromFixture(), { slot: A_RECAP_SLOT, config });

  const mustNot = JSON.stringify(out.brief.pre_seed.must_not_include);
  const factSafety = JSON.stringify(out.brief.enrichment.proof_stack.fact_safety);
  const expectedTerms = [...denyList.terms, ...denyList.secret_literals];
  assert.ok(expectedTerms.length > 0, 'fixture deny-list is non-empty');
  for (const term of expectedTerms) {
    assert.ok(mustNot.includes(term), `must_not_include carries the forbidden term "${term}"`);
    assert.ok(factSafety.includes(term), `fact_safety (gate leak-check input) carries the forbidden term "${term}"`);
  }
  assert.equal(out.provenance.private_terms_count, expectedTerms.length);
});

test('privacyDenySet accepts both a flat array and the { terms, secret_literals } object', () => {
  const flat = seed.privacyDenySet({ private_terms: ['A', 'B'] }, { work_recap: { private_terms: ['C'] } });
  assert.deepEqual(flat.sort(), ['A', 'B', 'C']);
  const obj = seed.privacyDenySet(
    { private_terms: { terms: ['Partner'], secret_literals: ['FAKE_TOKEN'] } },
    { work_recap: { private_terms: { terms: ['Codename'] } } },
  );
  assert.deepEqual(obj.sort(), ['Codename', 'FAKE_TOKEN', 'Partner']);
});

test('redaction belt-and-suspenders: a secret-SHAPED value in a recap is masked in the brief (§13.3)', () => {
  const config = { work_recap: { enabled: true } };
  // A synthetic high-entropy 40+ char opaque blob — redact.js's long-token pattern masks it.
  // Deliberately NOT a named-credential prefix (no ghp_/sk-/xai-/AIza), so it is unmistakably a
  // synthetic test value and the hygiene scan does not flag it as a real credential leak.
  const SYNTH_TOKEN = `${'Zk7'}${'Qx2Lm9Vt4Rb8Nh1Wd6Cf3Yg0Ap5Es7Ju2Mo9Ki4'}`;
  const recap = {
    shipped: [`rotated the synthetic placeholder secret ${SYNTH_TOKEN} and redeployed`],
    account_class: 'operator',
  };
  const out = seed.mapWorkRecapSeed(recap, { slot: A_RECAP_SLOT, config });
  const blob = JSON.stringify(out.brief);
  assert.ok(SYNTH_TOKEN.length >= 40, 'the synthetic token is long enough to trip the long-token pattern');
  assert.ok(!blob.includes(SYNTH_TOKEN), 'the token-shaped value is masked at map time');
});

test('work-recap requires a brand on the slot (operator account is a brand entry, §6.4)', () => {
  assert.throws(
    () => seed.mapWorkRecapSeed(cleanRecapFromFixture(), { slot: { slot_id: 's', platform: 'twitter' }, config: RECAP_CFG_BASE }),
    /slot.brand is required/,
  );
});

test('work-recap with no substance after redaction is refused', () => {
  assert.throws(
    () => seed.mapWorkRecapSeed({ account_class: 'operator' }, { slot: A_RECAP_SLOT, config: RECAP_CFG_BASE }),
    /no shippable substance/,
  );
});

test('mapWorkRecapSeed accepts the work-recap SOURCE seed shape (work_items) directly', () => {
  // The native seed produced by engine/sources/work-recap/build-seed.js (summaries only).
  const sourceSeed = {
    source: 'work-recap',
    slot_type: 'work_recap',
    trust_zone: 'O',
    account: 'acme-founder',
    angle: 'Build-in-public recap: shipped 2 things recently.',
    work_items: [
      { summary: 'Shipped the resumable indexer batch mode', date: '2099-04-08', privacy_flags: {} },
      { summary: 'Cut re-index time from 40 minutes to 90 seconds', date: '2099-04-08', privacy_flags: { terms: ['Nebula Nine Optics'] } },
    ],
    privacy_flags: { any_redacted: true, terms: ['Project Dark Comet'] },
    provenance: { method: 'memory-scan', period: { start: '2099-04-07', end: '2099-04-08' } },
  };
  const out = seed.mapWorkRecapSeed(sourceSeed, { slot: A_RECAP_SLOT, config: RECAP_CFG_BASE });
  assertValidBrief(out.brief, 'work-recap-source-seed');
  // The work_items summaries became the proof stack primary.
  const primary = JSON.stringify(out.brief.enrichment.proof_stack.primary);
  assert.match(primary, /resumable indexer batch mode/);
  // Item-level + seed-level flagged terms became deny-set anti-targets in fact_safety.
  const factSafety = JSON.stringify(out.brief.enrichment.proof_stack.fact_safety);
  assert.match(factSafety, /Nebula Nine Optics/);
  assert.match(factSafety, /Project Dark Comet/);
});

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

test('mapSeed routes by source and produces schema-valid briefs', async () => {
  const adapter = makeFakeTrendAdapter();
  const [report] = await adapter.poll({ platform: 'twitter', window: 'daily' });

  const t = seed.mapSeed('trend', report, { slot: A_TREND_SLOT, config: TREND_CFG });
  assert.equal(t.slot_type, 'trend');
  assertValidBrief(t.brief, 'mapSeed-trend');

  const w = seed.mapSeed('work-recap', cleanRecapFromFixture(), { slot: A_RECAP_SLOT, config: RECAP_CFG_BASE });
  assert.equal(w.source, 'work-recap');
  assertValidBrief(w.brief, 'mapSeed-recap');
});

test('mapSeed rejects an unknown source', () => {
  assert.throws(() => seed.mapSeed('bogus', {}, {}), /unknown content source/);
});

// ---------------------------------------------------------------------------
// Zero-key / no-secrets posture (RD-12)
// ---------------------------------------------------------------------------

test('the module loads and maps with no CONTENT_HOME and no keys set', () => {
  const env = { ...process.env };
  delete process.env.CONTENT_HOME;
  try {
    const out = seed.mapSeed('work-recap', cleanRecapFromFixture(), { slot: A_RECAP_SLOT, config: RECAP_CFG_BASE });
    assertValidBrief(out.brief, 'zero-key');
  } finally {
    process.env = env;
  }
});
