'use strict';

/**
 * engine/setup/setup-state.js  [N net-new]
 *
 * The setup-state record: which checkpoints (C0–C4) have passed, and the derived
 * Content Project lifecycle state. Backs the resumability contract — re-running setup
 * resumes from the first incomplete checkpoint and never duplicates work
 * (release-spec §2.1 setup principles; §2.2–§2.6 checkpoints; model §5.2 lifecycle;
 * §5.4 "setup row" durable record).
 *
 * Persistence: $CONTENT_HOME/setup-state.json (located via engine/shared/paths.js — RD-3;
 * never a hardcoded path). One JSON object, written atomically (tmp + rename) so a crash
 * never leaves a half-written record (§15.1 crash-safety). Missing file reads as the
 * uninitialized baseline; readSetupState never throws on a missing/torn file.
 *
 * Lifecycle (model §5.2, normative): uninitialized → ingested → calibrated → operational
 * (+ paused). The state is DERIVED from the passed checkpoints so the two can never disagree:
 *   - C0 only ............... uninitialized (proof-of-fit done, no instance yet)
 *   - C1 passed ............. uninitialized (integration ready; not yet ingested)
 *   - C2 passed ............. ingested
 *   - C3 passed ............. calibrated     (the gate that lets a project ever go operational)
 *   - C4 passed ............. operational
 * A project MUST NOT reach `operational` without C3 (calibration) passing (§2.4 invariant;
 * model §5.2). `paused` is an orthogonal flag mirrored by the PAUSED sentinel (§15.4) and is
 * not part of the checkpoint ladder.
 *
 * Tier-3 cleanliness (§1 per-path rule): no IDs, handles, absolute roots, or production
 * persona codenames (§0.3 rule 6). This module stores only checkpoint pass/fail + timestamps.
 */

const fs = require('fs');
const path = require('path');

const paths = require('../shared/paths');

const SCHEMA_VERSION = 1;

/** The checkpoint ids, in DD-5 dependency order. */
const CHECKPOINTS = Object.freeze(['C0', 'C1', 'C2', 'C3', 'C4']);

/** Lifecycle states (model §5.2). `paused` is an orthogonal flag, not a ladder rung. */
const LIFECYCLE = Object.freeze({
  UNINITIALIZED: 'uninitialized',
  INGESTED: 'ingested',
  CALIBRATED: 'calibrated',
  OPERATIONAL: 'operational',
  PAUSED: 'paused',
});

function nowIso() {
  return new Date().toISOString();
}

/** The uninitialized baseline record (no instance work done yet). */
function emptyState() {
  const checkpoints = {};
  for (const id of CHECKPOINTS) {
    checkpoints[id] = { passed: false, at: null, detail: null };
  }
  return {
    schema_version: SCHEMA_VERSION,
    project_state: LIFECYCLE.UNINITIALIZED,
    paused: false,
    checkpoints,
    updated_at: null,
  };
}

/**
 * Normalize whatever is on disk into the current shape, tolerating older/partial records:
 * every checkpoint id is present, `passed` is a boolean, and project_state is recomputed
 * from the checkpoints so a hand-edited file can never claim `operational` without C3.
 */
function normalize(raw) {
  const base = emptyState();
  if (!raw || typeof raw !== 'object') return base;
  for (const id of CHECKPOINTS) {
    const cp = raw.checkpoints && raw.checkpoints[id];
    if (cp && typeof cp === 'object') {
      base.checkpoints[id] = {
        passed: cp.passed === true,
        at: typeof cp.at === 'string' ? cp.at : null,
        detail: cp.detail ?? null,
      };
    }
  }
  base.paused = raw.paused === true;
  base.updated_at = typeof raw.updated_at === 'string' ? raw.updated_at : null;
  base.project_state = deriveLifecycle(base);
  return base;
}

/**
 * Derive the lifecycle state from the passed checkpoints (model §5.2). The highest contiguous
 * checkpoint that has passed determines the rung; calibration (C3) is the gate to `operational`.
 * @param {object} state a normalized state record.
 * @returns {string} a LIFECYCLE value (excluding `paused`, which the caller overlays).
 */
function deriveLifecycle(state) {
  const passed = (id) => Boolean(state.checkpoints[id] && state.checkpoints[id].passed);
  // operational requires the full ladder incl. C3 calibration (§2.4 invariant).
  if (passed('C4') && passed('C3')) return LIFECYCLE.OPERATIONAL;
  if (passed('C3')) return LIFECYCLE.CALIBRATED;
  if (passed('C2')) return LIFECYCLE.INGESTED;
  // C0/C1 are integration-readiness; the project is not yet ingested.
  return LIFECYCLE.UNINITIALIZED;
}

/**
 * Read the setup-state record for this instance. Missing/torn file reads as the uninitialized
 * baseline (never throws on a missing CONTENT_HOME-resident file). Throws only if CONTENT_HOME
 * itself is unset (paths.contentHome's ContentHomeUnsetError) — callers handle that as "no
 * instance yet" where appropriate.
 * @param {object} [env] environment for path resolution (default process.env) — injectable for tests.
 * @returns {object} the normalized state record.
 */
function readSetupState(env = process.env) {
  const file = paths.setupState(env);
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return emptyState();
  }
  return normalize(raw);
}

/** Atomic JSON write (tmp + rename) so a crash never leaves a half-written record (§15.1). */
function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

/**
 * Persist the full state record (recomputing project_state + updated_at) and return it.
 * @param {object} state a (possibly partial) state record; normalized before write.
 * @param {object} [env]
 * @returns {object} the written, normalized record.
 */
function writeSetupState(state, env = process.env) {
  const next = normalize(state);
  next.updated_at = nowIso();
  atomicWriteJson(paths.setupState(env), next);
  return next;
}

/**
 * Record a checkpoint result. Read-modify-write against the on-disk state so concurrent
 * verifier runs don't clobber each other's other checkpoints. Recomputes the lifecycle state.
 * @param {string} id      one of CHECKPOINTS (C0..C4).
 * @param {boolean} passed
 * @param {object} [opts]
 * @param {*}        [opts.detail] small structured detail (e.g. calibration scores) — kept tiny;
 *                                 never instance bulk (§18.2(6) run-residue stays out of the repo,
 *                                 but setup-state lives in $CONTENT_HOME so this is allowed there).
 * @param {object}   [opts.env]
 * @returns {object} the updated, normalized, persisted record.
 */
function setCheckpoint(id, passed, opts = {}) {
  if (!CHECKPOINTS.includes(id)) {
    throw new Error(`Unknown checkpoint "${id}". Valid checkpoints: ${CHECKPOINTS.join(', ')}.`);
  }
  const env = opts.env || process.env;
  const state = readSetupState(env);
  state.checkpoints[id] = {
    passed: passed === true,
    at: nowIso(),
    detail: opts.detail ?? null,
  };
  return writeSetupState(state, env);
}

/**
 * The first checkpoint that has not yet passed (the resume point — §2.1). Returns null when the
 * full ladder (C0..C4) has passed.
 * @param {object} [env]
 * @returns {string|null}
 */
function firstIncompleteCheckpoint(env = process.env) {
  const state = readSetupState(env);
  for (const id of CHECKPOINTS) {
    if (!state.checkpoints[id].passed) return id;
  }
  return null;
}

module.exports = {
  SCHEMA_VERSION,
  CHECKPOINTS,
  LIFECYCLE,
  emptyState,
  deriveLifecycle,
  readSetupState,
  writeSetupState,
  setCheckpoint,
  firstIncompleteCheckpoint,
};
