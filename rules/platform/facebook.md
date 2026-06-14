---
id: rule.platform.facebook
title: Facebook packaging rules
scope: platform
platforms: [facebook]
category: packaging
severity: hard
disposition: block
bars_recommended: false
codes: [PLAT.FACEBOOK_COMMUNITY_BRIDGE_MISSING]
mutability: human-only
version: 1.0.0
provenance: shipped
tests: [gate-regression/platform-facebook/*]
---

<!-- release-spec §10.1, §10.2 (PLAT.* family), §14.1 layer 3, RD-7 (Facebook = beta via Postiz).
     Deterministic enforcement: engine/gate/platform-gates.js (facebook module). -->

# Facebook packaging rules

Per-platform deterministic gate for the Facebook beta lane (RD-7). A Facebook package must carry
the community-bridge framing the platform's distribution favors.

## What is checked

- **Community-bridge framing.** A Facebook package must carry community-bridge framing (a hook
  that invites the platform's group/community distribution); absent ⇒
  `PLAT.FACEBOOK_COMMUNITY_BRIDGE_MISSING` (HARD).

## Code

- `PLAT.FACEBOOK_COMMUNITY_BRIDGE_MISSING` (HARD, route **packager**).

## Disposition

HARD ⇒ `block`. The packager adds the community-bridge framing.

## Example (brand: Acme Cosmos)

- An Acme Cosmos Facebook package with no community-bridge framing fires
  `PLAT.FACEBOOK_COMMUNITY_BRIDGE_MISSING`.

## Mutability

`human-only`. Platform packaging rules are descriptor-bound guardrails (§12.6); not tunable by the
machine-learning loop.
