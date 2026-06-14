'use strict';

/**
 * tests/pinned/approval-attribution.test.js  [PINNED — release-spec §16.2 / DD-17 / model §2 invariant]
 *
 * Approval attribution: every publish must carry a recorded approver who is on the config
 * reviewers allowlist with `approve` rights — there is NO hardcoded approver id (the production
 * single-approver constant is retired, §0.3 r6). The pinned guarantees (DD-17):
 *
 *   - an allowlisted reviewer WITH approve rights passes the publish-edge approver gate;
 *   - a reviewer with only `edit` rights, a non-allowlisted id, and a MISSING approver are ALL
 *     blocked (fail-closed); an empty allowlist passes no one (no hardcoded id);
 *   - end-to-end: a properly-attributed LIVE item hands off; an UNATTRIBUTED item is routed to
 *     manual_review at the publish edge and never reaches the publisher.
 *
 * Zero-key, no network: the gate is pure; the end-to-end leg uses a stub adapter + throwaway home.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const executor = require('../../engine/orchestrator/publish-executor.js');
const publishers = require('../../engine/publishers/publisher.js');

process.setMaxListeners(0);

const ALLOWED = '00000000000000001';
const EDIT_ONLY = '00000000000000002';
const STRANGER = '00000000000000099';

function ctxFor(reviewers, entries = []) {
  return {
    env: { CONTENT_HOME: '/tmp/pure-gate-no-io' },
    config: { reviewers, cooldown: { hard_days: 14, target_days: 30 }, approval_surface: { channels: {} } },
    cooldownHardDays: 14,
    usageRecords: [],
    entries,
  };
}
const entry = (fields) => ({ header: fields.content_id, fields: { state: 'approved', ...fields } });

test('only an allowlisted reviewer WITH approve rights passes the approver gate (DD-17)', () => {
  const gates = executor.buildGates(ctxFor([
    { id: ALLOWED, rights: ['approve', 'edit'] },
    { id: EDIT_ONLY, rights: ['edit'] },
  ]));

  assert.equal(gates.approver_allowlisted(entry({ content_id: 'c1', approved_by: ALLOWED })).ok, true,
    'allowlisted + approve rights passes');
  const editOnly = gates.approver_allowlisted(entry({ content_id: 'c2', approved_by: EDIT_ONLY }));
  assert.equal(editOnly.ok, false);
  assert.match(editOnly.reason, /approve rights/u, 'edit-only reviewer cannot approve a publish');
  const stranger = gates.approver_allowlisted(entry({ content_id: 'c3', approved_by: STRANGER }));
  assert.equal(stranger.ok, false);
  assert.match(stranger.reason, /not on the reviewers allowlist/u);
  assert.equal(gates.approver_allowlisted(entry({ content_id: 'c4', approved_by: '' })).ok, false,
    'a missing approver is rejected (model §2 invariant)');
});

test('an empty allowlist passes no one — there is no hardcoded approver id', () => {
  const gates = executor.buildGates(ctxFor([]));
  assert.equal(gates.approver_allowlisted(entry({ content_id: 'c1', approved_by: ALLOWED })).ok, false,
    'empty allowlist ⇒ fail-closed (no hardcoded id)');
});

test('the source carries no hardcoded approver/reviewer id literal (Tier-3, §0.3 r6)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'engine', 'orchestrator', 'publish-executor.js'), 'utf8');
  // No 17-20 digit snowflake-shaped literal anywhere in the executor source.
  assert.doesNotMatch(src, /\b\d{17,20}\b/u, 'no hardcoded snowflake-shaped approver id in the executor');
  // The approver is resolved from config.reviewers, never a constant.
  assert.match(src, /ctx\.config\.reviewers/u, 'the approver gate reads the config allowlist');
});

// ---------------------------------------------------------------------------
// End-to-end at the publish edge
// ---------------------------------------------------------------------------

const SYSTEM_CONFIG = {
  schema_version: '1.0.0',
  mode: 'LIVE',
  reviewers: [{ id: ALLOWED, rights: ['approve', 'edit'] }],
  publish: { draft_only: true, auto_publish_allowed: false },
  approval_surface: { adapter: 'discord', channels: {} },
  cooldown: { hard_days: 14, target_days: 30 },
};

function buildHome(approvedBy) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pin-attr-'));
  fs.mkdirSync(path.join(home, 'config'), { recursive: true });
  fs.mkdirSync(path.join(home, 'queue', 'locks'), { recursive: true });
  fs.mkdirSync(path.join(home, 'library'), { recursive: true });
  fs.writeFileSync(path.join(home, 'config', 'system.json'), JSON.stringify(SYSTEM_CONFIG, null, 2), 'utf8');
  const raw = [
    '# Publish Queue', '',
    '## Entry - 2026-04-01-acme-attr-01',
    '- content_id: 2026-04-01-acme-attr-01',
    '- brand: acme-cosmos', '- platform: twitter', '- format: text', '- mode: LIVE',
    ...(approvedBy ? [`- approved_by: ${approvedBy}`] : []),
    '- approved_variant: recommended', '- approved_copy: An attributed post.', '- state: approved', '',
  ].join('\n');
  fs.writeFileSync(path.join(home, 'queue', 'publish-queue.md'), raw, 'utf8');
  return { env: { CONTENT_HOME: home, WORKFLOW_LEDGER_DISABLE: '1' }, home, queuePath: path.join(home, 'queue', 'publish-queue.md') };
}
function installStub() {
  const calls = [];
  publishers.register('postiz', {
    name: 'postiz',
    async handoff(pkg) { calls.push((pkg && pkg.content_id) || 'x'); return { external_ref: 'draft-x', state: publishers.PUBLISH_STATE.HANDED_OFF }; },
    async verifyStatus() { return { state: publishers.PUBLISH_STATE.HANDED_OFF }; },
    async fetchMetrics() { return { supported: false, metrics: {} }; },
    capabilities() { return { name: 'postiz', draft_gate: true }; },
  });
  return { calls };
}
async function runQuiet(env) {
  const orig = console.log; console.log = () => {};
  try { return await executor.main(env); } finally { console.log = orig; }
}

test('end-to-end: an attributed LIVE item hands off; an unattributed one is blocked at the edge', async () => {
  // Attributed by the allowlisted reviewer → hands off.
  const ok = buildHome(ALLOWED);
  try {
    const stub = installStub();
    await runQuiet(ok.env);
    assert.equal(stub.calls.length, 1, 'attributed item hands off');
    assert.match(fs.readFileSync(ok.queuePath, 'utf8'), /- state: handed_off/u);
  } finally { fs.rmSync(ok.home, { recursive: true, force: true }); }

  // No recorded approver → blocked, routed to manual_review, never handed off.
  const bad = buildHome(null);
  try {
    const stub = installStub();
    const code = await runQuiet(bad.env);
    assert.equal(code, executor.EXIT.BLOCKED, 'unattributed item exits BLOCKED');
    assert.equal(stub.calls.length, 0, 'unattributed item never reaches the publisher');
    assert.match(fs.readFileSync(bad.queuePath, 'utf8'), /- state: manual_review/u, 'routed to manual_review');
  } finally { fs.rmSync(bad.home, { recursive: true, force: true }); }
});
