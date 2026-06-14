# Runbook: the daily kickoff batch

The daily kickoff is the **canonical v1 trigger** (release-spec §8.4 / RD-14). Once a day it selects
the day's eligible calendar slots and dispatches one slot-run task record per slot, under a
single-runner lock. This is the recurring operation that keeps content flowing; everything else in
the pipeline hangs off the items it produces.

> Command shorthand: `engine <verb>` is shorthand for `node bin/engine.js <verb>`. Set
> `CONTENT_HOME` in the environment first (it locates `$CONTENT_HOME/.env`, so it cannot live inside
> it — see [`../configuration.md`](../configuration.md)).

## What kickoff does

`engine kickoff` runs `orchestrator/runKickoff`:

1. Resolves the run **mode** through the one ladder — `--mode` > `ENGINE_MODE` > `config/system.json`
   `mode` > `SAFE` (default, RD-16f). The mode is surfaced in the output; an `ENGINE_MODE` override
   is a loud diagnostic notice (§4.5), not a quiet posture change.
2. Selects the day's eligible calendar slots (campaign overlays applied, staggered, bounded by
   `--max`).
3. Dispatches **one pending slot-run task record per slot** (the RD-18 run transport). The host
   runtime consumes each record through its run-dispatch hook — see
   [`../runtimes/generic.md`](../runtimes/generic.md). On the OpenClaw fast path this is automatic;
   elsewhere you prompt the host agent with the pending task.
4. Runs the whole batch **under the single-runner lock** (DD-19). An overlapping run is
   skip-and-logged as `skipped_on_overlap` — never queued behind, never run twice.
5. Honors the kill switch and budget preflight (§15.4): a `PAUSED` or over-budget project dispatches
   nothing, and the batch halts the moment the kill switch is seen. A refused-by-design batch is the
   system behaving correctly — it exits 0.

Kickoff **dispatches**; it does not itself call a chain-seat LLM (RD-2). It produces task records;
the host runtime turns those into drafts → approval cards.

## Run it on demand

```
engine kickoff --now
```

Reports the dispatch summary and exits 0. Useful flags (all real — `engine kickoff --help`):

- `--now` — run immediately (named trigger `kickoff--now`); without it the run uses the
  `morning-kickoff` trigger.
- `--date <YYYY-MM-DD>` — the day to run for (default today, in the configured timezone).
- `--max <n|all>` — bound the dispatched slots (default `config` `scheduler.daily_max` or 4).
- `--brand <id>` — restrict to one brand (comma-separated for several).
- `--slot <id>` — restrict to explicit slot id(s) (bypasses day/state gating).
- `--mode <SAFE|LIVE_PREVIEW|LIVE>` — per-run mode override (default config/SAFE).
- `--force` — re-dispatch even already-fired `(date, slot)` pairs.
- `--dry-run` — select and report, write no records and no state. Use this to preview the day's
  selection before a first LIVE run.
- `--json` — structured result.

To run a single slot off-calendar instead of the whole batch, use `engine run-slot <slot-id>`
(validates the slot, dispatches one task record, reports the inferred lane).

## On a schedule

Install `engine kickoff` on a daily scheduler. Runtime-neutral recipes ship in
[`../../templates/scheduler/`](../../templates/scheduler/) (cron, systemd, Windows Task Scheduler,
PM2, OpenClaw). The contract every recipe meets:

1. **Set `CONTENT_HOME`** in the process environment before the command runs.
2. **Run `engine kickoff`** once per day. The batch is idempotent under the single-runner lock, so an
   accidental double-fire is safe — the second run skips.

Do **not** encode `LIVE` in a scheduler wrapper. Safety posture lives in `config/system.json` `mode`
(§4.5), never in the trigger. Verify a recipe by running the command by hand first.

The optional intra-day **calendar tick** (`scheduler.tick_enabled: true`) is off by default (RD-14);
kickoff and the tick share dedup state, so a slot dispatched by either is not re-dispatched. The
daily kickoff is the only trigger you need until you deliberately enable the tick.

## What it produces and where to watch

Kickoff writes pending **task records** under `$CONTENT_HOME/ledger/tasks/` and `run_dispatched`
events to the **event ledger** (`$CONTENT_HOME/ledger/events.jsonl`). Watch with:

```
engine status
```

`engine status` is the one-command operational surface (§13.1). After a kickoff it answers:

- **Last run per named trigger** — `morning-kickoff` / `kickoff--now` with timestamp and outcome.
- **Pending task records** — queued-but-not-yet-run count (the dispatched records waiting for the
  host runtime).
- **Today's tallies** — produced / published / failed, with failure-code counts.
- **Queue state counts** — including `handed_off` glossed as *awaiting operator publish*.
- **Mode + paused state**, the **spend line** (honestly scoped — see [`../cost.md`](../cost.md)), and
  the **wiring self-check**.

`engine status --json` emits the full structured object for dashboards.

## Common outcomes

- **`kickoff <date>: N dispatched, M skipped, K failed`** — normal. Skipped slots were already fired
  or off-day; failures carry a code.
- **`skipped — another run holds the single-runner lock (skipped_on_overlap)`** — a tick or the
  executor was mid-run. Not an error; the next trigger picks up.
- **`HALTED (kill switch/budget)`** — an `EPAUSED` / `EBUDGET` / `ECONTENTHOME` error halted the
  batch. See [`recover-from-stall.md`](recover-from-stall.md) and
  [`../troubleshooting.md`](../troubleshooting.md#budget-stop--paused).
- **No content produced today** — if a scheduled kickoff didn't fire, the heartbeat raises a
  "no content produced" / "trigger-missed" alert (§13). Diagnose with
  [`recover-from-stall.md`](recover-from-stall.md).

## See also

- [`approval-publish.md`](approval-publish.md) — what happens to the cards kickoff's task records
  produce.
- [`recover-from-stall.md`](recover-from-stall.md) — when a kickoff didn't fire or the pipeline
  stalled.
- [`../observability.md`](../observability.md) — `engine status`, the ledger, the digest, KPIs.
- [`../../templates/scheduler/README.md`](../../templates/scheduler/README.md) — the scheduler
  recipe contract.
