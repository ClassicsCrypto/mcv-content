<!--
  agent.md — THE Repo Agent Guide (release-spec §17.1; the Cross-Cutting Requirement; model §1.3/§13.1).
  Distinct by name and role from per-seat Agent Definitions: agent.md is the ONE repo-level entry point
  an operator points their host agent at; agents/<seat>/AGENTS.template.md are the per-seat contracts.
  Authority cited inline. Runtime-neutral body + an OpenClaw fast-path section (RD-2). Written
  agent-first (RD-6): an AI agent executes it; a human reads it. Regenerated clean (§13.3 r4); no
  instance constants, no production persona codenames (§0.3 r6).
-->

# Repo Agent Guide (`agent.md`)

You are an AI agent. An operator has cloned this repository and pointed you here. **This file is
your single entry point** — it tells you what the system is, how to verify your host can run it, how
to drive setup end-to-end, how to operate it day to day, and where to look when something breaks.
Everything deeper lives under [`docs/`](docs/); this file is the map and the operating contract.

You drive; the human decides. Two authorities never move from the human to you: **approving content
for publication** and **publishing a draft on the platform**. Everything between — setup, generation,
gating, queueing, dispatch, observability — is yours to run.

---

## 1. What this is (two paragraphs)

A **multi-agent brand content production system**, shipped as a **kit plus a thin runner**: markdown
agent contracts, rules, schemas, and templates that you (the host runtime) execute, plus deterministic
Node.js engine code at the edges — scheduling, queue persistence, validation, approval capture, and
publishing. It produces platform-ready social content through a fixed agent chain, gates every draft
through a hybrid validation gate with a deterministic backstop, requires an **attributed human
approval** before anything publishes, and learns from reviewer feedback through governed, reviewable
learning records.

The deterministic engine runs as the **`engine` CLI** (shorthand for `node bin/engine.js <verb>`). The
LLM work — the agent seats in the chain — is **yours**: the engine never calls a chain-seat LLM (RD-2;
§4.3). You and the engine meet at a file-based transport: the engine writes **slot-run task records**
under the instance directory and you consume them to run the chain. That division is the whole design:
the engine is auditable and deterministic; the judgment is the model's.

---

## 2. Host-capability self-check (do this first — §3.2)

Before setup, confirm your host runtime provides the capability contract. Run this check and report
the result to the operator; if a **required** capability is missing, stop and say so.

| # | Capability | Required? | How you satisfy it |
|---|---|---|---|
| 1 | Persistent sessions/memory per agent seat across runs | required | one durable session per seat (§9.1 roster) |
| 2 | Scheduling or schedulability (can be triggered externally) | required | a scheduler recipe (cron / Task Scheduler / PM2) fires the engine |
| 3 | Tool/shell execution **for the setup session only** | required | pipeline seats run **tool-less** in operation (§2.1; Zone S) |
| 4 | Discord channel operations (read/post/react) | required | for the seats that touch the approval surface |
| 5 | Long-running session tolerance (chain runs take minutes-to-hours) | required | — |
| 6 | **Run-dispatch consumption** — a hook that starts the orchestrator seat on a pending task record | required | see §5; the degenerate hook is "the operator prompts you with the pending task" |
| 7 | Per-run token/cost reporting the engine can ingest | SHOULD (optional) | without it, `engine status` marks chain spend *engine-metered only (partial)* (§3.2 #7) |

**Verify Node + git, then prove the engine runs with zero keys:**

```
node --version      # MUST be >= 22
git --version
npm ci
node bin/engine.js fixture-run     # the zero-key, no-CONTENT_HOME proof (§2.2 C0 / §5.4)
```

`fixture-run` and `engine init --home <path>` are the **only two** commands that run without
`CONTENT_HOME` set (§4.1). If `fixture-run` is green, the deterministic spine works on this clone.

---

## 3. The privilege break — read before you start setup (§2.1, §9.1; model §8)

There are two phases, and they have different rights:

- **Setup (checkpoints C0–C4):** you run in a session **with elevated tool/shell access**. You create
  directories, write config, instantiate seats, run estimators. This is the only time you hold those
  rights.
- **Operation:** once the project is `operational`, **pipeline seats hold no tool or config-write
  authority** (Zone S). They read and write only schema-validated artifacts under the instance
  directory; they never touch the queue directly, never edit rules or config, never publish. The
  human operator (Zone A) holds approval and publish rights. Untrusted/scraped input (Zone U) reaches
  drafting seats only inside **data fences** (RD-8).

When you instantiate seats (C1 step 6), you MUST configure the pipeline seats **tool-less**. A
prompt-level "please don't use tools" is not sufficient (model §8); the host-runtime instantiation
must enforce it. `docs/runtimes/<runtime>.md` states how for your runtime.

---

## 4. Setup — the C0–C4 state machine (§2)

Setup is **idempotent and resumable**. Progress is recorded per-step in
`$CONTENT_HOME/setup-state.json`; re-running resumes from the first incomplete checkpoint and never
duplicates channels, re-bills scrapes/indexing, or overwrites Brand DNA. After each step, run the
verifier and report the result; a failure halts with a **named step + remediation** — fix that, then
re-run. The project lifecycle is `uninitialized → ingested → calibrated → operational` (+ `paused`),
and it MUST NOT reach `operational` without a calibration pass (C3).

Order is fixed (DD-5): **integration/agents → ingestion → calibration → calendar/library.**

### C0 — Prerequisites and zero-key proof
- Install prerequisites (§3). Clone, `npm ci`.
- `node bin/engine.js fixture-run` — the zero-key end-to-end proof. This is the "is this for me / does
  it work" check before any spend or account linking. The verifier: `engine verify --checkpoint C0`.

### C1 — Integration and agents (executable order — every artifact exists before the config that names it)
1. `engine init --home <path>` — scaffolds `$CONTENT_HOME` (§1.2 layout), a SAFE-mode starter
   `config/system.json`, a starter `.env` to fill as you produce credentials, a **local-only git repo**
   (for learning-record rollback, DD-6), and `setup-state.json`. Idempotent.
2. **Discord bot application:** create the application + bot user in the Discord developer portal,
   generate the bot token into `$CONTENT_HOME/.env` as `DISCORD_BOT_TOKEN`, and invite the bot with the
   **minimum permission set** (read/send messages, embed links, attach files, add reactions, read
   history, threads where used — **no admin, no manage-guild**). `templates/channels.md` is the
   end-to-end checklist for this — the most error-prone external procedure gets the most explicit guide.
3. **Discord channels:** create the four channel roles manually — `content-review`,
   `content-published`, `content-ops`, `media-bank` (+ optional `trend-readout`). Record the created
   channel IDs; step 5 consumes them. (Auto-creation is not in v1.)
4. **Publisher integration (deferrable until LIVE):** stand up or point at a Postiz instance; put
   `POSTIZ_API_KEY` / `POSTIZ_API_URL` into `.env`. Not required for SAFE / LIVE_PREVIEW — the
   quick-start defers it to the going-LIVE step.
5. **System configuration:** write `config/system.json` from the template, binding the now-known
   channel IDs (`approval_surface`). Setup MUST NOT proceed past C1 without: a **reviewer allowlist**
   with at least one `approve` reviewer (DD-17); a **budget** block with hard caps (DD-18); a publish
   posture (mode default **SAFE**).
6. **Agent seats:** instantiate the seat roster from `agents/<seat>/AGENTS.template.md` into host
   sessions per `docs/runtimes/<runtime>.md`, **tool-less** (§3), including the **run-dispatch hook**
   (§5). Minimal text-only first run = six seats (orchestrator, matcher, writer, gate, packager,
   publisher-liaison); media + analyst are deferrable. Instantiated copies are instance data — they
   live host-side or in `$CONTENT_HOME`, never in this checkout.
7. Verify: `engine verify --checkpoint C1`.

### C2 — Ingestion and brand identity
1. **Brand registration:** one `brands/<brand-id>/brand.json` (brand-keyed from day one). Connect each
   platform account in Postiz and record its `integration_ref` (deferrable as long as publishing is).
2. **Corpus intake** (preference order): manual data submission (first-class) → own-account export →
   BYO scraper adapter. All ingested corpora are **trust-class-tagged at write**; scraped material —
   including the operator's own — enters as Zone U `untrusted-scraped` with an attestation path to
   promote curated subsets (RD-8). Cold-start is fully supported: skip the corpus.
3. **Brand DNA:** v1 is **agent-assisted authoring, not one-shot automation**. Interview the operator
   and/or analyze the corpus, then fill `templates/brand/brand-dna-authoring.md`. Output:
   `brands/<id>/brand-dna.md` + an archetype catalog.
4. **Background + competitors:** operator-supplied context + competitor handle list; competitor corpora
   are always Zone U.
5. Verify: `engine verify --checkpoint C2`. Project state → `ingested`.

### C3 — Calibration (mandatory; the operator's first real spend)
- `engine calibrate --brand <id>`. It presents a **pre-run cost estimate and requires confirmation**
  (DD-18) — re-invoke with `--yes` to proceed. Use `--estimate-only` to see the band without spending.
- It generates N sample drafts (default 10) across the brand's archetypes, gates them, and grades
  against the **defined pass criteria** (not vibes): defaults — ≥ 8/10 clear the gate with zero hard
  fails; the operator judges ≥ 6/10 on-voice; zero fabrication-class codes.
- On failure: remediation loop (adjust DNA/rules, re-run). The project MUST NOT advance without a pass.
- The verifier `engine verify --checkpoint C3` **grades the recorded result** — it never spends; run
  `calibrate` first to produce it. On pass, pin the known-good baseline (tag a commit in the instance
  repo). Project state → `calibrated`.

### C4 — Calendar and library
1. **Calendar:** agent-assisted from `templates/calendar.template.md` + operator cadence; calendar
   generation assigns clock times to slots (DD-22).
2. **Campaigns (optional):** addable any time.
3. **Library (optional / deferrable):** point config at the media library and index it with
   `engine index-library` — it visual-tags each asset (description + tags + type, plus a duration for
   video) through the §12.5 vision provider, under the same estimate-and-confirm contract as calibrate
   (no `--yes`, no spend) and **incrementally** (already-indexed assets are skipped and never
   re-billed). **Empty-library mode is fully supported** — retrieval returns generate-only decisions;
   nothing hard-depends on a populated index, and `index-library` with no media is a clean no-op.
   `docs/library.md` covers indexing, folder auto-sort, and character sheets in full.
4. **Character sheets (optional):** detection (which roster characters already have a sheet) is
   deterministic, always available, and zero-key; generation of a missing sheet is metered,
   approval-gated, dry-run by default, and **requires a configured image-gen provider** — it degrades
   to a no-op when none is set (it never fabricates a sheet).
5. Verify: `engine verify --checkpoint C4`. Project state → `operational`.

Running `engine verify` with **no `--checkpoint`** walks the ladder from the first incomplete
checkpoint forward and stops at the first failure — this is your "where am I in setup, what's next"
surface.

---

## 5. How runs happen — the run mechanics (the load-bearing section — §8.4, RD-18, DD-19)

The engine does not call your seats. It hands you work through a file transport, and **no work runs
without a record** — task records double as the run-attribution records `engine status` reports on.

**Transport.** Every run — scheduled or ad hoc — is a **slot-run task record** (schema'd) written to
`$CONTENT_HOME/ledger/tasks/` in state `pending`. Three things write them:

- the **daily kickoff** (`engine kickoff`, installed on a scheduler) writes the day's records — and,
  when `work_recap.enabled`, also the **daily build-in-public option** (one per operator account into a
  reserved `work_recap` slot; §8.5);
- **`engine run-slot <slot-id>`** writes one immediately (the on-demand verb — quick-start first run);
- **`engine dispatch --family … --brand … --platform …`** writes one ad-hoc record without a calendar
  entry;
- the **trend pass** (`engine poll-trends`, config-gated, installed on a 2/4/8/12 h cadence) polls the
  configured adapter and writes one record per fresh report into a reserved `trend` slot (§8.5; DD-16).

Each record carries a **named trigger** (`morning-kickoff | calendar-tick | run-slot | kickoff--now |
run-campaign | trend-poll | work-recap`) and a stable `task_id`. Re-dispatching the same logical slot
for the same date is **idempotent** — it returns the existing record, never a second run. The trend
pass and work-recap option both run through THIS transport — they are content SOURCES that feed the
chain, never a bypass: each produces a SEED that runs matcher → writer → the gate → queue → the human
approval card, in SAFE by default.

**Consumption — your hook.** You consume pending records through a per-runtime hook documented in
`docs/runtimes/<runtime>.md`. The hook does exactly this:

1. poll `$CONTENT_HOME/ledger/tasks/` for the oldest `pending` record;
2. **claim** it (`pending → claimed`, recording who claimed it — two runtimes can't both claim one);
3. start the **orchestrator** seat with the record's `command` as input;
4. let the chain run through the seats; between seats, artifacts move as schema-validated files in
   `$CONTENT_HOME/workspaces/<stage>/` keyed by `content_id`;
5. on completion, mark the record `done` (or `failed` with a reason).

**The degenerate hook always satisfies the contract:** if your runtime has no scheduled poller, the
operator (or you, when prompted) reads the pending task and starts the orchestrator seat manually. Any
mechanism that starts the orchestrator seat on a pending record qualifies (DD-1(c)).

**Preflight.** Dispatch is fail-closed: the engine checks the **PAUSED** kill switch and the spend cap
**before writing any record**. A paused or over-budget project dispatches nothing, and the verb says so
(reason `EPAUSED` / `EBUDGET`) — that is the system behaving correctly, not an error.

You never invent a run. **No task record, no run.**

---

## 6. Modes — the ladder you operate under (§8.3)

| Mode | What happens | When |
|---|---|---|
| `SAFE` | artifacts only; **no Discord posts, no publisher calls** | the default for fresh installs (RD-16f) |
| `LIVE_PREVIEW` | real approval cards posted to `content-review`; **publishing disabled** | first real card, before going LIVE |
| `LIVE` | full pipeline; publisher handoff is **draft-only** by default (the second gate) | requires `operational` state + explicit config change |

Mode resolves through one authority: explicit `--mode` on a verb > `ENGINE_MODE` env (a loud diagnostic
override only) > `config/system.json` `mode` > `SAFE`. Every verb that runs the pipeline or dispatches
surfaces the resolved mode and any override notice in its output. **Safety posture lives in declared
config, not in scheduler wrappers.**

---

## 7. The CLI verbs you use (all real — `engine <verb>` = `node bin/engine.js <verb>`)

| Verb | What it does | Key flags |
|---|---|---|
| `init` | scaffold `$CONTENT_HOME` (CONTENT_HOME-free) | `--home <dir>`, `--no-git` |
| `verify` | the C0–C4 setup gate; record outcomes into `setup-state.json` | `--checkpoint C0..C4` (omit to walk the ladder) |
| `fixture-run` | the zero-key deterministic end-to-end proof (CONTENT_HOME-free) | — |
| `run-slot <slot-id>` | run one calendar slot on demand → dispatches a task record | `--mode`, `--date`, `--lane`, `--dispatch-only` |
| `kickoff` | the canonical daily batch: dispatch the day's eligible slots under the single-runner lock (also fills the daily work-recap option when `work_recap.enabled` — §8.5) | `--now`, `--date`, `--max <n\|all>`, `--brand`, `--dry-run` |
| `poll-trends` | the config-gated trend pass (§8.5, OFF by default): poll the adapter, post the angles-only readout, dispatch fresh reports into reserved `trend` slots | `--brand`, `--adapter`, `--cadence`, `--content-form`, `--mode`, `--force`, `--dry-run` |
| `dispatch` | write one ad-hoc slot-run task record (no calendar entry needed) | `--family`, `--brand`, `--platform`, `--format`, `--mode`, `--force` |
| `status` | the one-command operational surface (§9) | `--json` |
| `calibrate --brand <id>` | the C3 calibration runner (estimate-and-confirm) | `--samples`, `--yes`, `--estimate-only`, `--result <json>` |
| `index-library` | manage the media library: visual-tag/index (default), folder auto-sort (`--organize`), or character sheets (`--character-sheets`). Metered actions are estimate-and-confirm + dry-run; incremental, never re-bills; empty-library = no-op | `--yes`, `--estimate-only`, `--force`, `--no-hash`, `--organize [--apply]`, `--character-sheets [--generate --yes --apply]`, `--brand` |
| `purge-corpora` | enforce corpus retention windows by `retention_class` (dry-run by default) | `--apply`, `--brand` |
| `pause` / `resume` | the kill switch — engage / clear the PAUSED sentinel + config flag | `pause --reason "<text>"` |

Every verb supports `--help` and `--json`. `engine --help` lists them. Exit codes: `0` success; `1`
verb-level failure (a failed checkpoint, an erroring run); `2` usage/setup error; `3` a not-yet-present
dependency (e.g. calibration content); `64` unknown verb. A **refused-by-design** dispatch (PAUSED /
over budget) exits `0` — it behaved correctly.

---

## 8. The second gate — what "approved but not posted" means (§8.3; the thing operators ask about)

In `LIVE`, after a reviewer approves a card, the executor hands off **draft-only**: it creates a
**draft in Postiz** and the queue entry advances to `handed_off`. **Publishing the draft inside Postiz
is the operator's action** — the human, in the publisher UI. Once published there, the executor's
`verifyStatus` poll advances `handed_off → published`. So:

> **`handed_off` = "awaiting operator publish in the publisher."** It is the expected LIVE-mode state,
> not a failure. `engine status`, the queue view, and the quick-start walkthrough all say so.

You will see this in `engine status` glossed exactly that way. Do not treat a `handed_off` backlog as
broken — it means cards were approved and are sitting as drafts for the human to push live.

---

## 8.5 Optional content sources — trends + work-recap (config-gated, OFF by default)

Two opt-in **content sources** can feed the chain in addition to calendar slots. **Both ship
disabled**, both produce a *seed* that runs the **full chain to the human approval card**, and
**neither bypasses the gate or auto-publishes** (SAFE is still the default). Each is enabled only by
its config block in `config/system.json`.

- **Trends** (`trends` block) — a bring-your-own trend adapter polls a provider the operator supplies
  on a 2/4/8/12 h cadence and writes Zone-U **Trend Reports** under `$CONTENT_HOME/trends/`. Reports
  seed **reserved `trend` calendar slots only** (never out-of-calendar — DD-16); `quote-retweet` is a
  gated `content_form`; a stale trend **expires** rather than posting late (the freshness-window TTL,
  DD-15). Trend slots **skip or fall back to evergreen** when no fresh report exists. A manual
  submission path (a report file in `$CONTENT_HOME/trends/`, or `RUN_TREND_MANUAL`) needs no keys.
  `trends.enabled` must be **strictly `true`**; while off, no provider is contacted and no credential
  is read. **Scheduling:** install `engine poll-trends` on the same interval as `trends.cadence` (a
  cron/PM2 line — see `templates/scheduler/`); each pass polls, posts an **angles-only readout** to
  the optional `trend-readout` channel (it is **not** an approval surface), and dispatches one record
  per fresh report into a free reserved `trend` slot (a slot already filled today is not refilled; a
  report with no free reserved slot is reported `unslotted`, never posted out-of-calendar). The pass
  runs under the kickoff's single-runner lock + PAUSED/budget preflight. Full doc:
  [`docs/trends.md`](docs/trends.md).
- **Work-recap / build-in-public** (`work_recap` block) — turns the operator's **own project memory**
  into founder/operator-voice posts (targets `account_class: operator` accounts, §3.3).
  **Privacy is load-bearing:** memory is sensitive, so the source runs a **redaction pre-pass**
  (reusing `redact.js` + a config-extendable `private_terms` deny list) and the gate runs a
  **privacy/leak check** — both **before** the mandatory human approval card. The engine reads a
  **configured `memory_path`** and **never bundles or commits memory**; raw memory never enters the
  seed (sanitized summaries only). `work_recap.enabled` must be **strictly `true`**; a missing/empty
  memory path is a clean no-op. **Scheduling:** the **daily `engine kickoff` fills it** — one
  build-in-public option per day per operator account into a reserved `work_recap` calendar slot (no
  extra scheduler entry needed); per-account scoping via `work_recap.accounts[]`. Full doc:
  [`docs/work-recap.md`](docs/work-recap.md).

Both sources are **injectable for zero-key testing** (the trend fetch and the memory file reads are
seams like §12.5), so the fixtures and tests run with no secrets. Config keys are in
[`docs/configuration.md`](docs/configuration.md).

---

## 9. Operations — reading `engine status` and the failure playbooks (§13.1)

`engine status` answers, in one command: **did it run today, what did it produce, what failed with
which codes, what did it spend** — without reading internals. It reports:

- resolved **mode** + `paused`/active + **project state**;
- **queue** per-state counts + oldest-item age (with `handed_off` glossed as §8);
- **today's** produced / published / failed counts + **failure-code tallies**;
- **last run per named trigger** (DD-19);
- **pending task records** (queued-but-not-yet-run);
- a **wiring self-check** (CONTENT_HOME resolvable, config present + schema-shaped, an approver in the
  allowlist, `DISCORD_BOT_TOKEN` present, Postiz creds present-or-deferred — it names a missing
  variable, never its value);
- **spend**, honestly scoped: the engine meters **its own** actions; chain-seat LLM spend is
  **host-runtime-owned** and shows as *engine-metered only (partial)* unless your runtime reports
  per-run cost. The `monthly_cap` bounds engine-metered actions + run dispatch — **not** whole-system
  spend. Cap chain spend at your runtime (see `docs/cost.md` + `docs/runtimes/<runtime>.md`).

**Failure playbook (common cases):**

| You see | It means | Do |
|---|---|---|
| `status` wiring `✗ discord_token` | `DISCORD_BOT_TOKEN` missing/blank | fail-fast by design — set the token in `$CONTENT_HOME/.env`; never retry-loop an auth failure (§15.1) |
| many items in `handed_off` | approved drafts awaiting publish | not broken — tell the operator to publish them in Postiz (§8) |
| `dispatch refused (EPAUSED)` | the kill switch is engaged | `engine resume` when ready (§15.4) |
| `dispatch refused (EBUDGET)` | spend cap breached | raise/adjust the budget block or wait for the window; new runs are halted by design |
| `kickoff skipped — single-runner lock` | another run holds the lock (DD-19) | normal overlap skip; nothing to do |
| an item in `interrupted_hold` | a publish was crash-interrupted (the artifact may exist) | operator-released only — never auto-retried (a draft/post may already exist) |
| hard-fail dead-letter + "unfilled slot" notice | retries exhausted (bound 3) | redraft is an operator choice; the slot returns |

The detailed runbooks live in [`docs/runbooks/`](docs/runbooks/): daily kickoff, approval/publish,
weekly analytics, rotate-credentials, recover-from-stall. The deeper references live in `docs/`
(`architecture.md`, `configuration.md`, `rule-authoring.md`, `extending.md`, `cost.md`, `library.md`,
`data-policy.md`, `observability.md`, `troubleshooting.md`, `trends.md`, `work-recap.md`, `runtimes/`,
`platforms/`).

---

## 10. OpenClaw fast path (the v1 reference runtime — RD-2)

OpenClaw is the reference runtime; everything above is runtime-neutral, and this section is the
shortcut. Full details: [`docs/runtimes/openclaw.md`](docs/runtimes/openclaw.md).

- **Seats** map to OpenClaw agent sessions (one per `agents/<seat>/AGENTS.template.md`), configured
  tool-less for operation (§3).
- **Run-dispatch hook (§5):** wire a scheduled OpenClaw job that polls `$CONTENT_HOME/ledger/tasks/`,
  claims the oldest `pending` record, and starts the orchestrator seat with its `command` — then marks
  it `done`/`failed`. On this fast path the hook is automatic; the operator does not hand-prompt runs.
- **Scheduler:** install the `templates/scheduler/` recipe (cron / Task Scheduler / PM2) for the daily
  `engine kickoff`, the executor interval, the analytics interval, the TTL sweep, and the approval
  listener daemon. Every recipe sets `CONTENT_HOME` in the process environment (the one variable that
  cannot live in `$CONTENT_HOME/.env` — `paths.js` needs it to find the `.env`).
- **OpenClaw-coupled settings** (e.g. the fast-path enqueue knobs) are documented in
  `docs/runtimes/openclaw.md` only — they are deliberately **not** in `.env.example`, which stays
  runtime-neutral.
- **Spend reporting:** if you wire per-run cost reporting back to the engine, `engine status` shows
  full spend; otherwise it is honestly marked *engine-metered only (partial)*.

A generic (non-OpenClaw) runtime follows the same contract via
[`docs/runtimes/generic.md`](docs/runtimes/generic.md); only the seat-instantiation and run-dispatch
hook instructions differ. Other runtimes are best-effort (DD-1(c)).
