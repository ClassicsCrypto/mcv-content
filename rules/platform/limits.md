---
id: rule.platform.limits
title: Length limits
scope: platform
platforms: [twitter, instagram, tiktok, youtube, facebook, giphy]
category: packaging
severity: hard
disposition: block
bars_recommended: false
codes: [LINT.LENGTH]
mutability: human-only
version: 1.0.0
provenance: shipped
tests: [gate-regression/limits/*]
---

<!-- release-spec §10.1, §10.2 (LINT.* / platform limits), §12.6 (platform descriptor limits).
     Deterministic enforcement: engine/gate/pre-gate-lint.js (LINT.LENGTH) against the brief's
     target window; platform-descriptor limits feed the window. The actual limits are CONFIG
     (the platform descriptor + the brief's target_chars), not hardcoded brand judgment. -->

# Length limits

Each variant must fit the target character window for its platform and format. The window comes
from the brief's `target_chars` (which a platform descriptor's `limits` informs); when the brief
omits it, a generic platform default applies.

## What is checked

- A variant whose trimmed length is below the window minimum or above the maximum fires
  `LINT.LENGTH` (HARD). Length is measured on whitespace-collapsed text.

## Code

- `LINT.LENGTH` (HARD, route **writer**).

## Disposition

HARD ⇒ `block`. An out-of-window variant routes back to the writer to re-fit.

## Configuration

The window is `[min, max]`. It is set per item by the matcher's brief (`target_chars`) and bounded
by the platform descriptor's `limits` (§12.6). Operators tune per-platform limits via the
descriptor; this rule enforces whatever window the brief carries.

## Example (brand: Acme Cosmos)

- A short-standard Twitter brief targets `[101, 280]`; an Acme Cosmos variant of 312 chars fires
  `LINT.LENGTH`.

## Mutability

`human-only`. Platform limits are descriptor config (§12.6), not tunable by the machine-learning
loop.
