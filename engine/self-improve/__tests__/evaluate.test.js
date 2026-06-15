'use strict';

/**
 * engine/self-improve/__tests__/evaluate.test.js  [N net-new]
 *
 * Covers the GOVERNED SELF-IMPROVEMENT loop EVALUATION + evidence threshold
 * (engine/self-improve/evaluate.js; release-spec roadmap #3; DD-6; §8.9; §15.4; §3.1; RD-12).
 *
 * The evaluator integrates with the canonical sibling governance modules — the SI-MUTABILITY
 * classifier (engine/self-improve/mutability.js) and the SI-GOVERNANCE registry + evidence reader
 * (engine/self-improve/_governance.js) — rather than re-deriving their rules. These tests assert
 * the integration: emitted target_artifacts are registry keys, the evidence sample_size matches the
 * source_signals count the applier reads, the machine_change payload is present, and the human-only
 * / never-loosen refusals route through the canonical classifier.
 *
 * Zero-dependency, zero-key (RD-12): Node's built-in test runner, deterministic with an injected
 * clock — no chain LLM, no live API, no credentials.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const evaluate = require('../evaluate.js');
const governance = require('../_governance.js');

function tempHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oce-self-improve-'));
  return { CONTENT_HOME: dir };
}

/** Enabled-loop config with a moderate bar (canonical self_improve shape; spelled out for clarity). */
function enabledConfig(over = {}) {
  return {
    self_improve: {
      enabled: true,
      evidence: { min_sample_size: 5, min_confidence: 0.6, min_effect_size: 0.2 },
      allowlist: {
        targets: ['calendar_weighting', 'archetype_priority', 'content_type_priority'],
        bounds: { max_weight_delta: 0.25, weight_range: { min: 0, max: 1 } },
      },
      ...over,
    },
  };
}

/** A performance report with a strong over-performing theme + a weak under-performing format. */
function reportWithStrongAndWeak() {
  return {
    checkpoints: [],
    baselines: [
      { dimension: 'overall', key: 'acme-cosmos|twitter|24h', window: 'last_20', metrics: { likes_mean: 100 } },
    ],
    weekly_summary: {
      period: { start: '2026-06-01', end: '2026-06-08' },
      aggregates: [
        // theme "lore" beat baseline (200 vs 100 => +100% lift), 12 samples => strong evidence.
        { dimension: 'theme', key: 'lore', sample_size: 12, metrics: { likes_mean: 200 } },
        // format "thread" trailed baseline (40 vs 100 => -60% lift) but only 2 samples => thin.
        { dimension: 'format', key: 'thread', sample_size: 2, metrics: { likes_mean: 40 } },
      ],
      recommendations: [],
    },
  };
}

// ---------------------------------------------------------------------------
// (6) OFF by default + kill switch
// ---------------------------------------------------------------------------

test('the loop is OFF by default — no config, nothing runs, nothing written', () => {
  const env = tempHome();
  const res = evaluate.evaluateForImprovement({ env, report: reportWithStrongAndWeak() });
  assert.equal(res.ran, false);
  assert.match(res.reason, /disabled|off by default/i);
  assert.equal(res.proposals.length, 0);
  assert.ok(!fs.existsSync(path.join(env.CONTENT_HOME, 'learning', 'proposed')));
});

test('a PAUSED instance halts the loop (§15.4 kill switch)', () => {
  const env = tempHome();
  fs.writeFileSync(path.join(env.CONTENT_HOME, 'PAUSED'), 'maintenance');
  const res = evaluate.evaluateForImprovement({ env, config: enabledConfig(), report: reportWithStrongAndWeak() });
  assert.equal(res.ran, false);
  assert.match(res.reason, /PAUSED|kill switch/i);
  assert.equal(res.proposals.length, 0);
});

test('isPaused fails CLOSED when CONTENT_HOME is unset', () => {
  assert.equal(evaluate.isPaused({}), true);
});

// ---------------------------------------------------------------------------
// Proposal derivation + (3) evidence threshold classification
// ---------------------------------------------------------------------------

test('derives proposals only for machine knobs and classifies by the evidence bar', () => {
  const env = tempHome();
  const now = Date.UTC(2026, 5, 8);
  const res = evaluate.evaluateForImprovement({
    env, now, config: enabledConfig(), report: reportWithStrongAndWeak(),
  });
  assert.equal(res.ran, true);
  assert.equal(res.summary.total, 2);

  const byKey = Object.fromEntries(res.proposals.map((p) => [p.record.target.key, p]));
  const strong = byKey.lore;
  const weak = byKey.thread;

  // Strong: 12 samples, +100% lift (capped delta), clears the bar => auto-applicable.
  assert.equal(strong.record.target.target_artifact, 'config:archetype.priority');
  assert.equal(strong.record.change.op, 'increase_weight');
  assert.equal(strong.record.change.delta, 0.25); // capped to max_weight_delta
  // machine_change payload the applier consumes: neutral 0.5 (midpoint of [0,1]) + 0.25*0.5 = 0.625.
  assert.equal(strong.record.machine_change.values.lore, 0.625);
  assert.equal(strong.record.evidence.sample_size, 12);
  assert.equal(strong.auto_applicable, true);

  // Weak: only 2 samples => below the sample bar, stays proposed-only (human-applied).
  assert.equal(weak.record.target.target_artifact, 'config:content_type.priority');
  assert.equal(weak.record.change.op, 'decrease_weight');
  assert.equal(weak.auto_applicable, false);
  assert.equal(weak.flags.below_threshold, true);

  assert.equal(res.summary.auto_applicable, 1);
  assert.equal(res.summary.proposed_only, 1);
});

test('emitted target_artifacts are KEYS of the SI-GOVERNANCE machine-allowed registry', () => {
  const env = tempHome();
  const res = evaluate.evaluateForImprovement({ env, config: enabledConfig(), report: reportWithStrongAndWeak() });
  for (const p of res.proposals) {
    assert.ok(governance.isMachineAllowedTarget(p.record.target_artifact),
      `${p.record.target_artifact} must be a registry key`);
  }
});

test('the applier evidence reader (_governance.evaluateEvidence) agrees with the auto-applicable flag', () => {
  const env = tempHome();
  const config = enabledConfig();
  const res = evaluate.evaluateForImprovement({ env, config, report: reportWithStrongAndWeak() });
  const bar = evaluate.resolveGovernance(config).threshold;
  for (const p of res.proposals) {
    // The applier reads sample size from source_signals[].count; it must equal evidence.sample_size.
    const signalCount = p.record.source_signals.reduce((s, g) => s + g.count, 0);
    assert.equal(signalCount, p.record.evidence.sample_size);
    // And its evidence verdict must match our auto-applicable classification for learnable, non-loosening targets.
    const applierOk = governance.evaluateEvidence(p.record, bar).ok;
    assert.equal(p.auto_applicable, applierOk);
  }
});

test('every emitted record is status:proposed, governance_state:proposed; only learning/proposed written', () => {
  const env = tempHome();
  const res = evaluate.evaluateForImprovement({ env, config: enabledConfig(), report: reportWithStrongAndWeak() });
  for (const p of res.proposals) {
    assert.equal(p.record.status, 'proposed');           // never applied here
    assert.equal(p.record.governance_state, 'proposed');  // never advanced (CANARY/PROMOTE = applier)
    assert.equal(p.record.mutability_check, 'learnable');
    assert.equal(p.record.target_mutability, 'learnable');
    assert.ok(p.written.startsWith(path.join(env.CONTENT_HOME, 'learning', 'proposed')));
    assert.ok(fs.existsSync(p.written));
  }
  // No rules/ or config/ mutation — DD-6 (1).
  assert.ok(!fs.existsSync(path.join(env.CONTENT_HOME, 'rules')));
  assert.ok(!fs.existsSync(path.join(env.CONTENT_HOME, 'config')));
});

test('the emitted record conforms to learning-record.schema.json (required base fields + enums)', () => {
  const env = tempHome();
  const res = evaluate.evaluateForImprovement({ env, config: enabledConfig(), report: reportWithStrongAndWeak() });
  const schema = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', '..', '..', 'schemas', 'artifacts', 'learning-record.schema.json'), 'utf8',
  ));
  const rec = res.proposals[0].record;
  for (const req of schema.required) assert.ok(req in rec, `missing required field ${req}`);
  assert.ok(schema.properties.status.enum.includes(rec.status));
  assert.ok(schema.properties.target_mutability.enum.includes(rec.target_mutability));
});

// ---------------------------------------------------------------------------
// (1) HUMAN-ONLY boundary + (2) NEVER-LOOSEN — structural refusal via canonical classifier
// ---------------------------------------------------------------------------

test('isAutoApplicable structurally REFUSES a human-only / gate target no matter the evidence', () => {
  const config = enabledConfig();
  const guardrailRecord = {
    target_artifact: 'config:gate.thresholds.hard', // NOT a machine-allowed registry key
    target: { target_artifact: 'config:gate.thresholds.hard', key: 'fabrication', classifier: { kind: 'gate' } },
    mutability_check: 'human-only',
    source_signals: [{ type: 'analytics', count: 9999 }],
    evidence: { sample_size: 9999, confidence: 1, effect_size: 5 },
    change: {},
  };
  assert.equal(evaluate.isAutoApplicable(guardrailRecord, config), false);
  assert.equal(evaluate.targetIsMachineChangeable(guardrailRecord), false);

  // Even a learnable mutability label cannot rescue a non-registry / gate target.
  const sneaky = { ...guardrailRecord, mutability_check: 'learnable' };
  assert.equal(evaluate.isAutoApplicable(sneaky, config), false);
});

test('a registry key with a gate-source classifier is refused (canonical mutability says human-only)', () => {
  const config = enabledConfig();
  const record = {
    target_artifact: 'config:calendar.weights', // registry key...
    target: { target_artifact: 'config:calendar.weights', key: 's1',
      classifier: { kind: 'config', path: 'calendar.weights.s1', source: 'llm-quality' } }, // ...but gate source layer
    mutability_check: 'learnable',
    source_signals: [{ type: 'analytics', count: 50 }],
    evidence: { sample_size: 50, confidence: 0.9, effect_size: 0.5 },
    change: {},
  };
  assert.equal(evaluate.targetIsMachineChangeable(record), false);
  assert.equal(evaluate.isAutoApplicable(record, config), false);
});

test('the evaluator never emits a non-knob target (only machine dimensions become proposals)', () => {
  const env = tempHome();
  const report = {
    checkpoints: [], baselines: [{ dimension: 'overall', key: 'k', window: 'last_20', metrics: { likes_mean: 100 } }],
    weekly_summary: {
      period: { start: '2026-06-01', end: '2026-06-08' },
      aggregates: [
        // 'platform' is NOT a machine knob dimension => must be skipped.
        { dimension: 'platform', key: 'twitter', sample_size: 30, metrics: { likes_mean: 300 } },
        { dimension: 'theme', key: 'lore', sample_size: 10, metrics: { likes_mean: 300 } },
      ],
      recommendations: [],
    },
  };
  const res = evaluate.evaluateForImprovement({ env, config: enabledConfig(), report });
  assert.equal(res.summary.total, 1); // only the theme aggregate became a proposal
  for (const p of res.proposals) {
    assert.ok(governance.isMachineAllowedTarget(p.record.target_artifact));
    assert.equal(p.record.mutability_check, 'learnable');
  }
});

// ---------------------------------------------------------------------------
// (3) threshold honored from config; disabled loop never auto-applies
// ---------------------------------------------------------------------------

test('a stricter configured bar demotes an otherwise-auto record to proposed-only', () => {
  const env = tempHome();
  const ok = evaluate.evaluateForImprovement({ env, config: enabledConfig(), report: reportWithStrongAndWeak() });
  assert.equal(ok.proposals.find((p) => p.record.target.key === 'lore').auto_applicable, true);

  // A stricter sample bar (>= 50) demotes the 12-sample strong proposal.
  const env2 = tempHome();
  const strict = evaluate.evaluateForImprovement({
    env: env2,
    config: enabledConfig({ evidence: { min_sample_size: 50, min_confidence: 0.6, min_effect_size: 0.2 } }),
    report: reportWithStrongAndWeak(),
  });
  assert.equal(strict.proposals.find((p) => p.record.target.key === 'lore').auto_applicable, false);
});

test('isAutoApplicable returns false when the loop is disabled even for strong evidence', () => {
  const record = {
    target_artifact: 'config:archetype.priority',
    target: { target_artifact: 'config:archetype.priority', key: 'lore',
      classifier: { kind: 'config', path: 'archetype.priority' } },
    mutability_check: 'learnable',
    source_signals: [{ type: 'analytics', count: 99 }],
    evidence: { sample_size: 99, confidence: 1, effect_size: 1 },
    change: {},
  };
  assert.equal(evaluate.isAutoApplicable(record, { self_improve: { enabled: false } }), false);
  assert.equal(evaluate.isAutoApplicable(record, { self_improve: { enabled: true } }), true);
});

// ---------------------------------------------------------------------------
// Deterministic evidence math (RD-12)
// ---------------------------------------------------------------------------

test('computeConfidence is monotonic and zero at n<=1', () => {
  assert.equal(evaluate.computeConfidence(1, 1), 0);
  assert.ok(evaluate.computeConfidence(20, 0.5) >= evaluate.computeConfidence(5, 0.5));
  assert.ok(evaluate.computeConfidence(20, 0.5) >= evaluate.computeConfidence(20, 0.1));
  assert.equal(evaluate.computeConfidence(10, 0.5), 1);
});

test('relativeLift, capDelta, deltaToWeight behave as specified', () => {
  assert.equal(evaluate.relativeLift(200, 100), 1);
  assert.equal(evaluate.relativeLift(40, 100), -0.6);
  assert.equal(evaluate.relativeLift(5, 0), null);
  const b = { max_weight_delta: 0.25, min: 0, max: 1 };
  assert.equal(evaluate.capDelta(1.0, b), 0.25);
  assert.equal(evaluate.capDelta(-0.9, b), -0.25);
  assert.equal(evaluate.capDelta(0.1, b), 0.1);
  // neutral = midpoint(0,1) = 0.5; halfRange = 0.5 => +0.25 delta => 0.625, -0.25 => 0.375.
  assert.equal(evaluate.deltaToWeight(0.25, b), 0.625);
  assert.equal(evaluate.deltaToWeight(-0.25, b), 0.375);
  // clamp: an absurd delta is clamped to [min,max].
  assert.equal(evaluate.deltaToWeight(100, b), 1);
});

test('evaluation is deterministic — same inputs, same proposals + classifications', () => {
  const now = Date.UTC(2026, 5, 8);
  const a = evaluate.evaluateForImprovement({ env: tempHome(), now, config: enabledConfig(), report: reportWithStrongAndWeak() });
  const b = evaluate.evaluateForImprovement({ env: tempHome(), now, config: enabledConfig(), report: reportWithStrongAndWeak() });
  const strip = (r) => r.proposals.map((p) => ({ t: p.record.target, c: p.record.change, e: p.record.evidence, auto: p.auto_applicable }));
  assert.deepEqual(strip(a), strip(b));
});

// ---------------------------------------------------------------------------
// Calendar slot signals + baseline_ref
// ---------------------------------------------------------------------------

test('calendar slot signals produce calendar-weighting proposals; baseline_ref recorded', () => {
  const env = tempHome();
  const res = evaluate.evaluateForImprovement({
    env,
    config: enabledConfig(),
    baselineRef: 'a1b2c3d4e5f6', // commit ref
    calendarSignals: [{ slot_id: 'acme-mon-01', lift: 0.4, sample_size: 8 }],
  });
  assert.equal(res.summary.total, 1);
  const rec = res.proposals[0].record;
  assert.equal(rec.target_artifact, 'config:calendar.weights');
  assert.equal(rec.target.key, 'acme-mon-01');
  assert.equal(rec.baseline_ref, 'a1b2c3d4e5f6');
  assert.ok(governance.isMachineAllowedTarget(rec.target_artifact));
  // machine_change keyed by the slug of the slot id.
  assert.ok('acme-mon-01' in rec.machine_change.values);
});

test('an absolute baselineRef is rejected (CONTENT_HOME-relative or commit ref only)', () => {
  assert.throws(() => evaluate.evaluateForImprovement({
    env: tempHome(), config: enabledConfig(), baselineRef: path.resolve('/abs/baseline'),
    report: reportWithStrongAndWeak(),
  }), /absolute/);
});

// ---------------------------------------------------------------------------
// RD-2 — optional analyst seat refines PROSE only, never the math/classification
// ---------------------------------------------------------------------------

test('the analyst seat may only add rationale prose; targets/values/classification unchanged', () => {
  const report = reportWithStrongAndWeak();
  const base = evaluate.evaluateForImprovement({ env: tempHome(), now: 1, config: enabledConfig(), report });

  // A hostile seat that tries to flip everything: it can only return a string (used as rationale),
  // and any attempt to mutate the passed (cloned) objects must not affect the deterministic record.
  const hostileSeat = {
    refine(p) {
      p.change.delta = 999;
      p.change.machine_change.values.lore = 999;
      p.target.target_artifact = 'config:gate.thresholds.hard';
      p.evidence.sample_size = 1;
      return 'analyst note: reinforce the lore lane';
    },
  };
  const withSeat = evaluate.evaluateForImprovement({ env: tempHome(), now: 1, config: enabledConfig(), report, analystSeat: hostileSeat });

  for (let i = 0; i < base.proposals.length; i += 1) {
    const b = base.proposals[i].record;
    const s = withSeat.proposals[i].record;
    assert.deepEqual(s.target, b.target);
    assert.deepEqual(s.change, b.change);
    assert.deepEqual(s.machine_change, b.machine_change);
    assert.deepEqual(s.evidence, b.evidence);
    assert.equal(s.mutability_check, b.mutability_check);
    assert.equal(withSeat.proposals[i].auto_applicable, base.proposals[i].auto_applicable);
    assert.equal(s.rationale, 'analyst note: reinforce the lore lane');
  }
});

test('a throwing analyst seat degrades cleanly (deterministic result, no rationale)', () => {
  const report = reportWithStrongAndWeak();
  const res = evaluate.evaluateForImprovement({
    env: tempHome(), now: 1, config: enabledConfig(), report,
    analystSeat: { refine() { throw new Error('seat down'); } },
  });
  assert.equal(res.ran, true);
  for (const p of res.proposals) assert.equal(p.record.rationale, undefined);
});

// ---------------------------------------------------------------------------
// Module never imports the queue / never applies (the analytics-path invariant, extended)
// ---------------------------------------------------------------------------

test('evaluate.js never references the queue or any apply/write-rule helper', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'evaluate.js'), 'utf8');
  assert.doesNotMatch(src, /publish-queue|shared\/queue|acquireLock|writeFileAtomic|setEntryState/);
  // It does not CALL the applier's config-mutation / git helpers — it only delegates to
  // learning.writeProposed (proposed-only). (Documentary mentions in comments are fine; we assert
  // no actual invocation of these via the `governance.<fn>(` call form.)
  assert.doesNotMatch(src, /governance\.(writeSystemConfig|computeNextConfig|commitInstance|revertToCommit)\s*\(/);
});
