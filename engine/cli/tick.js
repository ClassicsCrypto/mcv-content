'use strict';

/**
 * engine/cli/tick.js  [N net-new]
 *
 * `engine tick` — the OPTIONAL, OFF-BY-DEFAULT intra-day calendar trigger (release-spec §8.4; RD-14).
 * The daily `engine kickoff` is the canonical trigger and is date-granular (it dispatches the whole
 * day's eligible slots when it runs). The tick adds CLOCK-PRECISE intra-day firing: an operator who
 * wants each slot dispatched near its actual `time` (rather than all at the morning run) enables
 * `scheduler.tick_enabled` and schedules `engine tick` on a sub-daily cadence (e.g. every 15–30m).
 *
 * THIN wiring over engine/orchestrator/scheduler.runTick (already on disk): it fires only slots due
 * within the look-ahead window (`scheduler.lookahead_minutes`, default 120), applies a per-brand
 * min-gap (`scheduler.min_gap_minutes`, default 30) + weekly dedup, runs UNDER the SAME single-runner
 * lock as kickoff + the executor (DD-19 — overlaps skip safely), and SHARES the kickoff dedup state
 * so a slot dispatched today by EITHER trigger is never re-dispatched (the double-dispatch guard).
 *
 * OFF BY DEFAULT (the LAW): without `scheduler.tick_enabled: true` it refuses with a clear notice and
 * exits 0 (the daily kickoff is all most operators need). `--force` runs it once regardless (an
 * explicit operator/test run). Mode resolves through the ONE ladder (mode.js, SAFE default — §8.3).
 *
 * Tier-3 cleanliness (§0.3 r6): calendar + dedup state under $CONTENT_HOME via paths.js; the
 * window/gap/timezone-offset come from config, no hardcoded values/ids/codenames.
 */

const scheduler = require('../orchestrator/scheduler');
const util = require('./util');

const HELP = `engine tick [options]

Run one optional intra-day calendar tick (§8.4 / RD-14): dispatch a pending slot-run task record for
each calendar slot whose clock time falls within the look-ahead window, under the single-runner lock
(DD-19), honoring PAUSED + budget caps (§15.4) and sharing the daily kickoff's dedup state so a slot
fired today by either trigger is never re-dispatched.

OFF BY DEFAULT — set \`scheduler.tick_enabled: true\` in config/system.json and schedule this on a
sub-daily cadence (e.g. every 15–30 min). The daily \`engine kickoff\` remains the canonical trigger;
the tick only adds clock-time precision on top of it.

  --force          run once even when scheduler.tick_enabled is false (explicit operator/test run).
  --mode <M>       SAFE | LIVE_PREVIEW | LIVE override (default config/SAFE — §8.3/RD-16f).
  --dry-run        select + report which slots are due; write no records and no state.
  --json           emit the structured result.
  -h, --help       show this help.

Tuning (config/system.json scheduler block): lookahead_minutes (default 120), min_gap_minutes
(default 30), utc_offset_minutes (default 0). The daily kickoff alone is sufficient until you enable
the tick.`;

/**
 * @param {object} ctx  { flags, positionals, env, config }
 * @returns {Promise<{ ok, summary, detail?, data?, exitCode? }>}
 */
async function run(ctx = {}) {
  const flags = ctx.flags || {};
  if (util.flagOn(flags.help)) return { ok: true, summary: HELP.split('\n')[0], detail: HELP };

  const env = ctx.env || process.env;
  const config = ctx.config || util.loadSystemConfig(env);
  const modeVerdict = util.resolveModeWithNotice({ override: flags.mode, config, env });

  let result;
  try {
    result = await scheduler.runTick({
      env,
      config,
      mode: flags.mode,
      force: util.flagOn(flags.force),
      dryRun: util.flagOn(flags['dry-run']),
    });
  } catch (err) {
    return { ok: false, exitCode: 1, summary: 'tick failed', detail: util.describeError(err) };
  }

  // OFF BY DEFAULT: a disabled tick is the system behaving correctly — report it, exit 0.
  if (result.ran === false && result.disabled) {
    return {
      ok: true,
      summary: 'calendar tick is OFF by default (scheduler.tick_enabled is not true)',
      detail: [
        result.reason,
        'Run `engine tick --force` for a one-off, or set scheduler.tick_enabled=true to enable the cadence.',
      ],
      data: result,
    };
  }
  // Overlap skip: another run holds the single-runner lock (DD-19) — honest skip, not a failure.
  if (result.ran === false) {
    if (result.skipped_on_overlap) {
      return {
        ok: true,
        summary: 'tick skipped — another run holds the single-runner lock (skipped_on_overlap, DD-19)',
        detail: result.heldBy ? [`held by: ${result.heldBy.owner || 'unknown'} (pid ${result.heldBy.pid})`] : undefined,
        data: result,
      };
    }
    return { ok: false, exitCode: 1, summary: 'tick did not run', detail: result.error || 'unknown reason', data: result };
  }

  const errLines = (result.errors || []).map((e) => `  ! ${e.slot_id}: ${e.code} ${e.reason}`);
  const halted = (result.errors || []).some((e) => ['EPAUSED', 'EBUDGET', 'ECONTENTHOME'].includes(e.code));

  return {
    ok: true,
    summary: `tick: ${result.due} due, ${result.dispatched} dispatched, ${result.skipped} skipped, ${result.failed} failed (mode ${result.mode})${halted ? ' — HALTED (kill switch/budget)' : ''}`,
    detail: [
      modeVerdict.notice ? `mode: ${modeVerdict.mode} — ${modeVerdict.notice}` : null,
      ...(result.tasks || []).map((t) => `  + ${t.slot_id}${t.task_id ? ` → ${t.task_id}` : ''}${t.existed ? ' (already pending)' : ''}${t.dry_run ? ' (dry-run)' : ''}`),
      ...errLines,
    ].filter(Boolean),
    data: result,
  };
}

module.exports = { run, HELP };
