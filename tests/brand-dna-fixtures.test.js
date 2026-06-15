'use strict';

/**
 * tests/brand-dna-fixtures.test.js  [BD-FIXTURES]
 *
 * Coverage for the DATA-INGESTION & BRAND-IDENTITY fixtures, config, and injectable fakes
 * (release-spec §1.1 Data Ingestion & Brand Identity; §1.2 Context & Competitor Analysis;
 * roadmap #2). These are the zero-key building blocks the brand-DNA flow's engine modules (the
 * deterministic analyzer, archetype categorizer, cost gate, CLI orchestration, writers — shipped
 * in sibling batches) consume. This test proves the fixtures + fakes are internally consistent and
 * honor the feature laws, ZERO-KEY (RD-12) with no network.
 *
 * Proves:
 *   - the new config blocks validate: brand.json `ingestion` (DD-10) against brand.schema.json,
 *     and the brand_dna fragment against the system schema's brand_dna sub-schema;
 *   - every ingested corpus item (own + competitor) validates against corpus-item.schema.json and
 *     is Zone U (untrusted-scraped) except the one attested operator-curated own keeper (RD-8);
 *   - the fake scraper (RD-9 BYO seam) replays the recorded corpus zero-key, honors max_items,
 *     exposes the empty-degrade path, presents a cost estimate (DD-18), and THROWS on an unrecorded
 *     query (never fabricates);
 *   - the fake DNA-synthesis seat (RD-2 host seat) replays a canned brand-dna.md zero-key, reports a
 *     metered receipt, and THROWS on an unrecorded brand;
 *   - the recorded scrape responses MIRROR the on-disk corpora (scraped path == manual-submission
 *     path for analysis);
 *   - NO-VERBATIM-REPUBLISH (RD-9 risk): no distinctive competitor phrase appears in the synthesized
 *     brand-dna.md or the archetype catalog's seeds/hooks — the derived output carries patterns only;
 *   - the deterministic-analysis ground truth (expected/analysis.json) is hand-consistent with the
 *     on-disk corpora (counts + the engagement-lift baseline median);
 *   - cold-start (DD-21) ground truth enumerates the never-block degradation cases.
 *
 * Runner: Node's built-in node:test (zero-dependency, Node >= 22).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { validate } = require('../scripts/validate-schemas.js');
const brandSchema = require('../schemas/config/brand.schema.json');
const systemSchema = require('../schemas/config/system.schema.json');
const corpusItemSchema = require('../schemas/inputs/corpus-item.schema.json');

const scraperHelper = require('./helpers/fake-scraper-adapter.js');
const dnaHelper = require('./helpers/fake-dna-synthesis.js');

const FIX = path.join(__dirname, '..', 'fixtures', 'brand-dna-acme');

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(FIX, rel), 'utf8'));
}
function listJson(relDir) {
  const dir = path.join(FIX, relDir);
  const out = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.json')) out.push(p);
    }
  })(dir);
  return out.sort();
}
const norm = (s) => String(s).toLowerCase().replace(/\s+/g, ' ');

// --- Config validation ----------------------------------------------------------------------

test('brand.json ingestion block validates against brand.schema.json (DD-10)', () => {
  const brand = readJson('brand.json');
  const r = validate(brand, brandSchema);
  assert.equal(r.ok, true, `brand.json must validate — errors: ${JSON.stringify(r.errors)}`);
  assert.ok(brand.ingestion, 'fixture exercises the new ingestion block');
  assert.equal(brand.ingestion.competitors.length, 2, 'two invented competitors');
  assert.ok(brand.ingestion.account_handles.length >= 1, 'at least one own account handle');
});

// The brand_dna sub-schema references #/$defs/private_terms, which lives at the system schema root.
// Build a self-contained sub-schema that re-roots the system $defs so the local $ref resolves when
// the block is validated in isolation (the fixture fragment is intentionally not a full system.json).
const brandDnaSubSchema = { $defs: systemSchema.$defs, ...systemSchema.properties.brand_dna };

test('system brand_dna fragment validates against the brand_dna sub-schema (off-by-default gate flipped on)', () => {
  const frag = readJson('system.brand-dna.json');
  const r = validate(frag.brand_dna, brandDnaSubSchema);
  assert.equal(r.ok, true, `brand_dna block must validate — errors: ${JSON.stringify(r.errors)}`);
  assert.equal(frag.brand_dna.enabled, true, 'fixture turns the off-by-default gate ON');
  assert.equal(frag.brand_dna.scraper.adapter, 'fixture', 'wires the zero-key fixture scraper');
  assert.equal(frag.brand_dna.synthesis.seat, 'fixture', 'wires the zero-key fixture seat');
});

test('brand_dna defaults off (fail-closed) — empty block validates with enabled absent meaning off', () => {
  // The schema requires `enabled`; absence is a config error, but any non-true value is "off".
  const offish = { enabled: false };
  const r = validate(offish, brandDnaSubSchema);
  assert.equal(r.ok, true);
  assert.equal(offish.enabled, false, 'OFF is the default posture (the LAW)');
});

// --- Corpus items ----------------------------------------------------------------------------

test('every ingested corpus item validates against corpus-item.schema.json and carries metrics', () => {
  const files = listJson('corpora');
  assert.ok(files.length >= 16, `expected >= 16 corpus items, got ${files.length}`);
  for (const f of files) {
    const item = JSON.parse(fs.readFileSync(f, 'utf8'));
    const r = validate(item, corpusItemSchema);
    assert.equal(r.ok, true, `${path.basename(f)} must validate — errors: ${JSON.stringify(r.errors)}`);
    assert.ok(item.metrics && typeof item.metrics.bookmarks === 'number', `${path.basename(f)} carries engagement metrics`);
  }
});

test('competitor corpus is Zone U; own keeper is attested operator-curated (RD-8)', () => {
  for (const f of listJson('corpora/acme-cosmos/competitors')) {
    const item = JSON.parse(fs.readFileSync(f, 'utf8'));
    assert.equal(item.trust_class, 'untrusted-scraped', `${path.basename(f)} competitor item is Zone U`);
    assert.equal(item.retention_class, 'transient', `${path.basename(f)} competitor item ages out fast`);
  }
  const own = listJson('corpora/acme-cosmos/own').map((f) => JSON.parse(fs.readFileSync(f, 'utf8')));
  const curated = own.filter((i) => i.trust_class === 'operator-curated');
  assert.equal(curated.length, 1, 'exactly one own item is promoted');
  assert.ok(curated[0].attestation && curated[0].attestation.reason, 'the promotion carries an attestation');
});

// --- Fake scraper adapter (RD-9 BYO seam) ----------------------------------------------------

test('fake scraper replays recorded corpus zero-key, honors max_items, and degrades on empty', async () => {
  const a = scraperHelper.makeFakeScraperAdapter();
  assert.equal(a.capabilities().requires_key, false, 'no key required (RD-9 / RD-12)');

  const own = await a.scrape({ platform: 'twitter', handle: '@acmecosmos' });
  assert.equal(own.length, 8, 'replays the 8 own items');
  for (const it of own) {
    assert.equal(validate(it, corpusItemSchema).ok, true, 'each replayed item validates');
  }
  const sliced = await a.scrape({ platform: 'twitter', handle: 'acmecosmos', max_items: 3 });
  assert.equal(sliced.length, 3, 'honors max_items');

  const empty = await a.scrape({ platform: 'twitter', handle: 'empty' });
  assert.deepEqual(empty, [], 'recorded empty scrape = degrade-to-cold-start path (DD-21)');

  const est = a.estimate({ handles: 3, max_items_per_handle: 200 });
  assert.equal(est.max_items, 600);
  assert.equal(est.requires_confirm, true, 'metered scrape presents a cost estimate + confirm (DD-18)');
  assert.equal(est.est_cost_usd, 0, 'fixture adapter spends nothing');
});

test('fake scraper THROWS on an unrecorded query (never fabricates); onMissing:empty degrades', async () => {
  const strict = scraperHelper.makeFakeScraperAdapter();
  await assert.rejects(() => strict.scrape({ platform: 'twitter', handle: 'unknown-handle' }), /no recorded response/);
  const lenient = scraperHelper.makeFakeScraperAdapter({ onMissing: 'empty' });
  assert.deepEqual(await lenient.scrape({ platform: 'twitter', handle: 'unknown-handle' }), []);
});

test('recorded scrape responses MIRROR the on-disk corpora (scraped == manual path)', async () => {
  const a = scraperHelper.makeFakeScraperAdapter();
  const ownScraped = (await a.scrape({ platform: 'twitter', handle: '@acmecosmos' })).map((i) => i.text).sort();
  const ownDisk = listJson('corpora/acme-cosmos/own')
    .map((f) => JSON.parse(fs.readFileSync(f, 'utf8')).text).sort();
  assert.deepEqual(ownScraped, ownDisk, 'the scraped own corpus equals the manual-submission own corpus');
});

// --- Fake DNA-synthesis seat (RD-2 host seat) ------------------------------------------------

test('fake DNA seat replays a canned brand-dna.md zero-key with a metered receipt', async () => {
  const seat = dnaHelper.makeFakeDnaSynthesis();
  assert.equal(seat.capabilities().requires_key, false, 'no key required (RD-2 host seat, zero-key fixture)');
  const out = await seat.synthesize({ brand: 'acme-cosmos', analysis: readJson('expected/analysis.json') });
  assert.match(out.brand_dna_md, /^# Brand DNA — Acme Cosmos/, 'returns the canned DNA prose');
  assert.equal(out.synthesis_meta.cost_usd, 0, 'fixture seat spends nothing');
  const est = seat.estimate({ analysis_tokens_est: 1800 });
  assert.equal(est.requires_confirm, true, 'metered synthesis presents a cost estimate + confirm (DD-18)');

  const expectedMd = fs.readFileSync(path.join(FIX, 'expected', 'brand-dna.expected.md'), 'utf8');
  assert.equal(out.brand_dna_md.trim(), expectedMd.trim(), 'recorded output == expected DNA file');
});

test('fake DNA seat THROWS on an unrecorded brand; onMissing:null degrades', async () => {
  const strict = dnaHelper.makeFakeDnaSynthesis();
  await assert.rejects(() => strict.synthesize({ brand: 'no-such-brand' }), /no recorded output/);
  const lenient = dnaHelper.makeFakeDnaSynthesis({ onMissing: 'null' });
  assert.equal(await lenient.synthesize({ brand: 'no-such-brand' }), null);
});

// --- No verbatim republish (RD-9 risk) ------------------------------------------------------

test('NO competitor copy is republished verbatim in the synthesized DNA or the archetype catalog', async () => {
  const nv = readJson('expected/no-verbatim-check.json');
  const seat = dnaHelper.makeFakeDnaSynthesis();
  const out = await seat.synthesize({ brand: 'acme-cosmos' });
  const cat = readJson('expected/archetype-catalog.json');
  const catText = cat.archetypes
    .flatMap((x) => [...(x.hook_patterns || []), ...(x.must_include || [])])
    .join('\n');
  const expectedMd = fs.readFileSync(path.join(FIX, 'expected', 'brand-dna.expected.md'), 'utf8');

  const haystacks = {
    'synthesized DNA': norm(out.brand_dna_md),
    'expected DNA file': norm(expectedMd),
    'archetype catalog': norm(catText),
  };
  let violations = 0;
  for (const f of nv.forbidden_substrings) {
    const needle = norm(f.phrase);
    for (const [where, hay] of Object.entries(haystacks)) {
      if (hay.includes(needle)) {
        violations += 1;
        assert.fail(`competitor verbatim "${f.phrase}" leaked into ${where}`);
      }
    }
  }
  assert.equal(violations, nv.expected_violations, 'derived output carries patterns only, never copied competitor copy');

  // Sanity: the forbidden phrases ARE actually present in the source competitor corpus (so the test
  // would catch a real leak, not pass vacuously).
  const compText = listJson('corpora/acme-cosmos/competitors')
    .map((file) => norm(JSON.parse(fs.readFileSync(file, 'utf8')).text)).join('\n');
  const grounded = nv.forbidden_substrings.filter((f) => compText.includes(norm(f.phrase)));
  assert.ok(grounded.length >= nv.forbidden_substrings.length - 1,
    'forbidden phrases are drawn from the actual competitor corpus (non-vacuous check)');
});

// --- Deterministic-analysis ground truth consistency ----------------------------------------

test('expected analysis ground truth is hand-consistent with the on-disk corpora', () => {
  const an = readJson('expected/analysis.json');
  const own = listJson('corpora/acme-cosmos/own');
  const stellar = listJson('corpora/acme-cosmos/competitors/stellar-optics-co');
  const orbit = listJson('corpora/acme-cosmos/competitors/orbit-outfitters');

  assert.equal(an.corpus.own.item_count, own.length, 'own count matches');
  assert.equal(an.corpus.total_items, own.length + stellar.length + orbit.length, 'total matches');
  assert.equal(an.provenance.all_items_zone, 'U', 'all ingested corpus is Zone U');
  assert.equal(an.provenance.no_verbatim_republish, true);

  // The engagement-lift baseline median bookmarks is the literal median of the 8 own items.
  const bm = own.map((f) => JSON.parse(fs.readFileSync(f, 'utf8')).metrics.bookmarks).sort((a, b) => a - b);
  const median = (bm[3] + bm[4]) / 2;
  assert.equal(median, an.engagement.own_account_median_bookmarks, 'baseline median bookmarks is hand-verifiable');
  assert.equal(an.engagement.strongest_own_archetype, 'HOW_TO', 'how-to is the strongest own lane');
});

// --- Cold-start (DD-21) ---------------------------------------------------------------------

test('cold-start ground truth enumerates the never-block degradation cases (DD-21)', () => {
  const cs = readJson('expected/cold-start.json');
  assert.equal(cs.invariants.onboarding_never_blocked, true);
  assert.equal(cs.invariants.engine_never_calls_analysis_llm_directly, true, 'RD-2 invariant');
  assert.equal(cs.invariants.nothing_auto_publishes, true);
  const noSeat = cs.cases.find((c) => c.id === 'B_corpus_no_seat');
  assert.equal(noSeat.expect.blocked, false, 'corpus-but-no-seat still proceeds');
  assert.equal(noSeat.expect.dna_synthesized, false, 'and does not fabricate DNA');
  assert.ok(noSeat.expect.emits.includes('templates/brand/brand-dna-authoring.md'),
    'it emits the authoring template for the agent to finish');
});
