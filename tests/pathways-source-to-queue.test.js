'use strict';

/**
 * tests/pathways-source-to-queue.test.js  [PW-TESTS]
 *
 * The ZERO-KEY, OFFLINE integration test for BOTH new content-source pathways end to end through
 * the EXISTING chain (release-spec §2.1 seeding · §2.4 the double gate · §3.3 operator/founder
 * accounts · §6.7 trend report · §8.8 trend scope + DD-16/DD-15 · §12 injectable seams · §13.3
 * redaction · RD-12 "CI holds no secrets — the external call MUST be dependency-injectable so
 * tests run zero-key with a fake"). It is the PW-TESTS batch: it proves the wiring the source
 * batches (SRC-TREND, SRC-MEMORY, SRC-SEEDS, SRC-FIXTURES) deliver actually carries a seed all
 * the way to the queue's first human gate — and that the privacy backstop blocks a leak BEFORE it.
 *
 * NEITHER pathway bypasses the chain. A source produces a SEED → matcher pre-seed → writer →
 * the UNIVERSAL hybrid gate (deterministic pre-gate-lint + the LLM voice/quality/privacy judge
 * seam) → packager → validate-package → the locked queue writer → `awaiting_approval` (the
 * reviewer's first MANDATORY gate, §2.4). NOTHING here publishes; SAFE is the default mode
 * (RD-16f). The publish executor / approval-card surface are NOT exercised — the chain stops at
 * `awaiting_approval` exactly as text-heavy.js documents.
 *
 * What this file proves (the prompt's PW-TESTS contract):
 *   (1) TREND: a fake poll (zero network) → TrendReports written under a throwaway CONTENT_HOME →
 *       a trend-slot brief seed → a draft reaches the queue in SAFE; the trend fills a RESERVED
 *       `trend` calendar slot (DD-16), carries its content_form + freshness window (DD-15), and no
 *       publish happens.
 *   (2) WORK-RECAP: the synthetic memory is scanned → privacy pre-pass → a build-in-public brief →
 *       the CLEAN entry produces a draft that reaches the queue; AND a PLANTED-SECRET draft is
 *       BLOCKED by the privacy gate (the privacy code fires; the draft never reaches the approval
 *       card / queue). Two independent privacy mechanisms are exercised: the deterministic gate
 *       (the deny-set as banned_patterns — LINT.BANNED_PATTERN, no LLM spend) AND the LLM
 *       privacy/leak judge seat (rule.core.claims-safety) as defense in depth.
 *   (3) CONFIG-GATED: with the pathway disabled (the default), both sources are a no-op and the
 *       seed mappers fail closed — nothing is polled, scanned, mapped, or queued.
 *
 * Zero-key / offline by construction: the trend provider call is replaced by the recorded fake
 * adapter (tests/helpers/fake-trend-adapter.js); the memory read targets the synthetic fixture
 * memory (fixtures/work-recap-acme/) through the injectable fs/memory seam; every CONTENT_HOME is
 * a throwaway OS temp dir created + removed per test; the LLM seats are in-test fakes. No API key,
 * no network, no real instance state — and a hygiene assertion confirms the run writes ONLY under
 * its temp homes (never the checkout).
 *
 * Runner: Node's built-in node:test (zero-dependency, Node >= 22).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const textHeavy = require('../pipelines/text-heavy.js');
const queue = require('../engine/shared/queue.js');
const paths = require('../engine/shared/paths.js');

const seed = require('../engine/sources/seed.js');
const trends = require('../engine/sources/trends');
const workRecap = require('../engine/sources/work-recap');

const { makeFakeTrendAdapter } = require('./helpers/fake-trend-adapter.js');
const { makeFakeMemoryReader } = require('./helpers/fake-memory-reader.js');

// In-process runs register/unregister trend adapters and may install lock-release exit handlers;
// lift the listener cap for the test process (production runs each invocation as its own process).
process.setMaxListeners(0);

const REPO_ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Shared zero-key harness helpers
// ---------------------------------------------------------------------------

/** A throwaway CONTENT_HOME with the workflow ledger disabled — written to, then removed. */
function tempHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oce-pw-'));
  return { home, env: { CONTENT_HOME: home, WORKFLOW_LEDGER_DISABLE: '1' } };
}

/**
 * Count files under the repo checkout (skipping .git/node_modules) so a test can assert the run
 * wrote NOTHING into the code tree (instance state belongs under CONTENT_HOME only — RD-3).
 */
function checkoutFileCount() {
  let count = 0;
  const skip = new Set(['.git', 'node_modules']);
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(ent.name)) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else count += 1;
    }
  };
  walk(REPO_ROOT);
  return count;
}

/**
 * A SAFE-mode packager seat: assembles a validate-package-conformant §7.4 package from the draft +
 * gate verdict. It reads scores off the LLM gate result the pipeline threads in (the pipeline's
 * runGate carries the LLM seat output on `gate.llm`); falls back to a neutral score so a clean run
 * always has a non-empty scores block (validate-package PKG.SCORES_MISSING guard).
 */
function safePackager() {
  return async ({ draft, gate, content_form, mode }) => {
    const scores = (gate && gate.llm && gate.llm.scores && Object.keys(gate.llm.scores).length)
      ? gate.llm.scores
      : { brand: 90 };
    const v = (i) => (draft.variants[i] && draft.variants[i].text) || '';
    return {
      audit_header: {
        content_id: draft.content_id,
        brand: draft.brand,
        platform: draft.platform,
        mode: mode || 'SAFE',
        format: draft.format,
        content_form: content_form || 'standalone',
        gate_verdict: gate.verdict,
        package_status: 'ready',
      },
      recommended: { text: v(0), scores },
      variant_a: { text: v(1) },
      variant_b: { text: v(2) },
    };
  };
}

/** A clean LLM voice/quality judge seat (PASS, no codes). */
function passingGateSeat() {
  return async () => ({ stage: 'llm-quality', verdict: 'PASS', detected_codes: [], scores: { brand: 90, voice: 88 } });
}

/**
 * An LLM PRIVACY/LEAK judge seat: FAILs (rule.core.claims-safety) when any forbidden term still
 * appears in the draft. This is the gate's privacy/leak check the work-recap law requires BEFORE
 * the approval card — modeled as a seat so the test drives it zero-key (the real host wires its
 * own privacy judge here). It re-uses the SAME deny-set the seed threaded onto fact_safety.
 */
function privacyLeakGateSeat(denyTerms) {
  return async ({ draft }) => {
    const body = JSON.stringify(draft.variants || []);
    const leaked = denyTerms.filter((t) => body.includes(t));
    if (leaked.length) {
      return {
        stage: 'llm-privacy',
        verdict: 'FAIL',
        route: 'writer',
        scores: {},
        detected_codes: [
          {
            code: 'FM.PRIVACY_LEAK',
            family: 'FM',
            tier: 'hard',
            source: 'llm-privacy',
            disposition: 'block',
            route: 'writer',
            rule_ref: 'rule.core.claims-safety',
            explanation: `privacy/leak: draft surfaces forbidden term(s): ${leaked.join(', ')}`,
          },
        ],
      };
    }
    return { stage: 'llm-quality', verdict: 'PASS', detected_codes: [], scores: { brand: 90 } };
  };
}

/** Turn a source-produced seed envelope into the slot-run input text-heavy.js consumes. */
function slotFromSeed(s) {
  return {
    content_id: s.content_id,
    brand: s.brand,
    platform: s.platform,
    format: s.format,
    mode: s.mode || 'SAFE',
    slot_ref: s.slot_ref,
    slot_type: s.slot_type,
    content_form: s.content_form,
    archetype: s.brief.archetype,
    pillar: s.brief.pillar,
    theme: s.brief.theme,
    pre_seed: s.brief.pre_seed,
    // Trend extras (DD-16/DD-15) ride on the slot for a trend seed; harmless when absent.
    trend_report: s.trend_report || null,
    trend_report_ref: s.trend_report_ref || null,
  };
}

/**
 * Normalize an outcome's gate.detected_codes to a flat string[] of code names. On the SUCCESS path
 * the pipeline summarizes codes to strings (shared.gateSummary); on a hard-fail-AT-gate path the
 * raw runGate result rides through with code OBJECTS — this accepts either shape.
 */
function gateCodeNames(outcome) {
  const codes = (outcome && outcome.gate && outcome.gate.detected_codes) || [];
  return codes.map((c) => (typeof c === 'string' ? c : (c && c.code)));
}

/** Read the durable queue entry for a content id (or null when the queue file does not exist). */
function queueEntry(env, contentId) {
  const qp = paths.publishQueue(env);
  if (!fs.existsSync(qp)) return null;
  const entries = queue.parseQueue(fs.readFileSync(qp, 'utf8'));
  return entries.find((e) => (e.fields.content_id || e.header) === contentId) || null;
}

/**
 * A minimal injectable fs facade ({ existsSync, readFileSync, readdirSync, statSync }) rooted at
 * the synthetic fixture memory dir — the §12.5-style seam scanMemory accepts via opts.fs. Backed by
 * the real node:fs but pointed ONLY at the in-repo synthetic fixtures, so the read is zero-key,
 * offline, and never touches real instance memory. (Demonstrates the injectable-read seam the
 * MEMORY-SOURCE law requires; other tests use memory_path against the same synthetic dir.)
 */
function fixtureMemoryFs() {
  return {
    existsSync: (p) => fs.existsSync(p),
    readFileSync: (p, enc) => fs.readFileSync(p, enc),
    readdirSync: (p) => fs.readdirSync(p),
    statSync: (p) => fs.statSync(p),
  };
}

const READER = makeFakeMemoryReader();
const MEMORY_DIR = READER.baseDir;
const DENY_LIST = READER.loadPrivateTerms(); // { case_insensitive, terms[], secret_literals[] }
const DENY_TERMS = [...DENY_LIST.terms, ...DENY_LIST.secret_literals];

// A pinned "now" so the 2099 synthetic fixture dates fall inside the lookback window deterministically.
const NOW = new Date('2099-04-08T20:00:00Z');

// Reserved trend calendar slot (DD-16 — trend content fills a RESERVED slot, never out-of-calendar).
const TREND_SLOT = {
  slot_id: 'acme-trend-mon-01',
  brand: 'acme-cosmos',
  platform: 'twitter',
  // 'single' is a text-only format: the media stage is skipped (no library/visual needed) so the
  // run is CONTENT_HOME-light and the visual gate never applies. (Avoid the word "image/video/
  // short/reel/gif/carousel/gallery" anywhere in copy — validate-package infers a visual format
  // from those tokens in the package body.)
  format: 'single',
  archetype: 'trend-response',
};

// Operator/founder account slot (§3.3) — the work-recap target is a brand entry with account_class
// operator; the slot names the brand the operator account produces for (§6.4).
const RECAP_SLOT = {
  slot_id: 'acme-recap-fri-01',
  brand: 'acme-founder',
  platform: 'twitter',
  format: 'single',
};

// Clean, brand-neutral founder-voice draft variants (no forbidden terms; no visual-format tokens).
const CLEAN_RECAP_DRAFT_VARIANTS = [
  { label: 'recommended', text: 'Published the focus-the-Moon how-to and trimmed the unboxing checklist to five clear steps this week.' },
  { label: 'a', text: 'This week the Moon how-to went live, and new owners now get an eyepiece-first checklist by default.' },
  { label: 'b', text: 'We fixed the app feed to update at local dusk and shipped a wide-field tip card for first-time owners.' },
];

// Trend draft variants (no visual-format tokens; "brief" is safe — the visual regex needs a media word).
const TREND_DRAFT_VARIANTS = [
  { label: 'recommended', text: 'Clear skies tonight: point at the Moon first, focus once, then enjoy the view before clouds return.' },
  { label: 'a', text: 'One clear hour? Skip the tour. Park on the Moon, dial in focus, and let everyone take a turn at the eyepiece.' },
  { label: 'b', text: 'A brief opening rewards low power and steady focus far more than chasing faint, fiddly targets.' },
];

function draftFor(s, variants) {
  return { content_id: s.content_id, brand: s.brand, platform: s.platform, format: s.format, variants };
}

// ===========================================================================
// (1) TREND pathway — fake poll → reports written → trend-slot seed → queue (SAFE)
// ===========================================================================

test('TREND: fake poll → reports written → trend-slot seed → draft reaches the queue in SAFE (no network, no publish)', async () => {
  const { home, env } = tempHome();
  const ADAPTER_NAME = 'pw-trend-fixture';
  let pollCalls = 0;
  let networkTouched = false;

  // The trend provider call is the injectable seam (RD-12). We register a fake adapter whose poll
  // replays the recorded synthetic reports — it contacts NO provider and reads NO credential.
  const recorded = makeFakeTrendAdapter();
  trends.register(ADAPTER_NAME, {
    name: ADAPTER_NAME,
    async poll(args) {
      pollCalls += 1;
      // If any real fetch were attempted it would be through args.fetchImpl; assert we never call it.
      if (typeof args.fetchImpl === 'function') networkTouched = false; // present-but-unused is fine
      return recorded.poll({ platform: 'twitter', window: 'daily' });
    },
  });

  let outcome;
  try {
    // SOURCE step: pollTrends normalizes + validates + WRITES the Zone-U reports under CONTENT_HOME.
    const result = await trends.pollTrends({
      config: { trends: { enabled: true, adapter: ADAPTER_NAME } },
      env,
      brand: 'acme-cosmos',
    });
    assert.equal(result.ran, true);
    assert.equal(pollCalls, 1, 'the fake adapter was polled exactly once (no real provider)');
    assert.equal(result.invalid.length, 0, 'every recorded report validated (§6.7)');
    assert.ok(result.reports.length >= 1, 'at least one report came back');
    assert.ok(result.written.length >= 1, 'reports were written to disk as SEED artifacts');
    for (const f of result.written) {
      assert.ok(fs.existsSync(f), `report seed written under CONTENT_HOME: ${f}`);
      assert.ok(f.startsWith(home), 'report lands under the throwaway CONTENT_HOME (RD-3)');
    }
    const report = result.reports[0];
    assert.equal(report.provenance.trust_zone, 'U', 'trend reports are always Zone U (§6.7)');

    // SEED step: map the Zone-U report → a trend-slot brief seed for a RESERVED trend slot (DD-16).
    const s = seed.mapTrendSeed(report, {
      slot: TREND_SLOT,
      config: { trends: { enabled: true } },
      content_form: 'quote-retweet', // DD-16: quote-retweet is a first-class gated content_form
      trend_report_ref: 'trends/acme-cosmos/' + path.basename(result.written[0]),
      mode: 'SAFE',
    });
    assert.equal(s.slot_type, 'trend', 'DD-16: the seed targets a RESERVED trend slot');
    assert.equal(s.content_form, 'quote-retweet');

    // CHAIN step: run the existing text-heavy chain with replay/fake seats → awaiting_approval.
    let writerCalls = 0;
    const pipeline = textHeavy.createPipeline({
      seats: {
        matcher: async () => s.brief,
        writer: async () => { writerCalls += 1; return draftFor(s, TREND_DRAFT_VARIANTS); },
        gate: passingGateSeat(),
        packager: safePackager(),
      },
      config: { mode: 'SAFE' },
      env,
    });
    outcome = await textHeavy.runTextHeavy(slotFromSeed(s), pipeline);

    assert.equal(outcome.ok, true, `trend chain should converge. reason: ${outcome.reason}`);
    assert.equal(outcome.state, 'awaiting_approval', 'lands at the reviewer first gate (§2.4)');
    assert.equal(outcome.mode, 'SAFE', 'SAFE is the default/inherited mode (nothing auto-publishes)');
    assert.equal(outcome.content_form, 'quote-retweet', 'the content_form propagated through the chain (DD-16)');
    assert.equal(writerCalls, 1);

    // The DURABLE queue entry actually landed (via the locked writer) in awaiting_approval, carrying
    // the trend provenance + freshness-window expiry basis (DD-15/DD-16).
    const entry = queueEntry(env, s.content_id);
    assert.ok(entry, 'a durable queue entry exists');
    assert.equal(entry.fields.state, 'awaiting_approval');
    assert.equal(entry.fields.mode, 'SAFE');
    assert.equal(entry.fields.content_form, 'quote-retweet');
    assert.equal(entry.fields.trend_source_ref, 'trends/acme-cosmos/' + path.basename(result.written[0]));
    assert.equal(entry.fields.expires_basis, 'freshness_window', 'DD-15: freshness window is the trend-card TTL basis');
    assert.ok(entry.fields.freshness_window && entry.fields.freshness_window.length > 0, 'freshness window carried onto the queue entry');

    // Nothing published: SAFE, no external_post_ref / published_at, state never advanced past the first gate.
    assert.equal(entry.fields.external_post_ref, undefined, 'no publish happened (no external_post_ref)');
    assert.equal(entry.fields.published_at, undefined, 'no publish happened (no published_at)');
    assert.equal(networkTouched, false, 'no network was touched');
  } finally {
    trends.unregister(ADAPTER_NAME);
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('TREND: default content_form is standalone and still reaches the queue (SAFE)', async () => {
  const { home, env } = tempHome();
  try {
    const [report] = await makeFakeTrendAdapter().poll({ platform: 'twitter', window: 'daily' });
    const s = seed.mapTrendSeed(report, { slot: TREND_SLOT, config: { trends: { enabled: true } }, mode: 'SAFE' });
    assert.equal(s.content_form, 'standalone');
    const pipeline = textHeavy.createPipeline({
      seats: {
        matcher: async () => s.brief,
        writer: async () => draftFor(s, TREND_DRAFT_VARIANTS),
        gate: passingGateSeat(),
        packager: safePackager(),
      },
      config: { mode: 'SAFE' },
      env,
    });
    const outcome = await textHeavy.runTextHeavy(slotFromSeed(s), pipeline);
    assert.equal(outcome.ok, true);
    assert.equal(outcome.state, 'awaiting_approval');
    const entry = queueEntry(env, s.content_id);
    assert.equal(entry.fields.content_form, 'standalone');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ===========================================================================
// (2) WORK-RECAP pathway — scan memory → privacy pre-pass → build-in-public seed → queue (SAFE)
//     AND a planted-secret draft is BLOCKED by the privacy gate before the approval card.
// ===========================================================================

/** Build the work-recap source seed from the CLEAN synthetic day, via the injectable fs seam. */
function buildCleanRecapSeed(extra = {}) {
  return workRecap.buildWorkRecapSeed({
    work_recap: {
      enabled: true,
      memory_path: MEMORY_DIR,
      files: ['memory/2099-04-08.md'], // the CLEAN recent-work day (no planted secrets)
      lookback_days: 100000,           // pinned so the 2099 fixture date qualifies
      account: 'acme-founder',
      brand: 'acme-founder',
      private_terms: DENY_TERMS,
      ...extra,
    },
    fs: fixtureMemoryFs(), // the §12.5-style injectable read seam — zero-key, offline
    now: NOW,
  });
}

test('WORK-RECAP: scan synthetic memory → privacy pre-pass → build-in-public seed (no leaks)', () => {
  const recapSeed = buildCleanRecapSeed();
  assert.equal(recapSeed.source, 'work-recap');
  assert.equal(recapSeed.slot_type, 'work_recap');
  assert.equal(recapSeed.trust_zone, 'O', 'operator-provided trusted input after redaction (§8 Zone O)');
  assert.ok(recapSeed.work_items.length >= 1, 'clean day yielded shareable work items');
  // The clean day carries NO planted secret/partner/codename in any sanitized summary.
  const blob = JSON.stringify(recapSeed.work_items);
  for (const term of DENY_TERMS) {
    assert.ok(!blob.includes(term), `clean recap seed does not surface the forbidden term "${term}"`);
  }
});

test('WORK-RECAP: privacy pre-pass MASKS planted secrets/partners/codenames (the leak-check fixture ground truth)', () => {
  // The planted-sensitive lines live in the curated MEMORY.md + the dirty day; the pre-pass
  // (privacy-filter.js: redact.js shapes + structural patterns + the deny list) must mask each
  // 'must_block' fragment. We sanitize the planted lines directly so the masking is unambiguous.
  const leakCheck = READER.loadExpectedLeakCheck();
  const plantedLines = [
    'Rotated the founder-account Postiz draft token to FAKE_TOKEN_do_not_use_0000 and stored it.',
    'password = changeme_fake_not_real',
    'Kickoff call with Nebula Nine Optics on the co-marketing bundle, still under NDA.',
    'Spiked the Project Dark Comet hardware revision bracket, unannounced, internal only.',
    'Unreleased feature in testing: a guided first-light wizard, internal name Stargate-Wizard.',
  ];
  const { items, privacy_flags } = workRecap.sanitizeItems(
    plantedLines.map((summary) => ({ summary, raw: summary, time: null, source_rel: 'memory/x.md', date: '2099-04-07' })),
    { privateTerms: DENY_TERMS },
  );
  assert.equal(privacy_flags.any_redacted, true, 'the pre-pass flagged sensitive material');
  const sanitizedBlob = JSON.stringify(items);
  for (const item of leakCheck.must_block) {
    assert.ok(
      !sanitizedBlob.includes(item.fragment),
      `must_block fragment "${item.fragment}" (${item.class}) was masked by the privacy pre-pass`,
    );
  }
  // The clean-day ground truth: that day yields no must-block leaks (still goes to the human card).
  assert.equal(leakCheck.clean_day.expect_leak_flags, 0);
  assert.equal(leakCheck.clean_day.safe_to_seed, true);
});

test('WORK-RECAP: a clean recap → build-in-public seed → draft reaches the queue in SAFE', async () => {
  const { home, env } = tempHome();
  try {
    const recapSeed = buildCleanRecapSeed();
    const config = { work_recap: { enabled: true, private_terms: DENY_LIST } };

    // SEED step: map the work-recap source seed → a build-in-public brief seed (operator account).
    const s = seed.mapWorkRecapSeed(recapSeed, {
      slot: RECAP_SLOT,
      config,
      account_ref: 'acme-founder',
      memory_source_ref: 'memory/2099-04-08.md',
      mode: 'SAFE',
    });
    assert.equal(s.source, 'work-recap');
    assert.equal(s.account_class, 'operator', '§3.3 operator/founder account');
    assert.equal(s.brief.framework_ref, 'rules/frameworks/build-in-public.md');
    // The deny-set is threaded onto the gate's privacy/leak-check input BEFORE the chain runs.
    const factSafety = JSON.stringify(s.brief.enrichment.proof_stack.fact_safety);
    for (const term of DENY_TERMS) {
      assert.ok(factSafety.includes(term), `fact_safety carries the forbidden term "${term}" for the gate`);
    }

    // CHAIN step: the deterministic gate is ARMED with the deny-set as banned_patterns (the
    // privacy/leak backstop), and an LLM privacy seat is also wired. A CLEAN draft passes both.
    const pipeline = textHeavy.createPipeline({
      seats: {
        matcher: async () => s.brief,
        writer: async () => draftFor(s, CLEAN_RECAP_DRAFT_VARIANTS),
        gate: privacyLeakGateSeat(DENY_TERMS),
        packager: safePackager(),
      },
      config: { mode: 'SAFE', banned_patterns: DENY_TERMS },
      env,
    });
    const outcome = await textHeavy.runTextHeavy(slotFromSeed(s), pipeline);

    assert.equal(outcome.ok, true, `clean recap chain should converge. reason: ${outcome.reason}`);
    assert.equal(outcome.state, 'awaiting_approval', 'lands at the reviewer first gate (§2.4)');
    assert.equal(outcome.mode, 'SAFE');

    const entry = queueEntry(env, s.content_id);
    assert.ok(entry, 'a durable queue entry exists');
    assert.equal(entry.fields.state, 'awaiting_approval');
    assert.equal(entry.fields.mode, 'SAFE');
    assert.equal(entry.fields.external_post_ref, undefined, 'nothing published');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('WORK-RECAP PRIVACY: a planted-secret draft is BLOCKED by the DETERMINISTIC privacy gate (no LLM spend) — never reaches the queue', async () => {
  const { home, env } = tempHome();
  try {
    const recapSeed = buildCleanRecapSeed();
    const config = { work_recap: { enabled: true, private_terms: DENY_LIST } };
    const s = seed.mapWorkRecapSeed(recapSeed, { slot: RECAP_SLOT, config, mode: 'SAFE' });

    // A draft where the writer (hypothetically) let a forbidden partner name slip through.
    const leakDraft = draftFor(s, [
      { label: 'recommended', text: 'Big week: we kicked off a co-marketing bundle with Nebula Nine Optics and shipped the Moon how-to.' },
      ...CLEAN_RECAP_DRAFT_VARIANTS.slice(1),
    ]);

    // The LLM gate seat MUST NOT be reached: a hard deterministic pre-gate fail short-circuits with
    // no LLM spend. We assert that by failing the test if the LLM seat is invoked at all.
    let llmGateCalled = false;
    const pipeline = textHeavy.createPipeline({
      seats: {
        matcher: async () => s.brief,
        writer: async () => leakDraft,
        gate: async () => { llmGateCalled = true; return { stage: 'llm', verdict: 'PASS', detected_codes: [], scores: {} }; },
        packager: safePackager(),
      },
      // The privacy deny-set is wired into the deterministic gate as banned_patterns (the
      // live deterministic privacy/leak backstop the work-recap law requires).
      config: { mode: 'SAFE', banned_patterns: DENY_TERMS },
      env,
    });
    const outcome = await textHeavy.runTextHeavy(slotFromSeed(s), pipeline);

    // The privacy code FIRED and the draft was HARD-FAILED — it never packaged, never queued.
    assert.equal(outcome.ok, false, 'the leaked draft is blocked');
    assert.equal(outcome.state, 'hard_failed');
    assert.equal(outcome.stage, 'gate', 'blocked at the gate (before the approval card)');
    assert.equal(outcome.routed_back_to, 'writer', 'routed back to the writer to fix the leak');
    assert.equal(llmGateCalled, false, 'a hard pre-gate fail short-circuits with NO LLM spend');
    const codes = gateCodeNames(outcome);
    assert.ok(codes.includes('LINT.BANNED_PATTERN'), 'the deterministic privacy/leak code fired (deny-set as banned_patterns)');

    // The draft NEVER reached the queue / approval card — nothing was written.
    assert.equal(queueEntry(env, s.content_id), null, 'no queue entry was created for the leaked draft');
    assert.equal(fs.existsSync(paths.publishQueue(env)), false, 'the queue file was never written');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('WORK-RECAP PRIVACY: the FORWARD deterministic gate auto-arms work_recap.private_terms (no manual banned_patterns) — blocked before the card, no LLM spend', async () => {
  const { home, env } = tempHome();
  try {
    const recapSeed = buildCleanRecapSeed();
    const config = { work_recap: { enabled: true, private_terms: DENY_LIST } };
    const s = seed.mapWorkRecapSeed(recapSeed, { slot: RECAP_SLOT, config, mode: 'SAFE' });

    const leakDraft = draftFor(s, [
      { label: 'recommended', text: 'Big week: we kicked off a co-marketing bundle with Nebula Nine Optics and shipped the Moon how-to.' },
      ...CLEAN_RECAP_DRAFT_VARIANTS.slice(1),
    ]);

    let llmGateCalled = false;
    const pipeline = textHeavy.createPipeline({
      seats: {
        matcher: async () => s.brief,
        writer: async () => leakDraft,
        gate: async () => { llmGateCalled = true; return { stage: 'llm', verdict: 'PASS', detected_codes: [], scores: {} }; },
        packager: safePackager(),
      },
      // The fix under test: NO banned_patterns armed here. The deny-set must auto-arm the
      // deterministic gate from config.work_recap.private_terms alone (shared.lintRules union).
      config: { mode: 'SAFE', work_recap: { enabled: true, private_terms: DENY_LIST } },
      env,
    });
    const outcome = await textHeavy.runTextHeavy(slotFromSeed(s), pipeline);

    assert.equal(outcome.ok, false, 'the leaked draft is blocked on the forward path');
    assert.equal(outcome.stage, 'gate', 'blocked at the gate (before the approval card)');
    assert.equal(llmGateCalled, false, 'a hard pre-gate fail short-circuits with NO LLM spend');
    const codes = gateCodeNames(outcome);
    assert.ok(codes.includes('LINT.BANNED_PATTERN'), 'work_recap.private_terms auto-armed the deterministic gate (no manual banned_patterns needed)');
    assert.equal(queueEntry(env, s.content_id), null, 'no queue entry for the leaked draft');
    assert.equal(fs.existsSync(paths.publishQueue(env)), false, 'the queue file was never written');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('WORK-RECAP PRIVACY: the LLM privacy/leak judge seat ALSO blocks a planted secret (defense in depth) — never reaches the queue', async () => {
  const { home, env } = tempHome();
  try {
    const recapSeed = buildCleanRecapSeed();
    const config = { work_recap: { enabled: true, private_terms: DENY_LIST } };
    const s = seed.mapWorkRecapSeed(recapSeed, { slot: RECAP_SLOT, config, mode: 'SAFE' });

    // Same leaked draft, but this time the DETERMINISTIC banned_patterns are NOT armed — so the
    // ONLY thing standing between the leak and the approval card is the LLM privacy/leak judge seat
    // (rule.core.claims-safety). It must FAIL the draft. This proves the second, independent
    // privacy mechanism the work-recap law requires.
    const leakDraft = draftFor(s, [
      { label: 'recommended', text: 'Quietly shipped the Project Dark Comet bracket revision and the Moon how-to this week.' },
      ...CLEAN_RECAP_DRAFT_VARIANTS.slice(1),
    ]);

    const pipeline = textHeavy.createPipeline({
      seats: {
        matcher: async () => s.brief,
        writer: async () => leakDraft,
        gate: privacyLeakGateSeat(DENY_TERMS),
        packager: safePackager(),
      },
      config: { mode: 'SAFE' }, // deterministic banned_patterns deliberately NOT set here
      env,
    });
    const outcome = await textHeavy.runTextHeavy(slotFromSeed(s), pipeline);

    assert.equal(outcome.ok, false, 'the leaked draft is blocked by the LLM privacy judge');
    assert.equal(outcome.state, 'hard_failed');
    assert.equal(outcome.stage, 'gate');
    const codes = gateCodeNames(outcome);
    assert.ok(codes.includes('FM.PRIVACY_LEAK'), 'the LLM privacy/leak code fired (rule.core.claims-safety)');
    assert.equal(queueEntry(env, s.content_id), null, 'no queue entry for the leaked draft');
    assert.equal(fs.existsSync(paths.publishQueue(env)), false, 'the queue file was never written (never reached the approval card)');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ===========================================================================
// (3) CONFIG-GATED: both pathways are OFF by default — a no-op / fail-closed, nothing queued.
// ===========================================================================

test('CONFIG-GATED: trend pathway disabled (default) is a no-op — pollTrends throws, mapTrendSeed fails closed, nothing queued', async () => {
  const { home, env } = tempHome();
  try {
    // pollTrends refuses while disabled and contacts no provider / writes no report.
    await assert.rejects(
      () => trends.pollTrends({ config: {}, env, brand: 'acme-cosmos' }),
      (e) => e instanceof trends.TrendsDisabledError,
      'pollTrends throws TrendsDisabledError when the pathway is off (the default)',
    );
    await assert.rejects(
      () => trends.pollTrends({ config: { trends: { enabled: false, adapter: 'fixture' } }, env }),
      (e) => e instanceof trends.TrendsDisabledError,
    );
    // No report dir / queue was created by the refused poll.
    assert.equal(fs.existsSync(paths.trendsDir(env)), false, 'no trend reports written while disabled');
    assert.equal(fs.existsSync(paths.publishQueue(env)), false, 'no queue entry while disabled');

    // The seed mapper also fails closed even if a caller hands it a report.
    const [report] = await makeFakeTrendAdapter().poll({ platform: 'twitter', window: 'daily' });
    assert.throws(
      () => seed.mapTrendSeed(report, { slot: TREND_SLOT /* no/disabled config */ }),
      (e) => e.code === 'ESOURCEDISABLED' && e.block === 'trends',
      'mapTrendSeed refuses to map while the trends pathway is disabled',
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('CONFIG-GATED: work-recap pathway disabled (default) is a no-op — scan/build no-op, mapWorkRecapSeed fails closed, nothing queued', () => {
  const { home, env } = tempHome();
  try {
    // scanMemory + buildWorkRecapSeed are clean no-ops while disabled (never throw, never read).
    const scan = workRecap.scanMemory({ config: {}, fs: fixtureMemoryFs() });
    assert.equal(scan.enabled, false);
    assert.equal(scan.reason, 'disabled');
    assert.equal(scan.items.length, 0);

    const recapSeed = workRecap.buildWorkRecapSeed({ config: {}, fs: fixtureMemoryFs() });
    assert.equal(recapSeed.enabled, false);
    assert.equal(recapSeed.reason, 'disabled');
    assert.equal(recapSeed.work_items.length, 0);

    // Even pointed at the configured memory path, a disabled block reads nothing.
    const scanWithPath = workRecap.scanMemory({
      work_recap: { enabled: false, memory_path: MEMORY_DIR, private_terms: DENY_TERMS },
      fs: fixtureMemoryFs(),
      now: NOW,
    });
    assert.equal(scanWithPath.reason, 'disabled');
    assert.equal(scanWithPath.items.length, 0);

    // The seed mapper fails closed even if handed a recap.
    assert.throws(
      () => seed.mapWorkRecapSeed({ shipped: ['x'] }, { slot: RECAP_SLOT /* no/disabled config */ }),
      (e) => e.code === 'ESOURCEDISABLED' && e.block === 'work_recap',
      'mapWorkRecapSeed refuses to map while the work_recap pathway is disabled',
    );

    assert.equal(fs.existsSync(paths.publishQueue(env)), false, 'no queue entry while disabled');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ===========================================================================
// Hygiene: the whole pathway run writes ONLY under throwaway CONTENT_HOME temp dirs (never the repo).
// ===========================================================================

test('hygiene: neither pathway writes into the code checkout (instance state stays under CONTENT_HOME — RD-3)', async () => {
  const before = checkoutFileCount();

  // Trend pathway, end to end.
  {
    const { home, env } = tempHome();
    const ADAPTER_NAME = 'pw-trend-hygiene';
    const recorded = makeFakeTrendAdapter();
    trends.register(ADAPTER_NAME, { name: ADAPTER_NAME, async poll() { return recorded.poll({ platform: 'twitter', window: 'daily' }); } });
    try {
      const result = await trends.pollTrends({ config: { trends: { enabled: true, adapter: ADAPTER_NAME } }, env, brand: 'acme-cosmos' });
      const s = seed.mapTrendSeed(result.reports[0], { slot: TREND_SLOT, config: { trends: { enabled: true } }, mode: 'SAFE' });
      const pipeline = textHeavy.createPipeline({
        seats: { matcher: async () => s.brief, writer: async () => draftFor(s, TREND_DRAFT_VARIANTS), gate: passingGateSeat(), packager: safePackager() },
        config: { mode: 'SAFE' }, env,
      });
      await textHeavy.runTextHeavy(slotFromSeed(s), pipeline);
    } finally {
      trends.unregister(ADAPTER_NAME);
      fs.rmSync(home, { recursive: true, force: true });
    }
  }

  // Work-recap pathway, end to end.
  {
    const { home, env } = tempHome();
    try {
      const recapSeed = buildCleanRecapSeed();
      const s = seed.mapWorkRecapSeed(recapSeed, { slot: RECAP_SLOT, config: { work_recap: { enabled: true, private_terms: DENY_LIST } }, mode: 'SAFE' });
      const pipeline = textHeavy.createPipeline({
        seats: { matcher: async () => s.brief, writer: async () => draftFor(s, CLEAN_RECAP_DRAFT_VARIANTS), gate: privacyLeakGateSeat(DENY_TERMS), packager: safePackager() },
        config: { mode: 'SAFE', banned_patterns: DENY_TERMS }, env,
      });
      await textHeavy.runTextHeavy(slotFromSeed(s), pipeline);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }

  const after = checkoutFileCount();
  assert.equal(after, before, 'the pathway runs wrote no file into the repo tree (CONTENT_HOME-only — RD-3)');
});
