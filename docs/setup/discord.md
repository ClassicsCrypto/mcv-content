# Discord setup

Discord is the v1 reference **approval surface**: the host runtime posts approval cards to a channel,
a named reviewer reacts to approve/edit/reject, and the runtime/adapter captures the attributed decision. This
is the most error-prone external procedure in setup, so it gets the most explicit checklist. The
canonical, step-by-step checklist lives in [`../../templates/channels.md`](../../templates/channels.md);
this doc is the agent-first narration around it and the why.

> Channel auto-creation is runtime-owned. If your host runtime can create channels, use that live
> connector. Otherwise use the manual checklist plus the `engine verify --setup c1` verifier.

## What you will produce

1. Four channels mapped to roles (plus one optional), whose ids you record into
   `config/system.json`'s `approval_surface.channels`.
2. Host-runtime Discord permissions to post/read/react in those channels.

You will set channel ids in `system.json`. The C1 verifier confirms every required channel role is
bound to a real id; actual Discord posting permission is owned by the host runtime.

## Step 1 — Confirm host Discord access

Use the Discord connector built into your host runtime or subscription plan. Confirm it can:

- view/read the bound channels;
- send messages;
- attach files;
- add/read reactions;
- read message history.

**Do not grant Administrator or Manage Server / Manage Guild unless your operating policy explicitly
requires it.** The approval surface needs to read, post, react, and attach in its bound channels —
nothing more. Permission sufficiency is verified by posting/reacting in each bound channel during
your first `LIVE_PREVIEW` run.

## Step 2 — Create the channels and record their ids

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

## Step 3 — Verify

```
engine verify --setup c1
```

The `channel_bindings` check passes when all four required roles are bound to non-placeholder ids.
Other C1 checks cover the reviewer allowlist, budget caps, the publish posture, and lock-dir
writability — see [`brand.md`](brand.md).

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
