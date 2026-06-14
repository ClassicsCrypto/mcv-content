---
id: rule.platform.instagram
title: Instagram packaging rules
scope: platform
platforms: [instagram]
category: packaging
severity: hard
disposition: block
bars_recommended: false
codes: [PLAT.INSTAGRAM_HASHTAG_OVER_LIMIT]
mutability: human-only
version: 1.0.0
provenance: shipped
tests: [gate-regression/platform-instagram/*]
---

<!-- release-spec §10.1, §10.2 (PLAT.* family), §14.1 layer 3, RD-7 (Instagram = beta via Postiz).
     Deterministic enforcement: engine/gate/platform-gates.js (instagram module). The hashtag
     count limit is config (the platform descriptor's limits), not hardcoded. -->

# Instagram packaging rules

Per-platform deterministic gate for the Instagram beta lane (RD-7). Unlike Twitter, Instagram
allows hashtags but caps their count.

## What is checked

- **Hashtag count limit.** An Instagram package whose hashtag count exceeds the configured limit
  fires `PLAT.INSTAGRAM_HASHTAG_OVER_LIMIT` (HARD).

## Code

- `PLAT.INSTAGRAM_HASHTAG_OVER_LIMIT` (HARD, route **packager**).

## Disposition

HARD ⇒ `block`. The packager trims hashtags to the configured limit.

## Configuration

The limit lives in the Instagram platform descriptor (`limits`, §12.6); operators tune it there.

## Example (brand: Acme Cosmos)

- With the limit set to 5, an Acme Cosmos Instagram package carrying 12 hashtags fires
  `PLAT.INSTAGRAM_HASHTAG_OVER_LIMIT`.

## Mutability

`human-only`. Platform packaging limits are descriptor config (§12.6); not tunable by the
machine-learning loop.
