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

## Optional: the trend pass (config-gated, OFF by default)

The trend pathway (release-spec §8.8) polls a configured provider on a cadence and
fills RESERVED `trend` calendar slots with seeds that run the SAME chain to a human
approval card (DD-16 — never out-of-calendar; nothing auto-publishes). It ships
**disabled**. To use it:

1. Set `trends.enabled: true`, a `trends.adapter` (e.g. `reference` for a BYO provider,
   or `fixture` for a zero-key smoke test), and a `trends.cadence` of `2h` / `4h` /
   `8h` / `12h` in `config/system.json`.
2. Reserve one or more `slot_type: trend` slots in your calendar (the seeds fill these).
3. Optionally bind a `trend-readout` channel under
   `approval_surface.channels` to receive the angles-only readout.
4. Schedule **`engine poll-trends`** on the SAME interval as your cadence. Example
   crontab line for a 4h cadence (set `CONTENT_HOME` as in the recipes):

   ```
   0 */4 * * *  CONTENT_HOME=<CONTENT_HOME> <NODE_BIN> <ENGINE_DIR>/bin/engine.js poll-trends
   ```

   The pass runs under the same single-runner lock as the kickoff (overlaps skip
   safely) and honors PAUSED + budget caps. Run it by hand once with `--dry-run`
   first. Scraping is BYO (RD-9) — the engine bundles no provider credentials.

## Optional: the daily work-recap option (config-gated, OFF by default)

The work-recap / build-in-public pathway (release-spec §3.3) is the daily option the
kickoff fills: it scans a CONFIGURED, SENSITIVE memory path, runs a privacy pre-pass,
and dispatches one build-in-public seed per operator account into a RESERVED
`work_recap` calendar slot (the seed runs the same chain — including a privacy/leak
check — to a human approval card; nothing auto-publishes). It ships **disabled** and
needs **no extra scheduler entry** — the daily `engine kickoff` runs it. To use it:

1. Set `work_recap.enabled: true` and a `work_recap.memory_path` (plus optional
   `private_terms`, `lookback_days`, and per-account `accounts[]`) in
   `config/system.json`.
2. Reserve a `slot_type: work_recap` slot in your calendar for each operator account's
   brand (`account_class: operator`).
3. The next daily `engine kickoff` fills it. Privacy is load-bearing: the repo ships
   the MECHANISM pointed at your configured path; it never bundles or commits memory.

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
