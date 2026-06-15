# Cost

Open source does **not** mean free to run. The chain and several optional features call metered
third-party services. This doc explains what is metered, who pays for what, and how to cap it.

> **Numbers here are INDICATIVE.** The specific cost bands below are placeholders marked "measured
> as of `<date>`" and are filled by a measurement pass. A stale band is a docs bug, not a release
> blocker. For *current* numbers on your own install, use the pre-run estimators
> `engine calibrate --estimate-only` and `engine index-library --estimate-only` — they reflect your
> configured chain and provider.

## The spend split (read this first)

There are two distinct cost regimes, and the engine can only see one of them:

- **Engine-metered spend** — actions the engine itself performs and can bill: the visual gate, media
  generation, **scraping/trend polls** (each poll of an enabled `trends` provider — see §"the two
  opt-in content sources" below), publisher API calls, and **library indexing**
  (`engine index-library` — it sends each library asset to the configured vision provider for a
  description + tags; character-sheet generation is similarly metered when a provider is configured).
  Each emits a spend event the engine can sum and cap.
- **Host-runtime-owned spend** — the chain-seat LLM tokens (writer, gate, matcher, enricher). The
  engine does **not** call these LLMs; your host runtime does, with your provider credentials. The
  engine is structurally blind to this cost **unless** your runtime reports per-run cost back to it.

This split is load-bearing for budgets (below) and for [`observability.md`](observability.md). For
most installs the chain-seat LLM tokens are the dominant cost, and they live outside the engine's
meter.

### The two opt-in content sources, by cost regime

The two config-gated content sources (both OFF by default) sit on opposite sides of this split:

- **Trend polling is engine-metered and external.** When you enable the `trends` block, **every poll
  is a metered provider call** (an Apify-/xAI-class request you bring your own key for) on the
  configured 2/4/8/12 h cadence. Pick the **slowest cadence that meets your needs** — a faster cadence
  means more provider calls. With no provider configured the pathway returns no reports and spends
  nothing; the manual-submission path is always free. See [`trends.md`](trends.md).
- **The memory scan is local and free — but it produces *public-bound* drafts.** The work-recap source
  reads files on disk; the scan itself costs nothing and calls no provider. **But it seeds the same
  chain as any content**, so the resulting draft incurs the host-runtime chain-seat LLM cost like any
  other post, and — because it is built from **sensitive project memory** — every such draft **MUST be
  reviewed by a human** before it publishes (the redaction pre-pass + gate privacy/leak check + the
  mandatory approval card; nothing auto-publishes). Cheap to generate is **not** the same as safe to
  ship: review is non-negotiable. See [`work-recap.md`](work-recap.md) and
  [`data-policy.md`](data-policy.md#project-memory-as-a-sensitive-source).

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
before spending**. Two commands are live:

- `engine calibrate --brand <id>` — your first real spend. Run `--estimate-only` to see the band, then
  `--yes` to confirm. See [`setup/brand.md`](setup/brand.md#calibrate-c3--the-mandatory-gate).
- `engine index-library` — library media indexing. Run `--estimate-only` to see the band (item count ×
  the per-asset band), then `--yes` to confirm and index in resumable batches. See
  [`library.md`](library.md).

Both `--estimate-only` outputs reflect *your* configured chain and providers, so they are the
authoritative current numbers; the bands above are only orientation.

> **`engine index-library` — the second engine-metered cost driver.** Indexing sends each
> not-yet-indexed library asset to your configured vision provider for a description + tags (+ a
> duration for video), so it spends. It honors the same estimate-and-confirm contract as calibrate: no
> `--yes`, no spend — the verb returns the pre-run estimate (scanned / already-indexed / to-index
> counts × the per-asset band) and indexes nothing. The per-asset band is **indicative** (placeholder
> `$0.001–$0.01`, config-overridable via `cost.per_asset_usd`) until a measurement pass fills it.
> Indexing is **incremental and idempotent**: an already-indexed, unchanged asset is skipped and
> **never re-billed** (content-hash fingerprint); `--force` is the only way to re-spend on it.
> **Empty-library mode** (default) is a clean no-op with zero spend. Character-sheet *generation*
> (image-gen) is a separate metered, approval-gated, dry-run-by-default action that degrades to a
> no-op when no image-gen provider is configured — see [`library.md`](library.md).

## See also

- [`configuration.md`](configuration.md#budget-spend-governance--required) — the `budget` key and its scope caveat.
- [`trends.md`](trends.md) — trend polling (engine-metered, BYO provider) and the manual free path.
- [`work-recap.md`](work-recap.md) — the local/free memory scan whose drafts are public-bound and must be reviewed.
- [`library.md`](library.md) — `engine index-library`, folder auto-sort, and character sheets in full.
- [`observability.md`](observability.md) — the spend line in `engine status` and the digest, and the partial-spend marker.
- [`runtimes/openclaw.md`](runtimes/openclaw.md) / [`runtimes/generic.md`](runtimes/generic.md) — capping and reporting chain spend.
