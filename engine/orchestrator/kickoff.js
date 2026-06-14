'use strict';

/**
 * engine/orchestrator/kickoff.js  [A adapted from the production morning-preview kickoff]
 *
 * The CANONICAL daily batch run (release-spec §8.4 "Canonical v1 trigger: the daily kickoff
 * batch"; RD-14 — kickoff is the production-proven topology, the recommended default; DD-19
 * named-trigger discipline; RD-18 run-dispatch transport). Once daily at a configured time, it:
 *   1. reads the calendar (+ campaign overlays),
 *   2. selects the day's eligible slots (staggered, bounded by `--max`),
 *   3. dispatches each as a `pending` slot-run task record into $CONTENT_HOME/ledger/tasks/.
 *
 * This is the de-coupled public form of the production kickoff module. That module's chat /
 * host-runtime enqueue transport (a hardcoded ops channel id + session key + a host-runtime cron
 * spawn) is GONE — replaced by RD-18 schema'd task records (the engine never calls a chain-seat
 * LLM; the host runtime consumes records through its documented hook, RD-2/§4.3). All
 * the proven topology is preserved: day-window slot selection, the bounded `--max`, staggering, and
 * the per-(date,slot) dedup that makes a re-run idempotent (no duplicate runs).
 *
 * Safety order (§15.4 + DD-19), enforced before ANY dispatch:
 *   - the whole batch runs UNDER the single-runner lock (run-lock.js → the canonical queue lock);
 *     an overlapping run is skip-and-logged as `skipped_on_overlap` with its named trigger;
 *   - dispatch.dispatchTask's own PAUSED + spend-cap preflight halts new dispatch when the kill
 *     switch is engaged or the budget is breached — so even inside the lock, a paused project
 *     dispatches nothing.
 *
 * Mode is resolved through the ONE ladder authority (mode.js); the default for a fresh install is
 * SAFE (RD-16f). The kickoff does NOT bake in a permissive default — it passes the operator's
 * requested mode (or none, letting config/SAFE win).
 *
 * Tier-3 cleanliness (§0.3 r6 / RD-3): the calendar lives under $CONTENT_HOME via paths.js; the
 * timezone is read from config (a production hardcoded zone is generalized — §11.2 scheduler
 * block); no channel ids, no session keys, no host-runtime env vars, no brand strings, no
 * production codenames. State (the per-date dedup) lives at $CONTENT_HOME/calendar/, never in-repo.
 *
 * The calendar schema (schemas/inputs/calendar.schema.json, §6.5/DD-22: `slot_id`, `brand`,
 * `platform`, `day`, `time`, `pillar/theme`, `content_type`, `command_family`, `format`,
 * `slot_type`, `state`, `notes`) is authored by P1-SCH-INPUT. This module's reader parses that
 * column set (tolerant markdown-table read; the strict gate is the schema-validation runner).
 */

const fs = require('fs');
const path = require('path');

const paths = require('./../shared/paths');
const dispatch = require('./dispatch');
const campaign = require('./campaign');
const runLock = require('./run-lock');
const mode = require('./mode');

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Default day-batch bound + stagger (the production-proven defaults; config-overridable). */
const DEFAULT_MAX = 4;
const DEFAULT_STAGGER_MINUTES = 10;

// ---------------------------------------------------------------------------
// Calendar read (§6.5 column set) — under $CONTENT_HOME via paths.js
// ---------------------------------------------------------------------------

/** $CONTENT_HOME/calendar/calendar.md — the public calendar file (RD-3). */
function calendarPath(env = process.env) {
  return path.join(paths.calendarDir(env), 'calendar.md');
}

/** $CONTENT_HOME/calendar/calendar-state.json — the per-date dedup state (replaces the in-repo state file). */
function kickoffStatePath(env = process.env) {
  return path.join(paths.calendarDir(env), 'kickoff-state.json');
}

/**
 * Parse the `## Slots` markdown table into slot objects keyed by the §6.5 public column set. The
 * production parser keyed `account`/`time_et`; the public column set is `brand`/`time`/`slot_type`.
 * We read BOTH spellings so a migrated instance file still loads (brand ← account; time ← time_et),
 * and we never throw on a malformed row — a row that does not parse is skipped, not fatal.
 */
function parseSlots(raw) {
  const m = raw.match(/## Slots\s*\n([\s\S]*?)(?=\n## |$)/);
  if (!m) return [];
  const slots = [];
  for (const line of m[1].split('\n')) {
    if (!line.trim().startsWith('|')) continue;
    const cols = line.split('|').map((c) => c.trim());
    // Leading + trailing empty cells from the surrounding pipes.
    if (cols.length < 4) continue;
    const c1 = cols[1];
    if (!c1 || c1 === 'slot_id' || c1.startsWith('---')) continue; // header / separator rows
    // Public column order (§6.5): slot_id, brand, platform, day, time, pillar/theme,
    // content_type, command_family, format, slot_type, state, notes. We index defensively.
    slots.push({
      slot_id: cols[1],
      brand: cols[2] || null,
      platform: cols[3] || null,
      day: cols[4] || null,
      time: cols[5] || null,
      pillar: cols[6] || null,
      content_type: cols[7] || null,
      command_family: cols[8] || null,
      format: cols[9] || null,
      slot_type: cols[10] || null,
      state: cols[11] || cols[10] || null, // tolerate a missing slot_type column
      notes: cols[12] || cols[11] || '',
    });
  }
  return slots;
}

/** Read + parse the calendar; returns [] when the file is absent (a fresh instance has none yet). */
function loadSlots(env = process.env) {
  let file;
  try {
    file = calendarPath(env);
  } catch {
    return [];
  }
  if (!fs.existsSync(file)) return [];
  return parseSlots(fs.readFileSync(file, 'utf8'));
}

// ---------------------------------------------------------------------------
// Day windowing + selection (production topology, generalized timezone)
// ---------------------------------------------------------------------------

/** Today's ISO date in the configured timezone (a production hardcoded zone is now config-driven). */
function todayIso(env = process.env, config = {}) {
  const tz = (config.scheduler && config.scheduler.timezone) || config.timezone || 'UTC';
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(new Date()).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
    return `${parts.year}-${parts.month}-${parts.day}`;
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

/** Day-of-week name (Sun..Sat) for an ISO date — noon-UTC anchored so DST never shifts the day. */
function dayNameForIso(dateISO) {
  const d = new Date(`${dateISO}T12:00:00Z`);
  return DAYS[d.getUTCDay()];
}

/**
 * Select the day's eligible slots: active state, matching day-of-week, optionally filtered by
 * brand/slot, sorted by clock time. Mirrors the production selection but without the hardcoded
 * platform/account gating (those are operator filters, passed in opts, not baked rules).
 */
function selectSlots(slots, dateISO, opts = {}) {
  const day = dayNameForIso(dateISO);
  const slotFilter = opts.slot ? new Set(String(opts.slot).split(',').map((s) => s.trim()).filter(Boolean)) : null;
  const brandFilter = opts.brand ? new Set(String(opts.brand).split(',').map((s) => s.trim()).filter(Boolean)) : null;

  return slots
    .filter((slot) => {
      if (slotFilter) return slotFilter.has(slot.slot_id); // explicit slot list bypasses day/state gating
      if (String(slot.state || '').toLowerCase() !== 'active') return false;
      if (slot.day && slot.day !== day) return false;
      if (brandFilter && !brandFilter.has(String(slot.brand || ''))) return false;
      return true;
    })
    .sort((a, b) => String(a.time || '').localeCompare(String(b.time || '')));
}

function resolveMax(rawMax, eligibleCount, config = {}) {
  const raw = String(rawMax == null ? '' : rawMax).trim().toLowerCase();
  if (['all', 'today', 'active', 'today-active'].includes(raw)) return eligibleCount;
  const parsed = Number(rawMax);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  const cfgMax = config.scheduler && Number(config.scheduler.daily_max);
  return Number.isFinite(cfgMax) && cfgMax > 0 ? cfgMax : DEFAULT_MAX;
}

// ---------------------------------------------------------------------------
// Per-date dedup state (replaces the production in-repo state file)
// ---------------------------------------------------------------------------

function loadKickoffState(env = process.env) {
  const file = kickoffStatePath(env);
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { /* fall through to empty */ }
  return { fires: {} };
}

function saveKickoffState(state, env = process.env) {
  const file = kickoffStatePath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

function fireKey(dateISO, slotId) {
  return `${dateISO}|${slotId}`;
}

// ---------------------------------------------------------------------------
// runKickoff — the canonical daily batch (the CLI's `kickoff --now` calls this)
// ---------------------------------------------------------------------------

/**
 * Run the daily kickoff batch: select the day's slots, apply campaign overlays, and dispatch one
 * pending slot-run task record per slot. Runs under the single-runner lock (DD-19) unless the
 * caller opts out (opts.lock === false — used when an outer caller already holds the lock).
 *
 * @param {object} [opts]
 * @param {object} [opts.env]      environment (default process.env)
 * @param {object} [opts.config]   parsed config/system.json (timezone, scheduler.daily_max, mode)
 * @param {Array}  [opts.slots]    pre-loaded calendar slots (tests/cross-trigger reuse); else loaded
 * @param {Array}  [opts.campaigns] pre-loaded campaign set (shared with tick); else loaded
 * @param {string} [opts.date]     ISO date to run for (default today, in the configured tz)
 * @param {number|string} [opts.max] bound on dispatched slots (default config/DEFAULT_MAX)
 * @param {string} [opts.mode]     per-run mode override (resolved through mode.js; default SAFE)
 * @param {boolean} [opts.force]   re-dispatch even already-fired (date,slot) pairs
 * @param {boolean} [opts.dryRun]  select + log, but write no records and no state
 * @param {boolean} [opts.lock]    acquire the single-runner lock (default true)
 * @param {string} [opts.trigger]  named trigger (default morning-kickoff; kickoff--now for on-demand)
 * @returns {Promise<{ ran, skipped_on_overlap?, date, eligible, dispatched, skipped, failed, tasks }>}
 */
async function runKickoff(opts = {}) {
  const env = opts.env || process.env;
  const config = opts.config || {};
  const trigger = opts.trigger || dispatch.TRIGGER.MORNING_KICKOFF;

  const body = async () => {
    const dateISO = opts.date || todayIso(env, config);
    const slots = Array.isArray(opts.slots) ? opts.slots : loadSlots(env);
    const campaigns = Array.isArray(opts.campaigns)
      ? opts.campaigns
      : campaign.loadCampaigns({ env });

    const eligible = selectSlots(slots, dateISO, opts);
    const max = resolveMax(opts.max, eligible.length, config);
    const selected = eligible.slice(0, max);

    const resolved = mode.resolveMode({ override: opts.mode, config, env });
    const state = opts.dryRun ? null : loadKickoffState(env);

    const result = {
      ran: true,
      date: dateISO,
      mode: resolved.mode,
      mode_source: resolved.source,
      eligible: eligible.length,
      selected: selected.length,
      dispatched: 0,
      skipped: 0,
      failed: 0,
      tasks: [],
      errors: [],
    };

    const staggerMin = Number.isFinite(Number(opts.staggerMinutes)) ? Number(opts.staggerMinutes) : DEFAULT_STAGGER_MINUTES;
    for (let index = 0; index < selected.length; index++) {
      const slot = selected[index];
      const key = fireKey(dateISO, slot.slot_id);
      if (!opts.force && state && state.fires && state.fires[key]) {
        result.skipped++;
        continue;
      }
      const claim = campaign.claimSlot(slot, dateISO, campaigns);
      const delaySeconds = 5 + Math.round(index * staggerMin * 60);

      if (opts.dryRun) {
        result.tasks.push({ slot_id: slot.slot_id, content_id: `${dateISO}-${slot.slot_id}`, claim, dry_run: true });
        result.dispatched++;
        continue;
      }

      const disp = dispatch.runSlot(slot.slot_id, {
        env,
        config,
        slots,
        date: dateISO,
        mode: opts.mode, // let dispatch resolve through mode.js (override > config > SAFE)
        dispatcher: 'kickoff',
        trigger,
        preSeed: claim
          ? { campaign_id: claim.campaign_id, theme: claim.theme, messaging_goals: claim.messaging_goals }
          : undefined,
      });

      if (!disp.ok) {
        result.failed++;
        result.errors.push({ slot_id: slot.slot_id, code: disp.code, reason: disp.reason });
        // A PAUSED/budget preflight failure halts the WHOLE batch (the kill switch is engaged /
        // the budget is breached — no point trying the rest of the day's slots, §15.4). A
        // per-slot dispatch error (e.g. a malformed slot) is recorded and we continue.
        if (disp.code === 'EPAUSED' || disp.code === 'EBUDGET' || disp.code === 'ECONTENTHOME') break;
        continue;
      }
      result.dispatched++;
      result.tasks.push({ slot_id: slot.slot_id, task_id: disp.task.task_id, existed: disp.existed, delay_seconds: delaySeconds });
      if (state && state.fires) {
        state.fires[key] = {
          fired_at: new Date().toISOString(),
          task_id: disp.task.task_id,
          content_id: disp.task.content_id,
        };
      }
    }

    if (state && !opts.dryRun) saveKickoffState(state, env);
    return result;
  };

  if (opts.lock === false) {
    return body();
  }
  const locked = await runLock.withRunLock({ trigger, env, ledger: opts.ledger }, body);
  if (!locked.ran) {
    return {
      ran: false,
      skipped_on_overlap: Boolean(locked.skipped_on_overlap),
      heldBy: locked.heldBy || null,
      error: locked.error || null,
      date: opts.date || todayIso(env, config),
      dispatched: 0,
    };
  }
  return locked.result;
}

module.exports = {
  DEFAULT_MAX,
  DEFAULT_STAGGER_MINUTES,
  calendarPath,
  kickoffStatePath,
  parseSlots,
  loadSlots,
  todayIso,
  dayNameForIso,
  selectSlots,
  resolveMax,
  runKickoff,
};
