# Fixture brand — "Acme Cosmos"

> **Every file here is synthetic, authored for this repository** (release-spec §5.1–§5.2;
> model §13.3 r1). "Acme Cosmos" is a fictional consumer space-telescope / backyard-astronomy
> brand. Nothing here resembles any real brand, product, person, or account. Full provenance:
> `fixtures/PROVENANCE.md`.

This is the complete fixture brand estate the engine's examples, the zero-key fixture run
(`engine fixture-run`, release-spec §5.4), and the docs reference. Every structured file
validates against its published schema in `schemas/`.

## Contents

| Path | Schema it validates against | Spec |
|---|---|---|
| `brand.json` | `schemas/config/brand.schema.json` | §5.1, §11.3 |
| `brand-dna.md` | — (markdown; DD-21 authoring template shape) | §5.1 |
| `background.md` | — (markdown) | §5.1 |
| `archetypes/*.md` (4) | — (markdown; seeds/hooks) | §5.1 |
| `corpus/own-corpus.jsonl` (40 lines) | `schemas/inputs/corpus-item.schema.json` | §5.1, §6.2 |
| `media/*.png` (6) | — (CC0 placeholder image assets) | §5.1 |
| `media/index.json` | `schemas/artifacts/archive-index-entry.schema.json` (per `assets[]` entry) | §5.1 |
| `calendar.json` | `schemas/config/calendar.schema.json` | §5.2, §6.5 |
| `campaign.json` | `schemas/config/campaign.schema.json` | §5.2, §8.7 |
| `commands/*.json` (4) | `schemas/inputs/operator-command.schema.json` | §5.2, §6.1 |

## Brand at a glance

- **id:** `acme-cosmos` · **account_class:** `brand` · **drama_dial:** `low`
- **Platforms:** twitter (postiz, primary text lane), instagram (postiz, visual lane),
  giphy (giphy, reaction loops).
- **Pillars:** `sky-tonight`, `how-to` (strongest), `field-notes`, `behind-the-glass`.

## How the pieces connect

- `calendar.json` slots reference the brand id and platforms in `brand.json`, and dispatch the
  RUN_* families in `commands/`. Slot ids follow the `acme-<day>-<pos>` convention.
- `campaign.json` (`acme-first-light-week`) claims `acme-fri-*` slots during its window and
  overrides their theme (§8.7).
- `commands/run-trend-manual.json` targets the trend-reserved giphy slot `acme-wed-02`.
- `media/index.json` describes the six `media/*.png` assets for the retrieval/cooldown path;
  its `path` values are `$CONTENT_HOME`-relative (`library/media/acme-cosmos/...`).
