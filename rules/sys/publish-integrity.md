---
id: rule.sys.publish-integrity
title: Publish-edge integrity and crash safety
scope: global
category: safety
severity: hard
disposition: block
bars_recommended: false
codes: [SYS.TEST_PUBLISH_BLOCKED, SYS.RETRY_EXHAUSTED, SYS.HANDOFF_FAILED, SYS.INTERRUPTED_MID_PUBLISH, SYS.READBACK_FAIL]
mutability: human-only
version: 1.0.0
provenance: shipped
tests: [gate-regression/publish-integrity/*]
---

<!-- release-spec §10.1, §10.2 (SYS.* family), §14.1 layer 3 (executor gates), §14.3 (retry bound,
     DD-13), DD-4/12/13/19 (lifecycle, write-ahead intent, idempotent publish, single-runner lock).
     Enforcement: engine/orchestrator/publish-executor.js (the queue walker) and the readback
     integrity verifier. These are runtime-integrity codes emitted at the publish edge onto the
     queue entry / event ledger — not content-gate detections. Registered source: package
     (the publish-edge layer; the registry schema source enum has no system value). -->

# Publish-edge integrity and crash safety

The publish executor walks the queue and runs a set of named publish gates before any external
call, then hands off idempotently with write-ahead intent. These codes are emitted when an
integrity or crash-safety guard fires at the publish edge — they never appear during content
gating, only when an approved item is being published.

## What is checked

- **Test-id guard.** A content item whose id marks it a test fixture must never publish; the
  executor refuses it ⇒ `SYS.TEST_PUBLISH_BLOCKED` (fail-closed).
- **Retry bound.** Hard-fail retries are bounded (3, DD-13); the attempt counter is durably
  incremented before each retry's spend. On exhaustion the item dead-letters and an "unfilled
  slot" notice is emitted ⇒ `SYS.RETRY_EXHAUSTED`. Never an unbounded paid loop.
- **Handoff failure.** The publisher-adapter handoff errored ⇒ `SYS.HANDOFF_FAILED`. Idempotent
  retry within the bound applies; handoff with the same content_id MUST NOT double-post.
- **Mid-publish interruption.** The executor was interrupted (crash/timeout) with a write-ahead
  intent persisted ⇒ `SYS.INTERRUPTED_MID_PUBLISH`. The entry enters an interrupted-hold state for
  crash-safe replay rather than risking a double-post.
- **Readback integrity.** The live approval card read back does not match the card the engine
  built (foreign edit / render corruption) ⇒ `SYS.READBACK_FAIL`. Fails closed — the item does not
  advance.

## Codes

All HARD, `disposition: block`, route **publisher-liaison** (the seat that owns approval-card
construction/readback, queue writes, and publisher handoff). A dead-letter additionally emits the
"unfilled slot" notice and disposes the slot per DD-15.

## Disposition

HARD ⇒ `block`. The publish edge fails closed on any integrity violation: a double-post or a
mis-reported publish is worse than a missed slot. The single-runner lock (DD-19) ensures only one
executor walks a project's queue at a time; overlap is skipped-and-logged.

## Example (brand: Acme Cosmos)

- An approved Acme Cosmos card is published, the process is killed mid-handoff, and on restart the
  write-ahead intent is found ⇒ `SYS.INTERRUPTED_MID_PUBLISH`; the entry holds for crash-safe
  replay instead of re-posting.

## Mutability

`human-only`. Publish-edge integrity invariants (idempotency, retry bound, lock, fail-closed
readback) are fixed (DD-4/12/13/19, §11.4); not tunable by the machine-learning loop.
