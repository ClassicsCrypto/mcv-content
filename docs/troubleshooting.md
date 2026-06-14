# Troubleshooting

Symptom → check → fix for the failure modes you will actually hit. Every state and code named here
is defined in [`architecture.md`](architecture.md) and [`../rules/codes.md`](../rules/codes.md);
`engine status` is your first stop for most of them.

## Missing or invalid credential (fail-fast, no retry)

**Symptom:** a component refuses to start naming a variable; `engine status`'s wiring self-check
shows `✗ discord_token` (or `✗ publisher`).

A missing or **invalid** credential is **permanent** — the engine does *not* retry credential
resolution (this avoids the crash-loop where a bad token is retried forever). The error names the
variable and its consumer, never the value.

- **Check:** is the variable set in `process.env` or `$CONTENT_HOME/.env`? Resolution reads
  `process.env` first, then `$CONTENT_HOME/.env`, and stops — there is no other path.
- **Fix:** set the named variable (e.g. `DISCORD_BOT_TOKEN`, `POSTIZ_API_KEY` + `POSTIZ_API_URL`) and
  **restart** the consuming component.

### Bot token invalid / rotation

If you rotate the Discord bot token, the listener will fail fast with "missing or invalid" until you
update `$CONTENT_HOME/.env` and restart it. Update the `.env`, restart the listener, and confirm
`engine status` shows `✓ discord_token`. A token left stale produces an immediate, named failure —
not a silent hang.

## Discord misconfiguration

**Symptom:** `engine verify --setup c1` fails `channel_bindings` or `discord_token`; no cards appear
in the review channel.

- `channel_bindings` lists **unbound or placeholder** roles → you left a `<CHANNEL_ID>` (or a
  `0000…` template value) in `config/system.json`. Replace each required role
  (`content-review`, `content-published`, `content-ops`, `media-bank`) with the real channel id and
  re-run.
- Cards never post → confirm the bot is **in the server** and has channel-level View/Send/Embed/
  Attach/React permissions in the bound channels (server-wide is not enough), and that you are in
  `LIVE_PREVIEW` or `LIVE` (in `SAFE` no cards are posted — that is correct).
- See [`setup/discord.md`](setup/discord.md) and [`../templates/channels.md`](../templates/channels.md).

## Empty library / cold-start brand

**Symptom:** retrieval returns only "generate" decisions; `engine verify --setup c4` warns about the
library.

This is expected for empty-library mode and cold-start brands. Nothing in the chain hard-depends on a
populated index.

- For a brand with no archetypes, set `cold_start: true` in `brand.json` — the C2 verifier then
  accepts the empty catalog (otherwise it fails, asking you to add archetypes or set the flag).
- Calibration quality improves once you add corpus data; add it later and re-calibrate. See
  [`setup/cold-start.md`](setup/cold-start.md).
- To move off empty-library mode, add media and run `engine index-library` (it visual-tags assets;
  estimate-and-confirm, incremental) or hand-author `index.json`. See [`library.md`](library.md).

## Gate hard-fail

**Symptom:** a draft never reaches the approval queue; the ledger shows a `FAIL` verdict with one or
more HARD codes.

A HARD code blocks the item entirely and routes it back to the seat named by the code's `route`. The
engine retries up to a bound of **3**, incrementing the attempt counter before each retry's spend.
On exhaustion the item dead-letters (`SYS.RETRY_EXHAUSTED`), the state becomes `dead_lettered`, and an
**"unfilled slot" notice** is posted to the review channel — there is no automatic redraft (cost
containment); redraft is your choice.

- **Check:** look up the failing code in [`../rules/codes.md`](../rules/codes.md) for what it means
  and which seat it routes to.
- **Fix:** address the root cause (e.g. `FM.FABRICATION` → the draft asserted an unsourced fact; tune
  the brief or claims-safety rule). Repeated dead-letters on one code are a calibration signal — see
  the calibration-drift KPI in [`observability.md`](observability.md).

## Stuck queue entries (and the ones that aren't stuck)

Check `engine status` queue states. What each non-terminal state means:

- **`handed_off`** — **NOT stuck.** In LIVE the post is a *draft* in the publisher awaiting your
  manual publish; the executor's `verifyStatus` advances it to `published` only after you publish it
  there. "Approved but nothing posted yet" is the expected LIVE state. To move it: publish the draft
  in the publisher.
- **`interrupted_hold`** — the executor was interrupted mid-publish (crash/timeout) with a
  write-ahead intent persisted. The entry is quarantined for crash-safe replay rather than risking a
  double-post. **Operator action:** inspect it and explicitly release it once you confirm whether the
  publish actually happened at the backend.
- **`manual_review`** — retry exhaustion parked for human attention. Inspect and decide (fix + redraft
  or abandon).
- **`failed_handoff`** — the publisher handoff failed (outage class) and is **retrying** within the
  bound. If it keeps failing, the publisher is down (next section); on bound exhaustion it
  dead-letters.
- **`dead_lettered`** — gave up after the retry bound. No automatic redraft; redraft is an operator
  choice.
- **`skipped_on_overlap`** — a run was skipped because the single-runner lock was held by another run.
  Normal under concurrency; not an error.

## Publisher down

**Symptom:** approvals are retained but nothing reaches `published`; `failed_handoff` entries
accumulate; escalation notices after repeated failures.

The queue is authoritative, so nothing is lost. The executor distinguishes **outage** (timeouts, 5xx,
unreachable → bounded retry with backoff) from **auth failure** (401/403 → permanent, halt + alert,
never the retry path). Misclassifying auth as outage is the recorded crash-loop failure mode.

- **Check:** is it an outage or an auth rejection? `engine status` and the digest distinguish them.
- **Fix:** bring the publisher back (outage) or fix the credential and restart (auth). Approved-
  unpublished items persist and resume.

## Trigger didn't fire

**Symptom:** no content produced today; the heartbeat posts a "no content produced" or
"trigger-missed" alert.

- **Check:** `engine status` → last run per named trigger. A trigger with no recent run did not fire.
- **Fix:** confirm the scheduler recipe is installed and running (Task Scheduler / cron / PM2), that
  it sets `CONTENT_HOME`, and that the project is not `paused`. Reinstall from `templates/scheduler/`
  if needed. See [`setup/platforms.md`](setup/platforms.md#scheduler-triggers).
- Remember: **no task record, no run.** A run requires a dispatched slot-run task record in
  `$CONTENT_HOME/ledger/tasks/` that the host runtime then consumes. If task records are being written
  but never consumed, the problem is the host-runtime hook — see
  [`runtimes/generic.md`](runtimes/generic.md).

## Budget stop / PAUSED

**Symptom:** dispatch refuses with `EPAUSED` or `EBUDGET`; `engine status` shows `paused`.

- **`EPAUSED`** — the `PAUSED` sentinel is set (the kill switch). `engine pause` set it; `engine
  resume` clears it. Every autonomous loop checks the sentinel first.
- **`EBUDGET`** — the engine-metered spend cap was breached: the project paused, engine-metered
  actions halted, and no new task records are dispatched (stopping dispatch stops new chain spend
  too). Review spend against caps, raise the cap or wait for the window, then `engine resume`.

A refused-by-design dispatch is the system behaving correctly — it exits 0, not as an error.

## Fixture-run failures

**Symptom:** `engine fixture-run` fails on a fresh clone.

`fixture-run` is the zero-key end-to-end proof and runs with **no credentials and no CONTENT_HOME**.
A failure here means the deterministic spine or a shipped schema/fixture is broken in your checkout,
not a configuration problem.

- **Check:** did `npm ci` complete? Are you on a clean clone? Read the named failing stage in the
  output.
- **Fix:** re-clone / re-`npm ci`; if it still fails on a clean clone, it is a bug to report (CI runs
  this on every push, so a clean clone should pass).

## Per-checkpoint verifier failures

**Symptom:** `engine verify --setup c<n>` halts with a named failed step.

Each verifier returns a structured result with a named failed check and its remediation; it never
throws for a normal failure. Read the failed check's remediation line and fix exactly that — setup is
resumable, so re-run the same `verify` after the fix and it resumes from the first incomplete
checkpoint. The full checkpoint walk is in [`setup/full-setup.md`](setup/full-setup.md).

## See also

- [`../rules/codes.md`](../rules/codes.md) — every code, its meaning, and its route seat.
- [`architecture.md`](architecture.md) — what each state means and the durability promises.
- [`observability.md`](observability.md) — reading `engine status` and the alerts.
