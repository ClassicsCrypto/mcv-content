# `fixtures/self-improve-acme/` — Provenance

**Every file here is synthetic / maintainer-authored, created for this repository.** None is, derives
from, or resembles any real brand, account, person, posted content, engagement dataset, secret,
partner, or operator instance. The only operator brand is the fictional **"Acme Cosmos"** (an invented
backyard-astronomy / consumer-telescope brand). Every metric, content id, and learning record is
**invented**. This satisfies the release contract that datasets without demonstrated
synthetic/operator-owned provenance never ship (release-spec §5 preamble; model §13.3 rules 1 & 3 —
regenerate-never-redact, §0.3 r6).

## What this fixture is for

The **zero-key test fixtures + config** for the **GOVERNED SELF-IMPROVEMENT LOOP** (release-spec
roadmap #3; original-design-spec §2.6 self-improvement; DD-6; §8.9 v1 boundary; §15.4 kill switch).
v1 ships analytics + learning-record **creation** (human-applied). This feature adds governed
**machine application** of within-bounds improvements derived **deterministically** from the existing
analytics — **and ships only WITH its governance, never application without governance** (DD-6).

These fixtures let the applier + its governance run in CI with **no keys and no network** (RD-12):

- **Synthetic performance data** (`analytics/raw-*.json`) the real engine analytics
  (`engine/analytics/engagement/baselines.js` + `performance-report.js`) aggregate into per-content-type
  and per-archetype groups — one group that **crosses** the evidence threshold and one that **misses**
  it, hand-verifiable from the 34 records.
- **Four fixture learning records** (`learning-records/*.json`, each conforming to
  `schemas/artifacts/learning-record.schema.json`) exercising the four governed outcomes (a/b/c/d below).
- **A config fragment** (`system.self-improve.json`) exercising the new `self_improve` block in
  `schemas/config/system.schema.json` (off-by-default gate flipped on for the test; evidence
  thresholds; canary cycles; the machine-changeable allowlist + human-set bounds).
- **A fake analyst seat** (`tests/helpers/fake-analyst-seat.js` + `recorded/analyst-refinements.json`)
  — the OPTIONAL host seat that may only **refine/annotate** the deterministic proposals (RD-2: the
  engine never calls chain LLMs; the seat can never widen the surface, lower a threshold, or loosen a
  gate; it degrades gracefully when absent).
- **Ground truth** (`expected/applier-outcomes.json`) the applier under test MUST reproduce.

## The DD-6 governance these fixtures prove (the whole point)

| # | Governance law (DD-6 / §3.1) | Proven by |
|---|---|---|
| 1 | **HUMAN-ONLY boundary** — guardrail rules, the gate, hard-fail thresholds are NEVER machine-changeable; the applier refuses structurally. | record **(b)** → `EHUMANONLY` |
| 2 | **NEVER-LOOSEN** — a machine change can never make a gate/guardrail more permissive (enforced independently of the allowlist check). | record **(c)** → `ENEVERLOOSEN` |
| 3 | **EVIDENCE THRESHOLD** — auto-applicable only above min sample/confidence/effect; else stays PROPOSED. | record **(d)** → `EBELOWTHRESHOLD` (stays `proposed`); record **(a)** crosses |
| 4 | **CANARY → OBSERVE → PROMOTE/ROLLBACK** — auto-applied change lands in a limited scope, observed N cycles, then kept or auto-rolled-back on regression. | record **(a)** → `auto_apply_canary` (`canary` config block) |
| 5 | **VERSIONED + ONE-STEP ROLLBACK** — every machine change is a versioned learning record with `engine rollback`. | record **(a)** `expected_reversible: true` + `rollback_ref` |
| 6 | **OFF BY DEFAULT + KILL SWITCH** — loop is config-gated, off by default; PAUSED sentinel halts it. | `self_improve.enabled` default false; `expected.kill_switch` (`EPAUSED` for all) |

## The four fixture learning records

| Record | Target | Mutability | Expected decision | Code |
|---|---|---|---|---|
| `lr-a-calendar-weight-auto-apply.json` | `calendar_weighting:acme-cosmos/sky-event-alert` (bump 0.20→0.30) | learnable | **auto_apply_canary** | `OK` |
| `lr-b-human-only-refuse.json` | `rules/core/claims-safety.md` (weaken hard-block → soft-warn) | human-only | **refuse** | `EHUMANONLY` |
| `lr-c-never-loosen-refuse.json` | `tunable_dial:gate.variant_distinctness.jaccard_threshold` (0.45→0.80, more permissive) | learnable | **refuse** | `ENEVERLOOSEN` |
| `lr-d-below-threshold-proposed.json` | `calendar_weighting:acme-cosmos/longform-essay` (bump 0.10→0.13) | learnable | **hold_proposed** | `EBELOWTHRESHOLD` |

Record **(c)** is the load-bearing one: it names an **allowlisted** target class (`tunable_dial`), so
it clears the human-only check — yet its *effect* loosens a gate (raising the variant-dup threshold
makes `LINT.VARIANT_DUP` fire less). It proves never-loosen is enforced **independently** of the
allowlist, exactly where a loosening change could otherwise hide behind an allowed target class.

## The synthetic performance corpus (hand-verifiable)

`analytics/raw-*.json` are 34 §7.9-conformant 7d engagement checkpoints (run
`buildWeeklyReport` over them with `weekEnding = 2099-04-08`):

| content_type / archetype | n | likes mean | effect vs `thread` baseline (mean 98) | crosses threshold? |
|---|---|---|---|---|
| `thread` / `how-to-explainer` (baseline population) | 16 | 98 | — | (baseline) |
| `sky-event-alert` / `timely-observation` | 14 | 215 | ~1.19 | **yes** (n≥12, effect≥0.2) → record (a) |
| `longform-essay` / `deep-dive` | 4 | 104 | ~0.06 | **no** (n<12 AND effect<0.2) → record (d) |

The thresholds are `min_sample_size: 12`, `min_confidence: 0.8`, `min_effect_size: 0.2`
(`system.self-improve.json → self_improve.evidence`). The corpus is regenerable with
`node fixtures/self-improve-acme/_generate.js`.

## Files

| File / dir | What it is | Provenance |
|---|---|---|
| `analytics/raw-*.json` (34) | Synthetic Acme Cosmos 7d engagement checkpoints; each validates against `performance-report.schema.json`'s checkpoint shape (after the report strip). | Authored-synthetic |
| `learning-records/lr-{a,b,c,d}-*.json` | The four fixture learning records; each validates against `schemas/artifacts/learning-record.schema.json`. | Authored-synthetic |
| `system.self-improve.json` | Partial system.json fragment exercising the new `self_improve` block (gate flipped on, fixture seat wired). Sub-validated against `schemas/config/system.schema.json#/properties/self_improve`. | Authored-synthetic |
| `recorded/analyst-refinements.json` | Recorded zero-key analyst-seat replays keyed by learning-record id. Consumed by `tests/helpers/fake-analyst-seat.js`. | Authored-synthetic |
| `expected/applier-outcomes.json` | Ground truth: per-record expected `decision` + `code`, the analytics facts, and the kill-switch override. | Authored-synthetic |
| `_generate.js` | Maintainer-only generator that (re)materializes `analytics/raw-*.json` deterministically. Not on the test path. | Authored-synthetic |

The consumer helper is `tests/helpers/fake-analyst-seat.js` (the analyst host seat, RD-2).

## Notes

- **Future-dated (2099-…):** all `captured_at` timestamps and learning-record `created_at` sit far in
  the future so a fixture record is never mistaken for a real observation and the week-window math is
  deterministic in tests.
- **Refs are `$CONTENT_HOME`-relative:** every `source_signals[].refs` and `proposed_diff` path is
  instance-relative (e.g. `analytics/…`, `rules/core/…`, `config/system.json`) — never an absolute path
  (the schema + `learning.js` forbid absolute refs).
- **The "loosening" and "human-only" records are deliberately obvious** so a test can prove the applier
  refuses them; they are diffs against shipped artifacts, never applied here — the WHOLE point is that
  the governed applier must refuse them.
- **Git-trackability:** all `.json`/`.js`/`.md` under `fixtures/` — not denied by `.gitignore` (only
  media binaries and `*.env*`/`*.token`/secret-named files are denied). Nothing here is named like a
  secrets file and the corpus holds no secret-shaped content.
- **No machine change is committed in the repo:** the fixture records are all `status: proposed`. The
  applied/rolled_back lifecycle is exercised by the test against an isolated temp `CONTENT_HOME`, never
  in the checkout (instance state lives outside the repo — model §13.2).
