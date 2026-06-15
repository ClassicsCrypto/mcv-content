'use strict';

/**
 * engine/cli/improve.js  [N net-new]  — batch SI-CLI
 *
 * `engine improve` + `engine rollback` — the thin CLI surface over the GOVERNED self-improvement
 * loop (release-spec roadmap #3 "Governed self-improvement loop — machine-applied Learning Records
 * with DD-6 machinery"; original-design-spec §2.6 self-improvement; §8.9 "ships WITH its governance
 * machinery, never before"; DD-6 the autonomy trust boundary; §15.4 kill switch; §3.1 never-loosen;
 * §13.1 status surface; RD-2/RD-12 deterministic zero-key engine code). Per DD-1(c) the CLI is the
 * thin runner: this file owns ONLY arg parsing + wiring + the result envelope; every decision lives
 * in the already-on-disk engine/self-improve modules (it wires, never re-implements).
 *
 * `engine improve` runs ONE governed loop pass:
 *   1. evaluate — derive deterministic, classified learning-record PROPOSALS from the analytics
 *      (engine/self-improve/evaluate.evaluateForImprovement over a performance report — built on
 *      demand via analytics/engagement/performance-report.buildWeeklyReport, or injected for tests).
 *      Each proposal is classified auto-applicable vs proposed-only vs structurally refused
 *      (human-only / never-loosen) against the configured evidence bar.
 *   2. for each AUTO-APPLICABLE record: applyGovernedChange — apply in a LIMITED CANARY scope
 *      (engine/self-improve/apply), then advance the canary (engine/self-improve/canary.runCanaryCycle)
 *      observe -> promote/auto-rollback. A REFUSED change (EHUMANONLY / ENEVERLOOSEN) is reported,
 *      never applied; a below-threshold record stays PROPOSED (the v1 human-applied behavior).
 *
 * SAFE BY DEFAULT (the LAW): `--dry-run` is the DEFAULT — it shows the proposed changes + their
 * governance classification and applies NOTHING. `--apply` performs governed application. Even with
 * `--apply`, the whole loop is OFF unless config.self_improve.enabled === true (DD-6 (6)) and is
 * halted by the PAUSED kill switch (§15.4); both refusals are surfaced honestly, never as errors.
 *
 * `engine rollback` reverts a machine change (DD-6 (5) one-step rollback): `--last` reverts the most
 * recent non-terminal change; `--to-baseline <ref>` reverts the touched config knob(s) to a pinned
 * known-good baseline; `--record <id>` reverts one named record. Every revert is itself a versioned,
 * auditable instance-repo commit (engine/self-improve/rollback). Surfaced by `engine status`.
 *
 * Honest exit codes (mirrors bin/engine.js §): 0 a clean pass (including a correctly-refused or
 * off-by-default/paused no-op — the system behaving correctly, surfaced honestly); 1 a verb-level
 * failure (an apply that errored, a rollback that could not complete); 2 a usage error (bad flag).
 *
 * Tier-3 cleanliness (§0.3 r6 / RD-3): constructs no instance paths (paths.js derives them via the
 * engine modules), hardcodes no ids/handles/roots/codenames; the only literals are public knob/flag
 * names and the §4.5 governance vocabulary.
 */

const evaluateMod = require('../self-improve/evaluate');
const applyMod = require('../self-improve/apply');
const canaryMod = require('../self-improve/canary');
const rollbackMod = require('../self-improve/rollback');
const performanceReport = require('../analytics/engagement/performance-report');
const util = require('./util');

const IMPROVE_HELP = `engine improve [options]

Run ONE pass of the GOVERNED self-improvement loop (DD-6 / §8.9): derive classified learning-record
proposals deterministically from the analytics, then — for each AUTO-APPLICABLE record — apply it in
a LIMITED canary scope, observe, and promote or auto-rollback. The whole loop is OFF by default
(config.self_improve.enabled) and halts under the PAUSED kill switch (§15.4). Structural refusals
(human-only / never-loosen) are reported, never applied.

  --dry-run        show proposals + their governance classification, apply NOTHING (THE DEFAULT).
  --apply          perform governed machine application (canary -> observe -> promote/rollback).
  --brand <id>     scope the performance report the proposals derive from to one brand.
  --json           emit the structured result.
  -h, --help       show this help.

Safety: --dry-run is the default; you must pass --apply to change anything. Even then, a machine
change can only ever touch the allowlisted knobs (calendar weightings, archetype/content-type
priority, bounded dials), never a guardrail/gate/human-only rule (EHUMANONLY), and never in a
gate-loosening direction (ENEVERLOOSEN). Every applied change is reversible via "engine rollback".`;

const ROLLBACK_HELP = `engine rollback [options]

Revert a governed machine change (DD-6 (5) one-step rollback). Every revert is itself a versioned,
auditable commit to the instance repo and is surfaced by "engine status".

  --last               revert the MOST RECENT non-terminal machine change (THE DEFAULT one-step).
  --to-baseline <ref>  revert the touched config knob(s) to a pinned known-good baseline commit ref.
  --record <id>        revert one named learning record.
  --reason "<text>"    optional reason recorded with the rollback.
  --json               emit the structured result.
  -h, --help           show this help.

With no target flag, --last is assumed. Honors the same OFF-by-default + PAUSED guards as the rest
of the loop only insofar as they gate APPLICATION; a rollback is a SAFETY action and always runs
when an instance git repo is present (a paused/disabled loop can still be rolled back).`;

// ---------------------------------------------------------------------------
// engine improve
// ---------------------------------------------------------------------------

/**
 * @param {object} ctx  { flags, env, config?, report?, analystSeat?, now? }
 *   - config        injected system config (default loaded from $CONTENT_HOME via util).
 *   - report        injected performance-report object (default built on demand); zero-key tests
 *                   pass a synthetic report so no analytics corpus is required.
 *   - analystSeat   optional host analyst seat passed through to evaluate (RD-2: it may only refine
 *                   proposal prose; the engine re-checks every seat output against the allowlist).
 *   - now           injected clock (ms) for deterministic record timestamps + canary bookkeeping.
 * @returns {{ ok, summary, detail?, data?, exitCode? }}
 */
async function run(ctx = {}) {
  const flags = ctx.flags || {};
  if (util.flagOn(flags.help)) return { ok: true, summary: IMPROVE_HELP.split('\n')[0], detail: IMPROVE_HELP };

  const env = ctx.env || process.env;
  const config = ctx.config || util.loadSystemConfig(env);
  const now = typeof ctx.now === 'number' ? ctx.now : undefined;
  const brand = typeof flags.brand === 'string' ? flags.brand : undefined;

  // SAFE default: --dry-run is the default; --apply must be explicit to change anything.
  const doApply = util.flagOn(flags.apply);
  const dryRun = !doApply; // an explicit --dry-run is redundant-but-honored; absence of --apply ⇒ dry.

  // GATE 0/1 surfaced honestly BEFORE doing analytics work: OFF-by-default + kill switch (DD-6 (6)).
  if (!evaluateMod.loopEnabled(config)) {
    return offByDefault(dryRun);
  }
  if (evaluateMod.isPaused(env)) {
    return paused(dryRun);
  }

  // Step 1 — derive + classify proposals deterministically (RD-2). The report is the analytics input
  // the proposer reads; build it on demand unless one is injected (zero-key tests inject a report).
  let report = ctx.report;
  let reportError = null;
  if (report === undefined) {
    try {
      report = performanceReport.buildWeeklyReport({ env, now, brand, write: false }).report;
    } catch (err) {
      // A missing analytics corpus is not an error — there is simply nothing to learn from yet.
      reportError = util.describeError(err);
      report = null;
    }
  }

  let evalResult;
  try {
    evalResult = evaluateMod.evaluateForImprovement({
      env,
      config,
      report: report || undefined,
      now,
      analystSeat: ctx.analystSeat,
      // In dry-run we still WRITE the proposed records (they are the v1 human-applied artifact and
      // carry no machine change); the apply step is what --apply gates. A caller that wants a pure
      // no-write preview can pass ctx.write === false.
      write: ctx.write !== false,
    });
  } catch (err) {
    return { ok: false, exitCode: 1, summary: 'improve: evaluation failed', detail: util.describeError(err) };
  }

  if (!evalResult.ran) {
    // Disabled/paused already handled above; any other not-ran reason is surfaced as a clean no-op.
    return {
      ok: true,
      exitCode: 0,
      summary: `improve: no pass (${evalResult.reason || 'nothing to evaluate'})`,
      detail: [reportError ? `analytics: ${reportError}` : null, evalResult.reason || null].filter(Boolean),
      data: { ran: false, mode: dryRun ? 'dry-run' : 'apply', reason: evalResult.reason || null, ...emptyData() },
    };
  }

  const proposals = evalResult.proposals || [];
  const classified = proposals.map(classifyForCli);

  // Step 2 — apply (only with --apply). In dry-run we stop here: show what WOULD happen.
  const applied = [];
  if (doApply) {
    for (const p of proposals) {
      if (!p.record || !p.auto_applicable) continue; // only auto-applicable records are machine-applied.
      applied.push(await applyOne(p.record, { env, now }));
    }
  }

  return summarize({ dryRun, evalResult, classified, applied, reportError, brand });
}

/**
 * Apply one auto-applicable record under governance, then advance its canary one cycle
 * (observe -> promote/auto-rollback). A structural refusal (EHUMANONLY/ENEVERLOOSEN) or a
 * below-threshold/disabled/paused outcome is reported, never applied — applyGovernedChange is
 * fail-closed and returns the refusal envelope rather than throwing.
 */
async function applyOne(record, { env, now }) {
  const applyRes = applyMod.applyGovernedChange(record, { env, now });
  const out = {
    record_id: record.id,
    target_artifact: record.target_artifact,
    apply: { ok: applyRes.ok, code: applyRes.code, summary: applyRes.summary },
    governance_state: applyRes.data && applyRes.data.governance_state,
    rollback_ref: applyRes.data && applyRes.data.rollback_ref,
    commit: applyRes.data && applyRes.data.commit,
    canary_scope: applyRes.data && applyRes.data.canary_scope,
  };
  // Only advance the canary when the change actually landed in canary state. A refusal / already-
  // applied / below-threshold result has no live canary to observe this pass.
  if (applyRes.ok && applyRes.data && applyRes.data.governance_state === canaryStateName()) {
    const cyc = canaryMod.runCanaryCycle({ env, now, recordId: record.id });
    out.canary = { ok: cyc.ok, code: cyc.code, summary: cyc.summary };
    if (cyc.data && cyc.data.governance_state) out.governance_state = cyc.data.governance_state;
    if (cyc.data && cyc.data.rollback) out.rolled_back = true;
  }
  return out;
}

/** The canary governance-state literal, sourced from the apply/canary substrate (no drift). */
function canaryStateName() {
  // _governance.GOV_STATES.CANARY — read through the apply module's transitive dep without importing
  // the private module directly. Stable literal 'canary'; kept as a fn so a future rename is 1-touch.
  return 'canary';
}

/** Reshape one evaluate proposal into the CLI's classification view (what + governance disposition). */
function classifyForCli(p) {
  const record = p.record || {};
  const flags = p.flags || {};
  let disposition;
  let code;
  if (flags.refused || (!record.id && !p.auto_applicable && flags.reason)) {
    disposition = 'refused'; code = 'EREFUSED';
  } else if (p.auto_applicable) {
    disposition = 'auto-applicable'; code = 'OK';
  } else if (flags.human_only) {
    disposition = 'refused (human-only)'; code = 'EHUMANONLY';
  } else if (flags.loosens_guardrail) {
    disposition = 'refused (never-loosen)'; code = 'ENEVERLOOSEN';
  } else if (flags.below_threshold) {
    disposition = 'proposed (below evidence threshold)'; code = 'EBELOWTHRESHOLD';
  } else {
    disposition = 'proposed (human-applied)'; code = 'EPROPOSED';
  }
  return {
    record_id: record.id || null,
    target_artifact: record.target_artifact || null,
    target_key: (record.target && record.target.key) || null,
    disposition,
    code,
    auto_applicable: Boolean(p.auto_applicable),
    evidence: record.evidence
      ? { sample_size: record.evidence.sample_size, confidence: record.evidence.confidence, effect_size: record.evidence.effect_size }
      : null,
    machine_change: record.machine_change || null,
    evidence_reasons: flags.evidence_reasons || null,
    refused_reason: flags.reason || null,
  };
}

/** Build the final result envelope from the evaluate + apply outcomes. */
function summarize({ dryRun, evalResult, classified, applied, reportError, brand }) {
  const sum = evalResult.summary || {};
  const autoN = sum.auto_applicable || 0;
  const proposedN = sum.proposed_only || 0;
  const refusedN = sum.refused || 0;

  const appliedOk = applied.filter((a) => a.apply && a.apply.ok);
  const appliedFail = applied.filter((a) => a.apply && !a.apply.ok);
  const promoted = applied.filter((a) => a.governance_state === 'promoted');
  const rolledBack = applied.filter((a) => a.rolled_back || a.governance_state === 'rolled_back');

  const mode = dryRun ? 'DRY-RUN' : 'APPLY';
  const summary = dryRun
    ? `improve (${mode}): ${sum.total || 0} proposal(s) — ${autoN} auto-applicable, ${proposedN} held proposed, ${refusedN} refused. Re-run with --apply to perform the ${autoN} governed change(s).`
    : `improve (${mode}): applied ${appliedOk.length}/${applied.length} governed change(s) in canary (${promoted.length} promoted, ${rolledBack.length} rolled back); ${proposedN} held proposed, ${refusedN} refused.`;

  const detail = [
    brand ? `brand scope: ${brand}` : null,
    reportError ? `analytics: ${reportError} (no proposals derivable yet)` : null,
    ...classified.map((c) => `  · ${dispositionGlyph(c)} ${c.target_artifact || '(unknown)'}${c.target_key ? `::${c.target_key}` : ''} — ${c.disposition}${c.code !== 'OK' && c.code !== 'EPROPOSED' ? ` [${c.code}]` : ''}`),
    ...applied.map((a) => `  ${a.apply && a.apply.ok ? '✓' : '✗'} apply ${a.record_id}: ${a.apply ? a.apply.summary : ''}${a.canary ? ` | canary: ${a.canary.summary}` : ''}`),
    dryRun ? 'No changes applied (dry-run is the default; pass --apply to change anything).' : null,
  ].filter(Boolean);

  // Honest exit code: a dry-run preview is always a clean 0. An --apply pass is 1 only if an apply
  // that we attempted actually ERRORED (a refusal is by-design, not an error — exit 0).
  const ok = appliedFail.every((a) => isByDesignRefusal(a.apply && a.apply.code));
  return {
    ok,
    exitCode: ok ? 0 : 1,
    summary,
    detail,
    data: {
      ran: true,
      mode: dryRun ? 'dry-run' : 'apply',
      summary: sum,
      proposals: classified,
      applied,
      promoted: promoted.map((a) => a.record_id),
      rolled_back: rolledBack.map((a) => a.record_id),
    },
  };
}

/** A by-design refusal (NOT an error): the loop correctly declined to change something. */
function isByDesignRefusal(code) {
  return ['EHUMANONLY', 'ENEVERLOOSEN', 'HUMAN_ONLY', 'TARGET_NOT_MACHINE_ALLOWED', 'BELOW_EVIDENCE_THRESHOLD',
    'PAUSED', 'DISABLED', 'ALREADY_APPLIED', 'EPAUSED', 'EBELOWTHRESHOLD'].includes(String(code));
}

function dispositionGlyph(c) {
  if (c.code === 'OK') return '✓';
  if (c.code === 'EHUMANONLY' || c.code === 'ENEVERLOOSEN' || c.code === 'EREFUSED') return '⛔';
  return '·';
}

function offByDefault(dryRun) {
  return {
    ok: true,
    exitCode: 0,
    summary: 'improve: self-improvement loop is OFF by default (config.self_improve.enabled !== true) — nothing applied',
    detail: [
      'The governed loop ships OFF (DD-6 (6) / §8.9). Set config/system.json self_improve.enabled = true to enable governed machine application.',
      'Until then, learning records remain PROPOSED (human-applied — the v1 behavior).',
    ],
    data: { ran: false, mode: dryRun ? 'dry-run' : 'apply', reason: 'loop disabled (off by default)', ...emptyData() },
  };
}

function paused(dryRun) {
  return {
    ok: true,
    exitCode: 0,
    summary: 'improve: PAUSED kill switch engaged (§15.4) — loop halted, nothing applied',
    detail: ['The PAUSED sentinel halts the whole loop regardless of config (DD-6 (6) / §15.4). Run "engine resume" to clear it.'],
    data: { ran: false, mode: dryRun ? 'dry-run' : 'apply', reason: 'PAUSED kill switch engaged', ...emptyData() },
  };
}

function emptyData() {
  return { summary: { total: 0, auto_applicable: 0, proposed_only: 0, refused: 0 }, proposals: [], applied: [], promoted: [], rolled_back: [] };
}

// ---------------------------------------------------------------------------
// engine rollback
// ---------------------------------------------------------------------------

/**
 * @param {object} ctx  { flags, env, now? }
 * @returns {{ ok, summary, detail?, data?, exitCode? }}
 */
function rollbackRun(ctx = {}) {
  const flags = ctx.flags || {};
  if (util.flagOn(flags.help)) return { ok: true, summary: ROLLBACK_HELP.split('\n')[0], detail: ROLLBACK_HELP };

  const env = ctx.env || process.env;
  const now = typeof ctx.now === 'number' ? ctx.now : undefined;
  const reason = typeof flags.reason === 'string' ? flags.reason : undefined;
  const recordId = typeof flags.record === 'string' ? flags.record : null;
  const toBaseline = flags['to-baseline'];

  let res;
  let action;
  if (recordId) {
    action = `record ${recordId}`;
    res = rollbackMod.rollbackRecord(recordId, { env, now, reason });
  } else if (typeof toBaseline === 'string' && toBaseline.trim() && toBaseline !== 'true') {
    action = `to baseline ${toBaseline}`;
    res = rollbackMod.rollbackToBaseline(toBaseline, { env, now, reason });
  } else if (util.flagOn(toBaseline)) {
    // --to-baseline was given without a ref value.
    return {
      ok: false,
      exitCode: 2,
      summary: 'rollback: --to-baseline needs a commit ref',
      detail: ['Usage: engine rollback --to-baseline <ref>   (the pinned known-good baseline commit).'],
    };
  } else {
    // Default + explicit --last: one-step revert of the most recent non-terminal change.
    action = 'last change';
    res = rollbackMod.rollbackLastChange({ env, now, reason });
  }

  // A "nothing to roll back" is an honest, non-error no-op (exit 0). A genuine git/IO failure is 1.
  const benign = res.code === 'NOTHING_TO_ROLL_BACK' || res.code === 'ALREADY_ROLLED_BACK';
  const ok = res.ok || benign;
  return {
    ok,
    exitCode: ok ? 0 : 1,
    summary: `rollback (${action}): ${res.summary}`,
    detail: [
      res.data && res.data.commit ? `revert commit: ${res.data.commit}` : null,
      res.data && res.data.baseline_ref ? `baseline ref: ${res.data.baseline_ref}` : null,
      res.data && Array.isArray(res.data.records) ? `records reverted: ${res.data.records.join(', ') || '(none)'}` : null,
      'Reverts are versioned + auditable; see "engine status".',
    ].filter(Boolean),
    data: { action, code: res.code, ...(res.data || {}) },
  };
}

module.exports = {
  run,
  rollbackRun,
  IMPROVE_HELP,
  ROLLBACK_HELP,
  // internals for the smoke test
  classifyForCli,
  isByDesignRefusal,
};
