'use strict';

/**
 * engine/cli/dispatch.js  [N net-new]
 *
 * `engine dispatch` — write ONE pending slot-run task record from an ad-hoc command (release-spec
 * §8.4 run mechanics; RD-18 task-record transport; DD-19 named-trigger discipline). The low-level
 * counterpart to `run-slot`/`kickoff`: where those resolve calendar slots, `dispatch` takes the
 * command fields directly, so an operator (or test) can hand the host runtime a run for a brand /
 * platform / format without a calendar entry — fail-closed on an unknown command_family (§6.1).
 *
 * THIN wiring over engine/orchestrator/dispatch.dispatchTask (already on disk): it builds a §6.1
 * command from the flags, resolves the run mode through the ONE ladder (mode.js, SAFE default),
 * and dispatches. dispatchTask's own preflight honors the PAUSED sentinel + the spend-cap hook
 * (§15.4) — a paused/over-budget project dispatches nothing; this handler surfaces that as a clear
 * EPAUSED/EBUDGET reason, not a silent no-op.
 *
 * Idempotent: re-dispatching the same logical task_id while it is still pending/claimed returns
 * the existing record (no double run — the dispatch-discipline guard). Use --force to re-dispatch
 * a finished task.
 *
 * Tier-3 cleanliness (§0.3 r6): no hardcoded IDs/paths/codenames.
 */

const dispatchMod = require('../orchestrator/dispatch');
const util = require('./util');

const HELP = `engine dispatch [--family RUN_SLOT|RUN_BATCH|RUN_CAMPAIGN|RUN_TREND_MANUAL] [options]

Write ONE pending slot-run task record from an ad-hoc command (§8.4 / RD-18). The host runtime
consumes it through its documented hook (docs/runtimes/<runtime>.md); the engine never calls a
chain-seat LLM (RD-2). Honors the PAUSED kill switch + budget caps before writing anything (§15.4).

  --family <F>     command_family: RUN_SLOT | RUN_BATCH | RUN_CAMPAIGN | RUN_TREND_MANUAL.
  --slot <id>      slot id for the run.
  --brand <id>     brand id.
  --platform <id>  platform descriptor id.
  --format <f>     content format.
  --content-id <id>  explicit content id (else derived).
  --date <YYYY-MM-DD>  run date (default today).
  --campaign <id>  campaign id (for RUN_CAMPAIGN).
  --mode <M>       SAFE | LIVE_PREVIEW | LIVE override (default config/SAFE — §8.3/RD-16f).
  --trigger <t>    named trigger (default run-slot; DD-19).
  --force          re-dispatch even a finished task with the same id.
  --json           emit the structured result.
  -h, --help       show this help.`;

/**
 * @param {object} ctx  { flags, positionals, env, config }
 * @returns {{ ok, summary, detail?, data?, exitCode? }}
 */
function run(ctx = {}) {
  const flags = ctx.flags || {};
  if (util.flagOn(flags.help)) return { ok: true, summary: HELP.split('\n')[0], detail: HELP };

  const env = ctx.env || process.env;
  const config = ctx.config || util.loadSystemConfig(env);

  const command = {
    command_family: typeof flags.family === 'string' ? flags.family : undefined,
    slot_id: typeof flags.slot === 'string' ? flags.slot : null,
    content_id: typeof flags['content-id'] === 'string' ? flags['content-id'] : null,
    brand: typeof flags.brand === 'string' ? flags.brand : null,
    platform: typeof flags.platform === 'string' ? flags.platform : null,
    format: typeof flags.format === 'string' ? flags.format : null,
    date: typeof flags.date === 'string' ? flags.date : null,
    campaign_id: typeof flags.campaign === 'string' ? flags.campaign : null,
    mode: typeof flags.mode === 'string' ? flags.mode : undefined,
  };

  const trigger = typeof flags.trigger === 'string' ? flags.trigger : dispatchMod.TRIGGER.RUN_SLOT;

  const res = dispatchMod.dispatchTask(command, trigger, {
    env,
    config,
    dispatcher: 'cli',
    force: util.flagOn(flags.force),
  });

  if (!res.ok) {
    return {
      ok: false,
      exitCode: res.code === 'EPAUSED' || res.code === 'EBUDGET' ? 0 : 1,
      summary: `dispatch refused (${res.code})`,
      detail: res.reason,
      data: res,
    };
  }

  return {
    ok: true,
    summary: `${res.existed ? 'task already pending' : 'dispatched'} ${res.task.task_id} (trigger ${res.task.trigger}, mode ${res.task.mode})`,
    detail: [
      `task_id: ${res.task.task_id}`,
      `state: ${res.task.state}`,
      res.existed ? 'idempotent: an in-flight task with this id already exists (no double run).' : 'the host runtime will pick this up via its run-dispatch hook (docs/runtimes/<runtime>.md).',
    ],
    data: res,
  };
}

module.exports = { run, HELP };
