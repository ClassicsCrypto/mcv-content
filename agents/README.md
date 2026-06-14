<!--
  agents/README.md
  Roster overview + per-handoff contract chain for the agent seat templates.
  Authority cited: release-spec §9.1 (8+1 roster, may/may-not), §9.2 (handoff artifact
  contracts), §9.3 (writing frameworks), §8.1 (the two lifecycles), §8.4 (run mechanics —
  task records, workspace handoffs, single-runner lock), §2.1 (setup-vs-operations privilege
  break / Zone S), §0.4 (trust zones), §11.4 (fixed vs configurable), DD-2 (fixed minimal
  roster), DD-11 (N=3), DD-17 (attributed approval), RD-13 (optional enricher),
  RD-18 (run-dispatch transport). Regenerated clean (§13.3 r4); no instance constants,
  no production persona codename (§0.3 r6).
-->

# Agent Seats

This directory ships the **agent-definition templates** for the content production chain. Each subdirectory is one seat with an `AGENTS.template.md` (the role contract + a neutral, renameable prompt body). The host AI runtime instantiates these into runtime sessions during setup checkpoint C1 (release-spec §2.3 step 6); instantiated copies are **instance data** that lives host-side or in `$CONTENT_HOME` — never in this checkout.

> **These are templates, not running agents.** They carry placeholder personas only — no brand content, no instance IDs, no production codenames (§0.3 r6, §13.3 r1). The role names are fixed; the personas are yours to rename per brand in `$CONTENT_HOME`.

## The roster (DD-2 fixed minimal roster, +1 optional per RD-13)

Eight normative seats plus one optional seat (§9.1). The roster **shape** is fixed (§11.4) — changing it means forking. *Instantiation* may be staged: the quick-start runs text-only with six seats and defers `media` + `analyst` (§2.8 step 2); that is a setup sequencing choice, not a roster change.

| Seat | Required? | Responsibility (one line) |
|---|---|---|
| [`orchestrator`](orchestrator/AGENTS.template.md) | required | Consumes the calendar feed; routes slots to workflows; dispatches seat tasks; owns run sequencing. |
| [`matcher`](matcher/AGENTS.template.md) | required | Slot → archetype/theme matching; deterministic pre-seeding into the brief. |
| [`enricher`](enricher/AGENTS.template.md) | **optional** (RD-13) | Context/argument enrichment between matcher and writer. Degrades cleanly when absent. |
| [`writer`](writer/AGENTS.template.md) | required | Drafting with per-length frameworks; emits **3** labeled variants (DD-11). |
| [`media`](media/AGENTS.template.md) | required (deferrable) | Retrieval queries; reuse/modify/generate decisions per rules; media assembly. |
| [`gate`](gate/AGENTS.template.md) | required | Validation authority: applies the rule stack, assigns codes, blocks hard fails. |
| [`packager`](packager/AGENTS.template.md) | required | Platform-final packaging **after** gating; per-platform lanes. |
| [`publisher-liaison`](publisher-liaison/AGENTS.template.md) | required | Approval-card construction/readback; queue writes; publisher handoff via adapters. |
| [`analyst`](analyst/AGENTS.template.md) | required (deferrable) | Engagement pulls, baselines, weekly report; drafts **proposed** Learning Records. |

Production ran more sessions than this (e.g. separate voice- and quality-judge sessions behind the `gate` role, and per-platform packager sessions behind the `packager` role). Those are **sub-stages of a role, not extra roles** (§9.1): the public roster folds them into the nine seats above.

## Trust zones and the privilege break

Every seat above runs in **Zone S** (system/pipeline execution): during operation **no seat holds shell/tool access or configuration-write authority** (§2.1, §9.1; model §8). Only the **setup session** (checkpoints C1–C4) and the **human operator** (Zone A) hold elevated rights. This is not a prompt-level suggestion — the host-runtime instantiation MUST configure pipeline seats tool-less, and `docs/runtimes/*.md` states how per runtime. Approval and publish rights are Zone A (the human); untrusted external/scraped input is Zone U and reaches drafting seats only inside **data fences** (RD-8).

## How a run starts (run mechanics — §8.4, RD-18)

No seat invents work. A run begins as a **slot-run task record** (the operator-command shape, `schemas/inputs/operator-command.schema.json`) written to `$CONTENT_HOME/ledger/tasks/` in state `pending` — by the daily kickoff, by `engine run-slot`, or by `engine kickoff --now`. The host runtime consumes the pending record through its documented hook and starts the `orchestrator` seat. **No task record, no run** (DD-19 named-trigger discipline). Between seats, artifacts move as **schema-validated files in `$CONTENT_HOME/workspaces/<stage>/`, keyed by `content_id`**; deterministic gates and queue writes happen only through engine entry points (the locked queue writer) — no seat touches the queue directly.

## The per-handoff contract chain (§9.2)

Each arrow names the artifact and its schema. The two lifecycles (§8.1) share this chain; for `VISUAL_HEAVY` runs the **media decision precedes drafting** (archive-first), so the media step moves ahead of the writer.

```
                          slot-run task record
                          (schemas/inputs/operator-command.schema.json)
                                     │
                                     ▼
   orchestrator ──[slot task]──▶ matcher
                                     │  brief (schemas/inputs/brief.schema.json)
                                     ▼
                  [ enricher ]  ──[ enrichment field-set ON the brief — OPTIONAL, RD-13 ]──┐
                                     │                                                     │
                                     ▼  brief (with or without `enrichment`)  ◀────────────┘
                                  writer
                                     │  draft — exactly 3 variants (schemas/inputs/draft.schema.json)
                                     ▼
                                   gate  ──[hard fail]──▶ route back to writer/matcher (bounded, DD-13)
                                     │  validation result (schemas/artifacts/validation-result.schema.json)
                                     │  + routed draft
                                     ▼
                                  media  ──▶ media-decision record
                                     │       (schemas/artifacts/media-decision.schema.json)
                                     │       [retrieval-result.schema.json feeds the decision]
                                     ▼
                                packager
                                     │  package (schemas/artifacts/package.schema.json)
                                     ▼
                          publisher-liaison
                                     │  approval card (schemas/artifacts/approval-card.schema.json)
                                     ▼
                                 REVIEWER  (Zone A — human, allowlisted, DD-17)
                                     │  approval decision (schemas/artifacts/approval-decision.schema.json)
                                     ▼
                                  queue  (queue entry — schemas/artifacts/queue-entry.schema.json,
                                     │    written through the engine's locked writer)
                                     ▼
                                executor ──[adapter §12.3, draft-only by default]──▶ publisher
                                     │
                                     ▼
                                 analyst ──▶ performance report (schemas/artifacts/performance-report.schema.json)
                                            + proposed learning records (schemas/artifacts/learning-record.schema.json)
```

| Handoff | Artifact (schema) |
|---|---|
| orchestrator → matcher | slot task — `schemas/inputs/operator-command.schema.json` (§6.1) |
| matcher → writer | **brief** — `schemas/inputs/brief.schema.json` |
| enricher → writer | enrichment packet — **optional `enrichment` field-set on the brief** (RD-13; absence validates) |
| writer → gate | **draft** — `schemas/inputs/draft.schema.json` (exactly 3 variants, DD-11) |
| gate → media/packager | **validation result** — `schemas/artifacts/validation-result.schema.json` + routed draft |
| media → packager | **media-decision record** — `schemas/artifacts/media-decision.schema.json` (with `retrieval-result.schema.json`) |
| packager → publisher-liaison | **package** — `schemas/artifacts/package.schema.json` |
| publisher-liaison → reviewer | **approval card** — `schemas/artifacts/approval-card.schema.json` (surface-neutral) |
| reviewer → queue | **approval decision** — `schemas/artifacts/approval-decision.schema.json` → **queue entry** (`schemas/artifacts/queue-entry.schema.json`) |
| executor → publisher | publish handoff via the adapter contract (§12.3) — idempotent, draft-only by default |
| analyst → operator | **performance report** (`schemas/artifacts/performance-report.schema.json`) + **proposed learning records** (`schemas/artifacts/learning-record.schema.json`) |

**Hard-fail routing:** the gate routes a hard-failed item back to the seat named by the failing code's `route` (matcher or writer), bounded per DD-13 (§14.3). On retry exhaustion the item dead-letters and the engine posts an unfilled-slot notice.

## The brief / draft wiring (the enricher seam)

The `enricher` is the only optional seat, and its optionality is expressed in the schema, not in branching logic:

- The **brief** (`schemas/inputs/brief.schema.json`) carries an **optional `enrichment` object**. The matcher emits the brief with `enrichment` absent; an absent `enrichment` validates. The matcher → writer contract is therefore complete with or without the enricher (RD-13, §9.1 "may not: be required").
- When the install runs the enricher, it returns the **same brief** with `enrichment` populated (summary, proof stack, variant lanes, comparator transfer with do-not-copy guardrails, humanizer notes). It never strips the matcher's required fields.
- The **writer** reads the brief either way: with `enrichment.variant_lanes`, it drafts one variant per lane; without, it finds three angles from the pre-seed alone. Either path emits a **draft** (`schemas/inputs/draft.schema.json`) of **exactly three** labeled variants, which the deterministic pre-gate (`pre-gate-lint`) validates first (variant count/dup, length, formatting, placeholder, banned-pattern).

## Per-seat template structure

Every `AGENTS.template.md` follows the same shape so an operator (or their agent) can read any seat the same way:

1. **Role status** — required vs optional, sub-stages, trust zone.
2. **Responsibility** — what the seat does (§9.1).
3. **May / May not** — the authority boundary (§9.1), including the Zone-S rule that drafting/pipeline seats hold no tool or config-write authority.
4. **Input contract** — the artifacts/schemas the seat reads.
5. **Output / handoff contract** — the artifact the seat emits and its schema (§9.2).
6. **Prompt body** — the brand-neutral, operator-renameable instructions.

Each seat also ships (or will ship) a `SOUL.template.md` neutral persona alongside its `AGENTS.template.md` (§1 tree); the persona is renameable, the role contract is not.

## What is fixed vs configurable (§11.4)

**Fixed (forking territory):** the roster shape and these handoff contracts; the gate-layer ordering and union-of-codes contract (DD-3); the no-publish-without-attributed-approval invariant (DD-17); the N=3 variant contract (DD-11); the single-runner lock (DD-19). **Configurable:** the per-seat personas (rename freely), the writing frameworks (`rules/core/frameworks/`, §9.3), the rules the gate applies (`rules/`, per §10 precedence), and which optional/deferrable seats you instantiate.
