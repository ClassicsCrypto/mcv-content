'use strict';

/**
 * engine/cli/poll-trends.js  [N net-new]
 *
 * `engine poll-trends` — the config-gated TREND PASS trigger (release-spec §8.8 trend pathway;
 * §6.7 trend report; DD-16 reserved-slot fill + freshness/TTL; RD-14 kickoff-canonical; RD-9 BYO;
 * RD-12 zero-key seams). The scheduler recipe (templates/scheduler/) installs this on a 2/4/8/12h
 * cadence; it polls the configured adapter, posts an angles-only readout to the trend-readout
 * channel, and dispatches one pending slot-run task record per fresh report into a RESERVED `trend`
 * calendar slot (DD-16: never out-of-calendar). The host runtime then runs the SAME chain to a
 * human approval card (§2.4) — NOTHING here auto-publishes; SAFE is the default mode.
 *
 * OFF BY DEFAULT (the LAW): refuses with a clear "disabled" notice unless config.trends.enabled is
 * true (and trends.adapter is set). --force runs it against an explicit operator/test opt-in.
 *
 * THIN wiring over engine/orchestrator/poll-trends.runTrendPass (already on disk): the pass runs
 * UNDER the single-runner lock (DD-19 — overlap is skip-and-logged), and each dispatch honors the
 * PAUSED sentinel + budget preflight (§15.4). Mode resolves through the ONE ladder (mode.js, SAFE
 * default — §8.3 / RD-16f). The trend-readout post mechanism is the host's (the engine ships
 * credential-free — RD-12/§4.4); from the CLI the readout text is surfaced in the output.
 *
 * Tier-3 cleanliness (§0.3 r6): the calendar + trend reports live under $CONTENT_HOME via paths.js;
 * the trend-readout channel id + provider config come from config; no hardcoded ids/paths/codenames.
 */

const pollTrendsMod = require('../orchestrator/poll-trends');
const util = require('./util');

const HELP = `engine poll-trends [options]

Run one config-gated trend pass (§8.8 / DD-16): poll the configured adapter, post an angles-only
readout to the trend-readout channel, and dispatch one slot-run task record per fresh report into a
RESERVED \`trend\` calendar slot (never out-of-calendar). The host runtime runs the chain to a human
approval card (§2.4). OFF BY DEFAULT — set config trends.enabled=true + trends.adapter first.

  --brand <id>     brand the reports/reserved trend slots are for (scopes the pass).
  --adapter <name> adapter override (apify | reference | fixture | operator's; else config trends.adapter).
  --cadence <c>    1h | 2h | 4h | 8h | 12h | 24h override (else config trends.cadence; the report freshness basis).
  --content-form <f>  standalone | quote-retweet (DD-16; default standalone).
  --mode <M>       SAFE | LIVE_PREVIEW | LIVE override (default config/SAFE — §8.3/RD-16f).
  --force          run even when trends.enabled is false (explicit operator opt-in).
  --dry-run        poll + build readout + select, write/dispatch nothing.
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

  let result;
  try {
    result = await pollTrendsMod.runTrendPass({
      env,
      config,
      brand: typeof flags.brand === 'string' ? flags.brand : undefined,
      adapter: typeof flags.adapter === 'string' ? flags.adapter : undefined,
      cadence: typeof flags.cadence === 'string' ? flags.cadence : undefined,
      content_form: typeof flags['content-form'] === 'string' ? flags['content-form'] : undefined,
      mode: flags.mode,
      force: util.flagOn(flags.force),
      dryRun: util.flagOn(flags['dry-run']),
    });
  } catch (err) {
    return { ok: false, exitCode: 1, summary: 'trend pass failed', detail: util.describeError(err) };
  }

  // OFF BY DEFAULT: a disabled pathway is the system behaving correctly — report it, exit 0.
  if (result.ran === false && result.disabled) {
    return { ok: true, summary: 'trend pathway is OFF by default (config trends.enabled is not true)', detail: result.reason, data: result };
  }
  // Overlap skip: another run holds the single-runner lock (DD-19) — honest skip, not a failure.
  if (result.ran === false) {
    if (result.skipped_on_overlap) {
      return { ok: true, summary: 'trend pass skipped — another run holds the single-runner lock (skipped_on_overlap, DD-19)', data: result };
    }
    return { ok: false, exitCode: 1, summary: 'trend pass did not run', detail: result.error || 'unknown reason', data: result };
  }

  const halted = (result.errors || []).some((e) => ['EPAUSED', 'EBUDGET', 'ECONTENTHOME'].includes(e.code));
  return {
    ok: true,
    summary: `trend pass (${result.adapter}/${result.cadence}): ${result.reports} report(s), ${result.dispatched} dispatched, ${result.unslotted} unslotted, ${result.stale} stale, ${result.skipped} dedup-skipped, ${result.failed} failed (mode ${result.mode})${halted ? ' — HALTED (kill switch/budget)' : ''}`,
    detail: [
      modeVerdict.notice ? `mode: ${modeVerdict.mode} — ${modeVerdict.notice}` : null,
      result.verification ? `verify: ${result.verification.summary}` : null,
      ...(result.verification && result.verification.errors ? result.verification.errors.map((e) => `  ✗ verify: ${e}`) : []),
      ...(result.verification && result.verification.warnings ? result.verification.warnings.map((w) => `  ~ verify: ${w}`) : []),
      result.readout_post && result.readout_post.posted === false ? `trend-readout: ${result.readout_post.reason || 'not posted (host delivers it)'}` : null,
      '--- readout (angles only) ---',
      result.readout,
      '--- dispatched ---',
      ...(result.tasks || []).map((t) => `  + ${t.content_id} → slot ${t.slot_id} [${t.content_form || 'standalone'}]${t.task_id ? ` (${t.task_id})` : ''}${t.existed ? ' (already pending)' : ''}${t.dry_run ? ' (dry-run)' : ''}`),
      ...(result.errors || []).map((e) => `  ! ${e.slot_id || e.report || '?'}: ${e.code} ${e.reason}`),
    ].filter(Boolean),
    data: result,
  };
}

module.exports = { run, HELP };
