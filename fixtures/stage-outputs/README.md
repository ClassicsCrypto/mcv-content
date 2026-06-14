# Recorded stage-output fixtures (`fixtures/stage-outputs/`)

The **recorded LLM-stage artifacts** the zero-key `engine fixture-run` replays (release-spec §5.4;
model §13.1 MUST). `engine fixture-run` exercises the deterministic spine end-to-end on a fresh
clone with **no live API keys and no `CONTENT_HOME`**:

```
brief.json
  → recorded writer output (draft.json, 3 variants)
  → deterministic pre-gate (pre-gate-lint)            [runs LIVE]
  → recorded LLM-gate verdicts (gate-verdicts.json)   [replayed, not judged]
  → package assembly
  → validate-package + platform gates + cooldown      [runs LIVE]
        (cooldown checked against usage-log.jsonl + media-decision.json)
  → mock approval-card artifact (temp dir, no Discord)
  → simulated approval
  → executor dry-run to a stub publisher adapter
```

**LLM-dependent stages replay these recorded artifacts; deterministic stages run live** (§5.4).
This is the honest reading of "fixture content end-to-end to a mock approval card with zero live
API keys": the regexable gates run for real, the LLM stages are pre-recorded. CI runs the whole
thing on every push (§16.5) with zero keys (RD-12).

All files here are **freshly authored synthetic Acme Cosmos content** — never copied from any of
the production run artifacts (§18.2(6); `fixtures/PROVENANCE.md`). Content id throughout:
`acme-fixture-0001`.

## The files

| File | Schema | Role in the spine |
|---|---|---|
| `brief.json` | `schemas/inputs/brief.schema.json` | The matcher→writer brief — the spine entry point. A SAFE-mode text Twitter slot, builder-recap archetype. |
| `draft.json` | `schemas/inputs/draft.schema.json` | The recorded writer output: 3 distinct variants on one verified anchor. **Passes the live `pre-gate-lint` clean** (verified during authoring: no em dash / inflation / financial / placeholder / banned pattern, all in the 100–280 window, three distinct angles). |
| `gate-verdicts.json` | each stage → `schemas/artifacts/validation-result.schema.json` | The recorded LLM-gate verdicts: an `llm-voice` stage (clean) + an `llm-quality` stage + the `final_verdict` union. Demonstrates the **union-of-codes contract** (DD-3): the live pre-gate's detections are carried forward and the LLM **adds but never drops** codes — including one advisory (`FM.UNVERIFIED_CAUSAL`, non-blocking) and one SOFT `warn` with `bars_recommended` (`FM.STATUS_RECAP` on Variant B). The Recommended pick stays code-clean, so the union verdict is `PASS_ALTERNATE_ONLY` with `recommended` as the named pick. |
| `media-decision.json` | `schemas/artifacts/media-decision.schema.json` | The recorded media stage decision: a `reuse` action on a past-cooldown asset, with the cooldown evaluation and one skipped (in-cooldown) candidate recorded. |
| `usage-log.jsonl` | canonical `{asset_id, content_id, used_at}` (DD-14) | The cooldown history the live `validate-package` cooldown leg reads. **One asset inside the 14-day hard floor** (`beta-hero-closeup.png`, the skipped candidate) and **one outside** (`beta-wall-overview.png`, the chosen reuse asset). |

## Two labeling notes (read before editing)

1. **`recorded_fixture` label.** `gate-verdicts.json` carries `"recorded_fixture": true` +
   `"fixture_note"` at the top level — its consumers read the `validation-result`-shaped objects
   under `stages`/`final_verdict`, and the `validation-result` schema is `additionalProperties:true`,
   so the labels are schema-legal there. `brief.json`, `draft.json`, and `media-decision.json` are
   bound to **`additionalProperties:false`** schemas, so they CANNOT carry an inline label without
   failing the §16.5 schema-validation job — their "recorded fixture" status is established here and
   by their location under `stage-outputs/` (not by an inline key). Do not add `recorded_fixture`
   to those three files.

2. **Date-relative cooldown.** `usage-log.jsonl` ships literal ISO `used_at` timestamps for
   inspection, but each entry also carries `_fixture_offset_days_ago`. Because the cooldown gate
   compares `used_at` to `Date.now()`, a fixture run that wants byte-stable cooldown results across
   calendar time should **rebase** each `used_at` to `now − _fixture_offset_days_ago` when it seeds
   its temp `CONTENT_HOME` (the same technique the `gate-regression/cooldown/` fixtures use). The
   in-window / out-of-window distinction (3 days vs 35 days) is what matters and is offset-stable.

## Consumed by

`bin/engine.js fixture-run` + `engine/setup/fixture-run.js` (P4-FIXRUN) replay these; a small
`tests/engine/stage-output-fixtures.test.js` (P4-FIX-STAGE / P4-TEST) asserts `draft.json` passes
`pre-gate-lint` and the recorded verdict set satisfies the union contract — catching fixture rot
before it surfaces as a fixture-run failure.
