'use strict';

/**
 * engine/orchestrator/work-recap.js  [N net-new — the work-recap pathway's SCHEDULING + chain wiring]
 *
 * Wires the MEMORY SOURCE (engine/sources/work-recap) into the EXISTING chain as a DAILY
 * build-in-public option the kickoff fills (release-spec §2.1 seeding; §3.3 operator/founder/team
 * accounts with flexible voice; §2.4 the double gate; §8.8 a source feeds the chain; §12 seams;
 * §13.3 redact-at-write). Once per day, per configured OPERATOR account, this:
 *
 *   1. SCANS the configured external memory path + runs the PRIVACY PRE-PASS
 *      (sources/work-recap.buildWorkRecapSeed → scan-memory + privacy-filter, reusing shared/redact
 *      + the config-extendable private-term deny list). PRIVACY IS LOAD-BEARING: project memory is
 *      SENSITIVE; only sanitized summaries leave the source, and the seed carries `privacy_flags`
 *      the downstream gate's privacy/leak check hard-blocks on BEFORE the approval card.
 *   2. MAPS the sanitized recap to a BUILD-IN-PUBLIC brief seed (sources/seed.mapWorkRecapSeed) for
 *      a calendar slot (recaps fill calendar slots, never out-of-calendar). The forbidden private
 *      terms are threaded onto pre_seed.must_not_include AND enrichment.proof_stack.fact_safety so
 *      the writer is told what not to say and the gate has the explicit forbidden set.
 *   3. DISPATCHES one pending slot-run task record (orchestrator/dispatch) carrying the seed's chain
 *      fields. The host runtime then runs the SAME chain — matcher → writer → hybrid gate (incl. the
 *      privacy/leak check) → package → queue → the HUMAN approval card (the double gate, §2.4).
 *      NOTHING here auto-publishes; SAFE is the default mode. Human approval is the final backstop.
 *
 * OFF BY DEFAULT (config-gated): the whole pathway ships disabled. It runs only when
 * config.work_recap.enabled === true; the source's buildWorkRecapSeed and seed.mapWorkRecapSeed both
 * re-enforce the same gate (fail-closed). With the feature off, or no memory path, or no shippable
 * work after redaction, this is a clean no-op — it dispatches nothing and never throws.
 *
 * ONE PER DAY, PER ACCOUNT (§3.3): the kickoff calls runDailyWorkRecap once on the daily batch. A
 * per-(date,account) dedup in the kickoff-state `work_recap_fires` map keeps a re-run from
 * dispatching a second recap for the same account the same day (mirrors kickoff's per-(date,slot)
 * dedup). Multiple operator accounts are configured via work_recap.accounts[]; each gets its own
 * daily build-in-public option scoped to its memory path/terms.
 *
 * IT DOES NOT FORK THE CHAIN. This module produces SEEDS and dispatches them through the canonical
 * RD-18 transport; the work-recap intent (slot_type, pre_seed, account_class, privacy provenance)
 * rides on the task command exactly as a calendar slot would (the LAW: a source feeds the chain).
 *
 * RESERVED WORK-RECAP SLOT (never out-of-calendar): build-in-public content fills the slot the
 * operator marked `slot_type: work_recap` in the calendar (calendar.schema slot_type enum) for the
 * account's brand. If no work-recap slot is reserved for the account, the recap is NOT dispatched
 * (never out-of-calendar) and reported as `unslotted` — the operator reserves one to enable it.
 *
 * TESTABILITY (RD-12, no secrets in CI): the memory read is injectable (opts.fs threaded into the
 * source's scanMemory) and the clock is injectable (opts.now), so the whole pathway runs zero-key
 * with an in-memory fake — exactly like the §12.5 vision seam.
 *
 * Tier-3 cleanliness (§0.3 r6 / RD-3): no IDs/handles/absolute paths/brand strings/codenames; the
 * memory path + accounts are operator-configured, the calendar + dedup state live under
 * $CONTENT_HOME via paths.js, and the seed is redacted-at-write through the source + dispatch.
 */

const fs = require('fs');
const path = require('path');

const workRecapSource = require('../sources/work-recap');
const seed = require('../sources/seed');
const dispatch = require('./dispatch');
const mode = require('./mode');
const kickoff = require('./kickoff');

/** The named trigger for a work-recap dispatch (DD-19 attribution; registered in dispatch.TRIGGER). */
const WORK_RECAP_TRIGGER = dispatch.TRIGGER.WORK_RECAP;

/** The calendar slot_type a work-recap option fills (calendar.schema slot_type enum). */
const WORK_RECAP_SLOT_TYPE = 'work_recap';

// ---------------------------------------------------------------------------
// Config — resolve the per-account work_recap settings (§3.3 per-account)
// ---------------------------------------------------------------------------

/**
 * Resolve the list of per-account work_recap settings from the `work_recap` config block. Two
 * shapes are supported (both off by default):
 *   - a single-account block: { enabled, memory_path, files, lookback_days, private_terms,
 *       brand, account }  → one account.
 *   - a multi-account block carrying `accounts: [{ brand, account, memory_path?, files?,
 *       lookback_days?, private_terms? }]` → each entry inherits the block's top-level defaults
 *       (memory_path/files/lookback_days/private_terms) unless it overrides them. Per §3.3, each
 *       operator/founder/team account gets its own daily build-in-public option.
 * Returns [] when the feature is disabled (the off-by-default gate) so callers no-op cleanly.
 *
 * @param {object} [config]  parsed config/system.json
 * @returns {Array<{brand, account, memory_path, files, lookback_days, private_terms}>}
 */
function resolveAccounts(config) {
  const block = (config && (config.work_recap || (config.sources && config.sources.work_recap))) || {};
  if (block.enabled !== true) return []; // OFF BY DEFAULT (the LAW).

  const defaults = {
    memory_path: typeof block.memory_path === 'string' ? block.memory_path : '',
    files: Array.isArray(block.files) ? block.files.slice() : undefined,
    lookback_days: Number.isFinite(block.lookback_days) ? block.lookback_days : undefined,
    private_terms: Array.isArray(block.private_terms) ? block.private_terms.slice() : [],
  };

  const list = Array.isArray(block.accounts) && block.accounts.length
    ? block.accounts
    : [{ brand: block.brand || null, account: block.account || null }];

  return list
    .filter((a) => a && typeof a === 'object')
    .map((a) => ({
      brand: a.brand || block.brand || null,
      account: a.account || block.account || null,
      memory_path: typeof a.memory_path === 'string' && a.memory_path ? a.memory_path : defaults.memory_path,
      files: Array.isArray(a.files) ? a.files.slice() : defaults.files,
      lookback_days: Number.isFinite(a.lookback_days) ? a.lookback_days : defaults.lookback_days,
      // Union the per-account deny list with the block default (both are public anti-targets).
      private_terms: dedupeStrings([...(defaults.private_terms || []), ...(Array.isArray(a.private_terms) ? a.private_terms : [])]),
    }));
}

function dedupeStrings(arr) {
  const seen = new Set();
  const out = [];
  for (const s of arr) {
    const v = String(s == null ? '' : s).trim();
    if (v && !seen.has(v)) { seen.add(v); out.push(v); }
  }
  return out;
}

/** Build the per-account `work_recap` settings object the source's buildWorkRecapSeed consumes. */
function sourceSettingsFor(acct) {
  const out = {
    enabled: true, // the account list only exists when the block is enabled (resolveAccounts gate)
    memory_path: acct.memory_path,
    brand: acct.brand,
    account: acct.account,
    private_terms: acct.private_terms || [],
  };
  if (acct.files) out.files = acct.files;
  if (acct.lookback_days != null) out.lookback_days = acct.lookback_days;
  return out;
}

// ---------------------------------------------------------------------------
// Reserved work-recap slot selection (never out-of-calendar)
// ---------------------------------------------------------------------------

/**
 * Find the reserved `work_recap` calendar slot for an account (its brand), oldest-first by clock
 * time. active state only; the slot's brand must match the account's brand when both are present.
 */
function workRecapSlotFor(slots, acct) {
  return slots
    .filter((s) => s && String(s.slot_type || '').toLowerCase() === WORK_RECAP_SLOT_TYPE)
    .filter((s) => String(s.state || 'active').toLowerCase() === 'active')
    .filter((s) => !acct.brand || !s.brand || String(s.brand) === String(acct.brand))
    .sort((a, b) => String(a.time || '').localeCompare(String(b.time || '')))[0] || null;
}

// ---------------------------------------------------------------------------
// Per-(date,account) dedup (mirrors kickoff's fires map)
// ---------------------------------------------------------------------------

function recapKey(dateISO, acct) {
  return `${dateISO}|${acct.brand || ''}|${acct.account || ''}`;
}

function loadStateSafe(env) {
  const file = kickoff.kickoffStatePath(env);
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { /* fall through */ }
  return { fires: {}, work_recap_fires: {} };
}

function saveStateSafe(state, env) {
  const file = kickoff.kickoffStatePath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

// ---------------------------------------------------------------------------
// runDailyWorkRecap — the daily build-in-public option (the chain wiring)
// ---------------------------------------------------------------------------

/**
 * Run the daily work-recap pass: for each configured OPERATOR account, scan memory, run the privacy
 * pre-pass, map a build-in-public seed into the account's reserved work-recap slot, and dispatch it.
 * OFF BY DEFAULT and a clean no-op when nothing is shippable. Designed to be called once on the
 * daily kickoff (kickoff.runKickoff invokes it) but is also a standalone entry point.
 *
 * NOTE: this is normally called from WITHIN the kickoff's run-lock body (opts.lock defaults to
 * false), so it does NOT take the single-runner lock itself — the kickoff already holds it. A
 * standalone caller (a dedicated work-recap trigger/test) passes opts.lock !== false to lock.
 *
 * @param {object} [opts]
 * @param {object}   [opts.env]      environment (default process.env)
 * @param {object}   [opts.config]   parsed config/system.json (work_recap block + approval_surface)
 * @param {Array}    [opts.slots]    pre-loaded calendar slots (shared with kickoff); else loaded
 * @param {string}   [opts.date]     ISO date for the run (default today)
 * @param {string}   [opts.mode]     per-run mode override (resolved through mode.js; default SAFE)
 * @param {object}   [opts.fs]       injectable fs facade forwarded to the memory scan (RD-12 zero-key)
 * @param {Date}     [opts.now]      injectable clock for lookback/dedup (default new Date())
 * @param {boolean}  [opts.force]    re-dispatch even an already-fired (date,account) pair
 * @param {boolean}  [opts.dryRun]   build seeds + select, but write/dispatch nothing
 * @param {boolean}  [opts.lock]     acquire the single-runner lock (default FALSE — kickoff holds it)
 * @returns {Promise<{ ran, disabled?, date, accounts, dispatched, unslotted, empty, skipped,
 *                      failed, tasks, errors }>}
 */
async function runDailyWorkRecap(opts = {}) {
  const env = opts.env || process.env;
  const config = opts.config || {};

  const accounts = resolveAccounts(config);
  if (!accounts.length) {
    return { ran: false, disabled: true, reason: 'the work-recap pathway is OFF by default (the LAW). Set config work_recap.enabled=true (and a memory_path) in config/system.json (§3.3/§8.8) to enable the daily build-in-public option.', accounts: 0, dispatched: 0 };
  }

  const body = async () => {
    const dateISO = opts.date || new Date(opts.now instanceof Date ? opts.now.getTime() : Date.now()).toISOString().slice(0, 10);
    const resolved = mode.resolveMode({ override: opts.mode, config, env });
    const slots = Array.isArray(opts.slots) ? opts.slots : kickoff.loadSlots(env);
    const state = opts.dryRun ? null : loadStateSafe(env);

    const result = {
      ran: true,
      date: dateISO,
      mode: resolved.mode,
      mode_source: resolved.source,
      accounts: accounts.length,
      dispatched: 0,
      unslotted: 0,
      empty: 0,
      skipped: 0,
      failed: 0,
      tasks: [],
      errors: [],
    };

    for (const acct of accounts) {
      const key = recapKey(dateISO, acct);
      if (!opts.force && state && state.work_recap_fires && state.work_recap_fires[key]) {
        result.skipped++;
        continue;
      }

      // 1. SCAN + PRIVACY PRE-PASS (the source builds the sanitized work-recap seed; raw memory
      //    never leaves the source). fs + now are injected for zero-key tests (RD-12).
      let recapSeed;
      try {
        recapSeed = workRecapSource.buildWorkRecapSeed({
          work_recap: sourceSettingsFor(acct),
          fs: opts.fs,
          now: opts.now,
        });
      } catch (e) {
        result.failed++;
        result.errors.push({ account: acct.account || acct.brand, code: 'ESCAN', reason: String(e && e.message ? e.message : e) });
        continue;
      }

      // Clean no-op: nothing shippable after redaction (disabled / no path / no work items).
      const hasWork = recapSeed && Array.isArray(recapSeed.work_items) && recapSeed.work_items.length > 0;
      if (!hasWork) {
        result.empty++;
        continue;
      }

      // 2. Find the reserved work-recap slot (never out-of-calendar).
      const slot = workRecapSlotFor(slots, acct);
      if (!slot) {
        result.unslotted++;
        result.errors.push({ account: acct.account || acct.brand, code: 'ENORESERVEDSLOT', reason: `no active reserved \`work_recap\` calendar slot for brand "${acct.brand || '(unset)'}" — recaps fill calendar slots, never out-of-calendar. Reserve a work_recap slot in the calendar to enable the daily option.` });
        continue;
      }

      // 3. Map the build-in-public seed (privacy deny-set threaded into the brief; fail-closed gate).
      let biPSeed;
      try {
        biPSeed = seed.mapWorkRecapSeed(recapSeed, {
          slot: {
            slot_id: slot.slot_id,
            brand: slot.brand || acct.brand,
            platform: slot.platform,
            format: slot.format,
            archetype: slot.archetype,
          },
          config,
          account_ref: acct.account || null,
          mode: opts.mode,
          memory_source_ref: recapSeed.provenance && recapSeed.provenance.memory_path_configured ? '(configured memory path)' : null,
        });
      } catch (e) {
        result.failed++;
        result.errors.push({ account: acct.account || acct.brand, slot_id: slot.slot_id, code: 'EMAPSEED', reason: String(e && e.message ? e.message : e) });
        continue;
      }

      if (opts.dryRun) {
        result.tasks.push({ account: acct.account || acct.brand, slot_id: slot.slot_id, content_id: biPSeed.content_id, dry_run: true, private_terms_count: biPSeed.provenance && biPSeed.provenance.private_terms_count });
        result.dispatched++;
        continue;
      }

      // Dispatch the seed through the CANONICAL transport. The seed's chain fields (incl. the privacy
      // provenance + account_class) ride on the command so the host pipeline + gate enforce them.
      const command = workRecapCommand(biPSeed, slot, dateISO, resolved.mode);
      const disp = dispatch.dispatchTask(command, WORK_RECAP_TRIGGER, { env, config, dispatcher: 'work-recap' });
      if (!disp.ok) {
        result.failed++;
        result.errors.push({ account: acct.account || acct.brand, slot_id: slot.slot_id, code: disp.code, reason: disp.reason });
        if (disp.code === 'EPAUSED' || disp.code === 'EBUDGET' || disp.code === 'ECONTENTHOME') break; // kill switch / budget halts the pass
        continue;
      }
      result.dispatched++;
      result.tasks.push({ account: acct.account || acct.brand, slot_id: slot.slot_id, task_id: disp.task.task_id, content_id: biPSeed.content_id, existed: disp.existed, private_terms_count: biPSeed.provenance && biPSeed.provenance.private_terms_count });
      if (state) {
        state.work_recap_fires = state.work_recap_fires || {};
        state.work_recap_fires[key] = { fired_at: new Date().toISOString(), task_id: disp.task.task_id, slot_id: slot.slot_id };
      }
    }

    if (state && !opts.dryRun) saveStateSafe(state, env);
    return result;
  };

  // Default lock=false: the kickoff already holds the single-runner lock when it calls us. A
  // standalone caller passes lock:true to take it (and gets skipped_on_overlap on contention).
  if (opts.lock !== true) return body();

  // eslint-disable-next-line global-require
  const runLock = require('./run-lock');
  const locked = await runLock.withRunLock({ trigger: WORK_RECAP_TRIGGER, env, ledger: opts.ledger }, body);
  if (!locked.ran) {
    return { ran: false, skipped_on_overlap: Boolean(locked.skipped_on_overlap), heldBy: locked.heldBy || null, error: locked.error || null, dispatched: 0 };
  }
  return locked.result;
}

/**
 * Build the §6.1/§7.11 command for a work-recap seed dispatch. The seed's chain-relevant fields ride
 * on the command so the host pipeline reads the build-in-public slot type, the pre_seed (with the
 * privacy must_not_include set), the account_class (operator — §3.3), and the privacy provenance the
 * gate's privacy/leak check enforces BEFORE the approval card (§2.4).
 */
function workRecapCommand(biPSeed, slot, dateISO, resolvedMode) {
  return {
    command_family: slot.command_family || dispatch.COMMAND_FAMILY.RUN_SLOT,
    content_id: biPSeed.content_id,
    slot_id: slot.slot_id,
    brand: biPSeed.brand,
    platform: biPSeed.platform,
    format: biPSeed.format,
    date: dateISO,
    mode: resolvedMode,
    // Chain fields the pipeline (pipelines/shared.makeRunCtx) reads off the slot/command. The seed
    // maps slot_type='regular' (build-in-public is a standalone post); we tag the SOURCE so
    // observability/the card can attribute it as a work-recap option.
    source: biPSeed.source,
    slot_type: biPSeed.slot_type,
    content_form: biPSeed.content_form,
    pre_seed: biPSeed.pre_seed,
    account_class: biPSeed.account_class,
    account_ref: biPSeed.account_ref || null,
    archetype: (biPSeed.brief && biPSeed.brief.archetype) || null,
    pillar: (biPSeed.brief && biPSeed.brief.pillar) || slot.pillar || null,
    framework_ref: (biPSeed.brief && biPSeed.brief.framework_ref) || null,
    // Privacy provenance the gate's privacy/leak check consumes (the forbidden set + redaction flag).
    provenance: biPSeed.provenance,
  };
}

module.exports = {
  WORK_RECAP_TRIGGER,
  WORK_RECAP_SLOT_TYPE,
  // config + selection helpers (exported for tests / the kickoff)
  resolveAccounts,
  sourceSettingsFor,
  workRecapSlotFor,
  recapKey,
  workRecapCommand,
  // the orchestration entry point (the kickoff calls this)
  runDailyWorkRecap,
};
