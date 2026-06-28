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

## Optional: the intra-day tick (`engine tick`)

The daily kickoff is **date-granular** — it dispatches the whole day's eligible slots when it runs.
The optional calendar **tick** adds **clock-time precision**: it dispatches each slot near its actual
`time` instead of all at the morning run. It is **OFF by default**. To use it:

1. Set `scheduler.tick_enabled: true` in `config/system.json` (optionally tune
   `scheduler.lookahead_minutes` (default 120), `min_gap_minutes` (default 30), and
   `utc_offset_minutes` (default 0, i.e. calendar times read as UTC)).
2. Schedule **`engine tick`** on a sub-daily cadence — every 15–30 min is typical. Example crontab
   line (set `CONTENT_HOME` as in the recipes):

   ```
   */15 * * * *  CONTENT_HOME=<CONTENT_HOME> <NODE_BIN> <ENGINE_DIR>/bin/engine.js tick >> <CONTENT_HOME>/logs/tick.cron.log 2>&1
   ```

`engine tick` runs under the **same single-runner lock** as the kickoff + executor (overlaps skip
safely) and **shares the kickoff's dedup state**, so a slot dispatched today by *either* trigger is
never re-dispatched. Run it by hand once with `--dry-run` (or `--force` while still off) to see what
it would fire. Until you enable it, **the daily kickoff is the only trigger you need.**

## Optional: the trend pass (config-gated, OFF by default)

The trend pathway (release-spec §8.8) polls a configured provider on a cadence and
fills RESERVED `trend` calendar slots with seeds that run the SAME chain to a human
approval card (DD-16 — never out-of-calendar; nothing auto-publishes). It ships
**disabled**. To use it:

1. Set `trends.enabled: true`, a `trends.adapter` (e.g. `apify` for the BYO Apify
   tracking pull, `reference` for a generic BYO provider, or `fixture` for a zero-key
   smoke test), and a `trends.cadence` of `1h` / `2h` / `4h` / `8h` / `12h` / `24h` in
   `config/system.json` — **`1h`/`2h` for hourly tracking, `24h` for a daily pass.**
   For the `apify` adapter, add the operator-CONFIRMED `trends.tracked_accounts` +
   `trends.keywords` (see [`docs/trends.md`](../../docs/trends.md); suggest them free
   with `engine suggest prompt tracked_accounts` / `keywords`).
2. Reserve one or more `slot_type: trend` slots in your calendar (the seeds fill these).
3. Optionally bind a `trend-readout` channel under
   `approval_surface.channels` to receive the angles-only readout.
4. Schedule **`engine poll-trends`** on the SAME interval as your cadence. Examples
   (set `CONTENT_HOME` as in the recipes):

   ```
   0 * * * *    CONTENT_HOME=<CONTENT_HOME> <NODE_BIN> <ENGINE_DIR>/bin/engine.js poll-trends   # hourly (1h)
   0 */4 * * *  CONTENT_HOME=<CONTENT_HOME> <NODE_BIN> <ENGINE_DIR>/bin/engine.js poll-trends   # every 4h
   0 9 * * *    CONTENT_HOME=<CONTENT_HOME> <NODE_BIN> <ENGINE_DIR>/bin/engine.js poll-trends   # daily (24h) at 09:00
   ```

   The pass runs under the same single-runner lock as the kickoff (overlaps skip
   safely) and honors PAUSED + budget caps. Run it by hand once with `--dry-run`
   first. Scraping is BYO (RD-9) — the engine bundles no provider credentials.

## Optional: the monthly competitor scan (config-gated, OFF by default)

The competitor-scan pathway (roadmap #5) ingests competitor content on a monthly or quarterly
cadence, runs a DETERMINISTIC landscape analysis, and writes a PATTERNS-ONLY Zone-U scan report.
When `voice_calibration.enabled` is also true, it derives a structured voice-calibration proposal
over the four voice axes (`drama_dial`, `archetype_emphasis`, `hook_preferences`,
`cadence_preferences`). It ships **disabled** (both `competitor_scan.enabled` and
`voice_calibration.enabled` must be explicitly `true`). To use it:

1. Set `competitor_scan.enabled: true`, a `competitor_scan.adapter` (or `"fixture"` for zero-key),
   and optionally `competitor_scan.voice_calibration.enabled: true` in `config/system.json`.
2. Schedule **`engine competitor-scan --brand <id> --yes`** on a monthly or quarterly cadence
   (the `--yes` flag confirms the DD-18 metered-scrape gate). Example crontab line for the 1st
   of each month at 07:00 (set `CONTENT_HOME` as in the recipes):

   ```
   0 7 1 * *  CONTENT_HOME=<CONTENT_HOME> <NODE_BIN> <ENGINE_DIR>/bin/engine.js competitor-scan --brand <id> --yes
   ```

   The scan runs under the single-runner lock (overlapping fires skip safely) and honors PAUSED +
   budget caps. Run it by hand once with `--dry-run` first. Scraping is BYO (RD-9).

3. After each scan, review the proposal with `engine voice-calibrate --show` and apply with
   **`engine voice-calibrate --apply --consent`** (explicit `--consent` is required — HUMAN-ONLY
   path; the machine stops at the proposal and never auto-applies). See
   [`docs/voice-calibration.md`](../../docs/voice-calibration.md) for the full walkthrough.

## Optional: the monthly breakout-discovery reminder (free, manual Grok)

The monthly **breakout discovery** — find NEW competitors and breakout keyword trends — is the
FREE manual-Grok path (no API spend): you run a prompt on your own Grok/X account and paste the
result back (`engine suggest`, see [`../grok-prompts/README.md`](../grok-prompts/README.md)). It is
a HUMAN task, so there is nothing to auto-run — but you can schedule a monthly REMINDER that prints
the ready-to-use prompt to your log (or a channel) so it never slips:

```
0 8 1 * *  CONTENT_HOME=<CONTENT_HOME> <NODE_BIN> <ENGINE_DIR>/bin/engine.js suggest prompt breakout >> <CONTENT_HOME>/logs/breakout-reminder.log 2>&1
```

When it fires, copy the printed prompt into Grok, then `engine suggest apply --file <reply> --brand
<id> --yes` to APPEND the confirmed new competitors (→ `ingestion.competitors`) and breakout
keywords (→ `trends.keywords`). Nothing is added without your confirm. `engine suggest` is read-only
and never spends, so this reminder is always safe to schedule.

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

Each recipe ships the **daily kickoff** plus COMMENTED/optional entries for the **trend poll**
(hourly/daily) and the **monthly** triggers (competitor scan + the breakout-discovery reminder) —
uncomment the ones you enable in `config/system.json`:

- `cron.example`            — Unix/Linux/macOS crontab lines.
- `systemd.example`         — systemd service + timer units (Linux).
- `windows-task-scheduler.example.xml` — Windows Task Scheduler task definitions.
- `pm2.example.json`        — PM2 ecosystem file with cron restarts.
- `openclaw.example.md`     — OpenClaw scheduled-job examples (one supported host runtime).

Verify your recipe by running the command by hand FIRST (with `CONTENT_HOME` set):

```
engine kickoff --now
```

It should report the day's dispatch summary and exit 0.
