'use strict';

/**
 * tests/pinned/edit-regate.test.js  [PINNED — release-spec §16.2 / DD-12 / §14.5]
 *
 * The edit→re-gate path: an operator EDIT (edit-counts-as-approval, §2.4) and a reviewer-ATTACHED
 * media asset RE-ENTER the deterministic gate subset (limits / formatting / banned-pattern /
 * variant checks via pre-gate-lint; per-platform packaging; package integrity; media reuse
 * cooldown) before publish. The pinned guarantees (DD-12):
 *
 *   - a clean edit PASSES the re-gate (proceeds to the queue);
 *   - an edit that introduces a HARD deterministic violation FAILS the re-gate and RETURNS the
 *     decision with the reason — never a silent publish, never a silent block;
 *   - an attached image inside its reuse cooldown FAILS the re-gate (the §14.5 cooldown subset);
 *   - re-gating is DETERMINISTIC ONLY — there is no second LLM review on the edit path.
 *
 * Zero-key, no network: the re-gate composes only deterministic engine modules; the cooldown leg
 * reads the canonical usage-log through a throwaway CONTENT_HOME.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const reGateMod = require('../../engine/gate/re-gate.js');
const usageLog = require('../../engine/library/usage-log.js');

function cleanEditedDraft() {
  return {
    content_id: 'acme-edit-01',
    brand: 'acme-cosmos',
    platform: 'twitter',
    format: 'text',
    variants: [
      { label: 'recommended', text: 'The reviewer tightened the recap: sixty builders shipped openable demos in one weekend.' },
      { label: 'variant-a', text: 'Sixty builders, one weekend, and every demo went out as a link you can open.' },
      { label: 'variant-b', text: 'We asked for working demos and got sixty of them. Here is the edited beta recap.' },
    ],
  };
}

function emDashEditedDraft() {
  // An edit that slipped a mid-sentence em dash into the Recommended variant (a HARD LINT code).
  const d = cleanEditedDraft();
  d.variants[0].text = 'The reviewer tightened the recap—and every demo shipped as an openable link.';
  return d;
}

test('a clean edit passes the deterministic re-gate (proceeds, DD-12)', () => {
  const result = reGateMod.reGate({ content_id: 'acme-edit-01', draft: cleanEditedDraft(), rules: { env: {} } });
  assert.equal(result.ok, true, `clean edit should pass; reasons: ${result.reasons.join('; ')}`);
  const lintLayer = result.layers.find((l) => l.layer === 'pre-gate-lint');
  assert.ok(lintLayer && lintLayer.ok, 'the deterministic pre-gate layer ran and passed');
});

test('an edit that introduces a HARD violation FAILS the re-gate and returns the reason (no silent publish)', () => {
  const result = reGateMod.reGate({ content_id: 'acme-edit-01', draft: emDashEditedDraft(), rules: { env: {} } });
  assert.equal(result.ok, false, 'a hard deterministic violation must fail the edit re-gate');
  assert.ok(result.reasons.length >= 1, 'the failure returns a reason (never a silent block)');
  const lintLayer = result.layers.find((l) => l.layer === 'pre-gate-lint');
  assert.ok(lintLayer.detail.some((c) => c.code === 'LINT.EM_DASH'), 'the specific deterministic code is surfaced');
});

test('an attached image inside its reuse cooldown FAILS the re-gate (§14.5 cooldown subset)', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pin-regate-'));
  try {
    fs.mkdirSync(path.join(home, 'library'), { recursive: true });
    const env = { CONTENT_HOME: home };
    const ASSET = 'media/acme/attached-hero.png';
    // A prior use 3 days ago — inside the 14-day hard floor.
    usageLog.recordUse({ asset_id: ASSET, content_id: 'acme-prior-09', used_at: new Date(Date.now() - 3 * 86400000).toISOString() }, { env });

    const result = reGateMod.reGate({
      content_id: 'acme-edit-02',
      attached_media_ref: ASSET,
      cooldown: { hardDays: 14, env },
      env,
    });
    assert.equal(result.ok, false, 'an in-cooldown attachment must fail the re-gate');
    const cd = result.layers.find((l) => l.layer === 'cooldown');
    assert.ok(cd && !cd.ok, 'the cooldown layer ran and blocked');
    assert.match(result.reasons.join(' '), /cooldown/u, 'the reason names the cooldown block');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('re-gating is DETERMINISTIC ONLY — no second LLM review on the edit path', () => {
  // The re-gate module composes pre-gate-lint + platform/package + cooldown; it imports no LLM
  // seat and exposes no judge hook. Pin that the source carries no LLM/gate-seat dependency.
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'engine', 'gate', 're-gate.js'), 'utf8');
  assert.doesNotMatch(src, /seats?\.gate|llm-quality|llm-voice|callLLM|judge\(/u, 're-gate must not invoke an LLM judge');
  // And a clean edit's layer set never includes an llm/voice/quality layer.
  const result = reGateMod.reGate({ content_id: 'acme-edit-01', draft: cleanEditedDraft(), rules: { env: {} } });
  assert.ok(!result.layers.some((l) => /llm|voice|quality/u.test(l.layer)), 'no LLM layer on the edit re-gate path');
});
