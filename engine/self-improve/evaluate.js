'use strict';

/**
 * engine/self-improve/evaluate.js  [N net-new]
 *
 * GOVERNED SELF-IMPROVEMENT LOOP — the learning-record EVALUATION + evidence-threshold layer
 * (release-spec roadmap #3 "Governed self-improvement loop — machine-applied Learning Records
 * with DD-6 machinery"; original-design-spec §2.6 self-improvement; DD-6; §8.9; §15.4; §3.1
 * never-loosen; RD-12 zero-key determinism).
 *
 * WHAT THIS IS / WHAT IT IS NOT:
 *   - This module DERIVES improvement PROPOSALS deterministically from the existing analytics
 *     (engine/analytics/engagement: baselines/outliers/performance-report) and CLASSIFIES each
 *     proposal as auto-applicable (above the configured evidence bar) vs proposed-only (below the
 *     bar => stays human-applied, the v1 behavior in engine/analytics/engagement/learning.js).
 *   - It does NOT apply anything. APPLY / CANARY / PROMOTE / ROLLBACK live in the sibling
 *     governance substrate (engine/self-improve/_governance.js) + the future applier; the
 *     governance ships TOGETHER with the application, never the application alone (FEATURE LAW;
 *     §8.9 "ships with its governance machinery, never before"). This file is the EVIDENCE half:
 *     it tells the applier whether a record may ever be machine-touched, stamps the governance
 *     fields the applier reads, and emits a deterministic `machine_change` payload the applier
 *     clamps + applies.
 *
 * It builds on the canonical sibling governance modules rather than re-deriving their rules:
 *   - engine/self-improve/mutability.js (SI-MUTABILITY) — the structural HUMAN-ONLY / NEVER-LOOSEN
 *     classifier (classifyTarget / assertNotGateLoosening). We CALL it; we never re-decide
 *     mutability ourselves.
 *   - engine/self-improve/_governance.js (SI-GOVERNANCE) — the machine-allowed-target registry
 *     (MACHINE_ALLOWED_TARGETS), the loop config gate, the kill switch, and the evidence-bar
 *     reader (evaluateEvidence). Our records emit target_artifacts that are KEYS of that registry
 *     and a `machine_change.values` map the applier's computeNextConfig consumes, so the applier's
 *     own evidence + bound checks agree with ours by construction.
 *   - engine/analytics/engagement/learning.js (analytics) — the v1 proposeLearningRecord path
 *     (status forced to `proposed`; only learning/proposed/ written). We reuse it so a proposal is
 *     always a schema-conformant, proposed-only learning record first; the DD-6 governance fields
 *     are layered on top.
 *
 * DD-6 GOVERNANCE — the parts this module owns:
 *   (1) HUMAN-ONLY boundary: the ONLY emitted targets are machine-allowed knobs (calendar /
 *       archetype / content-type weightings — the keys of _governance.MACHINE_ALLOWED_TARGETS).
 *       Every proposal is classified with mutability.classifyTarget; a human-only / gate /
 *       threshold target is NEVER emitted, and isAutoApplicable() structurally REFUSES a record
 *       whose target is not a registered machine knob — regardless of how strong its evidence is.
 *   (2) NEVER-LOOSEN invariant (§3.1): proposals only re-weight content-preference knobs (no gate
 *       axis), and each is run through mutability.assertNotGateLoosening; isAutoApplicable() rejects
 *       any record that fails that check. A machine change can never make a gate more permissive.
 *   (3) EVIDENCE THRESHOLD: a record is auto-applicable only at/above the configured bar
 *       (min sample_size, confidence, effect_size, from config.self_improvement.evidence). Below
 *       the bar it stays `proposed` (human-applied — the v1 behavior). Never act on thin evidence
 *       (DD-6 / DR W#21 n>=2).
 *   (4)/(5)/(6) CANARY / ROLLBACK / VERSIONING / KILL-SWITCH live in _governance.js + pause.js;
 *       this module initializes governance_state to `proposed`, never advances it, and refuses to
 *       evaluate at all when the loop is OFF (config-gated, off by default) or PAUSED (§15.4).
 *
 * DETERMINISTIC (RD-2 / RD-12): the engine NEVER calls chain LLMs. Proposals are a pure function of
 * the analytics inputs + config; same inputs => same proposals + classifications, testable zero-key.
 * An optional host analyst seat (opts.analystSeat) may REFINE proposal prose (rationale only) — it
 * can never change a target, a knob value, the evidence math, or a classification, and the module
 * degrades to identical behavior when it is absent.
 *
 * Pure of brand specifics (§1 per-path rule): no account enums, no hardcoded paths, no codename.
 */

const path = require('path');

const { proposeLearningRecord, LearningRecordError } = require('../analytics/engagement/learning.js');
const governance = require('./_governance.js');
const mutability = require('./mutability.js');

/** Governance lifecycle (DD-6 (4)/(5)). This module only ever emits `proposed`. */
const GOVERNANCE_STATES = Object.freeze(['proposed', 'canary', 'promoted', 'rolled_back']);

/** The canonical registry target_artifact ids (KEYS of _governance.MACHINE_ALLOWED_TARGETS). */
const TARGET_ARCHETYPE = 'config:archetype.priority';
const TARGET_CONTENT_TYPE = 'config:content_type.priority';
const TARGET_CALENDAR = 'config:calendar.weights';

/**
 * The analytics aggregate dimensions that map to a machine knob. theme/hook => archetype
 * prioritization; type/format => content-type prioritization. Calendar-weighting proposals come
 * from explicit slot signals. Each target_artifact is a KEY of the SI-GOVERNANCE registry; the
 * mutability descriptor is pulled from that registry at derive time (no hardcoded drift).
 */
const DIMENSION_TARGETS = Object.freeze({
  theme: TARGET_ARCHETYPE,
  hook: TARGET_ARCHETYPE,
  type: TARGET_CONTENT_TYPE,
  format: TARGET_CONTENT_TYPE,
});

/**
 * Proposal-side default bound (DD-6 (1) "within human-set bounds"). max_weight_delta mirrors the
 * system.schema self_improve.allowlist.bounds default (0.15); weight_range mirrors the registry
 * default ([0,1]). The applier re-clamps to the LIVE config bound before applying — the registry
 * bound is the authority; these are the proposal-side bound. Overridable via
 * config.self_improve.allowlist.bounds.
 */
const DEFAULT_BOUNDS = Object.freeze({
  max_weight_delta: 0.15, // never move a weighting more than this per machine step
  min: 0,                 // weight floor
  max: 1,                 // weight ceiling (registry default)
});

class EvaluateError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EvaluateError';
  }
}

// ---------------------------------------------------------------------------
// Loop gating (DD-6 (6); §15.4) — delegated to the canonical governance module.
// ---------------------------------------------------------------------------

/** The canonical self_improve config block (tolerates the legacy self_improvement alias), or {}. */
function siBlock(config = {}) {
  if (!config || typeof config !== 'object') return {};
  return (config.self_improve && typeof config.self_improve === 'object' && config.self_improve)
    || (config.self_improvement && typeof config.self_improvement === 'object' && config.self_improvement)
    || {};
}

/** The whole loop is config-gated and OFF unless config.self_improve.enabled === true (DD-6 (6)). */
function loopEnabled(config = {}) {
  return siBlock(config).enabled === true;
}

/** PAUSED sentinel present => kill switch engaged (§15.4). Delegates to _governance.isPaused. */
function isPaused(env = process.env) {
  return governance.isPaused(env);
}

// ---------------------------------------------------------------------------
// Deterministic evidence math (RD-12 zero-key)
// ---------------------------------------------------------------------------

/**
 * Relative lift of a value vs a baseline, as a signed fraction. +0.5 = 50% above baseline,
 * -0.4 = 40% below. Returns null when the baseline is absent or zero (no denominator).
 */
function relativeLift(value, baseline) {
  if (typeof value !== 'number' || typeof baseline !== 'number') return null;
  if (baseline === 0) return null;
  return (value - baseline) / baseline;
}

/**
 * Deterministic confidence proxy in [0,1] (NOT a p-value — RD-2 forbids stats libs / chain calls).
 * Monotonic in BOTH sample size and effect magnitude so the bar rewards "big effect, many samples"
 * and punishes "tiny effect" or "n=1". Pure and stable.
 *   sampleFactor : saturating in n (n>=10 ~= full credit), 0 at n<=1.
 *   effectFactor : saturating in |lift| (|lift|>=0.5 ~= full credit).
 */
function computeConfidence(sampleSize, effectSize) {
  const n = Number.isFinite(sampleSize) ? Math.max(0, sampleSize) : 0;
  if (n <= 1) return 0; // n=1 never earns confidence (DR W#21)
  const e = Number.isFinite(effectSize) ? Math.min(1, Math.abs(effectSize)) : 0;
  const sampleFactor = Math.min(1, (n - 1) / 9); // 0 at n=1, 1 at n>=10
  const effectFactor = Math.min(1, e / 0.5);     // 1 at |lift|>=0.5
  return Number((sampleFactor * effectFactor).toFixed(4));
}

/** Cap a relative lift to the configured delta bound, preserving sign (DD-6 (1) bounds). */
function capDelta(lift, bounds) {
  const max = typeof bounds.max_weight_delta === 'number' ? Math.abs(bounds.max_weight_delta) : DEFAULT_BOUNDS.max_weight_delta;
  if (typeof lift !== 'number' || !Number.isFinite(lift)) return 0;
  if (lift > max) return max;
  if (lift < -max) return -max;
  return lift;
}

/**
 * Translate a capped delta into an absolute, clamped weight value. The neutral weight is the
 * MIDPOINT of the human-set [min,max] range (so a knob has symmetric headroom to be increased or
 * decreased); the proposed weight is neutral + delta*(range/2), clamped to [min,max]. The applier
 * re-clamps to the live bound before applying (the registry bound is the authority).
 */
function deltaToWeight(delta, bounds) {
  const min = typeof bounds.min === 'number' ? bounds.min : DEFAULT_BOUNDS.min;
  const max = typeof bounds.max === 'number' ? bounds.max : DEFAULT_BOUNDS.max;
  const neutral = (min + max) / 2;
  const halfRange = (max - min) / 2;
  const raw = neutral + delta * halfRange;
  return Number(Math.min(max, Math.max(min, raw)).toFixed(4));
}

// ---------------------------------------------------------------------------
// Governance config resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the effective evidence bar + bounds, merging config over the conservative defaults. The
 * evidence bar is read from the SAME place the applier reads it (_governance.loopConfig semantics:
 * config.self_improvement.evidence) so our classification and the applier's agree. Bounds are
 * proposal-side; the registry bound is the authority at apply time.
 */
function resolveGovernance(config = {}) {
  const si = siBlock(config);
  const threshold = { ...governance.DEFAULT_EVIDENCE, ...(si.evidence || {}) };
  // Floor the sample bar the same way _governance.loopConfig does (never below the analytics
  // outlier-sample floor; mirrors MIN_SAMPLE_FLOOR=3).
  const floor = typeof governance.MIN_SAMPLE_FLOOR === 'number' ? governance.MIN_SAMPLE_FLOOR : 3;
  threshold.min_sample_size = Math.max(floor, Number(threshold.min_sample_size) || governance.DEFAULT_EVIDENCE.min_sample_size);

  // Human-set bound: prefer the canonical allowlist.bounds, then any flat bounds override, then default.
  const allowBounds = (si.allowlist && si.allowlist.bounds) || {};
  const wr = allowBounds.weight_range || {};
  const bounds = {
    max_weight_delta: pickNum([allowBounds.max_weight_delta, (si.bounds && si.bounds.max_weight_delta)], DEFAULT_BOUNDS.max_weight_delta),
    min: pickNum([wr.min, (si.bounds && si.bounds.min)], DEFAULT_BOUNDS.min),
    max: pickNum([wr.max, (si.bounds && si.bounds.max)], DEFAULT_BOUNDS.max),
  };
  const canaryScope = si.canary && typeof si.canary === 'object' ? si.canary : null;
  return { threshold, bounds, canaryScope };
}

/** First finite number in the list, else the default. */
function pickNum(candidates, dflt) {
  for (const c of candidates) {
    if (typeof c === 'number' && Number.isFinite(c)) return c;
  }
  return dflt;
}

// ---------------------------------------------------------------------------
// Proposal derivation from analytics (deterministic)
// ---------------------------------------------------------------------------

/**
 * Derive deterministic proposals from a performance report's by-dimension aggregates + the group
 * baselines. For each aggregate row that beat (or trailed) its baseline by a measurable margin,
 * propose a bounded reweighting of the corresponding machine knob (a single key in the knob's
 * weight map). Effect size is the relative lift of the row's primary metric mean vs the overall
 * baseline mean for the same metric; the proposed weight is neutral*(1+cappedLift), clamped.
 *
 * @returns {Array<object>} raw proposal descriptors (target/change/evidence) — not yet records.
 */
function deriveProposalsFromReport(report, bounds) {
  const out = [];
  if (!report || typeof report !== 'object') return out;
  const summary = report.weekly_summary || {};
  const aggregates = Array.isArray(summary.aggregates) ? summary.aggregates : [];
  const baselines = Array.isArray(report.baselines) ? report.baselines : [];
  const baselineMeanByMetric = overallBaselineMeans(baselines);

  for (const agg of aggregates) {
    const targetArtifact = DIMENSION_TARGETS[agg.dimension];
    if (!targetArtifact) continue; // not a machine knob dimension — skip (never propose a non-knob)
    const metric = pickAggregateMetric(agg.metrics);
    if (!metric) continue;
    const baseline = baselineMeanByMetric[metric.key];
    const lift = relativeLift(metric.value, baseline);
    if (lift == null) continue;
    const sampleSize = Number.isInteger(agg.sample_size) ? agg.sample_size : 0;
    const delta = capDelta(lift, bounds);
    if (delta === 0) continue;
    out.push(buildProposal({
      targetArtifact,
      laneKey: agg.key,
      delta,
      lift,
      sampleSize,
      bounds,
      evidenceExtra: {
        metric: metric.key,
        observed_value: metric.value,
        baseline_value: baseline,
        dimension: agg.dimension,
      },
    }));
  }
  return out;
}

/**
 * Derive proposals from explicit calendar slot signals ({slot_id, lift, sample_size}) for the
 * calendar_weighting knob. Structurally identical to the report path but targets a slot key.
 */
function deriveProposalsFromCalendarSignals(signals, bounds) {
  const out = [];
  if (!Array.isArray(signals)) return out;
  for (const s of signals) {
    if (!s || typeof s.slot_id !== 'string') continue;
    const lift = typeof s.lift === 'number' ? s.lift : null;
    if (lift == null) continue;
    const sampleSize = Number.isInteger(s.sample_size) ? s.sample_size : 0;
    const delta = capDelta(lift, bounds);
    if (delta === 0) continue;
    out.push(buildProposal({
      targetArtifact: TARGET_CALENDAR,
      laneKey: s.slot_id,
      delta,
      lift,
      sampleSize,
      bounds,
      evidenceExtra: { metric: 'primary' },
    }));
  }
  return out;
}

/** Assemble one raw proposal descriptor (target/change/evidence) from derived numbers. */
function buildProposal(a) {
  const weight = deltaToWeight(a.delta, a.bounds);
  const laneKey = slug(a.laneKey);
  // The mutability descriptor is the registry's own `mutabilityTarget` (kind+path) — the canonical
  // classifier accepts it; we never invent a parallel descriptor (no drift from the registry).
  const spec = governance.targetSpec(a.targetArtifact);
  const classifier = spec && spec.mutabilityTarget
    ? { ...spec.mutabilityTarget }
    : { kind: 'config', path: '' }; // unknown target => fail-closed (classifier will deny)
  return {
    target: {
      target_artifact: a.targetArtifact,
      key: a.laneKey,
      classifier,
    },
    change: {
      op: a.delta >= 0 ? 'increase_weight' : 'decrease_weight',
      delta: Number(a.delta.toFixed(4)),
      // The deterministic payload the applier (_governance.computeNextConfig) consumes + clamps:
      // a partial weight map updating only this lane's key.
      machine_change: { values: { [laneKey]: weight } },
      // Static bound metadata. Named `weight_bounds` (NOT `bounds`) so it does not collide with the
      // mutability comparator's gate-axis `bounds` before/after envelope shorthand — this is not a
      // gate transition, it is the clamp envelope the proposed weight already respects.
      weight_bounds: { min: a.bounds.min, max: a.bounds.max, max_weight_delta: a.bounds.max_weight_delta },
    },
    evidence: {
      sample_size: a.sampleSize,
      effect_size: Number(Math.abs(a.lift).toFixed(4)),
      confidence: computeConfidence(a.sampleSize, a.lift),
      direction: a.lift > 0 ? 'above_baseline' : 'below_baseline',
      ...a.evidenceExtra,
    },
  };
}

/** Average mean per metric across baseline rows (the `*_mean` keys). */
function overallBaselineMeans(baselines) {
  const sums = {};
  const counts = {};
  for (const b of baselines) {
    const m = (b && b.metrics) || {};
    for (const [k, v] of Object.entries(m)) {
      if (!k.endsWith('_mean') || typeof v !== 'number') continue;
      const metric = k.slice(0, -('_mean'.length));
      sums[metric] = (sums[metric] || 0) + v;
      counts[metric] = (counts[metric] || 0) + 1;
    }
  }
  const out = {};
  for (const metric of Object.keys(sums)) out[metric] = sums[metric] / counts[metric];
  return out;
}

/** Pick the aggregate's primary metric mean: likes_mean, else impressions_mean, else views_mean. */
function pickAggregateMetric(metrics = {}) {
  for (const base of ['likes', 'impressions', 'views']) {
    const v = metrics[`${base}_mean`];
    if (typeof v === 'number') return { key: base, value: v };
  }
  return null;
}

/** Filesystem-safe slug for a lane key (no brand specifics leak; stable). */
function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '') || 'unknown';
}

// ---------------------------------------------------------------------------
// Governance classification (DD-6 (1)/(2)/(3) — structural, delegated)
// ---------------------------------------------------------------------------

/**
 * Is this record's target a registered machine-allowed knob AND classified machine-changeable by
 * the canonical mutability classifier? Both checks must pass (defence in depth): the SI-GOVERNANCE
 * registry (target_artifact is a known knob) AND the SI-MUTABILITY classifier (the descriptor is
 * not a gate/guardrail/threshold/human-only surface). Either failing => not machine-changeable.
 */
function targetIsMachineChangeable(record) {
  if (!record || typeof record !== 'object') return false;
  if (!governance.isMachineAllowedTarget(record.target_artifact)) return false;
  const descriptor = record.target && record.target.classifier;
  const verdict = mutability.classifyTarget(descriptor || { kind: 'config', path: '' });
  return verdict.classification === mutability.CLASSIFICATION.MACHINE_CHANGEABLE;
}

/**
 * Would applying this change loosen a gate/guardrail? (NEVER-LOOSEN, §3.1.) Delegated to the
 * canonical mutability.assertNotGateLoosening — a weight reweighting carries no gate axis, so it
 * passes; anything that does carry one (a malformed proposal) throws there and we report true.
 */
function loosensGuardrail(record) {
  if (!record || typeof record !== 'object') return true; // fail closed
  const descriptor = record.target && record.target.classifier;
  // A content-preference reweighting carries NO gate axis (no severity/disposition/threshold/bounds
  // transition). We hand the comparator only the gate-axis-bearing fields, if any — a well-formed
  // reweighting has none, so the comparator sees no transition and passes. A malformed proposal that
  // smuggled a gate-axis field would throw ENEVERLOOSEN and be refused (belt-and-suspenders with the
  // target-kind refusal in targetIsMachineChangeable).
  const change = gateAxisFieldsOnly(record.change || {});
  try {
    mutability.assertNotGateLoosening(descriptor || {}, change);
    return false;
  } catch (err) {
    if (err && err.code === 'ENEVERLOOSEN') return true;
    return true; // any unexpected error => fail closed
  }
}

/** Keep only the fields the mutability gate-axis comparator inspects (drop our reweighting metadata). */
function gateAxisFieldsOnly(change) {
  const out = {};
  for (const k of ['severity', 'tier', 'disposition', 'bars_recommended', 'field', 'before', 'after', 'numeric', 'bounds', 'effects']) {
    if (k in change) out[k] = change[k];
  }
  return out;
}

/**
 * isAutoApplicable — the EVIDENCE-THRESHOLD + governance gate (DD-6 (1)/(2)/(3)).
 *
 * Returns true ONLY when ALL hold:
 *   - the loop is enabled (config-gated; DD-6 (6));
 *   - the target is a registered machine knob AND classified machine-changeable (DD-6 (1));
 *   - the change does not loosen a guardrail (never-loosen, §3.1; DD-6 (2));
 *   - mutability_check === 'learnable' (a human-only record is never auto-applicable);
 *   - evidence clears every configured bar (sample_size, confidence, effect_size; DD-6 (3)) —
 *     evaluated via _governance.evaluateEvidence so the applier and this layer agree.
 * Otherwise the record stays proposed-only (human-applied — the v1 behavior).
 *
 * Pure: no I/O, no clock; deterministic in (record, config). Safe to call standalone.
 *
 * @param {object} record  a governance-extended learning record (from evaluateForImprovement).
 * @param {object} [config] system config (reads config.self_improvement.{enabled,evidence}).
 * @returns {boolean}
 */
function isAutoApplicable(record, config = {}) {
  if (!record || typeof record !== 'object') return false;
  if (!loopEnabled(config)) return false;                 // (6)
  if (!targetIsMachineChangeable(record)) return false;   // (1)
  if (record.mutability_check !== 'learnable') return false; // (1)
  if (loosensGuardrail(record)) return false;             // (2)
  const { threshold } = resolveGovernance(config);        // (3)
  return governance.evaluateEvidence(record, threshold).ok;
}

/**
 * Classify the mutability of a proposal record using the canonical classifier. A machine-allowed,
 * machine-changeable target is `learnable`; anything else is `human-only` (and will be refused).
 */
function classifyMutability(record) {
  return targetIsMachineChangeable(record) ? 'learnable' : 'human-only';
}

/** Build a human-readable proposed_diff for the record (deterministic; analyst seat may refine). */
function renderDiff(proposal, rationale) {
  const { target, change } = proposal;
  const sign = change.delta >= 0 ? '+' : '';
  const weight = change.machine_change.values[slug(target.key)];
  const lines = [
    '# proposed machine change (governed self-improvement loop, DD-6)',
    `# target: ${target.target_artifact} :: ${target.key}`,
    `# bounded reweighting capped to +/-${change.weight_bounds.max_weight_delta}, clamped to [${change.weight_bounds.min},${change.weight_bounds.max}]`,
    `- weight[${target.key}]: (current)`,
    `+ weight[${target.key}]: ${weight}  (${sign}${change.delta} relative)`,
  ];
  if (rationale) lines.push(`# rationale: ${rationale}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * evaluateForImprovement — derive governed, classified learning-record PROPOSALS.
 *
 * Reads the analytics inputs (a performance report and/or explicit calendar slot signals), derives
 * deterministic proposals for the machine-changeable knobs ONLY, attaches the DD-6 governance
 * fields, classifies each as auto-applicable vs proposed-only against the configured evidence bar,
 * and (by default) writes each as a PROPOSED learning record via the v1 proposeLearningRecord path
 * (status forced to `proposed`, governance_state `proposed`).
 *
 * The loop is OFF by default and halts under the PAUSED kill switch (§15.4): when disabled or
 * paused, NO proposals are emitted and `{ ran: false }` is returned.
 *
 * This module NEVER applies a change and NEVER advances governance_state past `proposed`
 * (CANARY/PROMOTE/ROLLBACK belong to the applier). `auto_applicable: true` is a CLASSIFICATION the
 * applier consumes, not a self-grant of application here.
 *
 * @param {object} opts
 * @param {object}   [opts.config]           system config; reads opts.config.self_improvement.
 * @param {object}   [opts.report]           a performance-report object (analytics §7.9).
 * @param {Array}    [opts.calendarSignals]  [{slot_id, lift, sample_size}] direct slot signals.
 * @param {string}   [opts.baselineRef]      instance-repo commit ref of the known-good baseline (DD-6 (5)).
 * @param {object}   [opts.analystSeat]      OPTIONAL injectable refiner: { refine({target,change,evidence}) => string|null }
 *                                           It may only return a rationale STRING; it cannot change
 *                                           targets/values/evidence/classification. Degrades when absent.
 * @param {object}   [opts.env]              env for paths/pause resolution (default process.env).
 * @param {number}   [opts.now]              injected clock (ms) for record timestamps.
 * @param {boolean}  [opts.write]            write each proposed record (default true).
 * @returns {{ran:boolean, reason?:string, proposals:Array<{record, written, auto_applicable, flags}>,
 *            summary:{total:number, auto_applicable:number, proposed_only:number, refused:number}}}
 */
function evaluateForImprovement(opts = {}) {
  const env = opts.env || process.env;
  const config = opts.config || {};

  // (6) OFF by default + kill switch (§15.4 / DD-6 (6)).
  if (!loopEnabled(config)) {
    return { ran: false, reason: 'self-improvement loop disabled (off by default; set self_improvement.enabled)', proposals: [], summary: emptySummary() };
  }
  if (isPaused(env)) {
    return { ran: false, reason: 'PAUSED kill switch engaged (§15.4) — loop halted', proposals: [], summary: emptySummary() };
  }

  const { bounds, canaryScope } = resolveGovernance(config);
  const baselineRef = typeof opts.baselineRef === 'string' && opts.baselineRef ? opts.baselineRef : null;
  if (baselineRef && path.isAbsolute(baselineRef)) {
    throw new EvaluateError('baselineRef must be a CONTENT_HOME-relative path or an instance-repo commit ref, not absolute');
  }

  // Deterministic proposal derivation (RD-2: no chain LLM).
  const raw = [
    ...deriveProposalsFromReport(opts.report, bounds),
    ...deriveProposalsFromCalendarSignals(opts.calendarSignals, bounds),
  ];

  const analystSeat = opts.analystSeat && typeof opts.analystSeat.refine === 'function' ? opts.analystSeat : null;

  const proposals = [];
  const summary = emptySummary();
  for (const p of raw) {
    summary.total += 1;

    // Optional analyst refinement: PROSE ONLY. We deep-clone the inputs so the seat cannot mutate
    // the deterministic proposal; we accept only a returned rationale string (RD-2 degrades).
    let rationale = null;
    if (analystSeat) {
      try {
        const refined = analystSeat.refine({
          target: JSON.parse(JSON.stringify(p.target)),
          change: JSON.parse(JSON.stringify(p.change)),
          evidence: { ...p.evidence },
        });
        if (typeof refined === 'string') rationale = refined.slice(0, 500);
      } catch {
        rationale = null; // a throwing seat must not break determinism (degrade)
      }
    }

    // Build the v1 proposed record (status forced to `proposed`; only learning/proposed/ written).
    let base;
    try {
      base = proposeLearningRecord({
        source_signals: [{
          type: 'analytics',
          // The applier's _governance.evaluateEvidence reads sample size from source_signals[].count;
          // keep it equal to the evidence sample_size so both layers agree.
          count: Number.isInteger(p.evidence.sample_size) ? Math.max(1, p.evidence.sample_size) : 1,
          ...(baselineRef && !looksLikeCommitRef(baselineRef) ? { refs: [baselineRef] } : {}),
        }],
        target_artifact: p.target.target_artifact,
        target_mutability: 'learnable', // a machine knob; recorded pre-apply (schema field)
        proposed_diff: renderDiff(p, rationale),
      }, { env, now: opts.now, write: false });
    } catch (err) {
      if (err instanceof LearningRecordError) {
        summary.refused += 1;
        proposals.push({ record: null, written: null, auto_applicable: false, flags: { refused: true, reason: err.message } });
        continue;
      }
      throw err;
    }

    // Layer the DD-6 governance fields on top of the base learning record.
    const record = {
      ...base.record,
      target: p.target,
      change: p.change,
      // The applier reads record.machine_change.values; surface it at the top level too.
      machine_change: p.change.machine_change,
      evidence: p.evidence,
      governance_state: 'proposed', // (4)/(5): this module NEVER advances it
      ...(baselineRef ? { baseline_ref: baselineRef } : {}),
      ...(canaryScope ? { canary_scope: canaryScope } : {}),
      ...(rationale ? { rationale } : {}),
    };
    record.mutability_check = classifyMutability(record);

    const auto = isAutoApplicable(record, config);
    const evi = governance.evaluateEvidence(record, resolveGovernance(config).threshold);
    const flags = {
      auto_applicable: auto,
      human_only: record.mutability_check === 'human-only',
      loosens_guardrail: loosensGuardrail(record),
      below_threshold: !auto && record.mutability_check === 'learnable' && !loosensGuardrail(record) && !evi.ok,
      evidence_reasons: evi.reasons,
    };
    if (auto) summary.auto_applicable += 1; else summary.proposed_only += 1;

    let written = null;
    if (opts.write !== false) written = writeProposedRecord(record, env);

    proposals.push({ record, written, auto_applicable: auto, flags });
  }

  return { ran: true, proposals, summary };
}

/** Heuristic: a 7-40 char hex string is a commit ref (goes in baseline_ref, not signal refs). */
function looksLikeCommitRef(ref) {
  return /^[0-9a-f]{7,40}$/iu.test(String(ref));
}

/** Write the governance-enriched record to $CONTENT_HOME/learning/proposed/ (redacted, atomic). */
function writeProposedRecord(record, env = process.env) {
  // Delegate to the v1 writer so redaction + atomic-rename + path resolution stay single-sourced.
  const learning = require('../analytics/engagement/learning.js');
  return learning.writeProposed(record, env);
}

function emptySummary() {
  return { total: 0, auto_applicable: 0, proposed_only: 0, refused: 0 };
}

module.exports = {
  GOVERNANCE_STATES,
  DEFAULT_BOUNDS,
  DIMENSION_TARGETS,
  TARGET_ARCHETYPE,
  TARGET_CONTENT_TYPE,
  TARGET_CALENDAR,
  EvaluateError,
  // public API
  evaluateForImprovement,
  isAutoApplicable,
  // governance helpers (also used by the applier + tests)
  loopEnabled,
  isPaused,
  classifyMutability,
  targetIsMachineChangeable,
  loosensGuardrail,
  resolveGovernance,
  // deterministic evidence math (tests)
  relativeLift,
  computeConfidence,
  capDelta,
  deltaToWeight,
  // derivation internals (tests)
  deriveProposalsFromReport,
  deriveProposalsFromCalendarSignals,
  overallBaselineMeans,
  pickAggregateMetric,
  slug,
};
