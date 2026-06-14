'use strict';

/**
 * tests/stage-output-fixtures.test.js  [N net-new — P4-TEST / P4-FIX-STAGE]
 *
 * Guards the recorded stage-output fixtures (fixtures/stage-outputs/) the zero-key fixture run
 * replays (release-spec §5.4; P4-FIX-STAGE "a small test asserting draft passes pre-gate-lint +
 * the verdict set satisfies the union contract"). This catches FIXTURE ROT — a recorded artifact
 * drifting out of alignment with the live deterministic engine — at its source, before it surfaces
 * as a confusing fixture-run failure deep in the spine.
 *
 * What it pins:
 *   - draft.json PASSES the LIVE deterministic pre-gate clean (no em-dash / inflation / financial /
 *     placeholder / banned / length / distinctness codes) — the replay precondition the spine
 *     assumes;
 *   - gate-verdicts.json is labeled `recorded_fixture: true` and demonstrates the union-of-codes
 *     contract (DD-3): the final verdict carries forward every earlier (lint) detection and the LLM
 *     layer ADDS but never DROPS codes, including ≥1 soft `warn` with `bars_recommended`;
 *   - the usage-log fixture has one entry inside and one outside the 14-day hard floor (the cooldown
 *     fixture the spine's cooldown leg reads).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const preGateLint = require('../engine/gate/pre-gate-lint.js');

const STAGE_DIR = path.join(__dirname, '..', 'fixtures', 'stage-outputs');
const readJson = (name) => JSON.parse(fs.readFileSync(path.join(STAGE_DIR, name), 'utf8'));

test('draft.json passes the LIVE pre-gate clean (the replay precondition)', () => {
  const draft = readJson('draft.json');
  const brief = readJson('brief.json');
  // Mirror the spine's lint rules: the brief's length window when expressed as [min,max].
  const rules = { env: {} };
  const m = String(brief.target_length || '').match(/(\d+)\s*-\s*(\d+)/u);
  if (m) rules.target_chars = [Number(m[1]), Number(m[2])];
  const result = preGateLint.lint(draft, rules);
  assert.equal(result.verdict, 'PASS', `draft must pass clean; codes: ${result.detected_codes.map((c) => c.code).join(', ')}`);
  assert.equal(result.detected_codes.length, 0, 'no deterministic codes on the recorded draft');
});

test('draft.json carries exactly 3 distinct labeled variants (DD-11)', () => {
  const draft = readJson('draft.json');
  assert.equal(draft.variants.length, 3);
  const labels = draft.variants.map((v) => v.label);
  assert.equal(new Set(labels).size, 3, 'three distinct variant labels');
});

test('gate-verdicts.json is labeled recorded + satisfies the union-of-codes contract (DD-3)', () => {
  const gv = readJson('gate-verdicts.json');
  assert.equal(gv.recorded_fixture, true, 'must carry the replay label');

  const stages = gv.stages || [];
  const lintStage = stages.find((s) => s.stage === 'lint');
  assert.ok(lintStage, 'a recorded lint reference stage is present');

  // Collect every code detected across the per-stage chain.
  const stageCodes = new Set();
  for (const s of stages) for (const c of s.detected_codes || []) stageCodes.add(c.code);

  // Union contract: the final verdict carries forward every stage detection (adds, never drops).
  const finalCodes = new Set((gv.final_verdict.detected_codes || []).map((c) => c.code));
  for (const code of stageCodes) {
    assert.ok(finalCodes.has(code), `final verdict must carry forward ${code} (union, never drop)`);
  }

  // At least one soft warn with bars_recommended (the PASS_ALTERNATE_ONLY driver).
  const softBars = (gv.final_verdict.detected_codes || []).filter(
    (c) => c.tier === 'soft' && c.disposition === 'warn' && c.bars_recommended,
  );
  assert.ok(softBars.length >= 1, 'a soft warn with bars_recommended is present');
  assert.equal(gv.final_verdict.verdict, 'PASS_ALTERNATE_ONLY', 'a barred alternate ⇒ PASS_ALTERNATE_ONLY');
  assert.equal(gv.final_verdict.recommended_variant, 'recommended', 'the Recommended pick is code-clean');
});

test('usage-log.jsonl has one entry inside and one outside the 14-day hard floor', () => {
  const lines = fs.readFileSync(path.join(STAGE_DIR, 'usage-log.jsonl'), 'utf8')
    .split(/\r?\n/u).map((l) => l.trim()).filter(Boolean)
    .map((l) => JSON.parse(l));
  assert.equal(lines.length, 2, 'two cooldown-history entries');
  const offsets = lines.map((r) => r._fixture_offset_days_ago).sort((a, b) => a - b);
  assert.ok(offsets[0] < 14, 'one use inside the 14-day hard floor');
  assert.ok(offsets[1] > 14, 'one use outside the 14-day hard floor');
  for (const r of lines) {
    assert.ok(r.asset_id && r.content_id && r.used_at, 'each entry has the canonical {asset_id,content_id,used_at}');
  }
});
