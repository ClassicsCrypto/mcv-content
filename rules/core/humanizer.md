---
id: rule.core.humanizer
title: Humanizer — machine-writing tells
scope: global
category: voice
severity: soft
disposition: warn
bars_recommended: true
codes: [LINT.INFLATION, LINT.NEGPAR, FM.HYPE_VOICE, FM.HUMANIZER]
mutability: human-only
version: 1.0.0
provenance: shipped
tests: [gate-regression/humanizer/*]
---

<!-- release-spec §10.1, §10.2 (LINT.* + FM.* families), §10.3 (humanizer/style rules),
     §14.4 (RD-21: all soft codes ship disposition warn). Deterministic tells are enforced in
     engine/gate/pre-gate-lint.js (LINT.INFLATION, LINT.NEGPAR); the register-level tells are
     LLM-gate judgments (FM.HYPE_VOICE, FM.HUMANIZER). This file is the contract for both. -->

# Humanizer — machine-writing tells

A final-pass standard so public copy reads like a person with taste, not a content model. The
goal is signal, not a generic "make it casual" pass: the brand's intended voice is preserved.

## What is checked

The rule names CLASSES of machine-writing tells. Some classes are caught deterministically by the
pre-gate (a regex fires `LINT.*`); the rest are register judgments the LLM gate assigns (`FM.*`).
The shipped contract is the class list; the exact lexicons, weights, and the threshold for "how
much hype is too much" are calibrated judgment and stay maintainer-side (DD-9, §10.3).

Tell classes:

- **Significance inflation** — hype/importance words that inflate ordinary facts into momentous
  ones. Deterministic lexical hits fire `LINT.INFLATION` (HARD, route-back). The broader hype
  *register* (an LLM judgment beyond the fixed lexicon) fires `FM.HYPE_VOICE` (SOFT).
- **Negated parallelism** — "not just X, but Y" and its variants. The high-precision forms fire
  deterministically as `LINT.NEGPAR` (SOFT); the LLM gate keeps full recall on the looser forms.
- **Forced rule-of-three**, **stat-stacking**, **parrot/echo**, **tutorial signposting**
  ("let's dive in"), **chatbot artifacts** ("great question", "hope this helps"), **generic
  positive closers** ("exciting times ahead"), and **follow-trap** asks — all fire `FM.HUMANIZER`
  (SOFT) when the LLM gate judges them present.
- **Decorative emoji** — public copy defaults to zero or one emoji; decoration in every line is a
  tell (judged under `FM.HUMANIZER`).

## Codes

- `LINT.INFLATION` (HARD) — deterministic significance-inflation lexical hit. Route: **writer**.
- `LINT.NEGPAR` (SOFT, `bars_recommended`) — deterministic negated-parallelism hit. Route:
  **writer**.
- `FM.HYPE_VOICE` (SOFT, `bars_recommended`) — hype/inflation VOICE register the LLM gate judges
  beyond the fixed lexicon. Distinct from a falsifiable superlative CLAIM
  (`FM.SUPERLATIVE_UNBACKED`, see `rule.core.claims-safety`) and from the mechanical em-dash rule
  (`rule.core.formatting`). Route: **writer**.
- `FM.HUMANIZER` (SOFT, `bars_recommended`) — a residual machine-writing tell from the class list
  above. Route: **writer**.

## Disposition

`LINT.INFLATION` is HARD (`block`): the inflation lexicon is a clean deterministic signal, so it
routes back rather than shipping A/B. The remaining humanizer codes are SOFT and ship
`disposition: warn` with `bars_recommended: true` (RD-21): a variant with a residual tell is
A/B-eligible but never the Recommended pick.

## Example (brand: Acme Cosmos)

- Tell (negated parallelism): `This isn't just a launch, it's a movement.`
- Clean: `The launch is live. Here is what shipped.`

## Mutability

`human-only`. The humanizer set is a quality guardrail (DD-6). Operators tune lexicons and the
brand voice per install; the machine-learning loop cannot weaken it.
