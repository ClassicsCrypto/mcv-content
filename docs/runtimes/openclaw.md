# Host runtime: OpenClaw (reference fast path)

OpenClaw is the v1 **reference runtime**. This doc is the fast path: how to instantiate the seats,
wire the run-dispatch hook, and set the host-side knobs so the chain runs hands-off. It implements
the same capability contract as any runtime — see [`generic.md`](generic.md) for the contract itself
and the degenerate manual path. Other runtimes are community-supported best-effort.

## 1. Instantiate the seats

Instantiate the roster from `agents/*/AGENTS.template.md` as OpenClaw agent definitions/sessions —
one per seat. For a text-only first run, the six-seat minimum (orchestrator, matcher, writer, gate,
packager, publisher-liaison) is enough; add media and analyst when you need them.

Configure the **operating** seats tool-less: a pipeline seat must hold no shell/tool or config-write
authority during operation (Zone S). Only the setup session (C1–C4) gets elevated tool access. In
OpenClaw, express this through the seat's tool/permission profile so the seat genuinely cannot run a
tool — a prompt prohibition alone is not sufficient. The instantiated definitions are instance data;
they live host-side, never in the checkout.

## 2. Wire the run-dispatch hook (the fast part)

The fast path is a **scheduled host job that polls `$CONTENT_HOME/ledger/tasks/`** and starts the
orchestrator seat on each pending record. Concretely, the job:

1. lists pending task records (oldest-first),
2. claims the oldest (so a second run cannot take the same task),
3. starts the orchestrator seat with the task's `command` (brand, platform, format, mode, pre-seed),
4. marks the record `done` / `failed` when the run finishes.

The engine exposes the consumption surface for steps 1–4 (`listPending`, `claimTask`, `completeTask`,
`failTask` in `engine/orchestrator/dispatch.js`); you do not parse the directory by hand. Schedule
this poll job alongside the engine triggers from `templates/scheduler/` (the daily kickoff writes the
day's task records; the poll job consumes them). On OpenClaw this poll-and-start loop is what makes
runs automatic — on a generic runtime the same outcome is achieved by manually prompting the agent
with a pending task.

## 3. OpenClaw-specific settings (documented HERE only)

A few OpenClaw fast-path settings are host-runtime-coupled. They are documented here and **never** in
`.env.example`, because shipping them there would contradict the engine's runtime-neutral claim:

- `OPENCLAW_MJS` — path to the OpenClaw entry the poll job invokes to start a seat session.
- `OPENCLAW_ENQUEUE_ATTEMPTS` — how many times the host job retries enqueuing a seat run.
- `OPENCLAW_ENTRY` — the entry/command used to launch the seat.

Set these in your OpenClaw host configuration / the scheduled job's environment, not in the engine's
`$CONTENT_HOME/.env`. They configure how OpenClaw *starts a seat*; the engine neither reads nor
depends on them.

## 4. Discord approval surface

If the OpenClaw agent is already configured in the target Discord workspace/server, that connector
satisfies the host-capability self-check for Discord read/post/react operations. Do not ask the
operator to create a second bot just to talk to the same Discord server. Bind the approval channels in
`approval_surface.channels`, keep `approval_surface.adapter: "discord"`, and use the existing
OpenClaw Discord connector for approval cards and reactions. Only fall back to provisioning
`DISCORD_BOT_TOKEN` when the OpenClaw connector cannot access the target server or the deployment
intentionally separates the engine's approval adapter from the host runtime's Discord connector.

## 5. Token and cost reporting (the optional capability that pays off)

OpenClaw can report **per-run token use**, and cost when the provider exposes it, back to the engine.
Wire that reporting so the first completed chain run can print approximate input/output token totals.
For subscription-plan users of Claude Code, ChatGPT Codex, OpenClaw, Hermes, or similar harnesses,
token volume is often the best practical way to understand what share of the plan a run consumes.
Without reporting, the engine still honestly marks chain spend as "engine-metered only (partial)" and
the caps still bound engine-metered actions and new-run dispatch, but the chain-seat LLM tokens are
out-of-band. Cap or monitor the chain spend at your LLM provider or runtime regardless. See
[`../cost.md`](../cost.md).

## 6. Long-session tolerance

Chain runs are minutes-to-hours (a full text-heavy run walks matcher → writer → gate → media →
packager → publisher-liaison, with LLM stages in between). Configure OpenClaw's session/idle timeouts
generously enough that a long content run is not killed mid-chain; persistent per-seat sessions/memory
should survive across runs.

## See also

- [`generic.md`](generic.md) — the capability contract and the manual degenerate hook.
- [`../setup/platforms.md`](../setup/platforms.md#scheduler-triggers) — the engine triggers the poll job runs beside.
- [`../cost.md`](../cost.md) — capping and reporting chain spend.
- [`../architecture.md`](../architecture.md#1-what-the-system-is) — the engine-vs-runtime split this fast path sits across.
