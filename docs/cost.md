# Cost

Open source does **not** mean free to run. The chain and several optional features call metered
third-party services. This doc explains what is metered, who pays for what, and how to cap it.

> **Numbers here are INDICATIVE.** The specific cost bands below are placeholders marked "measured
> as of `<date>`" and are filled by a measurement pass. A stale band is a docs bug, not a release
> blocker. For *current* numbers on your own install, use the pre-run estimator
> `engine calibrate --estimate-only` (and `engine index-library`'s pre-run estimate once the automatic
> indexer ships — see below) — they reflect your configured chain and provider.

## The spend split (read this first)

There are two distinct cost regimes, and the engine can only see one of them:

- **Engine-metered spend** — actions the engine itself performs and can bill: the visual gate, media
  generation, scraping/trend calls, and publisher API calls — plus library indexing **once the
  automatic indexer ships** (a roadmap capability; not metered in v1 because the verb is a stub — see
  below). Each emits a spend event the engine can sum and cap.
- **Host-runtime-owned spend** — the chain-seat LLM tokens (writer, gate, matcher, enricher). The
  engine does **not** call these LLMs; your host runtime does, with your provider credentials. The
  engine is structurally blind to this cost **unless** your runtime reports per-run cost back to it.

This split is load-bearing for budgets (below) and for [`observability.md`](observability.md). For
most installs the chain-seat LLM tokens are the dominant cost, and they live outside the engine's
meter.

## Budgets and what they bind

`config/system.json` `budget` is **required** (the engine refuses LIVE mode without it):
`{ monthly_cap, daily_cap, per_item_generation_limit, indexing_requires_estimate: true }`.

> The caps bind **engine-metered spend and run dispatch only.** A `monthly_cap` of $50 bounds what
> the engine meters and dispatches — it is **not** a whole-system ceiling unless your runtime reports
> chain spend. `engine status`, the daily digest, and this doc all say so explicitly; nothing implies
> a ceiling that does not exist.

When the cap is breached: the project goes `paused`, all engine-metered actions halt, and — crucially
— **no new slot-run task records are dispatched.** Stopping dispatch stops *new* chain spend even
where the engine cannot meter it. A chain run already handed to the host runtime cannot be
retroactively stopped by the engine.

See the budget key reference in [`configuration.md`](configuration.md#budget-spend-governance--required).

## Cost bands (indicative — measured as of `<date>`)

Bands by usage profile. **Placeholder ranges; replace with measured values.**

| Profile | Engine-metered (indicative) | Host-runtime chain spend (your provider, indicative) |
|---|---|---|
| Text-only, empty-library, low cadence | `<$X–$Y / month>` | `<depends on your model & cadence>` |
| Text + media, indexed library, medium cadence | `<$X–$Y / month>` | `<depends on your model & cadence>` |
| Multi-brand, multi-platform, high cadence | `<$X–$Y / month>` | `<depends on your model & cadence>` |

Per-sample / per-item indicative band used by the estimators: `<$low–$high per content item>`. This
is the band `engine calibrate --estimate-only` multiplies by N to preface a calibration run; it is
config-overridable (`cost.per_sample_usd`). Treat all of these as starting points until you measure
your own.

## Capping chain spend (host runtime)

Because chain-seat LLM spend is host-owned, you cap it where your runtime lets you — not in this
engine's budget. Each runtime doc states how:

- **OpenClaw (reference):** see [`runtimes/openclaw.md`](runtimes/openclaw.md) for the model/cost
  settings and per-run cost reporting that the engine can ingest into the ledger.
- **Any other runtime:** see [`runtimes/generic.md`](runtimes/generic.md) — set your provider's spend
  limits at the runtime/provider, and (optionally) report per-run cost so `engine status` can show a
  whole-system figure instead of "partial".

When the runtime reports per-run cost, `engine status` and the digest fold it into the spend figure.
When it does not, they mark spend **"engine-metered only (partial)"** — an honest scope, not a bug.

## The estimators (your source of current numbers)

The estimate-and-confirm contract: a command presents a pre-run estimate and **requires confirmation
before spending**. In v1 one command is live:

- `engine calibrate --brand <id>` — your first real spend. Run `--estimate-only` to see the band, then
  `--yes` to confirm. See [`setup/brand.md`](setup/brand.md#calibrate-c3--the-mandatory-gate).

`engine calibrate --estimate-only` reflects *your* configured chain and providers, so it is the
authoritative current number; the bands above are only orientation.

> **`engine index-library` (when available).** Library auto-indexing is **forthcoming** (roadmap) —
> the automatic visual-tagging indexer is not shipped in v1, so the verb is an honest stub that points
> you at empty-library mode (default) or manual `index.json` population (see
> [`setup/brand.md`](setup/brand.md#calendar-and-library-c4)). When it ships it will honor the same
> estimate-and-confirm contract (a pre-run cost estimate + item count, then resumable batches once
> confirmed) and become a second engine-metered cost driver. It is **not** a v1 spend line.

## See also

- [`configuration.md`](configuration.md#budget-spend-governance--required) — the `budget` key and its scope caveat.
- [`observability.md`](observability.md) — the spend line in `engine status` and the digest, and the partial-spend marker.
- [`runtimes/openclaw.md`](runtimes/openclaw.md) / [`runtimes/generic.md`](runtimes/generic.md) — capping and reporting chain spend.
