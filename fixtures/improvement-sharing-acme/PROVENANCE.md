<!-- IS-FIXTURES — release-spec roadmap #4 OUTBOUND improvement-sharing (DD-7 = option (b));
     original-design-spec §2.6 Improvement Sharing. THE GOVERNANCE IS THE FEATURE. -->

# `fixtures/improvement-sharing-acme/` — Provenance

**Every file here is synthetic / maintainer-authored, created for this repository.** None is, derives
from, or resembles any real brand, person, account, secret, partner, product codename, handle, path, or
operator instance. The only brand is the fictional **"Acme Cosmos"** (an invented backyard-astronomy /
consumer-telescope brand). Every "secret", partner, codename, snowflake, path, and handle below is
**deliberately fake and obviously synthetic** — planted so a test can prove the OUTBOUND sanitizer
strips it and the structural guard refuses to emit it. This satisfies the release contract that datasets
without demonstrated synthetic/operator-owned provenance never ship (release-spec §5 preamble; model
§13.3 rules 1 & 3 — regenerate-never-redact, §0.3 r6).

## What this fixture is for

The **zero-key test fixtures + config** for **OUTBOUND IMPROVEMENT-SHARING** (release-spec roadmap #4;
DD-7 = option (b); original-design-spec §2.6 Improvement Sharing). The feature is outbound tooling that
lets an operator SHARE a generalizable improvement (a promoted learnable rule-diff / learning record
from the #3 self-improvement loop) UPSTREAM — but ONLY as a **sanitized, opt-in, operator-reviewed,
ABSTRACT rule-diff**, plus a **maintainer-side evaluation harness** on the receiving end. v1 is MANUAL:
the tooling PREPARES a contribution package on local disk for a manual PR; **it NEVER transmits**.

These fixtures let the OUTBOUND sanitizer/guard and the INBOUND maintainer harness run in CI with **no
keys and no network** (RD-12). Sanitization, packaging, and evaluation are DETERMINISTIC engine code —
**the engine NEVER calls chain LLMs** (RD-2). The fixtures REUSE the existing engine primitives:
`engine/shared/redact.js`, the config-extendable private-term deny list, and
`engine/self-improve/mutability.js` (`assertMachineChangeAllowed` / `assertNotGateLoosening`).

## DD-7 is load-bearing (what these fixtures prove)

| DD-7 law | Proven by |
|---|---|
| **(1) OPT-IN ONLY, OFF BY DEFAULT; no automatic-send path of any kind.** opt-out/telemetry permanently rejected. | `system.improvement-sharing.json` `enabled` defaults false; `transmit_target: null` + `only_output_sink` local path in `expected/sanitize-outcomes.json` |
| **(2) ABSTRACT RULE-DIFFS ONLY.** A sanitizer strips all specifics; a structural guard REFUSES a payload that still contains a brand name / secret shape / snowflake / path / configured private term. | `outbound/lr-dirty-with-specifics.json` → `EUNSHAREABLE` in `onResidual:'refuse'` mode (and a guaranteed-clean payload in `'strip'` mode); `outbound/lr-clean-abstract.json` → accept (no-op) |
| **(3) OPERATOR-REVIEWED CONSENT.** Operator sees EXACTLY the sanitized payload and must confirm; fail-closed: disabled/unconfirmed ⇒ nothing produced. | `require_operator_confirmation` const true; `disabled_decision` / `unconfirmed_decision` = `produce_nothing` |
| **(4) MAINTAINER EVALUATION HARNESS (receiving side; supply-chain safety).** Never auto-merge; reject anything that loosens a gate (`ENEVERLOOSEN`) or targets a human-only rule (`EHUMANONLY`). | `inbound/contrib-loosens-gate.json` → `ENEVERLOOSEN`; `inbound/contrib-targets-human-only.json` → `EHUMANONLY`; `inbound/contrib-clean-accept.json` → ACCEPT (not auto-merge) |

## Files

| File / dir | What it is | Provenance |
|---|---|---|
| `outbound/lr-dirty-with-specifics.json` | A promoted learnable rule-diff / learning record that still CARRIES planted instance/brand specifics (brand name, invented partner, private-term codename, fake secret literal, placeholder-shape snowflake, `$CONTENT_HOME` path, @handle). The sanitizer must STRIP each; `assertShareable` must REFUSE (`EUNSHAREABLE`) on any residual. | Authored-synthetic |
| `outbound/lr-clean-abstract.json` | The CLEAN abstract form of the SAME improvement — rule-diff structure + sanitized rationale only, zero specifics, zero brand-tied metrics. `assertShareable` ACCEPTS; the sanitizer is a no-op (idempotent). | Authored-synthetic |
| `inbound/contrib-loosens-gate.json` | An inbound (specifics-free) contribution whose EFFECT loosens a gate (severity hard→soft, disposition block→warn, threshold loosened). `evaluate` MUST reject `ENEVERLOOSEN`. | Authored-synthetic |
| `inbound/contrib-targets-human-only.json` | An inbound contribution targeting a guardrail/safety rule (`mutability:human-only`, `category:safety`). `evaluate` MUST reject `EHUMANONLY`. Its change is a TIGHTENING, so the refusal is the human-only boundary, NOT never-loosen. | Authored-synthetic |
| `inbound/contrib-clean-accept.json` | A clean inbound contribution targeting an allowlisted machine-changeable class (calendar-weighting), gate-neutral. `evaluate` ACCEPTS (admissible for MANUAL review — never auto-merge). | Authored-synthetic |
| `system.improvement-sharing.json` | Partial `system.json` fragment exercising the new `improvement_sharing` block (gate flipped ON for the test; deny list carries the planted specifics; `require_operator_confirmation` true; NO transmit target, only a local `package_output_path`). Sub-validated against `schemas/config/system.schema.json#/properties/improvement_sharing`. | Authored-synthetic |
| `expected/sanitize-outcomes.json` | Ground truth: per-outbound-record `assertShareable` decision + the residual specifics each guard class catches + the post-sanitize emittable abstract payload + the consent/no-transmit laws. | Authored-synthetic |
| `expected/evaluate-outcomes.json` | Ground truth: per-inbound-contribution maintainer `evaluate` `decision` + `code` (`ENEVERLOOSEN` / `EHUMANONLY` / OK-accept), `auto_merge: false` always. Codes verified against the live `engine/self-improve/mutability.js`. | Authored-synthetic |

## The planted specifics in `lr-dirty-with-specifics.json` (all FAKE) and how each is caught

Each planted value is chosen to be DETECTED by the engine sanitizer
(`engine/improvement-sharing/sanitize.js`) yet stay CLEAN for the public-tree hygiene scan
(`scripts/hygiene-scan.js`) — the snowflake uses the all-zero/zero-padded placeholder shape
(`snowflakeIsPlaceholder` exempt) and the path is `$CONTENT_HOME`-relative (a documented placeholder).

| Planted item | Class | Engine family raised | Caught by (OUTBOUND guard) |
|---|---|---|---|
| `Acme Cosmos` | brand name | `private_term` + `brand_term` | private-term deny list (`terms`) + brand-term matcher |
| `Nebula Nine Optics` | invented launch partner | `private_term` | private-term deny list (`terms`) |
| `Project Dark Comet` | unreleased campaign/hardware codename | `private_term` | private-term deny list (`terms`) |
| `FAKE_TOKEN_do_not_use_0000` | fake secret literal | `private_term` | private-term deny list (`secret_literals`) — deliberately NOT credential-SHAPED, so `redact.js` shape patterns do NOT fire; that is what keeps it obviously synthetic, and is exactly why the deny list is config-extendable |
| `000000000000000077` | snowflake (placeholder shape) | `snowflake-id` | no-instance-specifics structural check (17–20 digit id) — placeholder shape so hygiene-scan stays clean |
| `$CONTENT_HOME/config/system.json` | instance path | `internal_id` | inbound privacy-filter structural shape — `$CONTENT_HOME` placeholder keeps hygiene-scan clean |
| `@acme_founder` | account handle | `handle` | no-instance-specifics structural check (`@handle`) |

The `planted_specifics` manifest in the dirty record enumerates these so a test can assert the sanitizer
stripped EACH class and that `assertShareable` refuses on ANY residual. In `onResidual:'refuse'` mode the
engine throws `UnshareableError` (code `EUNSHAREABLE`) with families `handle, internal_id, private_term,
snowflake-id`; in `'strip'` mode it returns a guaranteed-clean abstract payload (it calls
`assertShareable` on its own output).

## Notes

- **The secret is OBVIOUSLY synthetic, not real-shaped:** `FAKE_TOKEN_do_not_use_0000` reads as fake on
  sight and is not a valid-looking credential — it can never be mistaken for a live secret, yet it still
  triggers the deny-list redaction/refusal path under test. (Same posture as `work-recap-acme`; the two
  fixtures share the SAME synthetic Acme Cosmos deny-list items, so the OUTBOUND gate is the mirror of
  the work-recap privacy gate.)
- **The dirty record is intentionally dirty:** it stores the raw planted items ON PURPOSE — the WHOLE
  point is that the sanitizer must strip them and `assertShareable` must refuse to emit them. Nothing
  here is sanitized in the file; the expected ground truth lives in `expected/sanitize-outcomes.json`.
- **Outbound records carry a `$comment` + `planted_specifics` annotation** (sharing-test metadata), so
  they are improvement-sharing INPUTS rather than strict shipped `learning-record` artifacts; they are
  documented SKIPS in `scripts/validate-schemas.js` (the canonical learning-record shape is validated by
  the `self-improve-acme` records). The inbound files are an `inbound-contribution/v1` wire shape
  consumed by the maintainer harness — also documented skips. The `system.improvement-sharing.json`
  fragment is sub-validated against `#/properties/improvement_sharing`.
- **Future-dated (2099-…):** all `created_at` / `submitted_at` timestamps sit far in the future so a
  fixture is never mistaken for a real observation.
- **No transmit anywhere:** the fixtures and config encode the v1 law — the tooling only PREPARES a
  local package; there is NO push/post/transmit and NO transmit target (`transmit_target: null`).
- **Hygiene-scan clean (deliberately):** the dirty fixture plants its snowflake as the all-zero
  placeholder shape (`000000000000000077`) and its path as `$CONTENT_HOME/...` — both DETECTED by the
  engine sanitizer's 17–20-digit / structural-shape detectors yet EXEMPT from `scripts/hygiene-scan.js`
  (`snowflakeIsPlaceholder` + the `$CONTENT_HOME` placeholder allow). So the fixture exercises the engine
  guard without tripping the public-tree leak gate. A raw home/user absolute path or a real-looking
  17–19-digit id would have failed CI — the placeholder shapes are the blessed way to plant a "specific"
  synthetically.
- **Git-trackability:** all `.json`/`.md` under `fixtures/` — not denied by `.gitignore` (only media
  binaries and `*.env*`/`*.token`/secret-named files are denied). No file here is named like a secrets
  file, so nothing is accidentally ignored; the planted "secret" is plain-text content, never a `.env`.
