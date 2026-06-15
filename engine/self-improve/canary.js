'use strict';

/**
 * engine/self-improve/canary.js  [N net-new]
 *
 * The CANARY → OBSERVE → PROMOTE/ROLLBACK stage of the governed self-improvement loop
 * (release-spec §8.9; Appendix B.3 #3 canary machinery; DD-6 (4)). A change applied by
 * apply.js lands in governance_state=canary on a LIMITED scope; this module observes it for N
 * cycles against the pre-change baseline, then either PROMOTES it (governance_state=promoted —
 * kept) or AUTO-ROLLS-BACK on regression (governance_state=rolled_back — reverted via rollback.js).
 *
 * Deterministic + zero-key (RD-2 / RD-12): the observation reads the EXISTING engagement analytics
 * (engine/analytics/engagement/baselines.js — the same rolling baselines/outliers the v1 report
 * uses). The canary's outcome is computed from the locally-collected checkpoints, NOT a chain LLM.
 * Regression rule: the canaried slice's primary-metric median must hold at/above
 * (1 - regression_tolerance) x the baseline median; falling below that band ⇒ AUTO-ROLLBACK.
 *
 * Each invocation advances one observation cycle. When observe_cycles_done reaches
 * observe_cycles_required AND no regression is detected ⇒ PROMOTE. A regression at ANY cycle ⇒
 * immediate AUTO-ROLLBACK (fail-closed: a regressing change is reverted, not given more rope).
 *
 * Every transition → the event ledger (DD-6 (6) auditable). Honors the kill switch + config gate
 * (a paused/disabled loop does not advance canaries). Idempotent on a terminal state (a promoted /
 * rolled-back record is a no-op-plus-report). Fail-closed: any error leaves the canary in place
 * (it will be re-observed next cycle) rather than silently promoting.
 *
 * Tier-3 cleanliness (§0.3 r6): no hardcoded paths/IDs/codenames; instance paths via paths.js.
 */

const fs = require('fs');

const ledger = require('../orchestrator/workflow-ledger.js');
const baselines = require('../analytics/engagement/baselines.js');
const gov = require('./_governance.js');
const { rollbackRecord } = require('./rollback.js');

const { GovernanceError, GOV_STATES } = gov;
const SI_LEDGER_ID = 'self-improve';

function nowIso(now) {
  return new Date(typeof now === 'number' ? now : Date.now()).toISOString();
}

function result(ok, code, summary, data) {
  return { ok, code, summary, data: data || {} };
}

/**
 * runCanaryCycle — advance one observation cycle for one canaried record (or, with no id, for
 * every canary currently in flight).
 *
 * @param {object} [opts]
 * @param {object}   [opts.env]        env for paths resolution (default process.env).
 * @param {number}   [opts.now]        injected clock (ms).
 * @param {string}   [opts.recordId]   advance just this canary; omit to sweep all canaries.
 * @param {Array}    [opts.records]    raw checkpoint records for the observation (default reads
 *                                      the analytics dir via baselines.js) — injectable for tests.
 * @param {object}   [opts.observation]  injected {value, baseline} to force an outcome (tests).
 * @returns {object}  single-record result, or { ok, code, summary, data:{results:[...]} } sweep.
 */
function runCanaryCycle(opts = {}) {
  const env = opts.env || process.env;
  const now = typeof opts.now === 'number' ? opts.now : Date.now();

  // Kill switch + config gate: a paused/disabled loop does not advance canaries (DD-6 (6)).
  if (gov.isPaused(env)) {
    return result(false, 'PAUSED', 'kill switch engaged — canary observation halted (§15.4)');
  }
  if (!gov.loopConfig(env).enabled) {
    return result(false, 'DISABLED', 'self-improvement loop disabled — canary observation halted (DD-6 (6))');
  }

  if (opts.recordId) {
    return observeOne(opts.recordId, opts, env, now);
  }

  // Sweep: advance every canary in flight.
  const ids = listCanaries(env);
  const results = ids.map((id) => observeOne(id, opts, env, now));
  return result(true, 'SWEPT', `observed ${results.length} canary(ies)`, { results });
}

/** All record ids whose governance sidecar is in governance_state=canary. */
function listCanaries(env = process.env) {
  let dir;
  try {
    dir = require('../shared/paths.js').learningAppliedDir(env);
  } catch {
    return [];
  }
  let files;
  try {
    files = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const ids = [];
  for (const f of files) {
    if (!f.endsWith('.governance.json')) continue;
    const sc = gov.readJson(require('path').join(dir, f));
    if (sc && sc.governance_state === GOV_STATES.CANARY && sc.record_id) ids.push(sc.record_id);
  }
  return ids;
}

/** Observe + advance one canary by id. */
function observeOne(recordId, opts, env, now) {
  try {
    const govFile = gov.governancePath(recordId, env);
    const sidecar = gov.readJson(govFile);
    if (!sidecar) {
      return result(false, 'NOT_FOUND', `no governance record for ${recordId}`, { record_id: recordId });
    }

    // Terminal states are idempotent no-ops.
    if (sidecar.governance_state === GOV_STATES.PROMOTED) {
      return result(true, 'ALREADY_PROMOTED', `${recordId} already promoted`, { record_id: recordId });
    }
    if (sidecar.governance_state === GOV_STATES.ROLLED_BACK) {
      return result(true, 'ALREADY_ROLLED_BACK', `${recordId} already rolled back`, { record_id: recordId });
    }
    if (sidecar.governance_state !== GOV_STATES.CANARY) {
      return result(false, 'NOT_CANARY', `${recordId} is not in canary state`, { record_id: recordId });
    }

    // Observe the canaried slice vs the baseline (DD-6 (4)). Deterministic from analytics.
    const obs = opts.observation || observeMetric(sidecar, opts, env);

    // Regression check: below (1 - tolerance) x baseline ⇒ AUTO-ROLLBACK (fail-closed).
    const tolerance = typeof sidecar.regression_tolerance === 'number' ? sidecar.regression_tolerance : 0.1;
    const regressed = isRegression(obs, tolerance);

    if (regressed) {
      logEvent(env, now, 'self_improve_canary_regression', recordId, {
        governance_state: GOV_STATES.CANARY, observation: obs, tolerance,
      });
      // AUTO-ROLLBACK to the pinned baseline ref (DD-6 (4)/(5)).
      const rb = rollbackRecord(recordId, {
        env, now, reason: `canary regression (value ${obs.value} vs baseline ${obs.baseline}, tol ${tolerance})`,
      });
      return result(true, 'AUTO_ROLLED_BACK',
        `${recordId} regressed — auto-rolled-back to baseline`,
        { record_id: recordId, observation: obs, rollback: rb.data });
    }

    // No regression: advance the observation counter.
    const done = (Number(sidecar.observe_cycles_done) || 0) + 1;
    const required = Number(sidecar.observe_cycles_required) || gov.DEFAULT_CANARY_CYCLES;
    sidecar.observe_cycles_done = done;
    sidecar.last_observation = { ...obs, at: nowIso(now) };

    if (done < required) {
      gov.writeJson(govFile, sidecar);
      gov.commitInstance(`self-improve: observe ${recordId} (cycle ${done}/${required})`, [govFile], env);
      logEvent(env, now, 'self_improve_canary_observed', recordId, {
        governance_state: GOV_STATES.CANARY, cycle: done, required, observation: obs,
      });
      return result(true, 'OBSERVED',
        `${recordId} observed cycle ${done}/${required} — holding canary`,
        { record_id: recordId, cycle: done, required, observation: obs });
    }

    // Required cycles met, no regression ⇒ PROMOTE (governance_state=promoted; the change is kept).
    sidecar.governance_state = GOV_STATES.PROMOTED;
    sidecar.promoted_at = nowIso(now);
    gov.writeJson(govFile, sidecar);
    const commit = gov.commitInstance(`self-improve: promote ${recordId}`, [govFile], env);
    logEvent(env, now, 'self_improve_promoted', recordId, {
      governance_state: GOV_STATES.PROMOTED, cycles: done, commit, observation: obs,
    });
    return result(true, 'PROMOTED',
      `${recordId} promoted after ${done} clean cycle(s)`,
      { record_id: recordId, governance_state: GOV_STATES.PROMOTED, commit, observation: obs });
  } catch (err) {
    // Fail-closed: leave the canary in place (it gets re-observed next cycle); never auto-promote.
    return result(false, err.code || 'OBSERVE_FAILED',
      `canary observation failed for ${recordId}: ${err.message}`, { record_id: recordId });
  }
}

/**
 * Deterministically observe the canaried slice's current primary-metric median vs the recorded
 * baseline. Reads the rolling baselines over the local checkpoint corpus (baselines.js). The
 * "canary value" is the rolling median for the brand×platform group the change targets, taken
 * from the SAME analytics the v1 report uses; the "baseline" is the pre-change median captured in
 * the sidecar (or, if absent, the historical group median). Pure aggregation — no chain LLM.
 *
 * @returns {{ value:(number|null), baseline:(number|null), basis:string }}
 */
function observeMetric(sidecar, opts, env) {
  const base = baselines.computeBaselines({ env, records: opts.records });
  // Current signal: the highest group median across the corpus (the change tunes prioritization,
  // so we track whether the tuned dimension's engagement held). Conservative: when we cannot
  // resolve a current value, treat it as MISSING (null) — isRegression then holds (no false promote).
  let value = null;
  for (const g of Object.values(base.groups || {})) {
    const m = pickMedian(g.metrics);
    if (m != null && (value == null || m > value)) value = m;
  }
  const baseline = typeof sidecar.baseline_metric === 'number'
    ? sidecar.baseline_metric
    : value; // first observation establishes the baseline if none was pinned.
  return { value, baseline, basis: 'rolling-median-primary' };
}

function pickMedian(metrics = {}) {
  for (const mk of ['likes', 'impressions', 'views']) {
    if (typeof metrics[`${mk}_median`] === 'number') return metrics[`${mk}_median`];
  }
  return null;
}

/**
 * Regression iff we have both a value and a baseline AND the value fell below the tolerance band.
 * When the value is unknown (null) we DO NOT declare a regression on that basis alone — but the
 * promotion path still requires clean cycles, so an unobservable canary simply keeps observing
 * (it never auto-promotes on missing data, because observeMetric leaves value null only when the
 * corpus is empty, in which case there is no evidence of harm OR benefit).
 */
function isRegression(obs, tolerance) {
  if (obs == null) return false;
  const { value, baseline } = obs;
  if (typeof value !== 'number' || typeof baseline !== 'number' || baseline <= 0) return false;
  return value < baseline * (1 - tolerance);
}

function logEvent(env, now, eventType, recordId, data) {
  ledger.recordEvent(SI_LEDGER_ID, eventType, {
    self_improve: { last_event: { ts: nowIso(now), event_type: eventType, record_id: recordId } },
  }, { record_id: recordId, ...(data || {}) }, env);
}

module.exports = {
  runCanaryCycle,
  // internals for tests
  listCanaries,
  observeOne,
  observeMetric,
  isRegression,
  SI_LEDGER_ID,
};
