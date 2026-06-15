'use strict';

/**
 * engine/self-improve/_governance.js  [N net-new]
 *
 * Shared deterministic substrate for the GOVERNED self-improvement loop — the machinery the
 * apply / canary / rollback controllers stand on (release-spec §8.9 "ships WITH its governance
 * machinery, never before"; Appendix B.3 #3 "machine-applied Learning Records with DD-6
 * machinery — thresholds, canary, rollback — shipping together"; DD-6 the trust boundary;
 * §15.4 kill switch). The original-design self-improvement (spec §2.6 auto-research loop) had
 * NO production implementation (gap §2.2 "zero self-improvement artifacts"); this is net-new
 * deterministic engine code derived from the EXISTING analytics outputs — it never calls a
 * chain LLM (RD-2 / RD-12: the governance + application is deterministic, testable zero-key).
 *
 * What lives here (the pieces apply/canary/rollback all share):
 *   1. The MACHINE-ALLOWED-TARGET registry (DD-6 (1)): a CLOSED set of config knobs a machine
 *      change may touch — calendar weightings, archetype/content-type prioritization, and
 *      explicitly machine-tunable dials WITHIN human-set bounds. Anything else (rules/*.md,
 *      the gate, hard-fail thresholds, any human-only artifact) is OUT by construction. This is
 *      the structural side of "the applier targets ONLY the allowed knobs"; the semantic
 *      human-only / gate-loosening refusals are enforced by engine/self-improve/mutability.js
 *      (SI-MUTABILITY) which this module REQUIRES and calls before any write.
 *   2. The loop CONFIG GATE (DD-6 (6)): config.self_improvement.enabled — OFF BY DEFAULT,
 *      strictly === true to enable (fail-closed; mirrors the §8.8 trend / §1.1 brand-dna LAW).
 *   3. The KILL SWITCH check (DD-6 (6) / §15.4): the PAUSED sentinel halts everything.
 *   4. The EVIDENCE THRESHOLD (DD-6 (3)): a learning record is auto-applicable only above a
 *      configured bar (min sample size, confidence, effect size). Below threshold it stays
 *      PROPOSED (the v1 human-applied behavior) — never act on thin evidence.
 *   5. The INSTANCE-REPO git substrate (DD-6 (5)): every machine change is a versioned commit to
 *      the $CONTENT_HOME local-only repo `engine init` created (setup/init.js initLocalGit).
 *      `commitInstance` / `revertToCommit` / `headRef` give one-step rollback. Best-effort,
 *      fail-closed: when git is unavailable the apply path REFUSES (no versioning ⇒ no change).
 *   6. The GOVERNANCE SIDECAR: governance_state (canary | promoted | rolled_back) + canary scope
 *      + observation bookkeeping live in $CONTENT_HOME/learning/applied/<id>.governance.json,
 *      next to the schema-conformant learning record. The learning-record schema's status enum is
 *      proposed|applied|rolled_back and is additionalProperties:false, so the canary lifecycle is
 *      carried in the sidecar rather than forced into the record (the record stays schema-clean).
 *
 * Tier-3 cleanliness (§0.3 r6 / §1 per-path rule): constructs no instance paths itself (paths.js
 * derives them), hardcodes no IDs/handles/absolute roots/codenames; the only literals are public
 * knob names and the §4.5 ledger event types.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const paths = require('../shared/paths.js');
const { redact } = require('../shared/redact.js');

// ---------------------------------------------------------------------------
// Errors — named so the controllers (and tests) can assert the refusal class.
// ---------------------------------------------------------------------------

/** Any governance precondition failure. Fail-closed: a thrown GovernanceError ⇒ no change. */
class GovernanceError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'GovernanceError';
    this.code = code || 'GOVERNANCE_REFUSED';
  }
}

// ---------------------------------------------------------------------------
// 1. Machine-allowed target registry (DD-6 (1))
// ---------------------------------------------------------------------------

/**
 * The CLOSED set of config knobs a machine change may write. Each entry maps a learning-record
 * `target_artifact` id to (a) the system.json config path it tunes, and (b) the mutability `target`
 * descriptor the SI-MUTABILITY classifier accepts (kind + dotted path), so the two checks agree:
 * the local registry is defence-in-depth, the canonical authority is mutability.classifyTarget.
 *
 * The config paths are chosen so mutability.MACHINE_CHANGEABLE_REGISTRY matches them
 * (calendar|scheduler.weight* ; archetype|content_type.priority*), keeping this module and the
 * guard in lockstep. A target_artifact NOT in this map is refused before any write (DD-6 (1)).
 *
 * The DD-6-named machine-allowed categories (mirrors the system.schema self_improve.allowlist enum):
 *   - calendar weightings        (calendar.weights.*) — slot/pillar emphasis the matcher reads
 *   - archetype prioritization   (archetype.priority.*)
 *   - content-type prioritization(content_type.priority.*)
 *
 * Guardrail rules, the gate, and hard-fail thresholds are NOT here and never can be (human-only).
 * Values are clamped to a human-set bound; the bound is read live from
 * config.self_improve.allowlist.bounds.weight_range (DD-6 (1)/(2)) with a conservative default.
 */
const MACHINE_ALLOWED_TARGETS = Object.freeze({
  'config:calendar.weights': {
    configPath: ['calendar', 'weights'],
    // mutability target descriptor (matches the classifier's calendar-weighting registry entry).
    mutabilityTarget: { kind: 'config', path: 'calendar.weights' },
    category: 'calendar_weighting',
  },
  'config:archetype.priority': {
    configPath: ['archetype', 'priority'],
    mutabilityTarget: { kind: 'config', path: 'archetype.priority' },
    category: 'archetype_priority',
  },
  'config:content_type.priority': {
    configPath: ['content_type', 'priority'],
    mutabilityTarget: { kind: 'config', path: 'content_type.priority' },
    category: 'content_type_priority',
  },
});

/** Conservative default human-set bound when config.self_improve.allowlist.bounds is absent. */
const DEFAULT_WEIGHT_RANGE = Object.freeze({ min: 0, max: 1 });

/** Is this learning-record target a registered machine-allowed knob? */
function isMachineAllowedTarget(targetArtifact) {
  return Object.prototype.hasOwnProperty.call(MACHINE_ALLOWED_TARGETS, String(targetArtifact));
}

/** The registry entry, or null. */
function targetSpec(targetArtifact) {
  return isMachineAllowedTarget(targetArtifact) ? MACHINE_ALLOWED_TARGETS[String(targetArtifact)] : null;
}

// ---------------------------------------------------------------------------
// 2 + 4. Loop config gate + evidence threshold (read from config.self_improvement)
// ---------------------------------------------------------------------------

/** Default evidence bar (DD-6 (3)). Mirrors the system.schema self_improve.evidence defaults. */
const DEFAULT_EVIDENCE = Object.freeze({
  min_sample_size: 12,
  min_confidence: 0.8,
  min_effect_size: 0.2,
});
/** Minimum sample floor (the analytics outlier-sample floor, baselines.MIN_OUTLIER_SAMPLE=3). */
const MIN_SAMPLE_FLOOR = 3;
/** Default canary observation length (DD-6 (4)) — N cycles before promote/rollback. */
const DEFAULT_CANARY_CYCLES = 2;
/** Default canary slice fraction: the limited scope a canaried change applies to first (DD-6 (4)). */
const DEFAULT_CANARY_FRACTION = 0.25;

/** Read + parse config/system.json (best-effort; missing/torn ⇒ {}). Never throws on parse. */
function readSystemConfig(env = process.env) {
  let file;
  try {
    file = paths.systemConfig(env);
  } catch (err) {
    throw new GovernanceError(`cannot resolve config path: ${err.message}`, 'CONTENT_HOME_UNSET');
  }
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

/** The raw self_improve config block (canonical system.schema key), or {}. */
function selfImproveBlock(env = process.env) {
  const cfg = readSystemConfig(env);
  return (cfg && typeof cfg.self_improve === 'object' && cfg.self_improve) || {};
}

/**
 * The loop config, normalized with defaults (canonical system.schema.json `self_improve` shape:
 * enabled, evidence.{min_sample_size,min_confidence,min_effect_size}, canary.{observe_cycles,
 * scope_fraction,rollback_on_regression_pct}). Evidence is FLOORED, never loosened below the
 * engine sample floor (DD-6 (2) spirit).
 */
function loopConfig(env = process.env) {
  const si = selfImproveBlock(env);
  const evidence = { ...DEFAULT_EVIDENCE, ...(si.evidence || {}) };
  evidence.min_sample_size = Math.max(MIN_SAMPLE_FLOOR, Number(evidence.min_sample_size) || DEFAULT_EVIDENCE.min_sample_size);
  const canary = (si.canary && typeof si.canary === 'object' && si.canary) || {};
  return {
    // DD-6 (6): OFF BY DEFAULT — strictly === true enables (fail-closed).
    enabled: si.enabled === true,
    evidence,
    canary_cycles: Math.max(1, Number(canary.observe_cycles) || DEFAULT_CANARY_CYCLES),
    canary_fraction: clampFraction(canary.scope_fraction, DEFAULT_CANARY_FRACTION),
    // Regression band: a canary metric below (1 - regression_tolerance) x baseline rolls back.
    regression_tolerance: clampFraction(canary.rollback_on_regression_pct, 0.1),
  };
}

/**
 * The human-set bound the applier clamps every knob value to (DD-6 (1)/(2)): read live from
 * config.self_improve.allowlist.bounds.weight_range, falling back to the conservative default.
 */
function weightRange(env = process.env) {
  const si = selfImproveBlock(env);
  const wr = si.allowlist && si.allowlist.bounds && si.allowlist.bounds.weight_range;
  if (wr && typeof wr.min === 'number' && typeof wr.max === 'number' && wr.max > wr.min) {
    return { min: wr.min, max: wr.max };
  }
  return { ...DEFAULT_WEIGHT_RANGE };
}

function clampFraction(value, dflt) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > 1) return dflt;
  return n;
}

// ---------------------------------------------------------------------------
// 3. Kill switch (DD-6 (6) / §15.4) — the PAUSED sentinel halts the loop.
// ---------------------------------------------------------------------------

/** True when the kill switch is engaged (the PAUSED sentinel exists). Fail-closed on error. */
function isPaused(env = process.env) {
  try {
    return fs.existsSync(paths.pausedSentinel(env));
  } catch {
    // If we cannot even resolve the sentinel path, treat the loop as halted (fail-closed).
    return true;
  }
}

// ---------------------------------------------------------------------------
// Evidence-threshold evaluation (DD-6 (3))
// ---------------------------------------------------------------------------

/**
 * Decide whether a learning record clears the evidence bar to be auto-applicable. Below the bar
 * the record stays PROPOSED (the v1 human-applied behavior) — we never act on thin evidence.
 *
 * Evidence is read deterministically from the record itself: total supporting occurrences across
 * source_signals[].count is the sample size; an optional record.evidence {confidence, effect_size}
 * (derived upstream from analytics baselines/outliers) supplies confidence + effect size. Missing
 * confidence/effect_size is treated as NOT meeting the bar (fail-closed) unless the bar is 0.
 *
 * @returns {{ ok:boolean, sample_size:number, confidence:(number|null), effect_size:(number|null),
 *             reasons:string[] }}
 */
function evaluateEvidence(record, bar) {
  const signals = Array.isArray(record.source_signals) ? record.source_signals : [];
  const sampleSize = signals.reduce((s, g) => s + (Number(g.count) || 0), 0);
  const ev = (record && typeof record.evidence === 'object' && record.evidence) || {};
  const confidence = typeof ev.confidence === 'number' ? ev.confidence : null;
  const effectSize = typeof ev.effect_size === 'number' ? Math.abs(ev.effect_size) : null;

  const reasons = [];
  if (sampleSize < bar.min_sample_size) {
    reasons.push(`sample_size ${sampleSize} < min ${bar.min_sample_size}`);
  }
  if (bar.min_confidence > 0 && (confidence == null || confidence < bar.min_confidence)) {
    reasons.push(`confidence ${confidence == null ? 'absent' : confidence} < min ${bar.min_confidence}`);
  }
  if (bar.min_effect_size > 0 && (effectSize == null || effectSize < bar.min_effect_size)) {
    reasons.push(`effect_size ${effectSize == null ? 'absent' : effectSize} < min ${bar.min_effect_size}`);
  }
  return { ok: reasons.length === 0, sample_size: sampleSize, confidence, effect_size: effectSize, reasons };
}

// ---------------------------------------------------------------------------
// Deterministic config-knob application (the only mutation a machine change makes)
// ---------------------------------------------------------------------------

function isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

/** Deep-clone via JSON (config is plain JSON; no functions/cycles). */
function cloneJson(v) {
  return JSON.parse(JSON.stringify(v));
}

/** Get the value at a config path (array of keys), or undefined. */
function getAtPath(obj, keys) {
  let cur = obj;
  for (const k of keys) {
    if (!isPlainObject(cur)) return undefined;
    cur = cur[k];
  }
  return cur;
}

/** Set the value at a config path, creating intermediate objects. Returns the mutated root. */
function setAtPath(obj, keys, value) {
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i += 1) {
    const k = keys[i];
    if (!isPlainObject(cur[k])) cur[k] = {};
    cur = cur[k];
  }
  cur[keys[keys.length - 1]] = value;
  return obj;
}

/**
 * Clamp a proposed knob value-map into the human-set bound (DD-6 (1): dials within human bounds).
 * The change can only ever produce values inside [bound.min, bound.max]; a proposal that asks for
 * out-of-bound values is clamped, never honored verbatim (a machine change cannot escape bounds).
 */
function clampMap(map, bound) {
  const out = {};
  for (const [k, v] of Object.entries(map || {})) {
    const n = Number(v);
    if (!Number.isFinite(n)) continue;
    out[k] = Math.min(bound.max, Math.max(bound.min, n));
  }
  return out;
}

/**
 * Compute the next config object for a machine change, in memory — NO write here. Returns the
 * cloned-and-mutated config plus the before/after knob values + the human bound for the ledger +
 * sidecar. The proposed change values come from record.machine_change (a deterministic, structured
 * payload the analytics derivation produced); proposed_diff stays the human-readable narrative.
 *
 * `scope` optionally limits which keys of the knob map are touched (the canary slice, DD-6 (4)):
 * only keys in `scope` are changed; the rest of the human config is preserved untouched.
 *
 * Every proposed value is CLAMPED to the human-set weight_range (DD-6 (1)/(2)) — a machine change
 * can never produce a value outside the human bound.
 *
 * @throws {GovernanceError} when the target is not a machine-allowed knob.
 */
function computeNextConfig(config, record, scope, env = process.env) {
  const spec = targetSpec(record.target_artifact);
  if (!spec) {
    throw new GovernanceError(
      `target_artifact "${record.target_artifact}" is not a machine-allowed knob (DD-6 (1))`,
      'TARGET_NOT_MACHINE_ALLOWED',
    );
  }
  const bound = weightRange(env);
  const next = cloneJson(config || {});
  const before = cloneJson(getAtPath(next, spec.configPath) || {});

  const proposed = (record.machine_change && record.machine_change.values) || {};
  const merged = { ...before };
  const clamped = clampMap(proposed, bound);
  for (const [k, v] of Object.entries(clamped)) {
    // Canary scope (DD-6 (4)): when a scope key-set is given, only apply those keys.
    if (scope && Array.isArray(scope) && scope.length && !scope.includes(k)) continue;
    merged[k] = v;
  }
  setAtPath(next, spec.configPath, merged);
  const after = cloneJson(getAtPath(next, spec.configPath) || {});
  return { next, before, after, spec, bound };
}

/** Atomically write config/system.json (preserves field order best-effort; pretty-printed). */
function writeSystemConfig(config, env = process.env) {
  const file = paths.systemConfig(env);
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
  return file;
}

// ---------------------------------------------------------------------------
// 5. Instance-repo git substrate (DD-6 (5)) — versioned change + one-step rollback
// ---------------------------------------------------------------------------

function git(env, args) {
  const home = paths.contentHome(env);
  return execFileSync('git', args, { cwd: home, stdio: ['ignore', 'pipe', 'ignore'] })
    .toString('utf8')
    .trim();
}

/**
 * A $CONTENT_HOME-relative POSIX pathspec for git (forward slashes — git rejects backslash
 * pathspecs on Windows). Accepts an absolute or already-relative path.
 */
function gitPathspec(home, p) {
  const rel = path.relative(home, path.isAbsolute(p) ? p : path.join(home, p)) || String(p);
  return rel.replace(/\\/gu, '/');
}

/** True when $CONTENT_HOME is a git repo (the `engine init` local-only repo). */
function isInstanceRepo(env = process.env) {
  try {
    return fs.existsSync(path.join(paths.contentHome(env), '.git'));
  } catch {
    return false;
  }
}

/** Current HEAD commit ref, or null when not a repo / no commits yet. */
function headRef(env = process.env) {
  if (!isInstanceRepo(env)) return null;
  try {
    return git(env, ['rev-parse', 'HEAD']);
  } catch {
    return null;
  }
}

/**
 * Stage the given $CONTENT_HOME-relative paths and commit them to the instance repo. Returns the
 * new commit ref. Fail-closed: throws GovernanceError when the home is not a repo or git fails —
 * the apply path turns that into a refusal (no versioning ⇒ no change, DD-6 (5)).
 */
function commitInstance(message, relPaths, env = process.env) {
  if (!isInstanceRepo(env)) {
    throw new GovernanceError(
      'instance is not a git repo; the DD-6 versioned-rollback substrate is unavailable (run "engine init")',
      'NO_INSTANCE_REPO',
    );
  }
  try {
    const home = paths.contentHome(env);
    // Best-effort identity so a fresh CI repo can commit without global git config.
    try { git(env, ['config', 'user.email', 'engine@open-content-engine.local']); } catch { /* ignore */ }
    try { git(env, ['config', 'user.name', 'open-content-engine']); } catch { /* ignore */ }
    for (const rel of relPaths) {
      git(env, ['add', '--', gitPathspec(home, rel)]);
    }
    git(env, ['commit', '--quiet', '--allow-empty', '-m', message]);
    return git(env, ['rev-parse', 'HEAD']);
  } catch (err) {
    throw new GovernanceError(`instance commit failed: ${err.message}`, 'COMMIT_FAILED');
  }
}

/**
 * Revert the instance working tree of the given paths to their state at `ref` and commit the
 * revert (one-step rollback, DD-6 (5)). Uses `git checkout <ref> -- <paths>` so only the targeted
 * artifacts move — never the operator's unrelated working-tree changes.
 */
function revertToCommit(ref, relPaths, message, env = process.env) {
  if (!isInstanceRepo(env)) {
    throw new GovernanceError('instance is not a git repo; cannot roll back', 'NO_INSTANCE_REPO');
  }
  try {
    const home = paths.contentHome(env);
    for (const rel of relPaths) {
      git(env, ['checkout', ref, '--', gitPathspec(home, rel)]);
    }
    return commitInstance(message, relPaths, env);
  } catch (err) {
    if (err instanceof GovernanceError) throw err;
    throw new GovernanceError(`instance rollback failed: ${err.message}`, 'ROLLBACK_FAILED');
  }
}

// ---------------------------------------------------------------------------
// 6. Governance sidecar (governance_state + canary bookkeeping)
// ---------------------------------------------------------------------------

/** governance_state vocabulary (DD-6 (4)): the canary lifecycle layered over the record status. */
const GOV_STATES = Object.freeze({
  CANARY: 'canary',
  PROMOTED: 'promoted',
  ROLLED_BACK: 'rolled_back',
});

/** Path to the schema-conformant applied learning record. */
function recordPath(id, env = process.env) {
  const safe = String(id).replace(/[^A-Za-z0-9_.-]+/gu, '-');
  return path.join(paths.learningAppliedDir(env), `${safe}.json`);
}

/** Path to the governance sidecar next to the applied record. */
function governancePath(id, env = process.env) {
  const safe = String(id).replace(/[^A-Za-z0-9_.-]+/gu, '-');
  return path.join(paths.learningAppliedDir(env), `${safe}.governance.json`);
}

/**
 * Top-level keys that hold a git COMMIT REF (a 40-char SHA). These are non-secret, load-bearing
 * rollback substrate (DD-6 (5); the learning-record schema mandates `rollback_ref`). The generic
 * redact.js masks 40+-char opaque tokens as a secret SHAPE, which would corrupt a SHA — so after
 * redaction we RESTORE these specific keys from the original value. They are git SHAs by
 * construction (we only ever set them from `git rev-parse`), never a credential.
 */
const REF_KEYS = Object.freeze(['baseline_ref', 'rollback_ref', 'commit']);

/** Atomically write a JSON artifact under learning/applied (redacted at write, §13.3). */
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const safe = redact(value);
  // Preserve git commit refs (redaction would mask a 40-char SHA as a secret shape).
  if (safe && typeof safe === 'object' && !Array.isArray(safe)) {
    for (const k of REF_KEYS) {
      if (typeof value[k] === 'string' && /^[0-9a-f]{7,40}$/iu.test(value[k])) safe[k] = value[k];
    }
  }
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(safe, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
  return file;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

module.exports = {
  GovernanceError,
  // registry
  MACHINE_ALLOWED_TARGETS,
  isMachineAllowedTarget,
  targetSpec,
  // config gate + evidence
  DEFAULT_EVIDENCE,
  DEFAULT_CANARY_CYCLES,
  DEFAULT_CANARY_FRACTION,
  DEFAULT_WEIGHT_RANGE,
  MIN_SAMPLE_FLOOR,
  readSystemConfig,
  selfImproveBlock,
  loopConfig,
  weightRange,
  isPaused,
  evaluateEvidence,
  // config-knob mutation
  computeNextConfig,
  writeSystemConfig,
  getAtPath,
  setAtPath,
  clampMap,
  // git substrate
  isInstanceRepo,
  headRef,
  commitInstance,
  revertToCommit,
  // sidecar
  GOV_STATES,
  REF_KEYS,
  recordPath,
  governancePath,
  writeJson,
  readJson,
};
