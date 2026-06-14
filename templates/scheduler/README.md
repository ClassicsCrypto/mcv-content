# Scheduler recipes

These recipes install the engine's CANONICAL daily trigger — `engine kickoff` — on a
scheduler so the day's eligible calendar slots are dispatched automatically
(release-spec §8.4, RD-14). They are RUNTIME-NEUTRAL: any scheduler that can run a
command on a daily schedule works. Pick the one that matches your platform.

## What the recipe must do (the contract)

Every recipe runs ONE command, once per day, with TWO requirements:

1. **Set `CONTENT_HOME`** in the process environment before the command runs. This is
   the §4.1 placement rule: `CONTENT_HOME` cannot live in `$CONTENT_HOME/.env` (it is
   what locates that file), so the scheduler entry is one of the few correct places to
   set it. Every recipe below sets it explicitly.
2. **Run `engine kickoff`** (optionally `--now`). The batch is idempotent and runs under
   a single-runner lock, so an accidental double-fire is safe — the second run skips.

Safety posture is NOT set in the scheduler. The run mode comes from
`config/system.json` `mode` (default SAFE). Do not encode LIVE in a scheduler wrapper.

## Placeholders

Replace these in every recipe:

- `$CONTENT_HOME` / `<CONTENT_HOME>` — absolute path to your instance directory.
- `<ENGINE_DIR>` — absolute path to this checkout (where `bin/engine.js` lives).
- `<NODE_BIN>` — absolute path to your `node` binary (or just `node` if on PATH).
- `HH:MM` — the daily run time, in the scheduler host's local time.

## Optional: the intra-day tick

The optional calendar TICK (intra-day precision) is OFF by default. To use it, set
`scheduler.tick_enabled: true` in `config/system.json` and schedule
`engine kickoff` (or the tick verb, if your build exposes it) more often than daily.
The kickoff and tick share dedup state, so a slot dispatched by either is not
re-dispatched. Until you enable it, the daily kickoff is the only trigger you need.

## Recipes in this directory

- `cron.example`            — Unix/Linux/macOS crontab line.
- `systemd.example`         — systemd service + timer (Linux).
- `windows-task-scheduler.example.xml` — Windows Task Scheduler task definition.
- `pm2.example.json`        — PM2 ecosystem file with a cron restart.
- `openclaw.example.md`     — OpenClaw scheduled-job example (one supported host runtime).

Verify your recipe by running the command by hand FIRST (with `CONTENT_HOME` set):

```
engine kickoff --now
```

It should report the day's dispatch summary and exit 0.
