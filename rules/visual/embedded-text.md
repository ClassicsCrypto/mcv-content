---
id: rule.visual.embedded-text
title: Embedded-text / baked-in markings check
scope: global
category: media
severity: hard
disposition: block
bars_recommended: false
codes: [VIS.EMBEDDED_TEXT]
mutability: human-only
version: 1.0.0
provenance: shipped
tests: [gate-regression/visual-default-pack/*]
---

<!-- release-spec §10.1, §10.2 (VIS.* family), §14.1 visual layer, §10.3 (visual-check default
     question pack). Enforcement: engine/gate/visual-check/. Driven by the pack's
     no_embedded_text string-key answer; the check is brand-neutral (no brand content). -->

# Embedded-text / baked-in markings check

Readable unsolicited text, dates, logos, signage, or pseudo-glyph markings baked into the frame
are rejected. Generated images frequently hallucinate text and dates; a baked-in date that
conflicts with the caption, or a hallucinated logo, is a credibility hazard. This check is
brand-neutral — it asks the vision model what text it can read in the frame and rejects any.

## What is checked

- **No embedded text.** The pack's embedded-text answer (a string listing any readable text /
  dates / logos / signage / pseudo-glyph markings in the frame, or "none") must read as "none".
  Anything else ⇒ `VIS.EMBEDDED_TEXT` (HARD).

## Code

- `VIS.EMBEDDED_TEXT` (HARD, route **media**) — re-source or re-generate a clean frame.

## Disposition

HARD ⇒ `block`. An image with baked-in text/markings does not pass.

## Configuration

Declarative in the question pack: `pass.no_embedded_text` names the string key whose answer must
be "none" (`rules/visual/default-pack.json` ships the brand-neutral default).

## Example (brand: Acme Cosmos)

- A generated Acme Cosmos image with a hallucinated date stamp or a garbled logo in the corner ⇒
  `VIS.EMBEDDED_TEXT`.

## Mutability

`human-only`. The embedded-text guard is a visual guardrail (DD-6); not tunable by the
machine-learning loop.
