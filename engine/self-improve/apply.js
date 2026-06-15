'use strict';

/**
 * engine/self-improve/apply.js  [N net-new]
 *
 * The APPLICATION controller of the GOVERNED self-improvement loop — the only place a machine
 * change is APPLIED (release-spec §8.9 "ships WITH its governance machinery, never before";
 * Appendix B.3 #3 "machine-applied Learning Records with DD-6 machinery shipping together";
 * DD-6 the autonomy trust boundary; §15.4 kill switch; §3.1 never-loosen). v1 ships analytics +
 * learning-record CREATION (proposed, human-applied — analytics/engagement/learning.js); THIS
 * file adds the governed MACHINE application that DD-6 gates. Deterministic, zero-key, no chain
 * LLM (RD-2 / RD-12).
 *
 * applyGovernedChange(record, opts) enforces, IN ORDER, fail-closed (any check failure ⇒ NO
 * change — DD-6 (6) auditable + reversible):
 *
 *   GATE 0  KILL SWITCH (DD-6 (6) / §15.4): the PAUSED sentinel halts the loop.
 *   GATE 1  CONFIG-ENABLED (DD-6 (6)): config.self_improvement.enabled must be strictly true
 *           (OFF BY DEFAULT, fail-closed).
 *   GATE 2  HUMAN-ONLY BOUNDARY (DD-6 (1)) + NEVER-LOOSEN (DD-6 (2) / §3.1): BEFORE any write,
 *           call mutability.assertMachineChangeAllowed (refuse human-only / guardrail / gate /
 *           hard-fail targets) and mutability.assertNotGateLoosening (a machine change can NEVER
 *           make a gate/guardrail more permissive). Structural refusal — not a prompt request.
 *           Defence-in-depth: the target must ALSO be in the local machine-allowed-knob registry
 *           (_governance), so even a mis-implemented mutability guard cannot widen the surface.
 *   GATE 3  EVIDENCE THRESHOLD (DD-6 (3)): above the configured bar (min sample / confidence /
 *           effect size) ⇒ auto-applicable; below ⇒ stays PROPOSED (the v1 behavior).
 *   GATE 4  ROLLBACK SUBSTRATE (DD-6 (5)): the instance must be a git repo (the one `engine init`
 *           created); no versioning ⇒ refuse (we will not apply an unrevertable change).
 *
 * On pass it applies the change to the allowed config knob in a LIMITED CANARY SCOPE FIRST
 * (DD-6 (4): governance_state=canary, a slice of the knob keys), writes the schema-conformant
 * learning record (status=applied, rollback_ref = pre-change HEAD) + a governance sidecar
 * (governance_state, baseline ref, canary scope, observe-until), commits BOTH plus the mutated
 * config/system.json to the instance repo as one versioned change (DD-6 (5)), and records the
 * action to the event ledger (DD-6 (6) auditable, surfaced by `engine status`).
 *
 * IDEMPOTENT: re-applying an already-applied record id is a no-op-plus-report (the applied record
 * + sidecar already exist; no second commit). Fail-closed throughout.
 *
 * Tier-3 cleanliness (§0.3 r6): no hardcoded paths/IDs/codenames; all instance paths via paths.js.
 */

const fs = require('fs');

const paths = require('../shared/paths.js');
const ledger = require('../orchestrator/workflow-ledger.js');
const gov = require('./_governance.js');

const { GovernanceError } = gov;

/**
 * Load the SI-MUTABILITY guard module. It is a SIBLING batch (engine/self-improve/mutability.js);
 * loading it lazily + defensively means apply FAILS CLOSED when the guard is absent — refusing to
 * apply rather than applying ungoverned (DD-6: governance ships WITH application, never without).
 */
function loadMutability() {
  let mod;
  try {
    // eslint-disable-next-line global-require
    mod = require('./mutability.js');
  } catch (err) {
    throw new GovernanceError(
      `mutability guard (engine/self-improve/mutability.js) is unavailable: ${err.message}; ` +
        'refusing to apply ungoverned (DD-6 governance ships WITH application)',
      'MUTABILITY_GUARD_MISSING',
    );
  }
  if (typeof mod.assertMachineChangeAllowed !== 'function' || typeof mod.assertNotGateLoosening !== 'function') {
    throw new GovernanceError(
      'mutability guard does not expose assertMachineChangeAllowed + assertNotGateLoosening; ' +
        'refusing to apply (DD-6)',
      'MUTABILITY_GUARD_INCOMPLETE',
    );
  }
  return mod;
}

const SI_LEDGER_ID = 'self-improve'; // ledger content_id bucket for loop events (DD-6 (6) audit).

/** ISO timestamp. */
function nowIso(now) {
  return new Date(typeof now === 'number' ? now : Date.now()).toISOString();
}

/** A standard structured result the CLI / status surface renders. */
function result(ok, code, summary, data) {
  return { ok, code, summary, data: data || {} };
}

/**
 * applyGovernedChange — the public entry point.
 *
 * @param {object} record   a learning record (learning-record.schema.json) carrying:
 *                          - target_artifact (must be a machine-allowed knob)
 *                          - target_mutability ('learnable' for machine-applicable)
 *                          - source_signals[] (the evidence)
 *                          - machine_change {values:{...}} (the deterministic structured change)
 *                          - optional evidence {confidence, effect_size}
 * @param {object} [opts]
 * @param {object}   [opts.env]   env for paths resolution (default process.env).
 * @param {number}   [opts.now]   injected clock (ms).
 * @param {string[]} [opts.canaryScope]  explicit knob-key slice for the canary (DD-6 (4)); when
 *                                        absent, a deterministic slice of the proposed keys is used.
 * @param {object}   [opts.mutability]   injected mutability guard (tests); else require()'d.
 * @returns {object}  { ok, code, summary, data:{ governance_state, rollback_ref, commit, ... } }
 */
function applyGovernedChange(record, opts = {}) {
  const env = opts.env || process.env;
  const now = typeof opts.now === 'number' ? opts.now : Date.now();

  try {
    if (!record || typeof record !== 'object' || !record.id) {
      throw new GovernanceError('a learning record with an id is required', 'BAD_RECORD');
    }

    // IDEMPOTENT: already applied ⇒ report, no second change.
    const recFile = gov.recordPath(record.id, env);
    const govFile = gov.governancePath(record.id, env);
    if (fs.existsSync(recFile) && fs.existsSync(govFile)) {
      const existing = gov.readJson(govFile) || {};
      return result(true, 'ALREADY_APPLIED',
        `record ${record.id} already applied (governance_state=${existing.governance_state || 'unknown'})`,
        { record_id: record.id, governance_state: existing.governance_state, idempotent: true });
    }

    // GATE 0 — kill switch (DD-6 (6) / §15.4).
    if (gov.isPaused(env)) {
      return refuse(record, env, now, 'PAUSED', 'kill switch engaged (PAUSED sentinel) — loop halted (§15.4)');
    }

    // GATE 1 — config-enabled, OFF by default (DD-6 (6)).
    const cfg = gov.loopConfig(env);
    if (!cfg.enabled) {
      return refuse(record, env, now, 'DISABLED',
        'self-improvement loop disabled (config.self_improvement.enabled !== true) — fail-closed (DD-6 (6))');
    }

    // GATE 2a — defence-in-depth: the target must be a registered machine-allowed knob (DD-6 (1)).
    // (Checked before the guard so we have the mutability target descriptor to hand it.)
    if (!gov.isMachineAllowedTarget(record.target_artifact)) {
      return refuse(record, env, now, 'TARGET_NOT_MACHINE_ALLOWED',
        `target_artifact "${record.target_artifact}" is not a machine-allowed knob (DD-6 (1))`);
    }
    // A learnable target is required; a human-only record can never reach apply.
    if (record.target_mutability === 'human-only') {
      return refuse(record, env, now, 'HUMAN_ONLY',
        'record targets a human-only artifact; the applier refuses (DD-6 (1))');
    }

    // GATE 2b — human-only boundary + never-loosen (DD-6 (1)/(2), §3.1). Guard FIRST, before any
    // write. assertMachineChangeAllowed throws EHUMANONLY for a human-only/guardrail/gate target;
    // assertNotGateLoosening throws ENEVERLOOSEN for any gate-loosening effect. The guard takes a
    // (target, change) descriptor — we build the canonical target from the registry + a non-gate
    // content-dial change descriptor (weighting/priority dials are NOT gate axes, so they pass the
    // loosening check while a misclassified gate target would be refused).
    const spec0 = gov.targetSpec(record.target_artifact);
    const mutTarget = spec0.mutabilityTarget;
    const mutChange = buildMutabilityChange(record);
    const mutability = opts.mutability || loadMutability();
    mutability.assertMachineChangeAllowed(mutTarget, mutChange); // throws on human-only refusal.
    mutability.assertNotGateLoosening(mutTarget, mutChange);     // throws on gate-loosening refusal.

    // GATE 3 — evidence threshold (DD-6 (3)). Below the bar ⇒ stays PROPOSED (v1 behavior).
    const evidence = gov.evaluateEvidence(record, cfg.evidence);
    if (!evidence.ok) {
      return refuse(record, env, now, 'BELOW_EVIDENCE_THRESHOLD',
        `evidence below threshold — stays PROPOSED (human-applied): ${evidence.reasons.join('; ')}`,
        { evidence });
    }

    // GATE 4 — rollback substrate must exist (DD-6 (5)). No versioning ⇒ no change.
    if (!gov.isInstanceRepo(env)) {
      return refuse(record, env, now, 'NO_INSTANCE_REPO',
        'instance is not a git repo; refusing an unrevertable change (DD-6 (5) — run "engine init")');
    }

    // ---- All gates passed. Apply in CANARY scope first (DD-6 (4)). ----

    const baselineRef = gov.headRef(env); // pre-change HEAD — the one-step rollback target.
    const config = gov.readSystemConfig(env);

    // Determine the canary slice: explicit keys, else a deterministic fraction of proposed keys.
    const proposedKeys = Object.keys((record.machine_change && record.machine_change.values) || {});
    const canaryScope = Array.isArray(opts.canaryScope) && opts.canaryScope.length
      ? opts.canaryScope
      : deterministicSlice(proposedKeys, cfg.canary_fraction);

    const { next, before, after, spec, bound } = gov.computeNextConfig(config, record, canaryScope, env);

    // NEVER-LOOSEN at the value level too (DD-6 (2) belt-and-braces): the human bound already
    // clamps; here we additionally assert the canary touched ONLY scope keys and stayed in-bounds.
    assertScopeRespected(before, after, canaryScope, bound);

    // 1) Write the mutated config knob (atomic).
    const configFile = gov.writeSystemConfig(next, env);

    // 2) Write the schema-conformant applied learning record (status=applied + rollback_ref).
    const applied = buildAppliedRecord(record, baselineRef, now);
    gov.writeJson(recFile, applied);

    // 3) Write the governance sidecar (governance_state=canary + observation bookkeeping).
    const sidecar = {
      record_id: record.id,
      governance_state: gov.GOV_STATES.CANARY,
      category: spec.category,
      target_artifact: record.target_artifact,
      config_path: spec.configPath.join('.'),
      baseline_ref: baselineRef,
      canary_scope: canaryScope,
      before, after,
      observe_cycles_required: cfg.canary_cycles,
      observe_cycles_done: 0,
      regression_tolerance: cfg.regression_tolerance,
      applied_at: nowIso(now),
    };
    gov.writeJson(govFile, sidecar);

    // 4) Commit ALL THREE as one versioned change to the instance repo (DD-6 (5)).
    const commit = gov.commitInstance(
      `self-improve: apply ${record.id} (canary) [${spec.category}]`,
      [configFile, recFile, govFile],
      env,
    );

    // 5) Ledger (DD-6 (6) auditable, surfaced by engine status).
    logEvent(env, now, 'self_improve_applied_canary', record, {
      governance_state: gov.GOV_STATES.CANARY,
      category: spec.category,
      baseline_ref: baselineRef,
      commit,
      canary_scope: canaryScope,
      evidence,
    });

    return result(true, 'APPLIED_CANARY',
      `applied ${record.id} in canary scope (${canaryScope.length} key(s)); observe ${cfg.canary_cycles} cycle(s) before promote/rollback`,
      {
        record_id: record.id,
        governance_state: gov.GOV_STATES.CANARY,
        rollback_ref: baselineRef,
        commit,
        canary_scope: canaryScope,
        before, after,
      });
  } catch (err) {
    // Fail-closed: ANY error (including a mutability refusal) ⇒ no change. Surface + ledger it.
    return refuse(record, env, now, err.code || 'REFUSED', err.message, { error: err.name });
  }
}

/** Record a refusal to the ledger (auditable) and return a fail-closed result (ok:false, no change). */
function refuse(record, env, now, code, summary, data) {
  try {
    logEvent(env, now, 'self_improve_refused', record, { code, reason: summary, ...(data || {}) });
  } catch {
    // ledger best-effort; a ledger failure must not itself become a side effect.
  }
  return result(false, code, summary, { record_id: record && record.id, ...(data || {}) });
}

/** Append a loop event to the workflow ledger under the self-improve bucket (DD-6 (6)). */
function logEvent(env, now, eventType, record, data) {
  ledger.recordEvent(SI_LEDGER_ID, eventType, {
    self_improve: {
      last_event: { ts: nowIso(now), event_type: eventType, record_id: record && record.id },
    },
  }, {
    record_id: record && record.id,
    target_artifact: record && record.target_artifact,
    ...(data || {}),
  }, env);
}

/** The schema-conformant applied learning record (learning-record.schema.json status=applied). */
function buildAppliedRecord(record, rollbackRef, now) {
  const out = {
    id: record.id,
    created_at: record.created_at || nowIso(now),
    source_signals: record.source_signals,
    target_artifact: record.target_artifact,
    target_mutability: record.target_mutability,
    proposed_diff: record.proposed_diff,
    status: 'applied',
    applied_by: 'engine:self-improve', // machine application, attributed (DD-6 (6) audit).
    applied_at: nowIso(now),
    rollback_ref: rollbackRef || 'pre-init', // schema requires a string; pre-init repos have no HEAD.
  };
  if (record.shareability === 'candidate-for-upstream') out.shareability = 'candidate-for-upstream';
  return out;
}

/**
 * Deterministic canary slice (DD-6 (4)): take a stable fraction of the proposed keys (sorted, so
 * the slice is reproducible across runs). At least one key when there is any proposed key.
 */
function deterministicSlice(keys, fraction) {
  const sorted = [...keys].sort();
  if (sorted.length === 0) return [];
  const n = Math.max(1, Math.ceil(sorted.length * fraction));
  return sorted.slice(0, n);
}

/**
 * Structural guard: the applied diff must touch ONLY keys in the canary scope, and only by setting
 * values inside the human-set bound (clampMap already enforced it). Any key changed outside scope
 * is a structural violation ⇒ throw (fail-closed). This is the value-level companion to never-loosen.
 */
function assertScopeRespected(before, after, scope, bound) {
  const scopeSet = new Set(scope);
  const beforeKeys = new Set(Object.keys(before || {}));
  const afterKeys = Object.keys(after || {});
  for (const k of afterKeys) {
    const changed = !beforeKeys.has(k) || before[k] !== after[k];
    if (changed && !scopeSet.has(k)) {
      throw new GovernanceError(
        `canary touched key "${k}" outside the declared scope — structural refusal (DD-6 (4))`,
        'CANARY_SCOPE_VIOLATION',
      );
    }
    if (changed) {
      const v = Number(after[k]);
      if (!Number.isFinite(v) || v < bound.min || v > bound.max) {
        throw new GovernanceError(
          `canary value for "${k}" (${after[k]}) is outside the human bound [${bound.min},${bound.max}]`,
          'OUT_OF_BOUND',
        );
      }
    }
  }
  // A canary must never DELETE a human-set key (that would be a silent loosening of intent).
  for (const k of beforeKeys) {
    if (!Object.prototype.hasOwnProperty.call(after, k)) {
      throw new GovernanceError(`canary removed human-set key "${k}" — refused (DD-6 (2))`, 'KEY_REMOVED');
    }
  }
}

/**
 * Build the `change` descriptor the SI-MUTABILITY never-loosen comparator inspects (mutability.js
 * collectTransitions/detectLoosening). A machine-allowed knob is a CONTENT-PREFERENCE dial
 * (calendar weighting / archetype-or-content-type priority) — it has NO gate-strictness axis, so
 * we describe it as a non-gate numeric effect set. detectLoosening only fails closed on the gate
 * axes (severity/disposition/bars_recommended/threshold-numeric/bounds); a pure weighting dial is
 * the `default` (unknown-axis) case and passes. If a record ever carried a gate-axis effect, the
 * guard would refuse it — which is exactly the never-loosen guarantee (DD-6 (2) / §3.1).
 */
function buildMutabilityChange(record) {
  const values = (record.machine_change && record.machine_change.values) || {};
  const effects = Object.entries(values).map(([field, after]) => ({ field, after }));
  // Carry the human bounds envelope so a record that tried to WIDEN bounds is refused (bounds axis).
  const change = { effects };
  if (record.machine_change && record.machine_change.bounds) change.bounds = record.machine_change.bounds;
  return change;
}

module.exports = {
  applyGovernedChange,
  // internals for tests
  buildAppliedRecord,
  deterministicSlice,
  assertScopeRespected,
  buildMutabilityChange,
  SI_LEDGER_ID,
};
