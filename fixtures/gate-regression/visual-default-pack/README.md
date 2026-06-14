# visual-default-pack — gate-regression fixtures

Synthetic vision-model answers exercised against the shipped brand-neutral default question
pack (`rules/visual/default-pack.json`) by `engine/gate/visual-check/__tests__/`.

Each `*.answer.json` is a stand-in for what a vision model would return for an image; each
`*.expected.json` is the verdict the pack's declarative pass logic must produce. No real
images, no brand specifics, no instance data (release-spec §5, §16.3; model §13.3 r1). The
visual gate's provider invocation is exercised separately with an injected `spawnSync` stub so
CI runs with zero external dependencies and zero keys (§16.5).

This directory is the `rule.visual.brand-fidelity` / `rule.visual.identity` /
`rule.visual.embedded-text` gate-regression set (their frontmatter `tests:` globs all point here)
and pins all five `VIS.*` codes. The first four cases carry a recorded vision answer; the last
two are **provider-state** cases (no `*.answer.json`) driven by how the provider is configured.

| Fixture | Kind | What it pins |
|---|---|---|
| `clean` | answer | on-brand answer with no embedded text ⇒ PASS |
| `off-brand` | answer | generic-stock-filler true ⇒ FAIL with VIS.OFF_BRAND |
| `embedded-text` | answer | readable text baked in frame ⇒ FAIL with VIS.EMBEDDED_TEXT |
| `identity-missing` | answer | identity_required + identity absent ⇒ FAIL with VIS.IDENTITY_MISSING |
| `skipped-no-provider` | provider-state | no provider configured ⇒ PASS_PENDING_MEDIA + SOFT VIS.SKIPPED_NO_PROVIDER (bars Recommended) |
| `check-error` | provider-state | provider invocation throws ⇒ FAIL + VIS.CHECK_ERROR, always-write vision_pass:null |

The four answer cases (`clean`, `off-brand`, `embedded-text`, `identity-missing`) carry a recorded
vision answer that **is replayed live** through the real pack + a stubbed `spawnSync` (the pack's
declarative pass logic runs in CI; the LLM/vision model never does — RD-12). The two provider-state
cases carry only an `*.expected.json`: the runner sets the provider to `null` (skip) or injects a
throwing `spawnSync` (error). Together the six cases cover the whole `VIS.*` family.
