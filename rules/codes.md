<!--
  rules/codes.md — THE unified failure-code registry (release-spec §10.2; DD-3; RD-21).
  Source of truth for every failure code any gate layer emits. Six namespaced families
  (LINT / FM / PKG / PLAT / VIS / SYS) collapse the production five-taxonomy split onto a
  single contract. Every code on every artifact MUST exist here; CI validates (§16.5).

  Each YAML block conforms to schemas/artifacts/code-registry-entry.schema.json
  (id, family, tier HARD|SOFT, source, disposition, route?, description, rule_ref). The
  emit-side code tables in engine code (pre-gate-lint.js CODES, validate-package.js CODES,
  platform-gates.js CODES, visual-check/codes.js CODES, publish-executor.js CODE) are kept
  consistent WITH this file; this file is canonical.

  DD-9 ceiling (§10.3): these entries ship the CONTRACT — what each code means, its family,
  tier, and disposition. Calibrated thresholds, scoring weights, and exemplar batteries that
  decide WHEN an LLM gate fires an FM.* code stay maintainer-side and are NOT in this repo.

  RD-21: every shipped SOFT code is `disposition: warn`. No v1 code ships `disposition:
  correct` — the correct-disposition application path is feature-gated with zero v1 rules
  (§14.4). Demotion of a soft-failing variant is carried by `bars_recommended` on the
  detected-code instance, not by a `correct` disposition.

  Schema note on `source`: the registry schema enum is
  {lint, llm-voice, llm-quality, package, platform, visual}. SYS.* publish-edge/integrity
  codes are emitted by the executor at the same publish-edge layer as the PKG.* package
  gates, so they register with `source: package`.
-->

# Failure-Code Registry (`codes.md`)

The one reference for every code the gate can put on a content item. If you saw a code on an
approval card, a gate report, or the event ledger, it is defined below. Families:

| Family   | Source layer (spec §14.1)                         | What it catches |
|----------|---------------------------------------------------|-----------------|
| `LINT.*` | deterministic pre-gate (`engine/gate/pre-gate-lint.js`) | cheap structural/lexical checks before any LLM spend |
| `FM.*`   | LLM content gate (voice + quality sub-stages)     | voice register, fabrication/claims safety, argument, hook, legibility, style |
| `PKG.*`  | deterministic package/publish-edge gate (`validate-package.js`) | package integrity, variant/visual presence, media cooldown |
| `PLAT.*` | per-platform deterministic gate (`platform-gates.js`) | per-platform packaging/limit rules |
| `VIS.*`  | visual gate (`engine/gate/visual-check/`)         | image brand-fidelity, embedded text, provider state |
| `SYS.*`  | runtime/integrity at the publish edge (`publish-executor.js`) + the privacy/leak backstop (`privacy-leak.js`) | publish-time integrity, retry exhaustion, handoff/crash safety, source-derived copy privacy/leak |

**Tier → verdict (spec §14.2, §14.4):** any HARD code ⇒ `FAIL` (route back to the code's
`route` seat). SOFT-only ⇒ `PASS_ALTERNATE_ONLY` when a soft code carries `bars_recommended`,
else `PASS`. The Recommended (Strongest) variant pick MUST be code-clean.

**Union contract (DD-3):** a downstream layer may add codes but MUST NOT drop a deterministic
detection. The final verdict carries the union of every layer's codes.

---

## LINT.* — deterministic pre-gate

> Enforcement: `engine/gate/pre-gate-lint.js`. Brand-neutral lexical/structural checks. The
> banned-pattern check reads operator-supplied phrases from the config seam — the engine ships
> zero banned phrases (§0.3 r6, §10.3).

```yaml
- code: LINT.EM_DASH
  family: LINT
  tier: hard
  source: lint
  disposition: block
  route: writer
  description: A mid-sentence em dash appears in a variant. Public copy uses a clean punctuation register; the em dash is a known machine-writing tell.
  rule_ref: rule.core.formatting
- code: LINT.INFLATION
  family: LINT
  tier: hard
  source: lint
  disposition: block
  route: writer
  description: Significance-inflation phrasing (the humanizer's banned hype register) appears in a variant.
  rule_ref: rule.core.humanizer
- code: LINT.FINANCIAL
  family: LINT
  tier: hard
  source: lint
  disposition: block
  route: writer
  description: Price/floor/market/ticker talk appears in a brand voice that is not financial.
  rule_ref: rule.core.voice-register
- code: LINT.BANNED_PATTERN
  family: LINT
  tier: hard
  source: lint
  disposition: block
  route: writer
  description: A phrase from the operator-supplied banned-pattern list appears in copy. The shipped default list is empty; operators add brand-private terms via the config seam.
  rule_ref: rule.core.banned-patterns
- code: LINT.VARIANT_DUP
  family: LINT
  tier: hard
  source: lint
  disposition: block
  route: writer
  description: Two or more variants restate the same thesis (shared opener or high n-gram overlap) instead of offering distinct angles.
  rule_ref: rule.core.variant
- code: LINT.VARIANT_COUNT
  family: LINT
  tier: hard
  source: lint
  disposition: block
  route: writer
  description: The draft does not carry exactly the expected number of labeled variants (N=3, DD-11).
  rule_ref: rule.core.variant
- code: LINT.LENGTH
  family: LINT
  tier: hard
  source: lint
  disposition: block
  route: writer
  description: A variant is outside the brief's target character window for its platform/format.
  rule_ref: rule.platform.limits
- code: LINT.TENSE_SLIP
  family: LINT
  tier: hard
  source: lint
  disposition: block
  route: writer
  description: An entity the brief marked [HISTORICAL] is framed in present-continuous tense (a past event described as ongoing).
  rule_ref: rule.core.claims-safety
- code: LINT.PLACEHOLDER
  family: LINT
  tier: soft
  source: lint
  disposition: warn
  route: writer
  description: An unresolved template token ({...}) remains in copy. SOFT and bars the Recommended slot — a brace can never publish, so the variant is A/B-eligible only once the token is filled.
  rule_ref: rule.core.fabrication
- code: LINT.NEGPAR
  family: LINT
  tier: soft
  source: lint
  disposition: warn
  route: writer
  description: A negated-parallelism construction ("not just X but Y") appears — a humanizer style tell.
  rule_ref: rule.core.humanizer
```

---

## FM.* — LLM content gate (voice + quality)

> Enforcement: the LLM gate seat (voice sub-stage + quality sub-stage), against the rule files
> in `rules/core/`. These codes are assigned by an LLM judge, so their *firing thresholds* are
> calibrated judgment that stays maintainer-side (DD-9, §10.3). This registry ships only the
> contract: what each code means, its tier, and its disposition.
>
> Tiering follows §14.4 / RD-21: integrity and compliance failures are HARD; register, quality,
> legibility, and style failures are SOFT (`warn` + `bars_recommended`). `FM.UNVERIFIED_CAUSAL`
> is the one **advisory** code: non-blocking, does not bar Recommended; it rides onto the card as
> a note for the reviewer's approval decision (§14.4 advisory handling).

### FM HARD (integrity / compliance / structural)

```yaml
- code: FM.FABRICATION
  family: FM
  tier: hard
  source: llm-quality
  disposition: block
  route: writer
  description: A new or inflated falsifiable fact (metric, event, quantity, date) that does not trace to the brand's project-context source or a named source. The screenshot-disprovable core of the fact firewall.
  rule_ref: rule.core.claims-safety
- code: FM.SUPERLATIVE_UNBACKED
  family: FM
  tier: hard
  source: llm-quality
  disposition: block
  route: writer
  description: A checkable comparative, ranking, first/only/biggest/most/best, or uniqueness claim with no project-context receipt that backs the exact claim. Uniform-strict for all brands (fact integrity, not voice).
  rule_ref: rule.core.claims-safety
- code: FM.COMPARATOR_RESKIN
  family: FM
  tier: hard
  source: llm-quality
  disposition: block
  route: writer
  description: A competitor/comparator's voice, claims, stats, campaign pressure, or proper nouns are copied into the draft as if they were the brand's own.
  rule_ref: rule.core.claims-safety
- code: FM.LANE_DRIFT
  family: FM
  tier: hard
  source: llm-voice
  disposition: block
  route: matcher
  description: The draft drifts off the brand's assigned theme lane (generic category copy a competitor could post unchanged), with no operator override cited.
  rule_ref: rule.core.voice-register
- code: FM.BRIEF_VIOLATION
  family: FM
  tier: hard
  source: llm-quality
  disposition: block
  route: matcher
  description: The draft omits a brief-mandated element (must-include) or contradicts a brief constraint.
  rule_ref: rule.core.structure
- code: FM.BANNED_CONSTRUCTION
  family: FM
  tier: hard
  source: llm-voice
  disposition: block
  route: writer
  description: A banned opener/closer/construction (per the brand's banned-construction rule) appears. The shipped default contract names the construction CLASSES; specific banned phrases are operator config.
  rule_ref: rule.core.banned-patterns
- code: FM.STRUCTURE_VIOLATION
  family: FM
  tier: hard
  source: llm-quality
  disposition: block
  route: writer
  description: A required structural element of the chosen format/framework is missing (e.g. beat structure or beat assignment for a structured format).
  rule_ref: rule.core.structure
```

### FM SOFT (register / quality / legibility / style — `warn`, `bars_recommended`)

```yaml
- code: FM.POSTER_REGISTER
  family: FM
  tier: soft
  source: llm-voice
  disposition: warn
  route: writer
  description: A conviction/closing line reads as a motivational-poster maxim rather than operator-conviction grounded in the piece's verified anchor (register-rubric T1-T3). Bars Recommended.
  rule_ref: rule.core.voice-register
- code: FM.SUBSTITUTABLE
  family: FM
  tier: soft
  source: llm-voice
  disposition: warn
  route: writer
  description: The copy is generic enough that an unrelated brand could post it verbatim — no brand-specific anchor makes it non-substitutable. Bars Recommended.
  rule_ref: rule.core.voice-register
- code: FM.STATUS_RECAP
  family: FM
  tier: soft
  source: llm-quality
  disposition: warn
  route: writer
  description: The post is recap-dominated — leads with a status/by-the-numbers dump (or a thesis-shaped wrapper over a credential/flex stack) rather than leading with the thesis the receipts evidence (receipt-framing F1-F4). Bars Recommended.
  rule_ref: rule.core.structure
- code: FM.WEAK_HOOK
  family: FM
  tier: soft
  source: llm-quality
  disposition: warn
  route: writer
  description: An announcement/scarcity post teases an action with no concrete actionable anchor (no date/window, no concrete spec, no concrete CTA). Bars Recommended.
  rule_ref: rule.core.structure
- code: FM.WEAK_ARG
  family: FM
  tier: soft
  source: llm-quality
  disposition: warn
  route: writer
  description: An opinion/thesis/commentary piece lacks a complete argument spine (claim, mechanism, verified anchor, stake, reframe) or is assertion-stacking rather than an argument (argument-spine A1-A3). Bars Recommended.
  rule_ref: rule.core.structure
- code: FM.ESOTERIC
  family: FM
  tier: soft
  source: llm-quality
  disposition: warn
  route: writer
  description: An insider anchor (project shorthand, lore term, handle slang, internal acronym, IYKYK register, or opaque operator/builder jargon) is used without translation an informed outsider could parse (anchor-legibility L1-L4). Bars Recommended.
  rule_ref: rule.core.structure
- code: FM.HYPE_VOICE
  family: FM
  tier: soft
  source: llm-voice
  disposition: warn
  route: writer
  description: Significance-inflation / hype-superlative VOICE register (distinct from the falsifiable superlative claim FM.SUPERLATIVE_UNBACKED and from the mechanical em-dash rule). Bars Recommended.
  rule_ref: rule.core.humanizer
- code: FM.HUMANIZER
  family: FM
  tier: soft
  source: llm-voice
  disposition: warn
  route: writer
  description: A residual machine-writing tell from the humanizer rule (forced rule-of-three, parrot/echo, stat-stacking, tutorial signposting, chatbot artifacts, generic positive closers, follow-trap). Bars Recommended.
  rule_ref: rule.core.humanizer
- code: FM.IMAGE_DESCRIPTION
  family: FM
  tier: soft
  source: llm-quality
  disposition: warn
  route: writer
  description: Copy describes the attached image/video literally instead of adding context or interpretation around it. Bars Recommended.
  rule_ref: rule.core.media
```

### FM ADVISORY (non-blocking; surfaced for the reviewer)

```yaml
- code: FM.UNVERIFIED_CAUSAL
  family: FM
  tier: soft
  source: llm-quality
  disposition: warn
  route: writer
  description: An interpretive/causal link ("X is why Y") between facts that are EACH verified. ADVISORY — it does NOT bar the Recommended slot and does NOT fail the variant; it rides onto the approval card as a note for the reviewer (advisory handling, §14.4). If either endpoint is unverified it is FM.FABRICATION (hard) instead, and the advisory layer is never reached. NOTE the advisory carve-out: although registered tier soft for schema purposes, the verdict mapping treats FM.UNVERIFIED_CAUSAL as non-blocking and Recommended-eligible (rule.core.claims-safety §"Advisory").
  rule_ref: rule.core.claims-safety
```

---

## PKG.* — deterministic package / publish-edge gate

> Enforcement: `engine/gate/validate-package.js`. Package-integrity and publish-readiness
> checks at the pre-render/pre-publish edge, including media cooldown.

```yaml
- code: PKG.PACKAGE_INVALID
  family: PKG
  tier: hard
  source: package
  disposition: block
  route: packager
  description: The package object failed structural validation (malformed or missing required shape).
  rule_ref: rule.core.packaging
- code: PKG.AUDIT_HEADER_MISSING
  family: PKG
  tier: hard
  source: package
  disposition: block
  route: packager
  description: The package has no audit header / identity block (the metadata that records account, platform, format, mode, content class, etc.).
  rule_ref: rule.core.packaging
- code: PKG.GATE_VERDICT_MISSING_FOR_LIVE
  family: PKG
  tier: hard
  source: package
  disposition: block
  route: packager
  description: A LIVE-bound package carries no explicit gate verdict — nothing can publish without a recorded gate result.
  rule_ref: rule.core.packaging
- code: PKG.GATE_VERDICT_NOT_PASSING_FOR_LIVE
  family: PKG
  tier: hard
  source: package
  disposition: block
  route: packager
  description: A LIVE-bound package's gate verdict is not a passing verdict.
  rule_ref: rule.core.packaging
- code: PKG.PACKAGE_STATUS_NOT_READY
  family: PKG
  tier: hard
  source: package
  disposition: block
  route: packager
  description: The package_status field indicates the package is not ready for the requested edge.
  rule_ref: rule.core.packaging
- code: PKG.PUBLISH_STATE_NOT_READY
  family: PKG
  tier: hard
  source: package
  disposition: block
  route: packager
  description: The publish_state field indicates the item is not ready to publish.
  rule_ref: rule.core.packaging
- code: PKG.READY_FOR_PREVIEW_NOT_READY
  family: PKG
  tier: hard
  source: package
  disposition: block
  route: packager
  description: The package is marked not-ready for the preview edge.
  rule_ref: rule.core.packaging
- code: PKG.READY_FOR_PUBLISH_NOT_READY
  family: PKG
  tier: hard
  source: package
  disposition: block
  route: packager
  description: The package is marked not-ready for the publish edge.
  rule_ref: rule.core.packaging
- code: PKG.RECOMMENDED_MISSING
  family: PKG
  tier: hard
  source: package
  disposition: block
  route: packager
  description: The package has no Recommended variant.
  rule_ref: rule.core.variant
- code: PKG.VARIANT_A_MISSING
  family: PKG
  tier: hard
  source: package
  disposition: block
  route: packager
  description: The package is missing Variant A.
  rule_ref: rule.core.variant
- code: PKG.VARIANT_B_MISSING
  family: PKG
  tier: hard
  source: package
  disposition: block
  route: packager
  description: The package is missing Variant B.
  rule_ref: rule.core.variant
- code: PKG.ENRICHMENT_PACKET_LEAK
  family: PKG
  tier: hard
  source: package
  disposition: block
  route: packager
  description: Internal enrichment-packet text leaked into the public-facing copy.
  rule_ref: rule.core.packaging
- code: PKG.SCORES_MISSING
  family: PKG
  tier: hard
  source: package
  disposition: block
  route: packager
  description: The package's scores block is missing.
  rule_ref: rule.core.packaging
- code: PKG.SOURCE_STACK_MISSING
  family: PKG
  tier: hard
  source: package
  disposition: block
  route: packager
  description: The copy cites a source but the package carries no Source Stack documenting it.
  rule_ref: rule.core.claims-safety
- code: PKG.VISUAL_STATE_MISSING
  family: PKG
  tier: hard
  source: package
  disposition: block
  route: media
  description: A visual-format package has no visual_state.
  rule_ref: rule.core.media
- code: PKG.MEDIA_MISSING
  family: PKG
  tier: hard
  source: package
  disposition: block
  route: media
  description: A visual-format package has no bound media.
  rule_ref: rule.core.media
- code: PKG.MEDIA_COOLDOWN_BLOCKED
  family: PKG
  tier: hard
  source: package
  disposition: block
  route: media
  description: The chosen media (or a derivative of it) was used inside the cooldown window. The deterministic cooldown floor is enforced here (rule.core.cooldown).
  rule_ref: rule.core.cooldown
- code: PKG.VISUAL_CHECK_MISSING
  family: PKG
  tier: hard
  source: package
  disposition: block
  route: media
  description: An image package has no visual-check result.
  rule_ref: rule.core.media
- code: PKG.VISUAL_CHECK_NOT_PASSING
  family: PKG
  tier: hard
  source: package
  disposition: block
  route: media
  description: The visual-check result for an image package is not passing.
  rule_ref: rule.core.media
```

---

## PLAT.* — per-platform deterministic gate

> Enforcement: `engine/gate/platform-gates.js`. One module per platform; codes named
> `PLAT.<PLATFORM>_<CHECK>`. Adding a platform adds a module + descriptor (§12.6).

```yaml
- code: PLAT.TWITTER_HASHTAG_PRESENT
  family: PLAT
  tier: hard
  source: platform
  disposition: block
  route: packager
  description: A Twitter/X package contains a hashtag (the flagship lane bans hashtags in copy).
  rule_ref: rule.platform.twitter
- code: PLAT.INSTAGRAM_HASHTAG_OVER_LIMIT
  family: PLAT
  tier: hard
  source: platform
  disposition: block
  route: packager
  description: An Instagram package exceeds the configured hashtag count limit.
  rule_ref: rule.platform.instagram
- code: PLAT.TIKTOK_HOOK_3S_MISSING
  family: PLAT
  tier: hard
  source: platform
  disposition: block
  route: packager
  description: A TikTok package has no first-3-seconds hook declared.
  rule_ref: rule.platform.tiktok
- code: PLAT.TIKTOK_COVER_FRAME_MISSING
  family: PLAT
  tier: hard
  source: platform
  disposition: block
  route: packager
  description: A TikTok package has no cover frame declared.
  rule_ref: rule.platform.tiktok
- code: PLAT.YOUTUBE_SOURCE_SENSE_MISSING
  family: PLAT
  tier: hard
  source: platform
  disposition: block
  route: packager
  description: A YouTube package has no source-sense note tying the title/description to the actual footage.
  rule_ref: rule.platform.youtube
- code: PLAT.FACEBOOK_COMMUNITY_BRIDGE_MISSING
  family: PLAT
  tier: hard
  source: platform
  disposition: block
  route: packager
  description: A Facebook package has no community-bridge framing the platform's distribution favors.
  rule_ref: rule.platform.facebook
```

---

## VIS.* — visual gate

> Enforcement: `engine/gate/visual-check/` against a question pack in `rules/visual/`. The
> brand-fidelity *content* is data (a question pack), not code (§10.3); the engine ships a
> brand-neutral default pack only.

```yaml
- code: VIS.OFF_BRAND
  family: VIS
  tier: hard
  source: visual
  disposition: block
  route: media
  description: The rendered image fails one or more of the pack's brand-fidelity checks.
  rule_ref: rule.visual.brand-fidelity
- code: VIS.IDENTITY_MISSING
  family: VIS
  tier: hard
  source: visual
  disposition: block
  route: media
  description: A required brand identity element is absent (enforced only when the pack marks the item identity-required).
  rule_ref: rule.visual.identity
- code: VIS.EMBEDDED_TEXT
  family: VIS
  tier: hard
  source: visual
  disposition: block
  route: media
  description: Readable unsolicited text, dates, logos, signage, or pseudo-glyph markings are baked into the frame.
  rule_ref: rule.visual.embedded-text
- code: VIS.SKIPPED_NO_PROVIDER
  family: VIS
  tier: soft
  source: visual
  disposition: warn
  route: media
  description: No vision provider is configured, so the visual gate degrades to skip-with-warning. SOFT and bars the Recommended slot for visual formats — never a crash, never an auto-pass (§3.1, §15.2).
  rule_ref: rule.visual.brand-fidelity
- code: VIS.CHECK_ERROR
  family: VIS
  tier: hard
  source: visual
  disposition: block
  route: media
  description: The vision provider invocation failed (timeout, unreadable image, bad config). The verdict is still written (always-write) with vision_pass null; consumers treat null as NOT-pass and never auto-pass.
  rule_ref: rule.visual.brand-fidelity
```

---

## SYS.* — runtime / integrity at the publish edge

> Enforcement: `engine/orchestrator/publish-executor.js` (and the readback integrity verifier) for
> the publish-edge integrity codes, plus `engine/gate/privacy-leak.js` for the privacy/leak backstop
> (`SYS.PRIVATE_LEAK`). All SYS codes register at the publish-edge layer (`source: package`) because
> the validation-result/registry `source` enum has no privacy/system value. The integrity codes fire
> at the publish edge and are emitted onto the queue entry / event ledger; `SYS.PRIVATE_LEAK` fires
> in the content path (before the approval card) and routes back to the **writer** rather than the
> publisher-liaison — a leaked draft is regenerated, never published.

```yaml
- code: SYS.TEST_PUBLISH_BLOCKED
  family: SYS
  tier: hard
  source: package
  disposition: block
  route: publisher-liaison
  description: A content item whose id marks it a test fixture reached the publish edge; the executor refuses to publish it (fail-closed test guard).
  rule_ref: rule.sys.publish-integrity
- code: SYS.RETRY_EXHAUSTED
  family: SYS
  tier: hard
  source: package
  disposition: block
  route: publisher-liaison
  description: The hard-fail retry bound (3, DD-13) was exhausted. The item dead-letters and an "unfilled slot" notice is emitted; the attempt counter is durably incremented before each retry's spend.
  rule_ref: rule.sys.publish-integrity
- code: SYS.HANDOFF_FAILED
  family: SYS
  tier: hard
  source: package
  disposition: block
  route: publisher-liaison
  description: The publisher adapter handoff failed (the external publish call errored). Idempotent retry within the bound applies; on exhaustion this becomes a dead-letter (SYS.RETRY_EXHAUSTED).
  rule_ref: rule.sys.publish-integrity
- code: SYS.INTERRUPTED_MID_PUBLISH
  family: SYS
  tier: hard
  source: package
  disposition: block
  route: publisher-liaison
  description: The executor was interrupted mid-publish (crash/timeout) with a write-ahead intent persisted. The entry enters an interrupted-hold state for crash-safe replay rather than risking a double-post.
  rule_ref: rule.sys.publish-integrity
- code: SYS.READBACK_FAIL
  family: SYS
  tier: hard
  source: package
  disposition: block
  route: publisher-liaison
  description: The live approval card read back does not match the card the engine built (a foreign edit or render corruption). Integrity check fails closed — the item does not advance.
  rule_ref: rule.sys.publish-integrity
- code: SYS.PRIVATE_LEAK
  family: SYS
  tier: hard
  source: package
  disposition: block
  route: writer
  description: A draft derived from a content source (especially the work-recap memory source) carries residual sensitive material into the human-visible copy — a secret/credential shape (reusing the redact.js patterns), a sensitive structural shape (financial amount, internal-id), or a configured work_recap.private_term (partner name, codename, unreleased feature). HARD-blocks and routes back to the writer so no human ever sees a leaked draft on the approval card (defense in depth; the human is the final backstop, §2.4). Enforced deterministically by engine/gate/privacy-leak.js, which re-verifies the copy the source pre-pass was supposed to keep clean. Registered source package (the publish-edge layer; the registry schema source enum has no privacy/system value).
  rule_ref: rule.sys.privacy-leak
```

---

## Out of scope (NOT in this registry)

- **Retrieval lab codes (`FP_*` / `FN_*`).** These belong to the offline calibration harness
  (DD-9), which evaluates the gate but never sits in the content path. They are not runtime
  detections and never appear on a card or in the queue. See `calibration/`.
- **Engine-internal error tokens** (e.g. queue-conflict abort codes) that are not content/
  publish gate detections. Those are operational signals surfaced via `engine status` and the
  logs, not registry codes on an artifact.
