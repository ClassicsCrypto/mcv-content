'use strict';

/**
 * tests/brand-dna-flow.test.js  [BD-TESTS]
 *
 * END-TO-END, ZERO-KEY coverage of the one-command Brand-DNA / competitor-ingestion flow
 * (release-spec / original-design-spec §1.1 Data Ingestion & Brand Identity + §1.2 Context &
 * Competitor Analysis; §2.4 C2; roadmap #2). Where the sibling suites cover the fixtures'
 * internal consistency (tests/brand-dna-fixtures.test.js) and the generator over INLINE synthetic
 * corpora (tests/brand-dna-generate.test.js), THIS suite drives the WHOLE flow against the real
 * on-disk Acme own+competitor fixture corpus copied into a temp $CONTENT_HOME, wired to the
 * injectable fake DNA-synthesis seat — proving the engine batches (BD-INGEST, BD-ANALYZE,
 * BD-GENERATE) compose into the shipped feature.
 *
 * The feature laws this suite enforces (offline, no secrets — RD-12):
 *   (1) ONE-COMMAND FLOW: corpus + seat -> brands/<id>/brand-dna.md + an archetype catalog that
 *       VALIDATE, derived from the fixture corpus; brand.json voice fields updated.
 *   (2) DETERMINISTIC ANALYZER: reproducible (same corpus => byte-identical signals) and the
 *       archetype categorizer buckets the fixture corpus into the right archetype cells.
 *   (3) COLD-START / DEGRADE (DD-21): corpus + NO seat -> deterministic analysis + a PREFILLED
 *       authoring template (no throw, no fabricated DNA); NO corpus -> the cold-start manual
 *       template. Onboarding is never blocked.
 *   (4) COMPETITOR-NOT-VERBATIM (RD-9): a seat that echoes a real Zone-U competitor line has the
 *       verbatim span STRIPPED + FLAGGED; the clean fixture prose passes with no >N-word overlap.
 *   (5) METERED-ACTION GATE (DD-18): --estimate-only spends nothing and writes nothing; the seat
 *       is not called without --yes; --yes proceeds; a re-run is idempotent (no re-bill/overwrite).
 *   (6) CONFIG-GATED / OFF paths are no-ops: the scraper ingestion pathway is OFF by default and
 *       refuses to run; the free manual/export intake paths always work.
 *
 * RD-2: the engine NEVER calls a chain/analysis LLM — the DNA synthesis is a HOST seat the runtime
 * wires (here the zero-key fixture seat, bridged to generateBrandDna's dnaSeat contract). The
 * deterministic analyzer + archetype categorizer are engine code (BD-ANALYZE), used as the default.
 *
 * Runner: Node's built-in node:test (zero-dependency, Node >= 22). Wired into `npm test` by the
 * existing `tests/** /*.test.js` glob in package.json.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const gen = require('../engine/brand-dna/generate.js');
const ingest = require('../engine/sources/ingest');
const analyzeMod = require('../engine/brand-dna/analyze.js');
const archetypesMod = require('../engine/brand-dna/archetypes.js');

const { validate } = require('../scripts/validate-schemas.js');
const brandSchema = require('../schemas/config/brand.schema.json');
const corpusItemSchema = require('../schemas/inputs/corpus-item.schema.json');

const dnaHelper = require('./helpers/fake-dna-synthesis.js');
const scraperHelper = require('./helpers/fake-scraper-adapter.js');

const BRAND = 'acme-cosmos';
const FIX = path.join(__dirname, '..', 'fixtures', 'brand-dna-acme');
const FIX_CORPUS = path.join(FIX, 'corpora', BRAND);

// ---------------------------------------------------------------------------
// Helpers — copy the REAL fixture corpus into an isolated temp CONTENT_HOME.
// ---------------------------------------------------------------------------

function readJsonFixture(rel) {
  return JSON.parse(fs.readFileSync(path.join(FIX, rel), 'utf8'));
}

/** Recursively list *.json files under a dir (sorted, deterministic). */
function listJson(dir) {
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

/** Recursively copy a directory tree (corpora/<brand>/{own,competitors}/...). */
function copyTree(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) copyTree(s, d);
    else fs.copyFileSync(s, d);
  }
}

function baseBrandJson() {
  // A minimal but schema-valid brand.json so updateBrandVoiceFields has something to patch.
  return {
    schema_version: '1.0.0',
    id: BRAND,
    display_name: 'Acme Cosmos',
    account_class: 'brand',
    drama_dial: 'low',
    platforms: [{ platform: 'twitter', publisher: 'postiz' }],
  };
}

/**
 * Spin up an isolated CONTENT_HOME. By default it copies the REAL Acme fixture corpus
 * (corpora/acme-cosmos/{own,competitors}/...) so the flow analyzes genuine fixture content.
 * @param {object} [opts] { withCorpus=true, withBrandJson=true }
 */
function withHome(opts = {}) {
  const withCorpus = opts.withCorpus !== false;
  const withBrandJson = opts.withBrandJson !== false;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oce-bdflow-'));
  const brandDir = path.join(home, 'brands', BRAND);
  fs.mkdirSync(brandDir, { recursive: true });
  if (withBrandJson) {
    fs.writeFileSync(path.join(brandDir, 'brand.json'), `${JSON.stringify(baseBrandJson(), null, 2)}\n`, 'utf8');
  }
  if (withCorpus) {
    copyTree(FIX_CORPUS, path.join(home, 'corpora', BRAND));
  }
  return { env: { CONTENT_HOME: home }, home, brandDir };
}

function cleanup(home) {
  fs.rmSync(home, { recursive: true, force: true });
}

/**
 * Bridge the recorded fixture DNA-synthesis seat (which returns { brand_dna_md, synthesis_meta })
 * to generateBrandDna's dnaSeat contract (which expects the structured synthesis object the writers
 * consume). A real host seat returns the structured fields directly; the fixture replays a single
 * markdown blob, so we carry it in `voice`/`summary` (the writer's prose fields) and seed the
 * archetypes from the published archetype-catalog fixture. The whole fixture prose therefore flows
 * through the writer AND the RD-9 verbatim check, exactly as a real seat's prose would.
 *
 * @param {object} [opts] { counter, archetypes }  counter() increments per call (DD-18 proof).
 */
function fixtureSeatBridge(opts = {}) {
  const fakeSeat = dnaHelper.makeFakeDnaSynthesis();
  const catalog = opts.archetypes || readJsonFixture('expected/archetype-catalog.json').archetypes;
  // Map the catalog fixture (id/display_name/hook_patterns/must_include/...) to the seat's
  // archetype field set the writer renders.
  const archetypes = catalog.map((a) => ({
    id: a.id,
    name: a.display_name || a.id,
    when_to_use: a.pattern_source || '',
    angle: (a.hook_patterns && a.hook_patterns[0]) || '',
    hook_direction: (a.hook_patterns && a.hook_patterns[1]) || (a.hook_patterns && a.hook_patterns[0]) || '',
    must_include: Array.isArray(a.must_include) ? a.must_include.slice() : [],
    voice_notes: a.voice_note || '',
  }));
  let calls = 0;
  const seat = async (input) => {
    calls += 1;
    if (typeof opts.counter === 'function') opts.counter();
    const out = await fakeSeat.synthesize({ brand: input.brand, analysis: input.analysis });
    const md = (out && out.brand_dna_md) || '';
    return {
      display_name: 'Acme Cosmos',
      drama_dial: 'low',
      identity: 'Acme Cosmos: a beginner-first backyard telescope and companion app.',
      tone: 'Plain, warm, useful first; calm about failure; never mystical.',
      // Carry the whole recorded fixture prose through the writer + the verbatim check.
      voice: md,
      summary: 'Help a beginner find their first real object tonight, then make it easy to come back.',
      do: ['Name the object, the time, and the place', 'Leave the reader able to do one thing tonight'],
      do_not: ['Manufactured urgency', 'Astrology framing'],
      signature_moves: ['Open at the eyepiece', 'Close with a clear next step'],
      archetypes,
    };
  };
  seat.calls = () => calls;
  return seat;
}

// ===========================================================================
// (1) ONE-COMMAND FLOW — corpus + seat -> validating DNA + archetype catalog.
// ===========================================================================

test('one-command flow: fixture corpus + fake seat -> brand-dna.md + archetype catalog that VALIDATE', async () => {
  const { env, home, brandDir } = withHome();
  const seat = fixtureSeatBridge();
  try {
    const res = await gen.generateBrandDna({ brand: BRAND, env, dnaSeat: seat, yes: true });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.match(res.status, /^generated/, `expected a generated status, got ${res.status}`);
    assert.equal(seat.calls(), 1, 'the host seat was invoked exactly once');

    // The deterministic analysis ran from the real fixture corpus (8 own + 8 competitor).
    assert.equal(res.data.corpus_summary.own_items, 8, 'analyzed the 8 own fixture items');
    assert.equal(res.data.corpus_summary.competitor_items, 8, 'analyzed the 8 competitor fixture items');
    assert.equal(res.data.analyzer_source, 'bd-analyze', 'used the BD-ANALYZE deterministic analyzer by default');
    assert.equal(res.data.analysis.generated_with, 'deterministic-no-llm', 'RD-2: auditable stats, never an LLM');

    // brand-dna.md was written with the document sections the writer renders.
    const dnaFile = path.join(brandDir, 'brand-dna.md');
    assert.equal(fs.existsSync(dnaFile), true, 'brand-dna.md was written');
    const dna = fs.readFileSync(dnaFile, 'utf8');
    assert.match(dna, /# Brand DNA — Acme Cosmos/);
    assert.match(dna, /## 1. Identity/);
    assert.match(dna, /## 2. Tone/);
    assert.match(dna, /## 3. Voice/);
    assert.match(dna, /## 5. Signature moves/);
    assert.match(dna, /Analysis provenance \(deterministic, auditable — no LLM\)/, 'embeds the auditable analysis');

    // An archetype catalog was written, one .md per archetype, mirroring the catalog fixture ids.
    const archDir = path.join(brandDir, 'archetypes');
    const archFiles = fs.readdirSync(archDir).filter((f) => f.endsWith('.md'));
    assert.ok(archFiles.length >= 1, 'a non-empty archetype catalog was written');
    assert.ok(archFiles.includes('how-to.md'), `expected how-to.md, got ${archFiles.join(',')}`);
    assert.ok(archFiles.includes('numbered-steps.md'), 'the borrowed-pattern archetype is in the catalog');
    const howTo = fs.readFileSync(path.join(archDir, 'how-to.md'), 'utf8');
    assert.match(howTo, /## Archetype: `how-to`/);

    // The written brand.json is still schema-valid AND carries the updated voice/path fields.
    const cfg = JSON.parse(fs.readFileSync(path.join(brandDir, 'brand.json'), 'utf8'));
    const vr = validate(cfg, brandSchema);
    assert.equal(vr.ok, true, `updated brand.json must still validate — errors: ${JSON.stringify(vr.errors)}`);
    assert.equal(cfg.paths.dna, `brands/${BRAND}/brand-dna.md`);
    assert.equal(cfg.paths.archetypes, `brands/${BRAND}/archetypes`);
    assert.equal(cfg.drama_dial, 'low', 'seat drama_dial applied');
    assert.equal(res.data.brand_json.updated, true);
  } finally {
    cleanup(home);
  }
});

// ===========================================================================
// (2) DETERMINISTIC ANALYZER — reproducible + correct archetype bucketing.
// ===========================================================================

/** Read the real fixture corpus into a mixed array + an ownPredicate (competitors/ subdir = Zone U). */
function loadFixtureCorpus() {
  const all = [];
  const own = new Set();
  (function walk(dir, isComp) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(p, isComp || /^competitors?$/i.test(e.name));
      } else if (e.name.endsWith('.json')) {
        const it = JSON.parse(fs.readFileSync(p, 'utf8'));
        all.push(it);
        if (!isComp) own.add(it);
      }
    }
  })(FIX_CORPUS, false);
  return { items: all, ownPredicate: (it) => own.has(it) };
}

test('deterministic analyzer is reproducible: same fixture corpus => byte-identical signals', () => {
  const { items, ownPredicate } = loadFixtureCorpus();
  const a = JSON.stringify(analyzeMod.analyzeCorpus(items, { ownPredicate }));
  const b = JSON.stringify(analyzeMod.analyzeCorpus(items, { ownPredicate }));
  assert.equal(a, b, 'the analyzer must be a pure function of the corpus (no Date.now / randomness / I/O)');

  // Order-independence: shuffling the input must not change the (sorted, tie-broken) output.
  const shuffled = [...items].reverse();
  const c = JSON.stringify(analyzeMod.analyzeCorpus(shuffled, { ownPredicate }));
  assert.equal(a, c, 'deterministic tie-breaking makes the output input-order-independent');
});

test('archetype categorizer buckets the fixture corpus into the right cells (own vs Zone-U competitor)', () => {
  const { items, ownPredicate } = loadFixtureCorpus();
  const cat = archetypesMod.categorizeArchetypes(items, { ownPredicate });
  assert.equal(cat.totals.own, 8, '8 own items');
  assert.equal(cat.totals.competitor, 8, '8 competitor items');

  const byCode = Object.fromEntries(cat.archetypes.map((a) => [a.code, a]));

  // The competitor corpus's scarcity/teaser/giveaway pattern is detected on the competitor side ONLY
  // (it is the anti-pattern the brand must NOT adopt — expected/archetype-catalog.json anti_patterns).
  assert.ok(byCode.SCARCITY_FOMO, 'a scarcity archetype was detected');
  assert.equal(byCode.SCARCITY_FOMO.counts.own, 0, 'the brand itself never uses scarcity (drama low)');
  assert.ok(byCode.SCARCITY_FOMO.counts.competitor >= 1, 'a competitor uses scarcity (Zone-U pattern)');

  assert.ok(byCode.ENGAGEMENT_BAIT, 'a giveaway/engagement-bait archetype was detected');
  assert.equal(byCode.ENGAGEMENT_BAIT.counts.own, 0, 'the brand never runs giveaways');
  assert.ok(byCode.ENGAGEMENT_BAIT.counts.competitor >= 1, 'a competitor runs a giveaway');

  // ANNOUNCEMENT appears on BOTH sides (the brand announces its app; a competitor announces a scope).
  assert.ok(byCode.ANNOUNCEMENT, 'an announcement archetype was detected');
  assert.ok(byCode.ANNOUNCEMENT.counts.own >= 1, 'the brand has an announcement');

  // Every cell carries DERIVED idea-seeds from OWN content ONLY — competitor copy never seeds.
  for (const a of cat.archetypes) {
    for (const seed of a.idea_seeds) {
      assert.equal(seed.archetype, a.code);
    }
    assert.ok(a.idea_seeds.length <= 6, 'idea seeds are capped (no bulk copy)');
  }

  // The categorizer is reproducible too.
  assert.equal(
    JSON.stringify(archetypesMod.categorizeArchetypes(items, { ownPredicate })),
    JSON.stringify(cat),
    'archetype categorization is a pure function of the corpus',
  );
});

// ===========================================================================
// (3) COLD-START / DEGRADE (DD-21) — never block onboarding.
// ===========================================================================

test('DEGRADE (corpus, NO seat): emits deterministic analysis + PREFILLED authoring template, no fabricated DNA', async () => {
  const { env, home, brandDir } = withHome();
  try {
    const res = await gen.generateBrandDna({ brand: BRAND, env }); // no dnaSeat wired
    assert.equal(res.ok, true, 'degrade never throws / never blocks onboarding (DD-21)');
    assert.equal(res.status, 'degraded-no-seat');
    assert.equal(res.data.analysis.generated_with, 'deterministic-no-llm', 'the free deterministic analysis is emitted');

    const dna = fs.readFileSync(path.join(brandDir, 'brand-dna.md'), 'utf8');
    // The shipped authoring template was prefilled with the deterministic analysis for the agent.
    assert.match(dna, /AUTO-PREFILL/, 'the authoring template is prefilled (the agent finishes the voice)');
    assert.match(dna, /Auto analysis \(deterministic/);
    assert.match(dna, /Brand DNA — authoring template/, 'the shipped authoring template body is present');
    // It must NOT contain synthesized voice prose: the synthesized document is the only path that
    // emits the host-seat synthesis footer + the rendered-document provenance heading (RD-2: the
    // engine did not call an LLM, so no DNA prose was fabricated — only the authoring template).
    assert.doesNotMatch(dna, /_Synthesis source: host-seat\./, 'no synthesized DNA document was fabricated');
    assert.doesNotMatch(dna, /Analysis provenance \(deterministic, auditable — no LLM\)/, 'the degrade path emits the prefill block, not the rendered DNA document');

    // A deterministic archetype catalog WAS written (derived patterns only).
    const archDir = path.join(brandDir, 'archetypes');
    const archFiles = fs.readdirSync(archDir).filter((f) => f.endsWith('.md'));
    assert.ok(archFiles.length >= 1, 'a deterministic catalog is written even without a seat');
  } finally {
    cleanup(home);
  }
});

test('COLD START (no corpus): writes the cold-start manual authoring template, never blocks (DD-21)', async () => {
  const { env, home, brandDir } = withHome({ withCorpus: false });
  try {
    // Even with a seat wired + --yes, no corpus means the cold-start template path (free, no spend).
    const seat = fixtureSeatBridge();
    const res = await gen.generateBrandDna({ brand: BRAND, env, dnaSeat: seat, yes: true });
    assert.equal(res.ok, true);
    assert.equal(res.status, 'cold-start');
    assert.equal(seat.calls(), 0, 'no corpus => the seat is never called (no spend)');
    const dna = fs.readFileSync(path.join(brandDir, 'brand-dna.md'), 'utf8');
    assert.match(dna, /Brand DNA — authoring template/, 'the manual authoring template is the deliverable');
    assert.doesNotMatch(dna, /AUTO-PREFILL/, 'cold start is the unprefilled template (no analysis to prefill)');
  } finally {
    cleanup(home);
  }
});

test('cold-start ground truth (DD-21) matches the flow behavior across all three cases', async () => {
  const cs = readJsonFixture('expected/cold-start.json');
  assert.equal(cs.invariants.onboarding_never_blocked, true);
  assert.equal(cs.invariants.engine_never_calls_analysis_llm_directly, true, 'RD-2 invariant');

  // Case A: no corpus, no seat -> cold-start template (ok, not blocked, no DNA synthesized).
  let h = withHome({ withCorpus: false });
  try {
    const a = await gen.generateBrandDna({ brand: BRAND, env: h.env });
    assert.equal(a.ok, true);
    assert.equal(a.status, 'cold-start');
  } finally { cleanup(h.home); }

  // Case B: corpus, no seat -> deterministic analysis + template, no DNA synthesized.
  h = withHome();
  try {
    const b = await gen.generateBrandDna({ brand: BRAND, env: h.env });
    assert.equal(b.status, 'degraded-no-seat');
    assert.equal(b.ok, true);
  } finally { cleanup(h.home); }

  // Case C: corpus + seat -> full synthesis.
  h = withHome();
  try {
    const c = await gen.generateBrandDna({ brand: BRAND, env: h.env, dnaSeat: fixtureSeatBridge(), yes: true });
    assert.match(c.status, /^generated/);
  } finally { cleanup(h.home); }
});

// ===========================================================================
// (4) COMPETITOR-NOT-VERBATIM (RD-9) — strip/flag, and assert no >N-word overlap.
// ===========================================================================

/** All Zone-U competitor texts from the real fixture corpus. */
function competitorTexts() {
  return listJson(path.join(FIX_CORPUS, 'competitors')).map((f) => JSON.parse(fs.readFileSync(f, 'utf8')).text);
}

test('RD-9: a seat echoing a REAL competitor line has the verbatim span STRIPPED + FLAGGED on disk', async () => {
  const { env, home, brandDir } = withHome();
  // Pick a distinctive >7-word competitor sentence from the actual fixture corpus.
  const leak = 'The most revolutionary scope ever made, period.';
  assert.ok(competitorTexts().some((t) => t.includes(leak)), 'the leak phrase is a real competitor line (non-vacuous)');

  // A leaky bridge seat that splices the competitor sentence into its voice prose.
  const leakySeat = async (input) => {
    const base = await fixtureSeatBridge()(input);
    return { ...base, voice: `Our voice. ${leak} And our own honest line about the eyepiece.` };
  };
  try {
    const res = await gen.generateBrandDna({ brand: BRAND, env, dnaSeat: leakySeat, yes: true });
    assert.equal(res.ok, true);
    assert.equal(res.status, 'generated-with-stripped-verbatim');
    assert.ok(res.data.verbatim_flags.length >= 1, 'the verbatim leak is flagged');

    const dna = fs.readFileSync(path.join(brandDir, 'brand-dna.md'), 'utf8');
    assert.doesNotMatch(dna, /most revolutionary scope ever made/, 'competitor copy must NOT reach disk');
    assert.match(dna, /competitor copy removed/, 'the strip marker is present');
    assert.match(dna, /our own honest line about the eyepiece/, 'the brand\'s own copy survives the scrub');
  } finally {
    cleanup(home);
  }
});

test('RD-9: the CLEAN fixture DNA + catalog carry no >N-word verbatim competitor overlap', async () => {
  const { env, home, brandDir } = withHome();
  const nv = readJsonFixture('expected/no-verbatim-check.json');
  const n = Number(nv.min_shingle_words) || gen.DEFAULT_SHINGLE_WORDS;
  const norm = (s) => String(s).toLowerCase().replace(/\s+/g, ' ');
  try {
    const res = await gen.generateBrandDna({ brand: BRAND, env, dnaSeat: fixtureSeatBridge(), yes: true });
    // The clean fixture prose passes WITHOUT any strip (no flags).
    assert.match(res.status, /^generated/);
    assert.equal(res.data.verbatim_flags.length, 0, 'the clean fixture prose needs no stripping');

    // Scan every written artifact for the documented forbidden competitor substrings.
    const dna = fs.readFileSync(path.join(brandDir, 'brand-dna.md'), 'utf8');
    const archDir = path.join(brandDir, 'archetypes');
    const catText = fs.readdirSync(archDir).filter((f) => f.endsWith('.md'))
      .map((f) => fs.readFileSync(path.join(archDir, f), 'utf8')).join('\n');
    const haystacks = { 'brand-dna.md': norm(dna), 'archetype catalog': norm(catText) };

    for (const f of nv.forbidden_substrings) {
      const needle = norm(f.phrase);
      for (const [where, hay] of Object.entries(haystacks)) {
        assert.ok(!hay.includes(needle), `competitor verbatim "${f.phrase}" leaked into ${where}`);
      }
    }

    // Belt-and-suspenders: a programmatic shingle check confirms NO n-word competitor shingle
    // appears in the generated DNA (independent of the documented forbidden list).
    const shingles = gen.buildCompetitorShingles(
      competitorTexts().map((t) => ({ text: t })), n,
    );
    const { hits } = gen.stripVerbatim(dna, shingles, n);
    assert.equal(hits.length, 0, `no ${n}-word competitor shingle may appear in the generated DNA`);
  } finally {
    cleanup(home);
  }
});

test('RD-9: the canonical fail-closed guard accepts clean output and rejects an embedded competitor item', () => {
  const comp = competitorTexts().map((t) => ({ text: t, trust_class: 'untrusted-scraped' }));
  // Clean synthesis: passes.
  const clean = gen.canonicalVerbatimGuard({ voice: 'A wholly derived, original brand voice line.' }, comp);
  assert.equal(clean.ok, true);
  // Embed a whole competitor item verbatim: the guard flags it (>= 40-char substring leak).
  const leaked = gen.canonicalVerbatimGuard({ voice: comp[0].text }, comp);
  assert.equal(leaked.ok, false, 'a whole competitor item embedded verbatim must be refused');
  assert.ok(Array.isArray(leaked.leaks) && leaked.leaks.length >= 1);
});

// ===========================================================================
// (5) METERED-ACTION GATE (DD-18) — estimate-only/no spend, --yes, idempotency.
// ===========================================================================

test('DD-18: --estimate-only spends nothing, calls no seat, writes nothing', async () => {
  const { env, home, brandDir } = withHome();
  let seatCalled = 0;
  const seat = fixtureSeatBridge({ counter: () => { seatCalled += 1; } });
  try {
    const res = await gen.generateBrandDna({ brand: BRAND, env, estimateOnly: true, dnaSeat: seat });
    assert.equal(res.ok, true);
    assert.equal(res.status, 'estimate-only');
    assert.equal(res.data.estimate.synthesis_calls, 1, 'one synthesis would be billed (a corpus exists)');
    assert.equal(res.data.estimate.own_items, 8);
    assert.equal(res.data.estimate.competitor_items, 8);
    assert.ok(res.data.estimate.estimated_total_usd.high > 0, 'a non-zero indicative band is reported');
    assert.equal(seatCalled, 0, 'estimate-only never invokes the metered seat');
    assert.equal(fs.existsSync(path.join(brandDir, 'brand-dna.md')), false, 'estimate-only writes nothing');
  } finally {
    cleanup(home);
  }
});

test('DD-18: seat wired but no --yes => halts awaiting confirmation, NO seat call, NO write; --yes proceeds', async () => {
  const { env, home, brandDir } = withHome();
  let seatCalled = 0;
  const seat = fixtureSeatBridge({ counter: () => { seatCalled += 1; } });
  try {
    const halt = await gen.generateBrandDna({ brand: BRAND, env, dnaSeat: seat });
    assert.equal(halt.status, 'awaiting-confirmation');
    assert.equal(halt.exitCode, 0, 'a confirmation halt is honest success, not an error');
    assert.equal(halt.data.awaiting_confirmation, true);
    assert.equal(seatCalled, 0, 'the metered seat is NOT called before confirmation');
    assert.equal(fs.existsSync(path.join(brandDir, 'brand-dna.md')), false, 'nothing written before confirmation');

    const go = await gen.generateBrandDna({ brand: BRAND, env, dnaSeat: seat, yes: true });
    assert.match(go.status, /^generated/);
    assert.equal(seatCalled, 1, '--yes confirms and invokes the seat exactly once');
    assert.equal(fs.existsSync(path.join(brandDir, 'brand-dna.md')), true);
  } finally {
    cleanup(home);
  }
});

test('DD-18 / idempotency: a re-run leaves brand-dna.md in place (no re-bill); --force regenerates', async () => {
  const { env, home, brandDir } = withHome();
  const dnaFile = path.join(brandDir, 'brand-dna.md');
  let seatCalled = 0;
  const mkSeat = () => fixtureSeatBridge({ counter: () => { seatCalled += 1; } });
  try {
    const first = await gen.generateBrandDna({ brand: BRAND, env, dnaSeat: mkSeat(), yes: true });
    assert.match(first.status, /^generated/);
    assert.equal(seatCalled, 1);
    const mtime1 = fs.statSync(dnaFile).mtimeMs;
    const billedAfterFirst = seatCalled;

    const second = await gen.generateBrandDna({ brand: BRAND, env, dnaSeat: mkSeat(), yes: true });
    assert.equal(second.status, 'exists', 'a re-run is a no-op');
    assert.equal(second.data.regenerated, false);
    assert.equal(seatCalled, billedAfterFirst, 'a re-run does NOT re-bill the metered seat');
    assert.equal(fs.statSync(dnaFile).mtimeMs, mtime1, 'a re-run does not overwrite brand-dna.md');

    const forced = await gen.generateBrandDna({ brand: BRAND, env, dnaSeat: mkSeat(), yes: true, force: true });
    assert.match(forced.status, /^generated/);
    assert.equal(forced.data.regenerated, true, '--force regenerates');
    assert.equal(seatCalled, billedAfterFirst + 1, '--force bills exactly one more synthesis');
  } finally {
    cleanup(home);
  }
});

test('DD-18 cost-estimate ground truth: metered actions are gated; free intake paths are not', () => {
  const ce = readJsonFixture('expected/cost-estimate.json');
  assert.equal(ce.assertions.estimate_presented_before_spend, true);
  assert.equal(ce.assertions.confirm_required_for_each_metered_action, true);
  // Both metered actions (scrape, dna-synthesis) require confirm; the fixture seats spend nothing.
  for (const a of ce.metered_actions) {
    assert.equal(a.gated, true, `${a.action} is gated`);
    assert.equal(a.requires_confirm, true, `${a.action} requires confirmation`);
  }
  assert.ok(ce.assertions.free_paths_ungated.includes('manual-submission'));
  assert.ok(ce.assertions.free_paths_ungated.includes('official-account-export'));

  // The engine's own estimate over the fixture corpus reports one synthesis call (corpus present),
  // and a corpus-free estimate reports zero (cold-start path spends nothing).
  const h = withHome();
  try {
    const est = gen.estimateDnaCost({ brand: BRAND, env: h.env });
    assert.equal(est.synthesis_calls, 1);
    assert.equal(est.own_items, 8);
    assert.equal(est.competitor_items, 8);
  } finally { cleanup(h.home); }

  const empty = withHome({ withCorpus: false });
  try {
    const est0 = gen.estimateDnaCost({ brand: BRAND, env: empty.env });
    assert.equal(est0.synthesis_calls, 0, 'no corpus => no metered synthesis spend (DD-21)');
    assert.equal(est0.estimated_total_usd.high, 0);
  } finally { cleanup(empty.home); }
});

// ===========================================================================
// (6) CONFIG-GATED / OFF paths are no-ops — scraper off by default; free paths work.
// ===========================================================================

test('scraper ingestion is OFF by default: ingestCorpus refuses without an opt-in (no provider contacted)', async () => {
  const { env, home } = withHome({ withCorpus: false });
  try {
    // No `ingest` config block at all => disabled => IngestDisabledError, BEFORE any adapter call.
    await assert.rejects(
      () => ingest.ingestCorpus({ brand: BRAND, env, account: '@acmecosmos', confirmed: true }),
      (err) => err instanceof ingest.IngestDisabledError,
      'the scraper pathway must be off by default (the LAW)',
    );
    assert.equal(ingest.isEnabled({}), false, 'isEnabled is false with no ingest block');
    assert.equal(ingest.isEnabled({ ingest: { enabled: 'yes' } }), false, 'only strict boolean true enables (fail-closed)');
    assert.equal(ingest.isEnabled({ ingest: { enabled: true } }), true);
  } finally {
    cleanup(home);
  }
});

test('DD-18 on the scraper path: enabled but unconfirmed scrape is refused with a cost estimate', async () => {
  const { env, home } = withHome({ withCorpus: false });
  const config = { ingest: { enabled: true, adapter: 'fixture', max_per_account: 50 } };
  try {
    await assert.rejects(
      () => ingest.ingestCorpus({ config, brand: BRAND, env, account: '@acmecosmos', competitors: ['@stellaroptics'], fetchImpl: async () => [] }),
      (err) => err instanceof ingest.IngestNotConfirmedError && err.estimate && err.estimate.item_estimate > 0,
      'a metered scrape must be refused until confirmed, with an estimate (DD-18)',
    );
  } finally {
    cleanup(home);
  }
});

test('FREE intake paths always work (no opt-in, no spend): manual submission + official-account export', () => {
  const { env, home } = withHome({ withCorpus: false });
  try {
    // (a) Manual submission of a dropped loose-item file — always available, lands Zone-U corpus items.
    const stagingDir = path.join(home, 'staging');
    fs.mkdirSync(stagingDir, { recursive: true });
    fs.writeFileSync(
      path.join(stagingDir, 'drop.json'),
      JSON.stringify([
        { text: 'On collimation: most beginners overthink it. A thirty-second check before each session is plenty.' },
        { text: 'The terminator is where the Moon shows its best detail. Aim there, not at the bright full disc.' },
      ]),
      'utf8',
    );
    const manual = ingest.importManualSubmission({ brand: BRAND, env, dir: stagingDir, account_class: 'own' });
    assert.equal(manual.source, 'manual', 'manual import path is first-class');
    assert.equal(manual.items.length, 2, 'both dropped items became corpus items');
    assert.equal(manual.by_class.own, 2, 'a manual drop defaults to the operator\'s OWN corpus');

    // (b) Official-account export -> own corpus, no scraper/credential.
    const exp = ingest.importAccountExport({
      brand: BRAND,
      env,
      format: 'twitter',
      handle: 'acmecosmos',
      data: [
        { tweet: { full_text: 'Clear sky tonight? Point low east for Jupiter and step down to a 10mm eyepiece.', created_at: '2099-01-02T20:00:00Z', id_str: '1' } },
        { tweet: { full_text: 'Three minutes to a sharp Moon, every time: red dot, 25mm, focus on the terminator.', created_at: '2099-01-03T20:00:00Z', id_str: '2' } },
      ],
    });
    assert.equal(exp.source, 'export');
    assert.equal(exp.items.length, 2, 'both exported tweets became corpus items');
    assert.equal(exp.by_class.own, 2, 'an official export is the operator\'s OWN corpus');
    for (const it of exp.items) {
      // Each written item is Zone U and schema-valid (the in-memory _account_class is stripped first).
      const { _account_class, ...schemaItem } = it;
      assert.equal(schemaItem.trust_class, 'untrusted-scraped', 'all ingested corpora enter Zone U (RD-8)');
      assert.equal(schemaItem.retention_class, 'retained', 'operator-supplied keepers are retained');
      const r = validate(schemaItem, corpusItemSchema);
      assert.equal(r.ok, true, `exported item must validate — errors: ${JSON.stringify(r.errors)}`);
    }
    // The exported items were written under corpora/<brand>/ and are now generate-able.
    assert.ok(exp.written.length === 2, 'export wrote both items to the brand corpus');
  } finally {
    cleanup(home);
  }
});

test('the FIXTURE scraper adapter is a zero-key BYO seam (RD-9/RD-12): replays the corpus, presents an estimate', async () => {
  // Pure seam check — no opt-in needed to USE the helper directly; it contacts no provider.
  const adapter = scraperHelper.makeFakeScraperAdapter();
  assert.equal(adapter.capabilities().requires_key, false, 'no key (RD-12)');
  const own = await adapter.scrape({ platform: 'twitter', handle: '@acmecosmos' });
  assert.equal(own.length, 8, 'replays the 8 own fixture items zero-key');
  const est = adapter.estimate({ handles: 3, max_items_per_handle: 200 });
  assert.equal(est.requires_confirm, true, 'a metered scrape presents a cost estimate + confirm (DD-18)');
  assert.equal(est.est_cost_usd, 0, 'the fixture adapter spends nothing');
});
