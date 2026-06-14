---
id: rule.core.cooldown
title: Media reuse cooldown
scope: brand
category: media
severity: hard
disposition: block
bars_recommended: false
codes: [PKG.MEDIA_COOLDOWN_BLOCKED]
mutability: human-only
version: 1.0.0
provenance: shipped
tests: [gate-regression/cooldown/*]
---

<!-- release-spec §10.1, §10.2, §10.3 (media cooldown rule — the spec exemplar), §8.6, DD-14.
     Deterministic enforcement at the publish edge: engine/gate/validate-package.js +
     engine/library/usage-log.js (the canonical cooldown write-back). The cooldown windows are
     CONFIG (config/system.json cooldown {hard_days, target_days}; per-brand overrides in
     brand.json), not hardcoded — this rule ships the contract and the shipped defaults. -->

# Media reuse cooldown

An asset or its derivatives MUST NOT be reused more often than the brand's hard window; the target
window is the looser preference the system aims for.

> **Shipped defaults (config-tunable):** an asset or its derivatives MUST NOT be reused more often
> than once per **14 days** (hard floor), target once per **30 days**.

## What is checked

- **Family/descendant reuse.** The chosen media — or a modified descendant, cropped still, or
  lightly refit version of it (the asset family) — was used inside the hard cooldown window. Fires
  `PKG.MEDIA_COOLDOWN_BLOCKED` (HARD). The check resolves the asset's family key and the days since
  the family was last used, against the configured window.
- The write-back that records each use (so the next run can see it) is the canonical usage log
  (`engine/library/usage-log.js`), written on confirmed publish (DD-14) and reconciled if the item
  is killed at the publisher's second gate.

## Code

- `PKG.MEDIA_COOLDOWN_BLOCKED` (HARD, route **media**) — re-source or re-generate a distinct asset.

## Disposition

HARD ⇒ `block`. A media item inside cooldown does not publish; the media seat must choose a
different asset. The hard floor is a deterministic backstop, not a soft preference.

## Configuration

- System default: `config/system.json` → `cooldown: {hard_days: 14, target_days: 30}`.
- Per-brand override: `brands/<id>/brand.json` → `cooldown_overrides: {hard_days, target_days}`.

## Example (brand: Acme Cosmos)

- The hero image used for the Monday Acme Cosmos post is requested again on Wednesday: within the
  14-day floor ⇒ `PKG.MEDIA_COOLDOWN_BLOCKED`. A cropped version of the same image is treated as
  the same family and is also blocked.

## Mutability

`human-only`. The cooldown floor is a guardrail (DD-6); operators set the windows, the
machine-learning loop cannot shrink the hard floor.
