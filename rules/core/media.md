---
id: rule.core.media
title: Media presence and visual-state requirements
scope: global
category: media
severity: hard
disposition: block
bars_recommended: false
codes: [PKG.VISUAL_STATE_MISSING, PKG.MEDIA_MISSING, PKG.VISUAL_CHECK_MISSING, PKG.VISUAL_CHECK_NOT_PASSING, FM.IMAGE_DESCRIPTION]
mutability: human-only
version: 1.0.0
provenance: shipped
tests: [gate-regression/media/*]
---

<!-- release-spec §10.1, §10.2, §14.1 layer 3 (media/visual-state requirements at the publish
     edge). Deterministic presence checks: engine/gate/validate-package.js (PKG.*). The
     copy-vs-image judgment is an LLM-gate code (FM.IMAGE_DESCRIPTION). The visual-fidelity
     content lives in rules/visual/ (rule.visual.brand-fidelity), not here — this rule governs
     PRESENCE and STATE, the visual rule governs the image's brand-fidelity. -->

# Media presence and visual-state requirements

For visual-format packages, the deterministic publish-edge gate requires that media is bound, its
visual state is declared, and a passing visual-check result exists before the item can advance.
The image's actual brand-fidelity is governed by `rule.visual.brand-fidelity`; this rule governs
whether the required media artifacts are present and in a publishable state.

## What is checked

- **Visual state present.** A visual-format package declares a `visual_state`; absent ⇒
  `PKG.VISUAL_STATE_MISSING`.
- **Media bound.** A visual-format package has bound media; absent ⇒ `PKG.MEDIA_MISSING`.
- **Visual-check result present.** An image package carries a visual-check result; absent ⇒
  `PKG.VISUAL_CHECK_MISSING`.
- **Visual-check passing.** The visual-check result is passing; not passing ⇒
  `PKG.VISUAL_CHECK_NOT_PASSING`.
- **Copy vs image (LLM-judged).** The copy adds context/interpretation around the media rather
  than describing it literally; literal description ⇒ `FM.IMAGE_DESCRIPTION` (SOFT).

## Codes

- `PKG.VISUAL_STATE_MISSING` / `PKG.MEDIA_MISSING` / `PKG.VISUAL_CHECK_MISSING` /
  `PKG.VISUAL_CHECK_NOT_PASSING` (HARD, route **media**)
- `FM.IMAGE_DESCRIPTION` (SOFT, `bars_recommended`, route **writer**)

## Disposition

The PKG presence/state codes are HARD ⇒ `block` (route to **media** for a re-source/re-generate or
to attach the missing artifact). `FM.IMAGE_DESCRIPTION` is SOFT — `warn`, `bars_recommended`
(RD-21). A package may instead carry a `PASS_PENDING_MEDIA` verdict when copy passes but media is
still required (§14.2); the missing-media path is a documented review state, not a silent block.

## Example (brand: Acme Cosmos)

- Literal image description (SOFT): `A picture of three builders at a desk.`
- Context-adding caption: `The Acme Cosmos beta floor on day one. Every desk shipped a working
  demo by close.`

## Mutability

`human-only`. Media presence and visual-state requirements are publish-edge guardrails (DD-6),
not tunable by the machine-learning loop.
