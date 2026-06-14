---
id: rule.core.formatting
title: Punctuation and formatting hygiene
scope: global
category: formatting
severity: hard
disposition: block
bars_recommended: false
codes: [LINT.EM_DASH]
mutability: human-only
version: 1.0.0
provenance: shipped
tests: [gate-regression/formatting/*]
---

<!-- release-spec §10.1 (rule format), §10.2 (LINT.* family), §14.1 layer 1. The deterministic
     enforcement is engine/gate/pre-gate-lint.js; this file is the contract it implements. -->

# Punctuation and formatting hygiene

Mechanical copy-hygiene checks applied to every public text variant before any LLM gate spend.
Deterministic and brand-neutral — these are the same for every brand.

## What is checked

- **Mid-sentence em dash.** A non-space character, an em dash, then more non-space text inside a
  sentence is rejected. The em dash mid-sentence is a recognized machine-writing tell and reads
  as un-edited model output in public copy. Sentence-ending dashes and clearly intentional
  typographic uses are out of scope of this mechanical check; the rule targets the
  mid-sentence pattern only.

## Code

- `LINT.EM_DASH` (HARD) — a mid-sentence em dash appears in a variant. Routes back to the
  **writer**. This is a fix-it / rewrite, not an A/B-shippable warning: the dash must be removed.

## Disposition

HARD ⇒ `block`. The variant cannot ship with a mid-sentence em dash; the writer re-renders the
line without it.

## Example (brand: Acme Cosmos)

- Rejected: `The beta wrapped—and the demos shipped live for everyone to use.`
- Accepted: `The beta wrapped. Every demo shipped live for everyone to use.`

## Mutability

`human-only`. Mechanical formatting hygiene is a guardrail (DD-6); the learning-application tool
refuses diffs against it. Operators MAY override the rule per brand in `$CONTENT_HOME`, but the
machine-learning loop cannot.
