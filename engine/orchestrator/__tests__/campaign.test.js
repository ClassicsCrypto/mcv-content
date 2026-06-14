'use strict';

/**
 * Tests for engine/orchestrator/campaign.js (release-spec §8.7 campaign mechanics; DD-16
 * no-out-of-calendar; earliest-start-wins). Zero-key, CONTENT_HOME-injected temp campaign files.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const campaign = require('../campaign');

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oce-campaign-'));
  fs.mkdirSync(path.join(home, 'campaigns'), { recursive: true });
  return home;
}

function writeCampaign(home, file, body) {
  fs.writeFileSync(path.join(home, 'campaigns', file), body, 'utf8');
}

const SLOT = { slot_id: 'acme-tue-01', brand: 'acme', platform: 'Twitter/X' };

const LAUNCH = `# Campaign: Acme Launch
- campaign_id: acme-launch
- brand: acme
- platforms: Twitter/X
- start_date: 2026-06-10
- end_date: 2026-06-20
- slot_pattern: acme-*

## Goal
Drive launch awareness.

## Day-by-day themes
- 2026-06-14: "Launch day push"
- 2026-06-15: "Day two recap"
`;

test('globToRegExp: only * is a wildcard; other metachars are literal', () => {
  assert.equal(campaign.globToRegExp('acme-*').test('acme-tue-01'), true);
  assert.equal(campaign.globToRegExp('acme-tue-*').test('acme-mon-01'), false);
  assert.equal(campaign.globToRegExp('acme-tue-01').test('acme-tue-01'), true);
  // a dot in the pattern is literal, not "any char"
  assert.equal(campaign.globToRegExp('a.b').test('axb'), false);
});

test('loadCampaigns reads $CONTENT_HOME/campaigns and sorts earliest-start first', () => {
  const home = tmpHome();
  const env = { CONTENT_HOME: home };
  writeCampaign(home, 'b-later.md', LAUNCH.replace('acme-launch', 'later').replace('2026-06-10', '2026-06-12'));
  writeCampaign(home, 'a-earlier.md', LAUNCH.replace('acme-launch', 'earlier').replace('2026-06-10', '2026-06-08').replace('2026-06-20', '2026-06-22'));
  const cs = campaign.loadCampaigns({ env });
  assert.equal(cs.length, 2);
  assert.equal(cs[0].id, 'earlier'); // earliest start first
});

test('loadCampaigns skips README, _disabled, and non-active state', () => {
  const home = tmpHome();
  const env = { CONTENT_HOME: home };
  writeCampaign(home, 'README.md', '# Campaigns\n');
  writeCampaign(home, '_paused.md', LAUNCH);
  writeCampaign(home, 'inactive.md', LAUNCH.replace('## Goal', '- state: draft\n\n## Goal'));
  writeCampaign(home, 'live.md', LAUNCH);
  const cs = campaign.loadCampaigns({ env });
  assert.equal(cs.length, 1);
  assert.equal(cs[0].id, 'acme-launch');
});

test('claimSlot: matching slot in window returns campaign + that day theme + goals (pre-seed)', () => {
  const home = tmpHome();
  const env = { CONTENT_HOME: home };
  writeCampaign(home, 'launch.md', LAUNCH);
  const cs = campaign.loadCampaigns({ env });
  const claim = campaign.claimSlot(SLOT, '2026-06-14', cs);
  assert.ok(claim);
  assert.equal(claim.campaign_id, 'acme-launch');
  assert.equal(claim.theme, 'Launch day push');
  assert.match(claim.messaging_goals, /launch awareness/i);
});

test('claimSlot: outside the window does not claim', () => {
  const home = tmpHome();
  const env = { CONTENT_HOME: home };
  writeCampaign(home, 'launch.md', LAUNCH);
  const cs = campaign.loadCampaigns({ env });
  assert.equal(campaign.claimSlot(SLOT, '2026-07-01', cs), null);
});

test('claimSlot: in-window slot with no theme line still claims (goals as pre-seed)', () => {
  const home = tmpHome();
  const env = { CONTENT_HOME: home };
  writeCampaign(home, 'launch.md', LAUNCH);
  const cs = campaign.loadCampaigns({ env });
  const claim = campaign.claimSlot(SLOT, '2026-06-16', cs); // in window, no theme for that date
  assert.ok(claim);
  assert.equal(claim.theme, null);
  assert.match(claim.messaging_goals, /launch awareness/i);
});

test('earliest start wins on overlapping claims (§8.7)', () => {
  const home = tmpHome();
  const env = { CONTENT_HOME: home };
  writeCampaign(home, 'late.md', LAUNCH.replace('acme-launch', 'late').replace('start_date: 2026-06-10', 'start_date: 2026-06-13'));
  writeCampaign(home, 'early.md', LAUNCH.replace('acme-launch', 'early').replace('start_date: 2026-06-10', 'start_date: 2026-06-09'));
  const cs = campaign.loadCampaigns({ env });
  const claim = campaign.claimSlot(SLOT, '2026-06-14', cs);
  assert.equal(claim.campaign_id, 'early');
});

test('brand + slot_pattern mismatch does not claim (de-localized account→brand)', () => {
  const home = tmpHome();
  const env = { CONTENT_HOME: home };
  writeCampaign(home, 'launch.md', LAUNCH);
  const cs = campaign.loadCampaigns({ env });
  assert.equal(campaign.claimSlot({ slot_id: 'other-tue-01', brand: 'other', platform: 'Twitter/X' }, '2026-06-14', cs), null);
});

test('parseCampaign reads the production account field as brand (rename map)', () => {
  const c = campaign.parseCampaign(LAUNCH.replace('- brand: acme', '- account: acme'), 'legacy.md');
  assert.equal(c.brand, 'acme');
});

test('claimedSlotsFor resolves a named campaign\'s claimed slots (RUN_CAMPAIGN)', () => {
  const home = tmpHome();
  const env = { CONTENT_HOME: home };
  writeCampaign(home, 'launch.md', LAUNCH);
  const cs = campaign.loadCampaigns({ env });
  const slots = [SLOT, { slot_id: 'other-x', brand: 'other', platform: 'Twitter/X' }];
  const claimed = campaign.claimedSlotsFor('acme-launch', slots, '2026-06-14', cs);
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].slot.slot_id, 'acme-tue-01');
});
