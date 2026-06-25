'use strict';

/**
 * engine/orchestrator/poll-trends.js  [N net-new — the trend pathway's SCHEDULING + chain wiring]
 *
 * Wires the TREND SOURCE (engine/sources/trends) into the EXISTING chain on a config-gated polling
 * cadence (release-spec §8.8 trend pathway; §6.7 trend report; §2.1 seeding; DD-16 reserved-slot
 * fill + quote-retweet content_form + freshness/TTL; RD-14 kickoff-canonical; RD-9 BYO scraping;
 * RD-12 zero-key seams). One trend pass:
 *
 *   1. POLLS the configured adapter (source.pollTrends) — OFF BY DEFAULT; refuses with
 *      TrendsDisabledError until the operator sets `trends.enabled: true` in config/system.json.
 *      Polling writes the §6.7 Trend Reports under $CONTENT_HOME/trends/ (always Zone U).
 *   2. POSTS a trend readout to the operator's `trend-readout` Discord channel role (already in
 *      system.schema approval_surface.channels). The readout is angles-only (§1.4 principle) — it
 *      NEVER drafts reply/comment text. The post mechanism is INJECTABLE (opts.postReadout) so the
 *      engine carries no credential and tests run zero-key (RD-12); the default is a no-op that
 *      returns the readout text for the caller/host to deliver.
 *   3. For each report, maps a TREND SEED (engine/sources/seed.mapTrendSeed) into a RESERVED `trend`
 *      calendar slot (DD-16: trend fills reserved slots, never out-of-calendar) and DISPATCHES one
 *      pending slot-run task record (orchestrator/dispatch) carrying the seed's chain fields
 *      (slot_type='trend', content_form, pre_seed, trend_report(_ref), freshness_window). The host
 *      runtime then runs the SAME chain — matcher → writer → hybrid gate → package → queue →
 *      the HUMAN approval card (the double gate, §2.4). NOTHING here auto-publishes; SAFE is default.
 *
 * IT DOES NOT FORK THE CHAIN. This module produces SEEDS and dispatches them through the canonical
 * RD-18 transport (dispatch.dispatchTask); the report rides on the task command exactly as a slot's
 * trend_report would (pipelines/shared.makeRunCtx reads slot_type/content_form/trend_report off the
 * command). The trend pathway is a SOURCE that feeds the chain, not a bypass (the LAW).
 *
 * RESERVED-SLOT MATCHING (DD-16): trend content fills slots the operator marked `slot_type: trend`
 * in the calendar (calendar.schema slot_type enum). A pass claims one report per available reserved
 * trend slot for the matched brand/platform; if no reserved trend slot is free, the report is
 * WRITTEN (the seed exists) but NOT dispatched (never out-of-calendar) and reported as `unslotted`.
 * The operator reserves more trend slots to raise throughput — the engine never invents a slot.
 *
 * Safety order (§15.4 + DD-19), enforced before ANY dispatch (identical posture to kickoff):
 *   - the whole pass runs UNDER the single-runner lock (run-lock.js → the canonical queue lock); an
 *     overlapping run is skip-and-logged as `skipped_on_overlap` under its named trigger;
 *   - dispatch's PAUSED + spend-cap preflight halts new dispatch when the kill switch is engaged or
 *     the budget is breached — a paused/over-budget project dispatches nothing even mid-pass.
 *
 * FRESHNESS / DEDUP (DD-16 freshness, DD-15 TTL): the trend-card TTL is the report's freshness
 * window (carried onto the seed + queue entry by the existing chain). A per-(date,report) dedup in
 * the kickoff-state `trend_fires` map keeps a re-run from dispatching the same report twice the same
 * day (mirrors kickoff's per-(date,slot) dedup); an expired report (freshness window in the past) is
 * skipped as `stale`.
 *
 * Tier-3 cleanliness (§0.3 r6 / RD-3): no channel ids/handles/paths/session keys/codenames; the
 * trend-readout channel id is read from config (operator-supplied), the calendar + dedup state live
 * under $CONTENT_HOME via paths.js, and the readout delivery is the host's injected mechanism.
 */

const fs = require('fs');
const path = require('path');

const trendSource = require('../sources/trends');
const { verifyTrendOutput } = require('../sources/verify-output');
const seed = require('../sources/seed');
const dispatch = require('./dispatch');
const runLock = require('./run-lock');
const mode = require('./mode');
const kickoff = require('./kickoff');

/** The named trigger for a trend pass (DD-19 attribution; registered in dispatch.TRIGGER). */
const TREND_TRIGGER = dispatch.TRIGGER.TREND_POLL;

/** The §11.2 channel role the trend readout is posted to (already in system.schema). */
const TREND_READOUT_ROLE = 'trend-readout';

// ---------------------------------------------------------------------------
// Reserved-slot selection (DD-16: trend fills RESERVED calendar slots only)
// ---------------------------------------------------------------------------

/**
 * The brand+platform a report wants a slot for. A report names its platform; the brand comes from
 * the poll's brand scoping (a trend pass is run per brand, like the rest of the chain).
 */
function reportTargetPlatform(report) {
  return (report && report.platform) || null;
}

/**
 * Find the reserved `trend` calendar slots eligible for a brand/platform, oldest-first by clock
 * time (so the day's earliest reserved trend slot is filled first). active state only; an explicit
 * platform on the slot must match the report's platform when both are present.
 */
function reservedTrendSlots(slots, { brand, platform }) {
  return slots
    .filter((s) => s && String(s.slot_type || '').toLowerCase() === 'trend')
    .filter((s) => String(s.state || 'active').toLowerCase() === 'active')
    .filter((s) => !brand || !s.brand || String(s.brand) === String(brand))
    .filter((s) => !platform || !s.platform || String(s.platform).toLowerCase() === String(platform).toLowerCase())
    .sort((a, b) => String(a.time || '').localeCompare(String(b.time || '')));
}

// ---------------------------------------------------------------------------
// Freshness / per-(date,report) dedup (mirrors kickoff's fires map)
// ---------------------------------------------------------------------------

/** Is the report still fresh (freshness window not expired)? A missing window is treated as fresh. */
function reportIsFresh(report, nowMs) {
  const fw = report && report.freshness_window;
  if (!fw || !fw.expires_at) return true;
  const exp = Date.parse(fw.expires_at);
  return Number.isNaN(exp) ? true : exp >= nowMs;
}

/** A stable per-report dedup key (platform + period end) — same report, same day = one dispatch. */
function reportKey(report) {
  const platform = (report && report.platform) || 'all';
  const stamp = (report && report.period && (report.period.end || report.period.start)) || '';
  return `${platform}|${stamp}`;
}

function loadStateSafe(env) {
  const file = kickoff.kickoffStatePath(env);
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { /* fall through */ }
  return { fires: {}, trend_fires: {} };
}

function saveStateSafe(state, env) {
  const file = kickoff.kickoffStatePath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

// ---------------------------------------------------------------------------
// Readout (angles-only; posted to the trend-readout channel via an injected mechanism)
// ---------------------------------------------------------------------------

/** The configured trend-readout channel id (Tier-3, operator-supplied; null when unbound). */
function trendReadoutChannelId(config) {
  const channels = (config && config.approval_surface && config.approval_surface.channels) || {};
  return channels[TREND_READOUT_ROLE] || null;
}

/**
 * Build the trend readout text for a set of reports: a compact, angles-only summary (§1.4 — angles,
 * never drafted reply text). Brand-neutral; carries topic labels + suggested angles + source links
 * so the operator can find the originating posts to engage authentically.
 */
function buildReadout(reports, { brand } = {}) {
  if (!reports.length) {
    return `Trend pass: no actionable trends this cycle${brand ? ` for ${brand}` : ''}.`;
  }
  const lines = [`Trend readout${brand ? ` — ${brand}` : ''}: ${reports.length} report${reports.length === 1 ? '' : 's'} (angles only — no drafted replies).`];
  for (const report of reports) {
    const { topicLabels, angles, links } = seed.summarizeTrend(report);
    const platform = report.platform || 'all';
    lines.push(`• [${platform}] ${topicLabels.length ? topicLabels.join(', ') : '(topics)'}`);
    for (const a of angles.slice(0, 3)) lines.push(`    angle: ${a}`);
    for (const l of links.slice(0, 2)) lines.push(`    source: ${l}`);
  }
  return lines.join('\n');
}

/**
 * The default readout poster: a NO-OP that returns the readout text without contacting any surface
 * (the engine ships credential-free — RD-12/§4.4). A host wires a real poster via opts.postReadout
 * ({ text, channelId, config, env }) -> any|Promise; the trend-readout channel id is supplied so a
 * Discord/Slack adapter can route it. When no channel is bound, the pass still returns the text.
 */
function defaultPostReadout({ text }) {
  return { posted: false, reason: 'no readout mechanism wired (engine ships credential-free, RD-12); text returned for the host to deliver', text };
}

// ---------------------------------------------------------------------------
// runTrendPass — poll → readout → reserved-slot dispatch (the chain wiring)
// ---------------------------------------------------------------------------

/**
 * Run one config-gated trend pass for a brand. OFF BY DEFAULT: refuses (returns
 * { ran:false, disabled:true }) unless config.trends.enabled === true, UNLESS opts.force overrides
 * for an explicit operator/test run (the source's pollTrends still enforces the same gate).
 *
 * @param {object} [opts]
 * @param {object}   [opts.env]          environment (default process.env)
 * @param {object}   [opts.config]       parsed config/system.json (trends block + approval_surface)
 * @param {string}   [opts.brand]        brand id the reports/slots are for (REQUIRED to fill a
 *                                        brand-scoped reserved trend slot, DD-16/§6.5)
 * @param {Array}    [opts.slots]        pre-loaded calendar slots (test/cross-trigger reuse); else loaded
 * @param {string}   [opts.adapter]      adapter override (else config.trends.adapter)
 * @param {string}   [opts.cadence]      cadence override (else config.trends.cadence)
 * @param {string[]} [opts.themes]       theme hints override (else config.trends.themes)
 * @param {string}   [opts.mode]         per-run mode override (resolved through mode.js; default SAFE)
 * @param {function} [opts.fetchImpl]    injectable provider call (RD-12) — forwarded to the adapter
 * @param {function} [opts.postReadout]  injectable readout poster (RD-12) — default returns the text
 * @param {boolean}  [opts.force]        run even when trends.enabled is false (operator/test)
 * @param {boolean}  [opts.dryRun]       poll + build readout + select, but write/dispatch nothing
 * @param {boolean}  [opts.lock]         acquire the single-runner lock (default true)
 * @param {Date|number} [opts.now]       injectable clock (freshness/dedup); default Date.now()
 * @returns {Promise<{ ran, disabled?, skipped_on_overlap?, adapter, cadence, reports, written,
 *                      readout, readout_post, dispatched, unslotted, stale, skipped, failed, tasks, errors }>}
 */
async function runTrendPass(opts = {}) {
  const env = opts.env || process.env;
  const config = opts.config || {};
  const enabled = trendSource.isEnabled(config);

  if (!enabled && !opts.force) {
    return {
      ran: false,
      disabled: true,
      reason: 'the trend pathway is OFF by default (the LAW). Set config trends.enabled=true (and trends.adapter) in config/system.json (§8.8) to run a trend pass.',
      dispatched: 0,
    };
  }

  const body = async () => {
    const nowMs = opts.now != null ? (opts.now instanceof Date ? opts.now.getTime() : Number(opts.now)) : Date.now();
    const dateISO = new Date(nowMs).toISOString().slice(0, 10);
    const resolved = mode.resolveMode({ override: opts.mode, config, env });
    const brand = opts.brand || null;

    // 1. POLL the source (writes reports under $CONTENT_HOME/trends unless dryRun). The source
    //    re-checks the same enabled gate; opts.force flips the config block on for an explicit run.
    const pollConfig = opts.force && !enabled
      ? { ...config, trends: { ...(config.trends || {}), enabled: true } }
      : config;
    const poll = await trendSource.pollTrends({
      env,
      config: pollConfig,
      brand,
      adapter: opts.adapter,
      cadence: opts.cadence,
      themes: opts.themes,
      fetchImpl: opts.fetchImpl,
      write: opts.dryRun !== true,
      signal: opts.signal,
    });

    const reports = poll.reports || [];

    // 1b. VERIFY the poll output: did it run + produce topics when tracking targets were configured,
    //     and is every topic filtered to only the trend-report variables? Read-only; surfaced on the
    //     result (and the CLI). An expected-but-empty poll is flagged, never a silent no-op.
    const tcfg = trendSource.trendsConfig(pollConfig);
    const verification = verifyTrendOutput(
      { reports, invalid: poll.invalid || [] },
      { requested: { tracked_accounts: tcfg.tracked_accounts, keywords: tcfg.keywords } },
    );

    // 2. Build the readout (angles-only) and post it to the trend-readout channel via the injected
    //    mechanism (default no-op returns the text; a host wires the real Discord/Slack poster).
    const readout = buildReadout(reports, { brand });
    const channelId = trendReadoutChannelId(config);
    const poster = typeof opts.postReadout === 'function' ? opts.postReadout : defaultPostReadout;
    let readoutPost = null;
    if (!opts.dryRun) {
      try {
        readoutPost = await poster({ text: readout, channelId, role: TREND_READOUT_ROLE, brand, config, env });
      } catch (e) {
        // Observability/readout delivery is never a chain dependency — a failed post does not stop
        // the seed dispatch (§13.1 posture). Record it.
        readoutPost = { posted: false, error: String(e && e.message ? e.message : e) };
      }
    }

    // 3. Map each fresh report to a TREND SEED and dispatch it into a RESERVED trend slot (DD-16).
    const slots = Array.isArray(opts.slots) ? opts.slots : kickoff.loadSlots(env);
    const state = opts.dryRun ? null : loadStateSafe(env);
    const usedSlotIds = new Set();

    const result = {
      ran: true,
      adapter: poll.adapter,
      cadence: poll.cadence,
      date: dateISO,
      mode: resolved.mode,
      mode_source: resolved.source,
      reports: reports.length,
      written: poll.written || [],
      invalid: poll.invalid || [],
      verification,
      readout,
      readout_post: readoutPost,
      dispatched: 0,
      unslotted: 0,
      stale: 0,
      skipped: 0,
      failed: 0,
      tasks: [],
      errors: [],
    };

    for (const report of reports) {
      // Freshness (DD-16): an expired trend never becomes a seed.
      if (!reportIsFresh(report, nowMs)) { result.stale++; continue; }

      // RESERVED trend slot match (DD-16: never out-of-calendar). Pick the first free reserved
      // trend slot for this brand/platform; if none is free, the seed is written but not dispatched.
      const platform = reportTargetPlatform(report);
      const candidates = reservedTrendSlots(slots, { brand, platform }).filter((s) => !usedSlotIds.has(s.slot_id));
      const slot = candidates[0];
      if (!slot) {
        result.unslotted++;
        result.errors.push({ report: reportKey(report), code: 'ENORESERVEDSLOT', reason: 'no free reserved `trend` calendar slot for this brand/platform (DD-16: trend fills reserved slots, never out-of-calendar). Reserve a trend slot in the calendar to raise throughput.' });
        continue;
      }

      // Per-(date,slot) dedup (mirrors kickoff's per-(date,slot) fires map): a reserved trend slot
      // already filled today is not refilled, so a re-run within the day is idempotent. Keyed on the
      // SLOT (stable) rather than the report timestamp (which differs every poll). Belt-and-braces
      // with the transport's own task_id idempotency.
      const dKey = `${dateISO}|${slot.slot_id}`;
      if (!opts.force && state && state.trend_fires && state.trend_fires[dKey]) {
        usedSlotIds.add(slot.slot_id); // claim it so a second report doesn't try the same slot
        result.skipped++;
        continue;
      }

      // Map the trend SEED through the on-disk bridge (fail-closed on the config gate). content_form
      // (standalone | quote-retweet) follows the slot's note/config; default standalone (DD-16).
      let trendSeed;
      try {
        trendSeed = seed.mapTrendSeed(report, {
          slot: {
            slot_id: slot.slot_id,
            brand: slot.brand || brand,
            platform: slot.platform || platform,
            format: slot.format,
            theme: slot.theme,
            pillar: slot.pillar,
            archetype: slot.archetype,
          },
          config: pollConfig,
          content_form: opts.content_form,
          mode: opts.mode,
        });
      } catch (e) {
        result.failed++;
        result.errors.push({ report: reportKey(report), code: 'EMAPSEED', reason: String(e && e.message ? e.message : e) });
        continue;
      }

      if (opts.dryRun) {
        usedSlotIds.add(slot.slot_id);
        result.tasks.push({ slot_id: slot.slot_id, content_id: trendSeed.content_id, content_form: trendSeed.content_form, dry_run: true });
        result.dispatched++;
        continue;
      }

      // Dispatch the seed as a slot-run task command through the CANONICAL transport. The seed's
      // chain fields ride on the command so the host pipeline (makeRunCtx) drives the trend chain.
      const command = trendCommand(trendSeed, slot, dateISO, resolved.mode);
      const disp = dispatch.dispatchTask(command, TREND_TRIGGER, { env, config, dispatcher: 'poll-trends' });
      if (!disp.ok) {
        result.failed++;
        result.errors.push({ slot_id: slot.slot_id, code: disp.code, reason: disp.reason });
        if (disp.code === 'EPAUSED' || disp.code === 'EBUDGET' || disp.code === 'ECONTENTHOME') break; // kill switch / budget halts the pass
        continue;
      }
      usedSlotIds.add(slot.slot_id);
      result.dispatched++;
      result.tasks.push({ slot_id: slot.slot_id, task_id: disp.task.task_id, content_id: trendSeed.content_id, content_form: trendSeed.content_form, existed: disp.existed });
      if (state) {
        state.trend_fires = state.trend_fires || {};
        state.trend_fires[dKey] = { fired_at: new Date(nowMs).toISOString(), task_id: disp.task.task_id, slot_id: slot.slot_id, report: reportKey(report) };
      }
    }

    if (state && !opts.dryRun) saveStateSafe(state, env);
    return result;
  };

  if (opts.lock === false) return body();
  const locked = await runLock.withRunLock({ trigger: TREND_TRIGGER, env, ledger: opts.ledger }, body);
  if (!locked.ran) {
    return {
      ran: false,
      skipped_on_overlap: Boolean(locked.skipped_on_overlap),
      heldBy: locked.heldBy || null,
      error: locked.error || null,
      dispatched: 0,
    };
  }
  return locked.result;
}

/**
 * Build the §6.1/§7.11 command for a trend seed dispatch. The seed's chain-relevant fields ride on
 * the command so the host pipeline reads slot_type='trend', content_form, pre_seed, the trend_report
 * (Zone-U angles), the report ref, and the freshness window (DD-15/DD-16) exactly as a calendar
 * trend slot would. command_family is RUN_TREND_MANUAL when the slot didn't name one (§6.1 family).
 */
function trendCommand(trendSeed, slot, dateISO, resolvedMode) {
  return {
    command_family: slot.command_family || dispatch.COMMAND_FAMILY.RUN_TREND_MANUAL,
    content_id: trendSeed.content_id,
    slot_id: slot.slot_id,
    brand: trendSeed.brand,
    platform: trendSeed.platform,
    format: trendSeed.format,
    date: dateISO,
    mode: resolvedMode,
    // Chain fields the pipeline (pipelines/shared.makeRunCtx) reads off the slot/command:
    slot_type: 'trend',
    content_form: trendSeed.content_form,
    pre_seed: trendSeed.pre_seed,
    trend_report: trendSeed.trend_report,
    trend_report_ref: trendSeed.trend_report_ref || null,
    freshness_window: trendSeed.freshness_window || null,
    expires_basis: trendSeed.expires_basis || null,
    archetype: (trendSeed.brief && trendSeed.brief.archetype) || null,
    theme: (trendSeed.brief && trendSeed.brief.theme) || slot.theme || null,
    pillar: slot.pillar || null,
    framework_ref: (trendSeed.brief && trendSeed.brief.framework_ref) || null,
    provenance: trendSeed.provenance,
  };
}

module.exports = {
  TREND_TRIGGER,
  TREND_READOUT_ROLE,
  // selection + freshness helpers (exported for tests / cross-trigger reuse)
  reservedTrendSlots,
  reportIsFresh,
  reportKey,
  trendReadoutChannelId,
  buildReadout,
  defaultPostReadout,
  trendCommand,
  // the orchestration entry point
  runTrendPass,
};
