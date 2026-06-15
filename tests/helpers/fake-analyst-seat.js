'use strict';

/**
 * tests/helpers/fake-analyst-seat.js  [SI-FIXTURES]
 *
 * Zero-key fake ANALYST seat for the GOVERNED SELF-IMPROVEMENT LOOP (release-spec roadmap #3
 * governed self-improvement; original-design-spec §2.6 self-improvement; DD-6; §8.9 v1 boundary).
 *
 * RD-2 boundary this fake exists to exercise: the ENGINE NEVER CALLS CHAIN LLMs. The governance +
 * applier machinery is DETERMINISTIC engine code; improvement PROPOSALS are derived deterministically
 * from the existing analytics (engine/analytics/engagement baselines/outliers/performance-report).
 * The analyst seat is an OPTIONAL host seat that may only REFINE / annotate those proposals — it can
 * NEVER widen the machine-changeable surface, lower an evidence threshold, or loosen a gate. The
 * engine RE-CHECKS any seat output against the allowlist/bounds/never-loosen invariant, so a
 * misbehaving seat cannot expand authority. This is the analytics-loop counterpart of
 * tests/helpers/fake-dna-synthesis.js (the injected DNA host seat) — same injection pattern,
 * degrades gracefully when no seat is wired (DD-21 cold-start pattern; the deterministic proposal
 * set is used as-is).
 *
 * The fake replays the canned refinements recorded in
 *   fixtures/self-improve-acme/recorded/analyst-refinements.json
 * keyed by learning-record id, with a ZERO-spend cost estimate (RD-12). It performs no network I/O
 * and holds no credentials.
 *
 * Injection shape (matches a host analyst seat interface — RD-2):
 *   makeFakeAnalystSeat() -> { name, refine, estimate, capabilities }
 *     refine({ record, proposal }) => Promise<{ rationale, refined_diff, confidence, seat_meta }|null>
 *       Replays the recorded refinement for `record.id` (deep-cloned). `proposal` (the deterministic
 *       analytics-derived proposal) is accepted — a real seat consumes it — but the fake returns the
 *       canned refinement regardless (deterministic for tests). An unknown record id THROWS
 *       (unrecorded = test bug, not a silent pass); pass { onMissing: 'null' } to instead resolve
 *       null (the degrade / no-seat path — the engine then uses the deterministic proposal as-is).
 *     estimate() => { action, est_cost_usd: 0, requires_confirm } — the DD-18 zero-spend estimate.
 *     capabilities() => static { name, methods, requires_key: false }.
 *
 * makeFakeRefine() returns just the refine fn for code that injects the function directly.
 *
 * ALL FIXTURES ARE SYNTHETIC (fictional "Acme Cosmos"). See fixtures/self-improve-acme/PROVENANCE.md
 * and fixtures/PROVENANCE.md.
 */

const fs = require('node:fs');
const path = require('node:path');

const RECORDING_PATH = path.join(
  __dirname, '..', '..', 'fixtures', 'self-improve-acme', 'recorded', 'analyst-refinements.json',
);

/** Load + cache the recorded refinements, stripping the documentation $comment key. */
let _cache = null;
function loadRecording() {
  if (_cache) return _cache;
  const raw = JSON.parse(fs.readFileSync(RECORDING_PATH, 'utf8'));
  const out = {};
  for (const [key, val] of Object.entries(raw)) {
    if (key === '$comment') continue;
    out[key] = val;
  }
  _cache = out;
  return out;
}

/** Deep clone via JSON so callers can mutate returned output without poisoning the fixture. */
function clone(obj) {
  return obj == null ? obj : JSON.parse(JSON.stringify(obj));
}

/**
 * Build the fake refine(req) the self-improvement proposer injects.
 * @param {object} [opts]
 * @param {'throw'|'null'} [opts.onMissing='throw']  behavior for an unrecorded record id.
 * @returns {function(object): Promise<object|null>}
 */
function makeFakeRefine(opts = {}) {
  const onMissing = opts.onMissing === 'null' ? 'null' : 'throw';
  const recording = loadRecording();
  return async function fakeRefine(req = {}) {
    const id = String((req.record && req.record.id) || req.id || '').trim();
    if (Object.prototype.hasOwnProperty.call(recording, id)) {
      return clone(recording[id]);
    }
    if (onMissing === 'null') return null;
    throw new Error(
      `fake-analyst-seat: no recorded refinement for record "${id}" (have: ${Object.keys(recording).join(', ')})`,
    );
  };
}

/**
 * The zero-spend pre-run cost estimate the DD-18 gate presents before invoking the analyst seat.
 * The fixture seat is always zero spend; a real host seat reports actual metered spend the §11.2
 * budget caps.
 * @param {object} [q]  { proposals_count }
 */
function estimate(q = {}) {
  return {
    action: 'analyst-refine',
    proposals_count: Number(q.proposals_count) || 0,
    est_cost_usd: 0,
    requires_confirm: true,
    note: 'fixture analyst seat — zero spend; a real host seat reports actual metered spend the budget caps',
  };
}

/**
 * Build a full fake analyst seat object conforming to a host analyst-seat interface (RD-2).
 * @param {object} [opts]  same { onMissing } contract as makeFakeRefine.
 */
function makeFakeAnalystSeat(opts = {}) {
  const refine = makeFakeRefine(opts);
  return {
    name: 'fixture-analyst-seat',
    refine,
    estimate,
    capabilities() {
      return {
        name: 'fixture-analyst-seat',
        methods: ['refine', 'estimate'],
        requires_key: false,
      };
    },
  };
}

/** Learning-record ids present in the recording (handy for a test that iterates the fixture set). */
function recordedRecordIds() {
  return Object.keys(loadRecording());
}

module.exports = {
  RECORDING_PATH,
  makeFakeAnalystSeat,
  makeFakeRefine,
  estimate,
  recordedRecordIds,
};
