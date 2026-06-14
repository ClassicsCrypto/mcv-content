---
id: rule.core.variant
title: Variant production — count, distinctness, presence
scope: global
category: structure
severity: hard
disposition: block
bars_recommended: false
codes: [LINT.VARIANT_COUNT, LINT.VARIANT_DUP, PKG.RECOMMENDED_MISSING, PKG.VARIANT_A_MISSING, PKG.VARIANT_B_MISSING]
mutability: human-only
version: 1.0.0
provenance: shipped
tests: [gate-regression/variant/*]
---

<!-- release-spec §10.1, §10.2, §10.3 (variant rules count/dup), DD-11 (N=3 variants).
     Deterministic: count + distinctness in engine/gate/pre-gate-lint.js (LINT.*), presence at
     the package edge in engine/gate/validate-package.js (PKG.*). The distinctness knobs
     (n-gram shingle size, similarity threshold, opener window) ship as GENERIC defaults and are
     config-tunable via config/system.json `gate.variant_distinctness`; the operator/maintainer's
     CALIBRATED values are not shipped (DD-9, §10.3). This file ships the contract. -->

# Variant production

The writer emits exactly **N = 3 labeled variants** (DD-11). The variants must offer distinct
angles, not the same thesis reworded, and the package must carry a Recommended pick plus Variant A
and Variant B.

## What is checked

- **Count (deterministic).** The draft carries exactly the expected number of labeled variants
  (default 3). Fires `LINT.VARIANT_COUNT` (HARD).
- **Distinctness (deterministic).** No two variants share a thesis. Enforced by an opener match
  plus an n-gram body-overlap similarity check. Two variants that restate the same idea fire
  `LINT.VARIANT_DUP` (HARD). The shingle size, similarity threshold, and opener window ship as
  generic defaults and are tunable via `config/system.json` `gate.variant_distinctness`; the
  maintainer's calibrated values are not shipped.
- **Presence at the package edge.** The package carries a Recommended variant plus Variant A and
  Variant B; missing slots fire `PKG.RECOMMENDED_MISSING` / `PKG.VARIANT_A_MISSING` /
  `PKG.VARIANT_B_MISSING` (HARD).

## Codes

- `LINT.VARIANT_COUNT` (HARD, route **writer**)
- `LINT.VARIANT_DUP` (HARD, route **writer**)
- `PKG.RECOMMENDED_MISSING` / `PKG.VARIANT_A_MISSING` / `PKG.VARIANT_B_MISSING` (HARD, route
  **packager**)

## Disposition

All HARD ⇒ `block`. A draft with the wrong count, duplicate variants, or a missing required slot
cannot proceed. The Recommended pick must be code-clean (§14.4); a soft-coded variant ships as A/B
only.

## Example (brand: Acme Cosmos)

- Duplicate (rejected): three variants all opening `Sixty builders shipped this weekend...`
- Distinct (accepted): one leads with the count, one leads with the outcome, one leads with the
  question the result answers.

## Mutability

`human-only`. The variant contract (N=3, distinct, required slots) is a fixed structural invariant
(§11.4); it is not tunable by the machine-learning loop.
