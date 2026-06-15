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

## Optional: the trend pass (config-gated, OFF by default)

If you enable the trend pathway (`trends.enabled: true` + a `trends.adapter` +
`trends.cadence` in `config/system.json`; release-spec §8.8), add a SECOND job that
runs `engine poll-trends` on the SAME interval as your cadence. It dispatches trend
seeds into RESERVED `trend` calendar slots (DD-16 — never out-of-calendar; nothing
auto-publishes) and posts an angles-only readout to the `trend-readout` channel.

```json
{
  "id": "content-engine-trend-poll",
  "schedule": "0 */4 * * *",
  "command": "node <ENGINE_DIR>/bin/engine.js poll-trends",
  "env": {
    "CONTENT_HOME": "<CONTENT_HOME>"
  },
  "description": "Open Content Engine trend pass — 4h cadence (release-spec section 8.8). OFF unless trends.enabled."
}
```

The daily **work-recap** option (release-spec §3.3) needs NO extra job — the daily
`engine kickoff` fills it when `work_recap.enabled: true`.

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
