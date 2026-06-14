# Platform setup

How to connect publishers, what each platform tier means in v1, and how to install the scheduler
triggers that make the system run on its own. Publisher integration is **deferrable until LIVE** —
SAFE and LIVE_PREVIEW operation (producing real approval cards) needs no publisher at all.

## Platform tiers (v1)

| Platform | Lane | Publisher | Status |
|---|---|---|---|
| Twitter/X | flagship text-heavy chain | Postiz (draft-by-default second gate) | **supported** |
| Giphy | direct publisher adapter | Giphy (platform-direct) | **supported** |
| Instagram | via Postiz | Postiz | beta |
| Facebook | via Postiz | Postiz | beta |
| YouTube | via Postiz | Postiz | beta |
| TikTok | documented manual path only | — | **out of v1** |

- **Supported** lanes get maintainer triage.
- **Beta** lanes depend on the upstream Postiz publisher; issues are upstream-dependent and triaged
  best-effort.
- **TikTok is out of v1.** It graduates only when the upstream publisher path can honestly report
  publish status (the `verifyStatus` contract — see [`../extending.md`](../extending.md)). Until then, use
  the manual path: the engine produces and gates the content and you publish by hand.

Per-platform setup detail lives in [`../platforms/`](../platforms/) (twitter, giphy, instagram,
facebook, youtube, tiktok).

## Postiz (Twitter/X, Instagram, Facebook, YouTube)

Postiz is a self-hostable open-source social-media publishing service. It is the v1 publisher backend
for Twitter/IG/FB/YT and the carrier of the **draft-only second gate**: approved posts land as drafts
the operator publishes in Postiz.

1. **Stand up or point at a Postiz instance.** Put the credentials in `$CONTENT_HOME/.env`:
   ```
   POSTIZ_API_KEY=<your-key>
   POSTIZ_API_URL=<your-postiz-url>
   ```
   Both are required together; set both or neither (the C1 verifier flags a half-configuration).
   They are consumed only by the Postiz publisher adapter and the analytics pull — never by chain
   seats.
2. **Connect each brand's account in Postiz**, then record the integration id Postiz shows for the
   connected account as `platforms[].integration_ref` in `brands/<id>/brand.json`. This is the
   account-connection step (C2); it is deferrable exactly as long as publishing is.

The flagship Twitter/X lane publishes through Postiz; there is no v1 direct-Twitter adapter.

## Giphy (direct)

Giphy is the second platform and the platform-direct case (it does not go through Postiz). Put the
credentials in `$CONTENT_HOME/.env`:

```
GIPHY_API_KEY=<your-key>
GIPHY_USERNAME=<your-giphy-username>
```

`GIPHY_API_KEY` is a Tier-1 secret, `GIPHY_USERNAME` is a Tier-3 identifier; both are consumed only
by the Giphy publisher adapter. In `brand.json`, the Giphy lane uses `publisher: "giphy"` and leaves
`integration_ref` null. The Giphy adapter preserves a fail-closed dual env-gate, normalized through
the publisher seam (see [`../extending.md`](../extending.md#publisher-adapters)).

## TikTok (manual path)

There is **no automated TikTok publishing in v1.** The chain still produces and gates TikTok content
(the platform gates `PLAT.TIKTOK_*` check for a first-3-seconds hook and a cover frame). To publish:
approve the card as usual, then upload manually to TikTok. Do not configure a TikTok publisher; the
platform descriptor exists for content production and the manual path only.

## Going LIVE

Publishing requires:

1. A reachable publisher with credentials in `.env` (Postiz for Twitter/IG/FB/YT; Giphy for Giphy).
2. Each brand×platform account connected (`integration_ref` recorded, or Giphy credentials present).
3. `config/system.json` `mode` set to `LIVE` on an `operational` project.

In LIVE, approval hands off **draft-only** by default: the queue entry shows `handed_off` and the
post sits as a draft in the publisher until you publish it there; the executor's `verifyStatus` poll
then advances it to `published`. "Approved but nothing posted yet" (`handed_off`) is the expected
LIVE-mode state, not a failure. Removing the second gate (auto-publish) is a mechanically-gated,
per-brand×platform risk-posture change — see
[`../configuration.md`](../configuration.md#auto-publish-trust-state).

## Scheduler triggers

The engine runs on triggers you install from `templates/scheduler/` (recipes ship for Windows Task
Scheduler, cron, and PM2 — pick one process supervisor or OS scheduler). The triggers and their
default cadences (from `config/system.json` `scheduler`):

| Trigger | What it does | Default cadence |
|---|---|---|
| daily kickoff | reads the calendar + campaign overlays, enqueues the day's slot runs (staggered, bounded) — **the canonical trigger** | once daily at `kickoff_time` |
| executor interval | walks the queue, runs the publish gates, hands off approved items | every `executor_interval_minutes` (5) |
| analytics interval | collects engagement checkpoints | every `analytics_interval_minutes` (240) |
| card-TTL sweep | expires/escalates approval cards, returns or escalates slots | every `ttl_sweep_interval_minutes` (60) |
| approval listener | the decision-capture daemon | always running |
| calendar tick *(optional)* | fires slots due within a look-ahead window | off by default (`tick_enabled`) |

Two rules:

- **Safety posture never lives in the scheduler wrapper.** Mode, budget caps, and the pause sentinel
  live in declared config; the recipes only set `CONTENT_HOME` and invoke `engine` verbs.
- **Single-runner lock per project.** Overlapping runs are skipped-and-logged (`skipped_on_overlap`),
  not forced. Every run records a named trigger so `engine status` can report last-run-per-trigger.

### How a run actually happens

The engine never calls a chain-seat LLM. A trigger writes a **slot-run task record** to
`$CONTENT_HOME/ledger/tasks/`; your host runtime consumes it through a documented hook and runs the
seats. No task record, no run. On the OpenClaw reference runtime this is automatic (a scheduled host
job polls the tasks dir); on any other runtime the degenerate hook — prompting the agent with the
pending task — always satisfies the contract. See [`../runtimes/generic.md`](../runtimes/generic.md) and
[`../runtimes/openclaw.md`](../runtimes/openclaw.md).

For an ad-hoc run without a calendar entry, `engine run-slot <slot-id>` (validated against the
calendar) or `engine dispatch --family RUN_SLOT --brand … --platform …` writes one task record
immediately.

## See also

- [`../configuration.md`](../configuration.md) — the `scheduler`, `publish`, and per-platform `brand.json` keys.
- [`../cost.md`](../cost.md) — which services are metered and the spend split.
- [`../extending.md`](../extending.md) — adding a publisher adapter or a new platform descriptor.
- [`../troubleshooting.md`](../troubleshooting.md) — publisher-down, trigger-didn't-fire, stuck `handed_off`.
