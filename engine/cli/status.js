'use strict';

/**
 * engine/cli/status.js  [N net-new]
 *
 * `engine status` — the one-command operational surface (release-spec §13.1 surface 1; model §7;
 * RD-16d). The bar (§13): an operator MUST be able to answer — did the system run today, what did
 * it produce, what failed with which codes, what did it spend — without reading internals.
 *
 * It composes the already-on-disk substrates (it reads, never mutates):
 *   - the canonical queue (engine/shared/queue.parseQueue) → per-state counts + oldest-age, with
 *     `handed_off` glossed as "awaiting operator publish in the publisher" (§8.3 / §13.1);
 *   - the event ledger (engine/orchestrator/workflow-ledger events.jsonl) → last run per NAMED
 *     trigger (DD-19) and today's produced/published/failed tallies with failure-code counts;
 *   - the pending task records (engine/orchestrator/dispatch.listPending) → queued-but-not-yet-run
 *     count (the RD-18 run transport);
 *   - the resolved mode (mode.js — the ONE ladder) + the PAUSED sentinel (§15.4 paused/active);
 *   - a wiring self-check (the production verify-wiring pattern, generalized): is CONTENT_HOME
 *     resolvable, is config present + schema-shaped, is the Discord token present (fail-fast names
 *     the variable, never the value — §15.1), are publisher creds present-or-deferred.
 *
 * Spend (RD-19 honesty — the load-bearing scope note): the engine meters its OWN actions
 * (indexing, visual gate, media gen, scraping, publisher calls) into the ledger; chain-seat LLM
 * spend (writer/gate/matcher tokens) is HOST-RUNTIME-owned and the engine is blind to it unless the
 * runtime reports per-run cost (§3.2 #7). Until P6-SPEND wires the ledger-backed cap evaluation,
 * status reports spend as *engine-metered only (partial)* and states the regime explicitly — never
 * implying a whole-system ceiling the engine cannot enforce (§15.4).
 *
 * Read-only + tolerant: every substrate read degrades to "unavailable" rather than throwing, so
 * status works on a half-set-up instance (the "where am I" use). Tier-3 cleanliness (§0.3 r6): no
 * hardcoded paths/ids/codenames; everything via paths.js + the engine modules.
 */

const fs = require('fs');

const paths = require('../shared/paths');
const secrets = require('../shared/secrets');
const queue = require('../shared/queue');
const dispatchMod = require('../orchestrator/dispatch');
const ledger = require('../orchestrator/workflow-ledger');
const setupState = require('../setup/setup-state');
const util = require('./util');

const HELP = `engine status

The one-command operational surface (§13.1): mode + paused state, queue state counts (oldest age),
today's produced/published/failed with failure-code tallies, last run per named trigger (DD-19),
pending task records, a wiring self-check, and the honestly-scoped spend line (RD-19 —
engine-metered actions; chain-seat LLM spend is host-runtime-owned unless reported).

  --json           emit the full structured status object.
  -h, --help       show this help.`;

const ISO_DAY = () => new Date().toISOString().slice(0, 10);

/** Read + parse the queue, returning per-state counts and the oldest awaiting-approval age. */
function queueSummary(env) {
  let raw;
  try {
    raw = fs.readFileSync(queue.queueFilePath(env), 'utf8');
  } catch {
    return { available: false, total: 0, by_state: {}, oldest: null };
  }
  const entries = queue.parseQueue(raw);
  const byState = {};
  let oldest = null;
  const now = Date.now();
  for (const e of entries) {
    const state = e.fields.state || 'unknown';
    byState[state] = (byState[state] || 0) + 1;
    const created = Date.parse(e.fields.created_at || e.fields.state_updated_at || '');
    if (Number.isFinite(created)) {
      const ageH = Math.round((now - created) / 3600000);
      if (!oldest || ageH > oldest.age_hours) oldest = { content_id: e.fields.content_id || e.header, state, age_hours: ageH };
    }
  }
  return { available: true, total: entries.length, by_state: byState, oldest };
}

/** Walk events.jsonl once: last run per trigger + today's produced/published/failed + code tallies. */
function ledgerSummary(env) {
  const out = {
    available: false,
    last_run_by_trigger: {},
    today: { date: ISO_DAY(), produced: 0, published: 0, failed: 0 },
    failure_codes: {},
  };
  let raw;
  try {
    raw = fs.readFileSync(ledger.eventsPath(env), 'utf8');
  } catch {
    return out;
  }
  out.available = true;
  const today = out.today.date;
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let ev;
    try { ev = JSON.parse(t); } catch { continue; }
    const day = String(ev.ts || '').slice(0, 10);

    // Last run per named trigger (DD-19): run_dispatched / run_dispatch_failed carry .trigger.
    if ((ev.event_type === 'run_dispatched' || ev.event_type === 'run_dispatch_failed') && ev.trigger) {
      const prev = out.last_run_by_trigger[ev.trigger];
      if (!prev || String(ev.ts) > String(prev.at)) {
        out.last_run_by_trigger[ev.trigger] = { at: ev.ts, outcome: ev.event_type === 'run_dispatch_failed' ? 'failed' : 'dispatched', content_id: ev.content_id || null };
      }
    }

    if (day !== today) continue;
    if (ev.event_type === 'queued_awaiting_approval' || ev.event_type === 'packaged') out.today.produced += 1;
    if (ev.event_type === 'published' || (ev.queue_state === 'published')) out.today.published += 1;
    if (/fail|hard_failed|dead_letter/iu.test(ev.event_type || '')) out.today.failed += 1;
    // Failure-code tallies (codes ride on gate/package-fail events as arrays of {code} or strings).
    const codes = Array.isArray(ev.failures) ? ev.failures : (Array.isArray(ev.detected_codes) ? ev.detected_codes : null);
    if (codes) {
      for (const c of codes) {
        const code = typeof c === 'string' ? c : (c && c.code);
        if (code) out.failure_codes[code] = (out.failure_codes[code] || 0) + 1;
      }
    }
  }
  return out;
}

/** The wiring self-check (the generalized verify-wiring pattern — §13.1 / §15.1). */
function wiringSelfCheck(env, config) {
  const checks = [];
  const push = (name, ok, detail) => checks.push({ name, ok, detail });

  let home = null;
  try { home = paths.contentHome(env); push('content_home', true, home); }
  catch (e) { push('content_home', false, e.message); }

  const hasConfig = config && typeof config === 'object' && Object.keys(config).length > 0;
  push('config_present', hasConfig, hasConfig ? `mode=${config.mode || 'unset'}` : 'config/system.json missing or empty');

  const reviewersOk = Array.isArray(config.reviewers) && config.reviewers.some((r) => r && Array.isArray(r.rights) && r.rights.includes('approve'));
  push('reviewers', reviewersOk, reviewersOk ? 'allowlist has an approver (DD-17)' : 'no reviewer with approve rights (DD-17)');

  // Credentials: name the variable, never the value (§15.1).
  const token = safeGetSecret('DISCORD_BOT_TOKEN', env);
  push('discord_token', Boolean(token), token ? 'present' : 'DISCORD_BOT_TOKEN missing (approval surface) — fail-fast §15.1');

  const pKey = safeGetSecret('POSTIZ_API_KEY', env);
  const pUrl = safeGetSecret('POSTIZ_API_URL', env);
  if (pKey && pUrl) push('publisher', true, 'Postiz creds present');
  else if (pKey || pUrl) push('publisher', false, 'Postiz partially configured (one of KEY/URL set)');
  else push('publisher', true, 'Postiz deferred (not required for SAFE/LIVE_PREVIEW — §2.3)');

  return checks;
}

function safeGetSecret(name, env) {
  try { return secrets.getSecret(name, { env }); } catch { return null; }
}

/**
 * @param {object} ctx  { flags, env, config }
 * @returns {{ ok, summary, detail?, data? }}
 */
function run(ctx = {}) {
  const flags = ctx.flags || {};
  if (util.flagOn(flags.help)) return { ok: true, summary: HELP.split('\n')[0], detail: HELP };

  const env = ctx.env || process.env;
  const config = ctx.config || util.loadSystemConfig(env);

  const modeVerdict = util.resolveModeWithNotice({ config, env });
  const paused = util.isPaused(env);
  const q = queueSummary(env);
  const lg = ledgerSummary(env);
  const wiring = wiringSelfCheck(env, config);
  let pending = [];
  try { pending = dispatchMod.listPending(env); } catch { pending = []; }
  let project_state = 'unknown';
  try { project_state = paused ? 'paused' : setupState.readSetupState(env).project_state; } catch { /* CONTENT_HOME unset */ }

  // Honest spend scope (RD-19 / §15.4): the engine meters its own actions; chain-seat LLM spend is
  // host-runtime-owned unless the runtime reports it. No P6-SPEND ledger yet → partial, by contract.
  const budget = config.budget || {};
  const spend = {
    scope: 'engine-metered only (partial)',
    note: 'Chain-seat LLM spend (writer/gate/matcher tokens) is host-runtime-owned and not metered here unless the runtime reports per-run cost (§3.2 #7 / RD-19). The monthly_cap bounds engine-metered actions + run dispatch, not whole-system spend (§15.4).',
    monthly_cap: budget.monthly_cap ?? null,
    daily_cap: budget.daily_cap ?? null,
    metered_total: null,
  };

  const wiringFails = wiring.filter((c) => !c.ok);
  const data = {
    mode: modeVerdict.mode,
    mode_source: modeVerdict.source,
    mode_notice: modeVerdict.notice,
    paused,
    project_state,
    queue: q,
    pending_tasks: pending.length,
    runs: lg.last_run_by_trigger,
    today: lg.today,
    failure_codes: lg.failure_codes,
    spend,
    wiring,
  };

  const stateBits = Object.entries(q.by_state).map(([s, n]) => `${s}:${n}`);
  const handedOff = q.by_state.handed_off ? ` (handed_off = ${q.by_state.handed_off} awaiting operator publish in the publisher — §8.3)` : '';
  const lastRuns = Object.entries(lg.last_run_by_trigger).map(([trig, r]) => `${trig}@${String(r.at).slice(0, 16)} ${r.outcome}`);

  return {
    ok: wiringFails.length === 0,
    summary: `mode ${modeVerdict.mode}${paused ? ' (PAUSED)' : ''} · project ${project_state} · queue ${q.total}${q.available ? '' : ' (n/a)'} · today produced ${lg.today.produced}/published ${lg.today.published}/failed ${lg.today.failed} · pending tasks ${pending.length}`,
    detail: [
      modeVerdict.notice ? `mode: ${modeVerdict.notice}` : null,
      `queue states: ${stateBits.length ? stateBits.join(', ') : '(empty)'}${handedOff}`,
      q.oldest ? `oldest queue item: ${q.oldest.content_id} (${q.oldest.state}, ${q.oldest.age_hours}h)` : null,
      `last runs: ${lastRuns.length ? lastRuns.join(' | ') : '(none recorded)'}`,
      Object.keys(lg.failure_codes).length ? `failure codes today: ${Object.entries(lg.failure_codes).map(([c, n]) => `${c}×${n}`).join(', ')}` : null,
      `spend: ${spend.scope}${spend.monthly_cap != null ? ` (monthly_cap ${spend.monthly_cap})` : ''} — ${spend.note}`,
      `wiring: ${wiring.map((c) => `${c.ok ? '✓' : '✗'} ${c.name}`).join(' ')}`,
      ...wiringFails.map((c) => `  ✗ ${c.name}: ${c.detail}`),
    ].filter(Boolean),
    data,
  };
}

module.exports = { run, HELP };
