<!--
docs/brand-dna.md — Brand DNA generation & data ingestion (the C2 ingestion+identity pathway).
Cites: release-spec / original-design-spec §1.1 Data Ingestion & Brand Identity + §1.2 Context &
Competitor Analysis; release-spec §2.4 C2; RD-2 (host seat, engine never calls chain/analysis LLMs);
RD-9 (scraping posture: manual/export first-class, scraping BYO, operator is data controller,
competitor patterns never republished); RD-8 (Zone-U trust class); DD-18 (metered estimate-and-
confirm); DD-21 (cold-start / degrade — never block onboarding); DD-10 (brand-keyed); roadmap #2.
Honest scope: DNA synthesis needs a host seat and degrades to the manual authoring template without
one — the deterministic analysis and archetype catalog still ship.
-->

# Brand DNA and data ingestion

This is the **C2 (ingestion and brand identity)** pathway: how the engine turns an account's content
corpus — and its competitors' — into a brand's foundational voice files. It upgrades the v1
agent-assisted authoring (you fill `templates/brand/brand-dna-authoring.md` by hand) into a
**deterministic, auditable, one-command flow** that produces a `brand-dna.md`, an archetype catalog,
and `brand.json` voice fields.

> **Honest scope.** The engine ships the ingestion seam, the **deterministic corpus analyzer (no
> LLM)**, the archetype categorizer, the cost-estimate gate, the CLI, and the writers. Turning the
> analysis into voice *prose* is a **host DNA-synthesis seat** the runtime wires (RD-2) — the engine
> never calls a chain/analysis LLM directly. **Without a seat the flow degrades gracefully**: it
> still emits the deterministic analysis + archetype catalog and a *prefilled* authoring template for
> the agent to finish. The manual authoring path always works. Onboarding is never blocked (DD-21).

## TL;DR

```
# 1. Ingest a corpus (any of three paths — see "Corpus intake" below). Drop files, convert an
#    export, or (opt-in) run a BYO scraper. Everything lands in $CONTENT_HOME/corpora/<brand>/.

# 2a. The one command — ingest (scrape/import) AND generate in one shot:
engine ingest-brand --brand <id> --estimate-only   # see the metered scrape + synthesis cost (DD-18)
engine ingest-brand --brand <id> --yes             # ingest -> deterministic analysis -> host synthesis

# 2b. Or, if you already ingested the corpus in step 1, run generation alone:
engine generate-dna --brand <id> --yes             # the generation step only (no ingestion)
```

What it writes under `$CONTENT_HOME`:

- `brands/<id>/brand-dna.md` — identity, tone, voice, do / do-not, signature moves, plus an
  **auditable deterministic-analysis provenance block** (the stats the synthesis was derived from).
- `brands/<id>/archetypes/<archetype>.md` — one file per detected content archetype (angle, hook
  direction, must-include, structure, voice notes), the matcher reads these to pre-seed slots.
- `brands/<id>/brand.json` voice fields — `drama_dial` and `paths.dna` / `paths.archetypes`
  (read-modify-write of only those fields; everything else in `brand.json` is left untouched).

## The flow, end to end

```
$CONTENT_HOME/corpora/<brand>/         own/ + competitors/ (Zone U, trust-class-tagged at write)
        │
        ▼  read + partition (own vs competitor)
  DETERMINISTIC corpus analyzer        auditable stats only — NO LLM (lengths, vocabulary, openers,
        │                              hashtag/mention usage, engagement signal, archetype buckets)
        ▼
  archetype categorizer                buckets items into Content Archetypes; competitor items
        │                              contribute PATTERN COUNTS only, never copied text
        ▼  (metered — DD-18 estimate + confirm)
  HOST DNA-synthesis seat (RD-2)       turns the analysis into voice PROSE; INJECTABLE for tests;
        │                              absent ⇒ degrade to the prefilled authoring template
        ▼  no-verbatim enforcement (RD-9) — strip + flag any competitor-copy overlap, fail-closed
  writers                              brand-dna.md + archetypes/ + brand.json voice fields
```

The deterministic stages (analysis, categorization, the no-verbatim check, all writes) run live and
cost nothing. Only the host synthesis seat is metered, and only that step requires `--yes`.

### The deterministic-vs-host-LLM split (why it is built this way)

- **Deterministic, in the engine, free, auditable:** the corpus reader, the corpus analyzer (counts
  and frequencies — you can verify every number), the archetype categorizer, the no-verbatim check,
  the cost estimator, the CLI orchestration, and the file writers. None of this calls an LLM.
- **Host seat, injected, metered, optional:** the DNA *synthesis* — composing the analysis into brand
  identity/tone/voice prose. This is an LLM seat owned by your host runtime (the same ownership split
  as the chain seats, RD-2, and the §12.5 vision seam). The engine **wires** the seat and **gates**
  its spend; it never holds the LLM credential or makes the call itself.

This is the same posture as every other engine-side LLM touchpoint: the engine declares the seam and
governs the cost; the runtime owns the model and the key (see [`cost.md`](cost.md) for the spend
split and [`data-policy.md`](data-policy.md) for what flows where).

## Corpus intake — three paths (RD-9 posture, read this)

Corpus items are written to `$CONTENT_HOME/corpora/<brand>/` conforming to
`schemas/inputs/corpus-item.schema.json`, **trust-class-tagged at write time**, and managed by
`engine purge-corpora` retention (below). Competitor items go under a `competitors/` subtree (or
carry `relation: "competitor"`); everything else is treated as *own* content.

In order of preference:

1. **Manual data submission — first-class.** Drop files conforming to the corpus-item schema into
   `$CONTENT_HOME/corpora/<brand>/`. No adapter, no credential, no opt-in. Always available.
2. **Official-account export — first-class.** Your platform's official archive/export, run through a
   shipped converter (`twitter` / `generic`, or a BYO `convert` function). No scraping involved.
3. **BYO scraper adapter — opt-in, off by default.** You bring the provider access (an Apify-/xAI-
   class key); the repo ships the **adapter interface and two reference adapters** (`apify`, the
   generic `reference`), but **no bundled scraping credentials and no hosted scraping service.**

> ### Wiring the `apify` adapter (the cheap bulk-pull path)
>
> The shipped **`apify`** scraper adapter runs an Apify Twitter/X actor and pulls the brand's full
> history + the competitors' corpus (incl. public engagement counts → the highest-engagement timeline).
> Set the credential by **name** in `$CONTENT_HOME/.env` (`APIFY_API_KEY=…`) and point the adapter at
> your actor in `brand_dna.scraper` (or per-brand `ingestion.scraper`):
>
> ```jsonc
> "scraper": {
>   "adapter": "apify",
>   "provider": {
>     "actor_id": "apidojo/tweet-scraper",   // the "username/actor-name" you want to run
>     "key_env": "APIFY_API_KEY",            // resolved BY NAME — never a value in config
>     "handles_as_search": true,             // fold handles into searchTerms as from:<handle> (default)
>     "field_map": { "search": "searchTerms", "maxItems": "maxItems", "since": "start" },
>     "input": { "sort": "Latest" },          // static actor knobs merged underneath
>     "dataset_limit": 5000                   // optional cap on items returned
>   }
> }
> ```
>
> The adapter resolves the token by name, builds the actor input from your handles/keywords/date-range,
> runs it (Apify's run-sync-get-dataset-items), and maps each row to a corpus item. Actors differ in
> their input shape — `field_map` + `handles_as_search` + a static `input` template adapt to any of
> them; an absent token or `actor_id` degrades to the manual/export path (never a broken setup).
>
> **Don't have a competitor list yet?** Use the **free manual-Grok kit** instead of guessing: run
> `engine suggest prompt competitors`, paste the prompt into your own Grok/X account (no API spend),
> then `engine suggest apply --file <reply> --brand <id> --yes` adds the confirmed handles to
> `ingestion.competitors`. See [`../templates/grok-prompts/README.md`](../templates/grok-prompts/README.md).

> **Output verification (always on for `ingest-brand`).** Every Apify-backed pull is verified: did it
> run and return data (a requested-but-**empty** pull is a hard failure, not a silent no-op — usually a
> wrong actor input or an auth problem surfacing as an empty dataset), and is every written item
> **filtered to only the corpus-item variables** (the actor's extra fields are dropped, not stored).
> The verification line prints under the ingest stage; `--json` carries the full report.

> ### How ingested text is stored — `raw` vs `stripped` (`--store` / `ingestion.text_mode`)
>
> Scraped corpus text is stored **`raw`** (verbatim) by default — the fullest signal for voice
> analysis. Set `ingestion.text_mode: "stripped"` (or pass `engine ingest-brand --store stripped`) to
> store a **deterministically cleaned, smaller** form instead: URLs removed and whitespace/newlines
> collapsed. Stripping **never summarizes, paraphrases, or changes word choice** — that distillation is
> the LLM **DNA-synthesis** step, which produces `brand-dna.md` from the corpus regardless of mode. To
> keep as little raw corpus as possible, pair `stripped` with a short `retention_class: "transient"` so
> the corpus ages out fast under `engine purge-corpora`.

> ### Scraping posture (RD-9) — the operator is the data controller
>
> - **Manual submission and official exports are the first-class paths.** Scraping is BYO: you supply
>   the adapter and the credential; the engine ships only the seam. The manual/export paths are
>   contractually equal, so a scraper vendor breaking never blocks setup.
> - **You are the data controller.** Compliance with each platform's terms of service, and with any
>   applicable data-protection law, is **your responsibility**. The maintainers receive nothing;
>   there is no telemetry and no upstream data sharing.
> - **Ingested corpus is Zone U (untrusted), including competitors and even your own scraped corpus**
>   (RD-8). Zone-U text enters seat prompts only inside data fences and can never modify rules or
>   config except through a reviewed Learning Record.
> - **Competitor content is analyzed for patterns ONLY — never republished verbatim.** The generated
>   DNA and archetypes carry *derived* patterns (what kinds of hooks, structures, and angles work),
>   not copied competitor copy. **A check enforces this** (see "No-verbatim enforcement" below).
> - **Scraping is metered (DD-18).** Before any scrape, the engine presents a pre-run cost estimate
>   (items × an indicative per-item band) and requires confirmation.

The scraper pathway is **config-gated and off by default**: it stays disabled until you set
`brand_dna.enabled: true` and a `brand_dna.scraper.adapter` in `config/system.json`. Requiring the
ingestion module makes the shipped adapters *available* to be selected — it contacts no provider and
reads no credential.

## Degrade and cold-start (DD-21) — onboarding is never blocked

`engine generate-dna` adapts to what is present:

| Situation | What happens | Spend |
|---|---|---|
| **No corpus** (cold start) | Writes the **manual authoring template** (`brand-dna-authoring.md`) as `brand-dna.md` + a starter archetype, sets `brand.json` paths. Fill it by hand, or ingest a corpus and re-run. | free |
| **Corpus present, no synthesis seat wired** | Runs the deterministic analysis, writes a **prefilled** authoring template (the analysis prepended for the agent to finish) + the deterministic archetype catalog. The agent-assisted path, preserved — now with free deterministic signal. | free |
| **Corpus present + synthesis seat wired** | Full generation: deterministic analysis → metered host synthesis → no-verbatim enforcement → `brand-dna.md` + archetype catalog + `brand.json` voice fields. | metered (1 synthesis; `--yes` required) |
| **Seat wired but fails / leaks competitor copy** | Falls back to the clean prefilled-template path rather than ship bad output (status `seat-failed-degraded` / `seat-verbatim-leak-refused`). | free |

In every case the manual authoring path remains available, and the cold-start brand is fully
supported (see [`setup/cold-start.md`](setup/cold-start.md)). The flow is **idempotent**: an existing
`brand-dna.md` is left in place (no spend, no overwrite) unless you pass `--force`.

## No-verbatim enforcement (RD-9)

Because the synthesis seat is shown competitor material (so a capable seat can study mechanics), the
engine treats the seat output as untrusted with respect to the no-republish rule and **scrubs it
before anything is written**:

- It builds the set of competitor word-shingles (an *n*-word sliding window) from the competitor
  corpus and strips any matching span from the generated DNA/archetype prose, replacing it with a
  visible, auditable marker and recording a flag.
- A belt-and-suspenders **canonical guard** then re-checks the already-scrubbed output; on a residual
  confirmed leak the engine **refuses to write** the contaminated output and falls back to the clean
  deterministic template path.

The shingle width is config-tunable via `brand_dna.verbatim_shingle_words` (minimum 3; a conservative
engine default applies when unset) — short enough to catch a lifted phrase, long enough not to flag
ordinary shared vocabulary. This is the check the feature requires: no copied competitor copy reaches
disk.

## The `brand_dna` config block (`config/system.json`)

The whole pathway is off until you enable it. Keys (all optional except `enabled`):

```jsonc
{
  "brand_dna": {
    "enabled": false,                    // the off-by-default gate; true turns on the one-command flow
    "scraper": {                         // OPTIONAL BYO scraper (omit ⇒ manual + export only)
      "adapter": "reference",            // a registered adapter name; "fixture" for zero-key tests
      "provider": { /* opaque to the engine; the adapter resolves its key BY NAME via secrets.js */ },
      "max_items_per_handle": 200        // bounds the metered scrape
    },
    "synthesis": {                       // OPTIONAL host DNA-synthesis seat (omit ⇒ degrade to template)
      "seat": "fixture"                  // a registered seat name; absent ⇒ deterministic + template
    },
    "synthesis_usd": { "low": 0.05, "high": 0.40 }, // OPTIONAL DD-18 estimate band (indicative)
    "verbatim_shingle_words": 6,         // OPTIONAL RD-9 no-verbatim shingle width (min 3)
    "private_terms": ["Partner Name"]    // OPTIONAL deny-list redacted from generated DNA at write
  }
}
```

No credential **value** ever lives in config — credentials resolve by name through `secrets.js`, and
the repo bundles none (RD-9). Per-brand ingestion targets (the brand's own handles, its competitor
handle list, a manual corpus path, the brand's corpus `retention_class`) live in
`brands/<id>/brand.json` under its `ingestion` block (brand-keyed, DD-10).

## Retention (RD-9)

Ingested corpus is governed by the system `retention` block and `engine purge-corpora`. Each item
carries a `retention_class`; competitor corpus is typically `transient` so it ages out fast, raw
third-party corpus defaults to a 90-day window, and `retained` items are never auto-purged.
`purge-corpora` is dry-run by default and only ever touches `$CONTENT_HOME/corpora`. Full table in
[`data-policy.md`](data-policy.md#retention-and-deletion).

## Testability (no secrets in CI)

Both metered seams are dependency-injectable, so the whole flow is exercised with zero keys: a fake
scraper adapter (`tests/helpers/fake-scraper-adapter.js`) and a fake DNA-synthesis seat
(`tests/helpers/fake-dna-synthesis.js`) replay recorded fixtures over the synthetic **Acme Cosmos**
corpus. No credentials, no network, no child process (RD-12).

## See also

- [`setup/brand.md`](setup/brand.md#author-the-brand-dna-c2-step-3) — C2 in the brand-setup walk (the
  one-command option alongside the manual path).
- [`setup/cold-start.md`](setup/cold-start.md) — the history-less brand.
- [`data-policy.md`](data-policy.md) — the operator-as-data-controller posture, Zone-U trust tagging,
  retention/deletion, and the third-party data flows.
- [`cost.md`](cost.md) — scraping and DNA synthesis as metered actions, and the spend split.
- [`configuration.md`](configuration.md) — the full config reference.
- [`extending.md`](extending.md#4-scraper--trend-adapters) — writing a scraper adapter; the
  everything-is-Zone-U rule.
