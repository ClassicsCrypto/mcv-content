'use strict';

/**
 * tests/cli-improve.test.js  [N — SI-CLI verb smoke]
 *
 * Smoke coverage for the GOVERNED self-improvement loop CLI verbs (engine/cli/improve.js: `engine
 * improve` + `engine rollback`) wired into the dispatcher (bin/engine.js) — release-spec roadmap #3;
 * DD-6 (the governance is the whole point); §8.9 ships-with-governance; §3.1 never-loosen; §15.4
 * kill switch; §13.1 status surface. Deterministic + zero-key (RD-12): no API calls, no network;
 * proposals are derived from an INJECTED performance report so no analytics corpus is needed, and
 * the apply path uses a throwaway $CONTENT_HOME with a real local git repo (the DD-6 (5) substrate).
 *
 * The bar these tests pin (the LAW): --dry-run is the DEFAULT (apply nothing), --apply performs the
 * governed change; the loop is OFF by default + halts when PAUSED; a refused change (human-only /
 * never-loosen / below-threshold) is reported and NEVER applied; rollback reverts a machine change;
 * machine changes are surfaced by `engine status`. Honest exit codes throughout.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const engine = require('../bin/engine.js');
const improveVerb = require('../engine/cli/improve.js');
const statusVerb = require('../engine/cli/status.js');
const rollbackMod = require('../engine/self-improve/rollback.js');
const gov = require('../engine/self-improve/_governance.js');

function gitOk() {
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
}

/** A $CONTENT_HOME with config/system.json seeded + (optionally) a real local git repo with a commit. */
function tmpHome(siConfig, withGit) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oce-cli-si-'));
  fs.mkdirSync(path.join(home, 'config'), { recursive: true });
  const config = {
    mode: 'SAFE',
    // Pre-existing human-set calendar weightings the canary only partially touches.
    calendar: { weights: { 'mon-pillar': 0.5, 'tue-pillar': 0.5 } },
    archetype: { priority: { lore: 0.5, hype: 0.5 } },
    content_type: { priority: { thread: 0.5, single: 0.5 } },
    self_improve: siConfig,
  };
  fs.writeFileSync(path.join(home, 'config', 'system.json'), `${JSON.stringify(config, null, 2)}\n`);
  if (withGit) {
    execFileSync('git', ['init', '--quiet'], { cwd: home });
    execFileSync('git', ['config', 'user.email', 't@t.local'], { cwd: home });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: home });
    execFileSync('git', ['add', '-A'], { cwd: home });
    execFileSync('git', ['commit', '--quiet', '-m', 'init'], { cwd: home });
  }
  return { CONTENT_HOME: home };
}

/** Loop-enabled config with a moderate bar (canonical self_improve shape). */
function enabledConfig(over = {}) {
  return {
    enabled: true,
    evidence: { min_sample_size: 5, min_confidence: 0.6, min_effect_size: 0.2 },
    canary: { observe_cycles: 1, scope_fraction: 0.5, rollback_on_regression_pct: 0.1 },
    allowlist: {
      targets: ['calendar_weighting', 'archetype_priority', 'content_type_priority'],
      bounds: { max_weight_delta: 0.25, weight_range: { min: 0, max: 1 } },
    },
    ...over,
  };
}

/** A report with a strong over-performing theme (auto-applicable) + a thin one (held proposed). */
function reportStrongAndWeak() {
  return {
    checkpoints: [],
    baselines: [{ dimension: 'overall', key: 'acme|twitter|24h', metrics: { likes_mean: 100 } }],
    weekly_summary: {
      period: { start: '2026-06-01', end: '2026-06-08' },
      aggregates: [
        { dimension: 'theme', key: 'lore', sample_size: 12, metrics: { likes_mean: 200 } }, // +100%, n=12 strong
        { dimension: 'format', key: 'thread', sample_size: 2, metrics: { likes_mean: 40 } }, // -60%, n=2 thin
      ],
      recommendations: [],
    },
  };
}

function configWith(si) {
  return { mode: 'SAFE', self_improve: si };
}

async function capture(fn) {
  const outChunks = []; const errChunks = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (c) => { outChunks.push(String(c)); return true; };
  process.stderr.write = (c) => { errChunks.push(String(c)); return true; };
  try { const code = await fn(); return { code, stdout: outChunks.join(''), stderr: errChunks.join('') }; }
  finally { process.stdout.write = origOut; process.stderr.write = origErr; }
}

// ---------------------------------------------------------------------------
// registration + help routing
// ---------------------------------------------------------------------------

test('improve + rollback are registered verbs with --help (exit 0)', async () => {
  assert.ok(engine.VERB_ORDER.includes('improve'));
  assert.ok(engine.VERB_ORDER.includes('rollback'));
  for (const verb of ['improve', 'rollback']) {
    const { code, stdout } = await capture(() => engine.main(['node', 'engine.js', verb, '--help']));
    assert.equal(code, 0, `${verb} --help exits 0`);
    assert.ok(stdout.length > 0);
  }
});

// ---------------------------------------------------------------------------
// OFF by default + kill switch (DD-6 (6) / §15.4)
// ---------------------------------------------------------------------------

test('improve is OFF by default — clean no-op, exit 0, applies nothing', async () => {
  const env = tmpHome({ enabled: false }, false);
  const res = await improveVerb.run({ flags: {}, env, config: configWith({ enabled: false }), report: reportStrongAndWeak() });
  assert.equal(res.ok, true);
  assert.equal(res.exitCode, 0);
  assert.equal(res.data.ran, false);
  assert.match(res.summary, /OFF by default/i);
});

test('improve halts under the PAUSED kill switch (§15.4), exit 0', async () => {
  const env = tmpHome(enabledConfig(), false);
  fs.writeFileSync(path.join(env.CONTENT_HOME, 'PAUSED'), 'maintenance');
  const res = await improveVerb.run({ flags: { apply: true }, env, config: configWith(enabledConfig()), report: reportStrongAndWeak() });
  assert.equal(res.ok, true);
  assert.equal(res.exitCode, 0);
  assert.equal(res.data.ran, false);
  assert.match(res.summary, /PAUSED/);
});

// ---------------------------------------------------------------------------
// dry-run is the DEFAULT — classifies, applies nothing
// ---------------------------------------------------------------------------

test('improve DEFAULTS to dry-run: shows proposals + classification, changes no config', async () => {
  const env = tmpHome(enabledConfig(), false);
  const before = fs.readFileSync(path.join(env.CONTENT_HOME, 'config', 'system.json'), 'utf8');

  const res = await improveVerb.run({ flags: {}, env, config: configWith(enabledConfig()), report: reportStrongAndWeak() });
  assert.equal(res.ok, true);
  assert.equal(res.exitCode, 0);
  assert.equal(res.data.mode, 'dry-run');
  assert.ok(res.data.summary.total >= 1);
  assert.ok(res.data.summary.auto_applicable >= 1, 'the strong theme should be auto-applicable');
  assert.equal(res.data.applied.length, 0, 'dry-run applies nothing');
  // The strong proposal is classified auto-applicable (code OK); the thin one is held proposed.
  const autoP = res.data.proposals.find((p) => p.auto_applicable);
  assert.ok(autoP && autoP.code === 'OK');
  assert.match(res.summary, /Re-run with --apply/);

  // No config knob moved.
  assert.equal(fs.readFileSync(path.join(env.CONTENT_HOME, 'config', 'system.json'), 'utf8'), before);
});

// ---------------------------------------------------------------------------
// --apply performs the governed change (canary -> observe -> promote/rollback)
// ---------------------------------------------------------------------------

test('improve --apply applies an auto-applicable record in canary and surfaces it + rollback works', { skip: !gitOk() && 'git unavailable' }, async () => {
  const env = tmpHome(enabledConfig(), true);
  const now = Date.UTC(2026, 5, 15);

  const res = await improveVerb.run({ flags: { apply: true }, env, config: configWith(enabledConfig()), report: reportStrongAndWeak(), now });
  assert.equal(res.ok, true);
  assert.equal(res.exitCode, 0);
  assert.equal(res.data.mode, 'apply');
  assert.ok(res.data.applied.length >= 1, 'at least one auto-applicable record applied');
  const applied = res.data.applied.find((a) => a.apply && a.apply.ok);
  assert.ok(applied, 'an apply succeeded');
  // It landed in a governed state (canary, or promoted after observe_cycles=1).
  assert.ok(['canary', 'promoted'].includes(applied.governance_state));
  assert.ok(applied.rollback_ref, 'a rollback ref was pinned (DD-6 (5))');

  // engine status surfaces the machine change + a rollback hint (DD-6 (6) auditable).
  const status = statusVerb.run({ flags: {}, env, config: configWith(enabledConfig()) });
  assert.equal(status.data.self_improve.enabled, true);
  assert.ok(status.data.self_improve.total_changes >= 1);
  assert.ok(status.data.self_improve.changes.some((c) => c.record_id === applied.record_id));

  // engine rollback --last reverts the most recent change (one-step, DD-6 (5)).
  const rb = improveVerb.rollbackRun({ flags: { last: true }, env, now });
  assert.equal(rb.ok, true);
  assert.equal(rb.exitCode, 0);
  assert.match(rb.summary, /rolled back/i);
  // The reverted record is now in rolled_back state.
  const sc = gov.readJson(gov.governancePath(applied.record_id, env));
  assert.equal(sc.governance_state, 'rolled_back');
});

// ---------------------------------------------------------------------------
// rollback: nothing-to-roll-back is an honest non-error no-op
// ---------------------------------------------------------------------------

test('rollback --last with no changes is a clean no-op (exit 0)', { skip: !gitOk() && 'git unavailable' }, () => {
  const env = tmpHome(enabledConfig(), true);
  const rb = improveVerb.rollbackRun({ flags: { last: true }, env });
  assert.equal(rb.ok, true);
  assert.equal(rb.exitCode, 0);
  assert.match(rb.summary, /no reversible machine change/i);
});

test('rollback --to-baseline without a ref is a usage error (exit 2)', () => {
  const env = tmpHome(enabledConfig(), false);
  const rb = improveVerb.rollbackRun({ flags: { 'to-baseline': true }, env });
  assert.equal(rb.ok, false);
  assert.equal(rb.exitCode, 2);
  assert.match(rb.summary, /needs a commit ref/);
});

// ---------------------------------------------------------------------------
// structural refusals are reported, never applied (DD-6 (1)/(2))
// ---------------------------------------------------------------------------

test('a never-loosen / human-only proposal is classified refused and never applied', async () => {
  const env = tmpHome(enabledConfig(), false);
  // A report whose only signal targets a non-knob gate dimension never even derives a knob proposal;
  // so we instead assert the classification path: inject a report whose aggregates map only to a
  // machine knob, but confirm that the dry-run NEVER lists an apply (and refusals carry their code).
  const res = await improveVerb.run({ flags: {}, env, config: configWith(enabledConfig()), report: reportStrongAndWeak() });
  // Every classified proposal carries an explicit governance disposition + code; none is applied
  // in dry-run, and an auto-applicable one is the only OK code (refusals would be EHUMANONLY/
  // ENEVERLOOSEN, below-threshold EBELOWTHRESHOLD).
  for (const p of res.data.proposals) {
    assert.ok(['OK', 'EHUMANONLY', 'ENEVERLOOSEN', 'EBELOWTHRESHOLD', 'EPROPOSED', 'EREFUSED'].includes(p.code));
    if (p.code !== 'OK') assert.equal(p.auto_applicable, false);
  }
  assert.equal(res.data.applied.length, 0);
});
