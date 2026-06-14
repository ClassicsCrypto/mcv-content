---
id: rule.visual.identity
title: Visual brand-identity presence
scope: brand
category: media
severity: hard
disposition: block
bars_recommended: false
codes: [VIS.IDENTITY_MISSING]
mutability: human-only
version: 1.0.0
provenance: shipped
tests: [gate-regression/visual-default-pack/*]
---

<!-- release-spec §10.1, §10.2 (VIS.* family), §14.1 visual layer, §10.3 (visual-check default
     question pack). Enforcement: engine/gate/visual-check/. The identity gate is data-driven by
     the question pack (rules/visual/default-pack.json -> pass.require_identity); the brand
     identity content is operator data, never shipped (§0.3 r6). -->

# Visual brand-identity presence

When the question pack marks an item identity-required, the rendered image must carry an
unmistakable brand identity cue (logo, mascot, owned art style, named character — whatever the
brand's pack defines). This is the only-when-required half of the visual gate: many formats do not
need a brand identity element, so the check is gated by the pack's `require_identity` setting.

## What is checked

- **Required identity element present.** For items the pack marks `identity_required`, the vision
  model must confirm a brand identity cue is present; absent ⇒ `VIS.IDENTITY_MISSING` (HARD). For
  items not marked identity-required, the check does not fire.

## Code

- `VIS.IDENTITY_MISSING` (HARD, route **media**) — re-source or re-generate an image that carries
  the brand identity cue.

## Disposition

HARD ⇒ `block`. An identity-required image with no brand cue does not pass.

## Configuration

The identity gate is declarative in the question pack:
`pass.require_identity: {key, when_required}`. The brand's actual identity cues are defined in the
brand's pack (`$CONTENT_HOME/brands/<brand>/visual-pack.json`), never in this repo (§0.3 r6).

## Example (brand: Acme Cosmos)

- An Acme Cosmos hero-image item marked identity-required renders with no Acme Cosmos mascot or
  owned art cue ⇒ `VIS.IDENTITY_MISSING`.

## Mutability

`human-only`. The identity requirement is a brand guardrail (DD-6); operators author the pack, the
machine-learning loop cannot disable it.
