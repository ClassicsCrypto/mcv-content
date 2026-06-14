'use strict';

/**
 * tests/usage-log.test.js  [A — new tests]
 *
 * Covers the canonical cooldown ledger (engine/library/usage-log.js; release-spec §7.8, §8.6;
 * DD-14): append-only recordUse, isInCooldown / cooldownStatus 14/30-day semantics, family /
 * descendant matching, and second-gate reconcileRemove. The production module shipped with no
 * direct tests for these — this closes that gap (release-spec §16.2 cooldown round-trip).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const usageLog = require('../engine/library/usage-log.js');

const DAY = 24 * 60 * 60 * 1000;

/** A throwaway CONTENT_HOME for one test. */
function tempHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oce-usage-'));
  return { CONTENT_HOME: dir };
}

function iso(msAgo, now = Date.now()) {
  return new Date(now - msAgo).toISOString();
}

test('recordUse appends one JSONL line per use and requires asset_id + content_id', () => {
  const env = tempHome();
  usageLog.recordUse({ asset_id: 'library/media/cat-01.png', content_id: 'c-1', platform: 'twitter' }, { env });
  usageLog.recordUse({ asset_id: 'library/media/cat-02.png', content_id: 'c-2' }, { env });

  const rows = usageLog.readLedger(env);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].content_id, 'c-1');
  assert.equal(rows[0].platform, 'twitter');
  // asset_id is normalized (leading library/ stripped).
  assert.equal(rows[0].asset_id, 'media/cat-01.png');

  assert.throws(() => usageLog.recordUse({ content_id: 'x' }, { env }), /asset_id is required/);
  assert.throws(() => usageLog.recordUse({ asset_id: 'a.png' }, { env }), /content_id is required/);
});

test('isInCooldown enforces the 14-day hard floor', () => {
  const env = tempHome();
  const now = Date.now();
  usageLog.recordUse({ asset_id: 'media/a.png', content_id: 'c-1', used_at: iso(5 * DAY, now) }, { env });

  // Used 5 days ago: inside the 14-day floor ⇒ blocked.
  assert.equal(usageLog.isInCooldown('media/a.png', 14, { now, env }), true);
  // A different, never-used asset is free.
  assert.equal(usageLog.isInCooldown('media/b.png', 14, { now, env }), false);
});

test('cooldown clears after the hard floor passes; 30-day window still counts the use', () => {
  const env = tempHome();
  const now = Date.now();
  usageLog.recordUse({ asset_id: 'media/a.png', content_id: 'c-1', used_at: iso(20 * DAY, now) }, { env });

  // 20 days ago: clears the 14-day hard floor ⇒ no longer blocked.
  assert.equal(usageLog.isInCooldown('media/a.png', 14, { now, env }), false);
  // But still inside the 30-day target window (recentUseCount over 30d sees it).
  assert.equal(usageLog.recentUseCount('media/a.png', 30, { now, env }), 1);
  assert.equal(usageLog.recentUseCount('media/a.png', 14, { now, env }), 0);
});

test('cooldownStatus shape mirrors the retrieval-result cooldown_status block', () => {
  const env = tempHome();
  const now = Date.now();
  usageLog.recordUse(
    { asset_id: 'media/a.png', content_id: 'c-1', platform: 'instagram', used_at: iso(3 * DAY, now) },
    { env },
  );
  const status = usageLog.cooldownStatus('media/a.png', { hardDays: 14, now, env });

  assert.equal(status.eligible, false);
  assert.equal(status.cooldown_blocked, true);
  assert.equal(status.cooldown_days, 14);
  assert.equal(status.recent_use_count, 1);
  assert.equal(status.days_since_last_use, 3);
  assert.ok(status.last_use);
  assert.equal(status.last_use.content_id, 'c-1');
  assert.equal(status.last_use.platform, 'instagram');
  assert.equal(status.last_use.match_reason, usageLog.MATCH_REASON.ASSET);
});

test('family/descendant matching: a derivative inherits the ancestor cooldown (DR W#48)', () => {
  const env = tempHome();
  const now = Date.now();
  // The original asset was used 2 days ago.
  usageLog.recordUse({ asset_id: 'media/launch/hero.png', content_id: 'c-1', used_at: iso(2 * DAY, now) }, { env });

  // A platform/size derivative of the same asset must be blocked too.
  assert.equal(usageLog.isInCooldown('media/launch/exports/hero-twitter-1600x900.png', 14, { now, env }), true);
  const status = usageLog.cooldownStatus('media/launch/optimized/hero-1080.png', { hardDays: 14, now, env });
  assert.equal(status.cooldown_blocked, true);
  assert.ok(['asset_family', 'base_asset_family'].includes(status.last_use.match_reason));

  // An unrelated asset in a different family is free.
  assert.equal(usageLog.isInCooldown('media/event/banner.png', 14, { now, env }), false);
});

test('base_asset_id ties a modified output back to its source for cooldown', () => {
  const env = tempHome();
  const now = Date.now();
  usageLog.recordUse(
    { asset_id: 'media/derived/edit-final.png', base_asset_id: 'media/source/orig.png', content_id: 'c-1', used_at: iso(1 * DAY, now) },
    { env },
  );
  // Querying the SOURCE finds the use via base_asset_id.
  assert.equal(usageLog.isInCooldown('media/source/orig.png', 14, { now, env }), true);
});

test('excludeContentId lets a re-gate of the same item not block itself', () => {
  const env = tempHome();
  const now = Date.now();
  usageLog.recordUse({ asset_id: 'media/a.png', content_id: 'c-1', used_at: iso(1 * DAY, now) }, { env });
  assert.equal(usageLog.isInCooldown('media/a.png', 14, { now, env }), true);
  assert.equal(usageLog.isInCooldown('media/a.png', 14, { now, env, excludeContentId: 'c-1' }), false);
});

test('reconcileRemove deletes a killed item and unblocks the asset (DD-14 second-gate kill)', () => {
  const env = tempHome();
  const now = Date.now();
  usageLog.recordUse({ asset_id: 'media/a.png', content_id: 'kill-me', used_at: iso(1 * DAY, now) }, { env });
  usageLog.recordUse({ asset_id: 'media/b.png', content_id: 'keep-me', used_at: iso(1 * DAY, now) }, { env });
  assert.equal(usageLog.isInCooldown('media/a.png', 14, { now, env }), true);

  const removed = usageLog.reconcileRemove('kill-me', { env });
  assert.equal(removed, 1);
  // The killed item's asset is free again; the other survives.
  assert.equal(usageLog.isInCooldown('media/a.png', 14, { now, env }), false);
  assert.equal(usageLog.isInCooldown('media/b.png', 14, { now, env }), true);
  // Idempotent.
  assert.equal(usageLog.reconcileRemove('kill-me', { env }), 0);
});

test('missing ledger reads as empty and never throws (empty-instance safe)', () => {
  const env = tempHome();
  assert.deepEqual(usageLog.readLedger(env), []);
  assert.equal(usageLog.isInCooldown('media/anything.png', 14, { env }), false);
  const status = usageLog.cooldownStatus('media/anything.png', { env });
  assert.equal(status.cooldown_blocked, false);
  assert.equal(status.last_use, null);
});
