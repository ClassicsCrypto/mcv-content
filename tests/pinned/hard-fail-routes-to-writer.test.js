'use strict';

/**
 * tests/pinned/hard-fail-routes-to-writer.test.js  [PINNED — release-spec §16.2]
 *
 * Hard-fail routing (§14.1 layer-1 contract; §8.1 gate invariant; DD-3). The pinned guarantees:
 *
 *   - a HARD deterministic pre-gate violation SHORT-CIRCUITS the gate: it routes the draft straight
 *     back to the WRITER with NO LLM gate spend (the explicit cost-saving contract of layer 1) — the
 *     LLM judge seat is never invoked;
 *   - the universal gate composition (pipelines/shared runGate) reports route='writer' on a hard
 *     deterministic fail and the lifecycle returns state 'hard_failed' routed_back_to the writer;
 *   - an LLM-layer hard code still routes back (to whatever seat the code names) but ONLY after the
 *     pre-gate was clean — i.e. the deterministic layer is always the cheap first stop.
 *
 * Zero-key: the gate seat is a STUB that records whether it was called; no provider, no network.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const textHeavy = require('../../pipelines/text-heavy.js');

function cleanVariants() {
  return [
    { label: 'recommended', text: 'Sixty builders shipped openable demos across one three-day weekend window.' },
    { label: 'variant-a', text: 'The public-output rule turned a hard deadline into sixty clickable demos here.' },
    { label: 'variant-b', text: 'We handed out three days and one rule; by Sunday the room was full of links.' },
  ];
}

// A draft whose Recommended variant carries a mid-sentence em dash (a HARD LINT code).
function emDashVariants() {
  const v = cleanVariants();
  v[0].text = 'Sixty builders shipped demos—and every one is a link anyone can open right now today.';
  return v;
}

function seats(over = {}) {
  return {
    matcher: async (i) => ({
      content_id: i.content_id, brand: i.brand, platform: i.platform, format: i.format,
      slot_ref: i.slot_ref || 'slot', archetype: 'recap', theme: 'beta recap',
      pre_seed: { angle: 'the beta shipped working demos' },
    }),
    writer: async ({ brief }) => ({
      content_id: brief.content_id, brand: brief.brand, platform: brief.platform, format: brief.format,
      variants: over.__variants || cleanVariants(),
    }),
    gate: over.gate,
    packager: async ({ draft, gate }) => ({
      audit_header: { content_id: draft.content_id, brand: draft.brand, platform: draft.platform, mode: 'SAFE', format: draft.format, gate_verdict: gate.verdict },
      recommended: { text: draft.variants[0].text, scores: { brand: 90 } },
      variant_a: { text: draft.variants[1].text },
      variant_b: { text: draft.variants[2].text },
    }),
    ...over,
  };
}

test('a HARD pre-gate fail routes back to the writer with NO LLM gate spend', async () => {
  let llmCalled = false;
  const gate = async () => { llmCalled = true; return { stage: 'gate', verdict: 'PASS', detected_codes: [] }; };

  const out = await textHeavy.runTextHeavy(
    { brand: 'acme-cosmos', platform: 'twitter', format: 'single tweet', slot_ref: 's1', mode: 'SAFE' },
    textHeavy.createPipeline({ seats: seats({ gate, __variants: emDashVariants() }), env: { CONTENT_HOME: undefined, WORKFLOW_LEDGER_DISABLE: '1' } }),
  );

  assert.equal(out.ok, false, 'a hard deterministic violation fails the run');
  assert.equal(out.state, 'hard_failed');
  assert.equal(out.routed_back_to, 'writer', 'routed back to the writer (layer-1 contract)');
  assert.equal(llmCalled, false, 'the LLM gate seat was NEVER invoked (no spend on a regex-catchable fail)');
});

test('runGate reports verdict FAIL + route=writer on a hard deterministic code, llm:null', async () => {
  let llmCalled = false;
  const ctx = {
    content_id: 'acme-hf-01', brand: 'acme-cosmos', platform: 'twitter', format: 'single tweet',
    config: {}, env: { WORKFLOW_LEDGER_DISABLE: '1' },
    seats: { gate: async () => { llmCalled = true; return { verdict: 'PASS', detected_codes: [] }; } },
  };
  const g = await textHeavy.runGate(ctx, {
    draft: { content_id: 'acme-hf-01', variants: emDashVariants() },
    brief: { content_id: 'acme-hf-01' },
  });
  assert.equal(g.ok, false);
  assert.equal(g.verdict, 'FAIL');
  assert.equal(g.route, 'writer');
  assert.equal(g.llm, null, 'the LLM layer did not run (honest null, never a fabricated PASS)');
  assert.equal(llmCalled, false);
});

test('a clean pre-gate advances to the LLM seat; an LLM-layer hard code then routes back', async () => {
  let llmCalled = false;
  const ctx = {
    content_id: 'acme-hf-02', brand: 'acme-cosmos', platform: 'twitter', format: 'single tweet',
    config: {}, env: { WORKFLOW_LEDGER_DISABLE: '1' },
    seats: {
      gate: async () => {
        llmCalled = true;
        return { verdict: 'FAIL', detected_codes: [{ code: 'FM.FABRICATION', family: 'FM', tier: 'hard', source: 'llm-quality', route: 'writer' }], route: 'writer' };
      },
    },
  };
  const g = await textHeavy.runGate(ctx, {
    draft: { content_id: 'acme-hf-02', variants: cleanVariants() }, // clean ⇒ pre-gate passes
    brief: { content_id: 'acme-hf-02' },
  });
  assert.equal(llmCalled, true, 'a clean pre-gate DOES advance to the LLM seat');
  assert.equal(g.ok, false, 'an LLM-layer hard code blocks');
  assert.equal(g.route, 'writer', 'and routes back to the seat the code names');
});
