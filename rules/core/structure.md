---
id: rule.core.structure
title: Structure — hook, argument spine, receipt framing, anchor legibility, brief compliance
scope: global
category: structure
severity: soft
disposition: warn
bars_recommended: true
codes: [FM.WEAK_HOOK, FM.WEAK_ARG, FM.STATUS_RECAP, FM.ESOTERIC, FM.BRIEF_VIOLATION, FM.STRUCTURE_VIOLATION]
mutability: learnable
version: 1.0.0
provenance: shipped
tests: [gate-regression/structure/*]
---

<!-- release-spec §10.1, §10.2, §10.3 (structure/hook rules), §14.4 (RD-21: all soft codes ship
     disposition warn). These are LLM-gate judgments applied per variant. DD-9 ceiling: this file
     ships the CONTRACT — the structural question each code answers and the canonical structure a
     piece is expected to have. The calibrated objective-test procedures (the maintainer's
     hook-spec H1, argument-spine A1-A3, receipt-framing F1-F4, anchor-legibility L1-L4 tests),
     their worked exemplar batteries, and validation provenance are maintainer-side and are NOT
     shipped. -->

# Structure

Governs how a piece is built: does it hook, does it argue, does it lead with the thesis its
receipts evidence, is it legible to an informed outsider, and does it honor the brief. These are
quality/legibility judgments the LLM gate makes per variant; the shipped CONTRACT is the question
each code answers and the canonical structure expected. The calibrated tests that answer those
questions, and their exemplars, stay maintainer-side (DD-9, §10.3).

## What is checked

- **Hook (`FM.WEAK_HOOK`, SOFT).** Applies to announcement / scarcity archetypes — any post whose
  job is to make the reader act or anticipate a concrete thing. The post must give at least ONE
  concrete actionable anchor: a specific date/time/window, OR a concrete spec/detail, OR a
  concrete CTA/mechanism. Teasing an action with none of these ("soon", "watch this account") is
  a weak hook.
- **Argument spine (`FM.WEAK_ARG`, SOFT).** Applies to opinion / thesis / commentary / long-form
  pieces. The canonical spine is **claim → mechanism → verified anchor → stake → reframe** (the
  middle three may be reordered for craft; claim opens, reframe closes). A piece fails if an
  element is missing OR if it is assertion-stacking (parallel claims reorderable without loss)
  rather than an argument.
- **Receipt framing (`FM.STATUS_RECAP`, SOFT).** Applies to receipt-anchored posts (milestone /
  ship-update / any post anchored on a verified number, first, count, or completed event).
  Receipts are evidence for a thesis, not the thesis itself: the post must lead with the
  reframe/thesis the receipt proves, not with the receipt presented as content (and not with a
  thesis-shaped wrapper over a credential/flex stack). Do not drop or alter the receipts to gain
  framing.
- **Anchor legibility (`FM.ESOTERIC`, SOFT).** Every internal/insider anchor (project shorthand,
  lore term, handle slang, internal acronym, IYKYK register, or opaque operator/builder jargon)
  must be rendered so an informed outsider understands it without insider decoding — translate
  the anchor while keeping the verified receipt verbatim. Do not strip specifics to gain
  legibility (that trades one failure for fabrication/vagueness).
- **Brief compliance (`FM.BRIEF_VIOLATION`, HARD).** The draft must include every brief-mandated
  element (must-include) and must not contradict a brief constraint.
- **Format/framework structure (`FM.STRUCTURE_VIOLATION`, HARD).** A required structural element of
  the chosen format or writing framework (e.g. a declared beat structure / beat assignment) must
  be present.

## Codes

- `FM.WEAK_HOOK` (SOFT, `bars_recommended`, route **writer**)
- `FM.WEAK_ARG` (SOFT, `bars_recommended`, route **writer**)
- `FM.STATUS_RECAP` (SOFT, `bars_recommended`, route **writer**)
- `FM.ESOTERIC` (SOFT, `bars_recommended`, route **writer**)
- `FM.BRIEF_VIOLATION` (HARD, route **matcher** — the brief is re-issued/re-matched)
- `FM.STRUCTURE_VIOLATION` (HARD, route **writer**)

## Disposition

The four quality/legibility codes are SOFT — `disposition: warn`, `bars_recommended` (RD-21):
A/B-eligible, never Recommended. The two compliance codes are HARD ⇒ `block` (route back). Apply
the structure rubrics independently — a piece can pass one and fail another; do not collapse them.

## Example (brand: Acme Cosmos)

- Weak hook (SOFT): `The wallet tool is coming. Watch this account, it opens soon.`
- Strong hook: `The Acme Cosmos wallet tool opens to holders Friday. Claim window is 72h, link in
  the next post.`

## Mutability

`learnable`. Unlike the safety guardrails, structure quality rules MAY be tuned through governed,
reviewed learning records (DD-6): the bar is meant to rise as the producer learns to emit fewer
codes. The learning-application tool still requires human review and one-step rollback.
