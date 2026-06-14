---
id: rule.platform.twitter
title: Twitter/X packaging rules
scope: platform
platforms: [twitter]
category: packaging
severity: hard
disposition: block
bars_recommended: false
codes: [PLAT.TWITTER_HASHTAG_PRESENT]
mutability: human-only
version: 1.0.0
provenance: shipped
tests: [gate-regression/platform-twitter/*]
---

<!-- release-spec §10.1, §10.2 (PLAT.* family), §14.1 layer 3, RD-7 (Twitter/X = v1 flagship).
     Deterministic enforcement: engine/gate/platform-gates.js (twitter module). -->

# Twitter/X packaging rules

Per-platform deterministic gate for the flagship lane (RD-7). Twitter/X copy must carry no
hashtags.

## What is checked

- **No hashtags.** A Twitter/X package containing a `#hashtag` in copy fires
  `PLAT.TWITTER_HASHTAG_PRESENT` (HARD). Hashtags read as engagement-bait on the flagship lane.

## Code

- `PLAT.TWITTER_HASHTAG_PRESENT` (HARD, route **packager**).

## Disposition

HARD ⇒ `block`. The packager removes the hashtag and re-packages.

## Example (brand: Acme Cosmos)

- Rejected: `The Acme Cosmos beta is live. #web3 #launch`
- Accepted: `The Acme Cosmos beta is live. Link in the next post.`

## Mutability

`human-only`. Platform packaging rules are descriptor-bound guardrails (§12.6); not tunable by the
machine-learning loop.
