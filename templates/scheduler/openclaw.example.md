# Scheduler recipe — OpenClaw (host-runtime example)

This is a worked example for ONE supported host runtime. Other runtimes use their own
job/cron mechanism; the contract is the same as the runtime-neutral recipes (see
`README.md`): set `CONTENT_HOME`, then run `engine kickoff` once daily.

OpenClaw schedules recurring work with cron-style jobs. Define a daily job that invokes
the kickoff command. Two things must be true:

1. **`CONTENT_HOME` is set in the job's environment** (the §4.1 placement rule). Set it
   on the job/command, not in `$CONTENT_HOME/.env`.
2. **The command is `engine kickoff`** (drop `--now` for the scheduled trigger).

## Example job definition

```json
{
  "id": "content-engine-kickoff",
  "schedule": "30 8 * * *",
  "command": "node <ENGINE_DIR>/bin/engine.js kickoff",
  "env": {
    "CONTENT_HOME": "<CONTENT_HOME>"
  },
  "description": "Open Content Engine daily kickoff (release-spec section 8.4)."
}
```

Replace `<ENGINE_DIR>` (this checkout) and `<CONTENT_HOME>` (your instance directory),
and adjust the cron `schedule` to your preferred local run time.

## Optional: the intra-day tick (config-gated, OFF by default)

The daily kickoff is date-granular. The **tick** (`engine tick`) adds clock-time precision — enable
`scheduler.tick_enabled: true` and add a job on a sub-daily cadence (e.g. every 15 min). It shares
the kickoff's dedup state + single-runner lock, so a slot is never dispatched twice.

```json
{
  "id": "content-engine-tick",
  "schedule": "*/15 * * * *",
  "command": "node <ENGINE_DIR>/bin/engine.js tick",
  "env": {
    "CONTENT_HOME": "<CONTENT_HOME>"
  },
  "description": "Open Content Engine intra-day calendar tick (release-spec §8.4). OFF unless scheduler.tick_enabled."
}
```

## Optional: the trend pass (config-gated, OFF by default)

If you enable the trend pathway (`trends.enabled: true` + a `trends.adapter` +
`trends.cadence` in `config/system.json`; release-spec §8.8), add a SECOND job that
runs `engine poll-trends` on the SAME interval as your cadence — `0 * * * *` for hourly
(`1h`), `0 */4 * * *` for 4h, `0 9 * * *` for a daily (`24h`) pass. It dispatches trend
seeds into RESERVED `trend` calendar slots (DD-16 — never out-of-calendar; nothing
auto-publishes) and posts an angles-only readout to the `trend-readout` channel. For the
`apify` adapter, set the operator-confirmed `trends.tracked_accounts` + `trends.keywords`
(suggest them free with `engine suggest prompt tracked_accounts` / `keywords`).

```json
{
  "id": "content-engine-trend-poll",
  "schedule": "0 * * * *",
  "command": "node <ENGINE_DIR>/bin/engine.js poll-trends",
  "env": {
    "CONTENT_HOME": "<CONTENT_HOME>"
  },
  "description": "Open Content Engine trend pass — hourly (1h) cadence; use 0 */4 * * * for 4h or 0 9 * * * for a daily 24h pass (release-spec section 8.8). OFF unless trends.enabled."
}
```

The daily **work-recap** option (release-spec §3.3) needs NO extra job — the daily
`engine kickoff` fills it when `work_recap.enabled: true`.

## Optional: the monthly competitor scan (config-gated, OFF by default)

The competitor-scan pathway (roadmap #5) scrapes or loads competitor content on a monthly or
quarterly cadence, runs the deterministic landscape analyzer, and writes a patterns-only Zone-U
scan report. When `voice_calibration.enabled` is also true, it derives a structured proposal over
the four voice axes (drama_dial, archetype_emphasis, hook_preferences, cadence_preferences).
It ships **disabled**. To use it:

1. Set `competitor_scan.enabled: true`, a `competitor_scan.adapter` (e.g. `fixture` for a
   zero-key smoke test, or a BYO adapter you register), and optionally
   `competitor_scan.voice_calibration.enabled: true` in `config/system.json`.
2. Add a MONTHLY job (one per brand, with `--yes` to confirm the DD-18 scrape gate):

```json
{
  "id": "content-engine-competitor-scan",
  "schedule": "0 7 1 * *",
  "command": "node <ENGINE_DIR>/bin/engine.js competitor-scan --brand <brand-id> --yes",
  "env": {
    "CONTENT_HOME": "<CONTENT_HOME>"
  },
  "description": "Open Content Engine monthly competitor scan (roadmap #5). OFF unless competitor_scan.enabled."
}
```

After each scan, review the pending proposal with `engine voice-calibrate --show` and apply
with explicit `engine voice-calibrate --apply --consent` when you are ready. **Voice
calibration is HUMAN-ONLY — the machine writes a proposal and stops; the operator consents
and applies.** The scan is idempotent per (brand, calendar month): a second fire in the same
month is skipped safely.

## Optional: the monthly breakout-discovery reminder (free, manual Grok)

Breakout discovery (new competitors + breakout keyword trends) is the FREE manual-Grok path
(no API spend) — a HUMAN task, so there is nothing to auto-run. Schedule a monthly job that
PRINTS the ready-to-use prompt (e.g. into a reminder channel via your host's command output
routing) so the manual step never slips. `engine suggest prompt breakout` is read-only and
never spends.

```json
{
  "id": "content-engine-breakout-reminder",
  "schedule": "0 8 1 * *",
  "command": "node <ENGINE_DIR>/bin/engine.js suggest prompt breakout",
  "env": {
    "CONTENT_HOME": "<CONTENT_HOME>"
  },
  "description": "Monthly reminder: prints the free manual-Grok breakout-discovery prompt. Paste the result into engine suggest apply --brand <id> --yes to APPEND confirmed competitors/keywords."
}
```

(In OpenClaw you can route this job's output to a DM or a data-ingest channel so the prompt
lands where you'll see it; the engine owns no channel — that wiring is the host's.)

## Notes

- The mode (SAFE / LIVE_PREVIEW / LIVE) is read from `config/system.json`, never from
  the job — keep posture in config.
- The kickoff is idempotent under a single-runner lock; overlapping fires are safe.
- The trend pass shares the kickoff's single-runner lock and PAUSED/budget preflight;
  it is also idempotent (a reserved trend slot filled today is not refilled).
- Validate by running the command once by hand with `CONTENT_HOME` set; it should print
  the dispatch summary and exit 0 before you rely on the schedule.
- If your OpenClaw build exposes a different job schema (field names/format), keep the
  same two requirements — env `CONTENT_HOME` plus the `engine kickoff` command — and map
  them onto that schema.
