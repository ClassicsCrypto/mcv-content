# `fixtures/brand-dna-acme/` — Provenance

**Every file here is synthetic / maintainer-authored, created for this repository.** None is, derives
from, or resembles any real brand, account, product, person, posted content, scraped corpus, or
operator instance. The only operator brand is the fictional **"Acme Cosmos"** (an invented
backyard-astronomy / consumer-telescope brand); the two competitors — **"Stellar Optics Co"** and
**"Orbit Outfitters"** — are likewise INVENTED, with invented handles. Any astronomical objects
named (the Moon, Jupiter, Saturn, the Pleiades, Andromeda, the terminator, …) are public,
free-to-mention sky objects, not anyone's intellectual property. This satisfies the release contract
that datasets without demonstrated synthetic/operator-owned provenance never ship (release-spec §5
preamble; model §13.3 rules 1 & 3 — regenerate-never-redact, §0.3 r6).

## What this fixture is for

The **zero-key test fixtures + config + injectable fakes** for the DATA-INGESTION & BRAND-IDENTITY
feature (release-spec §1.1 Data Ingestion & Brand Identity; §1.2 Context & Competitor Analysis;
roadmap #2). The feature upgrades the v1 agent-assisted onboarding (manual
`templates/brand/brand-dna-authoring.md`) to a ONE-COMMAND flow that runs in the C2 setup checkpoint:
ingest the operator account corpus + a competitor corpus → run a DETERMINISTIC corpus analyzer
(auditable stats, **no LLM**) → categorize archetypes → OPTIONALLY synthesize `brand-dna.md` via a
HOST seat the runtime wires → write `brand.json` voice fields.

Key design laws these fixtures exercise:

- **The engine never calls chain/analysis LLMs directly (RD-2).** DNA synthesis is a HOST seat,
  injectable like the §12.5 vision seam. `tests/helpers/fake-dna-synthesis.js` replays a canned
  `brand-dna.md` so the seat-wired path runs zero-key. The deterministic analysis + archetype
  categorizer + cost gate + writers are the engine's; only the prose synthesis is the host's.
- **Scraping posture (RD-9).** Manual submission + official-account EXPORTS are first-class;
  scraping is BYO adapter — NO bundled creds. `tests/helpers/fake-scraper-adapter.js` replays
  recorded corpus items zero-key. Ingested corpus is **Zone U** (untrusted third-party incl.
  competitors, RD-8), trust-class-tagged at write, stored under `$CONTENT_HOME/corpora/<brand>/`
  conforming to `schemas/inputs/corpus-item.schema.json` (the shape `engine/cli/purge-corpora.js`
  already retains).
- **Competitor content is analyzed for PATTERNS only — never republished verbatim** (RD-9 design
  risk). `expected/no-verbatim-check.json` is the ground truth a check enforces: no distinctive
  competitor phrase appears in the generated DNA or archetype catalog.
- **Cold-start / graceful degradation (DD-21).** No scraper + no corpus → the manual authoring path
  still works. Corpus but no seat → emit the deterministic analysis + the authoring template.
  Onboarding is never blocked. See `expected/cold-start.json`.
- **Metered actions are gated (DD-18).** Scrape + DNA synthesis each present a pre-run cost estimate
  + confirm. See `expected/cost-estimate.json`. Manual/export submission is free and ungated.
- **Brand-keyed (DD-10).** `brand.json` carries the new `ingestion` block (own handles, competitor
  handles, manual corpus path, retention); `system.brand-dna.json` carries the new `brand_dna` block.

## Files

| File / dir | What it is | Provenance |
|---|---|---|
| `brand.json` | Brand config exercising the new `ingestion` block; validates against `schemas/config/brand.schema.json`. | Authored-synthetic |
| `system.brand-dna.json` | Partial system.json fragment exercising the new `brand_dna` + `retention` blocks (off-by-default gate flipped on, fixture adapter + seat wired). Merged/sub-validated in tests. | Authored-synthetic |
| `corpora/acme-cosmos/own/*.json` (8) | Synthetic Acme Cosmos OWN-account corpus; each validates against `schemas/inputs/corpus-item.schema.json` (§6.2) and carries optional engagement `metrics`. | Authored-synthetic |
| `corpora/acme-cosmos/competitors/stellar-optics-co/*.json` (4) | Invented competitor #1 (hype/scarcity/teaser/giveaway profile — an ANTI-pattern); Zone U (untrusted-scraped, transient). | Authored-synthetic |
| `corpora/acme-cosmos/competitors/orbit-outfitters/*.json` (4) | Invented competitor #2 (how-to / numbered-steps / showcase profile — adjacent learnable patterns); Zone U. | Authored-synthetic |
| `recorded/scrape-responses.json` | Recorded zero-key scraper replays keyed by `${platform}:${handle}` (incl. a `twitter:empty` degrade case); mirrors the on-disk corpora. Consumed by `tests/helpers/fake-scraper-adapter.js`. | Authored-synthetic |
| `recorded/dna-synthesis.json` | Recorded zero-key DNA-synthesis seat output keyed by brand id (the canned `brand-dna.md` + a metered-action receipt). Consumed by `tests/helpers/fake-dna-synthesis.js`. | Authored-synthetic |
| `expected/analysis.json` | Ground truth for the deterministic corpus analyzer (own/competitor counts, vocab, archetype distribution, engagement lift). Hand-verifiable from the 16 items. | Authored-synthetic |
| `expected/archetype-catalog.json` | Ground truth for the archetype categorizer (per-archetype derived seeds/hooks; own + borrowed-pattern + anti-pattern). | Authored-synthetic |
| `expected/brand-dna.expected.md` | Expected synthesized Brand DNA — byte-identical to the recorded seat output. | Authored-synthetic |
| `expected/no-verbatim-check.json` | Ground truth for the no-verbatim-republish check (forbidden competitor substrings; expected 0 violations). | Authored-synthetic |
| `expected/cold-start.json` | Ground truth for the DD-21 cold-start / graceful-degradation cases (no corpus / corpus-no-seat / full). | Authored-synthetic |
| `expected/cost-estimate.json` | Ground truth for the DD-18 cost-estimate gate on the two metered actions. | Authored-synthetic |

The consumer helpers are `tests/helpers/fake-scraper-adapter.js` (scraper seam, RD-9) and
`tests/helpers/fake-dna-synthesis.js` (DNA-synthesis host seat, RD-2).

## Notes

- **Future-dated (2099-…):** all `captured_at` timestamps sit far in the future so a fixture item is
  never mistaken for a real observation and so retention/age math (`engine purge-corpora`) is
  deterministic in tests.
- **Source links** are all `https://example.test/...` reserved-domain placeholders with synthetic
  slug status ids (e.g. `/status/own-001`) — never numeric snowflake-shaped ids, never real URLs.
- **Zone U always for ingested corpus:** every scraped/competitor item is `untrusted-scraped` (RD-8);
  one own item is promoted to `operator-curated` with an attestation to exercise that path. Competitor
  items are `transient` so they age out fastest under retention.
- **The forbidden phrases in `no-verbatim-check.json` are deliberately distinctive** so a test can
  prove the derived DNA/archetypes carry patterns, not copied competitor copy. The invented competitor
  product name "NovaMax 9000" is on the forbidden list too.
