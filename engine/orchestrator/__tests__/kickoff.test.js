'use strict';

/**
 * Tests for engine/orchestrator/kickoff.js (release-spec §8.4 canonical daily kickoff; RD-14;
 * RD-18 task-record dispatch; DD-19 lock + idempotent re-run; §15.4 PAUSED).
 * Zero-key, CONTENT_HOME-injected temp dirs.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const kickoff = require('../kickoff');
const dispatch = require('../dispatch');

// 2026-06-15 is a Monday (Sun=14). Calendar day names use Sun..Sat.
const MON_ISO = '2026-06-15';

const CALENDAR = `# Content Calendar

## Slots
| slot_id | brand | platform | day | time | pillar | content_type | command_family | format | slot_type | state | notes |
|---|---|---|---|---|---|---|---|---|---|---|---|
| acme-mon-01 | acme | Twitter/X | Mon | 09:00 | lore | text | RUN_SLOT | text | regular | active | morning |
| acme-mon-02 | acme | Twitter/X | Mon | 12:00 | community | text | RUN_SLOT | text | regular | active | noon |
| acme-mon-03 | acme | Twitter/X | Mon | 15:00 | events | text | RUN_SLOT | text | regular | dormant | off |
| acme-tue-01 | acme | Twitter/X | Tue | 09:00 | lore | text | RUN_SLOT | text | regular | active | other day |
`;

function tmpHome(withCalendar = true) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oce-kickoff-'));
  if (withCalendar) {
    fs.mkdirSync(path.join(home, 'calendar'), { recursive: true });
    fs.writeFileSync(path.join(home, 'calendar', 'calendar.md'), CALENDAR, 'utf8');
  }
  return home;
}

test('parseSlots reads the §6.5 public column set', () => {
  const slots = kickoff.parseSlots(CALENDAR);
  assert.equal(slots.length, 4);
  assert.equal(slots[0].slot_id, 'acme-mon-01');
  assert.equal(slots[0].brand, 'acme');
  assert.equal(slots[0].command_family, 'RUN_SLOT');
  assert.equal(slots[0].state, 'active');
});

test('selectSlots picks active slots for the day, sorted by time', () => {
  const slots = kickoff.parseSlots(CALENDAR);
  const sel = kickoff.selectSlots(slots, MON_ISO);
  assert.deepEqual(sel.map((s) => s.slot_id), ['acme-mon-01', 'acme-mon-02']); // dormant + tue excluded
});

test('runKickoff dispatches one pending task per selected slot (RD-18)', async () => {
  const env = { CONTENT_HOME: tmpHome() };
  const r = await kickoff.runKickoff({ env, date: MON_ISO });
  assert.equal(r.ran, true);
  assert.equal(r.eligible, 2);
  assert.equal(r.dispatched, 2);
  const pending = dispatch.listPending(env);
  assert.equal(pending.length, 2);
  assert.ok(pending.every((t) => t.trigger === 'morning-kickoff'));
  assert.ok(pending.every((t) => t.mode === 'SAFE')); // default SAFE (RD-16f)
});

test('--max bounds the day batch', async () => {
  const env = { CONTENT_HOME: tmpHome() };
  const r = await kickoff.runKickoff({ env, date: MON_ISO, max: 1 });
  assert.equal(r.dispatched, 1);
  assert.equal(dispatch.listPending(env).length, 1);
});

test('idempotent re-run: a second kickoff for the same date dispatches nothing new', async () => {
  const env = { CONTENT_HOME: tmpHome() };
  await kickoff.runKickoff({ env, date: MON_ISO });
  const again = await kickoff.runKickoff({ env, date: MON_ISO });
  assert.equal(again.dispatched, 0);
  assert.equal(again.skipped, 2); // both already fired today
  assert.equal(dispatch.readAllTasks(env).length, 2); // no duplicates
});

test('dry-run selects but writes no records and no state', async () => {
  const env = { CONTENT_HOME: tmpHome() };
  const r = await kickoff.runKickoff({ env, date: MON_ISO, dryRun: true });
  assert.equal(r.dispatched, 2);
  assert.equal(dispatch.readAllTasks(env).length, 0);
  assert.equal(fs.existsSync(kickoff.kickoffStatePath(env)), false);
});

test('PAUSED halts the batch (§15.4) — first dispatch preflight fails, nothing written', async () => {
  const home = tmpHome();
  fs.writeFileSync(path.join(home, 'PAUSED'), 'kill', 'utf8');
  const env = { CONTENT_HOME: home };
  const r = await kickoff.runKickoff({ env, date: MON_ISO });
  assert.equal(r.dispatched, 0);
  assert.equal(r.failed, 1); // halts on the first slot's preflight
  assert.equal(dispatch.readAllTasks(env).length, 0);
});

test('mode override flows through to the dispatched records', async () => {
  const env = { CONTENT_HOME: tmpHome() };
  const r = await kickoff.runKickoff({ env, date: MON_ISO, mode: 'LIVE_PREVIEW' });
  assert.equal(r.mode, 'LIVE_PREVIEW');
  assert.ok(dispatch.listPending(env).every((t) => t.mode === 'LIVE_PREVIEW'));
});

test('absent calendar yields zero eligible (a fresh instance)', async () => {
  const env = { CONTENT_HOME: tmpHome(false) };
  const r = await kickoff.runKickoff({ env, date: MON_ISO });
  assert.equal(r.eligible, 0);
  assert.equal(r.dispatched, 0);
});

test('campaign overlay rides onto the dispatched record as pre-seed (§8.7)', async () => {
  const home = tmpHome();
  fs.mkdirSync(path.join(home, 'campaigns'), { recursive: true });
  fs.writeFileSync(path.join(home, 'campaigns', 'launch.md'), `# Campaign: Launch
- campaign_id: acme-launch
- brand: acme
- platforms: Twitter/X
- start_date: 2026-06-14
- end_date: 2026-06-20
- slot_pattern: acme-mon-01

## Goal
Launch awareness.

## Day-by-day themes
- ${MON_ISO}: "Launch push"
`, 'utf8');
  const env = { CONTENT_HOME: home };
  await kickoff.runKickoff({ env, date: MON_ISO });
  const claimed = dispatch.listPending(env).find((t) => t.slot_id === 'acme-mon-01');
  assert.ok(claimed.command.pre_seed);
  assert.equal(claimed.command.pre_seed.campaign_id, 'acme-launch');
  assert.equal(claimed.command.pre_seed.theme, 'Launch push');
});
