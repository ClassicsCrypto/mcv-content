# Runbook: the measurement instance (filling the indicative numbers)

[`cost.md`](../cost.md) and [`observability.md`](../observability.md) ship their cost bands and KPI
ranges marked **INDICATIVE** — "measured as of `<date>`" placeholders. This runbook is the
**measurement pass** that replaces those placeholders with values measured on a real instance. It is
a periodic docs-calibration chore, not an engine feature; nothing here runs automatically.

> **Honest scope.** The engine can only meter **engine-metered spend** (the visual gate, media
> generation, scraping/trend + competitor polls, publisher API calls, library indexing). Your
> **host-runtime chain spend** — every drafting/gate/analyst seat LLM call (RD-2: the engine never
> calls a chain LLM) — is visible only on **your LLM provider's billing**, never to the engine. So a
> measured cost figure is always two numbers from two meters. KPI ranges come from the engine's own
> observability surfaces. The numbers are install-specific (your models, providers, volume, brand),
> which is exactly why the repo ships them indicative rather than fabricating a universal table.

This is also the **RD-20 migration pilot**: production migrates onto a public release on its own
schedule, and this instance is where you validate a release — and gather its numbers — before you
point production at it.

## 1. Stand up the measurement instance

Use a dedicated `CONTENT_HOME` (outside any checkout — the engine refuses a `CONTENT_HOME` inside the
repo) with **one representative brand** and your **real configured chain + providers** (the numbers
are only meaningful against the providers/models you actually run). See
[`../setup/`](../setup/) and [`../configuration.md`](../configuration.md) for init.

```sh
export CONTENT_HOME=/path/to/measurement-home
engine init
# configure config/system.json + $CONTENT_HOME/.env with your real chain + providers, then:
engine status   # expect: initialized, mode resolved, paused=false
```

Keep this instance **SAFE / draft-only** unless you specifically intend to measure the live publish
path — you are calibrating docs, not running a campaign.

## 2. Run a representative period

Operate it normally for a representative window (a sprint or a month) so each metered path is
exercised at realistic volume: daily kickoffs, a `competitor-scan`, a `generate-dna`/`ingest-brand`
pass, and a `index-library` run if you use the library. The longer and more typical the window, the
less noisy the bands.

## 3. Collect the two cost meters + the KPIs

**Engine-metered spend** — run each pre-run estimator and record its band, then reconcile against
the actual provider charge for the same action:

| Action | Estimator | Fills (cost.md) |
| --- | --- | --- |
| Per content item (visual gate + media) | `engine calibrate --estimate-only` | per-item band |
| Brand-DNA synthesis | `engine generate-dna --estimate-only` | per-synthesis band |
| Competitor scan (scrape) | `engine competitor-scan --estimate-only` | scrape band |
| Library indexing | `engine index-library --estimate-only` | per-asset band |

**Host chain spend** — read it from your **LLM provider's billing dashboard** for the window
(the engine cannot see it). Attribute it per profile if you can.

**KPI ranges** — from the engine's own surfaces over the window: `engine status` (queue ages, state
counts), the **required weekly performance report**, and the operator **digest**
([`../observability.md`](../observability.md) §1). Record the steady-state range each KPI settled
into for a healthy week.

## 4. Fill the docs

Replace, in [`../cost.md`](../cost.md) and [`../observability.md`](../observability.md):

- every `measured as of <date>` marker with the date of this pass;
- the indicative cost bands (§"Cost bands", per-item, per-synthesis, per-asset) with your two-meter
  measured figures;
- the indicative KPI reference ranges (observability §"KPIs") with your measured steady-state ranges.

A stale band is a **docs bug, not a release blocker** — both docs say so, and the pre-run estimators
remain the authoritative *current* number for any given install regardless of what the table says.

## 5. Re-measure when the inputs change

The bands are only valid for the providers/models/volume you measured. Re-run this pass when you
materially change a configured chain model, swap a provider, or change scale — and whenever you cut a
release you intend production (RD-20) to adopt.

## See also

- [`../cost.md`](../cost.md) — the spend split and the bands this pass fills.
- [`../observability.md`](../observability.md) — the surfaces and the KPI set this pass fills.
- [`../configuration.md`](../configuration.md) — chain + provider configuration.
- [`daily-kickoff.md`](daily-kickoff.md), [`weekly-analytics.md`](weekly-analytics.md) — the cycles you run during the window.
