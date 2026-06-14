# Host-runtime contract (generic)

The engine is deterministic Node.js; it does **not** call a chain-seat LLM. The agent seats run
inside a **host runtime** that you supply. This doc is the runtime-neutral capability contract: what
any runtime must provide to run the chain, how to instantiate seats safely, and how the engine causes
seats to run. The reference runtime is OpenClaw ([`openclaw.md`](openclaw.md)); any runtime that
satisfies this contract works, best-effort.

## The capability contract

A host runtime must provide:

1. **Persistent sessions/memory** per agent seat across runs.
2. **Scheduling or schedulability** — the runtime can be triggered externally by the shipped
   scheduler recipes, or schedule itself.
3. **Tool/shell execution for the setup session only.** Setup (C1–C4) runs with elevated access;
   **pipeline seats run tool-less** once operational.
4. **Discord channel operations** (read / post / react) for the seats that touch the approval surface.
5. **Long-running session tolerance** — chain runs are minutes-to-hours.
6. **Run-dispatch consumption** — a documented hook that starts the orchestrator seat on a pending
   slot-run task record (see [below](#how-runs-happen-the-dispatch-hook)). The degenerate hook — you
   manually prompting the agent with the pending task — always satisfies this.
7. *(SHOULD, optional)* **Per-run token/cost reporting** the engine can ingest into the spend ledger.
   Runtimes that report give full spend observability; non-reporting runtimes leave chain-seat LLM
   spend out-of-band and `engine status` marks spend *engine-metered only (partial)*.

The engine edges and all artifacts are runtime-neutral; only the seat-instantiation and
run-dispatch-hook instructions differ per runtime.

## Instantiating seats (tool-less in operation)

Instantiate the roster from `agents/*/AGENTS.template.md` into your runtime's sessions/definitions.
The minimal text-only roster is six seats (orchestrator, matcher, writer, gate, packager,
publisher-liaison); the media and analyst seats may be deferred for a text-only, empty-library first
run. Instantiated copies are **instance data** — they live host-side or in `$CONTENT_HOME`, never in
the checkout.

The hard rule: **during operation, no pipeline seat holds shell/tool or config-write authority**
(Zone S). Prompt-level prohibitions are not sufficient — your runtime's instantiation must configure
the operating seats tool-less. Only the setup session and the human operator hold elevated rights.
How you express "tool-less" depends on your runtime (a permission flag, an empty tool list, a
restricted profile); state it in your runtime's notes and verify a seat genuinely cannot run a tool.

Each seat reads and writes schema-validated files under `$CONTENT_HOME/workspaces/<stage>/`, keyed by
content-id; deterministic gates and queue writes happen exclusively through engine entry points (the
locked queue writer). No seat touches the queue directly.

## How runs happen (the dispatch hook)

The engine never calls a chain-seat LLM. Every run — scheduled or ad hoc — is a schema'd **slot-run
task record** written to `$CONTENT_HOME/ledger/tasks/` in state `pending`. The invariant: **no task
record, no run.** Task records double as the run-attribution records `engine status` reports on.

Your runtime satisfies capability #6 with any mechanism that, given a pending task record, **starts
the orchestrator seat with that record as input.** The engine provides the consumption surface so you
do not have to parse the directory yourself:

- `engine status` shows the pending-task count.
- The dispatch module (`engine/orchestrator/dispatch.js`) exposes `listPending` /
  `peekPending` (oldest-first), `claimTask(taskId, claimedBy)` (pending → claimed, refusing a
  double-claim), `completeTask`, and `failTask`.

A typical hook loops: list pending → claim the oldest (so two runners cannot both take it) → start
the orchestrator seat with the task's `command` (brand, platform, format, mode, pre-seed) → mark
`done`/`failed`. The **degenerate hook always works**: read the oldest pending record (or `engine
dispatch`/`run-slot` output) and prompt your agent with it manually.

To create a run on demand without a calendar entry:

```
engine run-slot <slot-id>            # validates the slot against the calendar, writes one record
engine dispatch --family RUN_SLOT --brand <id> --platform <p> --format <f>   # ad-hoc, no calendar
engine kickoff --now                 # run the daily batch immediately
```

Dispatch honors the `PAUSED` sentinel and the spend cap *before* writing anything — a paused or
over-budget project dispatches nothing. Re-dispatching an in-flight task is idempotent (no double
run).

## Capping and reporting chain spend

Chain-seat LLM spend is **yours**, owned at the runtime/provider, not metered by this engine. Cap it
where your runtime lets you (a provider spend limit, a runtime budget). If your runtime can report
per-run token/cost, ingest it so `engine status` shows a whole-system figure instead of "partial";
otherwise the engine's caps bound only engine-metered actions + new-run dispatch (which still stops
*new* chain spend on a cap breach). See [`../cost.md`](../cost.md).

## Mode and safety

Seats inherit `mode` from the task record (default `SAFE`) and carry it forward unchanged — a seat
never escalates mode. The mode ladder (`SAFE → LIVE_PREVIEW → LIVE`) is resolved by the engine, not
the runtime; the runtime just runs what it is handed.

## See also

- [`openclaw.md`](openclaw.md) — the reference fast path with concrete wiring.
- [`../architecture.md`](../architecture.md#1-what-the-system-is) — the engine-vs-runtime split.
- [`../setup/platforms.md`](../setup/platforms.md#scheduler-triggers) — installing the triggers that write task records.
