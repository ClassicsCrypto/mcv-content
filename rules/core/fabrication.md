---
id: rule.core.fabrication
title: Unresolved template tokens (placeholder fabrication)
scope: global
category: safety
severity: soft
disposition: warn
bars_recommended: true
codes: [LINT.PLACEHOLDER]
mutability: human-only
version: 1.0.0
provenance: shipped
tests: [gate-regression/fabrication/*]
---

<!-- release-spec §10.1, §10.2 (LINT.* family), §14.4 (RD-21). Deterministic enforcement:
     engine/gate/pre-gate-lint.js (LINT.PLACEHOLDER). This is the placeholder-fabrication code:
     distinct from the LLM fact-firewall FM.FABRICATION (invented fact), which lives in
     rule.core.claims-safety. An unfilled {TOKEN} is a publish-safety hazard, not an invented
     fact — hence SOFT with a publish-safety floor (bars_recommended). -->

# Unresolved template tokens (placeholder fabrication)

A brace-enclosed token left in copy is an unfilled template slot. Braces never belong in published
copy, so the check is high-recall by design — every distinct token is reported. This is the
placeholder-fabrication code, distinct from the fact-firewall's invented-fact code
(`FM.FABRICATION`, see `rule.core.claims-safety`).

## What is checked

- Any `{...}` token (a brace-enclosed run) remaining in a variant fires `LINT.PLACEHOLDER`
  (SOFT, `bars_recommended`). Each distinct token is reported for auditability.

## Code

- `LINT.PLACEHOLDER` (SOFT, `bars_recommended`, route **writer**).

## Disposition

SOFT — `disposition: warn`, `bars_recommended: true` (RD-21). The *concept* is A/B-eligible once
the token is filled, but a literal brace can never publish: **publish safety floor** — a variant
carrying an unfilled token is barred from the Recommended slot, and the token must be resolved by
the writer before send. Soft means "fill it, then it's eligible", not "a brace may publish".

## Example (brand: Acme Cosmos)

- Unfilled (SOFT, bars Recommended): `The beta wrapped and {METRIC} builders shipped demos.`
- Filled (eligible): `The beta wrapped and 60 builders shipped demos.`

## Mutability

`human-only`. The publish-safety floor on unfilled tokens is a guardrail (DD-6); not tunable by
the machine-learning loop.
