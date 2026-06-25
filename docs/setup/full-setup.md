# Full setup (C0–C4)

The complete checkpoint walkthrough: from a clean clone through to an `operational` project, with the
deterministic verifier at every gate. This is the long-form companion to [`quick-start.md`](quick-start.md)
(the smallest path) and the home for the detailed sub-step docs — [`discord.md`](discord.md),
[`brand.md`](brand.md), and [`platforms.md`](platforms.md).

**Setup is idempotent and resumable.** Progress is recorded per step in
`$CONTENT_HOME/setup-state.json`; re-running any verb resumes from the first incomplete checkpoint
without duplicating channels, re-billing spend, or overwriting Brand DNA. Each checkpoint has its own
verifier — `engine verify --setup c<n>` — that halts with a named failed step and its remediation.

The project lifecycle is `uninitialized → ingested → calibrated → operational` (plus `paused`). The
gates are ordered: C4 cannot make a project `operational` unless C3 (calibration) has passed.

## C0 — the engine runs, with zero keys

```
git clone <repo-url> && cd <repo>
npm ci
node bin/engine.js fixture-run
```

`fixture-run` runs the deterministic engine end-to-end against shipped fixtures — no credentials, no
spend, no `$CONTENT_HOME`. It is the proof the engine works before any external service is touched. If
this is red, stop and fix the environment before going further.

There is no `engine verify --setup c0`; the green `fixture-run` **is** the C0 check.

## C1 — instance + the approval surface

### Step 1 — scaffold

```
node bin/engine.js init --home <path-outside-the-checkout>
export CONTENT_HOME=<path>            # PowerShell: $env:CONTENT_HOME = "<path>"
```

`init` creates the `$CONTENT_HOME` layout (a SAFE-mode `config/system.json`, a starter `.env`, a
local-only git repo for learning-record rollback — pass `--no-git` to skip — and `setup-state.json`).
It is one of the two verbs that run before `CONTENT_HOME` is set, and it refuses a path inside the
code checkout. Layout reference: [`../configuration.md`](../configuration.md#content_home-layout).

### Step 2 — the Discord approval surface

Create or choose the four channels, make sure your host runtime can post/read/react there, and bind
their ids in `system.json` → `approval_surface.channels`. If your runtime already has a Discord
connector, do not create a separate bot token for the engine. This is the most error-prone external
procedure in setup; follow the full checklist in [`discord.md`](discord.md) (and
[`../../templates/channels.md`](../../templates/channels.md)).

### Step 3 — write `config/system.json`

At minimum: the **reviewer allowlist** (named reviewers with `approve` rights), the **budget** block
(`monthly_cap`, `daily_cap`, `per_item_generation_limit`, `indexing_requires_estimate`), and
`mode: SAFE`. The budget block is required — the engine refuses LIVE without it. Key reference:
[`../configuration.md`](../configuration.md).

### Step 4 — instantiate the seats

Instantiate the six v1 seats (orchestrator, matcher, writer, gate, packager, publisher-liaison) that
your host runtime runs as the chain. The media and analyst seats are deferrable.

> **The publisher integration (Postiz / Giphy credentials + account connection) is deferrable until
> you go LIVE.** SAFE and LIVE_PREVIEW need no publisher. See [`platforms.md`](platforms.md).

### Verify C1

```
engine verify --setup c1
```

C1 covers: all required `channel_bindings` mapped to non-placeholder ids, host-managed approval
surface permissions, the reviewer allowlist non-empty, budget caps set, the SAFE publish posture, and
lock-dir writability.

## C2 — brand, Brand DNA, (optional) corpus

Detailed walk: [`brand.md`](brand.md). In short:

1. **Register a brand** — one `brands/<id>/brand.json` from the template (`id`, `display_name`,
   `account_class`, at least one `platforms[]` entry). Account connection (`integration_ref`) is
   deferrable as long as publishing is.
2. **Corpus intake (optional)** — manual submission (first-class), own-account export, or a BYO
   scraper adapter. All ingested corpora are trust-class-tagged at write time; the C2 verifier fails
   on any item missing a `trust_class`. See [`../data-policy.md`](../data-policy.md).
3. **Author the Brand DNA** — two paths, same output (`brands/<id>/brand-dna.md` + an `archetypes/`
   catalog). With a corpus, `engine generate-dna --brand <id>` runs a deterministic analysis (no LLM)
   + a **metered host synthesis seat** (estimate-and-confirm, DD-18; competitor patterns never
   verbatim, RD-9) and degrades to the authoring template when no seat/corpus is present — see
   [`../brand-dna.md`](../brand-dna.md). Or author by hand into the template. For a brand with no
   history, take the [`cold-start.md`](cold-start.md) path (manual authoring template +
   `cold_start: true`).

```
engine verify --setup c2
```

## C3 — calibrate (the mandatory gate)

```
engine calibrate --brand <id> --estimate-only     # see the cost band
engine calibrate --brand <id> --yes               # confirm and run
engine calibrate --brand <id> --result '{"sample_count":10,"gate_clear":9,"on_voice":7,"fabrication_codes":0}'
engine verify --setup c3
```

Calibration is your first real spend and is protected by estimate-and-confirm. The harness generates N
sample drafts (default 10) across archetypes, gates them, and grades against the defined pass criteria
(≥ 8/10 clear the gate with zero hard fails; ≥ 6/10 judged on-voice; zero fabrication-class codes).
The same criteria definition grades both the runner and the verifier, so they can never disagree. The
project **must not advance without a pass**; on a failure, run the DNA/rules remediation loop and
re-run. Full detail and the criteria block:
[`brand.md`](brand.md#calibrate-c3--the-mandatory-gate).

## C4 — calendar (required) + library (optional)

- **Calendar (required):** agent-assisted generation from `templates/calendar.template.md`; the C4
  verifier needs at least one slot with a clock time. Before writing or activating the calendar, the
  agent should suggest a baseline calendar from account class, own-account content downloads,
  existing published/downloaded corpus patterns, current comparator/competitor content, approval
  bandwidth, proof/media supply, platform availability, and anti-repetition windows. Operator
  accounts can usually sustain a higher cadence than brand accounts. If proof or media is missing,
  use dormant slots or capture requests instead of filling space.
- **Library (optional):** **library indexing is available** — `engine index-library` visual-tags
  assets (estimate-and-confirm, incremental, never re-billing an already-indexed asset). Use
  **empty-library mode** (default; retrieval returns generate-only), **auto-indexing**
  (`engine index-library --estimate-only` then `--yes`), or **manual population** (hand-author
  `index.json` against the archive-index-entry schema). The verifier passes any of them. Detail:
  [`../library.md`](../library.md).
- **Campaigns:** optional, addable later.
- **Character sheets:** optional — detection is always available and zero-key; generation is metered,
  approval-gated, dry-run by default, and requires a configured image-gen provider (degrades to a
  no-op without one). See [`../library.md`](../library.md#character-sheets).

```
engine verify --setup c4
```

On a C4 pass **with C3 already passed**, the project becomes `operational`.

## Going operational

Install the scheduler triggers from `templates/scheduler/` (see
[`platforms.md`](platforms.md#scheduler-triggers)) and advance the mode ladder:

- **SAFE** (fresh installs) → **LIVE_PREVIEW** (produces real cards, never publishes) → **LIVE**.
- LIVE requires an operational project, a reachable publisher with credentials, each brand×platform
  connected, and an explicit `mode: LIVE` config change.

The first real card is produced in LIVE_PREVIEW; the narrated card → approve → `handed_off` →
publish → `published` walk lives in [`quick-start.md`](quick-start.md#first-publish-going-live--deferrable)
and the [approval/publish runbook](../runbooks/approval-publish.md).

## See also

- [`quick-start.md`](quick-start.md) — the smallest command path to the first card.
- [`cold-start.md`](cold-start.md) — the history-less-brand path.
- [`discord.md`](discord.md) · [`brand.md`](brand.md) · [`platforms.md`](platforms.md) — the detailed
  sub-steps.
- [`../troubleshooting.md`](../troubleshooting.md) — per-checkpoint failure remediation.
- [`../../agent.md`](../../agent.md) — the Repo Agent Guide.
