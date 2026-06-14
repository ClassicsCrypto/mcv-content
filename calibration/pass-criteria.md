# Calibration pass criteria

> The **defined pass bar** for the public calibration harness (release-spec §2.5 checkpoint C3,
> §16.4). These are the criteria `engine calibrate` grades against — the same definition the C3
> setup verifier uses (`engine/setup/checkpoints.js` `DEFAULT_CALIBRATION_CRITERIA`), so the
> runner and the gate can never disagree. A project **MUST NOT** reach the `operational`
> lifecycle state without a calibration pass (model §5.2 invariant).

This is a **bar, not a tuning surface.** It states the minimum quality posture a fresh instance
must demonstrate before going operational with the shipped ruleset. It says nothing about the
maintainer's calibrated weights, thresholds, or judging methodology — those stay maintainer-side
by decision (DD-9; see `rubric.md` for what this contract does and does not include).

## The defaults (shipped)

Run over the default `sample_count` samples (default **10**) drawn across the brand's archetypes
(see `samples/`), a calibration run **passes** when **all** of the following hold:

| Criterion        | Default              | Meaning |
|------------------|----------------------|---------|
| `sample_count`   | **10**               | At least this many samples were generated and judged. |
| `min_gate_clear` | **≥ 8 of 10**        | At least 8 samples clear the gate with **zero hard fails** (no HARD-tier code from any gate layer — `rules/codes.md`). |
| `min_on_voice`   | **≥ 6 of 10**        | The operator judges at least 6 samples **on-voice** per the shipped rubric (`rubric.md`). This is a human judgment, not an automated score. |
| `max_fabrication`| **0**                | **Zero** fabrication-class codes (`FM.FABRICATION`, `FM.SUPERLATIVE_UNBACKED`, `FM.COMPARATOR_RESKIN`) anywhere in the battery. Fabrication is a hard block; one is a fail. |

All four must hold. The criteria are graded together; a battery that clears the gate but reads
off-voice fails on `min_on_voice`, and a single fabrication code fails the whole run regardless of
the other counts.

## How a result is recorded

The runner grades a result of the shape:

```json
{ "sample_count": 10, "gate_clear": 9, "on_voice": 7, "fabrication_codes": 0 }
```

- `gate_clear` — count of samples whose gate verdict carried **no HARD code** (a `PASS` or a
  `PASS_ALTERNATE_ONLY` with only soft/warn codes both count as "clear"; a `FAIL` does not).
- `on_voice` — count the **operator** judged on-voice against `rubric.md` (the human leg of C3).
- `fabrication_codes` — count of fabrication-class codes detected across the battery.

`engine calibrate --brand <id> --result '<json>'` records this into `setup-state.json`'s C3
detail and grades it; on a pass the project advances to `calibrated` and the operator pins the
known-good baseline (a tagged commit in the instance repo — DD-6).

## Tunable, with the defaults shipped

Every value above is **config-tunable** via the `calibration` block of `config/system.json`
(`{ sample_count, min_gate_clear, min_on_voice, max_fabrication }`); the defaults in the table
ship and are what an un-configured instance is held to. Raising the bar is supported; lowering it
below the shipped defaults is the operator's call and their risk.

## On failure: the remediation loop

A failed calibration is **not** terminal — it is the signal to iterate. Adjust the Brand DNA
and/or rules, then re-run `engine calibrate` (§2.5). The project stays non-operational until a
pass is recorded. Common moves:

- **Low `gate_clear`** → inspect which HARD codes fired (`rules/codes.md`) and tighten the
  brief / DNA so drafts stop tripping them; or correct a rule that is mis-firing.
- **Low `on_voice`** → the gate passed but the voice is generic or off-brand; sharpen the Brand
  DNA voice rules and example bank, raise the `drama_dial` if the brand reads flat.
- **Any `fabrication_codes`** → a falsifiable claim has no receipt in the brand's project
  context; remove the claim or add the source. This is the one criterion with zero tolerance.

## Cost note (read before running)

Calibration is the operator's **first real spend** — it drives the chain over N samples. Before
generating anything, `engine calibrate` presents a **pre-run cost estimate** (N samples × the
configured per-sample chain cost band) and **requires confirmation** (`--yes`), the same
estimate-and-confirm contract `engine index-library` will use when the automatic indexer ships
(DD-18; §2.5). The cost band is
indicative; see `docs/cost.md` for current measured numbers. Chain-seat LLM cost is owned by the
host runtime (RD-2) and is not billed by the engine directly.

## Where this runs (and where it does not)

The calibration harness is **operator-run only** — at setup (C3) and after major rule or Brand
DNA changes. It **never runs in CI** (it spends real money — §16.4) and it **never sits in the
content path**: it evaluates the gate offline and is not a publish gate (§14.6). User installs
**never transmit any data** to the maintainer (DD-9).
