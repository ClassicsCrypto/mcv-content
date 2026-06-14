---
id: rule.core.voice-register
title: Voice register — operator-conviction vs poster, substitutability, lane
scope: brand
category: voice
severity: soft
disposition: warn
bars_recommended: true
codes: [LINT.FINANCIAL, FM.POSTER_REGISTER, FM.SUBSTITUTABLE, FM.LANE_DRIFT]
mutability: human-only
version: 1.0.0
provenance: shipped
tests: [gate-regression/voice-register/*]
---

<!-- release-spec §10.1, §10.2, §10.3 (tone-register rubric), §14.4 (RD-21). The deterministic
     financial-register check is engine/gate/pre-gate-lint.js (LINT.FINANCIAL); the register
     judgments are LLM-gate codes. DD-9 ceiling: this file ships the CONTRACT — what register
     question each code answers and its disposition. The calibrated objective-test procedure
     (the maintainer's register rubric) and the per-brand drama dials are NOT shipped; they are
     maintainer-side judgment and per-brand config. -->

# Voice register

Keeps brand copy in a grounded, brand-specific register: conviction earned by the piece's own
verified anchors, not free-floating maxims; copy a competitor could not post unchanged; copy on
the brand's assigned theme lane. Brand-scoped — the bar is the brand's voice, set per brand in
`$CONTENT_HOME`.

## What is checked

The shipped CONTRACT is the set of register *questions* each code answers. The calibrated
procedure that answers them (the maintainer's tone-register rubric, with its objective tests and
worked exemplars) and the per-brand intensity dials are maintainer-side / operator config and do
NOT ship in this repo (DD-9, §10.3).

- **Financial register (deterministic).** Price/floor/market-cap/ticker talk in a brand voice
  that is not financial. Fires `LINT.FINANCIAL` (HARD).
- **Poster vs operator-conviction.** Is a conviction/closing line a motivational-poster maxim, or
  is it load-bearing on the piece's verified anchor? The question: would the line still stand as a
  shareable standalone aphorism with the brand's specifics deleted (poster), or does it collapse
  into something empty without the anchor (operator-conviction)? Poster ⇒ `FM.POSTER_REGISTER`.
- **Substitutability.** Could an unrelated brand post this verbatim and have it be equally true
  and on-voice for them? If yes, the copy is substitutable ⇒ `FM.SUBSTITUTABLE`.
- **Lane drift.** Has the copy drifted off the brand's assigned theme lane into generic category
  copy with no brand texture (and no operator override cited)? ⇒ `FM.LANE_DRIFT` (HARD —
  integrity/compliance, not style).

## Codes

- `LINT.FINANCIAL` (HARD) — deterministic financial-register hit. Route: **writer**.
- `FM.POSTER_REGISTER` (SOFT, `bars_recommended`) — poster/maxim register. Route: **writer**.
- `FM.SUBSTITUTABLE` (SOFT, `bars_recommended`) — generic, brand-transferable copy. Route:
  **writer**.
- `FM.LANE_DRIFT` (HARD) — off the brand's theme lane. Route: **matcher** (re-match the slot to a
  brand-appropriate angle).

## Disposition

`LINT.FINANCIAL` and `FM.LANE_DRIFT` are HARD (`block`): financial talk in a non-financial brand
voice and lane drift are integrity/compliance failures. `FM.POSTER_REGISTER` and
`FM.SUBSTITUTABLE` are SOFT register/quality judgments — `disposition: warn`, `bars_recommended`
(RD-21): A/B-eligible, never Recommended.

## Example (brand: Acme Cosmos)

- Poster (substitutable, register-fail): `Participation is the moat nobody can buy.`
- Operator-conviction (anchor-dependent, register-OK): `The Acme Cosmos beta did not get
  announced. It got finished.`

## Mutability

`human-only`. Register and lane are brand guardrails (DD-6). Operators define the brand's lane and
register per brand; the machine-learning loop cannot loosen them.
