'use strict';

/**
 * Tests for engine/orchestrator/scheduler.js (release-spec §8.4; RD-14 tick off-by-default;
 * RD-18 dispatch; DD-19 shared dedup with kickoff — no double-dispatch). Zero-key, injected env.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const scheduler = require('../scheduler');
const kickoff = require('../kickoff');
const dispatch = require('../dispatch');

// Fixed "now": Monday 2026-06-15 08:30 UTC. The 09:00 Mon slot is due within a 2h look-ahead.
const NOW = new Date('2026-06-15T08:30:00Z');
const MON_ISO = '2026-06-15';

const CALENDAR = `# Content Calendar

## Slots
| slot_id | brand | platform | day | time | pillar | content_type | command_family | format | slot_type | state | notes |
|---|---|---|---|---|---|---|---|---|---|---|---|
| acme-mon-01 | acme | Twitter/X | Mon | 09:00 | lore | text | RUN_SLOT | text | regular | active | due soon |
| acme-mon-02 | acme | Twitter/X | Mon | 23:00 | community | text | RUN_SLOT | text | regular | active | far away |
`;

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oce-sched-'));
  fs.mkdirSync(path.join(home, 'calendar'), { recursive: true });
  fs.writeFileSync(path.join(home, 'calendar', 'calendar.md'), CALENDAR, 'utf8');
  return home;
}

test('tick is OFF by default (RD-14): refuses unless scheduler.tick_enabled', async () => {
  const env = { CONTENT_HOME: tmpHome() };
  const r = await scheduler.runTick({ env, now: NOW, config: {} });
  assert.equal(r.ran, false);
  assert.equal(r.disabled, true);
  assert.match(r.reason, /OFF by default/i);
  assert.equal(dispatch.readAllTasks(env).length, 0);
});

test('enabled tick dispatches only slots due within the look-ahead window', async () => {
  const env = { CONTENT_HOME: tmpHome() };
  const config = { scheduler: { tick_enabled: true } };
  const r = await scheduler.runTick({ env, now: NOW, config });
  assert.equal(r.ran, true);
  assert.equal(r.dispatched, 1); // only the 09:00 slot is within 2h of 08:30
  const pending = dispatch.listPending(env);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].slot_id, 'acme-mon-01');
  assert.equal(pending[0].trigger, 'calendar-tick');
});

test('force runs the tick even when disabled (operator/test path)', async () => {
  const env = { CONTENT_HOME: tmpHome() };
  const r = await scheduler.runTick({ env, now: NOW, config: {}, force: true });
  assert.equal(r.ran, true);
  assert.equal(r.dispatched, 1);
});

test('CALENDAR_DRY_RUN=1 selects but writes nothing', async () => {
  const env = { CONTENT_HOME: tmpHome(), CALENDAR_DRY_RUN: '1' };
  const config = { scheduler: { tick_enabled: true } };
  const r = await scheduler.runTick({ env, now: NOW, config });
  assert.equal(r.ran, true);
  assert.equal(r.dispatched, 1);
  assert.equal(dispatch.readAllTasks(env).length, 0); // dry-run wrote no records
});

test('shared dedup with kickoff: a slot kickoff already fired today is NOT re-dispatched by the tick (no double-post)', async () => {
  const env = { CONTENT_HOME: tmpHome() };
  // Kickoff fires the Monday slots first (writes the shared (date,slot) dedup state).
  await kickoff.runKickoff({ env, date: MON_ISO });
  const afterKickoff = dispatch.readAllTasks(env).length;
  assert.ok(afterKickoff >= 1);

  // Now the tick runs for the same window — the 09:00 slot is already fired, so it skips it.
  const config = { scheduler: { tick_enabled: true } };
  const r = await scheduler.runTick({ env, now: NOW, config });
  assert.equal(r.dispatched, 0);
  assert.ok(r.skipped >= 1);
});

test('weekly dedup: a tick that already fired a slot this week does not re-fire it', async () => {
  const env = { CONTENT_HOME: tmpHome() };
  const config = { scheduler: { tick_enabled: true } };
  const first = await scheduler.runTick({ env, now: NOW, config });
  assert.equal(first.dispatched, 1);
  const second = await scheduler.runTick({ env, now: NOW, config });
  assert.equal(second.dispatched, 0); // weekly dedup holds
});

test('nextOccurrence honors a configured UTC offset', () => {
  // With offset 0 (UTC), Mon 09:00 from a Mon 08:30 base is ~30m ahead.
  const next = scheduler.nextOccurrence('Mon', '09:00', NOW, 0);
  assert.ok(next instanceof Date);
  assert.equal(next.toISOString(), '2026-06-15T09:00:00.000Z');
});

test('scheduler re-exports the canonical daily kickoff (RD-14)', () => {
  assert.equal(typeof scheduler.runKickoff, 'function');
  assert.equal(scheduler.runKickoff, kickoff.runKickoff);
});
