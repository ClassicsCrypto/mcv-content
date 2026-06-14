---
id: rule.core.packaging
title: Package integrity and publish-readiness
scope: global
category: packaging
severity: hard
disposition: block
bars_recommended: false
codes: [PKG.PACKAGE_INVALID, PKG.AUDIT_HEADER_MISSING, PKG.GATE_VERDICT_MISSING_FOR_LIVE, PKG.GATE_VERDICT_NOT_PASSING_FOR_LIVE, PKG.PACKAGE_STATUS_NOT_READY, PKG.PUBLISH_STATE_NOT_READY, PKG.READY_FOR_PREVIEW_NOT_READY, PKG.READY_FOR_PUBLISH_NOT_READY, PKG.ENRICHMENT_PACKET_LEAK, PKG.SCORES_MISSING, PKG.SOURCE_STACK_MISSING]
mutability: human-only
version: 1.0.0
provenance: shipped
tests: [gate-regression/packaging/*]
---

<!-- release-spec §10.1, §10.2, §14.1 layer 3 (audit-header integrity, verdict presence, etc.).
     Deterministic enforcement at the publish edge: engine/gate/validate-package.js. These are
     structural/integrity checks with no calibrated judgment — the contract is fully shippable. -->

# Package integrity and publish-readiness

The deterministic pre-publish gate (layer 3, §14.1) checks that a package is structurally sound,
carries its audit header and scores, did not leak internal enrichment text, cites its sources, and
is in a publishable state for the requested edge (preview vs publish; SAFE/LIVE_PREVIEW/LIVE). No
LLM judgment — these are integrity checks.

## What is checked

- **Package validity** — the package object passed structural validation
  (`PKG.PACKAGE_INVALID`).
- **Audit header** — the identity/metadata block is present (`PKG.AUDIT_HEADER_MISSING`).
- **Gate verdict for LIVE** — a LIVE-bound package has an explicit, passing gate verdict
  (`PKG.GATE_VERDICT_MISSING_FOR_LIVE`, `PKG.GATE_VERDICT_NOT_PASSING_FOR_LIVE`). Nothing publishes
  without a recorded passing verdict.
- **Readiness state** — `package_status`, `publish_state`, `ready_for_preview`, and
  `ready_for_publish` indicate the item is ready for the requested edge
  (`PKG.PACKAGE_STATUS_NOT_READY`, `PKG.PUBLISH_STATE_NOT_READY`, `PKG.READY_FOR_PREVIEW_NOT_READY`,
  `PKG.READY_FOR_PUBLISH_NOT_READY`).
- **No enrichment leak** — internal enrichment-packet text did not bleed into the public copy
  (`PKG.ENRICHMENT_PACKET_LEAK`).
- **Scores present** — the package carries its scores block (`PKG.SCORES_MISSING`).
- **Source stack** — copy that cites a source carries a Source Stack documenting it
  (`PKG.SOURCE_STACK_MISSING`; this code is the publish-edge counterpart of the claims-safety
  firewall — see `rule.core.claims-safety`).

## Codes

All are HARD, `disposition: block`, route **packager** (the publish-edge integrity codes are the
packager's to resolve before re-presenting the package). The registry (`rules/codes.md`) is
canonical for each code's `route`. Note the upstream cause varies even though the route is the
packager: a missing/non-passing gate verdict (`PKG.GATE_VERDICT_*`) ultimately traces back to the
gate seat, and a missing Source Stack (`PKG.SOURCE_STACK_MISSING`) traces back to the writer adding
the source — the packager re-routes to the responsible upstream seat as needed.

## Disposition

HARD ⇒ `block`. An invalid, unverified, or not-ready package cannot publish. These run at both the
pre-render and pre-publish edges; the publish edge additionally enforces approval and rate/dup
checks (executor, §14.1 / SYS.* family).

## Example (brand: Acme Cosmos)

- A LIVE-bound Acme Cosmos package with no recorded gate verdict ⇒
  `PKG.GATE_VERDICT_MISSING_FOR_LIVE` (route packager, who re-routes to the gate seat); it never
  reaches the publisher.

## Mutability

`human-only`. Package-integrity invariants are fixed (DD-6, §11.4); not tunable by the
machine-learning loop.
