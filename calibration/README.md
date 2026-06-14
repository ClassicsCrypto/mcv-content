# Calibration harness — content

This directory holds the **content** the public calibration harness runs (release-spec §2.5
checkpoint C3, §16.4; DD-9 public half). It is the operator-run quality check that a fresh
instance must pass before it goes operational with the shipped ruleset.

```
calibration/
├── samples/            # synthetic Acme Cosmos sample specs across archetypes (+ manifest, PROVENANCE)
├── rubric.md           # the PUBLIC judging rubric — the dimensions a sample is judged on
└── pass-criteria.md    # the defined pass bar the runner grades against
```

## What this is

- **`pass-criteria.md`** — the bar: ≥ 8 of 10 samples clear the gate with zero hard fails, the
  operator judges ≥ 6 of 10 on-voice, zero fabrication-class codes. Config-tunable; defaults ship.
- **`rubric.md`** — the contract: the qualitative dimensions (on-voice, fact-safety, structure,
  legibility, visual fit) a sample is judged on. **Not** calibrated weights, thresholds, or a
  multi-judge methodology — those stay maintainer-side by decision (DD-9).
- **`samples/`** — a synthetic Acme Cosmos sample battery across archetypes, each carrying an
  expected quality posture. All synthetic; see `samples/PROVENANCE.md`.

## How it runs

The runner is `engine calibrate --brand <id>` (built separately; `engine/cli/calibrate.js`). It:

1. Presents a **pre-run cost estimate** and **requires confirmation** (`--yes`) — calibration is
   the operator's first real spend (DD-18; see `pass-criteria.md`).
2. Generates N sample drafts across the brand's archetypes via the chain and gates them.
3. Lets the operator judge them against `rubric.md`, then grades the tally against
   `pass-criteria.md` and records the C3 result.

An operator can also record an externally-judged battery directly:
`engine calibrate --brand <id> --result '{"sample_count":10,"gate_clear":9,"on_voice":7,"fabrication_codes":0}'`.

## Where it does NOT run

- **Never in CI** — it spends real money (§16.4).
- **Never in the content path** — it evaluates the gate offline; it is not a publish gate (§14.6).
- **Never transmits data to the maintainer** — user installs are self-contained (DD-9). The
  maintainer's heavy calibration instance is a separate, private thing; this harness is the honest
  public quality contract, not a clone of it.
