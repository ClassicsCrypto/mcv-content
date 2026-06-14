'use strict';

/**
 * engine/cli/kickoff.js  [N net-new]
 *
 * `engine kickoff [--now]` — the canonical daily batch trigger (release-spec §8.4 "the daily
 * kickoff batch is the canonical v1 trigger"; RD-14; DD-19 named-trigger discipline; RD-18
 * task-record transport). Selects the day's eligible calendar slots (campaign overlays applied,
 * bounded by --max, staggered) and dispatches one pending slot-run task record per slot. The
 * scheduler recipe (templates/scheduler/) installs this on a daily cron/Task-Scheduler/PM2 entry;
 * `--now` runs it on demand.
 *
 * THIN wiring over engine/orchestrator/kickoff.runKickoff (already on disk): the whole batch runs
 * UNDER the single-runner lock (DD-19 — an overlapping run is skip-and-logged as
 * skipped_on_overlap), and each dispatch honors the PAUSED sentinel + budget preflight (§15.4 — a
 * paused/over-budget project dispatches nothing; the batch halts the moment the kill switch is
 * seen). Mode resolves through the ONE ladder (mode.js, SAFE default — §8.3 / RD-16f).
 *
 * Tier-3 cleanliness (§0.3 r6): the calendar lives under $CONTENT_HOME via paths.js; no hardcoded
 * timezone/channel ids/codenames (timezone comes from config).
 */

const kickoffMod = require('../orchestrator/kickoff');
const dispatchMod = require('../orchestrator/dispatch');
const util = require('./util');

const HELP = `engine kickoff [--now] [options]

Run the canonical daily kickoff batch (§8.4 / RD-14): select the day's eligible calendar slots and
dispatch one pending slot-run task record per slot, under the single-runner lock (DD-19), honoring
PAUSED + budget caps (§15.4). The host runtime runs each dispatched task via its hook.

  --now            run the batch immediately (named trigger: kickoff--now).
  --date <YYYY-MM-DD>  the day to run for (default today, in the configured timezone).
  --max <n|all>    bound the dispatched slots (default config scheduler.daily_max or 4).
  --brand <id>     restrict to one brand (comma-separated for several).
  --slot <id>      restrict to explicit slot id(s) (bypasses day/state gating).
  --mode <M>       SAFE | LIVE_PREVIEW | LIVE override (default config/SAFE).
  --force          re-dispatch even already-fired (date,slot) pairs.
  --dry-run        select + report, write no records and no state.
  --json           emit the structured result.
  -h, --help       show this help.`;

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

  // The verb is invoked on-demand; --now picks the kickoff--now named trigger (DD-19), otherwise
  // the canonical morning-kickoff trigger (the scheduler recipe runs this same path on cron).
  const trigger = util.flagOn(flags.now) ? dispatchMod.TRIGGER.KICKOFF_NOW : dispatchMod.TRIGGER.MORNING_KICKOFF;

  let result;
  try {
    result = await kickoffMod.runKickoff({
      env,
      config,
      trigger,
      date: typeof flags.date === 'string' ? flags.date : undefined,
      max: flags.max,
      brand: typeof flags.brand === 'string' ? flags.brand : undefined,
      slot: typeof flags.slot === 'string' ? flags.slot : undefined,
      mode: flags.mode,
      force: util.flagOn(flags.force),
      dryRun: util.flagOn(flags['dry-run']),
    });
  } catch (err) {
    return { ok: false, exitCode: 1, summary: 'kickoff failed', detail: util.describeError(err) };
  }

  // Overlap skip: another run holds the single-runner lock (DD-19) — not a failure, an honest skip.
  if (result.ran === false) {
    if (result.skipped_on_overlap) {
      return {
        ok: true,
        summary: 'kickoff skipped — another run holds the single-runner lock (skipped_on_overlap, DD-19)',
        detail: result.heldBy ? [`held by: ${result.heldBy.owner || 'unknown'} (pid ${result.heldBy.pid})`] : undefined,
        data: result,
      };
    }
    return { ok: false, exitCode: 1, summary: `kickoff did not run`, detail: result.error || 'unknown reason', data: result };
  }

  const errLines = (result.errors || []).map((e) => `  ! ${e.slot_id}: ${e.code} ${e.reason}`);
  const halted = (result.errors || []).some((e) => ['EPAUSED', 'EBUDGET', 'ECONTENTHOME'].includes(e.code));

  return {
    ok: true,
    summary: `kickoff ${result.date}: ${result.dispatched} dispatched, ${result.skipped} skipped, ${result.failed} failed (mode ${result.mode}, ${result.eligible} eligible)${halted ? ' — HALTED (kill switch/budget)' : ''}`,
    detail: [
      modeVerdict.notice ? `mode: ${modeVerdict.mode} — ${modeVerdict.notice}` : null,
      `trigger: ${trigger}`,
      ...result.tasks.map((t) => `  + ${t.slot_id}${t.task_id ? ` → ${t.task_id}` : ''}${t.existed ? ' (already pending)' : ''}${t.dry_run ? ' (dry-run)' : ''}`),
      ...errLines,
    ].filter(Boolean),
    data: result,
  };
}

module.exports = { run, HELP };
