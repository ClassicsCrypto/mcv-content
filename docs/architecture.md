# Architecture

How the engine is put together, the lifecycle a content item moves through, and the trust
boundaries that keep an autonomous chain from publishing the wrong thing. Read this once before
setup; it is the mental model every other doc assumes.

## 1. What the system is

A **multi-agent brand content production system**, shipped as a **kit plus a thin runner**:

- The **kit** is markdown agent contracts, rules, schemas, and templates. They describe *what each
  seat does and what passes the gate* — they are executed by an LLM running inside your host
  runtime, not by this repo.
- The **thin runner** is the deterministic Node.js code in `engine/` and `bin/engine.js`:
  scheduling, queue persistence, validation backstops, approval capture, and publishing. It calls
  no chain-seat LLM itself.

The product is a fixed agent chain that turns a calendar slot into platform-ready social content,
gates every draft, requires an attributed human approval before anything publishes, and learns
from reviewer feedback through reviewable learning records.

### Engine vs host runtime (the load-bearing split)

```
   ┌─────────────────────────────┐        ┌──────────────────────────────────┐
   │  ENGINE  (this repo)        │        │  HOST RUNTIME  (you supply)        │
   │  deterministic Node.js      │        │  the agent platform that runs LLMs │
   │                             │        │                                    │
   │  • scheduling / dispatch    │        │  • the agent seats (orchestrator,  │
   │  • queue persistence + lock │  task  │    matcher, writer, gate, …)       │
   │  • deterministic gates      │ record │  • the chain-seat LLM credentials  │
   │  • approval capture         │ ─────► │  • per-seat persistent sessions    │
   │  • publisher handoff        │ ◄───── │                                    │
   │  • observability / status   │ artifct│  reference runtime: OpenClaw       │
   └─────────────────────────────┘        └──────────────────────────────────┘
```

The engine **never** calls a chain-seat LLM. It writes a **slot-run task record** to
`$CONTENT_HOME/ledger/tasks/`; the host runtime picks it up through a documented hook and runs the
seats. The seats read and write schema-validated files under `$CONTENT_HOME/workspaces/<stage>/`;
the engine's deterministic gates and queue writes happen exclusively through engine entry points.
See [`runtimes/generic.md`](runtimes/generic.md) for the capability contract and
[`runtimes/openclaw.md`](runtimes/openclaw.md) for the reference fast path.

**Canonical source posture:** after the initial public cutover, the public engine repo is canonical
for engine code. A maintainer's production instance migrates onto public releases on its own
schedule. There is no private engine lineage that the public repo lags behind.

## 2. The two lifecycles (the agent chain)

Content takes one of two lanes, chosen by the platform's routing class. Both enter the **same**
validation gate — gate universality is an invariant, not a convenience.

**Text-heavy** (Twitter/X-class — the flagship lane):

```
calendar slot
  → orchestrator (routing + sequencing)
  → matcher (slot → archetype, deterministic pre-seed)
  → [enricher]  (optional — context/argument packet)
  → writer (3 labeled variants)
  → deterministic pre-gate (LINT.*)
  → LLM gate (voice + quality, FM.*; union of codes)
  → media decision (retrieve → reuse/modify/generate per rules)
  → visual gate (VIS.*, when media is present)
  → packager (platform-final, after gating)
  → deterministic package/platform gates + cooldown (PKG.*/PLAT.*)
  → approval card  →  reviewer decision  →  queue
  → executor → publisher handoff (draft by default — the second gate)
  → published → usage write-back + archive index → analytics checkpoints
```

**Video-heavy** (Giphy/IG/Shorts/Reels-class): identical, except the **media decision precedes
drafting** — archive-first sourcing, then the writer produces minimal captions — converging on the
same gate. Both lanes get a written per-handoff runbook in `pipelines/`.

Each handoff has a named artifact and schema (brief → draft → validation result → media decision →
package → approval card → approval decision → queue entry). The per-seat contracts live in
`agents/*/AGENTS.template.md`; the handoff table is in
[`rule-authoring.md`](rule-authoring.md) and the spec's §9.2.

### Three gate layers, union of codes

1. **Deterministic pre-gate** (`engine/gate/pre-gate-lint.js`, `LINT.*`): cheap structural/lexical
   checks (variant count/dup, length, formatting, placeholder, banned patterns) before any LLM
   spend. A failure routes straight back to the writer.
2. **LLM evaluation** (the gate seat, `FM.*`): rubric scoring, voice register, fabrication/claims
   safety, argument and hook quality. Injection-exposed by nature — which is exactly why layers 1
   and 3 exist and why hard-category enforcement never relies on this layer alone.
3. **Deterministic pre-publish** (`validate-package.js` + `platform-gates.js` + the executor,
   `PKG.*`/`PLAT.*`/`SYS.*`): audit-header integrity, verdict presence, variant presence, media
   cooldown, platform limits, and the publish-edge checks (schedule/rate/duplicate/approver).

**Union contract:** the final verdict carries every code from every layer. A downstream layer may
add codes but never drop a deterministic detection. The full code reference is
[`../rules/codes.md`](../rules/codes.md).

## 3. The content-item state machine

State is tracked in two places, by design:

- **Pre-packaging (stage states):** tracked via stage artifacts under
  `$CONTENT_HOME/workspaces/<stage>/`, keyed by content-id.
- **Packaging onward (queue states):** the durable publish-queue (`engine/shared/queue.js`) is
  authoritative.

```
  ── stage states (artifact-tracked) ─────────────────────────────────────────
  planned → seeded → [enriched] → drafted ⇄ media_attached → validating
         → validated_pass | validated_soft | hard_failed → packaged

  ── queue states (durable store authoritative) ──────────────────────────────
  awaiting_approval
     → approved | approved_pending_media | edited_approved | rejected | expired
     → publish_intent            (write-ahead marker, before any external call)
     → handed_off                (publisher draft created — awaiting operator publish)
     → published → archived → measured

  ── failure / hold branches ─────────────────────────────────────────────────
  interrupted_hold   (crash quarantine — explicit operator release)
  manual_review      (retry exhaustion)
  dead_lettered      (unrecoverable)
  failed_handoff     (publisher handoff failed, retrying)
  skipped_on_overlap (single-runner lock was held)
```

`drafted` and `media_attached` ordering is workflow-dependent (text-heavy drafts first;
video-heavy attaches media first); both converge on `validating`.

### Durability promises (every transition)

- **Write-ahead intent** is persisted *before* any external publish call (`publish_intent`), so a
  crash mid-publish is recoverable and never double-posts.
- **Attempt counters** are durably incremented *before* each retry's spend (hard-fail retry bound is
  3; on exhaustion the item dead-letters and an "unfilled slot" notice is emitted).
- **Publish is idempotent** by content-id — handing off the same item twice never creates a second
  post.
- **Card contents are persisted before posting**, so the approval surface can be rebuilt or read
  back for integrity.
- A crash mid-publish parks the entry in **`interrupted_hold`** for explicit operator release rather
  than risking a double-post.

### `handed_off` is not "stuck"

In LIVE mode the publisher handoff is **draft-only** by default (the second gate). After a reviewer
approves, the executor creates a draft in the publisher and the queue entry advances to
`handed_off`. **Publishing the draft inside the publisher is the operator's action.** Only then does
the executor's `verifyStatus` poll advance `handed_off → published`. *"Approved but nothing posted
yet" is the expected LIVE-mode state, not a failure* — `engine status` and the queue view say so
explicitly, glossing `handed_off` as "awaiting operator publish in the publisher".

### Production-state → public-vocabulary reconciliation

The vocabulary above is the public state machine. It was reconciled against the production
health-check's full known-state set so that no production state is silently dropped — each maps,
is renamed in, or is explicitly retired:

| Production state | Public state | Disposition | Note |
|---|---|---|---|
| draft requested / seeded | `planned` / `seeded` | renamed-in | pre-packaging stage; artifact-tracked, not queued |
| enriched (enricher packet present) | `enriched` (optional) | kept | optional stage, matches the optional enricher seat |
| drafted | `drafted` | kept | writer drafts |
| media attached | `media_attached` | kept | order vs drafted is lane-dependent |
| validating / gate running | `validating` | kept | the hybrid gate is running |
| gate PASS | `validated_pass` | renamed-in | production used per-gate verdict strings; public normalizes |
| SOFT tier (bars Recommended, ships A/B) | `validated_soft` | renamed-in | soft-fail semantics |
| HARD fail | `hard_failed` | kept | routes back to the responsible seat |
| packaged / `packaged_preview` | `packaged` | kept | the publisher-side schedule-ledger preview maps here |
| `awaiting_approval` | `awaiting_approval` | kept | card posted to the review channel |
| `approved` | `approved` | kept | reviewer approve |
| `approved_pending_media` | `approved_pending_media` | kept | a production extra, adopted verbatim |
| edited-then-approved | `edited_approved` | renamed-in | production routes edits via a feedback file + re-approval |
| `rejected` | `rejected` | kept | reviewer reject |
| (card expiry, near-nonexistent in prod) | `expired` | renamed-in / mostly net-new | public adds a card-TTL sweep; the only production seed is a draft-freshness gate |
| `publish_intent` (write-ahead) | `publish_intent` | kept | executor write-ahead intent marker |
| `handed_off` / publisher draft created | `handed_off` | kept | the second-gate state |
| `postiz_draft_restored_verified` | (folds into `handed_off` recovery) | retired | a crash-recovery sub-state, not a top-level state |
| `published` | `published` | kept | manual publish detected → promoted |
| (archive write-back on confirm) | `archived` | renamed-in | indexes on confirmed publish |
| (engagement checkpoints collected) | `measured` | renamed-in | post-publish measured terminal state |
| `interrupted_hold` (crash quarantine) | `interrupted_hold` | kept | the crash-safe parking state, adopted verbatim |
| retry exhaustion | `manual_review` | renamed-in | parks exhausted retries |
| dead-letter / unrecoverable | `dead_lettered` | renamed-in | |
| failed publisher handoff (retrying) | `failed_handoff` | renamed-in | outage-class retry path |
| overlap skip (lock held) | `skipped_on_overlap` | kept | single-runner lock skip-and-log |
| platform-direct upload sub-states (e.g. native-upload-ready) | fold into `handed_off`/`published` | retired | platform-direct lane sub-states, not top-level states |
| dry-run result fields | (not a content state) | retired | a *mode* artifact, not a lifecycle state — see the mode ladder below |

Three production fields (`approval_state`, `media_status`, `state`) collapse into the single public
`state` field plus `content_form`, `hold_reason`, and `media_refs` on the queue-entry schema. The
durable queue schema documents the field order; it is documented-with-migration-notes, not a frozen
interface.

## 4. Modes (the publish-posture ladder)

One ladder, resolved by `engine/orchestrator/mode.js`, consulted everywhere:

| Mode | Posts cards? | Calls publisher? | What it is |
|---|---|---|---|
| `SAFE` | no | no | artifacts only — no approval-surface posts, no publisher calls. **The default.** |
| `LIVE_PREVIEW` | yes | no | real approval cards posted; publishing disabled |
| `LIVE` | yes | yes (draft-only) | full pipeline; publisher handoff draft-only (the second gate) |

Resolution precedence: explicit per-run override > `ENGINE_MODE` env (a loud diagnostic override
only) > `config/system.json` `mode` > `SAFE`. An unknown or malformed value falls **closed** to
`SAFE` — a typo can only ever make the engine safer, never accidentally LIVE.

## 5. Trust boundaries (zones U / O / S / A)

The whole design exists to keep untrusted input and tool-less agents from gaining publish or config
authority. Four zones:

- **Zone U — untrusted external input.** Anything scraped or third-party. *It can contain injected
  instructions.* All Zone-U text enters a seat's prompt only inside **data fences** (structured
  quoting with provenance markers), and Zone-U material may never modify rules or config except
  through a reviewed Learning Record. Scraped material — including your *own* scraped corpus —
  enters as `untrusted-scraped`; an operator attestation can promote a curated subset to
  `operator-curated`.
- **Zone O — operator-provided trusted input.** Brand DNA, hand-written briefs, config you authored.
- **Zone S — system / pipeline execution.** The agent seats. During operation they hold **no tool,
  shell, or config-write authority** — prompt-level prohibitions are not sufficient, so the
  host-runtime instantiation must configure seats tool-less (see `runtimes/*.md`). A seat reads and
  writes workspace artifacts only; it never touches the queue directly or changes a gate verdict.
- **Zone A — human authority.** Approval and publish rights. Only the named reviewer allowlist can
  approve, every decision is attributed, and edits require the same rights as approvals.

### The two gates (the trust signal)

1. **The approval gate (mandatory, first):** nothing reaches the publish handoff without exactly one
   recorded, attributed approval decision from an allowlisted reviewer. Enforced by the executor's
   approver gate.
2. **The publisher draft gate (second):** in LIVE the post lands as a *draft*; a human publishes it
   in the publisher. Removing this second gate (auto-publish) is a per-brand×platform,
   mechanically-gated risk-posture change, not a convenience toggle — see
   [`configuration.md`](configuration.md#auto-publish-trust-state) and the spec's §15.5.

The setup session (checkpoints C1–C4) is the *only* agent session that holds elevated tool access;
once the project is operational, that privilege is gone. This setup-vs-operations break is explicit
in every seat template.

## 6. Where state lives (topology)

One clone = code, templates, schemas, docs, and fixtures only. **All mutable state lives outside the
repo tree** in an instance directory located by a single environment variable, `CONTENT_HOME`. The
resolver (`engine/shared/paths.js`) is the only component that derives instance paths; resolution
terminates at `CONTENT_HOME` with no fallback into the checkout or any unlisted path. `git add -A`
inside the checkout is safe by construction, and the engine refuses to run if `CONTENT_HOME`
resolves inside the code checkout. The full `$CONTENT_HOME` layout is documented in
[`configuration.md`](configuration.md#content_home-layout).

## See also

- [`configuration.md`](configuration.md) — every config key, the `$CONTENT_HOME` layout, provenance classes.
- [`rule-authoring.md`](rule-authoring.md) — the rule format and the unified failure-code registry.
- [`../rules/codes.md`](../rules/codes.md) — every failure code the gate can emit.
- [`troubleshooting.md`](troubleshooting.md) — what each stuck state means and how to recover.
- [`runtimes/generic.md`](runtimes/generic.md) / [`runtimes/openclaw.md`](runtimes/openclaw.md) — the host-runtime contract.
