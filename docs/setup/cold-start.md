# Cold start — a brand with no history

A brand with no posting history, no corpus, and no media library is **fully supported** in v1 (DD-21).
Explicit non-support is *not* the path: cold start is a first-class flow that gets a brand to its first
approval card using interview-driven authoring instead of corpus analysis, and empty-library mode
instead of an index.

This is the C2/C4 detail for the history-less case. It slots into the broader walk in
[`full-setup.md`](full-setup.md); for the rest of a brand's C2 (registration, corpus intake when you
*do* have data) see [`brand.md`](brand.md).

## What cold start uses instead

| Normal path | Cold-start substitute |
|---|---|
| Brand DNA from corpus analysis | **Manual Brand DNA authoring template** (interview-driven) |
| Archetype catalog mined from history | **Starter archetype set** from a shipped template |
| Indexed media library | **Empty-library mode** (`cold_start: true`) — retrieval is generate-only |

Nothing in the chain hard-depends on a populated index or a corpus; the cold-start brand calibrates
and operates on authored DNA alone.

## Step 1 — register the brand

Write `brands/<brand-id>/brand.json` from `templates/brand/brand.json.template` exactly as in the
normal flow (`id`, `display_name`, `account_class`, at least one `platforms[]` entry). The only
cold-start-specific field comes in step 3.

## Step 2 — author the Brand DNA from the manual template

v1 Brand DNA is **agent-assisted authoring** — and with no corpus, the authoring template is the whole
input. The host agent interviews you and fills `templates/brand/brand-dna-authoring.md`, producing
`brands/<id>/brand-dna.md`. The template captures identity, tone, voice rules, audience, taboos, the
drama/dial preference (matching the `brand.json` `drama_dial`), and an example bank you supply by hand.
Its frontmatter is schema-validated.

This is the same template that automated DNA generation will *eventually* populate (that automation is
roadmap, not v1) — so authoring it by interview now loses you nothing structural.

## Step 3 — starter archetypes + empty-library mode

1. Seed the archetype catalog from `templates/brand/archetypes.template.md` (a starter set). You may
   leave the catalog otherwise empty.
2. If the archetype catalog is empty, set **`cold_start: true`** in `brand.json`. This is the flag
   that:
   - tells retrieval to return **generate-only** decisions (no index lookups), and
   - tells the C2 verifier to **accept an empty archetype catalog**.

> The C2 verifier accepts an empty archetype catalog **only** when `cold_start: true` is set.
> Otherwise it fails with the remediation to add archetypes or set the flag.

### Empty-library mode (C4)

A cold-start brand has no media library, which is fine: **empty-library mode is fully supported**.
Leave the library disabled; retrieval returns generate-only decisions and the C4 verifier passes
without an index.

A cold-start brand typically has nothing to index yet, so empty-library mode is the right default.
When you do add media later, **library indexing is available** — `engine index-library` visual-tags
assets through your configured vision provider (estimate-and-confirm, incremental, never re-billing an
already-indexed asset), or you can hand-author `index.json` against the archive-index-entry schema.
With no media present, `engine index-library` is a clean no-op. Full detail: [`../library.md`](../library.md).

## Step 4 — calibrate and verify as usual

Cold start changes the *inputs*, not the gates. Calibrate exactly as in the normal flow:

```
engine calibrate --brand <id> --estimate-only
engine calibrate --brand <id> --yes
engine calibrate --brand <id> --result '{"sample_count":10,"gate_clear":9,"on_voice":7,"fabrication_codes":0}'
engine verify --setup c2
engine verify --setup c3
engine verify --setup c4
```

The mandatory calibration gate (C3) applies unchanged — a cold-start brand still cannot advance
without a pass. See [`brand.md`](brand.md#calibrate-c3--the-mandatory-gate) for the pass criteria.

## Moving off cold start later

Cold start is not a permanent mode. At any time you can:

- add corpus data (manual submission, own-account export, or a BYO scraper adapter — see
  [`brand.md`](brand.md#corpus-intake-optional-c2-step-2)),
- add real archetypes and clear `cold_start`,
- populate the media library (`engine index-library` to auto-tag, or manual `index.json`),

then **re-run calibration** to re-baseline. The docs state plainly that calibration quality improves
once you add corpus data; cold start gets you operating, not stuck.

## See also

- [`brand.md`](brand.md) — full C2 brand setup (registration, corpus, DNA).
- [`full-setup.md`](full-setup.md) — the complete C0–C4 checkpoint walk.
- [`quick-start.md`](quick-start.md) — the smallest path (uses cold start at C2 by default).
- [`../troubleshooting.md`](../troubleshooting.md#cold-start-a-history-less-brand) — cold-start
  verifier failures.
