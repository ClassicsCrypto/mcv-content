# `fixtures/library-acme/` — Provenance

**Every file here is synthetic / maintainer-authored, created for this repository.** None is, derives
from, or resembles any real brand, product, company, person, account, posted content, scraped corpus,
NFT, or operator instance. The only brand is the fictional **"Acme Cosmos"** (an invented backyard-
astronomy / consumer-telescope brand). Astronomical objects referenced (Moon, Jupiter, the Orion
Nebula, the Pleiades, comets) are public, free-to-mention sky objects, not anyone's IP. This satisfies
the release contract that datasets without demonstrated synthetic/operator-owned provenance never ship
(release-spec §5 preamble; model §13.3 rules 1 & 3 — regenerate-never-redact, §0.3 r6).

## What this fixture is for

The **zero-key test fixtures + fake vision provider** for the library auto-indexer (release-spec §1.5
asset auto-index / folder-sort / tag; §7.8 archive index; §12.5 vision-provider seam). It lets the
indexer (LIB-CORE) run in CI with **no keys and no network**: a fake `visionFn(filename)` returns the
recorded answers in `expected/vision-responses.json` instead of calling a real vision model (RD-12 —
the vision call is dependency-injectable so CI holds no secrets).

The synthetic media is laid out across the §1.5 folder-sort template buckets (`Images/`, `Videos/`,
`AI-generated/`) plus an `unsorted/` root that mixes media kinds (the pre-sort input a folder-sort run
would organize).

## Files

| File / dir | What it is | Provenance |
|---|---|---|
| `Images/moon-first-quarter.png` | Tiny (1×1) valid PNG placeholder; library image. | Authored-synthetic / CC0 |
| `Images/jupiter-moons-line.png` | Tiny (1×1) valid PNG placeholder; library image. | Authored-synthetic / CC0 |
| `Images/st1-on-table.jpg` | Tiny placeholder (PNG bytes under a `.jpg` name — sniffer falls back to extension); has a sidecar. | Authored-synthetic / CC0 |
| `Images/st1-on-table.meta.json` | Sidecar metadata marker (approval_lineage + usage_history) the indexer merges (§8.6, DD-14). | Authored-synthetic |
| `Images/orion-nebula-wide.png` | Tiny (1×1) valid PNG placeholder; library image. | Authored-synthetic / CC0 |
| `Videos/pleiades-pan-clip.mp4` | Minimal valid MP4 (`ftyp isom` + a `free` box marked SYNTHETIC); library video. | Authored-synthetic / CC0 |
| `Videos/setup-timelapse.webm` | Minimal placeholder WEBM (EBML magic + SYNTHETIC marker); library video. | Authored-synthetic / CC0 |
| `AI-generated/nebula-keyart-gen.png` | Tiny (1×1) valid PNG placeholder; generated-class asset. | Authored-synthetic / CC0 |
| `AI-generated/mascot-orbit-loop.gif` | Minimal valid GIF89a placeholder; animated generated asset; refs the mascot character. | Authored-synthetic / CC0 |
| `unsorted/app-tonight-card.png` | Tiny PNG placeholder at the unsorted root (image — folder-sort would route to `Images/`). | Authored-synthetic / CC0 |
| `unsorted/comet-flyby-raw.mp4` | Minimal MP4 placeholder at the unsorted root (video — folder-sort would route to `Videos/`). | Authored-synthetic / CC0 |
| `character-markers/acme-mascot-comet.character.json` | Existing-character-sheet marker so the indexer SKIPS the metered auto-generate path (§1.5, DD-18). | Authored-synthetic |
| `expected/vision-responses.json` | Recorded vision answers keyed by basename ({type, description, tags, content_tags, duration?, character_refs}) the fake `visionFn` returns. | Authored-synthetic |
| `expected/index-entries.json` | Golden post-sort `archive-index-entry` outputs; each entry validates against `schemas/artifacts/archive-index-entry.schema.json`. | Authored-synthetic |

## Notes

- **Media bytes are real magic-number-valid headers** (PNG/GIF89a/MP4 `ftyp`/EBML) but carry no
  decodable picture content — they are unmistakably placeholders. Video/MP4/WEBM files embed a literal
  `SYNTHETIC-FIXTURE-NOT-A-REAL-VIDEO` marker.
- **Git-trackability:** the repo `.gitignore` denies media binaries by default, then re-allows them
  under `fixtures/**` (the `!fixtures/**/*.{png,jpg,jpeg,webp,gif,mp4,mov,webm}` negations). All media
  here was confirmed `git check-ignore`-clean (trackable) at authoring time.
- **Mutation safety:** these fixtures exist precisely so the indexer's metered/mutating paths
  (vision tagging, folder-sort moves, character-sheet generation) can be tested DRY-RUN with no spend
  and no real file moves — the fake `visionFn` never bills and the expected outputs let a test assert
  idempotence + the never-re-bill contract (DD-18).
- The fake provider helper that consumes these recordings is `tests/helpers/fake-vision.js`.
