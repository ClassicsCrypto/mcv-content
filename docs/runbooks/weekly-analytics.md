# Runbook: the weekly analytics loop

Once a week the engine closes the feedback loop: it **collects** engagement on published items,
computes **rolling baselines**, emits the **required weekly performance report**, and surfaces
**proposed learning records** for you to review. The hard contract: the loop only *proposes* — a
human applies every change (DD-6).

> **Honest scope (§8.9):** the analytics modules under `engine/analytics/engagement/` are library
> functions (collection, baselines, performance report, learning-record creation). They are **not**
> a CLI verb. The **analyst seat** (an LLM in the host runtime — see
> [`../../agents/analyst/AGENTS.template.md`](../../agents/analyst/AGENTS.template.md)) drives them on
> its cycle; the engine never calls a chain-seat LLM (RD-2). The collector itself is deterministic
> code and needs no LLM. This runbook is the operator's view of that cycle.

## 1. Engagement collection

The collector (`engine/analytics/engagement/collector.js`, exported `collectEngagement`) reads the
publish queue, finds every item in state `published` with a `published_at`, and for each computes
which **checkpoints** are due and not yet collected:

- `1h`, `24h`, `7d` after publish (the default cadence; config-overridable).

For each due checkpoint it fetches metrics **through the publisher adapter seam**
(`publisher.fetchMetrics`, §12.3) — never a direct HTTP/CLI call — and writes one raw checkpoint
record to `$CONTENT_HOME/analytics/raw-<content-id>-<checkpoint>.json` (redacted at write, deduped by
file existence).

Behavior you can rely on:

- **Paused** — a `PAUSED` instance collects nothing (§15.4).
- **Partial pulls are flagged** (`partial: true`), never silently averaged in (§15.1).
- **Auth failure (401/403) is permanent** and **halts** collection; an outage is skip-and-retry next
  cycle. The two are distinct (§15.2) — do not treat a halted auth failure as a transient outage.
- `ANALYTICS_DRY_RUN=1` exercises the flow with deterministic synthetic metrics and **no adapter
  call** (documented diagnostic override, §4.5).

Collection is scheduled the same way as the daily kickoff — as a recurring host-runtime / analyst-seat
task. It writes only under `$CONTENT_HOME/analytics/` and is physically incapable of mutating the
publish queue (it never imports a queue-write helper).

## 2. Baselines

`baselines.js` (`computeBaselines`) reads the raw checkpoint corpus and computes, per
`brand × platform × checkpoint` group, a rolling mean + median over the last 20 records. It flags
**outliers** among new records: `≥ 2×` the group's baseline median is a high performer, `≤ 0.5×` is an
underperformer (groups with fewer than 3 records are skipped — not enough history to judge). Outliers
are report inputs only; nothing here mutates rules or config.

## 3. The weekly performance report (required output)

`performance-report.js` (`buildWeeklyReport`) is the analyst→operator handoff artifact and a
**required** output of the loop — emitted even in a quiet week (§7.9 / §9.2). For the week ending now
(or any `weekEnding` you pass) it builds a `performance-report.schema.json`-conformant object:

- `checkpoints[]` — the week's collected checkpoints.
- `baselines[]` — the rolling baselines.
- `weekly_summary` — `period`, by-dimension aggregates (`type` / `theme` / `format` / `hook`), and
  `recommendations[]` (top/bottom performers + outlier flags as plain, human-facing strings).

It writes `$CONTENT_HOME/analytics/performance-report-<week>[-brand].json` (redacted at write) unless
called with `write: false`. External post references in the report are publisher ids, never URLs
(§13.3). The report **mutates nothing** but its own output file.

## 4. Reviewing proposed learning records (human-applied — DD-6)

`learning.js` (`proposeLearningRecord` / `proposeFromRecommendations`) turns decision-time signals
(reviewer rejection reasons, edit diffs) and analytics recommendations into **proposed** learning
records under `$CONTENT_HOME/learning/proposed/<id>.json`. The hard line v1 does not cross:

- Records are **always** created in status `proposed`. The module **never** writes to `rules/`,
  `config/`, brand DNA, or any threshold — machine application is not in v1. Applying a record is a
  separate, future, feature-gated tool (P6).
- `target_mutability` is recorded at creation. A `human-only` target (guardrail / safety / hard-fail
  threshold) is **creatable but flagged** — the eventual application tool refuses to apply it. Only
  `learnable` targets are machine-applicable when that tool ships.
- A single-signal (n=1) proposal is **flagged** (minimum-signal discipline, DD-6).

**Your weekly review:**

1. Read the week's `performance-report-*.json` — the aggregates and `recommendations[]`.
2. Read the proposed records in `$CONTENT_HOME/learning/proposed/`. For each: check the
   `source_signals[]` (and whether any is flagged n=1), the `target_artifact` + `target_mutability`,
   and the `proposed_diff`.
3. **You decide and you apply.** Apply a change by hand in the instance repo (the rule/config/brand
   file) and commit it — tag/note the commit as the change's record so it is reversible. Never apply a
   diff against a `human-only` target through automation; never weaken a safety or guardrail rule.
4. A persistent upward drift in rejection-reason mix is the **calibration-drift** signal — time to
   re-calibrate the brand (`engine calibrate --brand <id>`). See
   [`../observability.md`](../observability.md).

## Watch it

`engine status` reports today's produced/published/failed and failure-code tallies; the **analytics
gap** stall alert (§13) fires when an expected analytics cycle is missing — see
[`recover-from-stall.md`](recover-from-stall.md). The corpus under `$CONTENT_HOME/analytics/` and
`$CONTENT_HOME/learning/proposed/` is the durable record.

## See also

- [`../../agents/analyst/AGENTS.template.md`](../../agents/analyst/AGENTS.template.md) — the analyst
  seat's may/may-not and cycle.
- [`../observability.md`](../observability.md) — the KPI set, including calibration drift.
- [`../data-policy.md`](../data-policy.md) — retention of analytics/learning artifacts (and
  `engine purge-corpora` for ingested corpora).
- [`rotate-credentials.md`](rotate-credentials.md) — fixing the publisher auth failure that halts
  collection.
