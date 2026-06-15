'use strict';

/**
 * tests/brand-dna-generate.test.js  [BD-GENERATE]
 *
 * Covers engine/brand-dna/generate.js (release-spec §1.1 Data Ingestion & Brand Identity / §1.2
 * Context & Competitor Analysis; §2.4 C2 Brand DNA; DD-18 estimate-and-confirm; DD-21 cold-start +
 * degrade; RD-9 competitor-not-verbatim).
 *
 * ZERO-KEY (RD-12): every test injects a FAKE dnaSeat + FAKE analyzer (or uses the built-in
 * deterministic fallback) over a synthetic corpus — no provider block, no secret, no child process,
 * no network. A real temp CONTENT_HOME exercises the corpus read + atomic write paths.
 *
 * Asserts:
 *   - DD-18: with a seat wired, generate halts awaiting confirmation and makes NO seat call until yes;
 *   - estimate-only spends nothing and reports the synthesis count × band;
 *   - cold start (no corpus): writes the manual authoring template, never blocks onboarding (DD-21);
 *   - degrade (corpus, no seat): writes the prefilled authoring template + deterministic catalog (DD-21);
 *   - full generation (seat wired + yes): writes brand-dna.md (identity/tone/voice/do/do-not/
 *     signature moves) + archetype catalog + updates brand.json voice fields;
 *   - RD-9: a seat that echoes competitor copy has the verbatim span STRIPPED + FLAGGED on disk;
 *   - idempotent: a second run leaves brand-dna.md in place; --force regenerates;
 *   - a throwing seat degrades to the template path (onboarding never blocked).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const gen = require('../engine/brand-dna/generate.js');

const BRAND = 'acme-cosmos';

/** Spin up an isolated CONTENT_HOME with a brand.json + optional corpus items. */
function withHome({ corpus, competitors, brandJson } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oce-bdna-'));
  const brandDir = path.join(home, 'brands', BRAND);
  fs.mkdirSync(brandDir, { recursive: true });
  if (brandJson !== null) {
    fs.writeFileSync(
      path.join(brandDir, 'brand.json'),
      JSON.stringify(brandJson || baseBrandJson(), null, 2),
    );
  }
  const corpusDir = path.join(home, 'corpora', BRAND);
  const writeItems = (items, sub) => {
    if (!items || !items.length) return;
    const dir = sub ? path.join(corpusDir, sub) : corpusDir;
    fs.mkdirSync(dir, { recursive: true });
    items.forEach((it, i) => fs.writeFileSync(path.join(dir, `item-${i}.json`), JSON.stringify(it, null, 2)));
  };
  writeItems(corpus);
  writeItems(competitors, 'competitors');
  return { env: { CONTENT_HOME: home }, home, brandDir };
}

function cleanup(home) {
  fs.rmSync(home, { recursive: true, force: true });
}

function baseBrandJson() {
  return {
    schema_version: '1.0.0',
    id: BRAND,
    display_name: 'Acme Cosmos',
    account_class: 'brand',
    drama_dial: 'medium',
    platforms: [{ platform: 'twitter', publisher: 'postiz' }],
  };
}

function corpusItem(text) {
  return { source: 'manual', captured_at: '2026-01-01T00:00:00Z', text, trust_class: 'untrusted-scraped', retention_class: 'standard' };
}

/** A fake host synthesis seat returning fixed voice prose + archetypes. */
function fakeSeat(extra = {}) {
  let calls = 0;
  const fn = async (input) => {
    calls += 1;
    return {
      display_name: 'Acme Cosmos',
      drama_dial: 'high',
      identity: 'Acme Cosmos builds plain, useful tools for builders.',
      tone: 'Confident and grounded; energy without hype.',
      voice: 'First-person community voice; short sentences; one concrete example each time.',
      do: ['Name the thing in plain words', 'Show one example'],
      do_not: ['Manufactured urgency', 'Emoji stacks'],
      signature_moves: ['Open with a concrete result', 'Close with an invitation'],
      signature_moves_prose: 'The brand reliably leads with proof.',
      archetypes: [
        { id: 'announcement', name: 'Announcement', angle: 'We shipped X and here is why it matters', hook_direction: 'Lead with the shipped result', must_include: ['what shipped'], structure: 'hook -> result -> why' },
        { name: 'Teaching Thread', angle: 'Explain one idea clearly', hook_direction: 'A sharp question' },
      ],
      ...extra,
    };
  };
  fn.calls = () => calls;
  return fn;
}

test('estimate-only: reports synthesis count × band, spends nothing, writes nothing', async () => {
  const { env, home, brandDir } = withHome({ corpus: [corpusItem('we shipped the launch today')] });
  try {
    const res = await gen.generateBrandDna({ brand: BRAND, env, estimateOnly: true, dnaSeat: fakeSeat() });
    assert.equal(res.ok, true);
    assert.equal(res.status, 'estimate-only');
    assert.equal(res.data.estimate.synthesis_calls, 1);
    assert.ok(res.data.estimate.estimated_total_usd.high > 0);
    assert.equal(fs.existsSync(path.join(brandDir, 'brand-dna.md')), false);
  } finally {
    cleanup(home);
  }
});

test('DD-18: seat wired but no --yes => halts awaiting confirmation, NO seat call, NO write', async () => {
  const { env, home, brandDir } = withHome({ corpus: [corpusItem('we shipped the launch today')] });
  const seat = fakeSeat();
  try {
    const res = await gen.generateBrandDna({ brand: BRAND, env, dnaSeat: seat });
    assert.equal(res.status, 'awaiting-confirmation');
    assert.equal(res.data.awaiting_confirmation, true);
    assert.equal(seat.calls(), 0, 'the metered seat must not be called before confirmation');
    assert.equal(fs.existsSync(path.join(brandDir, 'brand-dna.md')), false);
  } finally {
    cleanup(home);
  }
});

test('cold start (no corpus): writes the manual authoring template, never blocks (DD-21)', async () => {
  const { env, home, brandDir } = withHome({}); // no corpus
  try {
    const res = await gen.generateBrandDna({ brand: BRAND, env, dnaSeat: fakeSeat(), yes: true });
    assert.equal(res.ok, true);
    assert.equal(res.status, 'cold-start');
    const dna = fs.readFileSync(path.join(brandDir, 'brand-dna.md'), 'utf8');
    assert.match(dna, /Brand DNA/);
    assert.match(dna, /authoring template|Identity/i);
  } finally {
    cleanup(home);
  }
});

test('degrade (corpus, no seat): prefilled authoring template + deterministic catalog (DD-21)', async () => {
  const { env, home, brandDir } = withHome({
    corpus: [
      corpusItem('we shipped the new launch today and here is why it matters'),
      corpusItem('here is how to use the build, a quick guide thread'),
    ],
  });
  try {
    const res = await gen.generateBrandDna({ brand: BRAND, env }); // no dnaSeat
    assert.equal(res.ok, true);
    assert.equal(res.status, 'degraded-no-seat');
    const dna = fs.readFileSync(path.join(brandDir, 'brand-dna.md'), 'utf8');
    assert.match(dna, /Auto analysis \(deterministic/);
    // A deterministic catalog was written.
    const archDir = path.join(brandDir, 'archetypes');
    const files = fs.readdirSync(archDir).filter((f) => f.endsWith('.md'));
    assert.ok(files.length >= 1, 'deterministic catalog should be non-empty for a real corpus');
  } finally {
    cleanup(home);
  }
});

test('full generation (seat + yes): writes DNA sections + catalog + updates brand.json voice fields', async () => {
  const { env, home, brandDir } = withHome({ corpus: [corpusItem('we shipped the launch today, a quick guide')] });
  try {
    const res = await gen.generateBrandDna({ brand: BRAND, env, dnaSeat: fakeSeat(), yes: true });
    assert.equal(res.ok, true);
    assert.match(res.status, /^generated/);

    const dna = fs.readFileSync(path.join(brandDir, 'brand-dna.md'), 'utf8');
    assert.match(dna, /## 1. Identity/);
    assert.match(dna, /## 2. Tone/);
    assert.match(dna, /## 3. Voice/);
    assert.match(dna, /Always do/);
    assert.match(dna, /Never do/);
    assert.match(dna, /## 5. Signature moves/);
    assert.match(dna, /Name the thing in plain words/);

    // Archetype catalog: seat archetypes win; the unnamed-id one is slugged.
    const archDir = path.join(brandDir, 'archetypes');
    const files = fs.readdirSync(archDir).filter((f) => f.endsWith('.md'));
    assert.ok(files.includes('announcement.md'));
    assert.ok(files.includes('teaching-thread.md'), `expected slugged id, got ${files.join(',')}`);

    // brand.json voice fields updated.
    const cfg = JSON.parse(fs.readFileSync(path.join(brandDir, 'brand.json'), 'utf8'));
    assert.equal(cfg.drama_dial, 'high');
    assert.equal(cfg.paths.dna, `brands/${BRAND}/brand-dna.md`);
    assert.equal(cfg.paths.archetypes, `brands/${BRAND}/archetypes`);
    // untouched fields preserved.
    assert.equal(cfg.id, BRAND);
    assert.equal(cfg.account_class, 'brand');
  } finally {
    cleanup(home);
  }
});

test('RD-9: a seat echoing competitor copy has the verbatim span STRIPPED + FLAGGED on disk', async () => {
  const competitorLine = 'unleash maximum synergy with our revolutionary disruptive growth engine now';
  const { env, home, brandDir } = withHome({
    corpus: [corpusItem('we shipped the launch today')],
    competitors: [corpusItem(competitorLine)],
  });
  // Seat lifts the competitor sentence verbatim into the voice prose.
  const leakySeat = fakeSeat({ voice: `Our voice: ${competitorLine}. And our own line.` });
  try {
    const res = await gen.generateBrandDna({ brand: BRAND, env, dnaSeat: leakySeat, yes: true });
    assert.equal(res.ok, true);
    assert.equal(res.status, 'generated-with-stripped-verbatim');
    assert.ok(res.data.verbatim_flags.length >= 1, 'a verbatim leak must be flagged');
    const dna = fs.readFileSync(path.join(brandDir, 'brand-dna.md'), 'utf8');
    assert.doesNotMatch(dna, /revolutionary disruptive growth engine/, 'competitor copy must NOT reach disk');
    assert.match(dna, /competitor copy removed/, 'the strip marker must be present');
    // The brand's own copy survives the scrub.
    assert.match(dna, /our own line/);
  } finally {
    cleanup(home);
  }
});

test('idempotent: a second run leaves brand-dna.md in place; --force regenerates', async () => {
  const { env, home, brandDir } = withHome({ corpus: [corpusItem('we shipped the launch today')] });
  const dnaFile = path.join(brandDir, 'brand-dna.md');
  try {
    const first = await gen.generateBrandDna({ brand: BRAND, env, dnaSeat: fakeSeat(), yes: true });
    assert.match(first.status, /^generated/);
    const mtime1 = fs.statSync(dnaFile).mtimeMs;

    const second = await gen.generateBrandDna({ brand: BRAND, env, dnaSeat: fakeSeat(), yes: true });
    assert.equal(second.status, 'exists');
    assert.equal(second.data.regenerated, false);
    assert.equal(fs.statSync(dnaFile).mtimeMs, mtime1, 'no overwrite without --force');

    const forced = await gen.generateBrandDna({ brand: BRAND, env, dnaSeat: fakeSeat(), yes: true, force: true });
    assert.match(forced.status, /^generated/);
    assert.equal(forced.data.regenerated, true);
  } finally {
    cleanup(home);
  }
});

test('a throwing seat degrades to the template path (onboarding never blocked, DD-21)', async () => {
  const { env, home, brandDir } = withHome({ corpus: [corpusItem('we shipped the launch today')] });
  const throwingSeat = async () => { throw new Error('seat exploded'); };
  try {
    const res = await gen.generateBrandDna({ brand: BRAND, env, dnaSeat: throwingSeat, yes: true });
    assert.equal(res.ok, true);
    assert.equal(res.status, 'seat-failed-degraded');
    assert.match(res.summary, /seat exploded/);
    assert.equal(fs.existsSync(path.join(brandDir, 'brand-dna.md')), true);
  } finally {
    cleanup(home);
  }
});

test('injected analyzer is used over the built-in fallback', async () => {
  const { env, home } = withHome({ corpus: [corpusItem('hello world')] });
  let analyzeCalled = false;
  let categorizeCalled = false;
  const analyzeCorpus = () => { analyzeCalled = true; return { item_count: 1, analyzer: 'injected' }; };
  const categorizeArchetypes = () => { categorizeCalled = true; return [{ id: 'custom', name: 'Custom' }]; };
  try {
    const res = await gen.generateBrandDna({ brand: BRAND, env, analyzeCorpus, categorizeArchetypes, dnaSeat: fakeSeat({ archetypes: [] }), yes: true });
    assert.equal(res.ok, true);
    assert.equal(analyzeCalled, true);
    assert.equal(categorizeCalled, true);
    assert.equal(res.data.analyzer_source, 'injected');
  } finally {
    cleanup(home);
  }
});

test('missing brand.json: generation still writes DNA, reports brand.json not updated', async () => {
  const { env, home, brandDir } = withHome({ corpus: [corpusItem('we shipped the launch today')], brandJson: null });
  try {
    const res = await gen.generateBrandDna({ brand: BRAND, env, dnaSeat: fakeSeat(), yes: true });
    assert.equal(res.ok, true);
    assert.equal(res.data.brand_json.updated, false);
    assert.match(res.data.brand_json.reason, /brand\.json missing/);
    assert.equal(fs.existsSync(path.join(brandDir, 'brand-dna.md')), true);
  } finally {
    cleanup(home);
  }
});

test('no CONTENT_HOME: returns a named error, never throws', async () => {
  const res = await gen.generateBrandDna({ brand: BRAND, env: {} });
  assert.equal(res.ok, false);
  assert.equal(res.status, 'no-home');
});
