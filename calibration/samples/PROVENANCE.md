# Calibration samples — provenance

> Provenance statement for every calibration sample asset (release-spec §5 fixture-provenance
> rule, model §13.3 r1; mirrored here because calibration content is held to the same
> regenerated-not-redacted bar — §0.3 r2/r6, §18.2). The CI hygiene scan asserts this manifest is
> complete.

## Origin

Every file under `calibration/samples/` is **synthetic, authored fresh** for the public release.
Nothing here is derived from any operator instance, any private testing estate, any scraped
corpus, or any real brand. Specifically:

- **Clean-room.** None of this content was copied or adapted from the maintainer's private
  calibration material — no five-judge personas, no judging methodology, no gold sets, no
  peer-rank/tournament material, no calibration corpora (all §18.2(2)-excluded). The sample set,
  the rubric dimensions, and the pass bar were written from the public spec (§2.5 pass criteria,
  §16.4 harness) only.
- **One synthetic brand.** The only brand referenced is the fictional **"Acme Cosmos"** — a
  made-up open-source space-mission-planning project with a public beta and a builder community.
  Acme Cosmos has no relationship to any real brand or project. The same synthetic brand is used
  across the repo's fixtures.
- **Placeholders only.** No real handles, channel/user/guild IDs, absolute paths, tokens, dates
  tied to real events, or secret values appear in any sample. Slot ids (`cal-*`) and brand id
  (`acme-cosmos`) are synthetic. Any media a visual sample alludes to is a synthetic placeholder;
  no media binaries ship in this directory.
- **Facts are invented and self-consistent.** Every falsifiable detail in a sample (the offline
  trajectory solver, the caching bug, "one full week with no scrubbed windows", the beta sign-up
  window) is a fictional Acme Cosmos event authored for this set. They exist so the fact-safety
  dimension has something coherent to trace against — they are not claims about anything real.

## Per-file manifest

| File | Kind | Origin |
|------|------|--------|
| `samples.json` | sample manifest | authored fresh (synthetic) |
| `cal-01.sample.json` … `cal-10.sample.json` | calibration sample specs | authored fresh (synthetic Acme Cosmos) |
| `PROVENANCE.md` | this file | authored fresh |

## Schema conformance

Each sample's `command` block conforms to `schemas/inputs/operator-command.schema.json`
(`RUN_SLOT` with `slot_ref`, valid `mode`/`routing_class` enums). The sibling calibration
metadata (`sample_id`, `archetype`, `expected_posture`, `exercises`, `reviewer_note`) lives
outside the command object so the command stays schema-valid (the operator-command schema is
`additionalProperties: false`).

## What "expected posture" means

The `expected_posture` on each sample is **authoring intent, not a graded answer key.** Most
samples are designed as clean on-voice pieces; `cal-08` (weak-hook) and `cal-09` (substitutable)
are deliberately seeded to surface a specific weakness so the harness exercises the gate's and the
rubric's discrimination. The battery as a whole is authored to still clear `pass-criteria.md`
(≥ 8/10 gate-clear, ≥ 6/10 on-voice, 0 fabrication) — calibration is a bar, not a demand for a
flawless ten.
