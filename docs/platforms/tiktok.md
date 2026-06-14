# TikTok (out of v1 — manual path)

> **TikTok has no automated publishing in v1** (RD-7). The engine still **produces and gates** TikTok
> content; you publish the finished asset to TikTok **by hand**. Do not configure a TikTok publisher —
> none ships.

- **Workflow class:** visual-heavy.
- **Publisher:** `manual` — a documented manual-upload path; no automated adapter.
- **Support status:** **manual / out of v1.**

## Why TikTok is out of v1

The engine's honesty contract is the publisher seam's `verifyStatus` truth-check (§12.3): an adapter
may only report `published` when its backend can **honestly confirm the post is actually live**. The
available upstream TikTok publish path has a **false-`PUBLISHED` defect** — it reports a post as
published when it has not actually gone live. An adapter built on that path would lie to the queue,
fabricating a `published` state.

The seam forbids exactly this: when a backend cannot confirm publish state, the adapter must return
`unverifiable` (or hold), **never a fabricated `published`**. Because the TikTok path cannot satisfy
that contract, no TikTok adapter ships in v1. (The cautionary publisher-contract test pins this
behavior so a future adapter cannot regress it.)

**TikTok graduates** to an automated lane the moment the upstream publisher path reports publish
status **truthfully** — i.e. when `verifyStatus` can be honest for TikTok (roadmap; see
[`../extending.md`](../extending.md)). Until then, the manual path below is the supported path.

## The manual upload path

The chain treats TikTok as a first-class **content production** lane — it just stops short of
auto-publishing:

1. **Produce + gate as usual.** The chain drafts, packages, and gates the TikTok item. The TikTok
   packaging rules are HARD and still apply:
   - `PLAT.TIKTOK_HOOK_3S_MISSING` — the package must declare its first-3-seconds hook.
   - `PLAT.TIKTOK_COVER_FRAME_MISSING` — the package must declare its cover frame.

   See [`../../rules/platform/tiktok.md`](../../rules/platform/tiktok.md).
2. **Approve the card.** Approve the TikTok approval card in Discord exactly as for any lane (the
   first gate).
3. **Upload by hand.** Take the approved, gated asset and **upload it to TikTok manually.** The engine
   does not call TikTok; there is no `handed_off`/`verifyStatus` cycle for this lane.

Because there is no automated handoff, there is no draft second gate and no `published` transition
driven by the engine — the manual upload *is* the publish step.

## Credentials

**None.** Do not set any TikTok credential and do not bind a TikTok publisher in `brand.json`. The
TikTok platform descriptor exists for **content production and the manual path only**; its
`publisher` is `manual` and its `support_status` is `manual`.

## See also

- [`twitter.md`](twitter.md) — the flagship automated lane (the second-gate / `verifyStatus` model
  TikTok cannot yet satisfy).
- [`../setup/platforms.md`](../setup/platforms.md#tiktok-manual-path) — TikTok in the platform-tier
  table and the manual path in context.
- [`../extending.md`](../extending.md) — the §12.3 `verifyStatus` contract that gates TikTok's
  graduation, and how to add a platform when it does.
