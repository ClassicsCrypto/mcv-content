---
id: rule.platform.tiktok
title: TikTok packaging rules
scope: platform
platforms: [tiktok]
category: packaging
severity: hard
disposition: block
bars_recommended: false
codes: [PLAT.TIKTOK_HOOK_3S_MISSING, PLAT.TIKTOK_COVER_FRAME_MISSING]
mutability: human-only
version: 1.0.0
provenance: shipped
tests: [gate-regression/platform-tiktok/*]
---

<!-- release-spec §10.1, §10.2 (PLAT.* family), §14.1 layer 3, RD-7 (TikTok OUT of v1 — documented
     manual path only; the descriptor + gate ship so a future direct lane has the contract).
     Deterministic enforcement: engine/gate/platform-gates.js (tiktok module). -->

# TikTok packaging rules

TikTok is **out of v1** as an automated lane (RD-7) — the supported path is the documented manual
one (`docs/platforms/tiktok-manual.md`). The descriptor and these gates ship so the lane has a
ready contract; the gates still apply to any TikTok package that reaches them.

## What is checked

- **First-3-seconds hook declared.** A TikTok package must declare its first-3-seconds hook;
  absent ⇒ `PLAT.TIKTOK_HOOK_3S_MISSING` (HARD).
- **Cover frame declared.** A TikTok package must declare its cover frame; absent ⇒
  `PLAT.TIKTOK_COVER_FRAME_MISSING` (HARD).

## Codes

- `PLAT.TIKTOK_HOOK_3S_MISSING` (HARD, route **packager**)
- `PLAT.TIKTOK_COVER_FRAME_MISSING` (HARD, route **packager**)

## Disposition

HARD ⇒ `block`. The packager adds the missing hook/cover-frame declaration.

## Example (brand: Acme Cosmos)

- An Acme Cosmos TikTok package with no first-3-seconds hook declared fires
  `PLAT.TIKTOK_HOOK_3S_MISSING`.

## Mutability

`human-only`. Platform packaging rules are descriptor-bound guardrails (§12.6); not tunable by the
machine-learning loop.
