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

## Notes

- The mode (SAFE / LIVE_PREVIEW / LIVE) is read from `config/system.json`, never from
  the job — keep posture in config.
- The kickoff is idempotent under a single-runner lock; overlapping fires are safe.
- Validate by running the command once by hand with `CONTENT_HOME` set; it should print
  the dispatch summary and exit 0 before you rely on the schedule.
- If your OpenClaw build exposes a different job schema (field names/format), keep the
  same two requirements — env `CONTENT_HOME` plus the `engine kickoff` command — and map
  them onto that schema.
