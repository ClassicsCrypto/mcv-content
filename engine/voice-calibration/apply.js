'use strict';

/**
 * engine/voice-calibration/apply.js  [N net-new — roadmap #5 voice-calibration human-applied path]
 *
 * applyVoiceCalibration(record, opts) — the HUMAN-ONLY application path for a voice-calibration
 * proposal. This is NOT the self-improve applyGovernedChange path (which EHUMANONLY-refuses any
 * voice target). This path is exclusively human-applied and requires explicit consent.
 *
 * GOVERNANCE CONTRACT (NON-NEGOTIABLE):
 *   - consent !== true  => throw { code:'ECONSENTREQUIRED' }, write NOTHING.
 *   - assertNotGateLoosening on every proposed axis => ENEVERLOOSEN on smuggled gate fields.
 *   - $CONTENT_HOME must be a git repo => NO_INSTANCE_REPO refusal (no versioning = no change).
 *   - Capture baseline_ref = HEAD before writing.
 *   - Run gate-regression BEFORE writing brand.json (fail-closed).
 *   - Write brand.json voice fields atomically (all four axes).
 *   - Write learning record status:'applied' + governance sidecar.
 *   - ONE atomic instance-repo commit (all changed files together).
 *   - Record in workflow-ledger.
 *
 * rollbackVoiceCalibration(ref, opts) — delegates to engine/self-improve/rollback.js
 * rollbackToBaseline, targeting the voice fields in brand.json.
 *
 * REUSES from engine/self-improve/_governance.js:
 *   headRef, commitInstance, isInstanceRepo, writeJson, recordPath, governancePath, isPaused, readJson
 * REUSES from engine/self-improve/mutability.js:
 *   assertMachineChangeAllowed (throws EHUMANONLY — called to CONFIRM this is human-only)
 *   assertNotGateLoosening (throws ENEVERLOOSEN on gate-axis smuggling)
 *
 * Tier-3 cleanliness (§0.3 r6): no hardcoded brand names/ids/handles/paths/codenames.
 */

const fs = require('fs');
const path = require('path');

const paths = require('../shared/paths.js');
const ledger = require('../orchestrator/workflow-ledger.js');
const gov = require('../self-improve/_governance.js');
const mutability = require('../self-improve/mutability.js');
const rollbackMod = require('../self-improve/rollback.js');
// Reuse the freshness guard from propose.js (BLOCKER 3 — apply re-asserts freshness).
const { assertFresh, StaleReportError } = require('./propose.js');

const { GovernanceError } = gov;
const { HumanOnlyViolation, NeverLoosenViolation } = mutability;

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

class ConsentRequiredError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConsentRequiredError';
    this.code = 'ECONSENTREQUIRED';
  }
}

class NeverLoosenError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NeverLoosenError';
    this.code = 'ENEVERLOOSEN';
  }
}

class VoiceApplyError extends Error {
  constructor(message, code = 'EVOICEAPPLY') {
    super(message);
    this.name = 'VoiceApplyError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VC_LEDGER_ID = 'voice-calibration';

/** Voice axes that live in brand.json and are the only fields this module ever writes. */
const VOICE_AXES = Object.freeze(['drama_dial', 'archetype_emphasis', 'hook_preferences', 'cadence_preferences']);

/** Gate axes in a proposed_diff that should never appear — any such key is a smuggled gate axis. */
const GATE_AXIS_NAMES = Object.freeze(['severity', 'tier', 'disposition', 'bars_recommended', 'threshold', 'hard_fail', 'hardfail', 'gate', 'bounds']);

/** Default freshness window (days) for the apply-time re-assertion when a record carries no expiry. */
const FRESHNESS_DEFAULT_DAYS = 30;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nowIso(now) {
  return new Date(typeof now === 'number' ? now : Date.now()).toISOString();
}

function result(ok, code, summary, data) {
  return { ok, code, summary, data: data || {} };
}

function logEvent(env, now, eventType, brandId, data) {
  try {
    ledger.recordEvent(VC_LEDGER_ID, eventType, {
      voice_calibration: {
        last_event: { ts: nowIso(now), event_type: eventType, brand_id: brandId },
      },
    }, { brand_id: brandId, ...(data || {}) }, env);
  } catch {
    // Ledger is best-effort; never let a ledger failure block the apply.
  }
}

// ---------------------------------------------------------------------------
// Gate-loosening check for voice axes
// ---------------------------------------------------------------------------

/**
 * Assert the proposed_diff contains NO gate axes (severity/disposition/threshold/bounds etc.).
 * Voice calibration is only allowed to change the four voice axes. A smuggled gate axis
 * would violate ENEVERLOOSEN.
 *
 * @param {object|string} proposedDiff  the proposed_diff (object or JSON string)
 * @throws {NeverLoosenError} (ENEVERLOOSEN) when a gate axis is found
 */
function assertNotGateLoosenedByVoiceDiff(proposedDiff) {
  let diff;
  if (typeof proposedDiff === 'string') {
    try { diff = JSON.parse(proposedDiff); } catch { diff = {}; }
  } else {
    diff = proposedDiff || {};
  }

  // Check top-level keys of the diff for known gate axes.
  const keys = Object.keys(diff).map((k) => k.toLowerCase());
  for (const k of keys) {
    for (const gateAxis of GATE_AXIS_NAMES) {
      if (k === gateAxis || k.includes(gateAxis)) {
        throw new NeverLoosenError(
          `Voice-calibration proposed_diff contains a gate axis "${k}" — ENEVERLOOSEN. ` +
          'Voice calibration may ONLY change the four voice axes (drama_dial, archetype_emphasis, ' +
          'hook_preferences, cadence_preferences). Gate axes must never be touched (release-spec §3.1).',
        );
      }
    }
  }

  // Also check the structured diff via assertNotGateLoosening for each voice axis.
  // Each axis { current, proposed } is checked — a gate-shaped value in a voice field
  // is caught as a semantic violation.
  for (const axis of VOICE_AXES) {
    if (!diff[axis]) continue;
    const axisVal = diff[axis];
    // Build a synthetic change descriptor for the gate-loosening comparator.
    const change = { field: axis, before: axisVal.current, after: axisVal.proposed };
    try {
      // assertNotGateLoosening only throws on recognized gate-axis field names or transitions.
      // For voice axes (which are not gate axes), it returns true without throwing.
      mutability.assertNotGateLoosening({ kind: 'voice' }, change);
    } catch (err) {
      if (err && err.code === 'ENEVERLOOSEN') {
        throw new NeverLoosenError(
          `Voice-calibration axis "${axis}" would loosen a gate: ${err.message} (ENEVERLOOSEN).`,
        );
      }
      // Other errors are not gate-loosening violations; ignore.
    }
  }

  // MINOR P3 hardening: deep-scan the PROPOSED VALUES of each voice axis for stray gate-axis keys.
  // For example, archetype_emphasis[].severity or hook_preferences[].threshold would indicate
  // a smuggled gate-axis hiding inside a voice-axis array/object value.
  function deepScanForGateKeys(value, axisName) {
    if (value == null || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) deepScanForGateKeys(item, axisName);
      return;
    }
    // It's a plain object — check every key.
    for (const k of Object.keys(value)) {
      const kl = k.toLowerCase();
      for (const gateAxis of GATE_AXIS_NAMES) {
        if (kl === gateAxis || kl.includes(gateAxis)) {
          throw new NeverLoosenError(
            `Voice-calibration axis "${axisName}" proposed value contains a gate-axis key "${k}" — ` +
            'ENEVERLOOSEN. Gate axes must never appear inside voice-axis values ' +
            '(release-spec §3.1 deep-scan).',
          );
        }
      }
      // Recurse into nested objects/arrays.
      deepScanForGateKeys(value[k], axisName);
    }
  }

  for (const axis of VOICE_AXES) {
    if (!diff[axis]) continue;
    const axisVal = diff[axis];
    // Scan the proposed value (not the current — we are guarding what would be written).
    if (axisVal.proposed !== undefined) {
      deepScanForGateKeys(axisVal.proposed, axis);
    }
  }
}

// ---------------------------------------------------------------------------
// Gate-regression runner (injected for tests; real runner for production)
// ---------------------------------------------------------------------------

/**
 * Run gate-regression. Returns { ok: boolean, reason?: string }.
 * Accepts opts.gateRegression as a test seam (injected result).
 */
function runGateRegression(opts) {
  // Test seam: injected result.
  if (opts && opts.gateRegression && typeof opts.gateRegression === 'object') {
    const r = opts.gateRegression;
    return { ok: r.ok === true, reason: r.ok !== true ? (r.reason || 'gate-regression failed (injected)') : undefined };
  }
  if (opts && opts.skipGateRegression === true) {
    return { ok: true, skipped: true };
  }

  // Real runner.
  const repoRoot = path.resolve(__dirname, '..', '..');
  let runner;
  try {
    // eslint-disable-next-line global-require
    runner = require(path.join(repoRoot, 'scripts', 'gate-regression.js'));
  } catch (err) {
    return { ok: false, reason: `could not load gate-regression runner (${err.message}) — fail closed` };
  }
  if (!runner || typeof runner.run !== 'function') {
    return { ok: false, reason: 'gate-regression runner missing run() — fail closed' };
  }
  let code;
  try {
    code = runner.run(['--json']);
  } catch (err) {
    return { ok: false, reason: `gate-regression runner threw (${err.message})` };
  }
  return { ok: code === 0, reason: code !== 0 ? 'gate-regression suite is red' : undefined };
}

// ---------------------------------------------------------------------------
// Brand.json voice-field writer
// ---------------------------------------------------------------------------

/**
 * Build the path to brand.json for a brand. Looks under $CONTENT_HOME/brands/<brandId>/brand.json.
 * When the brandId is not known, falls back to scanning brands/ (only first brand found).
 */
function resolveBrandJsonPath(brandId, env) {
  if (brandId) {
    return paths.brandConfig(brandId, env);
  }
  // Fallback: find the only brand dir.
  const brandsDir = paths.brandsDir(env);
  try {
    const dirs = fs.readdirSync(brandsDir).filter((d) => {
      try { return fs.statSync(path.join(brandsDir, d)).isDirectory(); } catch { return false; }
    });
    if (dirs.length === 1) return paths.brandConfig(dirs[0], env);
  } catch { /* fall through */ }
  throw new VoiceApplyError('brandId is required — cannot locate brand.json without a brand id', 'BRAND_ID_REQUIRED');
}

/**
 * Atomically write the four voice axes to brand.json (tmp + rename).
 * ONLY touches: drama_dial, archetype_emphasis, hook_preferences, cadence_preferences.
 * All other brand.json fields are preserved verbatim.
 *
 * @returns {string} path to the written brand.json
 */
function writeBrandVoiceFields(brandId, proposedDiff, env) {
  const brandJsonPath = resolveBrandJsonPath(brandId, env);

  // Read current brand.json.
  let brand;
  try {
    brand = JSON.parse(fs.readFileSync(brandJsonPath, 'utf8'));
  } catch (err) {
    throw new VoiceApplyError(`Cannot read brand.json at ${brandJsonPath}: ${err.message}`, 'BRAND_JSON_READ_ERROR');
  }

  // Parse the proposed diff.
  let diff;
  if (typeof proposedDiff === 'string') {
    try { diff = JSON.parse(proposedDiff); } catch {
      throw new VoiceApplyError('proposed_diff is not valid JSON', 'INVALID_PROPOSED_DIFF');
    }
  } else {
    diff = proposedDiff || {};
  }

  // Apply only the four voice axes to brand.json — never touch anything else.
  const updated = { ...brand };
  if (diff.drama_dial && diff.drama_dial.proposed !== undefined) {
    updated.drama_dial = diff.drama_dial.proposed;
  }
  if (diff.archetype_emphasis && diff.archetype_emphasis.proposed !== undefined) {
    updated.archetype_emphasis = diff.archetype_emphasis.proposed;
  }
  if (diff.hook_preferences && diff.hook_preferences.proposed !== undefined) {
    updated.hook_preferences = diff.hook_preferences.proposed;
  }
  if (diff.cadence_preferences && diff.cadence_preferences.proposed !== undefined) {
    updated.cadence_preferences = diff.cadence_preferences.proposed;
  }

  // Atomic write (tmp + rename).
  const dir = path.dirname(brandJsonPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${brandJsonPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(updated, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, brandJsonPath);

  return brandJsonPath;
}

/**
 * Derive the brandId from a voice-calibration record.
 * target_artifact is 'brand:<id>:voice' — extract the middle segment.
 */
function brandIdFromRecord(record) {
  if (record && typeof record.target_artifact === 'string') {
    const m = record.target_artifact.match(/^brand:(.+):voice$/u);
    if (m) return m[1];
  }
  return null;
}

// ---------------------------------------------------------------------------
// Load the most recent proposed voice-calibration record
// ---------------------------------------------------------------------------

/**
 * Load a voice-calibration record. If `record` is provided (non-null), use it directly.
 * Otherwise, find the most recent proposed record for the given brand in
 * $CONTENT_HOME/learning/proposed/.
 */
function resolveRecord(record, brandId, env) {
  if (record && typeof record === 'object' && record.id) return record;

  // Find the most recent proposed record that matches the brand.
  const proposedDir = paths.learningProposedDir(env);
  let files;
  try {
    files = fs.readdirSync(proposedDir).filter((f) => f.endsWith('.json'));
  } catch {
    return null;
  }

  const targetArtifact = brandId ? `brand:${brandId}:voice` : null;
  let best = null;
  let bestTs = '';

  for (const f of files) {
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(proposedDir, f), 'utf8'));
      if (!rec || !rec.id) continue;
      // Filter by target_artifact when brandId is known.
      if (targetArtifact && rec.target_artifact !== targetArtifact) continue;
      // Also accept any brand:*:voice record when no brandId is specified.
      if (!targetArtifact && !(typeof rec.target_artifact === 'string' && rec.target_artifact.endsWith(':voice'))) continue;
      if (rec.status !== 'proposed') continue;
      // Pick the most recent by created_at.
      const ts = rec.created_at || '';
      if (!best || ts > bestTs) { best = rec; bestTs = ts; }
    } catch { /* skip unreadable */ }
  }
  return best;
}

// ---------------------------------------------------------------------------
// applyVoiceCalibration — the public human-applied path
// ---------------------------------------------------------------------------

/**
 * Apply a voice-calibration proposal to brand.json. This is the HUMAN-ONLY path.
 * The self-improve applyGovernedChange MUST refuse voice records with EHUMANONLY.
 *
 * @param {object|null} record  the proposed learning record (or null to load from disk)
 * @param {object} opts
 * @param {boolean}  opts.consent          REQUIRED: must be exactly true
 * @param {object}   [opts.env]            process.env override
 * @param {number}   [opts.now]            injected clock (ms)
 * @param {string}   [opts.brand]          brand id (used to load record when record is null)
 * @param {string}   [opts.appliedBy]      operator identity (default 'human:operator')
 * @param {object}   [opts.gateRegression] test seam for gate-regression result
 * @param {boolean}  [opts.skipGateRegression]  test-only: skip gate-regression
 * @returns {{ ok:boolean, code:string, summary:string, data:object }}
 * @throws {ConsentRequiredError}  ECONSENTREQUIRED when consent !== true
 * @throws {NeverLoosenError}      ENEVERLOOSEN when proposed_diff contains a gate axis
 * @throws {VoiceApplyError}       NO_INSTANCE_REPO / other structural failures
 */
async function applyVoiceCalibration(record, opts = {}) {
  const env = opts.env || process.env;
  const now = typeof opts.now === 'number' ? opts.now : Date.now();
  const consent = opts.consent;
  const brand = typeof opts.brand === 'string' && opts.brand.trim() ? opts.brand.trim() : null;
  const appliedBy = typeof opts.appliedBy === 'string' ? opts.appliedBy : 'human:operator';

  // CONSENT GATE (P2) — must be first, before any I/O.
  if (consent !== true) {
    throw new ConsentRequiredError(
      'Voice calibration requires explicit consent (consent:true). ' +
      'Pass --consent explicitly to apply. This is a human-only operation (P2).',
    );
  }

  // Load record (from arg or disk).
  const rec = resolveRecord(record, brand, env);
  if (!rec) {
    return result(false, 'NO_PROPOSAL',
      `No pending voice-calibration proposal found${brand ? ` for brand "${brand}"` : ''}. ` +
      'Run `engine competitor-scan` to generate a scan report and proposal first.',
      { brand });
  }

  const brandId = brandIdFromRecord(rec) || brand;

  // Verify this record really is a voice record (structural check).
  if (typeof rec.target_artifact !== 'string' || !rec.target_artifact.endsWith(':voice')) {
    return result(false, 'NOT_VOICE_RECORD',
      `record ${rec.id} is not a voice-calibration record (target_artifact: ${rec.target_artifact})`,
      { record_id: rec.id });
  }

  // Confirm that self-improve applyGovernedChange WOULD refuse this (the machine path cannot apply it).
  // This is a structural assertion — we verify the invariant, but the HUMAN path proceeds.
  try {
    mutability.assertMachineChangeAllowed({ kind: 'voice' });
    // If we reach here, the guard did NOT refuse — governance invariant violated. Fail closed.
    return result(false, 'EGOVERNANCE',
      'INTERNAL: mutability.assertMachineChangeAllowed did not refuse a voice target — governance invariant violated.',
      { record_id: rec.id });
  } catch (err) {
    if (!err || err.code !== 'EHUMANONLY') {
      // Something else went wrong — fail closed.
      return result(false, 'EGOVERNANCE',
        `mutability check failed unexpectedly (expected EHUMANONLY): ${err && err.message}`,
        { record_id: rec.id });
    }
    // Expected: EHUMANONLY confirmed. The machine path refuses it. The human path continues.
  }

  // FRESHNESS RE-ASSERTION (P9 / DD-15): re-run assertFresh before ANY write — UNCONDITIONALLY.
  // A record proposed when fresh must never be applied after the scan has expired. Prefer the
  // scan_freshness_expires_at the proposer persisted; otherwise fall back to created_at + the
  // default 30-day window. If NO freshness anchor can be derived at all, refuse (fail closed) —
  // we must not apply a change whose scan recency cannot be proven (this also covers hand-built /
  // external / legacy records fed directly to apply, not only scan-flow-produced ones).
  let freshnessExpiresAt = rec.scan_freshness_expires_at || null;
  if (!freshnessExpiresAt && rec.created_at) {
    const createdMs = Date.parse(rec.created_at);
    if (Number.isFinite(createdMs)) {
      freshnessExpiresAt = new Date(createdMs + FRESHNESS_DEFAULT_DAYS * 86400000).toISOString();
    }
  }
  if (!freshnessExpiresAt) {
    throw new StaleReportError(
      'Voice-calibration record carries no freshness anchor (no scan_freshness_expires_at and no ' +
      'parseable created_at) — refusing to apply a change whose scan recency cannot be proven ' +
      '(DD-15 / P9). Re-run engine competitor-scan to produce a fresh, dated proposal.',
      { record_id: rec.id },
    );
  }
  // Throws StaleReportError (ESTALEREPORT) when the scan is now stale — write nothing.
  assertFresh({ freshness_window: { expires_at: freshnessExpiresAt } }, now, FRESHNESS_DEFAULT_DAYS);

  // NEVER-LOOSEN gate (P3): assert no gate axis in proposed_diff.
  const proposedDiff = rec.proposed_diff_structured || rec.proposed_diff;
  assertNotGateLoosenedByVoiceDiff(proposedDiff);

  // INSTANCE REPO check (P8) — no versioning = no change.
  if (!gov.isInstanceRepo(env)) {
    throw new VoiceApplyError(
      'The instance $CONTENT_HOME is not a git repo. Voice calibration requires a versioned ' +
      'instance repo for one-step rollback (DD-6 (5) / P8). Run "engine init" first.',
      'NO_INSTANCE_REPO',
    );
  }

  // Capture baseline_ref BEFORE any write (P8).
  const baselineRef = gov.headRef(env);

  // GATE-REGRESSION must pass BEFORE writing brand.json (P4 + fail-closed).
  const gateResult = runGateRegression(opts);
  if (!gateResult.ok) {
    return result(false, 'GATE_REGRESSION_FAILED',
      `Voice calibration refused: gate-regression failed before writing — ${gateResult.reason || 'suite is red'}. ` +
      'Fix the gate-regression suite before applying voice calibration.',
      { record_id: rec.id, brand_id: brandId, baseline_ref: baselineRef });
  }

  // Write brand.json voice fields atomically (four axes only — P4 never touches gates/rules).
  const brandJsonPath = writeBrandVoiceFields(brandId, proposedDiff, env);

  // Write the applied learning record.
  const appliedRecord = {
    ...rec,
    status: 'applied',
    applied_by: appliedBy,
    applied_at: nowIso(now),
    rollback_ref: baselineRef || 'pre-init',
    target_mutability: 'human-only', // always human-only (never changed)
  };
  const recFile = gov.recordPath(rec.id, env);
  gov.writeJson(recFile, appliedRecord);

  // Write the governance sidecar.
  const govFile = gov.governancePath(rec.id, env);
  const sidecar = {
    record_id: rec.id,
    governance_state: 'applied',
    target_artifact: rec.target_artifact,
    brand_id: brandId,
    baseline_ref: baselineRef || 'pre-init',
    applied_by: appliedBy,
    applied_at: nowIso(now),
    consent: true,
    voice_axes_changed: VOICE_AXES.filter((ax) => {
      if (!proposedDiff || typeof proposedDiff !== 'object') return false;
      const axis = typeof proposedDiff === 'string' ? JSON.parse(proposedDiff) : proposedDiff;
      return axis[ax] && JSON.stringify(axis[ax].current) !== JSON.stringify(axis[ax].proposed);
    }),
  };
  gov.writeJson(govFile, sidecar);

  // ONE atomic instance-repo commit (P8 — all files in one commit).
  const home = paths.contentHome(env);
  const relBrandJson = path.relative(home, brandJsonPath).replace(/\\/gu, '/');
  const relRecFile = path.relative(home, recFile).replace(/\\/gu, '/');
  const relGovFile = path.relative(home, govFile).replace(/\\/gu, '/');

  const commit = gov.commitInstance(
    `voice-calibrate: apply ${rec.id} (human-consented, brand: ${brandId})`,
    [brandJsonPath, recFile, govFile],
    env,
  );

  // Ledger event.
  logEvent(env, now, 'voice_calibration_applied', brandId, {
    record_id: rec.id,
    baseline_ref: baselineRef,
    commit,
    brand_json_path: relBrandJson,
    applied_by: appliedBy,
  });

  return result(true, 'APPLIED',
    `Voice calibration applied (brand: ${brandId}, record: ${rec.id}). ` +
    `Baseline ref: ${baselineRef ? baselineRef.slice(0, 10) : 'pre-init'}. Commit: ${commit ? commit.slice(0, 10) : '?'}.`,
    {
      record_id: rec.id,
      brand_id: brandId,
      baseline_ref: baselineRef,
      commit,
      brand_json_path: relBrandJson,
      applied_by: appliedBy,
    });
}

// ---------------------------------------------------------------------------
// rollbackVoiceCalibration — delegates to engine/self-improve/rollback.js
// ---------------------------------------------------------------------------

/**
 * Roll back a voice-calibration apply by reverting brand.json (and optional learning record)
 * to their state at the given baseline ref. Voice calibration rollback targets brand.json
 * (the file that voice-calibration apply writes), NOT config/system.json (which the
 * SI rollback substrate targets). Uses gov.revertToCommit directly.
 *
 * P8: one-step revert, versioned, auditable.
 *
 * @param {string|null} ref     instance-repo commit ref to revert to (null => last apply sidecar ref)
 * @param {object} [opts]       { env, now, brand, recordId, reason }
 * @returns {{ ok, code, summary, data }}
 */
async function rollbackVoiceCalibration(ref, opts = {}) {
  const env = opts.env || process.env;
  const now = typeof opts.now === 'number' ? opts.now : Date.now();

  if (!gov.isInstanceRepo(env)) {
    return result(false, 'NO_INSTANCE_REPO',
      'Cannot rollback voice calibration: instance is not a git repo (P8 — run "engine init").',
      {});
  }

  const brand = typeof opts.brand === 'string' && opts.brand.trim() ? opts.brand.trim() : null;
  const recordId = opts.recordId || null;
  const reason = opts.reason || 'voice-calibration rollback (human-applied)';

  // Determine the baseline ref: use provided ref, else find from the most recent applied sidecar.
  let targetRef = (ref && typeof ref === 'string' && ref.trim()) ? ref.trim() : null;

  if (!targetRef) {
    // Find from the most recent applied voice-calibration sidecar (the baseline_ref stored there).
    const appliedDir = paths.learningAppliedDir(env);
    try {
      const files = fs.readdirSync(appliedDir).filter((f) => f.endsWith('.governance.json'));
      let bestTs = '';
      for (const f of files) {
        try {
          const sc = gov.readJson(path.join(appliedDir, f));
          if (!sc || !sc.target_artifact) continue;
          if (!sc.target_artifact.endsWith(':voice')) continue;
          if (sc.governance_state === 'rolled_back') continue;
          const ts = sc.applied_at || '';
          if (!bestTs || ts > bestTs) {
            targetRef = sc.baseline_ref || null;
            bestTs = ts;
          }
        } catch { /* skip */ }
      }
    } catch { /* no applied dir */ }
  }

  if (!targetRef || targetRef === 'pre-init') {
    return result(false, 'NO_BASELINE_REF',
      'Cannot rollback voice calibration: no baseline_ref found. ' +
      'Pass --to-baseline <ref> to specify the commit to restore.',
      { brand });
  }

  // Find brand.json path to revert.
  let brandJsonPath;
  try {
    brandJsonPath = resolveBrandJsonPath(brand, env);
  } catch {
    brandJsonPath = null;
  }

  const filesToRevert = [];
  if (brandJsonPath && fs.existsSync(brandJsonPath)) {
    filesToRevert.push(brandJsonPath);
  }

  if (filesToRevert.length === 0) {
    return result(false, 'NOTHING_TO_REVERT',
      'Voice-calibration rollback: no brand.json found to revert.',
      { brand });
  }

  let commit;
  try {
    commit = gov.revertToCommit(
      targetRef,
      filesToRevert,
      `voice-calibrate: rollback brand.json → baseline ${targetRef.slice(0, 10)} (${reason})`,
      env,
    );
  } catch (err) {
    return result(false, err.code || 'ROLLBACK_FAILED',
      `voice-calibration rollback failed: ${err.message}`,
      { brand, baseline_ref: targetRef });
  }

  // If we have a recordId or can find the applied record, mark it rolled_back.
  const targetRecordId = recordId || (() => {
    // Try to find the last applied voice record.
    const appliedDir = paths.learningAppliedDir(env);
    try {
      const files = fs.readdirSync(appliedDir).filter((f) => f.endsWith('.governance.json'));
      let bestTs = '';
      let bestId = null;
      for (const f of files) {
        try {
          const sc = gov.readJson(path.join(appliedDir, f));
          if (!sc || !sc.target_artifact || !sc.target_artifact.endsWith(':voice')) continue;
          if (sc.governance_state === 'rolled_back') continue;
          const ts = sc.applied_at || '';
          if (!bestTs || ts > bestTs) { bestId = sc.record_id; bestTs = ts; }
        } catch { /* skip */ }
      }
      return bestId;
    } catch { return null; }
  })();

  if (targetRecordId) {
    try {
      const recFile = gov.recordPath(targetRecordId, env);
      const govFile = gov.governancePath(targetRecordId, env);
      let flipped = false;
      const sidecar = gov.readJson(govFile);
      if (sidecar) {
        sidecar.governance_state = 'rolled_back';
        sidecar.rolled_back_at = new Date(now).toISOString();
        sidecar.rollback_reason = reason;
        gov.writeJson(govFile, sidecar);
        flipped = true;
      }
      const appliedRec = gov.readJson(recFile);
      if (appliedRec) {
        appliedRec.status = 'rolled_back';
        gov.writeJson(recFile, appliedRec);
        flipped = true;
      }
      // Version the audit-trail flip so HEAD matches the working tree and git status stays clean —
      // mirrors engine/self-improve/rollback.js (which commits [govFile, recFile] for the same reason).
      // Without this, HEAD reads 'applied' while the worktree reads 'rolled_back' and the tree is dirty.
      if (flipped) {
        gov.commitInstance(
          `voice-calibrate: mark ${targetRecordId} rolled_back`,
          [recFile, govFile],
          env,
        );
      }
    } catch { /* best-effort */ }
  }

  logEvent(env, now, 'voice_calibration_rolled_back', brand, {
    baseline_ref: targetRef, commit, record_id: targetRecordId,
  });

  return result(true, 'ROLLED_BACK',
    `voice-calibration rolled back to baseline ${targetRef.slice(0, 10)}. Commit: ${commit ? commit.slice(0, 10) : '?'}.`,
    { brand, baseline_ref: targetRef, commit, record_id: targetRecordId });
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  applyVoiceCalibration,
  rollbackVoiceCalibration,
  // Error types — callers branch on .code.
  ConsentRequiredError,
  NeverLoosenError,
  VoiceApplyError,
  StaleReportError, // re-exported from propose.js for callers that branch on ESTALEREPORT
  // Internals exposed for tests.
  assertNotGateLoosenedByVoiceDiff,
  writeBrandVoiceFields,
  brandIdFromRecord,
  resolveRecord,
  runGateRegression,
  VOICE_AXES,
  GATE_AXIS_NAMES,
};
