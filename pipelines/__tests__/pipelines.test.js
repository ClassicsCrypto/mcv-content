'use strict';

/**
 * pipelines/__tests__/pipelines.test.js  [N net-new]
 *
 * Characterizes the two lifecycle chain definitions (release-spec §8.1): the text-heavy and
 * video-heavy runners, the UNIVERSAL gate (§8.1 invariant), the §8.2 convergence on
 * awaiting_approval, hard-fail routing (no LLM spend on a deterministic pre-gate fail), and the
 * trend variant (§8.8: trend slot_type + quote-retweet content_form + freshness-window TTL).
 *
 * These tests wire STUB seats (the engine never calls chain-seat LLMs — RD-2/§4.3) and run on a
 * throwaway CONTENT_HOME with the workflow ledger disabled, so they exercise the deterministic
 * spine (pre-gate-lint, validate-package, retrieval/usage-log, the locked queue writer) without
 * any provider/key. Full CI wiring is P4; this file co-locates the contract tests.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const textHeavy = require('../text-heavy.js');
const videoHeavy = require('../video-heavy.js');
const shared = require('../shared.js');

/** A throwaway CONTENT_HOME with the ledger disabled (CONTENT_HOME-free observability). */
function tempEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oce-pipe-'));
  return { CONTENT_HOME: dir, WORKFLOW_LEDGER_DISABLE: '1' };
}

/** Three distinct, clean variants (pass the pre-gate's count + distinctness + length checks). */
function cleanVariants() {
  return [
    { label: 'recommended', text: 'The Acme Cosmos beta wrapped with sixty builders shipping live working demos this weekend.' },
    { label: 'variant-a', text: 'Sixty builders. One weekend. Every single demo went out the door as a working link.' },
    { label: 'variant-b', text: 'We asked for working demos and got sixty of them. Here is the full beta recap thread now.' },
  ];
}

/** A full set of passing stub seats; `over` overrides individual roles. */
function seats(over = {}) {
  return {
    matcher: async (i) => ({
      content_id: i.content_id,
      brand: i.brand,
      platform: i.platform,
      format: i.format,
      slot_ref: i.slot_ref || 'slot',
      archetype: 'announcement',
      theme: 'beta recap',
      pre_seed: { angle: 'the beta shipped working demos' },
      framework_ref: 'rules/core/frameworks/short.md',
    }),
    writer: async ({ brief }) => ({
      content_id: brief.content_id,
      brand: brief.brand,
      platform: brief.platform,
      format: brief.format,
      variants: cleanVariants(),
    }),
    gate: async () => ({ stage: 'gate', verdict: 'PASS', detected_codes: [] }),
    packager: async ({ draft, gate, media_decision }) => {
      const header = {
        content_id: draft.content_id,
        brand: draft.brand,
        platform: draft.platform,
        mode: 'SAFE',
        format: draft.format,
        gate_verdict: gate.verdict,
      };
      if (media_decision && media_decision.output_ref) header.media = [media_decision.output_ref];
      if (media_decision && media_decision.output_ref) header.visual_state = 'reviewed';
      return {
        audit_header: header,
        recommended: { text: draft.variants[0].text, scores: { brand: 90 } },
        variant_a: { text: draft.variants[1].text },
        variant_b: { text: draft.variants[2].text },
      };
    },
    ...over,
  };
}

// ---------------------------------------------------------------------------
// text-heavy
// ---------------------------------------------------------------------------

test('runTextHeavy: a clean text item converges on awaiting_approval and writes a queue entry', async () => {
  const env = tempEnv();
  const out = await textHeavy.runTextHeavy(
    { brand: 'acme-cosmos', platform: 'twitter', format: 'single tweet', slot_ref: 'acme-mon-01', mode: 'SAFE' },
    textHeavy.createPipeline({ seats: seats(), env }),
  );

  assert.equal(out.ok, true);
  assert.equal(out.stage, 'queue');
  assert.equal(out.state, 'awaiting_approval'); // §8.2 convergence
  assert.equal(out.gate.gate_verdict, 'PASS');
  assert.equal(out.queue_entry.written, true);

  // The durable queue entry actually landed in awaiting_approval via the locked writer (§8.4).
  const q = fs.readFileSync(path.join(env.CONTENT_HOME, 'queue', 'publish-queue.md'), 'utf8');
  assert.match(q, /## Entry - /);
  assert.match(q, /- state: awaiting_approval/);
  assert.match(q, /- content_form: standalone/);
});

test('runTextHeavy: a deterministic pre-gate HARD fail routes back to the writer with NO LLM gate spend', async () => {
  const env = tempEnv();
  let llmGateCalled = false;
  let packagerReached = false;
  const out = await textHeavy.runTextHeavy(
    { brand: 'acme-cosmos', platform: 'twitter', format: 'single tweet', slot_ref: 's', mode: 'SAFE' },
    textHeavy.createPipeline({
      seats: seats({
        // A mid-sentence em dash is a HARD LINT.EM_DASH (pre-gate-lint) → FAIL before any LLM gate.
        writer: async ({ brief }) => ({
          content_id: brief.content_id,
          brand: brief.brand,
          platform: brief.platform,
          format: 'single tweet',
          variants: [
            { label: 'recommended', text: 'The beta wrapped—and the demos shipped live for all to use today.' },
            { label: 'variant-a', text: 'Sixty builders showed up and every single demo went out as a usable link.' },
            { label: 'variant-b', text: 'We asked for working demos. Sixty arrived. Here is the complete recap now.' },
          ],
        }),
        gate: async () => { llmGateCalled = true; return { stage: 'gate', verdict: 'PASS', detected_codes: [] }; },
        packager: async () => { packagerReached = true; return {}; },
      }),
      env,
    }),
  );

  assert.equal(out.ok, false);
  assert.equal(out.state, 'hard_failed');
  assert.equal(out.routed_back_to, 'writer'); // the pre-gate routes em-dash back to the writer
  assert.equal(llmGateCalled, false, 'the LLM gate must NOT be called after a deterministic pre-gate FAIL');
  assert.equal(packagerReached, false, 'the packager must not be reached on a gate fail');
});

test('runTextHeavy: an unwired required seat fails loudly (the engine never fabricates an artifact)', async () => {
  const env = tempEnv();
  await assert.rejects(
    () => textHeavy.runTextHeavy(
      { brand: 'acme-cosmos', platform: 'twitter', format: 'single tweet', slot_ref: 's' },
      textHeavy.createPipeline({ seats: {}, env }), // no matcher wired
    ),
    /seat "matcher" is not wired/,
  );
});

test('runTextHeavy: a text-only format does not require media and queues without an asset', async () => {
  const env = tempEnv();
  let mediaSeatCalled = false;
  const out = await textHeavy.runTextHeavy(
    { brand: 'acme-cosmos', platform: 'twitter', format: 'single tweet', slot_ref: 's', mode: 'SAFE' },
    textHeavy.createPipeline({ seats: seats({ media: async () => { mediaSeatCalled = true; return null; } }), env }),
  );
  assert.equal(out.ok, true);
  assert.equal(out.state, 'awaiting_approval');
  assert.equal(out.media_decision.action, 'generate'); // text-only ⇒ no media required
  assert.equal(mediaSeatCalled, false, 'no media seat is invoked for a text-only format with no media need');
  assert.equal(out.queue_entry.fields.media_refs, 'null');
});

// ---------------------------------------------------------------------------
// video-heavy
// ---------------------------------------------------------------------------

test('runVideoHeavy: media-first sourcing then a minimal caption converges on awaiting_approval', async () => {
  const env = tempEnv();
  const order = [];
  const out = await videoHeavy.runVideoHeavy(
    { brand: 'acme-cosmos', platform: 'giphy', format: 'short clip', slot_ref: 'acme-fri-03', mode: 'SAFE' },
    videoHeavy.createPipeline({
      seats: seats({
        media: async () => {
          order.push('media');
          return { decision: { action: 'reuse', reason: 'owned video', chosen_asset_id: 'media/launch.mp4', output_ref: 'library/media/launch.mp4' } };
        },
        writer: async ({ brief, caption_mode }) => {
          order.push(`writer:${caption_mode}`);
          return {
            content_id: brief.content_id,
            brand: brief.brand,
            platform: brief.platform,
            format: brief.format,
            variants: [
              { label: 'recommended', text: 'When the launch finally goes live for everyone today.' },
              { label: 'variant-a', text: 'That feeling when shipping day finally arrives at long last.' },
              { label: 'variant-b', text: 'Launch day energy, captured perfectly in one short little clip.' },
            ],
          };
        },
      }),
      env,
    }),
  );

  assert.equal(out.ok, true);
  assert.equal(out.state, 'awaiting_approval'); // same convergence as text-heavy (§8.2)
  assert.equal(out.media_decision.action, 'reuse');
  // The lane inversion: media is sourced BEFORE the (minimal) caption is written (§8.1).
  assert.deepEqual(order, ['media', 'writer:minimal']);
  // The produced asset rode onto the queue entry's media_refs.
  assert.match(out.queue_entry.fields.media_refs, /launch\.mp4/);
});

test('runVideoHeavy: no produced asset routes back to the media seat (the asset is the main artifact)', async () => {
  const env = tempEnv();
  const out = await videoHeavy.runVideoHeavy(
    { brand: 'acme-cosmos', platform: 'giphy', format: 'short clip', slot_ref: 's', mode: 'SAFE' },
    videoHeavy.createPipeline({ seats: seats({ media: async () => ({ decision: { action: 'generate', reason: 'nothing matched in library' } }) }), env }),
  );
  assert.equal(out.ok, false);
  assert.equal(out.stage, 'media');
  assert.equal(out.state, 'hard_failed');
  assert.equal(out.routed_back_to, 'media');
});

// ---------------------------------------------------------------------------
// gate universality (§8.1 invariant)
// ---------------------------------------------------------------------------

test('the gate is UNIVERSAL: both lifecycles import the SAME gate composition (runGate)', () => {
  // video-heavy.js imports runGate from text-heavy.js — one composition, two entry orders.
  assert.equal(typeof textHeavy.runGate, 'function');
  const src = fs.readFileSync(path.join(__dirname, '..', 'video-heavy.js'), 'utf8');
  assert.match(src, /require\(['"]\.\/text-heavy\.js['"]\)/);
  assert.match(src, /runGate/);
});

test('runGate: a soft-only pre-gate result bars Recommended (PASS_ALTERNATE_ONLY), still advances', async () => {
  const env = tempEnv();
  const ctx = shared.makeRunCtx(
    { brand: 'acme-cosmos', platform: 'twitter', format: 'single tweet' },
    textHeavy.createPipeline({ seats: seats(), env }),
    'text-heavy',
  );
  // A placeholder token is a SOFT LINT.PLACEHOLDER that bars Recommended but does not FAIL.
  const draft = {
    content_id: 'c1', brand: 'acme-cosmos', platform: 'twitter', format: 'single tweet',
    variants: [
      { label: 'recommended', text: 'The beta wrapped and {METRIC} builders shipped working demos this past weekend.' },
      { label: 'variant-a', text: 'Sixty builders arrived and every demo went out as a usable working link today.' },
      { label: 'variant-b', text: 'We asked for working demos. Many arrived. Here is the complete recap thread now.' },
    ],
  };
  const gate = await textHeavy.runGate(ctx, { draft, brief: {} });
  assert.equal(gate.ok, true); // soft-only ⇒ not a publish blocker
  assert.equal(gate.verdict, 'PASS_ALTERNATE_ONLY');
  assert.ok(gate.detected_codes.some((d) => d.code === 'LINT.PLACEHOLDER'));
});

test('runGate: an LLM-layer hard fail blocks even when the deterministic pre-gate is clean', async () => {
  const env = tempEnv();
  const ctx = shared.makeRunCtx(
    { brand: 'acme-cosmos', platform: 'twitter', format: 'single tweet' },
    textHeavy.createPipeline({
      seats: seats({ gate: async () => ({ stage: 'gate', verdict: 'FAIL', route: 'writer', detected_codes: [{ code: 'FM.FABRICATION', family: 'FM', tier: 'hard', source: 'quality', route: 'writer' }] }) }),
      env,
    }),
    'text-heavy',
  );
  const draft = { content_id: 'c1', brand: 'acme-cosmos', platform: 'twitter', format: 'single tweet', variants: cleanVariants() };
  const gate = await textHeavy.runGate(ctx, { draft, brief: {} });
  assert.equal(gate.ok, false);
  assert.equal(gate.verdict, 'FAIL');
  assert.equal(gate.route, 'writer');
  // The union-of-codes contract: the LLM code travels alongside the (clean) pre-gate codes.
  assert.ok(gate.detected_codes.some((d) => d.code === 'FM.FABRICATION'));
});

// ---------------------------------------------------------------------------
// trend variant (§8.8)
// ---------------------------------------------------------------------------

test('runTextHeavy trend variant: quote-retweet content_form + freshness-window TTL ride the queue entry', async () => {
  const env = tempEnv();
  const trendReport = {
    period: { start: '2026-06-14T00:00:00Z', end: '2026-06-14T12:00:00Z' },
    platform: 'twitter',
    topics: [{ topic: 'open source AI', suggested_angles: ['ship the work in public'] }],
    freshness_window: { expires_at: '2026-06-15T00:00:00Z' },
    provenance: { trust_zone: 'U', method: 'manual' },
  };

  let matcherSawTrend = false;
  const out = await textHeavy.runTextHeavy(
    {
      brand: 'acme-cosmos', platform: 'twitter', format: 'single tweet', slot_ref: 'acme-trend-01',
      slot_type: 'trend', content_form: 'quote-retweet',
      trend_report: trendReport, trend_report_ref: 'trends/r1.json', mode: 'SAFE',
    },
    textHeavy.createPipeline({
      seats: seats({
        media: null,
        matcher: async (i) => {
          // The submitted trend report's ANGLES (never drafted text) reach the matcher as Zone U.
          matcherSawTrend = Boolean(i.trend && i.trend.trust_zone === 'U' && i.trend.topics.length);
          return {
            content_id: i.content_id, brand: i.brand, platform: i.platform, format: i.format,
            slot_ref: i.slot_ref, archetype: 'reaction', theme: 'open source', pre_seed: { angle: 'ship the work in public' },
          };
        },
        writer: async ({ brief }) => ({
          content_id: brief.content_id, brand: brief.brand, platform: brief.platform, format: 'single tweet',
          variants: [
            { label: 'recommended', text: 'Open source wins when you ship the work in public for everyone to actually see.' },
            { label: 'variant-a', text: 'Building in the open beats building in the dark, every single time that you try.' },
            { label: 'variant-b', text: 'The fastest way to earn trust is to do the work where people can openly watch it.' },
          ],
        }),
        packager: async ({ draft }) => ({
          audit_header: { content_id: draft.content_id, brand: draft.brand, platform: 'twitter', mode: 'SAFE', format: 'text' },
          recommended: { text: draft.variants[0].text, scores: { brand: 90 } },
          variant_a: { text: draft.variants[1].text },
          variant_b: { text: draft.variants[2].text },
        }),
      }),
      env,
    }),
  );

  assert.equal(out.ok, true);
  assert.equal(out.state, 'awaiting_approval');
  assert.equal(out.content_form, 'quote-retweet'); // DD-16 first-class content_form
  assert.equal(matcherSawTrend, true, 'the matcher received the trend report angles as Zone-U pre-seed');

  const f = out.queue_entry.fields;
  assert.equal(f.content_form, 'quote-retweet');
  assert.equal(f.trend_source_ref, 'trends/r1.json'); // §7.1 trend_source_ref
  assert.equal(f.expires_basis, 'freshness_window'); // DD-15 TTL basis
  assert.match(f.freshness_window, /expires_at/);
});

// ---------------------------------------------------------------------------
// convergence + plumbing
// ---------------------------------------------------------------------------

test('both lifecycles produce the same convergence state vocabulary (validating→packaged→awaiting_approval)', async () => {
  const env = tempEnv();
  const t = await textHeavy.runTextHeavy(
    { brand: 'acme-cosmos', platform: 'twitter', format: 'single tweet', slot_ref: 's1', mode: 'SAFE' },
    textHeavy.createPipeline({ seats: seats(), env }),
  );
  const v = await videoHeavy.runVideoHeavy(
    { brand: 'acme-cosmos', platform: 'giphy', format: 'short clip', slot_ref: 's2', mode: 'SAFE' },
    videoHeavy.createPipeline({
      seats: seats({
        media: async () => ({ decision: { action: 'modify', reason: 'crop owned video', chosen_asset_id: 'media/launch.mp4', output_ref: 'library/media/launch-crop.mp4' } }),
        writer: async ({ brief }) => ({
          content_id: brief.content_id, brand: brief.brand, platform: brief.platform, format: brief.format,
          variants: [
            { label: 'recommended', text: 'When the launch finally goes live for the whole community today.' },
            { label: 'variant-a', text: 'That feeling when shipping day finally arrives after all the late nights.' },
            { label: 'variant-b', text: 'Launch day energy, captured perfectly in one short and satisfying clip.' },
          ],
        }),
      }),
      env,
    }),
  );
  assert.equal(t.state, 'awaiting_approval');
  assert.equal(v.state, 'awaiting_approval');
  // Both states are members of the §8.2 queue-state vocabulary the queue-entry schema enumerates.
  for (const state of [t.state, v.state]) {
    assert.ok(['awaiting_approval', 'approved', 'rejected'].includes(state));
  }
});

test('shared.matcherInput carries content_form and (for trend slots) Zone-U trend angles only', () => {
  const ctx = shared.makeRunCtx(
    { brand: 'b', platform: 'twitter', format: 'single tweet', slot_type: 'trend', content_form: 'quote-retweet', trend_report_ref: 'trends/x.json', trend_report: { topics: [{ topic: 't', suggested_angles: ['a'], source_links: ['https://e.example'] }] } },
    textHeavy.createPipeline({ seats: seats() }),
    'text-heavy',
  );
  const input = shared.matcherInput(ctx);
  assert.equal(input.content_form, 'quote-retweet');
  assert.equal(input.trend.trust_zone, 'U');
  assert.equal(input.trend.report_ref, 'trends/x.json');
  assert.equal(input.trend.topics[0].suggested_angles[0], 'a');
  // No drafted comment text is ever carried — only the topic, angles, and source links.
  assert.deepEqual(Object.keys(input.trend.topics[0]).sort(), ['source_links', 'suggested_angles', 'topic']);
});
