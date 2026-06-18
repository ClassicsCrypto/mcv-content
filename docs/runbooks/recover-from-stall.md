# Runbook: recovering from a stalled pipeline

A stall is *nothing moved when something should have*. The engine is built so silent death is not the
failure presentation — `engine status`, the event ledger, and the heartbeat/stall alerts make a stall
visible. This runbook turns "it's stuck" into a diagnosis and a fix.

> First stop, always:
> ```
> engine status
> ```
> It reads (never mutates) every substrate and answers: mode + paused state, queue-state counts and
> the oldest item's age, today's produced/published/failed with failure codes, last run per named
> trigger, pending task records, and the wiring self-check. `--json` for the full object.

## 1. Read the signal

Where the symptom shows up tells you which stage stalled:

- **Heartbeat / stall alerts** (§13) — the proactive surface. Alerts fire on: **no content produced
  today** (`stall_thresholds.no_content_produced_hours`, default 24h), **queue age** (cards older than
  the TTL still pending, `queue_age_alert_hours`, default 24h), **trigger missed** (an expected
  trigger didn't fire), and **analytics gap** (an expected cycle is missing). Tune the thresholds in
  `config/system.json` `observability` (see [`../observability.md`](../observability.md) and
  [`../configuration.md`](../configuration.md#cooldown-card_ttl-retention-observability)).
- **`engine status` → last run per named trigger** — a trigger with no recent run did not fire.
- **`engine status` → queue states + oldest age** — items piling up in one state localize the stall.
- **The event ledger** (`$CONTENT_HOME/ledger/events.jsonl`) — the append-only truth. Every
  transition, gate verdict, decision, and handoff is one JSON line; the per-item rollup is
  `$CONTENT_HOME/ledger/records/<content-id>.json`. This is where you confirm *what actually
  happened* to a specific item.

## 2. Trigger didn't fire (no content produced)

**Symptom:** "no content produced" / "trigger-missed" alert; `engine status` shows no recent
`morning-kickoff` run.

1. Confirm the project isn't paused (`engine status` → `paused`; see §5 below).
2. Confirm the scheduler recipe is installed and running (cron / systemd / Task Scheduler / PM2 /
   OpenClaw) and that it **sets `CONTENT_HOME`** before running `engine kickoff`. Run it by hand to
   prove it:
   ```
   engine kickoff --now
   ```
   It should report the day's dispatch summary and exit 0.
3. **No task record, no run.** A run requires a dispatched slot-run task record under
   `$CONTENT_HOME/ledger/tasks/` that the host runtime then consumes. If records are being **written
   but never consumed**, the stall is the host-runtime hook, not the engine — see
   [`../runtimes/generic.md`](../runtimes/generic.md). `engine status` "pending task records" climbing with no
   corresponding drafts is exactly this signature.

See [`daily-kickoff.md`](daily-kickoff.md) for the full kickoff path.

## 3. Single-runner lock held / overlap

**Symptom:** a kickoff or tick reports `skipped_on_overlap`; or everything is wedged behind a writer.

The kickoff, the tick, the reaction listener, and the publish executor all share the **one canonical
queue lock** (DD-19). Only one writer touches the queue/dispatch path at a time; an overlapping run is
**skip-and-logged** (`skipped_on_overlap`) — normal under concurrency, not an error, and the next
trigger picks up. The lock is heartbeated and mtime-stale-reclaimable, so a *dead* holder's lock is
reclaimed automatically; a *live but slow* holder (big upload) keeps its lock and is never reclaimed
mid-run. If runs are *persistently* skipped, find the long-running holder via the ledger's last
`run_dispatched` / executor activity rather than deleting the lock by hand.

## 4. Stuck queue entries (and the ones that aren't stuck)

Read `engine status` queue states. What each non-terminal state means and the operator action:

- **`handed_off`** — **not stuck.** In LIVE the post is a *draft* in the publisher awaiting your manual
  publish; the executor's `verifyStatus` advances it to `published` only after you publish it there.
  **Action:** publish the draft in the publisher. (Full flow:
  [`approval-publish.md`](approval-publish.md).)
- **`interrupted_hold`** — the executor was interrupted mid-publish (crash / timeout / ambiguous
  outcome) **after** the write-ahead `publish_intent` was persisted. The artifact **may or may not
  exist**, so the entry is quarantined and is **never auto-retried** (auto-retry would risk a
  double-post). **Operator release (the recovery):**
  1. Look up the entry in the publisher (or by its `external_post_ref` / `publish_intent` in the
     ledger record) and determine whether the artifact actually exists.
  2. **If it was published** at the backend, treat it as published (do not re-handoff). The next
     `verifyStatus` tick confirms a real draft/post; an entry whose backend record was genuinely lost
     surfaces as a `handoff_lost` hold for the same inspect-then-decide.
  3. **If it was not published**, set the entry's `state: approved` to re-queue it for a clean retry.
  The `interrupted_hold` `error` field records exactly this instruction.
- **`manual_review`** — a publish-edge gate failed, or retry exhaustion parked it for a human. Read the
  recorded gate reasons, fix the root cause, and decide (re-queue or abandon).
- **`failed_handoff`** — the publisher handoff failed (outage class) and is **retrying** within the
  bound of 3. If it keeps failing the publisher is down (§6); on bound exhaustion it dead-letters.
- **`dead_lettered`** — gave up after the retry bound (`SYS.RETRY_EXHAUSTED`); an "unfilled slot"
  notice was posted. **No automatic redraft** (cost containment) — redraft is your choice.
- **`skipped_on_overlap`** — see §3; normal.

## 5. Pause / resume (the kill switch, §15.4)

**Symptom:** dispatch refuses with `EPAUSED`; `engine status` shows `paused`.

`engine pause` writes the `PAUSED` sentinel at `$CONTENT_HOME/PAUSED` **and** sets
`config/system.json` `paused: true`, halting **every** autonomous loop in one action — triggers, task
dispatch, the executor, analytics, ttl-sweep. Each loop checks the sentinel first. To recover:

```
engine pause   --reason "<why>"     # engage (idempotent; records the reason)
engine resume                       # reverse (removes the sentinel, clears the flag; idempotent)
```

The sentinel is authoritative for the loops; the config flag is the durable record `engine status`
reads. Both verbs are idempotent — pausing an already-paused project (or resuming a running one) is a
safe no-op-plus-report. A refused-by-design dispatch **exits 0** — the system behaving correctly, not
an error.

`EBUDGET` is the budget kill switch: the engine-metered spend cap was breached, the project paused,
and dispatch stopped (stopping dispatch stops new chain spend too — the spend line is honestly scoped;
see [`../cost.md`](../cost.md)). Review spend against caps, raise the cap or wait for the window, then
`engine resume`.

## 6. Publisher down (auth vs outage)

**Symptom:** approvals are retained but nothing reaches `published`; `failed_handoff` accumulates.

The queue is authoritative, so nothing is lost. The executor distinguishes **outage** (timeouts / 5xx
/ unreachable → bounded retry with backoff) from **auth failure** (401/403 → permanent, halt + alert,
never the retry path). Misclassifying auth as outage is the recorded crash-loop failure mode.

- **Outage:** bring the publisher back; approved-unpublished items resume on the next tick.
- **Auth:** fix the credential and restart the consumer — see
  [`rotate-credentials.md`](rotate-credentials.md). The same auth-vs-outage split halts the analytics
  collector (see [`weekly-analytics.md`](weekly-analytics.md)).

## 7. Wiring failure

If `engine status`'s self-check shows a `✗` (e.g. `content_home`, `config_present`, `reviewers`,
`channel_bindings`, `approval_surface_permissions`, `publisher`), the named line carries the remediation. A missing reviewer-with-approve
blocks the approval flow; missing host Discord permissions block the approval surface; an unresolvable
`CONTENT_HOME` blocks everything. Fix the named item, restart the affected consumer, re-check.

## See also

- [`../troubleshooting.md`](../troubleshooting.md) — the full symptom → check → fix index.
- [`../observability.md`](../observability.md) — `engine status`, the ledger, the digest, alerts, KPIs.
- [`../architecture.md`](../architecture.md#3-the-content-item-state-machine) — what each queue state
  means and the durability promises.
- [`../../rules/codes.md`](../../rules/codes.md) — every failure code and its route seat.
