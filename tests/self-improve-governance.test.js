'use strict';

/**
 * tests/self-improve-governance.test.js  [SI-TESTS]
 *
 * THE GOVERNANCE SAFETY-PROPERTY PROOF for the GOVERNED SELF-IMPROVEMENT LOOP — the most
 * safety-critical feature in the engine: the system modifying its own config (release-spec roadmap
 * #3 "governed self-improvement loop"; original-design-spec §2.6 self-improvement; DD-6 "the
 * governance is the whole point"; §8.9 "ships WITH its governance machinery, never before"; §3.1
 * never-loosen; §15.4 kill switch; RD-2 the engine NEVER calls chain LLMs; RD-12 zero-key).
 *
 * This suite does NOT re-unit-test the controllers (engine/self-improve/__tests__/{apply,canary,
 * mutability,evaluate}.test.js already do). It PROVES, end-to-end against the REAL machinery (a real
 * local git rollback substrate, the REAL SI-MUTABILITY guard — no injected stubs), the seven
 * load-bearing DD-6 safety properties the FEATURE LAW enumerates, and that the deterministic governed
 * applier reproduces the hand-verified ground truth in
 * fixtures/self-improve-acme/expected/applier-outcomes.json:
 *
 *   (1) AUTO-APPLY -> CANARY -> PROMOTE on good performance, AND AUTO-ROLLBACK on a regression.
 *   (2) a HUMAN-ONLY-target change is REFUSED (EHUMANONLY) and NEVER written — the guardrail/gate is
 *       never machine-modified.
 *   (3) a GATE-LOOSENING change is REFUSED (ENEVERLOOSEN) — independently of the human-only check
 *       (the fixture (c) case proves a loosening change cannot hide behind an allowed target class).
 *   (4) a BELOW-THRESHOLD record stays PROPOSED (human-applied) — never auto-applied (no write).
 *   (5) `engine rollback` (rollbackLastChange / rollbackRecord / rollbackToBaseline) reverts a
 *       promoted/canary change to the prior version / pinned baseline (one-step, versioned).
 *   (6) OFF BY DEFAULT => no-op (the LAW: governed machine application is disabled unless
 *       self_improve.enabled === true).
 *   (7) the PAUSED kill switch halts the loop MID-FLIGHT (a canary in flight does not advance).
 *
 * Plus: the machine change is AUDITABLE (event-ledger trail) + REVERSIBLE, and the optional analyst
 * seat (RD-2) is PROSE-ONLY and DEGRADES with zero keys (tests/helpers/fake-analyst-seat.js).
 *
 * Zero-key, fully offline: Node's built-in test runner + assert only; a throwaway $CONTENT_HOME with
 * a real local git repo per test; the real mutability guard; injected clock. No network, no
 * credentials, no chain LLM. Git-dependent tests skip cleanly where git is unavailable.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const apply = require('../engine/self-improve/apply.js');
const canary = require('../engine/self-improve/canary.js');
const rollback = require('../engine/self-improve/rollback.js');
const gov = require('../engine/self-improve/_governance.js');
const mutability = require('../engine/self-improve/mutability.js');
const ledger = require('../engine/orchestrator/workflow-ledger.js');
const { makeFakeAnalystSeat } = require('./helpers/fake-analyst-seat.js');

const FIXTURE_DIR = path.join(__dirname, '..', 'fixtures', 'self-improve-acme');

// ---------------------------------------------------------------------------
// Test substrate — a throwaway instance with a real git rollback substrate (DD-6 (5)).
// ---------------------------------------------------------------------------

function gitOk() {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const HAS_GIT = gitOk();
/** Git-dependent test wrapper — skips (does not fail) where git is unavailable. */
const git = HAS_GIT ? test : test.skip;

/**
 * A $CONTENT_HOME seeded with config/system.json (human-set calendar weightings) and a real local
 * git repo with one initial commit — the DD-6 (5) versioned rollback baseline. The self_improve
 * block is supplied by the caller so each test pins its own governance config.
 */
function tmpHome(siConfig) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oce-si-gov-'));
  // Ledger ENABLED so we can assert the audit trail (DD-6 (6)).
  const env = { CONTENT_HOME: home, WORKFLOW_LEDGER_DISABLE: '0' };
  fs.mkdirSync(path.join(home, 'config'), { recursive: true });
  const config = {
    calendar: { weights: { 'slot-a': 0.5, 'slot-b': 0.5, 'slot-c': 0.5 } },
    self_improve: siConfig || { enabled: true },
  };
  fs.writeFileSync(path.join(home, 'config', 'system.json'), `${JSON.stringify(config, null, 2)}\n`);
  execFileSync('git', ['init', '--quiet'], { cwd: home });
  execFileSync('git', ['config', 'user.email', 't@t.local'], { cwd: home });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: home });
  execFileSync('git', ['add', '-A'], { cwd: home });
  execFileSync('git', ['commit', '--quiet', '-m', 'init'], { cwd: home });
  return env;
}

function weights(env) {
  return JSON.parse(fs.readFileSync(path.join(env.CONTENT_HOME, 'config', 'system.json'), 'utf8')).calendar.weights;
}

/** A canonical governance config: loop ON, the fixture's evidence bar + bounds. */
function govConfig(over = {}) {
  return {
    enabled: true,
    evidence: { min_sample_size: 12, min_confidence: 0.8, min_effect_size: 0.2 },
    canary: { observe_cycles: 2, scope_fraction: 1, rollback_on_regression_pct: 0.1 },
    allowlist: {
      targets: ['calendar_weighting', 'archetype_priority', 'content_type_priority', 'tunable_dial'],
      bounds: { max_weight_delta: 0.15, weight_range: { min: 0, max: 1 } },
    },
    ...over,
  };
}

/**
 * A learnable, machine-allowed, well-evidenced learning record that proposes a calendar weighting —
 * the registry shape the REAL applier + REAL mutability guard accept (mirrors fixture record (a)).
 */
function machineAllowedRecord(over = {}) {
  return {
    id: 'lr-a-calweight',
    created_at: '2099-04-08T06:00:00.000Z',
    source_signals: [{ type: 'analytics', count: 20 }],
    target_artifact: 'config:calendar.weights',
    target_mutability: 'learnable',
    proposed_diff: '# bump slot-a calendar weighting (sky-event-alert lane)',
    evidence: { confidence: 0.9, effect_size: 0.5 },
    machine_change: { values: { 'slot-a': 0.65 } },
    ...over,
  };
}

/** The expected-outcomes ground truth the deterministic applier must reproduce. */
function expectedOutcomes() {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'expected', 'applier-outcomes.json'), 'utf8'));
}

// ===========================================================================
// PROPERTY (1) — AUTO-APPLY -> CANARY -> PROMOTE (good performance)
//            and AUTO-APPLY -> CANARY -> AUTO-ROLLBACK (regression)
// ===========================================================================

git('(1a) machine-allowed, above-threshold change auto-applies to a LIMITED canary, then PROMOTES on good performance', () => {
  const env = tmpHome(govConfig({ canary: { observe_cycles: 2, scope_fraction: 1 } }));
  const before = weights(env);

  // APPLY — real mutability guard, real git substrate (no stubs).
  const res = apply.applyGovernedChange(machineAllowedRecord(), { env });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.code, 'APPLIED_CANARY');
  assert.equal(res.data.governance_state, gov.GOV_STATES.CANARY, 'lands in CANARY first (DD-6 (4))');
  assert.ok(res.data.rollback_ref, 'a versioned rollback ref is pinned (DD-6 (5))');
  assert.ok(res.data.commit, 'committed to the instance repo (DD-6 (5))');

  // The canaried knob moved; the OTHER human-set keys are untouched (limited scope).
  assert.equal(weights(env)['slot-a'], 0.65, 'canaried key applied');
  assert.equal(weights(env)['slot-b'], before['slot-b'], 'out-of-scope human key preserved');
  assert.equal(weights(env)['slot-c'], before['slot-c'], 'out-of-scope human key preserved');

  // The applied learning record is schema-conformant + reversible.
  const applied = JSON.parse(fs.readFileSync(gov.recordPath('lr-a-calweight', env), 'utf8'));
  assert.equal(applied.status, 'applied');
  assert.ok(applied.rollback_ref && applied.applied_by && applied.applied_at);

  // OBSERVE the canary for the required cycles against a healthy baseline (value >= baseline).
  const healthy = { value: 120, baseline: 100, basis: 'test' };
  const c1 = canary.runCanaryCycle({ env, recordId: 'lr-a-calweight', observation: healthy });
  assert.equal(c1.code, 'OBSERVED', 'first clean cycle holds the canary');
  const c2 = canary.runCanaryCycle({ env, recordId: 'lr-a-calweight', observation: healthy });
  assert.equal(c2.code, 'PROMOTED', 'required clean cycles met => PROMOTE');

  const sidecar = JSON.parse(fs.readFileSync(gov.governancePath('lr-a-calweight', env), 'utf8'));
  assert.equal(sidecar.governance_state, gov.GOV_STATES.PROMOTED);
  assert.equal(weights(env)['slot-a'], 0.65, 'the promoted change is KEPT');
});

git('(1b) a canary that REGRESSES below the tolerance band AUTO-ROLLS-BACK and reverts the knob to baseline', () => {
  const env = tmpHome(govConfig({ canary: { observe_cycles: 3, scope_fraction: 1, rollback_on_regression_pct: 0.1 } }));
  const baselineWeight = weights(env)['slot-a'];

  apply.applyGovernedChange(machineAllowedRecord(), { env });
  assert.equal(weights(env)['slot-a'], 0.65, 'change is live in canary');

  // value 80 < baseline 100 * (1 - 0.1) = 90 => regression at the FIRST cycle (not given more rope).
  const reg = canary.runCanaryCycle({ env, recordId: 'lr-a-calweight', observation: { value: 80, baseline: 100 } });
  assert.equal(reg.code, 'AUTO_ROLLED_BACK', 'a regressing canary is auto-rolled-back (DD-6 (4), fail-closed)');

  const sidecar = JSON.parse(fs.readFileSync(gov.governancePath('lr-a-calweight', env), 'utf8'));
  assert.equal(sidecar.governance_state, gov.GOV_STATES.ROLLED_BACK);
  assert.equal(weights(env)['slot-a'], baselineWeight, 'the knob is reverted to the pre-change baseline value');

  const applied = JSON.parse(fs.readFileSync(gov.recordPath('lr-a-calweight', env), 'utf8'));
  assert.equal(applied.status, 'rolled_back');
});

git('(1) the canary slice is LIMITED — only the scoped key moves even when more keys are proposed (DD-6 (4))', () => {
  // scope_fraction 0.5 of the 2 proposed keys (sorted) => 1 key only: slot-a.
  const env = tmpHome(govConfig({ canary: { observe_cycles: 1, scope_fraction: 0.5 } }));
  const res = apply.applyGovernedChange(
    machineAllowedRecord({ machine_change: { values: { 'slot-a': 0.7, 'slot-b': 0.7 } } }),
    { env },
  );
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(res.data.canary_scope, ['slot-a'], 'only a deterministic slice is canaried');
  assert.equal(weights(env)['slot-a'], 0.7, 'scoped key applied');
  assert.equal(weights(env)['slot-b'], 0.5, 'out-of-scope proposed key NOT applied in the canary');
});

// ===========================================================================
// PROPERTY (2) — HUMAN-ONLY target is REFUSED (EHUMANONLY), never written
// ===========================================================================

git('(2) a record targeting a HUMAN-ONLY / guardrail artifact is REFUSED and nothing is written or committed', () => {
  const env = tmpHome(govConfig());
  const headBefore = gov.headRef(env);
  const guardrailWeights = weights(env);

  // A guardrail/safety rule target (fixture (b) shape): not a machine-allowed knob.
  const res = apply.applyGovernedChange(
    machineAllowedRecord({
      id: 'lr-b-humanonly',
      target_artifact: 'rules/core/claims-safety.md',
      target_mutability: 'human-only',
      machine_change: { values: { severity: 0 } },
    }),
    { env }, // REAL guard
  );
  assert.equal(res.ok, false);
  // The applier's defence-in-depth refuses a non-registry target before the guard even runs.
  assert.ok(['TARGET_NOT_MACHINE_ALLOWED', 'HUMAN_ONLY', 'EHUMANONLY'].includes(res.code),
    `expected a human-only refusal code, got ${res.code}`);

  // STRUCTURAL: no config mutation, no applied record, no governance sidecar, no new commit.
  assert.deepEqual(weights(env), guardrailWeights, 'the guardrail/gate config is NEVER machine-modified');
  assert.equal(fs.existsSync(gov.recordPath('lr-b-humanonly', env)), false, 'no applied learning record written');
  assert.equal(fs.existsSync(gov.governancePath('lr-b-humanonly', env)), false, 'no governance sidecar written');
  assert.equal(gov.headRef(env), headBefore, 'HEAD did not advance — no commit was made');
});

git('(2) the REAL mutability guard throws EHUMANONLY for a gate/guardrail target (structural refusal #1)', () => {
  // The guard is the structural boundary the applier delegates to. Proven directly with the real module.
  assert.throws(
    () => mutability.assertMachineChangeAllowed({ kind: 'config', path: 'gate.thresholds.hard' }, {}),
    (e) => e.code === 'EHUMANONLY',
  );
  assert.throws(
    () => mutability.assertMachineChangeAllowed(
      { kind: 'rule', rule_frontmatter: { id: 'claims-safety', mutability: 'human-only', category: 'safety' } }, {},
    ),
    (e) => e.code === 'EHUMANONLY',
  );
});

git('(2) even a learnable mutability label + overwhelming evidence cannot rescue a human-only target', () => {
  const env = tmpHome(govConfig());
  const res = apply.applyGovernedChange(
    machineAllowedRecord({
      id: 'lr-sneaky',
      target_artifact: 'rules/core/claims-safety.md',
      target_mutability: 'learnable', // mislabeled — must still be refused
      source_signals: [{ type: 'analytics', count: 99999 }],
      evidence: { confidence: 1, effect_size: 5 },
    }),
    { env },
  );
  assert.equal(res.ok, false);
  assert.equal(res.code, 'TARGET_NOT_MACHINE_ALLOWED', 'a non-knob target is refused regardless of evidence/label');
});

// ===========================================================================
// PROPERTY (3) — GATE-LOOSENING change is REFUSED (ENEVERLOOSEN)
// ===========================================================================

git('(3) a change whose EFFECT loosens a gate is REFUSED with ENEVERLOOSEN even on an allowlisted target', () => {
  const env = tmpHome(govConfig());
  const before = weights(env);
  const headBefore = gov.headRef(env);

  // Fixture (c) shape: the target_artifact is an ALLOWED registry knob (clears the human-only check),
  // but the machine_change smuggles a gate-loosening effect (widening the human-set bounds envelope).
  // The never-loosen invariant must refuse it INDEPENDENTLY of the human-only allowlist check.
  const res = apply.applyGovernedChange(
    machineAllowedRecord({
      id: 'lr-c-neverloosen',
      target_artifact: 'config:calendar.weights', // allowlisted => passes EHUMANONLY
      machine_change: {
        values: { 'slot-a': 0.6 },
        bounds: { before: { min: 0, max: 1 }, after: { min: 0, max: 3 } }, // widening = loosening
      },
    }),
    { env }, // REAL guard
  );
  assert.equal(res.ok, false);
  assert.equal(res.code, 'ENEVERLOOSEN', 'a gate-loosening change is structurally refused (§3.1)');

  // STRUCTURAL: no mutation, no record, no commit.
  assert.deepEqual(weights(env), before, 'no gate/bound was loosened');
  assert.equal(fs.existsSync(gov.recordPath('lr-c-neverloosen', env)), false);
  assert.equal(gov.headRef(env), headBefore, 'no commit was made');
});

git('(3) never-loosen fires INDEPENDENTLY of the human-only check — a loosening change cannot hide behind an allowed target class', () => {
  // The fixture (c) lesson, proven on the guard directly: an allowlisted machine-changeable target
  // (clears assertMachineChangeAllowed) whose effect loosens a gate axis still throws ENEVERLOOSEN.
  const allowedTarget = { kind: 'tunable-dial', machine_tunable: true, bounds: { min: 0, max: 1 } };
  assert.equal(mutability.isMachineChangeable(allowedTarget), true, 'target itself is allowlisted');
  assert.doesNotThrow(() => mutability.assertMachineChangeAllowed(allowedTarget, {}), 'passes human-only check');

  for (const loosening of [
    { severity: { before: 'hard', after: 'soft' } },
    { disposition: { before: 'block', after: 'warn' } },
    { bars_recommended: { before: true, after: false } },
    { numeric: { field: 'jaccard_threshold', before: 0.45, after: 0.80, direction: 'lower-is-stricter' } },
    { bounds: { before: { min: 0, max: 1 }, after: { min: 0, max: 3 } } },
  ]) {
    assert.throws(
      () => mutability.assertNotGateLoosening(allowedTarget, loosening),
      (e) => e.code === 'ENEVERLOOSEN',
      `loosening ${JSON.stringify(loosening)} must be refused`,
    );
  }
});

// ===========================================================================
// PROPERTY (4) — BELOW-THRESHOLD record stays PROPOSED, never auto-applied
// ===========================================================================

git('(4) a below-threshold record is held PROPOSED (human-applied) — never auto-applied, nothing written', () => {
  const env = tmpHome(govConfig());
  const before = weights(env);
  const headBefore = gov.headRef(env);

  // Fixture (d) shape: machine-allowed + gate-neutral, but thin evidence (n=4 < 12, effect 0.06 < 0.2).
  const res = apply.applyGovernedChange(
    machineAllowedRecord({
      id: 'lr-d-belowthreshold',
      source_signals: [{ type: 'analytics', count: 4 }],
      evidence: { confidence: 0.41, effect_size: 0.06 },
      machine_change: { values: { 'slot-a': 0.55 } },
    }),
    { env },
  );
  assert.equal(res.ok, false);
  assert.equal(res.code, 'BELOW_EVIDENCE_THRESHOLD', 'thin evidence stays PROPOSED (DD-6 (3))');

  // Stays proposed-only: no config mutation, no applied record, no commit. (A human may still apply it.)
  assert.deepEqual(weights(env), before, 'no change on thin evidence');
  assert.equal(fs.existsSync(gov.recordPath('lr-d-belowthreshold', env)), false, 'never auto-applied');
  assert.equal(gov.headRef(env), headBefore, 'no commit was made');
});

git('(4) a record that misses the evidence bar on confidence alone is also held PROPOSED (fail-closed)', () => {
  const env = tmpHome(govConfig());
  const res = apply.applyGovernedChange(
    machineAllowedRecord({ evidence: { effect_size: 0.5 } }), // confidence absent
    { env },
  );
  assert.equal(res.ok, false);
  assert.equal(res.code, 'BELOW_EVIDENCE_THRESHOLD');
});

// ===========================================================================
// PROPERTY (5) — `engine rollback` reverts a promoted/canary change one-step
// ===========================================================================

git('(5) engine rollback (rollbackLastChange) reverts a PROMOTED change to the prior version', () => {
  const env = tmpHome(govConfig({ canary: { observe_cycles: 1, scope_fraction: 1 } }));
  const baselineWeight = weights(env)['slot-a'];

  apply.applyGovernedChange(machineAllowedRecord(), { env });
  canary.runCanaryCycle({ env, recordId: 'lr-a-calweight', observation: { value: 110, baseline: 100 } });
  assert.equal(
    JSON.parse(fs.readFileSync(gov.governancePath('lr-a-calweight', env), 'utf8')).governance_state,
    gov.GOV_STATES.PROMOTED,
  );
  assert.equal(weights(env)['slot-a'], 0.65, 'promoted change is live');

  const rb = rollback.rollbackLastChange({ env });
  assert.equal(rb.ok, true);
  assert.equal(rb.code, 'ROLLED_BACK');
  assert.equal(weights(env)['slot-a'], baselineWeight, 'one-step rollback reverted the promoted change');
  assert.equal(
    JSON.parse(fs.readFileSync(gov.recordPath('lr-a-calweight', env), 'utf8')).status,
    'rolled_back',
  );
});

git('(5) engine rollback reverts a still-in-CANARY change (one-step, before promotion)', () => {
  const env = tmpHome(govConfig({ canary: { observe_cycles: 5, scope_fraction: 1 } }));
  const baselineWeight = weights(env)['slot-a'];
  apply.applyGovernedChange(machineAllowedRecord(), { env });
  // observe one healthy cycle but do not promote (5 required) — still canary.
  canary.runCanaryCycle({ env, recordId: 'lr-a-calweight', observation: { value: 100, baseline: 100 } });
  assert.equal(weights(env)['slot-a'], 0.65);

  const rb = rollback.rollbackRecord('lr-a-calweight', { env });
  assert.equal(rb.ok, true);
  assert.equal(rb.code, 'ROLLED_BACK');
  assert.equal(weights(env)['slot-a'], baselineWeight, 'canaried change reverted to baseline');
});

git('(5) rollbackToBaseline reverts config to a PINNED known-good baseline ref', () => {
  const env = tmpHome(govConfig({ canary: { observe_cycles: 2, scope_fraction: 1 } }));
  const pinned = gov.headRef(env); // pin the known-good baseline before any change.
  const baselineWeight = weights(env)['slot-a'];

  apply.applyGovernedChange(machineAllowedRecord(), { env });
  assert.equal(weights(env)['slot-a'], 0.65);

  const res = rollback.rollbackToBaseline(pinned, { env });
  assert.equal(res.ok, true);
  assert.equal(res.code, 'ROLLED_BACK_TO_BASELINE');
  assert.equal(weights(env)['slot-a'], baselineWeight, 'config reverted to the pinned baseline');
  assert.ok(res.data.records.includes('lr-a-calweight'), 'the record is marked rolled_back');
});

git('(5) rollback is IDEMPOTENT — rolling back an already-rolled-back record is a no-op-plus-report', () => {
  const env = tmpHome(govConfig());
  apply.applyGovernedChange(machineAllowedRecord(), { env });
  rollback.rollbackRecord('lr-a-calweight', { env });
  const again = rollback.rollbackRecord('lr-a-calweight', { env });
  assert.equal(again.ok, true);
  assert.equal(again.code, 'ALREADY_ROLLED_BACK');
});

// ===========================================================================
// PROPERTY (6) — OFF BY DEFAULT => no-op (the LAW)
// ===========================================================================

git('(6) the loop is OFF by default — an absent self_improve.enabled is a no-op (no change, fail-closed)', () => {
  // No enabled flag at all.
  const env = tmpHome({ allowlist: { targets: ['calendar_weighting'] } });
  const before = weights(env);
  const res = apply.applyGovernedChange(machineAllowedRecord(), { env });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'DISABLED');
  assert.deepEqual(weights(env), before, 'a disabled loop never touches config');
  assert.equal(fs.existsSync(gov.recordPath('lr-a-calweight', env)), false);
});

git('(6) only a STRICT boolean true enables — a truthy non-true value stays disabled (fail-closed)', () => {
  const env = tmpHome({ enabled: 'yes' });
  const res = apply.applyGovernedChange(machineAllowedRecord(), { env });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'DISABLED');
});

git('(6) a disabled loop also refuses to advance canaries', () => {
  // Apply with the loop ON, then flip it OFF and try to advance — the canary must not move.
  const env = tmpHome(govConfig({ canary: { observe_cycles: 2, scope_fraction: 1 } }));
  apply.applyGovernedChange(machineAllowedRecord(), { env });
  // Flip the config to disabled.
  const cfgFile = path.join(env.CONTENT_HOME, 'config', 'system.json');
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  cfg.self_improve.enabled = false;
  fs.writeFileSync(cfgFile, `${JSON.stringify(cfg, null, 2)}\n`);

  const res = canary.runCanaryCycle({ env, recordId: 'lr-a-calweight', observation: { value: 100, baseline: 100 } });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'DISABLED');
  assert.equal(
    JSON.parse(fs.readFileSync(gov.governancePath('lr-a-calweight', env), 'utf8')).governance_state,
    gov.GOV_STATES.CANARY,
    'the canary did not advance while disabled',
  );
});

// ===========================================================================
// PROPERTY (7) — PAUSED kill switch halts the loop MID-FLIGHT
// ===========================================================================

git('(7) the PAUSED kill switch halts a fresh apply (§15.4)', () => {
  const env = tmpHome(govConfig());
  fs.writeFileSync(path.join(env.CONTENT_HOME, 'PAUSED'), '{}');
  const before = weights(env);
  const res = apply.applyGovernedChange(machineAllowedRecord(), { env });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'PAUSED');
  assert.deepEqual(weights(env), before, 'a paused loop never applies');
});

git('(7) the PAUSED kill switch halts an in-flight canary MID-FLIGHT (the change is held, not promoted)', () => {
  const env = tmpHome(govConfig({ canary: { observe_cycles: 2, scope_fraction: 1 } }));
  apply.applyGovernedChange(machineAllowedRecord(), { env });

  // Engage the kill switch between apply and the next observation cycle.
  fs.writeFileSync(path.join(env.CONTENT_HOME, 'PAUSED'), '{}');
  const res = canary.runCanaryCycle({ env, recordId: 'lr-a-calweight', observation: { value: 100, baseline: 100 } });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'PAUSED');

  // The canary is HELD in place — not advanced, not promoted, not rolled back.
  const sidecar = JSON.parse(fs.readFileSync(gov.governancePath('lr-a-calweight', env), 'utf8'));
  assert.equal(sidecar.governance_state, gov.GOV_STATES.CANARY, 'canary frozen mid-flight by the kill switch');
  assert.equal(Number(sidecar.observe_cycles_done) || 0, 0, 'no observation cycle was recorded while paused');
});

git('(7) isPaused fails CLOSED (treats the loop as halted) when the sentinel path cannot be resolved', () => {
  // No CONTENT_HOME => cannot resolve the sentinel => paused (fail-closed, §15.4).
  assert.equal(gov.isPaused({}), true);
});

// ===========================================================================
// AUDITABILITY + REVERSIBILITY (DD-6 (6)) — every machine change is ledgered
// ===========================================================================

git('audit: apply -> promote -> rollback each emit a self-improve event to the ledger (DD-6 (6))', () => {
  const env = tmpHome(govConfig({ canary: { observe_cycles: 1, scope_fraction: 1 } }));
  apply.applyGovernedChange(machineAllowedRecord(), { env });
  canary.runCanaryCycle({ env, recordId: 'lr-a-calweight', observation: { value: 110, baseline: 100 } });
  rollback.rollbackRecord('lr-a-calweight', { env });

  const types = ledger.readEvents('self-improve', env).map((e) => e.event_type);
  assert.ok(types.includes('self_improve_applied_canary'), 'apply ledgered');
  assert.ok(types.includes('self_improve_promoted'), 'promote ledgered');
  assert.ok(types.includes('self_improve_rolled_back'), 'rollback ledgered');
});

git('audit: a REFUSAL (human-only / never-loosen / below-threshold) is also ledgered as auditable', () => {
  const env = tmpHome(govConfig());
  apply.applyGovernedChange(
    machineAllowedRecord({ id: 'lr-refused', target_artifact: 'rules/core/claims-safety.md', target_mutability: 'human-only' }),
    { env },
  );
  const refusals = ledger.readEvents('self-improve', env).filter((e) => e.event_type === 'self_improve_refused');
  assert.ok(refusals.length >= 1, 'the refusal is recorded in the event ledger for audit');
});

// ===========================================================================
// GROUND-TRUTH REPLAY — the deterministic applier reproduces applier-outcomes.json
// ===========================================================================

/**
 * Map a fixture record's documented (decision, code) onto the controller it must reproduce. The
 * fixture records use instance-flavored target_artifact ids (calendar_weighting:.../rules/...); we
 * exercise the SAME governance decision with the REAL machinery using the canonical registry shapes,
 * so the proven decision/code equals the hand-verified ground truth in applier-outcomes.json.
 */
git('ground-truth: the deterministic applier reproduces the decision + code for every fixture record', () => {
  const gt = expectedOutcomes();
  const byLabel = Object.fromEntries(gt.records.map((r) => [r.target_class || r.record, r]));

  // (a) MACHINE-ALLOWED, above threshold => auto_apply_canary / OK (canary applied).
  {
    const expected = gt.records.find((r) => r.code === 'OK');
    assert.ok(expected, 'fixture (a) present');
    // The fixture documents scope_fraction 0.25, observe_cycles 2 (system.self-improve.json).
    const env = tmpHome(govConfig({ canary: { scope_fraction: 0.25, observe_cycles: 2 } }));
    const res = apply.applyGovernedChange(machineAllowedRecord({ id: 'gt-a' }), { env });
    assert.equal(res.ok, true);
    assert.equal(res.code, 'APPLIED_CANARY', 'fixture (a): auto-apply to canary');
    assert.equal(res.data.governance_state, gov.GOV_STATES.CANARY);
    assert.equal(expected.expected_canary, true);
    assert.equal(expected.expected_reversible, true);
    // reversible: one-step rollback returns it.
    const rb = rollback.rollbackRecord('gt-a', { env });
    assert.equal(rb.ok, true);
  }

  // (b) HUMAN-ONLY target => refuse / EHUMANONLY (proven on the guard, the structural authority).
  {
    const expected = gt.records.find((r) => r.code === 'EHUMANONLY');
    assert.ok(expected, 'fixture (b) present');
    assert.throws(
      () => mutability.assertMachineChangeAllowed(
        { kind: 'rule', rule_frontmatter: { id: 'claims-safety', mutability: 'human-only', category: 'safety', severity: 'hard' } },
        { disposition: { before: 'block', after: 'warn' } },
      ),
      (e) => e.code === expected.code,
    );
    assert.equal(expected.expected_canary, false);
  }

  // (c) GATE-LOOSENING => refuse / ENEVERLOOSEN (allowlisted target, loosening effect).
  {
    const expected = gt.records.find((r) => r.code === 'ENEVERLOOSEN');
    assert.ok(expected, 'fixture (c) present');
    const env = tmpHome(govConfig());
    const res = apply.applyGovernedChange(
      machineAllowedRecord({
        id: 'gt-c',
        target_artifact: 'config:calendar.weights', // allowlisted (clears EHUMANONLY)
        machine_change: { values: { 'slot-a': 0.6 }, bounds: { before: { min: 0, max: 1 }, after: { min: 0, max: 3 } } },
      }),
      { env },
    );
    assert.equal(res.ok, false);
    assert.equal(res.code, expected.code, 'fixture (c): never-loosen refusal');
    assert.equal(expected.expected_canary, false);
  }

  // (d) BELOW threshold => hold_proposed / EBELOWTHRESHOLD (the applier reports BELOW_EVIDENCE_THRESHOLD).
  {
    const expected = gt.records.find((r) => r.code === 'EBELOWTHRESHOLD');
    assert.ok(expected, 'fixture (d) present');
    const env = tmpHome(govConfig());
    const res = apply.applyGovernedChange(
      machineAllowedRecord({ id: 'gt-d', source_signals: [{ type: 'analytics', count: 4 }], evidence: { confidence: 0.41, effect_size: 0.06 } }),
      { env },
    );
    assert.equal(res.ok, false);
    assert.match(res.code, /BELOW_EVIDENCE_THRESHOLD|EBELOWTHRESHOLD/, 'fixture (d): below-threshold hold');
    assert.equal(expected.expected_canary, false);
    assert.equal(fs.existsSync(gov.recordPath('gt-d', env)), false, 'never auto-applied');
  }
});

git('ground-truth: the PAUSED kill switch overrides EVERY record — even the auto-applicable (a) is held (EPAUSED)', () => {
  const gt = expectedOutcomes();
  assert.equal(gt.kill_switch.when_paused_code_for_all, 'EPAUSED');
  const env = tmpHome(govConfig());
  fs.writeFileSync(path.join(env.CONTENT_HOME, 'PAUSED'), '{}');
  // The auto-applicable (a) record is held when paused.
  const res = apply.applyGovernedChange(machineAllowedRecord({ id: 'gt-a-paused' }), { env });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'PAUSED', 'the kill switch holds even the strongest record');
  assert.equal(fs.existsSync(gov.recordPath('gt-a-paused', env)), false);
});

// ===========================================================================
// RD-2 — the optional analyst seat is PROSE-ONLY and DEGRADES (zero-key)
// ===========================================================================

test('RD-2: the fake analyst seat is zero-spend, requires no key, and replays canned refinements', () => {
  const seat = makeFakeAnalystSeat();
  const caps = seat.capabilities();
  assert.equal(caps.requires_key, false, 'no key required (zero-key, RD-12)');
  const est = seat.estimate({ proposals_count: 4 });
  assert.equal(est.est_cost_usd, 0, 'zero spend (RD-12)');
});

test('RD-2: the analyst seat REFINES prose only — it cannot widen the machine surface or lower a threshold', async () => {
  const seat = makeFakeAnalystSeat();
  // (a) gets a within-bounds refinement; (b)/(c) get a refusal-flag note with no diff.
  const a = await seat.refine({ record: { id: 'lr-2099-04-08-a-calweight' } });
  assert.ok(a && typeof a.rationale === 'string' && a.refined_diff, 'auto-applicable record gets advisory prose + within-bounds diff');
  const b = await seat.refine({ record: { id: 'lr-2099-04-08-b-humanonly' } });
  assert.equal(b.refined_diff, null, 'the seat does NOT endorse a human-only guardrail change');
  const c = await seat.refine({ record: { id: 'lr-2099-04-08-c-neverloosen' } });
  assert.equal(c.refined_diff, null, 'the seat does NOT endorse a gate-loosening change');
});

test('RD-2: the seat DEGRADES gracefully when a refinement is missing (no-seat path => null)', async () => {
  const degrading = makeFakeAnalystSeat({ onMissing: 'null' });
  const out = await degrading.refine({ record: { id: 'no-such-record' } });
  assert.equal(out, null, 'an absent refinement degrades to null — the deterministic proposal is used as-is');

  // The default (strict) seat THROWS on an unrecorded id (an unrecorded id is a test bug, not a silent pass).
  const strict = makeFakeAnalystSeat();
  await assert.rejects(() => strict.refine({ record: { id: 'no-such-record' } }), /no recorded refinement/);
});

// ===========================================================================
// IDEMPOTENCE + DETERMINISM (RD-12) — the governed applier is reproducible
// ===========================================================================

git('determinism: re-applying an already-applied record is an idempotent no-op-plus-report', () => {
  const env = tmpHome(govConfig());
  const r1 = apply.applyGovernedChange(machineAllowedRecord(), { env });
  assert.equal(r1.ok, true);
  const headAfterFirst = gov.headRef(env);
  const r2 = apply.applyGovernedChange(machineAllowedRecord(), { env });
  assert.equal(r2.ok, true);
  assert.equal(r2.code, 'ALREADY_APPLIED');
  assert.equal(r2.data.idempotent, true);
  assert.equal(gov.headRef(env), headAfterFirst, 'no second commit on idempotent re-apply');
});

git('determinism: the same record + config produces the same canary decision + weight across runs (RD-12)', () => {
  const run = () => {
    const env = tmpHome(govConfig({ canary: { observe_cycles: 1, scope_fraction: 1 } }));
    const res = apply.applyGovernedChange(machineAllowedRecord(), { env, now: 1_700_000_000_000 });
    return { code: res.code, scope: res.data.canary_scope, weight: weights(env)['slot-a'] };
  };
  assert.deepEqual(run(), run(), 'deterministic in (record, config): same code, scope, applied weight');
});
