# Gate-regression corpus (`fixtures/gate-regression/`)

The synthetic judged corpus behind the Tier-2 gate-regression suite (release-spec §5.5, §16.3).
For **every shipped rule** in `rules/` there is one directory here, named by the rule's
frontmatter `tests:` glob, holding a positive (violating) and a negative (clean control) example
with the **expected detected codes** pinned in `expected.json`. The runner (P4-TEST,
`tests/gate-regression/runner.test.js`) loads each `expected.json`, replays its cases through the
real gate, and asserts **byte-stable code emission** (§16.3) — so perturbing a rule constant
flips a fixture red.

All content is synthetic **Acme Cosmos** copy (a fictional space-exploration brand) or obvious
placeholders. Nothing here derives from any production run, brand, or instance (§0.3 r6, §5,
`fixtures/PROVENANCE.md`). These replace the unpublishable production report corpus (§5.5).

## Two gate halves

| Layer | Rules | Runner mode | Source modules |
|---|---|---|---|
| **Deterministic** | `LINT.*`, `PKG.*`, `PLAT.*` | **executed live** in CI — the gate runs and its codes are diffed against `expected.json` (P4-GREG-DET) | `engine/gate/pre-gate-lint.js`, `engine/gate/validate-package.js`, `engine/gate/platform-gates.js` |
| **LLM / visual** | `FM.*`, `VIS.*` | **structural only** in CI — codes-registered + expectations internally consistent; the LLM judge is never run in CI (RD-12 zero-key bar). A keyed maintainer can run the judge locally and diff (P4-GREG-LLM). The visual pack's *declarative* pass logic over a recorded vision answer IS executed live. | the LLM gate seat (`agents/gate/`), the visual pack `engine/gate/visual-check/` over `rules/visual/default-pack.json` |

## `expected.json` manifest shape

Each rule directory carries exactly one `expected.json`:

```json
{
  "rule_ref": "rule.core.formatting",
  "gate": "lint",                         // lint | package | platform | visual | llm | sys
  "executed_in_ci": true,                 // false ⇒ FM.* prose / SYS.* / contract-only codes
  "fixture_kind": "draft",                // draft | package | vision-answer | provider-state | prose
  "cases": [
    {
      "name": "em-dash",
      "kind": "positive",                 // positive = violation present (emits the code)
      "input": "em-dash.draft.json",      // co-located input file (or null for prose/provider-state)
      "expected_verdict": "FAIL",         // §7.2 verdict the gate must return
      "expected_codes": ["LINT.EM_DASH"], // EXACT detected_codes[].code list, in emission order
      "notes": "mid-sentence em dash — the machine-writing tell"
    },
    {
      "name": "clean",
      "kind": "negative",                 // negative = clean control (emits no codes for this rule)
      "input": "clean.draft.json",
      "expected_verdict": "PASS",
      "expected_codes": []
    }
  ]
}
```

- **`kind`** follows the P4-GREG-DET convention: a **positive** case is one where the rule's
  violation is present and the rule fires; a **negative** is a clean control that does **not**
  fire. Every rule has at least one of each (§16.3 / plan P4-GREG-DET).
- **`expected_codes`** is the exact ordered `detected_codes[].code` list for the gate that owns
  the rule. The deterministic runner diffs this list verbatim (a code emitted twice — e.g. a
  three-way variant-dup — is listed as many times as it is emitted).
- For deterministic cases that need rule/brief inputs (length window, `[HISTORICAL]` entities,
  operator banned phrases, cooldown history), the case carries a `rules`/`config`/`usage_history`
  block the runner threads into the gate call. See each directory's `expected.json`.
- For **LLM (`FM.*`) prose** cases (`executed_in_ci:false`) the `input` points at a `*.copy.md`
  draft/snippet and `expected_codes` is the judgment a calibrated judge should return; CI checks
  only that the codes are registered, tiers/dispositions are RD-21-consistent (all soft codes
  `warn`), and any soft code that bars the Recommended carries `bars_recommended`.

## Directory index

Deterministic (executed live):

- `formatting/` — `LINT.EM_DASH`
- `humanizer/` — `LINT.INFLATION`, `LINT.NEGPAR` (+ FM.* prose: `FM.HYPE_VOICE`, `FM.HUMANIZER`)
- `voice-register/` — `LINT.FINANCIAL` (+ FM.* prose)
- `fabrication/` — `LINT.PLACEHOLDER`
- `claims-safety/` — `LINT.TENSE_SLIP` (+ FM.* prose)
- `banned-patterns/` — `LINT.BANNED_PATTERN` (+ FM.* prose)
- `variant/` — `LINT.VARIANT_COUNT`, `LINT.VARIANT_DUP`, `PKG.RECOMMENDED_MISSING`, `PKG.VARIANT_A_MISSING`, `PKG.VARIANT_B_MISSING`
- `limits/` — `LINT.LENGTH`
- `packaging/` — the `PKG.*` integrity family
- `cooldown/` — `PKG.MEDIA_COOLDOWN_BLOCKED`
- `media/` — `PKG.VISUAL_STATE_MISSING`, `PKG.MEDIA_MISSING`, `PKG.VISUAL_CHECK_MISSING`, `PKG.VISUAL_CHECK_NOT_PASSING` (+ FM.* prose: `FM.IMAGE_DESCRIPTION`)
- `platform-twitter/`, `platform-instagram/`, `platform-tiktok/`, `platform-youtube/`, `platform-facebook/` — the `PLAT.*` family
- `visual-default-pack/` — `VIS.*` (declarative pack logic executed live over recorded answers)

Structural / contract-only (not executed in CI):

- `structure/` — `FM.WEAK_HOOK`, `FM.WEAK_ARG`, `FM.STATUS_RECAP`, `FM.ESOTERIC`, `FM.BRIEF_VIOLATION`, `FM.STRUCTURE_VIOLATION`
- `publish-integrity/` — `SYS.TEST_PUBLISH_BLOCKED`, `SYS.RETRY_EXHAUSTED`, `SYS.HANDOFF_FAILED`, `SYS.INTERRUPTED_MID_PUBLISH`, `SYS.READBACK_FAIL`

> The legacy `lint-selftest/` directory is the original pre-gate self-test scaffold (referenced by
> `engine/gate/pre-gate-lint.js --selftest`); the per-rule directories above are the canonical
> §16.3 corpus the rule frontmatter `tests:` globs point at.
