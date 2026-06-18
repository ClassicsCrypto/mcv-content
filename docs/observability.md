# Observability

The bar: an operator must be able to answer — *did the system run today, what did it produce, what
failed with which codes, what did it spend* — without reading internals. This doc covers the
surfaces that answer those questions and the KPI set that defines "what a healthy week looks like."

> KPI reference ranges below are **INDICATIVE** — marked "measured as of `<date>`" and filled by a
> measurement pass (see [`runbooks/measurement-instance.md`](runbooks/measurement-instance.md)). A
> stale range is a docs bug, not a release blocker. Tune them per install.

## 1. Surfaces

### `engine status` (the one command)

`engine status` reads (never mutates) the on-disk substrates and answers the four questions at once:

- **Mode + paused state** — the resolved mode and its source, plus whether the `PAUSED` sentinel is
  set.
- **Project state** — `uninitialized` / `ingested` / `calibrated` / `operational` / `paused`.
- **Queue state counts + oldest age** — per-state counts from the durable queue, with `handed_off`
  glossed as *"awaiting operator publish in the publisher"* and the oldest queue item's age.
- **Today's tallies** — produced / published / failed counts, with failure-code tallies (e.g.
  `FM.SUBSTITUTABLE×3`).
- **Last run per named trigger** — from the event ledger (`morning-kickoff`, `run-slot`, etc.) with
  outcome.
- **Pending task records** — queued-but-not-yet-run count (the dispatch transport).
- **Spend line** — honestly scoped (see [Spend](#5-the-spend-line)).
- **Wiring self-check** — `content_home` resolvable, config present + shaped, reviewer allowlist has
  an approver, approval channels are bound, host runtime permissions are expected, publisher creds
  present-or-deferred.

`engine status` is read-only and tolerant: each substrate degrades to "unavailable" rather than
throwing, so it works on a half-set-up instance (the "where am I" use). `--json` emits the full
structured object. The exit is non-zero only when a wiring check fails.

### Event ledger (`ledger/events.jsonl`)

The append-only, schema'd event stream: every stage transition, gate verdict, decision, handoff, and
spend event. This is the machine-readable substrate everything else is computed from. Run-dispatch
events carry their named trigger, which is how last-run-per-trigger is derived.

### Daily digest (to `content-ops`)

A once-daily summary: produced / approved / published / unfilled slots, failure-code counts, spend,
and queue age — the failure-code dashboard in minimal form. A paused install digests "paused" rather
than alerting.

### Heartbeat / stall alerts

Silent death must not be the failure presentation. Alerts fire on:

- **No content produced today** (threshold `observability.stall_thresholds.no_content_produced_hours`,
  default 24h).
- **Queue age** — cards older than the TTL still pending
  (`queue_age_alert_hours`, default 24h).
- **Trigger missed** — an expected trigger didn't fire.
- **Analytics gap** — an expected analytics cycle is missing.

The undelivered-card backlog threshold (`undelivered_card_backlog`, default 10) additionally pauses
*new generation* when the approval surface is unreachable — don't pile spend behind a dead control
plane.

### Queue view (`queue/queue.md`)

A human-readable rendering of the durable queue, for eyeballing what is in flight without parsing
JSON.

## 2. The KPI set — "what does a successful week look like"

These define steady-state health and power the digest. Ranges are **indicative** (measured as of
`<date>`) and config-tunable. For each KPI: what it measures, then a reference range.

| KPI | What it measures | Indicative reference range |
|---|---|---|
| Approval rate | (approved + edited) / cards posted | `<measured>` |
| Edit rate | edited / approved — how often the recommended text needs a fix | `<measured>` |
| Hard-fail rate per stage | hard-code fails / drafts, per gate layer | `<measured>` |
| Dead-letter count | items that exhausted retries and dead-lettered | target **0** |
| Slots filled vs planned | produced cards / planned calendar slots | `<measured>` |
| Publish success rate | `published` / approved-for-publish | `<measured>` |
| Median slot→publish latency | time from slot run to `published` | `<measured>` |
| Spend vs budget | engine-metered spend against caps (see scope below) | within caps |
| Calibration drift signal | rejection-reason trend over time | stable / no upward drift |

A healthy week, narratively: most cards are approved with a low edit rate, hard-fail rates per stage
are low and stable, dead-letters are zero, planned slots are getting filled, approved items reach
`published` (you are actually publishing the drafts), latency is bounded, spend is within caps, and
the rejection-reason mix is not drifting upward (which would signal the calibrated voice is slipping
and it is time to re-calibrate).

## 3. Mapping KPIs to surfaces

Every KPI is derivable from the event ledger; `engine status` and the daily digest surface the
current-window slices. If a KPI you care about is not on the digest, it is computable from
`ledger/events.jsonl` (the events that feed it — transitions, verdicts, decisions, handoffs, spend —
are all there). The status command and the digest are aligned views over the same substrate, not
separate truths.

## 4. Configuration

The observability surfaces are tuned by `config/system.json` `observability`:
`{ digest_time, stall_thresholds: { no_content_produced_hours, queue_age_alert_hours,
undelivered_card_backlog } }`. See
[`configuration.md`](configuration.md#cooldown-card_ttl-retention-observability).

## 5. The spend line

The spend figure is honestly scoped. The engine meters its **own** actions (indexing, visual gate,
media generation, scraping, publisher calls) and sums them against the caps. Chain-seat LLM spend
(writer/gate/matcher tokens) is **host-runtime-owned** and the engine is blind to it unless your
runtime reports per-run cost. So:

- When the runtime reports cost, the spend line folds it in — a whole-system figure.
- When it does not, the spend line is marked **"engine-metered only (partial)"** and states the
  regime, never implying a whole-system ceiling that does not exist. The `monthly_cap` bounds
  engine-metered actions + run dispatch, not your total bill.

This is the same split as [`cost.md`](cost.md); see it for how to cap and report chain spend per
runtime.

## See also

- [`cost.md`](cost.md) — the spend split and the estimators.
- [`troubleshooting.md`](troubleshooting.md) — turning an alert or a stuck state into a fix.
- [`architecture.md`](architecture.md#3-the-content-item-state-machine) — the queue states `engine status` counts.
