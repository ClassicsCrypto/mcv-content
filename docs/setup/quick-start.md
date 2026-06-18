# Quick start

The smallest literal-command path from a clean clone to your **first approval card**, then on to your
**first publish**. Everything not on this path is explicitly marked deferrable and linked to the
checkpoint that owns it. For the full C0–C4 checkpoint walk with every verifier, see
[`full-setup.md`](full-setup.md); for a brand with no history, see [`cold-start.md`](cold-start.md).

This is written agent-first: an agent runs the commands; you read along and make the human decisions
(reviewer identity, the cost confirmation, the approval reaction).

> **Brand new to this, or want the no-jargon version?** Read **[`START-HERE.md`](START-HERE.md)**
> first — it walks an absolute beginner from a clean clone to a working engine, then back here (or to
> an AI assistant) for the rest.

## C0 — prove the engine runs (zero keys)

```
git clone <repo-url> && cd <repo>
npm ci
node bin/engine.js fixture-run
```

`fixture-run` exercises the deterministic engine end-to-end against shipped fixtures with **no
credentials and no spend**. A green run is the proof the engine works on your box before you touch any
external service. Nothing here writes to a `$CONTENT_HOME`.

Before C1, ask the operator for the missing operating context:

- source library and approved asset locations;
- competitor lists, benchmark data, and off-limits sources;
- canonical brand facts, voice rules, forbidden claims, and current priorities;
- review channels, publisher accounts, analytics sources, and approver IDs;
- credentials, connectors, folder permissions, or human approvals still missing.

If those answers are not ready, continue only with zero-key and SAFE-mode steps that do not require
them. Do not invent brand facts, competitor lists, approval rules, or publishing access.

## C1 (minimal) — scaffold + the approval surface

```
node bin/engine.js init --home <path-outside-the-checkout>
export CONTENT_HOME=<path>            # PowerShell: $env:CONTENT_HOME = "<path>"
```

`init` creates the instance directory (a SAFE-mode `config/system.json`, a starter `.env`, a
local-only git repo, and `setup-state.json`). It refuses a path inside the code checkout. See
[`../configuration.md`](../configuration.md#content_home-layout) for the layout.

`CONTENT_HOME` is the local instance/state folder: queue, brands, config, logs, workspaces, and
secrets. It is deliberately outside the repo so commits never capture private instance data.

Then, the minimal C1:

1. **Discord channel access, four channels.** Create or choose the channels, grant your host runtime
   permission to post/read/react there, and record their ids in `system.json` →
   `approval_surface.channels`. No Discord bot token is required by the engine when the host runtime
   already owns the Discord connector. Full checklist: [`discord.md`](discord.md).
2. **Write `config/system.json`:** one reviewer in the allowlist, engine-metered budget caps
   (`monthly_cap`, `daily_cap`, `per_item_generation_limit`), `mode: SAFE`, and a host-runtime
   token-reporting plan so the first completed chain run prints approximate input/output token use.
3. **Instantiate the six seats** (orchestrator, matcher, writer, gate, packager, publisher-liaison) —
   the chain your host runtime runs.

> **Postiz is NOT needed yet.** Publisher integration is deferrable until you go LIVE — see step 8.

Verify:

```
engine verify --setup c1
```

## C2 (minimal) — one brand, cold-start Brand DNA

```
# brands/<brand-id>/brand.json from templates/brand/brand.json.template
```

Register **one brand** (`id`, `display_name`, `account_class`, one `platforms[]` entry — use Twitter).
Author the Brand DNA with the **cold-start path**: fill the agent-assisted authoring template
(`templates/brand/brand-dna-authoring.md`) by interview, set `cold_start: true` in `brand.json`, and
use the starter archetype set. **No scraping, no corpus, no account connection yet.** Full cold-start
walk: [`cold-start.md`](cold-start.md).

```
engine verify --setup c2
```

## C3 — calibrate (mandatory gate, your first spend)

```
engine calibrate --brand <id> --estimate-only     # see the cost band first
engine calibrate --brand <id> --yes               # confirm, then run
```

Calibration is the **mandatory gate** and your first real engine-metered spend, so it is
estimate-and-confirm: the runner shows a pre-run estimate and will not spend without `--yes`.
Generation runs through your host runtime; record the host-reported input/output tokens for the run
alongside any runtime-known cost. Record the judged result, then verify:

```
engine calibrate --brand <id> --result '{"sample_count":10,"gate_clear":9,"on_voice":7,"fabrication_codes":0}'
engine verify --setup c3
```

The project cannot advance without a C3 pass. Detail + pass criteria:
[`brand.md`](brand.md#calibrate-c3--the-mandatory-gate).

## C4 (minimal) — a small calendar, empty library

Generate a small calendar (e.g. a 3-slot/week Twitter cadence) from `templates/calendar.template.md`;
at least one slot needs a clock time. Use **empty-library mode** — leave the library disabled;
retrieval returns generate-only decisions. *(Deferrable: campaigns, character sheets, the media
library — when you do add media, `engine index-library` visual-tags it; see
[`../library.md`](../library.md).)*

```
engine verify --setup c4
```

On a C4 pass with C3 already passed, the project becomes `operational`.

## First card (LIVE_PREVIEW)

Install the daily trigger from `templates/scheduler/` **or** skip it and drive one slot by hand.
Then set `mode: LIVE_PREVIEW` and run a slot:

```
engine run-slot <slot-id>
```

The engine writes a slot-run task record to `$CONTENT_HOME/ledger/tasks/`; **your host runtime picks
it up and runs the chain**, which produces a real approval card in your `content-review` channel.
LIVE_PREVIEW produces real cards but **never publishes**. This is the first-approval-card milestone.

When the card appears, the human reviewer reacts to approve / approve A / approve B / edit / reject.
In LIVE_PREVIEW the decision is captured and attributed, but nothing hands off to a publisher.

## First publish (going LIVE) — deferrable

This is the deferred publisher step from C1/C2:

1. Stand up Postiz, set `POSTIZ_API_KEY` + `POSTIZ_API_URL` in `.env` (both or neither).
2. Connect the brand's account in Postiz and record `platforms[].integration_ref` in `brand.json`.
3. Set `mode: LIVE` on the operational project.

Now run a slot and approve the card. The executor hands off **draft-only**: the queue entry shows
`handed_off` and the post sits as a **draft in Postiz**. You publish the draft in Postiz; the
executor's `verifyStatus` poll then advances the entry to `published`.

> **`handed_off` means "approved, awaiting your publish in Postiz."** That is the expected LIVE-mode
> state, not a failure. See the [approval/publish runbook](../runbooks/approval-publish.md).

## What you deferred (and where it lives)

Each of these is a labeled later checkpoint, resumable any time:

- Competitor ingestion / corpus data → [`brand.md`](brand.md#corpus-intake-optional-c2-step-2)
- Library indexing + folder auto-sort + character sheets → [`../library.md`](../library.md)
  (empty-library mode is the default; `engine index-library` auto-tags assets, or populate `index.json`
  manually)
- Additional brands / platforms / account connections → [`platforms.md`](platforms.md)
- Campaigns, the media + analyst seats, the analytics loop, trend slots, Giphy

## See also

- [`full-setup.md`](full-setup.md) — the complete C0–C4 walkthrough with every verifier.
- [`cold-start.md`](cold-start.md) — the history-less-brand path in full.
- [`../../agent.md`](../../agent.md) — the Repo Agent Guide (point your agent here).
