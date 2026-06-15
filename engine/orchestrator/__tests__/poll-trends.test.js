'use strict';

/**
 * Tests for engine/orchestrator/poll-trends.js — the trend pathway's scheduling + chain wiring
 * (release-spec §8.8 trend pass; DD-16 RESERVED-slot fill, never out-of-calendar; §15.4 PAUSED;
 * DD-19 single-runner lock; RD-12 zero-key injectable provider + readout). Asserts:
 *   1. OFF BY DEFAULT — runTrendPass refuses (disabled) until config trends.enabled is true.
 *   2. an enabled pass with the fixture adapter dispatches one trend SEED per fresh report into a
 *      RESERVED trend slot, through the canonical dispatch transport (no chain fork).
 *   3. DD-16: a report with NO free reserved trend slot is `unslotted` (never out-of-calendar).
 *   4. the readout is built angles-only and the injected poster is called.
 *   5. PAUSED halts the pass (§15.4) — nothing dispatched.
 *   6. per-(date,report) dedup: a second pass the same day dispatches nothing new.
 *   7. the dispatched command carries the chain fields (slot_type=trend, content_form, trend_report).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const pollTrends = require('../poll-trends');
const dispatch = require('../dispatch');

const CALENDAR = `# Content Calendar

## Slots
| slot_id | brand | platform | day | time | pillar | content_type | command_family | format | slot_type | state | notes |
|---|---|---|---|---|---|---|---|---|---|---|---|
| acme-mon-01 | acme | twitter | Mon | 09:00 | lore | text | RUN_SLOT | text | regular | active | regular |
| acme-trend-01 | acme | twitter | Mon | 11:00 | trend | text | RUN_TREND_MANUAL | single tweet | trend | active | reserved trend |
`;

function tmpHome(withCalendar = true) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oce-polltrends-'));
  if (withCalendar) {
    fs.mkdirSync(path.join(home, 'calendar'), { recursive: true });
    fs.writeFileSync(path.join(home, 'calendar', 'calendar.md'), CALENDAR, 'utf8');
  }
  return home;
}

const ENABLED = { trends: { enabled: true, adapter: 'fixture', cadence: '4h' }, approval_surface: { channels: { 'trend-readout': '000000000000000099' } } };

test('OFF BY DEFAULT — runTrendPass refuses (disabled) until opt-in (the LAW)', async () => {
  const r = await pollTrends.runTrendPass({ env: { CONTENT_HOME: tmpHome() }, config: {} });
  assert.equal(r.ran, false);
  assert.equal(r.disabled, true);
  assert.equal(r.dispatched, 0);
});

test('enabled pass dispatches one trend seed into a RESERVED trend slot (DD-16, no chain fork)', async () => {
  const env = { CONTENT_HOME: tmpHome() };
  const r = await pollTrends.runTrendPass({ env, config: ENABLED, brand: 'acme' });
  assert.equal(r.ran, true);
  assert.equal(r.adapter, 'fixture');
  assert.ok(r.reports >= 1, 'fixture produced at least one report');
  assert.equal(r.dispatched, 1, 'one fresh report fills the one reserved trend slot');
  assert.equal(r.unslotted, 0);

  // It went through the canonical dispatch transport as a pending task (NOT a fork).
  const pending = dispatch.listPending(env);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].trigger, 'trend-poll');
  assert.equal(pending[0].slot_id, 'acme-trend-01');
  fs.rmSync(env.CONTENT_HOME, { recursive: true, force: true });
});

test('the dispatched command carries the chain fields (slot_type=trend, content_form, trend_report)', async () => {
  const env = { CONTENT_HOME: tmpHome() };
  await pollTrends.runTrendPass({ env, config: ENABLED, brand: 'acme' });
  const t = dispatch.listPending(env)[0];
  assert.equal(t.command.slot_type, 'trend');
  assert.equal(t.command.content_form, 'standalone');
  assert.ok(t.command.trend_report && Array.isArray(t.command.trend_report.topics), 'the Zone-U report rides on the command');
  assert.ok(t.command.pre_seed && t.command.pre_seed.angle, 'the matcher pre-seed angle is carried');
  assert.equal(t.command.provenance.trust_zone, 'U');
  fs.rmSync(env.CONTENT_HOME, { recursive: true, force: true });
});

test('DD-16: a report with no free reserved trend slot is unslotted, never out-of-calendar', async () => {
  // No reserved trend slot in the calendar → the report is written but not dispatched.
  const env = { CONTENT_HOME: tmpHome(false) };
  fs.mkdirSync(path.join(env.CONTENT_HOME, 'calendar'), { recursive: true });
  fs.writeFileSync(path.join(env.CONTENT_HOME, 'calendar', 'calendar.md'), `# Cal
## Slots
| slot_id | brand | platform | day | time | pillar | content_type | command_family | format | slot_type | state | notes |
|---|---|---|---|---|---|---|---|---|---|---|---|
| acme-mon-01 | acme | twitter | Mon | 09:00 | lore | text | RUN_SLOT | text | regular | active | only regular |
`, 'utf8');
  const r = await pollTrends.runTrendPass({ env, config: ENABLED, brand: 'acme' });
  assert.equal(r.dispatched, 0);
  assert.ok(r.unslotted >= 1, 'no reserved trend slot → unslotted (never out-of-calendar)');
  assert.equal(dispatch.listPending(env).length, 0);
  fs.rmSync(env.CONTENT_HOME, { recursive: true, force: true });
});

test('the readout is angles-only and the injected poster is called', async () => {
  const env = { CONTENT_HOME: tmpHome() };
  let postedText = null;
  let postedChannel = null;
  const r = await pollTrends.runTrendPass({
    env, config: ENABLED, brand: 'acme',
    postReadout: ({ text, channelId }) => { postedText = text; postedChannel = channelId; return { posted: true }; },
  });
  assert.ok(r.readout && r.readout.length > 0);
  assert.equal(postedText, r.readout, 'the readout text was handed to the poster');
  assert.equal(postedChannel, '000000000000000099', 'posted to the configured trend-readout channel');
  assert.ok(/angles only/i.test(r.readout), 'the readout is explicitly angles-only (§1.4)');
  fs.rmSync(env.CONTENT_HOME, { recursive: true, force: true });
});

test('PAUSED halts the pass (§15.4) — nothing dispatched', async () => {
  const home = tmpHome();
  fs.writeFileSync(path.join(home, 'PAUSED'), 'kill', 'utf8');
  const env = { CONTENT_HOME: home };
  const r = await pollTrends.runTrendPass({ env, config: ENABLED, brand: 'acme' });
  assert.equal(r.dispatched, 0);
  assert.ok(r.failed >= 1);
  assert.equal(dispatch.readAllTasks(env).length, 0);
  fs.rmSync(home, { recursive: true, force: true });
});

test('per-(date,slot) dedup: a second pass the same day dispatches nothing new', async () => {
  // Use real time (no injected `now`) so the freshly-polled fixture report is always within its
  // freshness window; both passes share the same ISO date, exercising the per-(date,slot) dedup.
  const env = { CONTENT_HOME: tmpHome() };
  const first = await pollTrends.runTrendPass({ env, config: ENABLED, brand: 'acme' });
  assert.equal(first.dispatched, 1);
  const again = await pollTrends.runTrendPass({ env, config: ENABLED, brand: 'acme' });
  assert.equal(again.dispatched, 0);
  assert.ok(again.skipped >= 1, 'the reserved trend slot filled today is not refilled (dedup)');
  assert.equal(dispatch.readAllTasks(env).length, 1, 'no duplicate task');
  fs.rmSync(env.CONTENT_HOME, { recursive: true, force: true });
});

test('dry-run selects + builds the readout but writes/dispatches nothing', async () => {
  const env = { CONTENT_HOME: tmpHome() };
  const r = await pollTrends.runTrendPass({ env, config: ENABLED, brand: 'acme', dryRun: true });
  assert.ok(r.dispatched >= 1, 'selection happens');
  assert.ok(r.tasks.every((t) => t.dry_run));
  assert.equal(dispatch.readAllTasks(env).length, 0, 'no task records written');
  assert.equal(fs.existsSync(path.join(env.CONTENT_HOME, 'trends')), false, 'no reports written in dry-run');
  fs.rmSync(env.CONTENT_HOME, { recursive: true, force: true });
});

test('--force runs a trend pass even when trends.enabled is false', async () => {
  const env = { CONTENT_HOME: tmpHome() };
  const config = { trends: { enabled: false, adapter: 'fixture' } };
  const r = await pollTrends.runTrendPass({ env, config, brand: 'acme', force: true });
  assert.equal(r.ran, true);
  assert.ok(r.dispatched >= 1);
  fs.rmSync(env.CONTENT_HOME, { recursive: true, force: true });
});
