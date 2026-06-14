'use strict';

/**
 * engine/orchestrator/scheduler.js  [A adapted from the production calendar tick]
 *
 * The RD-14 trigger contract: the DAILY KICKOFF batch is the CANONICAL v1 trigger (kickoff.js, the
 * production-proven topology), and an OPTIONAL, OFF-BY-DEFAULT calendar TICK provides intra-day
 * precision (release-spec §8.4; RD-14 recommended option (b) — one canonical answer keeps the run
 * model + observability simple). This module owns the tick port and the disabled-by-default gate;
 * the canonical daily run lives in kickoff.js and is re-exported here for a single scheduler surface.
 *
 * The tick is the de-coupled public form of the production `_calendar-tick.js`: same proven
 * mechanics — a 2h look-ahead window, a per-brand minimum gap, and weekly dedup — but
 *   - it REFUSES to run unless `config.scheduler.tick_enabled === true` (RD-14 off-by-default); the
 *     refusal is explicit, not silent, so an operator who installed the recipe but left the flag off
 *     gets told why nothing fired;
 *   - the Discord/HQ enqueue transport is replaced by RD-18 task records (dispatch.js), exactly like
 *     kickoff — the engine never calls a chain-seat LLM (RD-2);
 *   - `CALENDAR_DRY_RUN=1` is retained as a DOCUMENTED diagnostic override, LOUD at startup (§4.5);
 *   - it runs under the SAME single-runner lock as kickoff + the executor (run-lock.js → the
 *     canonical queue lock), and it shares a dedup discipline with kickoff so a slot dispatched by
 *     EITHER trigger is not re-dispatched (DD-19; the double-dispatch bug P3-TICK guards). The tick
 *     records its fires in the SAME kickoff-state `fires` map keyed by (date,slot), so kickoff and
 *     tick observe each other's dispatches within the day.
 *
 * Tier-3 cleanliness (§0.3 r6 / RD-3): no channel ids, no session keys, no host-runtime env vars;
 * the calendar + dedup state live under $CONTENT_HOME via paths.js; the timezone/window/gap come
 * from config (a production hardcoded wall-clock offset is generalized — §11.2 scheduler block). No
 * brand strings, no production codenames.
 */

const fs = require('fs');

const dispatch = require('./dispatch');
const campaign = require('./campaign');
const runLock = require('./run-lock');
const mode = require('./mode');
const kickoff = require('./kickoff');

/** Tick defaults (the production-proven values; config-overridable via the scheduler block). */
const DEFAULT_LOOKAHEAD_MINUTES = 120; // fire anything due in the next 2h
const DEFAULT_MIN_GAP_MINUTES = 30;    // 30-min minimum between posts per brand within a tick

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** The §4.5 diagnostic dry-run override for the tick (documented, loud). */
const TICK_DRY_RUN_ENV = 'CALENDAR_DRY_RUN';

// ---------------------------------------------------------------------------
// Tick scheduling math (generalized timezone offset)
// ---------------------------------------------------------------------------

/**
 * Next occurrence of (dayName, HH:MM) as an absolute Date, honoring a fixed UTC offset for the
 * calendar's wall-clock timezone. The production module hardcoded a -4h ET offset; here the offset
 * comes from config (`scheduler.utc_offset_minutes`, default 0 = treat calendar times as UTC). This
 * keeps the tick deterministic and dependency-free; precise tz/DST is a roadmap refinement (the
 * tick is 30-min granular, so a sub-hour offset drift is tolerable — production note preserved).
 */
function nextOccurrence(dayName, timeHHMM, now, offsetMinutes) {
  const targetDay = DAYS.indexOf(dayName);
  if (targetDay === -1) return null;
  const m = String(timeHHMM || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  const offMs = (Number.isFinite(offsetMinutes) ? offsetMinutes : 0) * 60 * 1000;
  // Walk in "wall-clock" space (now shifted by the offset), then shift back to absolute UTC.
  const wallNow = new Date(now.getTime() + offMs);
  const wallDay = wallNow.getUTCDay();
  let daysAhead = (targetDay - wallDay + 7) % 7;
  const candidate = new Date(wallNow);
  candidate.setUTCDate(candidate.getUTCDate() + daysAhead);
  candidate.setUTCHours(hh, mm, 0, 0);
  // If it's today but already >30m past in wall time, roll to next week's same day.
  if (daysAhead === 0 && candidate.getTime() < wallNow.getTime() - 30 * 60 * 1000) {
    candidate.setUTCDate(candidate.getUTCDate() + 7);
  }
  return new Date(candidate.getTime() - offMs);
}

/** ISO-week key (yyyy-Www) so the weekly dedup rotates with the calendar week. */
function isoWeekKey(date) {
  const tmp = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  tmp.setUTCDate(tmp.getUTCDate() + 4 - (tmp.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((tmp - yearStart) / 86400000) + 1) / 7);
  return `${tmp.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// runTick — the optional intra-day trigger (off by default)
// ---------------------------------------------------------------------------

/**
 * Run one calendar tick: dispatch task records for slots due within the look-ahead window, with a
 * per-brand min-gap and weekly dedup, SHARING the kickoff dedup state so a slot fired today by
 * either trigger is not re-fired. REFUSES (returns { ran:false, disabled:true }) unless
 * config.scheduler.tick_enabled is true (RD-14) — unless opts.force overrides for an explicit
 * operator/test run.
 *
 * @param {object} [opts]
 * @param {object} [opts.env]          environment (default process.env)
 * @param {object} [opts.config]       parsed config (scheduler.tick_enabled, lookahead, gap, offset, mode)
 * @param {Array}  [opts.slots]        pre-loaded calendar slots (shared with kickoff); else loaded
 * @param {Array}  [opts.campaigns]    pre-loaded campaign set (shared); else loaded
 * @param {Date|number} [opts.now]     injectable clock for deterministic tests (default Date.now())
 * @param {boolean} [opts.force]       run even when tick_enabled is false (operator/test)
 * @param {boolean} [opts.dryRun]      select + log, write no records and no state (also via CALENDAR_DRY_RUN)
 * @param {boolean} [opts.lock]        acquire the single-runner lock (default true)
 * @returns {Promise<{ ran, disabled?, skipped_on_overlap?, due, dispatched, skipped, failed, tasks }>}
 */
async function runTick(opts = {}) {
  const env = opts.env || process.env;
  const config = opts.config || {};
  const scheduler = config.scheduler || {};
  const trigger = dispatch.TRIGGER.CALENDAR_TICK;

  const enabled = scheduler.tick_enabled === true;
  if (!enabled && !opts.force) {
    return {
      ran: false,
      disabled: true,
      reason: 'calendar tick is OFF by default (RD-14). Set config scheduler.tick_enabled=true to run it; the daily kickoff is the canonical trigger.',
    };
  }

  const dryRun = opts.dryRun === true || env[TICK_DRY_RUN_ENV] === '1';

  const body = async () => {
    const nowMs = opts.now != null ? (opts.now instanceof Date ? opts.now.getTime() : Number(opts.now)) : Date.now();
    const now = new Date(nowMs);
    const lookaheadMs = (Number(scheduler.lookahead_minutes) || DEFAULT_LOOKAHEAD_MINUTES) * 60 * 1000;
    const minGapMs = (Number(scheduler.min_gap_minutes) || DEFAULT_MIN_GAP_MINUTES) * 60 * 1000;
    const offsetMinutes = Number(scheduler.utc_offset_minutes) || 0;

    const slots = Array.isArray(opts.slots) ? opts.slots : kickoff.loadSlots(env);
    const campaigns = Array.isArray(opts.campaigns) ? opts.campaigns : campaign.loadCampaigns({ env });
    const active = slots.filter((s) => String(s.state || '').toLowerCase() === 'active');

    const resolved = mode.resolveMode({ override: opts.mode, config, env });
    const state = dryRun ? null : loadStateSafe(env);

    const result = {
      ran: true,
      due: 0,
      dispatched: 0,
      skipped: 0,
      failed: 0,
      mode: resolved.mode,
      tasks: [],
      errors: [],
    };

    // Build the due list (within [now-30m, now+lookahead]) with weekly dedup.
    const due = [];
    for (const slot of active) {
      const next = nextOccurrence(slot.day, slot.time, now, offsetMinutes);
      if (!next) continue;
      const t = next.getTime();
      if (t < nowMs - 30 * 60 * 1000) continue;
      if (t > nowMs + lookaheadMs) continue;
      const dedupKey = `${slot.slot_id}|${isoWeekKey(next)}`;
      if (state && state.tick_fires && state.tick_fires[dedupKey]) continue; // already fired this week
      due.push({ slot, fireTime: next, dedupKey });
    }
    due.sort((a, b) => a.fireTime - b.fireTime);
    result.due = due.length;

    // Per-brand min-gap within this tick + shared (date,slot) dedup with kickoff.
    const lastFirePerBrand = {};
    for (const item of due) {
      const { slot, fireTime, dedupKey } = item;
      const brandKey = `${slot.brand || ''}|${slot.platform || ''}`;
      const lastFire = lastFirePerBrand[brandKey] || 0;
      if (fireTime.getTime() - lastFire < minGapMs) {
        result.skipped++;
        continue;
      }
      const fireDateISO = fireTime.toISOString().slice(0, 10);
      // SHARED dedup with kickoff: if kickoff already dispatched this (date,slot) today, skip.
      const sharedKey = `${fireDateISO}|${slot.slot_id}`;
      if (state && state.fires && state.fires[sharedKey]) {
        result.skipped++;
        continue;
      }

      const claim = campaign.claimSlot(slot, fireDateISO, campaigns);
      if (dryRun) {
        result.tasks.push({ slot_id: slot.slot_id, fire_time: fireTime.toISOString(), claim, dry_run: true });
        result.dispatched++;
        lastFirePerBrand[brandKey] = fireTime.getTime();
        continue;
      }

      const disp = dispatch.runSlot(slot.slot_id, {
        env,
        config,
        slots,
        date: fireDateISO,
        mode: opts.mode,
        dispatcher: 'calendar-tick',
        trigger,
        preSeed: claim
          ? { campaign_id: claim.campaign_id, theme: claim.theme, messaging_goals: claim.messaging_goals }
          : undefined,
      });
      if (!disp.ok) {
        result.failed++;
        result.errors.push({ slot_id: slot.slot_id, code: disp.code, reason: disp.reason });
        // PAUSED/budget halts the whole tick (same posture as kickoff).
        if (disp.code === 'EPAUSED' || disp.code === 'EBUDGET') break;
        continue;
      }
      result.dispatched++;
      result.tasks.push({ slot_id: slot.slot_id, task_id: disp.task.task_id, existed: disp.existed });
      lastFirePerBrand[brandKey] = fireTime.getTime();
      if (state) {
        state.tick_fires = state.tick_fires || {};
        state.tick_fires[dedupKey] = new Date().toISOString();
        state.fires = state.fires || {};
        state.fires[sharedKey] = { fired_at: new Date().toISOString(), task_id: disp.task.task_id, by: 'calendar-tick' };
      }
    }

    if (state && !dryRun) saveStateSafe(state, env);
    return result;
  };

  if (opts.lock === false) return body();
  const locked = await runLock.withRunLock({ trigger, env, ledger: opts.ledger }, body);
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

// The kickoff state file is the shared dedup substrate; reuse its load/save by reading the same
// path. kickoff exports the path accessor; loadKickoffState/saveKickoffState are module-private
// there, so we re-implement a tolerant read/write against the same file.
function loadStateSafe(env) {
  const file = kickoff.kickoffStatePath(env);
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { /* fall through */ }
  return { fires: {}, tick_fires: {} };
}

function saveStateSafe(state, env) {
  const file = kickoff.kickoffStatePath(env);
  const path = require('path');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

module.exports = {
  DEFAULT_LOOKAHEAD_MINUTES,
  DEFAULT_MIN_GAP_MINUTES,
  TICK_DRY_RUN_ENV,
  nextOccurrence,
  isoWeekKey,
  runTick,
  // RD-14: the canonical daily run is kickoff.runKickoff — re-exported for one scheduler surface.
  runKickoff: kickoff.runKickoff,
};
