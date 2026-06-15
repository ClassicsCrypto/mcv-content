# Data policy

What data the system handles, who is responsible for it, how long it is kept, and which external
services receive what. This is the legal-and-trust posture doc; read it before ingesting any
third-party data.

## Operator as data controller

**You — the operator running the install — are the data controller.** This engine is software you
run on your own infrastructure with your own credentials and accounts. The maintainers do not receive
your data: nothing leaves an install without your explicit action, there is no telemetry, and there
is no automatic upstream data sharing of any kind. Compliance with the terms of service of every
platform you connect to or scrape — and with any applicable data-protection law — is your
responsibility.

## Intake posture

Corpus intake supports three paths, in order of preference:

1. **Manual data submission (primary, first-class)** — files you provide, conforming to
   `schemas/inputs/corpus-item.schema.json`.
2. **Own-account export (primary)** — the platform's official archive/export, converted by a shipped
   converter.
3. **BYO scraper adapter (optional)** — you supply the provider access (e.g. an Apify-class key); the
   repo ships the adapter interface and a reference adapter, but **no bundled scraping credentials and
   no hosted scraping service.** Scraping is your responsibility, including platform-ToS compliance.

The manual and export paths are contractually equal to scraping, so vendor breakage never blocks
setup.

## Trust tagging and promotion (Zone U)

All ingested corpora are **trust-class-tagged at write time.** Scraped material — **including your
own scraped corpus** — enters as `untrusted-scraped` (Zone U). Zone-U text:

- enters seat prompts only inside **data fences** (structured quoting with provenance markers),
- may never modify rules or configuration except through a reviewed Learning Record.

An **operator attestation** promotes a curated subset to `operator-curated` — recorded in the corpus
item's `attestation` field (who promoted it, when, why). Promotion is a deliberate human act, not a
default.

## Project memory as a sensitive source

The optional **work-recap / build-in-public** source ([`work-recap.md`](work-recap.md)) reads **your
own project memory** to seed founder-voice posts. **Project memory is one of the most sensitive
inputs the system can touch** — it carries secrets, partner names, unreleased product details,
codenames, financial figures, and internal IDs. The policy around it:

- **Read-only, pointed at a configured path.** The repo ships the *mechanism*; it **never bundles,
  copies, commits, or ships any real memory.** You configure `work_recap.memory_path` to a directory
  **outside** the checkout (treat it like `$CONTENT_HOME` — keep it out of any repo with a remote).
  With the source disabled (the default) or the path absent, **no memory is read at all.**
- **Sanitize before it can become content.** Every memory-derived line passes a **redaction pre-pass**
  before it becomes a shareable seed: secret-shaped values via the same `redact.js` the logs use, plus
  neutral structural shapes (financial, internal-ID), plus **your config-extendable
  `work_recap.private_terms` deny list** for the instance-specific confidential terms a generic matcher
  cannot know (partner names, codenames). **Raw memory never enters the seed** — only sanitized
  summaries travel.
- **Honest scope:** this is pattern + known-name redaction, **not semantic DLP.** It cannot infer that
  an unflagged proper noun is confidential. That is exactly why the deny list is yours to extend, why
  a **gate privacy/leak check** re-verifies the draft and **hard-blocks residual leakage before the
  approval card**, and why a **human reviewer is the mandatory final backstop**. Nothing
  auto-publishes.
- **Memory is never committed or shared.** Like all instance data, memory and any memory-derived run
  residue stay under your instance directory and out of the repo (see *Never committed, never shared*
  below; model §13.2).

The full mechanism and the four privacy layers are documented in
[`work-recap.md`](work-recap.md#2-the-privacy-model--read-this-first).

## Retention and deletion

Each corpus item carries a `retention_class`. `engine purge-corpora` enforces the windows over
`$CONTENT_HOME/corpora/<brand>/` by `captured_at` age:

| `retention_class` | Window | Behavior |
|---|---|---|
| `transient` | `retention.transient_days` (default 7) | purged once older than the window |
| `standard` | `retention.raw_corpus_days` (default 90) | purged once older than the window |
| `retained` | never | never auto-purged; explicit deletion only |

Conservative defaults: an item with no/invalid `retention_class` is treated as `standard` (it ages
out) — **never** silently `retained`. An item with no parseable `captured_at` is left in place and
reported — the engine never purges on a guess.

`engine purge-corpora` is **dry-run by default** (it reports what *would* be purged); pass `--apply`
to delete, and `--brand <id>` to scope to one brand. It only ever touches
`$CONTENT_HOME/corpora` — never anything outside `CONTENT_HOME`. Run it on a cadence via the
`retention.purge_schedule` recipe (default `weekly`).

### Retention defaults vs pre-existing instances (the A5 disclaimer)

The 90-day default and the windows above govern **fresh public installs.** A pre-existing instance —
including a maintainer's production instance migrating onto a public release — configures its own
retention windows per its own posture in `config/system.json` `retention`. The shipped defaults are a
safe starting point, not a mandate retroactively imposed on existing data.

## Third-party data flows (what each service receives)

When you connect a service, this is the data that flows to it. Connect only what you need; each is
optional except Discord.

| Service | Required? | What it receives |
|---|---|---|
| **Discord** (approval surface) | required in v1 | approval-card content (the variants, rationale, warnings), reviewer reactions, and any reviewer-attached media. It is your control plane — it sees the content you are about to publish. |
| **Postiz** (publisher) | for Twitter/IG/FB/YT | the final post content + media you hand off as drafts, and the connected account credentials/integration you set up in Postiz. It also serves the analytics pull. |
| **Giphy** (direct publisher) | Giphy lanes only | the GIF/media and caption you publish, plus your Giphy API credentials/username. |
| **Scraping/trend provider** (BYO) | optional | the queries/accounts/themes you ask it to fetch — including when the optional `trends` pathway ([`trends.md`](trends.md)) polls it on a cadence. Returns Zone-U corpus/trend material; you are responsible for ToS compliance. Provider responses are redacted at write, so a token in a response never survives into a stored Trend Report. |
| **LLM provider for the host runtime** | required (owned by the runtime) | the chain prompts and your content. **This is configured at your host runtime, not in this engine** — the engine never proxies chain-seat LLM credentials. Review your runtime/provider's data-handling terms. |
| **Vision / media-generation provider** (engine-side) | optional | the image(s) the visual gate inspects or the prompts/inputs for media generation, via the §12.5 provider config block. Absent ⇒ the visual gate degrades to skip-with-warning; media degrades to reuse-only. |

The chain's primary LLM credentials belong to the **host runtime's own configuration** and are out
of scope here; the engine never proxies them (see [`runtimes/generic.md`](runtimes/generic.md)).

## Never committed, never shared

The repo is structured so instance data cannot leak into it: all mutable state lives outside the
checkout under `$CONTENT_HOME`, logs are redacted at write and never committed, and the contribution
rules forbid instance data, scraped corpora, and brand IP. Concretely, the following never enter the
public repo, its fixtures, examples, docs, history, or contributions: secrets and signed URLs;
scraped third-party corpora and any derivative carrying them (including your own scraped corpus);
brand DNA/strategy/lore; media libraries and indexes; run residue (briefs, drafts, gate reports,
queue contents, publish histories, trend readouts); live instance configuration (real account/channel
ids, approver identities); agent memory/identity files; and personal data (wallet↔identity joins,
holder lists, member profiling). Schemas of these ship; instances never do.

## See also

- [`configuration.md`](configuration.md) — the `retention` block and the trust glossary.
- [`work-recap.md`](work-recap.md) — project memory as a source: the four-layer privacy model in full.
- [`trends.md`](trends.md) — the BYO trend pathway: Zone-U reports, manual-first, metered polling.
- [`extending.md`](extending.md#4-scraper--trend-adapters) — the scraper adapter and the everything-Zone-U rule.
- [`architecture.md`](architecture.md#5-trust-boundaries-zones-u--o--s--a) — zones U/O/S/A and data fences.
- `CONTRIBUTING.md` — the never-accepted list.
