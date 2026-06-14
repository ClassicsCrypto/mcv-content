# Twitter/X (v1 flagship)

Twitter/X is the **v1 flagship lane** (RD-7): the full text-heavy chain, end to end. It is the most
exercised path in the engine and the one the first-publish walkthrough below narrates. If you are
standing up the engine for the first time, this is the lane to start with.

- **Workflow class:** `TEXT_HEAVY` — copy is drafted first; media (if any) is attached after.
- **Publisher:** Postiz, draft-by-default (the [second gate](#the-second-gate-83)).
- **Support status:** **supported** — gets maintainer triage.
- **Chains supported:** single posts and multi-post threads (the packager splits `N/M`-marked
  thread copy into segments — see [Packager behavior](#packager-behavior)).

## What this lane supports in v1

- Single text posts and **text-heavy threads** (the chain's core competency).
- An optional leading media attachment (image/GIF/video) on the first post of a thread.
- The full deterministic + LLM gate stack, including the Twitter packaging rule
  (`PLAT.TWITTER_HASHTAG_PRESENT`, HARD) — **the flagship lane bans hashtags in copy**, because
  they read as engagement-bait. See [`../../rules/platform/twitter.md`](../../rules/platform/twitter.md).

There is **no v1 direct-Twitter adapter.** The platform-direct `X_BEARER_TOKEN` is explicitly ruled
out for v1 (RD-11): Twitter/X publishes through Postiz. A future direct adapter would have to add a
named credential row through the §12.3 publisher seam — see [`../extending.md`](../extending.md).

## Required credentials

Set in `$CONTENT_HOME/.env` (names only — never commit the values; see
[`../setup/platforms.md`](../setup/platforms.md) for the full procedure):

| Variable | Required | Notes |
|---|---|---|
| `POSTIZ_API_KEY` | for publishing | Tier-1 secret. Consumed only by the Postiz adapter + the analytics pull. |
| `POSTIZ_API_URL` | with the key | Set both or neither; the C1 verifier flags a half-configuration. |

Per brand, record the Postiz integration id for the connected Twitter/X account as
`platforms[].integration_ref` in `brands/<id>/brand.json` (the C2 account-connection step). The
adapter refuses to hand off without it. Both `.env` credentials and `integration_ref` are
**deferrable until you go LIVE** — SAFE and LIVE_PREVIEW need no publisher at all.

## Packager behavior

The packager produces the final Twitter/X post(s) the adapter hands off:

- **Threads.** Copy carrying `N/M` segment markers (e.g. a line that is just `1/4`) is split into one
  post per segment; the markers delimit the boundaries. Copy with no markers is a single post.
- **Leading media.** A media attachment rides on the **first** segment only; later segments are text.
- **Hashtag strip.** The platform gate is HARD: a `#hashtag` in copy fires
  `PLAT.TWITTER_HASHTAG_PRESENT` and routes back to the packager, which removes it and re-packages.

## Publish flow

In LIVE, the executor walks the queue each interval and drives this state path per approved item:

```
approved
  → publish_intent      (write-ahead intent persisted BEFORE any publisher call — DD-4)
  → handed_off          (adapter.handoff created a Postiz DRAFT — the second gate)
  → published           (a later tick's verifyStatus poll confirmed the post is live)
```

`handoff` is **idempotent by `content_id`**: handing the same item off twice never creates a second
draft (if the create response carries no id, the adapter looks up the just-created draft in a time
window and resolves to the same one). An ambiguous outcome (timeout / dropped connection) parks the
entry in `interrupted_hold` for explicit operator release rather than blind-retrying a publish.

### The second gate (§8.3)

LIVE handoff is **draft-only by default**. The chain's first gate is the Discord approval card; the
**second gate** is the draft sitting in Postiz that *you publish by hand*:

1. The reviewer approves the card in Discord (first gate).
2. `adapter.handoff` creates a **draft** in Postiz; the queue entry advances to `handed_off`.
3. **The operator opens Postiz and publishes the draft** — this is a deliberate human action.
4. On a later executor tick, `adapter.verifyStatus` polls Postiz, sees the post is live, and advances
   the entry `handed_off → published` (recording the post URL and publish time).

> **"Approved but nothing posted yet" (`handed_off`) is the expected LIVE-mode state, not a failure.**
> The queue view, `engine status`, and this walkthrough all say so explicitly. The post only goes live
> when you publish the draft in Postiz.

`verifyStatus` is honest by construction: a still-draft stays `handed_off`, an unknown ref is held,
an outage is retried next tick, and **only a backend-confirmed live post becomes `published`** — it
never fabricates a publish. (That honesty is exactly the contract TikTok cannot satisfy in v1 — see
[`tiktok.md`](tiktok.md).)

### First-publish walkthrough (cold start)

What you see, end to end, the first time you publish on this lane:

1. **Card.** The chain posts an approval card to your Discord review channel with the Recommended
   variant (and A/B alternates if any), plus any soft-warning notes.
2. **Approve.** A named reviewer reacts to approve (an edit counts as approval and re-enters the
   deterministic gate subset before publish).
3. **`handed_off`.** The executor writes `publish_intent`, calls `handoff`, and a **draft** appears in
   Postiz. The queue entry now reads `handed_off`. Nothing is public yet — this is correct.
4. **Operator publishes.** You open Postiz, review the draft, and publish it.
5. **`verifyStatus`.** On the next executor tick the adapter polls Postiz, confirms the post is live,
   and advances the entry to `published` with the post URL.
6. **Usage write-back + analytics.** The published item is archived; analytics checkpoints (1h / 24h /
   7d) are collected on the configured interval via `fetchMetrics`.

Removing the second gate (per-brand×platform auto-publish) requires **both** explicit opt-ins
(`POSTIZ_DRAFT_ONLY=0` *and* `POSTIZ_AUTO_PUBLISH_ALLOWED=1`, canonical home in
`config/system.json`) and is a mechanically-gated risk-posture change — see
[`../configuration.md`](../configuration.md#auto-publish-trust-state).

## See also

- [`../setup/platforms.md`](../setup/platforms.md) — connecting Postiz + recording `integration_ref`.
- [`giphy.md`](giphy.md) · [`instagram.md`](instagram.md) · [`facebook.md`](facebook.md) ·
  [`youtube.md`](youtube.md) · [`tiktok.md`](tiktok.md) — the other v1 lanes.
- [`../extending.md`](../extending.md) — the §12.3 publisher seam and adding a platform.
- [`../troubleshooting.md`](../troubleshooting.md) — stuck `handed_off`, publisher-down.
