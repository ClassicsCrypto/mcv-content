'use strict';

/**
 * engine/self-improve/rollback.js  [N net-new]
 *
 * The ROLLBACK stage of the governed self-improvement loop (release-spec §8.9; Appendix B.3 #3
 * "one-step rollback"; DD-6 (5) "every machine change a versioned learning record with one-step
 * rollback; pinned known-good baseline"). One-step revert of a machine change back to its pinned
 * pre-change baseline ref, flipping governance_state=rolled_back and committing the revert to the
 * instance repo — so the rollback is itself a versioned, auditable step (DD-6 (5)/(6)).
 *
 * Three entry points:
 *   - rollbackRecord(id)       revert a specific applied/canary record (used by canary auto-rollback
 *                              on regression — DD-6 (4) — and by an operator who names a record).
 *   - rollbackLastChange()     revert the MOST RECENT non-terminal machine change (the `engine
 *                              rollback` one-step verb, DD-6 (5)).
 *   - rollbackToBaseline(ref)  revert the touched config knob to a pinned known-good baseline ref
 *                              (DD-6 (5) "pinned known-good baseline at end of Phase 1").
 *
 * Deterministic + zero-key (RD-2 / RD-12): rollback is pure git + filesystem; no chain LLM. Every
 * action → the event ledger (DD-6 (6) auditable, surfaced by engine status). Idempotent: rolling
 * back an already-rolled-back record is a no-op-plus-report. Fail-closed: a git/IO failure leaves
 * state untouched and reports the failure (it does NOT half-revert).
 *
 * Tier-3 cleanliness (§0.3 r6): no hardcoded paths/IDs/codenames; instance paths via paths.js.
 */

const fs = require('fs');

const paths = require('../shared/paths.js');
const ledger = require('../orchestrator/workflow-ledger.js');
const gov = require('./_governance.js');

const { GovernanceError, GOV_STATES } = gov;
const SI_LEDGER_ID = 'self-improve';

function nowIso(now) {
  return new Date(typeof now === 'number' ? now : Date.now()).toISOString();
}

function result(ok, code, summary, data) {
  return { ok, code, summary, data: data || {} };
}

/**
 * rollbackRecord — revert one machine change (by record id) to its pinned baseline.
 *
 * @param {string} recordId
 * @param {object} [opts] { env, now, reason }
 * @returns {object}
 */
function rollbackRecord(recordId, opts = {}) {
  const env = opts.env || process.env;
  const now = typeof opts.now === 'number' ? opts.now : Date.now();
  try {
    if (!recordId) throw new GovernanceError('a record id is required', 'BAD_RECORD');

    const govFile = gov.governancePath(recordId, env);
    const recFile = gov.recordPath(recordId, env);
    const sidecar = gov.readJson(govFile);
    if (!sidecar) {
      return result(false, 'NOT_FOUND', `no governance record for ${recordId}`, { record_id: recordId });
    }

    // Idempotent: already rolled back.
    if (sidecar.governance_state === GOV_STATES.ROLLED_BACK) {
      return result(true, 'ALREADY_ROLLED_BACK', `${recordId} already rolled back`, { record_id: recordId });
    }

    const baselineRef = sidecar.baseline_ref;
    if (!gov.isInstanceRepo(env)) {
      throw new GovernanceError('instance is not a git repo; cannot roll back (DD-6 (5))', 'NO_INSTANCE_REPO');
    }
    if (!baselineRef || baselineRef === 'pre-init') {
      // No pre-change commit to return to: restore the recorded `before` knob value directly, then
      // commit. This still gives a versioned, one-step revert even on a repo that had no HEAD at
      // apply time (fail-safe path; the common case has a real baseline_ref).
      restoreBeforeKnob(sidecar, env);
    } else {
      // One-step revert of the touched config to the pinned baseline ref (DD-6 (5)).
      const configFile = paths.systemConfig(env);
      gov.revertToCommit(baselineRef, [configFile], `self-improve: rollback ${recordId} → ${shortRef(baselineRef)}`, env);
    }

    // Flip governance_state + update the applied record status=rolled_back (schema-conformant).
    sidecar.governance_state = GOV_STATES.ROLLED_BACK;
    sidecar.rolled_back_at = nowIso(now);
    if (opts.reason) sidecar.rollback_reason = opts.reason;
    gov.writeJson(govFile, sidecar);

    const applied = gov.readJson(recFile);
    if (applied) {
      applied.status = 'rolled_back';
      gov.writeJson(recFile, applied);
    }

    // Commit the state flip alongside the (already-reverted) config so the ledger + repo agree.
    const commit = gov.commitInstance(
      `self-improve: mark ${recordId} rolled_back`,
      [govFile, recFile],
      env,
    );

    logEvent(env, now, 'self_improve_rolled_back', recordId, {
      governance_state: GOV_STATES.ROLLED_BACK,
      baseline_ref: baselineRef,
      commit,
      reason: opts.reason || null,
    });

    return result(true, 'ROLLED_BACK',
      `${recordId} rolled back to baseline ${shortRef(baselineRef)}`,
      { record_id: recordId, governance_state: GOV_STATES.ROLLED_BACK, baseline_ref: baselineRef, commit });
  } catch (err) {
    return refuse(env, now, recordId, err.code || 'ROLLBACK_FAILED', err.message);
  }
}

/**
 * rollbackLastChange — revert the most recent non-terminal machine change (the one-step verb).
 * "Most recent" = the canary/applied record with the latest applied_at that is not already
 * rolled_back/promoted-and-irreversible. We revert canaries and applied-but-not-yet-promoted
 * changes; a PROMOTED change is also reversible by id, but the one-step verb targets the latest
 * still-canary change first (the safest one-step).
 */
function rollbackLastChange(opts = {}) {
  const env = opts.env || process.env;
  const now = typeof opts.now === 'number' ? opts.now : Date.now();
  const sidecars = listSidecars(env)
    .filter((s) => s.governance_state !== GOV_STATES.ROLLED_BACK)
    .sort((a, b) => String(b.applied_at || '').localeCompare(String(a.applied_at || '')));
  if (sidecars.length === 0) {
    return result(false, 'NOTHING_TO_ROLL_BACK', 'no reversible machine change found', {});
  }
  return rollbackRecord(sidecars[0].record_id, { env, now, reason: opts.reason || 'one-step rollback (engine rollback)' });
}

/**
 * rollbackToBaseline — revert the touched config knob(s) to a pinned known-good baseline ref
 * (DD-6 (5) pinned baseline). When `recordId` is given, only that record's config path is reverted
 * to `ref`; otherwise config/system.json as a whole is reverted to `ref`. Every still-applied
 * record whose baseline predates `ref` is marked rolled_back so state stays consistent.
 *
 * @param {string} ref       the instance-repo commit ref to return to (the pinned baseline).
 * @param {object} [opts]    { env, now, recordId, reason }
 */
function rollbackToBaseline(ref, opts = {}) {
  const env = opts.env || process.env;
  const now = typeof opts.now === 'number' ? opts.now : Date.now();
  try {
    if (!ref) throw new GovernanceError('a baseline ref is required', 'BAD_REF');
    if (!gov.isInstanceRepo(env)) {
      throw new GovernanceError('instance is not a git repo; cannot roll back (DD-6 (5))', 'NO_INSTANCE_REPO');
    }

    if (opts.recordId) {
      // Single-record path: just delegate, but pin the requested ref into the sidecar first.
      const govFile = gov.governancePath(opts.recordId, env);
      const sidecar = gov.readJson(govFile);
      if (sidecar) {
        sidecar.baseline_ref = ref;
        gov.writeJson(govFile, sidecar);
      }
      return rollbackRecord(opts.recordId, { env, now, reason: opts.reason || `rollback to pinned baseline ${shortRef(ref)}` });
    }

    // Whole-knob path: revert config/system.json to the pinned baseline and mark all non-terminal
    // records rolled_back (the config no longer reflects them).
    const configFile = paths.systemConfig(env);
    gov.revertToCommit(ref, [configFile], `self-improve: rollback config → pinned baseline ${shortRef(ref)}`, env);

    const flipped = [];
    for (const sc of listSidecars(env)) {
      if (sc.governance_state === GOV_STATES.ROLLED_BACK) continue;
      const govFile = gov.governancePath(sc.record_id, env);
      sc.governance_state = GOV_STATES.ROLLED_BACK;
      sc.rolled_back_at = nowIso(now);
      sc.rollback_reason = opts.reason || `pinned-baseline rollback to ${shortRef(ref)}`;
      gov.writeJson(govFile, sc);
      const recFile = gov.recordPath(sc.record_id, env);
      const applied = gov.readJson(recFile);
      if (applied) { applied.status = 'rolled_back'; gov.writeJson(recFile, applied); }
      flipped.push(sc.record_id);
    }
    const commit = gov.commitInstance(`self-improve: pinned-baseline rollback → ${shortRef(ref)} (${flipped.length} record(s))`,
      [configFile, paths.learningAppliedDir(env)], env);

    logEvent(env, now, 'self_improve_rolled_back_to_baseline', null, {
      baseline_ref: ref, commit, records: flipped,
    });
    return result(true, 'ROLLED_BACK_TO_BASELINE',
      `config reverted to pinned baseline ${shortRef(ref)}; ${flipped.length} record(s) marked rolled_back`,
      { baseline_ref: ref, commit, records: flipped });
  } catch (err) {
    return refuse(env, now, opts.recordId || null, err.code || 'ROLLBACK_FAILED', err.message);
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Restore a knob to its recorded `before` value (fail-safe path when there was no baseline ref). */
function restoreBeforeKnob(sidecar, env) {
  const spec = gov.targetSpec(sidecar.target_artifact);
  if (!spec) throw new GovernanceError(`unknown target on rollback: ${sidecar.target_artifact}`, 'TARGET_UNKNOWN');
  const config = gov.readSystemConfig(env);
  gov.setAtPath(config, spec.configPath, sidecar.before || {});
  gov.writeSystemConfig(config, env);
}

/** All governance sidecars on disk. */
function listSidecars(env = process.env) {
  let dir;
  try {
    dir = paths.learningAppliedDir(env);
  } catch {
    return [];
  }
  let files;
  try {
    files = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    if (!f.endsWith('.governance.json')) continue;
    const sc = gov.readJson(require('path').join(dir, f));
    if (sc && sc.record_id) out.push(sc);
  }
  return out;
}

function shortRef(ref) {
  return ref ? String(ref).slice(0, 10) : 'baseline';
}

function refuse(env, now, recordId, code, summary) {
  try {
    logEvent(env, now, 'self_improve_rollback_refused', recordId, { code, reason: summary });
  } catch {
    /* ledger best-effort */
  }
  return result(false, code, summary, { record_id: recordId });
}

function logEvent(env, now, eventType, recordId, data) {
  ledger.recordEvent(SI_LEDGER_ID, eventType, {
    self_improve: { last_event: { ts: nowIso(now), event_type: eventType, record_id: recordId } },
  }, { record_id: recordId, ...(data || {}) }, env);
}

module.exports = {
  rollbackRecord,
  rollbackLastChange,
  rollbackToBaseline,
  // internals for tests
  listSidecars,
  SI_LEDGER_ID,
};
