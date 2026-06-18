# Configuration

The complete configuration reference: the `$CONTENT_HOME` instance layout, every key in
`config/system.json` and `brands/<id>/brand.json`, the secrets layer, and how configuration is
layered, provenanced, and upgraded. The JSON Schemas in `schemas/config/` are the authority; this
doc walks them and states defaults and consumers. When the two ever disagree, the schema wins and
the doc is a bug.

## 1. The layered configuration model

Configuration comes in three layers, in increasing visibility:

1. **Secrets** — `$CONTENT_HOME/.env` (or the process environment) only. Never anywhere else. See
   [`§4`](#4-secrets-env) and the shipped `.env.example`.
2. **Structured config** — JSON validated by published schemas:
   `config/system.json` (system-wide) and `brands/<id>/brand.json` (one per brand).
3. **Rules** — markdown with machine-readable frontmatter (see [`rule-authoring.md`](rule-authoring.md)).

All Tier-3 instance constants — reviewer ids, channel ids, handles, paths — live in these layers,
**never in code**.

### Provenance is first-class

Every configuration value carries a provenance class:

- **`shipped-default`** — comes from the repo (a shipped rule, a schema default).
- **`user-set`** — the operator authored it.
- **`machine-learned`** — landed via an applied Learning Record (v1 ships record *creation*;
  machine application is feature-gated/roadmap).

Provenance makes the shipped-vs-overridden diff mechanically visible across upgrades. Machine-learned
values may only land through applied Learning Records, never by silent mutation.

### The upgrade channel

Upstream changes reach an instance **only as versioned releases** (git tags + `CHANGELOG.md`) that
you explicitly adopt by pulling and upgrading — never silently. The engine does **not** self-update,
and no component fetches upstream content at runtime. Operator-overridden artifacts persist across
upgrades by the rule precedence in [`rule-authoring.md`](rule-authoring.md); provenance classes make
the diff visible. `stable` schemas change only with migration notes.

## 2. `$CONTENT_HOME` layout

One clone = code only. All mutable state lives in the instance directory, located by the single
`CONTENT_HOME` environment variable. `engine init --home <path>` scaffolds it (see
[`setup/brand.md`](setup/brand.md)). It can live anywhere **outside** any git repo that has a remote;
the engine refuses to run if `CONTENT_HOME` resolves inside the code checkout.

```
$CONTENT_HOME/
├── .env                       # instance secrets — the ONLY secrets location (§4)
├── config/
│   └── system.json            # system configuration (schema-validated; §3)
├── brands/<brand-id>/         # brand.json + Brand DNA + archetypes + character sheets + learned voice
├── calendar/                  # calendar.md + calendar-state.json
├── campaigns/                 # campaign instance files
├── corpora/<brand-id>/        # ingested own/competitor corpora, trust-class-tagged
├── queue/
│   ├── publish-queue.md       # the durable queue (authoritative)
│   ├── queue.md               # human-readable queue view
│   └── locks/                 # single-runner lock dir
├── workspaces/<stage>/        # per-stage run artifacts, keyed by content-id
├── library/
│   ├── media/                 # media assets
│   ├── metadata/<collection>/ # NFT/asset metadata for the trait index
│   ├── index.json             # archive index
│   ├── tags/                  # trait indexes (by-token / by-trait / summary)
│   └── usage-log.jsonl        # the single canonical cooldown ledger
├── analytics/                 # engagement checkpoints, baselines, weekly reports
├── learning/
│   ├── proposed/              # proposed learning records
│   └── applied/               # applied learning records
├── ledger/
│   ├── events.jsonl           # append-only event stream (the observability substrate)
│   └── tasks/                 # pending slot-run task records (the run-dispatch transport)
├── logs/                      # redacted-at-write logs (never committed)
├── setup-state.json           # setup checkpoints
└── PAUSED                     # kill-switch sentinel — its presence pauses all loops
```

`engine init` also initializes `$CONTENT_HOME` as a **local-only git repository with no remote**
(unless you pass `--no-git`). That gives versioned learning records and one-step rollback: a
snapshot before any learning application, `git revert` as the undo. This layout is *documented*, not
repo content; it may change between minor versions with migration notes.

### The `CONTENT_HOME` placement rule

`CONTENT_HOME` MUST be set in the **process environment** — your shell profile, the service
definition, or the scheduler recipe (every `templates/scheduler/` recipe sets it). It is the one
variable that *cannot* live in `$CONTENT_HOME/.env`, because the engine needs it to *find* that
`.env`. The only two commands that run without it are `engine fixture-run` and
`engine init --home <path>`.

## 3. `config/system.json` (system scope)

Validated by `schemas/config/system.schema.json`. Required keys: `mode`, `reviewers`, `budget`,
`publish`, `approval_surface`, `scheduler`. `additionalProperties` is false — an unknown key is a
validation error.

| Key | Type | Default | Consumer / notes |
|---|---|---|---|
| `schema_version` | string `N.N.N` | — | config-shape version for migrations |
| `mode` | enum `SAFE` / `LIVE_PREVIEW` / `LIVE` | `SAFE` | the publish-posture ladder; fresh installs are SAFE, LIVE needs an operational project + explicit change |
| `reviewers[]` | array, min 1 | — | the approval allowlist (see below); **must be non-empty with ≥1 approver** |
| `budget` | object | — | spend governance; **required** — the engine refuses LIVE without it (see below) |
| `publish` | object | — | publish posture (see below) |
| `approval_surface` | object | — | adapter id + channel-role bindings (see below) |
| `scheduler` | object | — | trigger schedule (see below) |
| `cooldown` | object | `{hard_days:14, target_days:30}` | media reuse cooldown defaults (per-brand overridable) |
| `gate` | object | (code defaults) | deterministic-gate tunables; calibrated values are operator-side, never shipped |
| `card_ttl` | object | `{trend:"freshness-window-bound", evergreen_escalate_after:"72h"}` | approval-card TTL per slot type |
| `retention` | object | `{raw_corpus_days:90, purge_schedule:"weekly"}` | corpus retention — see [`data-policy.md`](data-policy.md) |
| `observability` | object | (see below) | digest timing + stall thresholds |
| `self_improve` | object | `{enabled:false}` | the governed self-improvement loop — **OFF by default** (see below + [`self-improvement.md`](self-improvement.md)) |
| `paused` | boolean | `false` | mirror of the `PAUSED` sentinel |

### `reviewers[]` (the approval allowlist)

Each entry: `{ id, name?, rights: [...] }` where `rights` is a non-empty subset of `approve` /
`edit`. At least one reviewer must hold `approve`. Every approval/edit decision is attributed to an
entry here; edits require the same rights as approvals. `id` is a Tier-3 instance constant
(templates ship `<REVIEWER_ID>` placeholders); the C1 verifier rejects leftover placeholders.

```jsonc
"reviewers": [
  { "id": "<REVIEWER_ID>", "name": "Lead Reviewer", "rights": ["approve", "edit"] }
]
```

### `budget` (spend governance) — required

`{ currency?, monthly_cap, daily_cap, per_item_generation_limit, indexing_requires_estimate }`.
`monthly_cap`, `daily_cap`, and `per_item_generation_limit` must be > 0; `indexing_requires_estimate`
must be `true`.

> **Scope caveat (read this).** The caps bind **engine-metered spend and run dispatch only**.
> Chain-seat LLM spend (writer/gate/matcher tokens) is host-runtime-owned and is *not* a
> whole-system ceiling unless your runtime reports per-run cost. A `monthly_cap` of $50 bounds what
> the engine meters and dispatches, not your total bill. See [`cost.md`](cost.md) for the full split
> and how to cap chain spend at the runtime. A cap breach forces the project to `paused`.

### `publish` (posture)

`{ draft_only: true (default), auto_publish_allowed: false (default) }`. `draft_only` true means
approved posts land as drafts the operator publishes manually (the second gate).
`auto_publish_allowed` is a global gate; even when true, each brand×platform must independently earn
the trust state in `brand.json` (see [auto-publish](#auto-publish-trust-state)).

### `approval_surface`

`{ adapter: "discord", channels: { ... } }`. The adapter enum is `discord` in v1. `channels` binds
the four required roles by id — `content-review`, `content-published`, `content-ops`, `media-bank`
— plus the optional `trend-readout`. Channel ids are Tier-3 instance constants; templates ship
`<CHANNEL_ID>` placeholders. See [`setup/discord.md`](setup/discord.md) for creating and binding
them.

### `scheduler`

`{ kickoff_time (required, HH:MM), executor_interval_minutes (5), analytics_interval_minutes (240),
ttl_sweep_interval_minutes (60), tick_enabled (false) }`. The daily kickoff is the canonical
trigger; `tick_enabled` turns on the optional fine-grained calendar tick. **Safety posture never
lives in scheduler wrappers** — it lives here in declared config. See
[`setup/platforms.md`](setup/platforms.md) and `templates/scheduler/` for installing the triggers.

### `cooldown`, `card_ttl`, `retention`, `observability`

- `cooldown`: `{ hard_days: 14, target_days: 30 }` — an asset or its derivatives must not be reused
  more often than `hard_days`, target `target_days`. Per-brand overridable.
- `card_ttl`: `{ trend, evergreen_escalate_after }`. `trend` defaults to the token
  `"freshness-window-bound"` (TTL inherited from the trend report's freshness window);
  `evergreen_escalate_after` defaults to `"72h"` (a duration token: integer + `m`/`h`/`d`).
- `retention`: `{ raw_corpus_days: 90, purge_schedule: "weekly" }`. Governs `engine purge-corpora`.
- `observability`: `{ digest_time, stall_thresholds: { no_content_produced_hours: 24,
  queue_age_alert_hours: 24, undelivered_card_backlog: 10 } }`. See [`observability.md`](observability.md).

### `gate` (deterministic-gate tunables)

The engine ships **generic day-one defaults in code** (e.g. variant-distinctness shingle size 5,
Jaccard threshold 0.45, opener window 30 chars). These are generic starting points, *not* calibrated
values — the maintainer's calibrated heuristics, weights, and exemplar batteries are not shipped.
Tune `gate.variant_distinctness` per brand voice if the defaults over- or under-fire on
`LINT.VARIANT_DUP`.

### The `self_improve` block (governed self-improvement)

The config gate for the **governed self-improvement loop** (DD-6; full reference:
[`self-improvement.md`](self-improvement.md)). `additionalProperties: false`; only `enabled` is
required. **OFF by default and the whole block is fail-closed** — the loop machine-applies nothing
unless `enabled` is **strictly `true`**, and the `PAUSED` kill switch overrides it even then.

| Field | Type | Default | Notes |
|---|---|---|---|
| `enabled` | boolean | `false` | **THE LAW.** Strictly `true` to allow governed machine application; any other value keeps learning records human-applied (the v1 behavior) |
| `evidence` | object | `{min_sample_size:12, min_confidence:0.8, min_effect_size:0.2}` | the auto-applicable bar (DD-6 (3)); below it a record stays `proposed`. `min_sample_size` is floored at **3** (the analytics outlier-sample floor) |
| `canary` | object | `{observe_cycles:2, scope_fraction:0.25, rollback_on_regression_pct:0.1}` | canary → observe → promote/auto-rollback (DD-6 (4)); `observe_cycles` ≥ 1 |
| `allowlist` | object | — | the **closed** machine-changeable set + human-set bounds (DD-6 (1)+(2)) |
| `analyst_seat` | object | — | **optional** host seat that refines proposal *prose only*; degrades when absent (RD-2). `{ seat, provider }`; the provider block resolves credentials by name, never a value |

`allowlist.targets[]` is a **closed enum** — `calendar_weighting`, `archetype_priority`,
`content_type_priority`, `tunable_dial` — and **nothing else can be added**: a guardrail, the gate, or
a hard-fail threshold is human-only by construction and refused structurally regardless of this block.
`allowlist.bounds` = `{ max_weight_delta (default 0.15), weight_range {min, max} (default [0,1]),
dials[] {name, min, max} }`; the applier **clamps every machine change into these human-set bounds**
and refuses a proposal that would exit them (a within-bounds change can never reach a guardrail).

Values that land via this loop carry the **`machine-learned`** provenance class
([above](#provenance-is-first-class)) and are recorded as versioned, applied Learning Records in the
instance repo (one-step `engine rollback`). The loop is deterministic engine code (no chain LLM); see
[`self-improvement.md`](self-improvement.md) for the six DD-6 invariants and the state machine.

## 4. `brands/<id>/brand.json` (brand scope)

Validated by `schemas/config/brand.schema.json`. Required: `id`, `display_name`, `account_class`,
`platforms`. `additionalProperties` is false. Every value is authorable from this doc alone.

| Field | Type | Default | Notes |
|---|---|---|---|
| `id` | string | — | matches the `brands/<id>/` directory name and the `brand` key on artifacts |
| `display_name` | string | — | human-readable name |
| `account_class` | enum `operator` / `brand` | — | `operator` = a founder account (looser media strictness); `brand` = a project account |
| `platforms[]` | array, min 1 | — | per-platform publishing config (see below) |
| `cooldown_overrides` | `{hard_days?, target_days?}` | inherit system | per-brand cooldown override |
| `drama_dial` | enum `low` / `medium` / `high` | `medium` | per-brand dramatization stance, consumed by the voice/style rules |
| `paths` | `{dna?, archetypes?, corpora?}` | — | CONTENT_HOME-relative locations; **absolute paths and drive letters are forbidden** |

### `platforms[]` entries

`{ platform, publisher, integration_ref?, handle_placeholder?, rate_limit_per_day?,
publish_windows?, auto_publish? }`:

- `platform` — a platform descriptor id (`twitter`, `giphy`, `instagram`, `facebook`, `youtube`,
  `tiktok`). See `schemas/config/platform-descriptor.schema.json`.
- `publisher` — which adapter carries it: `postiz` / `giphy` / `manual`.
- `integration_ref` — the integration id the publisher shows for the connected account, recorded at
  account-connection time. For Postiz lanes this is the Postiz integration id; Giphy lanes leave it
  null and use the Giphy credentials/username instead. Null until the account is connected
  (deferrable until LIVE).
- `handle_placeholder` — display handle; synthetic in shipped templates (e.g. `@acmecosmos`).
- `rate_limit_per_day` — max posts/day for this brand×platform, enforced by the publish gate.
- `publish_windows[]` — allowed local-time windows `{ days: [mon…sun], start: "HH:MM",
  end: "HH:MM" }`. Outside a window the publish gate fails. `end` may be earlier than `start` to
  cross midnight.

### Auto-publish trust state

`auto_publish` is the trust-state block: `{ enabled (operator opt-in, default false),
qualifying_streak (engine-maintained), last_revocation, revocation_reason }`. Auto-publish removes
the publisher *second* gate for one lane — **never** the human approval gate. Entry and revocation
are enforced mechanically by the engine: the operator sets `enabled`, but publishing automatically
also requires the trailing trust criteria to be met (consecutive qualifying publishes with zero
post-approval edits and zero integrity incidents). Any gate-violating publish, dead-letter spike,
pause, or integrity failure on the lane revokes the flag and resets the streak. Treat this as a
risk-posture change, not a convenience toggle.

## 5. Secrets (`.env`)

The complete variable surface ships as `.env.example` (names + placeholders + per-variable comments
stating Tier class, consumer, and whether it is required). You should never need to read source to
learn the variable surface. The resolver (`engine/shared/secrets.js`) reads `process.env` first, then
`$CONTENT_HOME/.env`, and **terminates there** — no fallback into the checkout or any other path.

Tier glossary (used in every `.env.example` comment):

- **Tier 1** — credentials and secrets (e.g. `POSTIZ_API_KEY`, `GIPHY_API_KEY`, `APIFY_API_KEY`,
  `XAI_API_KEY`).
- **Tier 2** — secret-adjacent (signed URLs, session artifacts) — never appears in config or logs.
- **Tier 3** — instance identifiers and constants (channel/reviewer ids, handles, paths) — these
  live in `system.json`/`brand.json`, not in `.env`.

Core variable: `CONTENT_HOME` (config; the one variable that must be in the process environment).
Discord approval delivery is host-runtime permissioning, not an engine secret. Publisher and
optional-provider variables are per-platform/per-feature — see `.env.example` and
[`setup/platforms.md`](setup/platforms.md). The public engine path documents only Postiz, Giphy,
Apify, and XAI keys; general LLM/model access belongs to the host runtime/subscription plan.

### Diagnostic overrides (§4.5)

A small set of env vars exist as **diagnostic overrides only**, each documented in `.env.example` and
logged loudly at startup when set — e.g. `ENGINE_MODE` (overrides the mode ladder), publish-posture
toggles, and dry-run flags. Safety posture belongs in `system.json`, not in these. Image-model and
timeout selection is **configuration, not environment**: it lives in the §12.5 provider block
(`{ kind, model, endpoint_env, timeout_ms, options }`), never in vendor-named env vars — see
[`extending.md`](extending.md#provider-config-blocks).

## 6. Configurable vs fixed

**Configurable:** everything in `system.json`/`brand.json`; rules (by precedence); trend cadence;
platform set per brand; TTLs, cooldowns, budgets, schedules.

**Fixed in v1 (changing these means forking):** the agent roster shape and handoff contracts; the
gate-layer ordering and the union-of-codes contract; the no-publish-without-approval invariant; the
mode-ladder semantics; the queue state vocabulary; N=3 variants; the single-runner lock.

## See also

- [`setup/brand.md`](setup/brand.md) — registering a brand and the cold-start path.
- [`setup/discord.md`](setup/discord.md) — channel roles and binding their ids.
- [`setup/platforms.md`](setup/platforms.md) — publisher connection and scheduler recipes.
- [`cost.md`](cost.md) — the budget scope caveat in full.
- [`data-policy.md`](data-policy.md) — the `retention` block and `engine purge-corpora`.
