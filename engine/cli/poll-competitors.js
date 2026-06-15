'use strict';

/**
 * engine/cli/poll-competitors.js  [N net-new — roadmap #5 competitor scan CLI]
 *
 * `engine competitor-scan` — the config-gated MONTHLY COMPETITOR SCAN trigger (roadmap #5;
 * RD-9 BYO scraping; RD-12 zero-key seams; DD-18 estimate-and-confirm; §15.4 kill switch;
 * DD-19 named-trigger discipline).
 *
 * OFF BY DEFAULT (the LAW): refuses with a clear "disabled" notice unless
 * config.competitor_scan.enabled is true (and competitor_scan.adapter is set). --force runs
 * it against an explicit operator/test opt-in.
 *
 * THIN wiring over engine/orchestrator/competitor-scan.runCompetitorScan: the scan runs UNDER
 * the single-runner lock (DD-19 — overlap is skip-and-logged), and the dispatch honors the
 * PAUSED sentinel + budget preflight (§15.4). The scraper adapter is the host's (the engine
 * ships credential-free — RD-12/§4.4); from the CLI the scan result + report path are surfaced
 * in the output.
 *
 * Exit codes (bin/engine.js contract):
 *   0  success (also: disabled, paused, overlap-skipped, estimate-only — the system behaving correctly)
 *   1  genuine run failure (report or dispatch errored)
 *   2  bad arguments
 *
 * Note: the header previously claimed exit 3 for "configured-but-unregistered adapter". There is no
 * named-adapter registry in the competitor-scan orchestrator (the scraper adapter is always injected
 * by the caller, never looked up by name from a registry). The claim was removed to stay honest.
 *
 * Tier-3 cleanliness (§0.3 r6 / RD-3): constructs no instance paths (paths.js derives them via
 * the engine modules); no hardcoded ids/handles/roots/codenames; the only literals are public
 * flag names and the §4.5 governance vocabulary.
 */

const competitorScanMod = require('../orchestrator/competitor-scan');
const util = require('./util');

const HELP = `engine competitor-scan [options]

Run one config-gated monthly competitor scan (roadmap #5): scrape OR load from the on-disk
corpus, run the deterministic landscape analyzer, write a Zone-U scan report, dispatch ONE
reserved competitor_scan task record (informational — no post produced; P11/DD-16), and
optionally produce a voice-calibration proposal. OFF BY DEFAULT — set config
competitor_scan.enabled=true first.

  --brand <id>         brand the scan is for (scopes the corpus + scan dir).
  --adapter <name>     scraper adapter override (else config competitor_scan.adapter).
  --platform <p>       platform override (else config competitor_scan.provider.platform; default twitter).
  --estimate-only      compute and show the DD-18 cost estimate; do nothing else.
  --yes                confirm the DD-18 metered-scrape gate (required for scraper adapters).
  --force              run even when competitor_scan.enabled is false (operator/test opt-in).
  --dry-run            analyze + build report, write/dispatch nothing.
  --json               emit the structured result.
  -h, --help           show this help.`;

/**
 * @param {object} ctx  { flags, positionals, env, config }
 * @returns {Promise<{ ok, summary, detail?, data?, exitCode? }>}
 */
async function run(ctx = {}) {
  const flags = ctx.flags || {};
  if (util.flagOn(flags.help)) return { ok: true, summary: HELP.split('\n')[0], detail: HELP };

  const env = ctx.env || process.env;
  const config = ctx.config || util.loadSystemConfig(env);

  // Validate brand (required — exit 2 for bad args, before touching the orchestrator).
  const brand = typeof flags.brand === 'string' && flags.brand.trim() ? flags.brand.trim() : null;
  if (!brand) {
    return {
      ok: false,
      exitCode: 2,
      summary: 'bad args: --brand <id> is required for competitor-scan',
      detail: ['Usage: engine competitor-scan --brand <id> [options]', HELP],
    };
  }

  let result;
  try {
    result = await competitorScanMod.runCompetitorScan({
      env,
      config,
      brand,
      platform: typeof flags.platform === 'string' ? flags.platform : undefined,
      adapter: typeof flags.adapter === 'string' ? flags.adapter : undefined,
      force: util.flagOn(flags.force),
      dryRun: util.flagOn(flags['dry-run']),
      estimateOnly: util.flagOn(flags['estimate-only']),
      confirmed: util.flagOn(flags.yes),
    });
  } catch (err) {
    if (err && err.code === 'EVERBATIMCOPY') {
      return {
        ok: false,
        exitCode: 1,
        summary: 'competitor scan refused: verbatim competitor text detected in output (P1)',
        detail: err.message,
      };
    }
    return { ok: false, exitCode: 1, summary: 'competitor scan failed', detail: util.describeError(err) };
  }

  // OFF BY DEFAULT: a disabled pathway is the system behaving correctly — report it, exit 0.
  if (result.ran === false && result.disabled) {
    return {
      ok: true,
      summary: 'competitor scan is OFF by default (config competitor_scan.enabled is not true)',
      detail: result.reason,
      data: result,
    };
  }

  // Estimate-only: surfaced honestly, exit 0.
  if (result.estimate_only) {
    return {
      ok: true,
      summary: `competitor scan estimate: ~${result.estimate && result.estimate.estimated_items} items ≈ $${result.estimate && result.estimate.total_usd_estimate} (indicative, DD-18). Re-run with --yes to confirm.`,
      detail: result.estimate ? JSON.stringify(result.estimate, null, 2).split('\n') : [],
      data: result,
    };
  }

  // Needs DD-18 confirmation.
  if (result.needs_confirmation) {
    return {
      ok: true,
      summary: 'competitor scan not confirmed (DD-18 estimate-and-confirm): re-run with --yes to proceed with metered scrape.',
      detail: result.reason,
      data: result,
    };
  }

  // Overlap skip / halted / cold-start (all: system behaving correctly => exit 0).
  if (result.ran === false) {
    if (result.skipped_on_overlap) {
      return {
        ok: true,
        summary: 'competitor scan skipped — another run holds the single-runner lock (skipped_on_overlap, DD-19)',
        data: result,
      };
    }
    if (result.cold_start) {
      return {
        ok: true,
        summary: `competitor scan: cold start for brand ${result.brand || '?'} — no corpus and no scraper adapter. Ingest a corpus first (DD-21).`,
        detail: result.reason,
        data: result,
      };
    }
    // halted: PAUSED kill switch or budget preflight refused the run before it could proceed —
    // this is the system behaving correctly (§15.4), not an error. Exit 0.
    if (result.halted) {
      return {
        ok: true,
        summary: `competitor scan halted (kill switch / budget) for brand ${result.brand || '?'} — nothing ran (§15.4)`,
        detail: result.reason || result.error || null,
        data: result,
      };
    }
    return { ok: false, exitCode: 1, summary: 'competitor scan did not run', detail: result.error || 'unknown reason', data: result };
  }

  // Halted by kill switch or budget.
  const halted = result.halted || (Array.isArray(result.errors) && result.errors.some((e) => ['EPAUSED', 'EBUDGET', 'ECONTENTHOME'].includes(e.code)));

  return {
    ok: true,
    summary: [
      `competitor scan (${result.brand}/${result.platform || 'twitter'}/${result.date}):`,
      `${result.corpus_item_count || 0} items (own:${result.own_count || 0} competitor:${result.competitor_count || 0}),`,
      `${result.dispatched || 0} dispatched`,
      result.dry_run ? '(dry-run)' : '',
      halted ? '— HALTED (kill switch/budget)' : '',
    ].filter(Boolean).join(' '),
    detail: [
      result.report_path ? `report written: ${result.report_path}` : null,
      result.task_id ? `task_id: ${result.task_id}${result.task_existed ? ' (existed)' : ''}` : null,
      result.voice_calibration_proposal && !result.voice_calibration_proposal.error
        ? `voice-calibration proposal: status=${result.voice_calibration_proposal.status || '?'}`
        : null,
      result.voice_calibration_proposal && result.voice_calibration_proposal.error
        ? `voice-calibration proposal error: ${result.voice_calibration_proposal.error}`
        : null,
      ...(Array.isArray(result.errors) && result.errors.length
        ? result.errors.map((e) => `  ! ${e.code}: ${e.reason}`)
        : []),
    ].filter(Boolean),
    data: result,
  };
}

module.exports = { run, HELP };
