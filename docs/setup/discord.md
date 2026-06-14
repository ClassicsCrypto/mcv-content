# Discord setup

Discord is the v1 reference **approval surface**: the engine posts approval cards to a channel, a
named reviewer reacts to approve/edit/reject, and a listener captures the attributed decision. This
is the most error-prone external procedure in setup, so it gets the most explicit checklist. The
canonical, step-by-step checklist lives in [`../../templates/channels.md`](../../templates/channels.md);
this doc is the agent-first narration around it and the why.

> Channel auto-creation is **not** in v1. The supported path is the manual checklist plus the
> `engine verify --setup c1` verifier. (Auto-creation is on the roadmap.)

## What you will produce

1. A Discord **bot application** with a token, invited to your server with a **minimum** permission
   set (no admin, no manage-guild).
2. Four channels mapped to roles (plus one optional), whose ids you record into
   `config/system.json`'s `approval_surface.channels`.

You will set `DISCORD_BOT_TOKEN` in `$CONTENT_HOME/.env` and the channel ids in `system.json`. The
C1 verifier confirms the token is present and every required channel role is bound to a real id.

## Step 1 — Create the bot application and token

In the Discord developer portal:

1. **New Application** — name it anything (this is your bot, not a brand).
2. **Bot** tab → add a bot user. Copy the **bot token** and put it in `$CONTENT_HOME/.env`:

   ```
   DISCORD_BOT_TOKEN=<your-bot-token>
   ```

   The token is a Tier-1 secret consumed *only* by the approval-surface adapter (listener, card
   poster, readback) — never by pipeline agents. If you ever rotate it, update this `.env` and
   restart the listener; a missing/invalid token fails fast (the engine does **not** retry credential
   resolution — see [`../troubleshooting.md`](../troubleshooting.md#bot-token-invalid--rotation)).

## Step 2 — Invite the bot with the minimum permission set

Generate an invite (OAuth2 URL) with the bot scope and **only** these permissions:

- View Channels / Read Messages
- Send Messages
- Embed Links
- Attach Files
- Add Reactions
- Read Message History
- Use Threads (only where you use threads)

**Do not grant Administrator or Manage Server / Manage Guild.** The approval surface needs to read,
post, react, and attach in its bound channels — nothing more. The C1 verifier's `discord_token`
check confirms the token is present; the permission set is verified sufficient by being able to
post/react in each bound channel during your first `LIVE_PREVIEW` run.

## Step 3 — Create the channels and record their ids

Create four channels and map each to a role. Use whatever names you like; the *role* is what
`system.json` binds, by id:

| Role (config key) | Purpose |
|---|---|
| `content-review` | approval cards are posted here; reviewers react to approve/edit/reject |
| `content-published` | a published-confirmation log |
| `content-ops` | the daily digest and heartbeat/stall alerts |
| `media-bank` | reviewer-attached / operator-staged media |
| `trend-readout` *(optional)* | trend readouts, when the trend pathway is used |

Enable Developer Mode in Discord, right-click each channel → **Copy Channel ID**, and bind them in
`config/system.json`:

```jsonc
"approval_surface": {
  "adapter": "discord",
  "channels": {
    "content-review":    "<CHANNEL_ID>",
    "content-published": "<CHANNEL_ID>",
    "content-ops":       "<CHANNEL_ID>",
    "media-bank":        "<CHANNEL_ID>"
  }
}
```

Channel ids are Tier-3 instance constants — they live in `system.json`, never in code, and the
templates ship `<CHANNEL_ID>` placeholders. The C1 verifier rejects leftover placeholders.

## Step 4 — Verify

```
engine verify --setup c1
```

The `channel_bindings` check passes when all four required roles are bound to non-placeholder ids;
`discord_token` passes when `DISCORD_BOT_TOKEN` resolves. (Other C1 checks cover the reviewer
allowlist, budget caps, the publish posture, and lock-dir writability — see
[`brand.md`](brand.md).)

## Approval semantics (what the reviewer does)

The card carries a recommended variant plus Variant A and Variant B, any soft-code warnings, and a
"why it's strong" rationale. The reviewer's actions — approve recommended / approve A / approve B /
edit / attach media / reject — are defined by the **card schema**, not by which emoji you press; the
Discord reaction mapping is reference-implementation detail. Key invariants:

- **Every decision is attributed** to an allowlisted reviewer, and **edits require the same rights as
  approvals**.
- An **edit counts as approval** but re-enters the deterministic gate subset (limits, formatting,
  platform, cooldown) before publish — *without* a second LLM review. The card states this.
- **Nothing publishes without exactly one recorded decision.**

The decision capture daemon is `engine/orchestrator/reaction-listener.js`; it reads the allowlist
from config. See [`../extending.md`](../extending.md#approval-surface) for swapping the surface and
[`../../templates/channels.md`](../../templates/channels.md) for the full manual checklist.
