<!--
  docs/library.md — the media library: indexing, folder auto-sort, and character sheets
  (release-spec §1.5 asset management; §7.8 archive index entry + retrieval; §12.5 vision/image-gen
  provider seam; §15.4 cost; §17.6 accuracy rule; DD-18 estimate-and-confirm; DD-21 empty-library).
  Normative-behavior doc: kept consistent with engine/library/* and engine/cli/index-library.js.
-->

# The media library

The library is your store of operator-owned media — images, video, animated GIFs — that the chain can
**retrieve** instead of generating from scratch. `engine index-library` is the one verb that manages
it, with three sub-actions:

- **Auto-index** (default) — visual-tag every asset so retrieval can find it.
- **Folder auto-sort** (`--organize`) — sort loose media into `Images / Videos / AI-generated`.
- **Character sheets** (`--character-sheets`) — detect which roster characters have a reference sheet,
  and optionally generate the missing ones.

**Empty-library mode is the default and is fully supported** (DD-21): with no media present, retrieval
returns generate-only decisions, nothing in the chain hard-depends on a populated index, and every
sub-action is a clean no-op. You only touch the library when you have media to work with.

Everything that **spends** (vision tagging, character-sheet image generation) is **estimate-and-confirm
and dry-run by default** (DD-18): no `--yes` / `--apply`, no spend. Everything is **incremental and
idempotent**: an already-processed asset is skipped and **never re-billed**.

---

## 1. Media indexing (vision-tagging)

```
engine index-library --estimate-only     # scan + cost band; spends nothing
engine index-library --yes               # confirm and index in resumable batches
```

Indexing scans `$CONTENT_HOME/library/media` (recursively; dotfiles and symlinks are skipped), and for
each asset asks your configured **§12.5 vision provider** for:

- a **description** — one or two sentences of what is in the asset and what it is about;
- searchable **tags** — lowercase keywords (subjects, scene, mood, style);
- a media **type** read — `image` / `video` / `animated_image`;
- a **duration** (for video).

It writes one schema-conformant **archive-index entry** per asset
(`schemas/artifacts/archive-index-entry.schema.json`: `asset_id`, `path`, `type`, `description`,
`tags`, `duration`, `source_class`, `character_refs`, …). New library assets default to
`source_class: "library"`. The retrieval path (`engine/library/check.js`) consumes this index.

### Incrementality — never re-bills

Each asset gets a content **fingerprint** (a SHA-1 of the file for small files; a bounded
head+tail+size signature for large ones, so a 200 MB video does not stall the scan). On a re-run, an
asset whose fingerprint is unchanged and already indexed is **skipped** — no vision call, **no spend**.
The cost estimate is computed from the **exact same partition** the build loop uses, so the estimate
and the actual spend can never disagree. Indexing also persists in **batches** (default every 25
assets), so an interrupted run resumes without re-doing completed work.

- `--force` re-indexes **every** asset — a deliberate, confirmed re-spend.
- `--no-hash` fingerprints by `path+size+mtime` instead of hashing file contents (faster scan, slightly
  weaker change detection).

### Cost (estimate-and-confirm)

The vision model is **metered** and **host-runtime-owned** (the engine routes through the provider but
the spend is your provider's — see [`cost.md`](cost.md)). Without `--yes`, `index-library` **halts with
the pre-run estimate** (scanned / already-indexed / to-index counts × the per-asset band) and indexes
nothing. The per-asset band is **INDICATIVE** — a placeholder `$0.001–$0.01` marked "measured as of
`<date>`" (§17.6), config-overridable via `cost.per_asset_usd` in `system.json`. A stale band is a docs
bug, not a release blocker; `engine index-library --estimate-only` is the authoritative current number
for your install.

### Status envelopes

`index-library` reports an honest status: `empty-library` (no media — no-op), `up-to-date` (nothing to
do — no re-billing), `estimate-only`, `awaiting-confirmation` (the DD-18 halt — exit 0 so the agent
re-invokes with `--yes`), `indexed`, or `indexed-with-errors` (a single asset's vision failure is
recorded and skipped, never aborting the run — that asset retries next run). If you confirm an index
but **no vision provider is configured**, the verb fails with a clear `no-provider` message (exit 3) —
configure the §12.5 provider block, or use empty-library / manual population instead.

### Manual population (no provider needed)

You can hand-author `index.json` entries against the archive-index-entry schema instead of running the
indexer at all. The C4 verifier accepts a manually populated index exactly like an auto-indexed one.

---

## 2. Folder auto-sort (`--organize`)

```
engine index-library --organize           # plan the moves (DRY-RUN — changes nothing)
engine index-library --organize --apply   # perform the moves
```

Folder-sort classifies loose media under `$CONTENT_HOME/library` and sorts it into template subfolders:

| Folder | Holds |
|---|---|
| `Images/` | stills (png, jpg, jpeg, webp, bmp, tiff, svg, heic, …) |
| `Videos/` | time-based media (mp4, mov, webm, avi, mkv, **gif** animations, …) |
| `AI-generated/` | anything detected as model-generated (takes precedence over kind) |

**AI-generated detection** is marker-first and brand-neutral: a sibling sidecar
(`<file>.json` / `<file>.meta.json` / `<file>.txt`) declaring the asset generated
(`source_class: generated|modified`, `ai_generated: true`, a generator/model field, …), **or** a
generation marker in the filename (`ai-gen`, `gpt-image`, `dalle`, `sdxl`, `midjourney`, `flux`,
`imagen`, …), **or** an archive-index entry whose `source_class` is `generated` / `modified`.

This is a **pure FS reorganization — no spend, no network** — but it is still **dry-run by default**
for mutation safety. It is:

- **idempotent** — an asset already in its correct subfolder is left in place; a second run is a no-op;
- **non-destructive** — a name collision in the destination gets a numeric suffix; a move never
  overwrites an existing file;
- **contained** — it operates only inside `$CONTENT_HOME/library`; anything that would escape the root
  is refused and reported, never moved;
- **tolerant** — an unreadable file is reported and skipped, never fatal;
- **index-consistent** — when an archive-index entry references a moved asset by its
  `$CONTENT_HOME`-relative `path`, that path is rewritten on `--apply` so retrieval keeps pointing at
  the file.

---

## 3. Character sheets (`--character-sheets`)

A character sheet is a reference image for a recurring brand character. The roster of characters that
*should* have sheets is **operator config** (`system.json` → `character_sheets.roster`, optionally
brand-scoped with `--brand`). There are two paths.

### Detection (always available, zero-key)

```
engine index-library --character-sheets
```

Detection reads the library index and the roster and reports, per character, whether a sheet already
exists (by a `character-sheet` tag, a `character-sheets/` path segment, a `character_refs` back-link, or
a source-class marker) and which characters are **missing** one. It is **deterministic, zero-spend,
zero-write, zero-key** — always available.

### Generation (metered, approval-gated, dry-run, provider-dependent)

```
engine index-library --character-sheets --generate              # estimate + plan (no approval yet)
engine index-library --character-sheets --generate --yes        # approve; DRY-RUN unless --apply
engine index-library --character-sheets --generate --yes --apply  # generate the missing sheets (spends)
```

> **Honest scope:** *detection* fully works with no provider and no keys. *Generation* requires a
> **configured image-gen provider** (the §12.5 provider seam, image-gen variant). When no image-gen
> provider is configured, generation **degrades to a no-op** — it skips with a clear message and
> **never fabricates a sheet**. So "character sheets" in v1 means: detection always; generation when
> you have wired an image-gen provider.

Generation is guarded the same way indexing is:

- **approval-gated** (DD-18): without `--yes` it halts with the cost estimate for the whole missing
  batch (the §1.5 "if approved" gate) and generates nothing;
- **dry-run by default**: `--yes` without `--apply` plans the work and writes nothing; `--apply`
  performs the metered image-gen call;
- **idempotent**: a character that already has a sheet is never re-generated — an already-processed
  asset is never re-billed;
- **degrade-to-skip**: no image-gen provider ⇒ a clean skip, not a crash.

The per-sheet image-gen cost band is **INDICATIVE** (placeholder, config-overridable via
`cost.per_image_usd`) until a measurement pass fills it.

---

## 4. Where this fits in setup (C4)

The library is the **optional** half of checkpoint C4 (calendar is the required half). The C4 verifier
passes any of: **empty-library mode** (default), an **auto-indexed** library, or a **manually
populated** `index.json`. See [`setup/brand.md`](setup/brand.md#calendar-and-library-c4) and
[`setup/cold-start.md`](setup/cold-start.md) — a cold-start brand starts in empty-library mode and adds
media later with no loss.

## See also

- [`cost.md`](cost.md) — the engine-metered vs host-runtime spend split; the estimators.
- [`configuration.md`](configuration.md) — the `library`, `cost`, `character_sheets`, and provider
  config blocks, and the `$CONTENT_HOME` layout.
- [`architecture.md`](architecture.md) — where library state lives and how retrieval consumes the index.
- `schemas/artifacts/archive-index-entry.schema.json` — the per-asset index entry shape.
- [`../agent.md`](../agent.md) — the C4 library step and the `index-library` verb row.
