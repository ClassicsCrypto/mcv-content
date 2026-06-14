'use strict';

/**
 * fixtures/stub-publisher.js  [N net-new — P4-TEST / P4-FIXRUN]
 *
 * A §12.3-conformant STUB publisher adapter for the zero-key `engine fixture-run` (release-spec
 * §5.4 "executor dry-run to a stub publisher adapter"). It performs NO network I/O and holds NO
 * credentials — it is the deterministic stand-in the fixture run hands the approved item to, so
 * the executor's full publish-edge walk (gates → write-ahead intent → handoff → second-gate
 * handed_off) is exercised end-to-end with zero live API keys.
 *
 * The contract it satisfies (engine/publishers/publisher.js REQUIRED_METHODS):
 *   handoff(pkg, options)      — idempotent by content_id (DR W#35): a second handoff of the same
 *                                content_id returns the SAME draft ref and never "creates" a second
 *                                post. Returns a DRAFT handoff (the §2.4 second gate) → handed_off.
 *   verifyStatus(ref, options) — scripted: keeps the draft handed_off (it does NOT fabricate a
 *                                `published` it cannot confirm — the RD-7 honesty contract).
 *   fetchMetrics(...)          — { supported: false } (no backend metrics).
 *   capabilities()             — minimal static declaration (draft_gate: true).
 *
 * createStubPublisher() returns { adapter, calls } so a caller (the fixture runner, a test) can
 * register the adapter and inspect exactly how many handoffs were issued (the idempotency proof).
 */

const publishers = require('../engine/publishers/publisher.js');

/**
 * Build a fresh stub adapter + a call log. The adapter is idempotent by content_id: repeated
 * handoffs of the same id return the same draft ref without recording a new "post".
 * @returns {{ adapter: object, calls: string[], drafts: Map<string,string> }}
 */
function createStubPublisher() {
  const calls = [];
  const drafts = new Map(); // content_id -> draft ref (idempotency memory)

  const adapter = {
    name: 'fixture-stub',

    async handoff(pkg) {
      const id =
        (pkg && (pkg.content_id || (pkg.audit_header && pkg.audit_header.content_id))) || 'unknown';
      calls.push(id);
      // Idempotent by content_id (DR W#35): same id ⇒ same draft, never a second artifact.
      if (!drafts.has(id)) drafts.set(id, `fixture-draft-${id}`);
      return {
        external_ref: drafts.get(id),
        state: publishers.PUBLISH_STATE.HANDED_OFF,
        type: 'draft',
      };
    },

    async verifyStatus(ref) {
      // Honest second-gate behavior (RD-7): the draft is not auto-published; it stays handed_off
      // until an operator publishes it in the (real) publisher. Never fabricate `published`.
      return { state: publishers.PUBLISH_STATE.HANDED_OFF, external_ref: ref, post_url: null };
    },

    async fetchMetrics() {
      return { supported: false, metrics: {} };
    },

    capabilities() {
      return { name: 'fixture-stub', draft_gate: true, media_types: ['image', 'text'], limits: {} };
    },
  };

  return { adapter, calls, drafts };
}

module.exports = { createStubPublisher };
