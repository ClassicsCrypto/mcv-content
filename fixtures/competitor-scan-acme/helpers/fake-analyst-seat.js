'use strict';

/**
 * fixtures/competitor-scan-acme/helpers/fake-analyst-seat.js  [CS-FIXTURES]
 *
 * Zero-key fake ANALYST SEAT stub for voice-calibration propose tests (roadmap #5; RD-2/RD-12).
 * The analyst seat in proposeVoiceCalibration may ONLY return a RATIONALE STRING (P7 guarantee):
 * it cannot change the dial, evidence, target, or proposed_diff — those are structural engine
 * guarantees re-validated after the seat returns.
 *
 * Three fixture variants are exported:
 *   wellBehaved  — returns a canned rationale string (the happy path).
 *   mutating     — tries to change the drama_dial in the proposal (must be ignored/re-validated).
 *   throwing     — throws an error (engine must degrade to deterministic rationale, P7).
 *
 * Usage in tests:
 *   const { wellBehaved, mutating, throwing } = require(
 *     '../../fixtures/competitor-scan-acme/helpers/fake-analyst-seat'
 *   );
 *   // Pass as analystSeat arg to proposeVoiceCalibration(scanReport, brandConfig, { analystSeat: wellBehaved })
 */

/**
 * Well-behaved seat: returns a deterministic rationale string.
 * @param {object} proposal - The proposed learning record (deep-cloned by the engine before call).
 * @returns {string} A rationale annotation.
 */
async function wellBehaved(proposal) {
  // The seat MUST NOT mutate proposal. Returns a rationale string only.
  void proposal; // explicitly unused
  return 'Analyst annotation: numbered how-to hook pattern aligns with high-bookmark competitor content; recommend maintaining drama_dial:low as competitor high-drama items underperform on bookmarks.';
}

/**
 * Mutating seat: ILLEGALLY tries to change the drama_dial and proposed_diff on the proposal.
 * The engine MUST deep-clone inputs before calling the seat and re-validate after, so this
 * mutation must have NO effect on the final proposal (P7 guarantee).
 * @param {object} proposal - Deep-cloned proposal object.
 * @returns {string} A rationale (returned after illegal mutation attempt).
 */
async function mutating(proposal) {
  // Attempt to illegally mutate the proposal (P7: engine must ignore).
  if (proposal && proposal.proposed_diff) {
    try { proposal.proposed_diff.drama_dial = { current: 'low', proposed: 'high' }; } catch { /* ignore */ }
  }
  if (proposal) {
    try { proposal.target_mutability = 'learnable'; } catch { /* ignore */ }
  }
  return 'Mutating seat rationale (mutations must be discarded by engine).';
}

/**
 * Throwing seat: throws an error. The engine MUST catch and degrade to the deterministic
 * rationale, emitting a warning but NOT failing the proposal generation (P7 guarantee).
 * @returns {never}
 */
async function throwing() {
  throw new Error('fake-analyst-seat: simulated seat failure (P7 degradation test)');
}

module.exports = { wellBehaved, mutating, throwing };
