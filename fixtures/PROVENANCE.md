# Fixture Provenance

Every fixture in this repository is **synthetic or maintainer-authored, created for this repository**.
No fixture is, derives from, or resembles any real brand, product, company, person, account,
posted content, scraped corpus, NFT, collection, or any operator instance. This satisfies the
release contract that datasets without demonstrated synthetic/operator-owned provenance are never
committed (release-spec §5 preamble; model §13.3 rules 1 & 3 — regenerate-never-redact, §0.3).

The single brand used across all examples is the **fictional "Acme Cosmos"** — an invented
consumer space-telescope / backyard-astronomy brand. Any astronomical objects referenced (the
Moon, Jupiter, Saturn, the Orion Nebula, the Pleiades, the Andromeda Galaxy, etc.) are public,
free-to-mention sky objects, not brand or third-party intellectual property.

Provenance is **authored-synthetic** for every file listed below.

## `fixtures/brand-acme/` — synthetic fixture brand (release-spec §5.1–§5.2)

| File / dir | What it is | Provenance |
|---|---|---|
| `brand.json` | Brand config; validates against `schemas/config/brand.schema.json`. | Authored-synthetic |
| `brand-dna.md` | Brand DNA / voice doc, written from the DD-21 authoring template. | Authored-synthetic |
| `background.md` | Brand background and product story. | Authored-synthetic |
| `archetypes/sky-tonight.md` | Content archetype with seeds/hooks. | Authored-synthetic |
| `archetypes/how-to.md` | Content archetype with seeds/hooks. | Authored-synthetic |
| `archetypes/field-notes.md` | Content archetype with seeds/hooks. | Authored-synthetic |
| `archetypes/behind-the-glass.md` | Content archetype with seeds/hooks. | Authored-synthetic |
| `corpus/own-corpus.jsonl` | 40-item own-account corpus; each line validates against `schemas/inputs/corpus-item.schema.json` (§6.2). | Authored-synthetic |
| `media/*.png` (6 files) | Tiny (1×1) placeholder image assets, maintainer-made, released CC0. No third-party imagery. | Authored-synthetic / CC0 |
| `media/index.json` | Pre-built archive-index fragment; entries validate against `schemas/artifacts/archive-index-entry.schema.json`. | Authored-synthetic |
| `calendar.json` | One-week calendar; validates against `schemas/config/calendar.schema.json`. All slot types (regular, trend, campaign) and the active/dormant distinction are represented. | Authored-synthetic |
| `campaign.json` | One campaign exercising the §8.7 slot-claiming rules; validates against `schemas/config/campaign.schema.json`. | Authored-synthetic |
| `commands/*.json` (4 files) | One operator-command sample per RUN_* family; each validates against `schemas/inputs/operator-command.schema.json` including the per-family conditional requirements. | Authored-synthetic |
| `README.md` | Index/description of the fixture brand estate. | Authored-synthetic |

## `fixtures/nft-acme/` — synthetic NFT collection (release-spec §5.3, RD-17)

| File / dir | What it is | Provenance |
|---|---|---|
| `metadata/acme-explorers/*.json` (25 files) | 25-token synthetic collection, OpenSea-style `attributes`; exercises the JSON-per-token loader of `engine/library/tags/build-index.js`. | Authored-synthetic |
| `metadata/acme-orbiters/traits.csv` | 8-token synthetic collection in `token_id,trait_type,value` form; exercises the CSV loader of the same builder. | Authored-synthetic |
| `README.md` | Description + build instructions for the NFT fixtures. | Authored-synthetic |

All trait types/values and all `image` URIs (`ipfs://example-placeholder/...`) are invented and
carry no meaning outside this fixture.

## `fixtures/gate-regression/` — synthetic judged corpus (release-spec §5.5, §16.3)

One directory per shipped rule (named by the rule's frontmatter `tests:` glob); each carries a
positive (violating) and negative (clean control) example with expected codes pinned in
`expected.json`. See `fixtures/gate-regression/README.md` for the corpus contract. All content is
authored-synthetic Acme Cosmos copy or obvious placeholders.

| Dir | Codes pinned | Provenance |
|---|---|---|
| `gate-regression/formatting/` | `LINT.EM_DASH` | Authored-synthetic |
| `gate-regression/humanizer/` | `LINT.INFLATION`, `LINT.NEGPAR`, `FM.HYPE_VOICE`, `FM.HUMANIZER` | Authored-synthetic |
| `gate-regression/voice-register/` | `LINT.FINANCIAL`, `FM.POSTER_REGISTER`, `FM.SUBSTITUTABLE`, `FM.LANE_DRIFT` | Authored-synthetic |
| `gate-regression/fabrication/` | `LINT.PLACEHOLDER` | Authored-synthetic |
| `gate-regression/claims-safety/` | `LINT.TENSE_SLIP`, `FM.FABRICATION`, `FM.SUPERLATIVE_UNBACKED`, `FM.COMPARATOR_RESKIN`, `FM.UNVERIFIED_CAUSAL` | Authored-synthetic |
| `gate-regression/banned-patterns/` | `LINT.BANNED_PATTERN`, `FM.BANNED_CONSTRUCTION` | Authored-synthetic |
| `gate-regression/variant/` | `LINT.VARIANT_COUNT`, `LINT.VARIANT_DUP`, `PKG.RECOMMENDED_MISSING`, `PKG.VARIANT_A_MISSING`, `PKG.VARIANT_B_MISSING` | Authored-synthetic |
| `gate-regression/limits/` | `LINT.LENGTH` | Authored-synthetic |
| `gate-regression/packaging/` | the `PKG.*` integrity family (`PKG.PACKAGE_INVALID` contract-only) | Authored-synthetic |
| `gate-regression/cooldown/` | `PKG.MEDIA_COOLDOWN_BLOCKED` | Authored-synthetic |
| `gate-regression/media/` | `PKG.VISUAL_STATE_MISSING`, `PKG.MEDIA_MISSING`, `PKG.VISUAL_CHECK_MISSING`, `PKG.VISUAL_CHECK_NOT_PASSING`, `FM.IMAGE_DESCRIPTION` | Authored-synthetic |
| `gate-regression/platform-twitter/` | `PLAT.TWITTER_HASHTAG_PRESENT` | Authored-synthetic |
| `gate-regression/platform-instagram/` | `PLAT.INSTAGRAM_HASHTAG_OVER_LIMIT` | Authored-synthetic |
| `gate-regression/platform-tiktok/` | `PLAT.TIKTOK_HOOK_3S_MISSING`, `PLAT.TIKTOK_COVER_FRAME_MISSING` | Authored-synthetic |
| `gate-regression/platform-youtube/` | `PLAT.YOUTUBE_SOURCE_SENSE_MISSING` | Authored-synthetic |
| `gate-regression/platform-facebook/` | `PLAT.FACEBOOK_COMMUNITY_BRIDGE_MISSING` | Authored-synthetic |
| `gate-regression/visual-default-pack/` | `VIS.OFF_BRAND`, `VIS.IDENTITY_MISSING`, `VIS.EMBEDDED_TEXT`, `VIS.SKIPPED_NO_PROVIDER`, `VIS.CHECK_ERROR` | Authored-synthetic; see its README |
| `gate-regression/structure/` | `FM.WEAK_HOOK`, `FM.WEAK_ARG`, `FM.STATUS_RECAP`, `FM.ESOTERIC`, `FM.BRIEF_VIOLATION`, `FM.STRUCTURE_VIOLATION` | Authored-synthetic |
| `gate-regression/publish-integrity/` | `SYS.TEST_PUBLISH_BLOCKED`, `SYS.RETRY_EXHAUSTED`, `SYS.HANDOFF_FAILED`, `SYS.INTERRUPTED_MID_PUBLISH`, `SYS.READBACK_FAIL` | Authored-synthetic |
| `gate-regression/lint-selftest/` | Authored-synthetic (legacy pre-gate self-test scaffold); see its README |

## `fixtures/stage-outputs/` — recorded LLM-stage artifacts (release-spec §5.4)

The recorded artifacts the zero-key `engine fixture-run` replays for the LLM-dependent stages of
the deterministic spine. Authored fresh; never copied from any production run (§18.2(6)). See
`fixtures/stage-outputs/README.md`.

| File | What it is | Provenance |
|---|---|---|
| `brief.json` | Recorded matcher→writer brief (spine entry point); validates against `schemas/inputs/brief.schema.json`. | Authored-synthetic |
| `draft.json` | Recorded writer output, 3 variants; validates against `schemas/inputs/draft.schema.json` AND passes the live `pre-gate-lint` clean. | Authored-synthetic |
| `gate-verdicts.json` | Recorded LLM-gate verdicts (llm-voice + llm-quality stages + final union); each stage validates against `schemas/artifacts/validation-result.schema.json`; demonstrates the DD-3 union contract incl. a soft `warn`+`bars_recommended`. | Authored-synthetic |
| `media-decision.json` | Recorded media stage decision (reuse + cooldown eval); validates against `schemas/artifacts/media-decision.schema.json`. | Authored-synthetic |
| `usage-log.jsonl` | Recorded cooldown history (one asset inside the 14-day floor, one outside); canonical `{asset_id, content_id, used_at}` shape. | Authored-synthetic |
| `README.md` | Provenance + spine-consumption notes for the recorded artifacts. | Authored-synthetic |

## `fixtures/library-acme/` — synthetic media library + zero-key vision recordings (release-spec §1.5, §7.8, §12.5)

The zero-key test fixtures + fake-vision recordings for the library auto-indexer. A small synthetic
media set laid out across the §1.5 folder-sort buckets (`Images/`, `Videos/`, `AI-generated/`) plus an
`unsorted/` root, with recorded vision answers a fake `visionFn(filename)` returns so the indexer runs
in CI with zero keys and zero network (RD-12). See `fixtures/library-acme/PROVENANCE.md` for the full
file table. The consumer helper is `tests/helpers/fake-vision.js`.

| File / dir | What it is | Provenance |
|---|---|---|
| `library-acme/Images/*` (3 png + 1 jpg + 1 sidecar) | Tiny placeholder images + one `*.meta.json` sidecar. | Authored-synthetic / CC0 |
| `library-acme/Videos/*` (mp4 + webm) | Minimal valid-header placeholder clips marked SYNTHETIC. | Authored-synthetic / CC0 |
| `library-acme/AI-generated/*` (png + gif) | Generated-class placeholder still + animated loop. | Authored-synthetic / CC0 |
| `library-acme/unsorted/*` (png + mp4) | Pre-folder-sort mixed-kind root (folder-sort input). | Authored-synthetic / CC0 |
| `library-acme/character-markers/*.character.json` | Existing-character-sheet marker (skips metered generation). | Authored-synthetic |
| `library-acme/expected/vision-responses.json` | Recorded vision answers keyed by basename. | Authored-synthetic |
| `library-acme/expected/index-entries.json` | Golden `archive-index-entry` outputs (schema-valid). | Authored-synthetic |

## `fixtures/trends-acme/` — synthetic trend pathway + fake adapter (release-spec §8.8, §6.7, §3.3, §2.1)

The zero-key fixtures + fake trend adapter for the trend-pathway content source. Synthetic Trend
Reports plus recorded `poll(query)` responses a fake adapter (`tests/helpers/fake-trend-adapter.js`)
replays so the source runs in CI with zero keys and zero network (RD-9 BYO adapter; RD-12 injectable
seam). The trend pathway is a content source, not a publish bypass: reports become Zone-U pre-seeds
(§2.1) that feed the existing chain through to the human approval card (§2.4); nothing auto-publishes.
See `fixtures/trends-acme/PROVENANCE.md` for the full file table.

| File / dir | What it is | Provenance |
|---|---|---|
| `trends-acme/reports/2099-04-08-clear-sky-window.json` | `manual`-method Trend Report (referenced by `brand-acme/commands/run-trend-manual.json`); validates against `schemas/inputs/trend-report.schema.json`. | Authored-synthetic |
| `trends-acme/reports/2099-04-09-meteor-shower-peak.json` | `adapter`-method Trend Report; validates against the same schema. | Authored-synthetic |
| `trends-acme/recorded/trend-poll-responses.json` | Recorded `poll(query)` responses keyed by `${platform}:${window}` the fake adapter replays. | Authored-synthetic |

## `fixtures/work-recap-acme/` — synthetic project memory + injectable reader (release-spec §3.3, §2.1, §13.3)

The zero-key fixtures + injectable memory reader for the work-recap content source (founder/operator
accounts). A synthetic `MEMORY.md` + `memory/YYYY-MM-DD.md` daily logs of fictional Acme Cosmos work,
read by a fake reader (`tests/helpers/fake-memory-reader.js`) pointed at a CONFIGURED memory path so
the repo ships the MECHANISM and never bundles real memory (RD-12). **Privacy is load-bearing:** the
memory DELIBERATELY PLANTS sensitive items (an obviously-fake secret, a fake partner, unreleased
codenames) so a test proves the redaction pre-pass + private-term deny list + gate leak-check BLOCK
them before the approval card, plus a clean day that passes. See `fixtures/work-recap-acme/PROVENANCE.md`.

| File / dir | What it is | Provenance |
|---|---|---|
| `work-recap-acme/MEMORY.md` | Synthetic curated memory; mixes CLEAN-OK facts with PLANTED-SENSITIVE secrets/partner/codenames. | Authored-synthetic |
| `work-recap-acme/memory/2099-04-07.md` | Synthetic daily log mixing clean work with planted-sensitive lines. | Authored-synthetic |
| `work-recap-acme/memory/2099-04-08.md` | Synthetic CLEAN daily log — the pass case that seeds a valid recap. | Authored-synthetic |
| `work-recap-acme/private-terms.json` | Config-extendable deny list (`terms` + `secret_literals`) the privacy pre-pass loads on top of `redact.js`. | Authored-synthetic |
| `work-recap-acme/commands/run-work-recap.json` | RUN_SLOT command targeting a founder-account slot; validates against `schemas/inputs/operator-command.schema.json`. | Authored-synthetic |
| `work-recap-acme/expected/leak-check.json` | Ground truth: the `must_block` fragments + the `clean_day` pass assertion. | Authored-synthetic |

All planted "secrets", partner names, and codenames are **deliberately fake and obviously synthetic** —
the planted credential (`FAKE_TOKEN_do_not_use_0000`) reads as a fake on sight and is never real-shaped.

## `fixtures/brand-dna-acme/` — synthetic data-ingestion / brand-identity estate (release-spec §1.1, §1.2; roadmap #2)

The zero-key fixtures + config + injectable fakes for the DATA-INGESTION & BRAND-IDENTITY feature: the
one-command flow that ingests the operator account corpus + a competitor corpus, runs a DETERMINISTIC
corpus analyzer (auditable stats — NO LLM), categorizes archetypes, and OPTIONALLY synthesizes
`brand-dna.md` via a HOST seat (RD-2 — the engine never calls analysis LLMs directly; the seat is
injectable like the §12.5 vision seam). Scraping is BYO + no bundled creds (RD-9); ingested corpus is
Zone U (RD-8); competitor content is analyzed for PATTERNS only and never republished verbatim (a check
enforces this); cold-start never blocks onboarding (DD-21); metered actions are cost-gated (DD-18);
everything is brand-keyed (DD-10). The only operator brand is the fictional **Acme Cosmos**; the two
competitors (**Stellar Optics Co**, **Orbit Outfitters**) are invented. See
`fixtures/brand-dna-acme/PROVENANCE.md` for the full file table.

| File / dir | What it is | Provenance |
|---|---|---|
| `brand-dna-acme/brand.json` | Brand config exercising the new `ingestion` block; validates against `schemas/config/brand.schema.json`. | Authored-synthetic |
| `brand-dna-acme/system.brand-dna.json` | Partial system.json fragment exercising the new `brand_dna` + `retention` blocks. | Authored-synthetic |
| `brand-dna-acme/corpora/acme-cosmos/own/*.json` (8) | Synthetic OWN-account corpus; each validates against `schemas/inputs/corpus-item.schema.json` and carries optional engagement `metrics`. | Authored-synthetic |
| `brand-dna-acme/corpora/acme-cosmos/competitors/<name>/*.json` (4+4) | Two invented competitors' corpora; Zone U (untrusted-scraped, transient). | Authored-synthetic |
| `brand-dna-acme/recorded/scrape-responses.json` | Recorded zero-key scraper replays keyed by `${platform}:${handle}` (incl. an empty-degrade case). | Authored-synthetic |
| `brand-dna-acme/recorded/dna-synthesis.json` | Recorded zero-key DNA-synthesis seat output keyed by brand id (canned `brand-dna.md`). | Authored-synthetic |
| `brand-dna-acme/expected/*.json` (5) | Ground truth: deterministic analysis, archetype catalog, no-verbatim check, cold-start cases, cost estimate. | Authored-synthetic |
| `brand-dna-acme/expected/brand-dna.expected.md` | Expected synthesized Brand DNA (byte-identical to the recorded seat output). | Authored-synthetic |

The consumer helpers are `tests/helpers/fake-scraper-adapter.js` (RD-9 scraper seam) and
`tests/helpers/fake-dna-synthesis.js` (RD-2 DNA-synthesis host seat).

## Why no instance content migrates

Per the release gap analysis, **zero** files from the private instance pass the §13.3 r1 test
as-is. None were copied or redacted; the entire fixture estate above was regenerated clean.
