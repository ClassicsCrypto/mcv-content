---
id: rule.visual.brand-fidelity
title: Visual brand-fidelity check
scope: brand
category: media
severity: hard
disposition: block
bars_recommended: false
codes: [VIS.OFF_BRAND, VIS.IDENTITY_MISSING, VIS.EMBEDDED_TEXT, VIS.SKIPPED_NO_PROVIDER, VIS.CHECK_ERROR]
mutability: human-only
version: 1.0.0
provenance: shipped
tests: [gate-regression/visual-default-pack/*]
---

# Visual brand-fidelity check

The visual gate (release-spec §14.1 visual layer) asks a configured vision model a tight pack
of questions about a rendered image and turns the answers into a validation result. It exists
so an LLM content gate that never receives the image bytes cannot confabulate a visual PASS.

This rule file is the **contract**; the enforcement is `engine/gate/visual-check/`. The
brand-fidelity *content* — what counts as on-brand for a given brand — is **data, not code**: a
question pack under `rules/visual/default-pack.json` (the shipped brand-neutral default) and,
per brand, `$CONTENT_HOME/brands/<brand>/visual-pack.json`. The engine ships no brand specifics
(spec §0.3 rule 6, §10.3).

## Codes (registry refs — `rules/codes.md`, `VIS.*` family, spec §10.2)

- `VIS.OFF_BRAND` (hard) — the image fails one or more of the pack's brand-fidelity checks.
  Routes back to the **media** seat for a re-source/re-generate.
- `VIS.IDENTITY_MISSING` (hard) — a required brand identity element is absent (only enforced
  when the item is `identity_required`, per the pack's `require_identity` gate).
- `VIS.EMBEDDED_TEXT` (hard) — readable unsolicited text, dates, logos, signage, or pseudo-glyph
  markings are baked into the frame.
- `VIS.SKIPPED_NO_PROVIDER` (soft, `bars_recommended`) — **degrade-to-skip**: no vision provider
  is configured (§12.5). The gate does not crash; it emits this soft warning, which bars the
  Recommended slot for visual formats (§3.1, §15.2). Configure a provider to enable the gate.
- `VIS.CHECK_ERROR` (hard) — the vision provider invocation failed (timeout, unreadable image,
  bad config). The verdict is still written (always-write contract) with `vision_pass: null`;
  consumers treat null as NOT-pass and **never auto-pass**.

## Vision provider (spec §12.5)

The vision model is selected by the `{kind, model, endpoint_env, timeout_ms, options}` provider
block in `config/system.json` — never a vendor-named env var and never an operator-OAuth CLI
coupling. Vision-capable LLM access is **optional**; absence degrades to skip-with-warning.

## Authoring a brand pack

Copy `rules/visual/default-pack.json` to `$CONTENT_HOME/brands/<brand>/visual-pack.json` and
edit `questions[]` and `pass{}`:

- `questions[]` — each `{key, prompt}` is a field the vision model must answer. Booleans drive
  the pass logic; string fields (`embedded_text_dates_logos`, `main_subject_one_line`) are for
  the embedded-text check and auditability.
- `pass.all_true` — boolean keys that MUST be true to pass.
- `pass.all_false` — boolean keys that MUST be false to pass.
- `pass.no_embedded_text` — the string key whose answer must read as "none".
- `pass.require_identity` — `{key, when_required}` identity gate; when `when_required` is true
  the identity key is only required for items marked `identity_required`.
