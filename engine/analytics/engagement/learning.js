'use strict';

/**
 * engine/analytics/engagement/learning.js  [N net-new]
 *
 * Learning Record CREATION — the analyst-side, proposed-only half of the v1 analytics/learning
 * loop (release-spec §7.10 learning record; §8.9 "Learning Record creation (proposed records,
 * human-applied)"; DD-6 mutability). NET-NEW: production mutated rule files in place and kept no
 * record artifact (gap §2.5 learning-record row), so there is no production source to port — only
 * the SIGNAL shapes (rejection reasons, edit diffs, analytics recommendations) are reused.
 *
 * The hard contract this module enforces (DD-6 / §8.9 — the line v1 must not cross):
 *   - It ONLY CREATES records, always in status `proposed`. It NEVER applies a change: it does
 *     not write to rules/, config/, brand DNA, or any rule-stack/threshold artifact. The
 *     application tool (mutability refusal + rollback ref) is the §10.1 feature-gated, post-v1
 *     deliverable (plan P6-LEARN-APPLY). Machine application is NOT in v1.
 *   - `target_mutability` is recorded at creation (model §3 rule 4). Guardrail/safety rules and
 *     hard-fail thresholds are `human-only` — such a record is CREATABLE but FLAGGED here; the
 *     later application tool refuses to apply it. Only `learnable` targets are machine-applicable
 *     when that tool ships.
 *   - Minimum-signal discipline (DD-6 / DR W#21): a single-signal (count=1) proposal is FLAGGED.
 *
 * Inputs are decision-time calibration signals — reviewer rejection reasons and edit diffs
 * captured by the reaction listener (§7.6) — plus analytics `recommendations[]` from the weekly
 * report (§7.9). The record captures the signals it was derived from; it does not re-derive them.
 *
 * Output: one `learning-record.schema.json`-conformant file per record under
 * $CONTENT_HOME/learning/proposed/, redacted at write (§13.3). Refs are $CONTENT_HOME-relative
 * or instance-repo commit refs; absolute paths are forbidden (the schema enforces shape; this
 * module never emits an absolute path).
 *
 * Pure of brand specifics (§1 per-path rule): no account enums, no hardcoded paths, no codename.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const paths = require('../../shared/paths.js');
const { redact } = require('../../shared/redact.js');

/** Signal kinds the schema accepts (§7.10). */
const SIGNAL_TYPES = Object.freeze(['rejection', 'edit', 'analytics', 'calibration']);
/** Mutability classes (§7.10 / DD-6). human-only = guardrail/safety/threshold — apply-refused. */
const MUTABILITY = Object.freeze(['human-only', 'learnable']);
/** v1 status is always proposed; applied/rolled_back belong to the P6 application tool. */
const PROPOSED = 'proposed';

class LearningRecordError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LearningRecordError';
  }
}

/** Stable record id: a short content-addressed stamp so re-proposing identical input is detectable. */
function recordId(signals, targetArtifact, createdAt) {
  const h = crypto.createHash('sha256');
  h.update(JSON.stringify({ signals, targetArtifact }));
  return `lr-${createdAt.slice(0, 10)}-${h.digest('hex').slice(0, 10)}`;
}

/** Normalize + validate one input signal into the §7.10 source_signals[] shape. */
function normalizeSignal(sig) {
  if (!sig || typeof sig !== 'object') {
    throw new LearningRecordError('each source signal must be an object');
  }
  if (!SIGNAL_TYPES.includes(sig.type)) {
    throw new LearningRecordError(
      `source signal type "${sig.type}" is invalid; expected one of ${SIGNAL_TYPES.join(', ')}`,
    );
  }
  const count = Number.isInteger(sig.count) ? sig.count : (Array.isArray(sig.refs) ? sig.refs.length : 1);
  if (count < 1) throw new LearningRecordError('source signal count must be >= 1');
  const out = { type: sig.type, count };
  if (Array.isArray(sig.refs) && sig.refs.length) {
    // Refs must be $CONTENT_HOME-relative or instance-repo refs — reject absolute paths.
    for (const ref of sig.refs) {
      if (typeof ref === 'string' && path.isAbsolute(ref)) {
        throw new LearningRecordError(`source signal ref "${ref}" is absolute; refs must be CONTENT_HOME-relative`);
      }
    }
    out.refs = sig.refs.map(String);
  }
  return out;
}

/**
 * proposeLearningRecord — the public entry point (plan P3-LEARN export).
 *
 * Creates a single PROPOSED learning record from the supplied signals + target. Records nothing
 * but the record file; applies no change (DD-6 / §8.9). Returns the record + flags so the caller
 * (analyst seat) sees the n=1 and human-only conditions explicitly.
 *
 * @param {object}   input
 * @param {Array}    input.source_signals   one or more {type, count?, refs?} signals (>=1).
 * @param {string}   input.target_artifact  id of the artifact the change targets (rule id / config key).
 * @param {string}   input.target_mutability  'human-only' | 'learnable' (recorded before apply).
 * @param {string}   input.proposed_diff    the proposed change as a diff against the target.
 * @param {string}   [input.shareability]   'private' (default) | 'candidate-for-upstream' (DD-7b).
 * @param {object}   [opts]
 * @param {object}     [opts.env]   env for paths resolution (default process.env).
 * @param {number}     [opts.now]   injected clock (ms).
 * @param {boolean}    [opts.write] write the record file (default true).
 * @returns {{record:object, written:(string|null), flags:{single_signal:boolean, human_only:boolean}}}
 * @throws {LearningRecordError} on a malformed input (the schema-shape preconditions).
 */
function proposeLearningRecord(input = {}, opts = {}) {
  const env = opts.env || process.env;
  const now = typeof opts.now === 'number' ? opts.now : Date.now();
  const createdAt = new Date(now).toISOString();

  const rawSignals = Array.isArray(input.source_signals) ? input.source_signals : [];
  if (rawSignals.length === 0) {
    throw new LearningRecordError('source_signals must contain at least one signal (§7.10)');
  }
  const signals = rawSignals.map(normalizeSignal);

  if (!input.target_artifact || typeof input.target_artifact !== 'string') {
    throw new LearningRecordError('target_artifact (string) is required');
  }
  if (!MUTABILITY.includes(input.target_mutability)) {
    throw new LearningRecordError(
      `target_mutability "${input.target_mutability}" is invalid; expected one of ${MUTABILITY.join(', ')}`,
    );
  }
  if (!input.proposed_diff || typeof input.proposed_diff !== 'string') {
    throw new LearningRecordError('proposed_diff (string) is required');
  }

  const record = {
    id: input.id || recordId(signals, input.target_artifact, createdAt),
    created_at: createdAt,
    source_signals: signals,
    target_artifact: input.target_artifact,
    target_mutability: input.target_mutability,
    proposed_diff: input.proposed_diff,
    // Status is ALWAYS proposed in v1 — never applied/rolled_back here (DD-6 / §8.9).
    status: PROPOSED,
    shareability: input.shareability === 'candidate-for-upstream' ? 'candidate-for-upstream' : 'private',
  };

  // DD-6 flags surfaced to the analyst seat (creatable but flagged; not blocked).
  const flags = {
    // n=1 minimum-signal flag: total supporting occurrences across all signals is 1 (DR W#21).
    single_signal: signals.reduce((s, g) => s + g.count, 0) <= 1,
    // human-only target: the application tool will refuse this later (guardrail/safety/threshold).
    human_only: record.target_mutability === 'human-only',
  };

  let written = null;
  if (opts.write !== false) written = writeProposed(record, env);
  return { record, written, flags };
}

/** Write a proposed record to $CONTENT_HOME/learning/proposed/<id>.json (redacted, atomic). */
function writeProposed(record, env = process.env) {
  const dir = paths.learningProposedDir(env);
  fs.mkdirSync(dir, { recursive: true });
  const safe = String(record.id).replace(/[^A-Za-z0-9_.-]+/gu, '-');
  const outPath = path.join(dir, `${safe}.json`);
  const tmp = `${outPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(redact(record), null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, outPath);
  return outPath;
}

/**
 * Convenience: derive proposed records from a weekly report's recommendations[] + a decision-time
 * signal set. Each recommendation becomes one proposed record targeting a `learnable` brand-voice
 * hint by default (the analyst seat chooses the real target; this is the scaffold the seat fills).
 * Still creation-only — applies nothing.
 *
 * @param {object} args
 * @param {string[]} [args.recommendations]  weekly report recommendations (§7.9).
 * @param {Array}    [args.decisionSignals]  rejection/edit signals (§7.6) shared across records.
 * @param {string}   [args.targetArtifact]   default target id for the derived records.
 * @param {object}   [opts]
 * @returns {Array<{record, written, flags}>}
 */
function proposeFromRecommendations(args = {}, opts = {}) {
  const recs = Array.isArray(args.recommendations) ? args.recommendations : [];
  const decisionSignals = Array.isArray(args.decisionSignals) ? args.decisionSignals : [];
  const target = args.targetArtifact || 'rules/core/voice-register';
  const out = [];
  for (const rec of recs) {
    const signals = [
      { type: 'analytics', count: 1, refs: [] },
      ...decisionSignals,
    ];
    out.push(proposeLearningRecord({
      source_signals: signals,
      target_artifact: target,
      target_mutability: 'learnable',
      proposed_diff: `# proposed (human review required)\n${rec}`,
    }, opts));
  }
  return out;
}

module.exports = {
  SIGNAL_TYPES,
  MUTABILITY,
  PROPOSED,
  LearningRecordError,
  proposeLearningRecord,
  proposeFromRecommendations,
  // internals for tests
  normalizeSignal,
  recordId,
  writeProposed,
};
