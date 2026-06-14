# Pre-gate lint — synthetic regression fixtures

These are **synthetic** drafts (brand "Acme Cosmos", placeholders only — release-spec §0.3 r6,
model §13.3 r1) that exercise the deterministic pre-gate (`engine/gate/pre-gate-lint.js`,
release-spec §14.1 layer 1). They replace the production self-test fixtures (real corpus lines)
that must never travel to the public tree.

Each `*.draft.json` conforms to `schemas/inputs/draft.schema.json`. The companion
`*.expected.json` lists the `LINT.*` codes the pre-gate MUST emit and the expected `verdict`
(release-spec §14.2). The gate-regression runner (batch P4-GREG-DET) consumes these; the
co-located `tests/pre-gate-lint.test.js` covers the same checks inline.

| Fixture | Exercises | Expected verdict |
|---|---|---|
| `clean.draft.json` | three distinct, in-window, clean variants | `PASS` |
| `em-dash.draft.json` | `LINT.EM_DASH` (hard) | `FAIL` |
| `placeholder.draft.json` | `LINT.PLACEHOLDER` (soft, bars Recommended) | `PASS_ALTERNATE_ONLY` |
| `variant-dup.draft.json` | `LINT.VARIANT_DUP` (hard) | `FAIL` |

The engine ships **zero** banned phrases; the `LINT.BANNED_PATTERN` check is exercised in the
co-located test via an operator-supplied pattern, not a fixture brand term.
