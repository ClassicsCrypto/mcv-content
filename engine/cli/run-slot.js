'use strict';

/**
 * engine/cli/run-slot.js  [N net-new]
 *
 * `engine run-slot <slot-id>` — the on-demand single-slot run (release-spec §2.8 quick-start step
 * 7 "the first run"; §8.4 run mechanics; RD-18 task-record transport). The smallest path to a
 * first approval card: validate the named slot against the calendar (fail-closed on an unknown
 * slot — §6.1), then DISPATCH one pending slot-run task record the host runtime consumes through
 * its documented hook (docs/runtimes/<runtime>.md — automatic on the OpenClaw fast path; manual
 * elsewhere). The engine never calls a chain-seat LLM (RD-2/§4.3), so dispatch IS the run mechanic.
 *
 * Pipeline composition (the seat seam): the pipelines (runTextHeavy / runVideoHeavy) are wired in
 * here so that when a caller PROVIDES wired seats (a test harness, the zero-key fixture run, or an
 * in-process host), the chain runs end-to-end to `awaiting_approval`. With the default UNWIRED
 * pipeline the engine refuses to fabricate seat artifacts: the seam throws EUNWIREDSEAT, and this
 * handler reports the honest "seats not wired — dispatched the task record for the host runtime to
 * run" outcome rather than inventing a card (RD-2/§4.3). Lane selection (text-heavy vs video-heavy)
 * follows the slot's format/platform (VISUAL_HEAVY formats → video-heavy; else the flagship
 * text-heavy lane, §8.1).
 *
 * Mode resolves through the ONE ladder (mode.js): --mode > ENGINE_MODE > config > SAFE (§8.3 /
 * RD-16f). In SAFE no card is posted; LIVE_PREVIEW posts a real card with no publish; LIVE hands
 * off draft-only (the second gate) — but card-posting/handoff are the publisher-liaison + executor
 * edges, not this verb: run-slot stops at the dispatched run / queued item.
 *
 * Tier-3 cleanliness (§0.3 r6): the calendar lives under $CONTENT_HOME via paths.js; no hardcoded
 * IDs/paths/codenames.
 */

const kickoff = require('../orchestrator/kickoff');
const dispatchMod = require('../orchestrator/dispatch');
const util = require('./util');

/** Visual-heavy format/platform heuristic (no platform-dirs descriptor on disk yet — P2). */
const VISUAL_HEAVY_RE = /(reel|short|video|clip|gif|carousel|gallery)/iu;

const HELP = `engine run-slot <slot-id> [options]

Run one calendar slot on demand (§2.8 step 7). Validates the slot against the calendar, then
dispatches a pending slot-run task record for the host runtime to execute (RD-18). With wired seats
(a host/test harness) the chain runs to a queued, awaiting-approval item; unwired, it dispatches
the record and reports honestly (the engine never fabricates seat output — RD-2).

  <slot-id>        the calendar slot id to run (required).
  --mode <M>       SAFE | LIVE_PREVIEW | LIVE override (default config/SAFE — §8.3/RD-16f).
  --date <YYYY-MM-DD>  run date (default today).
  --lane <l>       force lane: text-heavy | video-heavy (default: inferred from format/platform).
  --dispatch-only  dispatch the task record and stop (do not attempt an in-process pipeline run).
  --json           emit the structured result.
  -h, --help       show this help.`;

/** Infer the lifecycle lane for a slot (§8.1): visual-heavy formats → video-heavy; else text-heavy. */
function laneFor(slot, override) {
  if (override === 'text-heavy' || override === 'video-heavy') return override;
  const hay = `${slot.format || ''} ${slot.platform || ''} ${slot.content_type || ''}`;
  return VISUAL_HEAVY_RE.test(hay) ? 'video-heavy' : 'text-heavy';
}

/**
 * @param {object} ctx  { flags, positionals, env, config, pipeline? }
 * @returns {Promise<{ ok, summary, detail?, data?, exitCode? }>}
 */
async function run(ctx = {}) {
  const flags = ctx.flags || {};
  if (util.flagOn(flags.help)) return { ok: true, summary: HELP.split('\n')[0], detail: HELP };

  const env = ctx.env || process.env;
  const config = ctx.config || util.loadSystemConfig(env);

  const slotId = (ctx.positionals && ctx.positionals[0]) || (typeof flags.slot === 'string' ? flags.slot : null);
  if (!slotId) {
    return { ok: false, exitCode: 1, summary: 'run-slot needs a slot id', detail: 'Usage: engine run-slot <slot-id> (the slot must exist in the calendar — §6.1).' };
  }

  const modeVerdict = util.resolveModeWithNotice({ override: flags.mode, config, env });

  // Validate the slot against the calendar BEFORE dispatching (fail-closed, §6.1).
  const slots = kickoff.loadSlots(env);
  const slot = slots.find((s) => s && String(s.slot_id) === String(slotId));
  if (!slot) {
    return {
      ok: false,
      exitCode: 1,
      summary: `slot "${slotId}" not in the calendar`,
      detail: slots.length === 0
        ? 'No calendar slots found. Generate a calendar (§2.6 step 1) before running a slot.'
        : `Known slots: ${slots.map((s) => s.slot_id).join(', ')}`,
    };
  }

  // Dispatch the run-transport task record (the §8.4 run mechanic). dispatch.runSlot validates the
  // slot again against `slots` and honors PAUSED + budget preflight (§15.4).
  const disp = dispatchMod.runSlot(slotId, {
    env,
    config,
    slots,
    date: typeof flags.date === 'string' ? flags.date : undefined,
    mode: flags.mode,
    dispatcher: 'run-slot',
    trigger: dispatchMod.TRIGGER.RUN_SLOT,
  });
  if (!disp.ok) {
    return {
      ok: false,
      exitCode: disp.code === 'EPAUSED' || disp.code === 'EBUDGET' ? 0 : 1,
      summary: `run-slot refused (${disp.code})`,
      detail: disp.reason,
      data: disp,
    };
  }

  const lane = laneFor(slot, typeof flags.lane === 'string' ? flags.lane : undefined);
  const baseDetail = [
    modeVerdict.notice ? `mode: ${modeVerdict.mode} — ${modeVerdict.notice}` : `mode: ${modeVerdict.mode}`,
    `lane: ${lane}`,
    `task_id: ${disp.task.task_id} (${disp.existed ? 'already pending' : 'dispatched'})`,
  ];

  // Dispatch-only path (the §2.8 step 7 default): hand the host runtime the run, stop here.
  if (util.flagOn(flags['dispatch-only']) || !ctx.pipeline) {
    return {
      ok: true,
      summary: `dispatched ${slotId} → ${lane} (mode ${modeVerdict.mode}); host runtime will run it`,
      detail: [
        ...baseDetail,
        'The host runtime picks up the pending task via its run-dispatch hook (docs/runtimes/<runtime>.md);',
        'on the OpenClaw fast path this is automatic, otherwise prompt the host agent with the pending task.',
      ],
      data: { ok: true, slot_id: slotId, lane, mode: modeVerdict.mode, dispatch: disp },
    };
  }

  // In-process pipeline run (caller supplied wired seats — a host/test/fixture harness).
  const slotInput = {
    content_id: disp.task.content_id,
    slot_ref: slot.slot_id,
    brand: slot.brand,
    platform: slot.platform,
    format: slot.format,
    slot_type: slot.slot_type || 'regular',
    mode: modeVerdict.mode,
    pillar: slot.pillar,
  };

  let outcome;
  try {
    // Lazy require so the dispatch-only path never loads the chain modules unnecessarily.
    // eslint-disable-next-line global-require
    const lifecycleMod = lane === 'video-heavy' ? require('../../pipelines/video-heavy.js') : require('../../pipelines/text-heavy.js');
    const runFn = lane === 'video-heavy' ? lifecycleMod.runVideoHeavy : lifecycleMod.runTextHeavy;
    outcome = await runFn(slotInput, ctx.pipeline);
  } catch (err) {
    if (err && err.code === 'EUNWIREDSEAT') {
      return {
        ok: true,
        summary: `dispatched ${slotId} → ${lane}; pipeline seat "${err.role}" unwired (host runs it)`,
        detail: [...baseDetail, `seat "${err.role}" is not wired in-process — the engine does not fabricate seat output (RD-2). The dispatched task record is the run.`],
        data: { ok: true, slot_id: slotId, lane, mode: modeVerdict.mode, dispatch: disp, unwired_seat: err.role },
      };
    }
    return { ok: false, exitCode: 1, summary: `run-slot pipeline error`, detail: util.describeError(err) };
  }

  return {
    ok: outcome.ok !== false,
    exitCode: outcome.ok === false ? 1 : 0,
    summary: `run-slot ${slotId} → ${lane}: ${outcome.state}${outcome.ok === false ? ` (routed back to ${outcome.routed_back_to})` : ''}`,
    detail: [
      ...baseDetail,
      `stage: ${outcome.stage}, state: ${outcome.state}`,
      outcome.reason ? `reason: ${outcome.reason}` : null,
    ].filter(Boolean),
    data: { ok: outcome.ok !== false, slot_id: slotId, lane, mode: modeVerdict.mode, dispatch: disp, outcome },
  };
}

module.exports = { run, HELP, laneFor };
