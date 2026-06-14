# Runbook: the reviewer approval → publish flow

This is the recurring human-in-the-loop operation: a draft becomes an **approval card**, a named
reviewer decides on it, edits re-enter the gate, and an approved item walks the publish edge with a
**second gate** before anything goes live. The whole flow is fail-closed — no silent publish, no
silent block.

> The approval surface in the reference install is Discord, but the decision **core** is
> surface-neutral. It accepts a normalized interaction and never branches on emoji/buttons (§12.4),
> so the semantics below hold for any surface.

## 1. The approval card

When the pipeline runs an item to `awaiting_approval`, the surface posts an approval card to the
`content-review` channel and the ledger records `preview_posted`. The card presents the recommended
text (and any A/B variants) plus the decision actions: approve, edit, attach media, reject.

In **SAFE** no card is posted (correct — SAFE is artifact-only). In **LIVE_PREVIEW** a real card is
posted with no publish path. In **LIVE** an approved item is handed off draft-only (the second gate).
The mode is resolved by the one ladder (default SAFE, §8.3 / RD-16f).

## 2. Reviewer decision: approve / edit / reject

Every decision is authorized against the **named-reviewer allowlist** (DD-17). A reviewer is an entry
in `config/system.json` `reviewers[]` with explicit `rights`:

- `approve` — required for any **approve** or **reject**.
- `edit` — required for **edit** and **attach media** (edits carry the same authority as approvals,
  §11.2).

The allowlist is **fail-closed**: an empty or missing allowlist authorizes no one; a non-allowlisted
or under-privileged actor is **refused** and nothing is recorded or queued. No reviewer ID is
hardcoded anywhere — confirm `engine status` shows `✓ reviewers` (the wiring self-check fails if no
reviewer has `approve` rights).

The decision outcomes:

- **approve** (`approve_recommended` / `approve_a` / `approve_b`) — records a §7.6 decision and, when
  the reviewer changed nothing, transitions the queue entry to `approved` (the text the reviewer saw
  is unchanged — post-review immutability, DD-20). Each approve carries the selected variant.
- **edit** — *edit-counts-as-approval* (§2.4): the edited text **re-enters the deterministic gate
  subset** (DD-12 / §14.5). On PASS the entry transitions to `edited_approved`; on FAIL the card is
  returned with the reason. No silent publish, no silent block.
- **attach media** — reviewer-attached media re-enters the **cooldown/limit** subset (DD-12). On PASS
  it proceeds as an approval (`approved_pending_media` while the attachment is still re-gating); on
  FAIL the card is returned.
- **reject** — records a §7.6 decision and transitions to `rejected` (audit trail; no publish path).

### Re-gate on edits (DD-12)

The re-gate runs only the deterministic layers wired today (formatting / limits / platform /
cooldown), since those are the layers an edit can affect. An `approve` with neither an edit nor an
attachment **skips** the re-gate. A re-gate FAIL is recorded as an `edit_requested` ledger event with
the reason and the card is returned to the reviewer.

### Concurrency / safety

The decision write goes through the **one canonical queue lock** — the same lock the executor holds,
so a decision and a publish run mutually exclude. If the executor is mid-run the decision returns
`lock_busy` with `retry: true` (the caller is told to retry shortly); the approval is **never**
swallowed and the listener never crashes. A **duplicate guard** refuses to re-queue an item already
in a live post-approval state (`approved` / `edited_approved` / `approved_pending_media` /
`publish_intent` / `handed_off` / `published`).

`REACTION_LISTENER_DRY_RUN=1` records the ledger decision but performs no queue write (documented
diagnostic override, fail-closed default, §4.5).

## 3. The second gate (handoff) and publish

An approved item is walked by the **publish executor** (`orchestrator/publish-executor.js`), which
runs the publish-edge gates on each eligible entry before any external call:

- **approver allowlisted** — `approved_by` must be on the `reviewers[]` allowlist with `approve`
  rights (DD-17, the durable backstop to the listener's check).
- **media complete** — approved copy still pending real media cannot publish.
- **media cooldown** — blocks reuse of an asset inside its hard window (`PKG.MEDIA_COOLDOWN_BLOCKED`),
  reading the canonical usage log (DD-14). See [`../configuration.md`](../configuration.md) for the
  window.
- **publisher registered** — the platform must resolve to a registered adapter (§12.3).
- **not test content** / **no duplicate** — test ids never publish; an already-published id never
  republishes.

Any gate failure parks the entry in `manual_review` with the reasons recorded — never a silent block.

### Mode ladder at the edge

- **SAFE / LIVE_PREVIEW** — gates run, but **no publisher call** is made. The item stays put. This is
  expected, not a failure.
- **LIVE** — the executor performs the **write-ahead intent** (`publish_intent`, persisted before any
  external call — DD-4), increments the durable attempt counter (DD-13), then hands the item to the
  publisher adapter. The default posture is **draft-only**: the adapter creates a draft and the entry
  becomes **`handed_off`**.

### `handed_off` is the expected LIVE state

`handed_off` means *a draft exists at the publisher and is awaiting your manual publish* — "approved
but nothing posted yet" is the normal LIVE state, not a stall (§8.3). To complete it:

1. Publish the draft in the publisher.
2. The next executor tick's `verifyStatus` poll confirms the backend state and advances the entry
   `handed_off → published`. A confirmed publish writes the usage log (cooldown lineage, DD-14).

An ambiguous handoff (timeout / dropped connection / unverifiable) parks as **`interrupted_hold`**
rather than retrying — the artifact may exist (DR W#35). A definite backend rejection is a retryable
`failed_handoff` within the bound of **3**; on exhaustion it `dead_lettered` and an "unfilled slot"
notice is posted (no automatic redraft — cost containment).

A direct-publish adapter (e.g. Giphy) goes straight to `published` with no second gate.

## Watch it

```
engine status
```

Shows queue-state counts (with `handed_off` glossed as *awaiting operator publish*), the oldest queue
item's age, today's produced/published/failed, and failure-code tallies. For a single item, read its
ledger record under `$CONTENT_HOME/ledger/records/<content-id>.json`.

## See also

- [`recover-from-stall.md`](recover-from-stall.md) — releasing `interrupted_hold`, clearing a stuck
  queue.
- [`../troubleshooting.md`](../troubleshooting.md#stuck-queue-entries-and-the-ones-that-arent-stuck) —
  what each non-terminal queue state means.
- [`../setup/discord.md`](../setup/discord.md) and
  [`../../templates/channels.md`](../../templates/channels.md) — wiring the approval surface +
  reviewer allowlist.
- [`../../rules/codes.md`](../../rules/codes.md) — the publish-edge failure codes.
