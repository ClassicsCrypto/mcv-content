'use strict';

/**
 * tests/cli-tick.test.js  [N — new tests, TICK-WIRING]
 *
 * Covers the `engine tick` CLI verb (engine/cli/tick.js) — the optional intra-day calendar trigger
 * (release-spec §8.4 / RD-14). Two regression guards for the gaps this verb closes:
 *   GAP #1 — the tick is actually RUNNABLE: enabling scheduler.tick_enabled + running `engine tick`
 *     dispatches a due slot end-to-end (before this wiring, runTick had no CLI entry point, so the
 *     config flag was a no-op).
 *   GAP #2 — the scheduler schema ACCEPTS the tick's tuning fields (lookahead_minutes/min_gap_minutes/
 *     utc_offset_minutes/daily_max/timezone) the code reads, while still rejecting unknown fields.
 *
 * Deterministic + zero-key: a throwaway CONTENT_HOME with a slot due "now" (computed from the real
 * clock, with a generous look-ahead so it is always in-window). The precise tick math is covered by
 * engine/orchestrator/__tests__/scheduler.test.js (which injects a fixed clock).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tickVerb = require('../engine/cli/tick.js');
const engine = require('../bin/engine.js');
const paths = require('../engine/shared/paths.js');
const { validate } = require('../scripts/validate-schemas.js');
const SYSTEM_SCHEMA = require('../schemas/config/system.schema.json');

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function tickConfig(extra = {}) {
  return {
    schema_version: '1.0.0', mode: 'SAFE',
    reviewers: [{ id: '111', name: 'L', rights: ['approve', 'edit'] }],
    budget: { monthly_cap: 50, daily_cap: 5, per_item_generation_limit: 1, indexing_requires_estimate: true },
    publish: { draft_only: true, auto_publish_allowed: false },
    approval_surface: { adapter: 'discord', channels: { 'content-review': '100', 'content-published': '200', 'content-ops': '300', 'media-bank': '400' } },
    scheduler: { kickoff_time: '09:00', tick_enabled: true, lookahead_minutes: 240, ...extra },
  };
}

/** Build a temp instance with a calendar holding ONE active slot due "now" (UTC). */
function instanceWithDueSlot(cfg) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oce-tick-'));
  const env = { CONTENT_HOME: home };
  require('../engine/setup/init.js').initHome({ home, env });
  fs.writeFileSync(path.join(home, 'config', 'system.json'), JSON.stringify(cfg, null, 2));
  const now = new Date();
  const dow = DAYS[now.getUTCDay()];
  const hhmm = `${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}`;
  const cal = [
    '# Calendar', '', '## Slots',
    '| slot_id | brand | platform | day | time | pillar | content_type | command_family | format | slot_type | state | notes |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|',
    `| demo-now | demo | twitter | ${dow} | ${hhmm} | P1 | text | RUN_SLOT | single | standard | active |  |`,
    '',
  ].join('\n');
  fs.mkdirSync(path.join(home, 'calendar'), { recursive: true });
  fs.writeFileSync(path.join(home, 'calendar', 'calendar.md'), cal);
  return { home, env };
}

// ---------------------------------------------------------------------------
// GAP #1 — the verb is wired + runnable
// ---------------------------------------------------------------------------

test('tick OFF by default: returns ok + exit 0 with the disabled notice, dispatches nothing', async () => {
  const { home, env } = instanceWithDueSlot(tickConfig({ tick_enabled: false }));
  const res = await tickVerb.run({ flags: {}, env });
  assert.equal(res.ok, true);
  assert.notEqual(res.exitCode, 1);
  assert.equal(res.data.disabled, true);
  assert.match(res.summary, /OFF by default/i);
  fs.rmSync(home, { recursive: true, force: true });
});

test('tick ENABLED dispatches a due slot end-to-end (the gap-1 regression guard)', async () => {
  const { home, env } = instanceWithDueSlot(tickConfig());
  const res = await tickVerb.run({ flags: {}, env });
  assert.equal(res.ok, true);
  assert.ok(res.data.ran !== false, 'tick must actually run when enabled');
  assert.ok(res.data.dispatched >= 1, `expected >=1 dispatched, got ${res.data.dispatched} (due ${res.data.due}, failed ${res.data.failed})`);
  // a calendar-tick task record landed in the ledger
  const tasks = fs.readdirSync(path.join(home, 'ledger', 'tasks'));
  assert.ok(tasks.some((f) => f.includes('calendar-tick')), `expected a calendar-tick task record, saw ${tasks.join(',')}`);
  fs.rmSync(home, { recursive: true, force: true });
});

test('tick re-run does not re-dispatch the same slot (dedup state persists across runs)', async () => {
  const { home, env } = instanceWithDueSlot(tickConfig());
  const first = await tickVerb.run({ flags: {}, env });
  assert.ok(first.data.dispatched >= 1);
  const again = await tickVerb.run({ flags: {}, env });
  // The weekly dedup (tick_fires) filters the already-fired slot out before dispatch, so the
  // guarantee is simply: nothing is re-dispatched on the second run.
  assert.equal(again.data.dispatched, 0, 'second tick must not re-dispatch the already-fired slot');
  fs.rmSync(home, { recursive: true, force: true });
});

test('tick --force runs even when tick_enabled is false', async () => {
  const { home, env } = instanceWithDueSlot(tickConfig({ tick_enabled: false }));
  const res = await tickVerb.run({ flags: { force: true }, env });
  assert.ok(res.data.ran !== false && !res.data.disabled, 'force must bypass the off-by-default gate');
  fs.rmSync(home, { recursive: true, force: true });
});

test('dispatcher routes `tick` and exits 0; --help works', async () => {
  const { home } = instanceWithDueSlot(tickConfig({ tick_enabled: false }));
  const origHome = process.env.CONTENT_HOME;
  process.env.CONTENT_HOME = home;
  const chunks = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (c) => { chunks.push(String(c)); return true; };
  let code;
  try { code = await engine.main(['node', 'engine', 'tick']); }
  finally { process.stdout.write = origWrite; if (origHome === undefined) delete process.env.CONTENT_HOME; else process.env.CONTENT_HOME = origHome; }
  assert.equal(code, 0);
  assert.match(chunks.join(''), /tick/i);
  const help = await tickVerb.run({ flags: { help: true } });
  assert.match(help.detail, /intra-day calendar tick/i);
  fs.rmSync(home, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// GAP #2 — schema accepts the tick tuning fields, still rejects unknowns
// ---------------------------------------------------------------------------

test('scheduler schema accepts the tick tuning fields the code reads', () => {
  const cfg = tickConfig({ lookahead_minutes: 90, min_gap_minutes: 20, utc_offset_minutes: -240, daily_max: 6, timezone: 'America/Toronto' });
  const res = validate(cfg, SYSTEM_SCHEMA);
  assert.ok(res.ok, `config with tick tuning fields must validate — errors:\n${res.errors.join('\n')}`);
});

test('scheduler schema still rejects an unknown field (additionalProperties:false holds)', () => {
  const cfg = tickConfig();
  cfg.scheduler.totally_bogus_field = 1;
  const res = validate(cfg, SYSTEM_SCHEMA);
  assert.equal(res.ok, false, 'an unknown scheduler field must be rejected');
});
