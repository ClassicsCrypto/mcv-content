# Brand setup

How to scaffold an instance, register a brand, author its Brand DNA, and run the calibration gate —
including the **cold-start** path for a brand with no history. This walks checkpoints C1–C4 from the
brand's point of view. For the Discord half of C1 see [`discord.md`](discord.md); for
publisher/scheduler setup see [`platforms.md`](platforms.md).

Setup is **idempotent and resumable**: progress is recorded per step in
`$CONTENT_HOME/setup-state.json`, and re-running resumes from the first incomplete checkpoint
without duplicating channels, re-billing scrapes/indexing, or overwriting Brand DNA. Each checkpoint
has a deterministic verifier (`engine verify --setup c<n>`) that halts with a named failed step and
its remediation.

The project lifecycle is `uninitialized → ingested → calibrated → operational` (plus `paused`). The
project cannot reach `operational` without passing the calibration gate (C3).

## Scaffold the instance (C1, step 1)

```
engine init --home <path>
```

This creates the `$CONTENT_HOME` layout (see [`../configuration.md`](../configuration.md#content_home-layout)),
a SAFE-mode starter `config/system.json`, a starter `.env` to fill as later steps produce
credentials, a local-only git repo (for learning-record rollback; pass `--no-git` to skip), and
`setup-state.json`. It is one of the two commands that run without `CONTENT_HOME` already set, and it
refuses a path inside the code checkout. Re-running fills missing pieces and never overwrites your
content.

Set `CONTENT_HOME` in your process environment afterward (the scheduler recipes do this for you).

> The rest of C1 — the Discord bot + channels, the publisher integration (deferrable until LIVE),
> and writing `config/system.json` (reviewer allowlist, budget caps, SAFE mode) — is covered in
> [`discord.md`](discord.md) and [`platforms.md`](platforms.md). `engine
> verify --setup c1` gates all of it.

## Register a brand (C2, step 1)

Write one `brands/<brand-id>/brand.json` per brand from `templates/brand/brand.json.template`. Every
field is documented in [`../configuration.md`](../configuration.md#4-brandsidbrandjson-brand-scope).
Minimum: `id`, `display_name`, `account_class` (`operator` or `brand`), and at least one
`platforms[]` entry with a `platform` and a `publisher` (`postiz` / `giphy` / `manual`).

**Account connection** is deferrable exactly as long as publishing is: for each platform you will
publish on, connect the brand's account in the publisher and record the resulting integration id as
`platforms[].integration_ref`. Giphy lanes record the Giphy username/credentials instead. The
quick-start defers this to the going-LIVE step.

## Author the Brand DNA (C2, step 3)

There are **two paths to a Brand DNA**, and they share the same output and the same authoring
template — pick whichever fits the brand:

**A. Generate it from a corpus (the one-command flow).** If you have ingested a corpus (step 2),
`engine generate-dna` runs a **deterministic corpus analysis (no LLM)**, categorizes archetypes, and
— when a host synthesis seat is wired — composes the voice prose, writing `brands/<id>/brand-dna.md`,
the `archetypes/` catalog, and the `brand.json` voice fields in one shot:

```
engine generate-dna --brand <id> --estimate-only   # see the metered-synthesis cost first (DD-18)
engine generate-dna --brand <id> --yes             # confirm and generate
```

DNA *synthesis* is a **host-runtime seat** (the engine never calls a chain/analysis LLM directly,
RD-2) and it is **metered** — without `--yes` the command halts with a cost estimate and writes
nothing. Competitor content informs **patterns only and is never reproduced verbatim** (a check
enforces this, RD-9). The flow **degrades gracefully**: corpus but no seat ⇒ it writes the
deterministic analysis + a *prefilled* authoring template for the agent to finish; no corpus ⇒ the
cold-start manual template. Onboarding is never blocked (DD-21). Full reference, the `brand_dna`
config block, and the no-verbatim check: [`../brand-dna.md`](../brand-dna.md).

**B. Author it by hand (agent-assisted).** The host agent interviews you and/or reads the
deterministic analysis, then fills `templates/brand/brand-dna-authoring.md` directly. This is the
path for a history-less brand and the always-available fallback.

Either way the output is `brands/<id>/brand-dna.md` plus an `archetypes/` catalog, and the authoring
template captures identity, tone, voice rules, audience, taboos, the drama/dial preference (matching
the `brand.json` `drama_dial`), and an example bank. Its frontmatter is schema-validated. The same
authoring template is the cold-start path below (see [`cold-start.md`](cold-start.md) for the full
history-less walk).

### Corpus intake (optional, C2, step 2)

Three supported paths, in order of preference:

1. **Manual data submission** (first-class): drop files conforming to
   `schemas/inputs/corpus-item.schema.json` into `$CONTENT_HOME/corpora/<brand-id>/`.
2. **Own-account export:** the platform's official archive, converted by a shipped converter.
3. **BYO scraper adapter:** you supply provider access; the repo ships the adapter interface and a
   reference adapter. See [`../data-policy.md`](../data-policy.md) for the legal posture.

All ingested corpora are **trust-class-tagged at write time**. Scraped material — including your own
scraped corpus — enters as `untrusted-scraped`; an operator attestation promotes a curated subset to
`operator-curated`. The C2 verifier fails if any present corpus item lacks a `trust_class`.

## Cold start (a history-less brand)

A brand with no history is fully supported — explicit non-support is *not* the path. The full
walkthrough is in [`cold-start.md`](cold-start.md); in brief, a cold-start brand uses:

- The **manual Brand DNA authoring template** (interview-driven), instead of corpus analysis.
- A **starter archetype set** from `templates/brand/archetypes.template.md`.
- **Empty-library mode**: set `cold_start: true` in `brand.json` if the archetype catalog is empty;
  retrieval returns generate-only decisions and nothing in the chain hard-depends on a populated
  index.

The C2 verifier accepts an empty archetype catalog *only* when `cold_start: true` is set (otherwise
it fails with the remediation to add archetypes or set the flag). The docs state plainly that
calibration quality improves once you add corpus data, and what to add later. You can move a brand off
cold-start at any time by adding corpus and archetypes and re-running calibration.

## Calibrate (C3) — the mandatory gate

```
engine calibrate --brand <id> --estimate-only     # see the cost first
engine calibrate --brand <id> --yes                # confirm and run
```

Calibration is your first real spend, so it is protected by **estimate-and-confirm**: the runner
presents a pre-run cost estimate (N samples × the per-sample band; indicative, see
[`../cost.md`](../cost.md)) and **requires confirmation** before any spend. Without `--yes` it halts with
the estimate (the CLI is non-interactive in the agent-first flow; the agent re-invokes with `--yes`).

The harness generates N sample drafts (default 10) across the brand's archetypes, gates them, and
grades against the **defined** pass criteria:

- ≥ 8 of 10 clear the gate with zero hard fails,
- the operator judges ≥ 6 of 10 on-voice per the shipped rubric,
- zero fabrication-class codes.

Criteria are config-tunable (`system.json` `calibration` block); these defaults ship. Generation runs
through your host runtime (the engine never calls a chain-seat LLM); record the judged result with:

```
engine calibrate --brand <id> --result '{"sample_count":10,"gate_clear":9,"on_voice":7,"fabrication_codes":0}'
```

On a pass the project advances toward `calibrated`; pin the known-good baseline by tagging a commit
in the instance repo. On a failure, run the remediation loop (adjust DNA/rules → re-run) — **the
project must not advance without a pass.** The same criteria definition grades both `engine
calibrate` and the C3 verifier, so the runner and the gate can never disagree.

> If the shipped `calibration/` content is not present, the runner reports "calibration content not
> present" rather than silently passing C3 — the calibration gate is never bypassed.

## Calendar and library (C4)

- **Calendar (required):** agent-assisted generation from `templates/calendar.template.md` plus your
  cadence preferences. Calendar generation assigns clock times to slots. The C4 verifier needs at
  least one slot with a clock time.
- **Library (optional):** **library indexing is available** via `engine index-library` — it scans
  `library/media`, asks your configured vision provider for a description + searchable tags (+ a
  duration for video) per asset, and writes the archive index retrieval consumes. It is
  estimate-and-confirm (no `--yes`, no spend), **incremental** (already-indexed assets are skipped and
  never re-billed), and resumable. Three supported v1 paths:
  - **Empty-library mode (default, fully supported):** leave the library disabled; retrieval returns
    generate-only decisions and nothing in the chain hard-depends on an index. `engine index-library`
    with no media present is a clean no-op (zero spend).
  - **Automatic indexing:** point config at the library and run
    `engine index-library --estimate-only` then `engine index-library --yes`.
  - **Manual population:** hand-author `index.json` entries against the archive-index-entry schema.

  The C4 verifier passes either an empty/disabled library (empty-library mode) or a populated index
  (auto-indexed or manual). Full detail — indexing, folder auto-sort, and character sheets — is in
  [`../library.md`](../library.md).
- **Campaigns:** optional, addable later.
- **Character sheets:** optional. **Detection** (which roster characters already have a sheet in the
  library) is deterministic and always available, zero-key. **Generation** of a missing sheet is
  metered, approval-gated, and dry-run by default; it **requires a configured image-gen provider** and
  degrades to a no-op when none is set. See [`../library.md`](../library.md#character-sheets).

```
engine verify --setup c4
```

On a C4 pass *with C3 already passed*, the project becomes `operational`.

## Going operational

Install the triggers from `templates/scheduler/` (see [`platforms.md`](platforms.md)) and
advance the mode ladder: fresh installs are `SAFE`; LIVE requires an operational project plus an
explicit config change. The first real card is produced in `LIVE_PREVIEW` — see
[`quick-start.md`](quick-start.md) for the narrated card → approve → `handed_off` → publish →
`published` walk.
