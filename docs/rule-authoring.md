# Rule authoring

How to read, override, and write rules — and where the line is between what a rule may say and what
stays maintainer-side. Rules are the shipped, editable quality contract; the unified failure-code
registry (`rules/codes.md`) is their machine-readable index. The shipped rules in `rules/` are the
authority; this doc states the format and the rules of engagement.

## 1. Rule format

A rule is a **markdown file with YAML frontmatter.** The frontmatter is machine-readable and anchors
the failure-code taxonomy; the body is the human/agent-facing contract (prose definition, examples,
reviewer guidance). Required frontmatter keys:

```yaml
---
id: rule.core.hook-strength          # stable id (namespaced: rule.<area>.<name>)
title: Hook strength requirements
scope: global | brand | platform     # the rule's reach
platforms: [twitter]                 # required when scope: platform
category: structure | voice | safety | formatting | media | packaging
severity: hard | soft                # maps to the validation-result severity
disposition: block | correct | warn  # how a detection is handled (soft only; hard ⇒ block)
bars_recommended: true | false       # a warn that bars the Recommended slot (ships A/B)
codes: [FM.HOOK_WEAK]                # the registry codes this rule emits
mutability: human-only | learnable   # may a learning record change it?
version: 1.0.0
provenance: shipped                  # shipped | operator | learned
tests: [gate-regression/hook-strength/*]   # gate-regression fixture refs
---
(rule body: prose definition, examples, reviewer guidance)
```

Key semantics:

- **`severity`** — `hard` (a detection blocks the item, `FAIL` verdict, routes back) or `soft` (the
  code travels with the item).
- **`disposition`** — `block` (hard codes), `correct` (a deterministic, mechanically-safe correction
  applied before the card is built), or `warn` (the code travels to the reviewer on the card).
- **`bars_recommended`** — a `warn` code may additionally bar the affected variant from the
  Recommended slot, so it ships as A/B. This is the demote-as-a-flag mechanism.
- **`mutability`** — `human-only` means no learning record may change it (guardrail/safety rules MUST
  be `human-only`); `learnable` means an applied learning record may.
- **`provenance`** — shipped vs operator-authored vs machine-learned. See the configuration
  provenance classes in [`configuration.md`](configuration.md#provenance-is-first-class).

Here is a real shipped example — `rules/core/formatting.md`:

```yaml
---
id: rule.core.formatting
title: Punctuation and formatting hygiene
scope: global
category: formatting
severity: hard
disposition: block
bars_recommended: false
codes: [LINT.EM_DASH]
mutability: human-only
version: 1.0.0
provenance: shipped
tests: [gate-regression/formatting/*]
---
```

## 2. The unified failure-code registry (`rules/codes.md`)

There is one registry for every code any gate layer can emit. It collapses the production
five-taxonomy split onto six namespaced families:

| Family | Source layer | What it catches |
|---|---|---|
| `LINT.*` | deterministic pre-gate (`engine/gate/pre-gate-lint.js`) | cheap structural/lexical checks before any LLM spend |
| `FM.*` | LLM content gate (voice + quality) | voice register, fabrication/claims safety, argument, hook, legibility, style |
| `PKG.*` | deterministic package/publish-edge gate (`validate-package.js`) | package integrity, variant/visual presence, media cooldown |
| `PLAT.*` | per-platform gate (`platform-gates.js`) | per-platform packaging/limit rules |
| `VIS.*` | visual gate (`engine/gate/visual-check/`) | image brand-fidelity, embedded text, provider state |
| `SYS.*` | runtime/integrity at the publish edge (`publish-executor.js`) | publish-time integrity, retry exhaustion, handoff/crash safety |

Each registry entry conforms to `schemas/artifacts/code-registry-entry.schema.json`:
`{ code, family, tier (hard|soft), source, disposition, route?, description, rule_ref }`. `route`
names the seat a routed-back failure goes to.

Two contracts you must respect:

- **Every code on every artifact MUST exist in the registry.** CI validates this.
- **Union of codes:** a downstream layer may *add* codes but never *drop* a deterministic detection.
  The final verdict carries the union of every layer's codes.

**Tier → verdict:** any HARD code ⇒ `FAIL`. SOFT-only ⇒ `PASS_ALTERNATE_ONLY` when a soft code
carries `bars_recommended`, else `PASS`. The Recommended (strongest) variant pick must be code-clean.
One code, `FM.UNVERIFIED_CAUSAL`, is **advisory**: non-blocking and Recommended-eligible — it rides
onto the card as a note for the reviewer's decision.

## 3. Soft-fail handling and the v1 posture (`correct` is dormant)

DD-20's correct-vs-warn vocabulary ships as specified, but v1 ships **zero `correct` rules**: every
shipped soft code is `disposition: warn`, and demotion is carried by `bars_recommended`. The
`correct`-disposition application path is **feature-gated and inactive** — it activates per-rule only
when a specific rule earns it after v1. Practically:

- Do **not** ship a v1 rule with `disposition: correct` expecting auto-correction to fire — the path
  is dormant.
- Only mechanically-safe corrections (whitespace/formatting/limit-trim classes) may ever be
  `correct`. When the path activates, the card shows final text + original + correction record;
  nothing mutates content after the reviewer saw it.

## 4. Precedence and overrides

- Operator-authored and learned rules live in `$CONTENT_HOME` and **override/extend** shipped rules
  by id and scope precedence: **brand > platform > global.**
- **Overridden copies survive upgrades.** A versioned release never silently replaces your
  overrides; provenance classes make the shipped-vs-overridden diff visible.
- A rule implemented as a code check (lint constants, platform gates) MUST still have a registry
  entry and a paired rule file: **the code is the enforcement, the rule file is the contract.** For
  example, `LINT.EM_DASH` is enforced in `pre-gate-lint.js`, registered in `codes.md`, and contracted
  in `rules/core/formatting.md`.

## 5. Mutability and learning records

- **Guardrail and safety rules MUST be `mutability: human-only`.** The learning-application tool
  refuses any diff against a `human-only` rule.
- A `learnable` rule may be changed only via an **applied Learning Record** — never by in-place
  mutation. v1 ships record *creation* (proposed records, human-applied with instance-repo rollback);
  machine application is feature-gated/roadmap.

## 6. The ceiling — what a rule may NOT contain (DD-9)

The public ruleset ships the **contract**: what is checked, the codes, tiers, dispositions, routes,
and human/agent-facing definitions and examples. It does **not** ship the maintainer's calibrated
judgment:

- No calibrated firing thresholds, scoring weights, or model-judge tuning for `FM.*` codes.
- No exemplar batteries or gold-set tuning that decides *when* an LLM gate fires.
- No private judging methodology.

The shipped `gate` config block carries only **generic day-one defaults** (e.g. variant-distinctness
thresholds) clearly marked as starting points, not calibrated values. A rule body may describe the
contract and give illustrative examples; it must not encode the maintainer's calibrated instance.
The public quality contract is the shipped ruleset + the lightweight calibration harness — not a
pretense that it equals a calibrated instance.

## 7. Contributing a rule

A rule contribution **must carry gate-regression fixtures**: for the rule's codes, positive and
negative examples with the expected codes (`fixtures/gate-regression/`). The regression runner
asserts byte-stable code emission, and rule changes are tested against previously judged content
before merge. Contributions never include instance data, scraped material, or brand IP. See
`CONTRIBUTING.md`.

## See also

- [`../rules/codes.md`](../rules/codes.md) — the live registry with every code and its disposition.
- [`architecture.md`](architecture.md#three-gate-layers-union-of-codes) — the three gate layers.
- [`extending.md`](extending.md) — rules and codes are a fully-open seam.
