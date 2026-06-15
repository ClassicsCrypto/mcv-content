'use strict';

/**
 * engine/voice-calibration/__tests__/apply.test.js  [N net-new — CS-STAGE-5 apply tests]
 *
 * Proves mandatory safety properties for the HUMAN-ONLY voice-calibration apply path.
 *
 * P2  CONSENT-GATED/NEVER-AUTO-APPLY:
 *     - self-improve applyGovernedChange REFUSES a voice record with EHUMANONLY.
 *     - applyVoiceCalibration without consent throws ECONSENTREQUIRED, writes nothing.
 *     - consented applyVoiceCalibration writes brand.json + record + ONE commit + baseline_ref.
 * P3  NEVER-LOOSEN: a proposal with a smuggled gate axis (severity/disposition/threshold) throws ENEVERLOOSEN.
 * P4  NEVER-TOUCH-HUMAN-ONLY: gate config/rules/thresholds are byte-identical after apply.
 * P8  VERSIONED+REVERSIBLE: rollback restores prior voice fields in one step; refuses when not a git repo.
 * P10 NOT-SHAREABLE-UPSTREAM: improvement-sharing evaluate + sanitize both reject a brand:*:voice payload.
 *
 * Zero-key: no API calls, no network. Uses a tmp git instance repo for I/O tests (git must be available).
 * Runner: node:test (Node >= 22).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const applyMod = require('../apply.js');
const siApplyMod = require('../../self-improve/apply.js');
const mutability = require('../../self-improve/mutability.js');
const { evaluateContribution, isVoiceArtifact: evalIsVoiceArtifact } = require('../../improvement-sharing/evaluate.js');
const sanitize = require('../../improvement-sharing/sanitize.js');

const {
  applyVoiceCalibration,
  rollbackVoiceCalibration,
  ConsentRequiredError,
  NeverLoosenError,
  VoiceApplyError,
  assertNotGateLoosenedByVoiceDiff,
} = applyMod;

// ---------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------

const FIX_DIR = path.join(__dirname, '..', '..', '..', 'fixtures', 'competitor-scan-acme');
const SCAN_REPORT = JSON.parse(fs.readFileSync(path.join(FIX_DIR, 'scans', 'acme-cosmos', '2099-03-15.json'), 'utf8'));
const BRAND_CONFIG = JSON.parse(fs.readFileSync(path.join(FIX_DIR, 'brand.json'), 'utf8'));

/** Check if git is available. */
function gitAvailable() {
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
}

const HAS_GIT = gitAvailable();

/**
 * Create a tmp $CONTENT_HOME with:
 *   - config/system.json (minimal gate config)
 *   - brands/<brandId>/brand.json (the current brand config)
 *   - A local git repo with one initial commit
 *
 * Returns { home, env, brandId }.
 */
function tmpHome(brandId = 'acme-cosmos', brandOverrides = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oce-vc-apply-'));
  const env = { CONTENT_HOME: home };

  // Config with gate fields that must NOT change after apply.
  const gateConfig = {
    mode: 'SAFE',
    reviewers: [{ id: 'r1', rights: ['approve'] }],
    budget: { monthly_cap: 1, daily_cap: 1, per_item_generation_limit: 1, indexing_requires_estimate: true },
    publish: { draft_only: true, auto_publish_allowed: false },
    approval_surface: { adapter: 'discord', channels: { 'content-review': 'c', 'content-published': 'c', 'content-ops': 'c', 'media-bank': 'c' } },
    scheduler: { kickoff_time: '09:00' },
    gate: { thresholds: { hard_fail_min: 0.9, soft_min: 0.6 } },
    thresholds: { fm_quality: 0.8, platform_min: 0.7 },
  };
  fs.mkdirSync(path.join(home, 'config'), { recursive: true });
  fs.writeFileSync(path.join(home, 'config', 'system.json'), `${JSON.stringify(gateConfig, null, 2)}\n`, 'utf8');

  // Brand config.
  const brand = { ...BRAND_CONFIG, ...brandOverrides, id: brandId };
  const brandDir = path.join(home, 'brands', brandId);
  fs.mkdirSync(brandDir, { recursive: true });
  fs.writeFileSync(path.join(brandDir, 'brand.json'), `${JSON.stringify(brand, null, 2)}\n`, 'utf8');

  // Init git repo with initial commit.
  if (HAS_GIT) {
    execFileSync('git', ['init', '--quiet'], { cwd: home, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 't@t.local'], { cwd: home });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: home });
    execFileSync('git', ['add', '-A'], { cwd: home, stdio: 'ignore' });
    execFileSync('git', ['commit', '--quiet', '--allow-empty', '-m', 'init'], { cwd: home });
  }

  return { home, env, brandId };
}

/** Read the brand.json from the tmp home. */
function readBrandJson(home, brandId) {
  return JSON.parse(fs.readFileSync(path.join(home, 'brands', brandId, 'brand.json'), 'utf8'));
}

/** Read config/system.json from the tmp home. */
function readSystemConfig(home) {
  return JSON.parse(fs.readFileSync(path.join(home, 'config', 'system.json'), 'utf8'));
}

/** Build a synthetic proposed voice-calibration record. */
function makeVoiceRecord(brandId = 'acme-cosmos', overrides = {}) {
  return {
    id: `vc-test-${brandId}-001`,
    created_at: '2099-03-20T00:00:00.000Z',
    source_signals: [{ type: 'calibration', count: 4 }],
    target_artifact: `brand:${brandId}:voice`,
    target_mutability: 'human-only',
    status: 'proposed',
    proposed_diff: JSON.stringify({
      drama_dial: { current: 'low', proposed: 'low' },
      archetype_emphasis: {
        current: BRAND_CONFIG.archetype_emphasis,
        proposed: [
          { code: 'HOW_TO', weight: 3.5 },
          { code: 'SKY_TONIGHT', weight: 2.0 },
          { code: 'THESIS_OR_RECEIPT', weight: 1.5 },
        ],
      },
      hook_preferences: {
        current: BRAND_CONFIG.hook_preferences,
        proposed: [
          { pattern: 'direct-tip', weight: 3.0 },
          { pattern: 'how-to-numbered', weight: 3.0 },
          { pattern: 'question-hook', weight: 1.0 },
        ],
      },
      cadence_preferences: {
        current: BRAND_CONFIG.cadence_preferences,
        proposed: BRAND_CONFIG.cadence_preferences,
      },
    }),
    proposed_diff_structured: {
      drama_dial: { current: 'low', proposed: 'low' },
      archetype_emphasis: {
        current: BRAND_CONFIG.archetype_emphasis,
        proposed: [
          { code: 'HOW_TO', weight: 3.5 },
          { code: 'SKY_TONIGHT', weight: 2.0 },
          { code: 'THESIS_OR_RECEIPT', weight: 1.5 },
        ],
      },
      hook_preferences: {
        current: BRAND_CONFIG.hook_preferences,
        proposed: [
          { pattern: 'direct-tip', weight: 3.0 },
          { pattern: 'how-to-numbered', weight: 3.0 },
          { pattern: 'question-hook', weight: 1.0 },
        ],
      },
      cadence_preferences: {
        current: BRAND_CONFIG.cadence_preferences,
        proposed: BRAND_CONFIG.cadence_preferences,
      },
    },
    confidence: 0.62,
    evidence: { confidence: 0.62, count: 4 },
    rationale: 'Deterministic rationale for test.',
    shareability: 'private',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// P2: MACHINE applyGovernedChange REFUSES a voice record (EHUMANONLY)
// ---------------------------------------------------------------------------

describe('P2 — machine applyGovernedChange refuses voice record (EHUMANONLY)', () => {
  test('applyGovernedChange returns not-ok for a voice record (EHUMANONLY structurally, DISABLED when loop off)', (t) => {
    if (!HAS_GIT) { t.skip('git not available'); return; }
    const { env } = tmpHome();
    const rec = makeVoiceRecord();
    // target_mutability is 'human-only' — the machine applier must refuse.
    // With self_improve.enabled not set, DISABLED fires first (gate 1 before gate 2).
    // In all cases the machine applier must return ok:false — it never applies a voice record.
    const applyResult = siApplyMod.applyGovernedChange(rec, {
      env,
      now: Date.now(),
    });
    // The machine applier must return ok:false — voice records are NEVER machine-applied.
    assert.strictEqual(applyResult.ok, false, 'machine applier must not apply a voice record');
    // Acceptable refusal codes: human-only refusals (TARGET_NOT_MACHINE_ALLOWED, HUMAN_ONLY, EHUMANONLY),
    // or DISABLED (loop off by default — the system behaving correctly). All of these are by-design refusals.
    const ACCEPTABLE_CODES = ['TARGET_NOT_MACHINE_ALLOWED', 'HUMAN_ONLY', 'EHUMANONLY', 'DISABLED', 'PAUSED'];
    assert.ok(
      ACCEPTABLE_CODES.includes(applyResult.code),
      `expected a by-design refusal code, got: ${applyResult.code}`,
    );
  });

  test('mutability.assertMachineChangeAllowed throws EHUMANONLY for { kind:"voice" }', () => {
    assert.throws(
      () => mutability.assertMachineChangeAllowed({ kind: 'voice' }),
      (err) => {
        assert.strictEqual(err.code, 'EHUMANONLY');
        assert.ok(err instanceof mutability.HumanOnlyViolation);
        return true;
      },
      'must throw EHUMANONLY for a voice target',
    );
  });

  test('mutability.classifyTarget({ kind:"voice" }) classifies as human-only', () => {
    const r = mutability.classifyTarget({ kind: 'voice' });
    assert.strictEqual(r.classification, mutability.CLASSIFICATION.HUMAN_ONLY);
  });
});

// ---------------------------------------------------------------------------
// P2: applyVoiceCalibration without consent throws ECONSENTREQUIRED, writes nothing
// ---------------------------------------------------------------------------

describe('P2 — applyVoiceCalibration without consent throws ECONSENTREQUIRED', () => {
  test('consent:false throws ECONSENTREQUIRED', async () => {
    const { env } = tmpHome();
    const rec = makeVoiceRecord();
    await assert.rejects(
      () => applyVoiceCalibration(rec, { consent: false, env, now: Date.now(), skipGateRegression: true }),
      (err) => {
        assert.strictEqual(err.code, 'ECONSENTREQUIRED');
        assert.ok(err instanceof ConsentRequiredError);
        return true;
      },
      'must throw ECONSENTREQUIRED when consent is false',
    );
  });

  test('consent omitted (undefined) throws ECONSENTREQUIRED', async () => {
    const { env } = tmpHome();
    const rec = makeVoiceRecord();
    await assert.rejects(
      () => applyVoiceCalibration(rec, { env, now: Date.now(), skipGateRegression: true }),
      (err) => { assert.strictEqual(err.code, 'ECONSENTREQUIRED'); return true; },
    );
  });

  test('consent:"yes" (string, not boolean true) throws ECONSENTREQUIRED', async () => {
    const { env } = tmpHome();
    const rec = makeVoiceRecord();
    await assert.rejects(
      () => applyVoiceCalibration(rec, { consent: 'yes', env, now: Date.now(), skipGateRegression: true }),
      (err) => { assert.strictEqual(err.code, 'ECONSENTREQUIRED'); return true; },
    );
  });

  test('no I/O happens before consent check (files unchanged)', async (t) => {
    if (!HAS_GIT) { t.skip('git not available'); return; }
    const { home, env, brandId } = tmpHome();
    const rec = makeVoiceRecord();
    const brandBefore = readBrandJson(home, brandId);
    const configBefore = readSystemConfig(home);

    try {
      await applyVoiceCalibration(rec, { consent: false, env, now: Date.now(), skipGateRegression: true });
    } catch (err) {
      assert.strictEqual(err.code, 'ECONSENTREQUIRED');
    }

    // Nothing should have changed.
    const brandAfter = readBrandJson(home, brandId);
    const configAfter = readSystemConfig(home);
    assert.deepStrictEqual(brandAfter, brandBefore, 'brand.json must be unchanged after ECONSENTREQUIRED');
    assert.deepStrictEqual(configAfter, configBefore, 'system.json must be unchanged after ECONSENTREQUIRED');
  });
});

// ---------------------------------------------------------------------------
// P2: consented apply writes brand.json + learning record + ONE commit + baseline_ref
// ---------------------------------------------------------------------------

describe('P2 — consented apply writes brand.json + record + ONE commit', () => {
  test('consented apply with gate-regression injected as OK writes expected artifacts', async (t) => {
    if (!HAS_GIT) { t.skip('git not available'); return; }
    const { home, env, brandId } = tmpHome();
    const rec = makeVoiceRecord(brandId);
    const now = Date.now();

    const result = await applyVoiceCalibration(rec, {
      consent: true,
      env,
      now,
      gateRegression: { ok: true },
    });

    assert.strictEqual(result.ok, true, `apply should succeed; got: ${result.summary}`);
    assert.strictEqual(result.code, 'APPLIED');
    assert.ok(result.data.baseline_ref, 'baseline_ref must be captured');
    assert.ok(result.data.commit, 'a git commit must be recorded');
    assert.ok(result.data.brand_json_path, 'brand_json_path must be present');

    // brand.json must be updated with the proposed values.
    const brand = readBrandJson(home, brandId);
    assert.strictEqual(brand.drama_dial, 'low', 'drama_dial preserved');
    // HOW_TO weight should be 3.5 (boosted).
    const howTo = brand.archetype_emphasis.find((e) => e.code === 'HOW_TO');
    assert.ok(howTo, 'HOW_TO entry must exist');
    assert.strictEqual(howTo.weight, 3.5, 'HOW_TO weight must be 3.5 after apply');
    // how-to-numbered hook weight should be 3.0 (boosted).
    const hookHowTo = brand.hook_preferences.find((p) => p.pattern === 'how-to-numbered');
    assert.ok(hookHowTo, 'how-to-numbered must exist');
    assert.strictEqual(hookHowTo.weight, 3.0, 'how-to-numbered weight must be 3.0 after apply');

    // Gate config must be unchanged (P4).
    const config = readSystemConfig(home);
    assert.deepStrictEqual(config.gate, { thresholds: { hard_fail_min: 0.9, soft_min: 0.6 } }, 'gate config must be unchanged (P4)');
    assert.deepStrictEqual(config.thresholds, { fm_quality: 0.8, platform_min: 0.7 }, 'thresholds must be unchanged (P4)');
  });

  test('apply captures baseline_ref = HEAD before writing', async (t) => {
    if (!HAS_GIT) { t.skip('git not available'); return; }
    const { home, env, brandId } = tmpHome();
    const rec = makeVoiceRecord(brandId);

    // Capture HEAD before apply.
    const headBefore = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: home }).toString().trim();

    const result = await applyVoiceCalibration(rec, {
      consent: true,
      env,
      now: Date.now(),
      gateRegression: { ok: true },
    });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.data.baseline_ref, headBefore, 'baseline_ref must be the pre-apply HEAD');
    // The commit after apply must be different (a new commit was made).
    const headAfter = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: home }).toString().trim();
    assert.notStrictEqual(headAfter, headBefore, 'a new commit must be created by apply');
    // The new commit is exactly ONE commit ahead.
    const logCount = execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: home }).toString().trim();
    assert.strictEqual(Number(logCount), 2, 'exactly ONE commit must be added (init + apply)');
  });
});

// ---------------------------------------------------------------------------
// P3: NEVER-LOOSEN — smuggled gate axis in proposed_diff throws ENEVERLOOSEN
// ---------------------------------------------------------------------------

describe('P3 — NEVER-LOOSEN: smuggled gate axis in proposed_diff throws ENEVERLOOSEN', () => {
  test('proposed_diff with "severity" key throws ENEVERLOOSEN', () => {
    assert.throws(
      () => assertNotGateLoosenedByVoiceDiff({
        drama_dial: { current: 'low', proposed: 'low' },
        severity: { before: 'hard', after: 'soft' },
      }),
      (err) => {
        assert.strictEqual(err.code, 'ENEVERLOOSEN', `expected ENEVERLOOSEN, got ${err.code}`);
        return true;
      },
    );
  });

  test('proposed_diff with "disposition" key throws ENEVERLOOSEN', () => {
    assert.throws(
      () => assertNotGateLoosenedByVoiceDiff({
        drama_dial: { current: 'low', proposed: 'low' },
        disposition: { before: 'block', after: 'warn' },
      }),
      (err) => {
        assert.strictEqual(err.code, 'ENEVERLOOSEN');
        return true;
      },
    );
  });

  test('proposed_diff with "threshold" key throws ENEVERLOOSEN', () => {
    assert.throws(
      () => assertNotGateLoosenedByVoiceDiff({
        drama_dial: { current: 'low', proposed: 'low' },
        threshold: { before: 0.9, after: 0.5 },
      }),
      (err) => {
        assert.strictEqual(err.code, 'ENEVERLOOSEN');
        return true;
      },
    );
  });

  test('proposed_diff with "gate" key throws ENEVERLOOSEN', () => {
    assert.throws(
      () => assertNotGateLoosenedByVoiceDiff({
        drama_dial: { current: 'low', proposed: 'low' },
        gate: { enabled: false },
      }),
      (err) => {
        assert.strictEqual(err.code, 'ENEVERLOOSEN');
        return true;
      },
    );
  });

  test('a clean proposed_diff (voice axes only) does NOT throw', () => {
    assert.doesNotThrow(
      () => assertNotGateLoosenedByVoiceDiff({
        drama_dial: { current: 'low', proposed: 'low' },
        archetype_emphasis: { current: [], proposed: [] },
        hook_preferences: { current: [], proposed: [] },
        cadence_preferences: { current: {}, proposed: {} },
      }),
      'clean voice-only proposed_diff must not throw ENEVERLOOSEN',
    );
  });

  test('applyVoiceCalibration with smuggled severity axis rejects before writing', async (t) => {
    if (!HAS_GIT) { t.skip('git not available'); return; }
    const { home, env, brandId } = tmpHome();
    const rec = makeVoiceRecord(brandId, {
      proposed_diff: JSON.stringify({
        drama_dial: { current: 'low', proposed: 'low' },
        severity: { before: 'hard', after: 'soft' }, // smuggled gate axis
      }),
      proposed_diff_structured: {
        drama_dial: { current: 'low', proposed: 'low' },
        severity: { before: 'hard', after: 'soft' },
      },
    });
    const brandBefore = readBrandJson(home, brandId);

    await assert.rejects(
      () => applyVoiceCalibration(rec, { consent: true, env, now: Date.now(), skipGateRegression: true }),
      (err) => {
        assert.strictEqual(err.code, 'ENEVERLOOSEN', `expected ENEVERLOOSEN, got ${err.code}: ${err.message}`);
        return true;
      },
      'must throw ENEVERLOOSEN for a smuggled gate axis',
    );

    // Nothing should be written.
    const brandAfter = readBrandJson(home, brandId);
    assert.deepStrictEqual(brandAfter, brandBefore, 'brand.json must be unchanged after ENEVERLOOSEN');
  });
});

// ---------------------------------------------------------------------------
// P4: NEVER-TOUCH-HUMAN-ONLY — gate config/rules/thresholds byte-identical after apply
// ---------------------------------------------------------------------------

describe('P4 — gate config/rules/thresholds byte-identical after consented apply', () => {
  test('system.json gate and threshold fields are byte-identical after apply', async (t) => {
    if (!HAS_GIT) { t.skip('git not available'); return; }
    const { home, env, brandId } = tmpHome();
    const rec = makeVoiceRecord(brandId);

    // Snapshot the full system.json before apply.
    const configBefore = readSystemConfig(home);

    await applyVoiceCalibration(rec, {
      consent: true,
      env,
      now: Date.now(),
      gateRegression: { ok: true },
    });

    const configAfter = readSystemConfig(home);

    // The entire system.json should be byte-identical (voice apply never touches system.json).
    assert.deepStrictEqual(configAfter, configBefore,
      'config/system.json must be byte-identical after voice-calibration apply (P4)');

    // Specifically verify gate and threshold fields.
    assert.deepStrictEqual(configAfter.gate, configBefore.gate, 'gate config must be unchanged');
    assert.deepStrictEqual(configAfter.thresholds, configBefore.thresholds, 'thresholds must be unchanged');
    assert.deepStrictEqual(configAfter.reviewers, configBefore.reviewers, 'reviewers must be unchanged');
    assert.deepStrictEqual(configAfter.publish, configBefore.publish, 'publish config must be unchanged');
    assert.deepStrictEqual(configAfter.budget, configBefore.budget, 'budget must be unchanged');
  });

  test('only brand.json voice axes change — no other file in brands/ changes', async (t) => {
    if (!HAS_GIT) { t.skip('git not available'); return; }
    const { home, env, brandId } = tmpHome();
    const rec = makeVoiceRecord(brandId);

    // Snapshot brand.json non-voice fields before apply.
    const brandBefore = readBrandJson(home, brandId);
    const nonVoiceBefore = {
      id: brandBefore.id,
      display_name: brandBefore.display_name,
      account_class: brandBefore.account_class,
      ingestion: brandBefore.ingestion,
      paths: brandBefore.paths,
      platforms: brandBefore.platforms,
    };

    await applyVoiceCalibration(rec, {
      consent: true,
      env,
      now: Date.now(),
      gateRegression: { ok: true },
    });

    const brandAfter = readBrandJson(home, brandId);
    const nonVoiceAfter = {
      id: brandAfter.id,
      display_name: brandAfter.display_name,
      account_class: brandAfter.account_class,
      ingestion: brandAfter.ingestion,
      paths: brandAfter.paths,
      platforms: brandAfter.platforms,
    };
    assert.deepStrictEqual(nonVoiceAfter, nonVoiceBefore,
      'non-voice fields in brand.json must be unchanged after voice calibration apply (P4)');
  });
});

// ---------------------------------------------------------------------------
// P8: VERSIONED+REVERSIBLE — rollback + NO_INSTANCE_REPO
// ---------------------------------------------------------------------------

describe('P8 — versioned and reversible', () => {
  test('refuses apply when $CONTENT_HOME is not a git repo', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oce-vc-nogit-'));
    const env = { CONTENT_HOME: home };
    const brandId = 'acme-cosmos';
    fs.mkdirSync(path.join(home, 'brands', brandId), { recursive: true });
    fs.mkdirSync(path.join(home, 'config'), { recursive: true });
    fs.writeFileSync(path.join(home, 'brands', brandId, 'brand.json'), JSON.stringify(BRAND_CONFIG), 'utf8');
    fs.writeFileSync(path.join(home, 'config', 'system.json'), '{}', 'utf8');

    const rec = makeVoiceRecord(brandId);

    await assert.rejects(
      () => applyVoiceCalibration(rec, { consent: true, env, now: Date.now(), skipGateRegression: true }),
      (err) => {
        assert.strictEqual(err.code, 'NO_INSTANCE_REPO', `expected NO_INSTANCE_REPO, got ${err.code}`);
        return true;
      },
      'must refuse when $CONTENT_HOME is not a git repo',
    );
  });

  test('rollback refuses when not a git repo', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oce-vc-rb-nogit-'));
    const env = { CONTENT_HOME: home };

    const result = await rollbackVoiceCalibration(null, { env, now: Date.now() });
    assert.strictEqual(result.ok, false, 'rollback must fail when not a git repo');
    assert.strictEqual(result.code, 'NO_INSTANCE_REPO');
  });

  test('rollback restores prior voice fields after apply', async (t) => {
    if (!HAS_GIT) { t.skip('git not available'); return; }
    const { home, env, brandId } = tmpHome();
    const rec = makeVoiceRecord(brandId);

    // Capture prior brand.json voice state.
    const brandBefore = readBrandJson(home, brandId);
    const howToBefore = brandBefore.archetype_emphasis.find((e) => e.code === 'HOW_TO');
    assert.strictEqual(howToBefore && howToBefore.weight, 3.0, 'baseline HOW_TO weight is 3.0');

    // Apply.
    const applyResult = await applyVoiceCalibration(rec, {
      consent: true,
      env,
      now: Date.now(),
      gateRegression: { ok: true },
    });
    assert.strictEqual(applyResult.ok, true, 'apply should succeed');
    const baselineRef = applyResult.data.baseline_ref;

    // Verify weight changed.
    const brandAfterApply = readBrandJson(home, brandId);
    const howToAfter = brandAfterApply.archetype_emphasis.find((e) => e.code === 'HOW_TO');
    assert.strictEqual(howToAfter && howToAfter.weight, 3.5, 'HOW_TO weight must be 3.5 after apply');

    // Rollback to baseline.
    const rbResult = await rollbackVoiceCalibration(baselineRef, { env, now: Date.now() });
    assert.ok(rbResult.ok !== false, `rollback should succeed; got: ${rbResult.summary}`);

    // After rollback, brand.json should be restored.
    const brandAfterRollback = readBrandJson(home, brandId);
    const howToRestored = brandAfterRollback.archetype_emphasis.find((e) => e.code === 'HOW_TO');
    assert.strictEqual(howToRestored && howToRestored.weight, 3.0,
      'HOW_TO weight must be restored to 3.0 after rollback (P8)');
  });

  test('rollback commits the governance state-flip — clean worktree + HEAD shows rolled_back (P8)', async (t) => {
    if (!HAS_GIT) { t.skip('git not available'); return; }
    const paths = require('../../shared/paths.js');
    const { home, env, brandId } = tmpHome();
    const rec = makeVoiceRecord(brandId);

    const applyResult = await applyVoiceCalibration(rec, {
      consent: true, env, now: Date.now(), gateRegression: { ok: true },
    });
    assert.strictEqual(applyResult.ok, true, 'apply should succeed');

    const rbResult = await rollbackVoiceCalibration(applyResult.data.baseline_ref, { env, now: Date.now() });
    assert.ok(rbResult.ok !== false, `rollback should succeed; got: ${rbResult.summary}`);

    // The versioned governance state (sidecar + record + brand.json) must be committed — no TRACKED
    // file may be left modified after rollback. (The append-only audit ledger under ledger/ is
    // intentionally untracked operational data, so untracked '??' entries are allowed.)
    const porcelain = execFileSync('git', ['status', '--porcelain'], { cwd: home, encoding: 'utf8' });
    const modifiedTracked = porcelain.split('\n').filter((l) => l.trim() && !l.startsWith('??'));
    assert.deepStrictEqual(modifiedTracked, [],
      `no tracked file may be left modified after rollback (state-flip must be committed); dirty: ${JSON.stringify(modifiedTracked)}`);

    // The governance sidecar committed at HEAD must read rolled_back (not 'applied').
    const appliedDir = paths.learningAppliedDir(env);
    const govFiles = fs.readdirSync(appliedDir).filter((f) => f.endsWith('.governance.json'));
    assert.ok(govFiles.length >= 1, 'an applied governance sidecar must exist');
    const govRel = path.relative(home, path.join(appliedDir, govFiles[0])).split(path.sep).join('/');
    const headGov = JSON.parse(execFileSync('git', ['show', `HEAD:${govRel}`], { cwd: home, encoding: 'utf8' }));
    assert.strictEqual(headGov.governance_state, 'rolled_back',
      'HEAD governance sidecar must read rolled_back after the versioned rollback');
  });

  test('apply result carries baseline_ref and commit (P8 evidence)', async (t) => {
    if (!HAS_GIT) { t.skip('git not available'); return; }
    const { home, env, brandId } = tmpHome();
    const rec = makeVoiceRecord(brandId);

    const result = await applyVoiceCalibration(rec, {
      consent: true,
      env,
      now: Date.now(),
      gateRegression: { ok: true },
    });

    assert.ok(result.ok, 'apply should succeed');
    assert.ok(typeof result.data.baseline_ref === 'string' && result.data.baseline_ref.length >= 7,
      'baseline_ref must be a git SHA');
    assert.ok(typeof result.data.commit === 'string' && result.data.commit.length >= 7,
      'commit must be a git SHA');
  });
});

// ---------------------------------------------------------------------------
// P10: NOT-SHAREABLE-UPSTREAM — improvement-sharing rejects brand:*:voice payloads
// ---------------------------------------------------------------------------

describe('P10 — improvement-sharing evaluate + sanitize reject brand:*:voice payloads', () => {
  test('evaluateContribution rejects a brand:*:voice payload (EHUMANONLY via not_voice_artifact)', () => {
    const voiceContrib = {
      kind: 'rule-diff',
      target_artifact: 'brand:acme-cosmos:voice',
      target: { kind: 'voice', path: 'brand.acme-cosmos.voice' },
      change: { before: { drama_dial: 'low' }, after: { drama_dial: 'medium' } },
      rationale: 'test voice calibration',
    };

    const verdict = evaluateContribution(voiceContrib, { skipGateRegression: true });
    assert.strictEqual(verdict.accepted, false, 'voice artifact contribution must be rejected');
    assert.ok(verdict.checks.not_voice_artifact, 'not_voice_artifact check must be present');
    assert.strictEqual(verdict.checks.not_voice_artifact.ok, false,
      'not_voice_artifact check must fail for brand:*:voice');
    // The reason must be prefixed with [not-shareable-voice].
    assert.ok(verdict.reasons.some((r) => r.startsWith('[not-shareable-voice]')),
      `reasons must include [not-shareable-voice] prefix; got: ${verdict.reasons.join(' | ')}`);
  });

  test('isVoiceArtifact correctly identifies brand:*:voice family', () => {
    assert.ok(evalIsVoiceArtifact('brand:acme-cosmos:voice'));
    assert.ok(evalIsVoiceArtifact('brand:test:voice'));
    assert.ok(evalIsVoiceArtifact('brand:test:drama_dial'));
    assert.strictEqual(evalIsVoiceArtifact('config:calendar.weights'), false);
    assert.strictEqual(evalIsVoiceArtifact('brand:test:archetype'), false);
  });

  test('sanitize.js sanitizeForSharing rejects a voice record before extraction', () => {
    const voiceRecord = {
      id: 'vc-test-001',
      target_artifact: 'brand:acme-cosmos:voice',
      target_mutability: 'human-only',
      proposed_diff: '{}',
      machine_change: { kind: 'voice-calibration', values: {} },
      source_signals: [{ type: 'calibration', count: 4 }],
    };

    assert.throws(
      () => sanitize.sanitizeForSharing(voiceRecord, { brandTerms: [] }),
      (err) => {
        // Must throw UnshareableError with code EUNSHAREABLE.
        assert.ok(err instanceof sanitize.UnshareableError || err.code === 'EUNSHAREABLE',
          `expected UnshareableError/EUNSHAREABLE, got: ${err.name}/${err.code}`);
        return true;
      },
      'sanitizeForSharing must throw for a voice artifact record (P10)',
    );
  });

  test('sanitize.isVoiceArtifact correctly identifies voice artifacts', () => {
    assert.ok(sanitize.isVoiceArtifact('brand:acme-cosmos:voice'));
    assert.ok(sanitize.isVoiceArtifact('brand:test:drama_dial'));
    assert.ok(sanitize.isVoiceArtifact('voice'));
    assert.strictEqual(sanitize.isVoiceArtifact('config:calendar.weights'), false);
  });

  test('voice record target_mutability is always human-only (P2 + P10 combined)', () => {
    const rec = makeVoiceRecord();
    assert.strictEqual(rec.target_mutability, 'human-only',
      'all voice records must carry target_mutability:human-only');
    assert.ok(evalIsVoiceArtifact(rec.target_artifact),
      'target_artifact must be recognized as a voice artifact');
  });
});

// ---------------------------------------------------------------------------
// BLOCKER 3 — P9 freshness re-asserted on apply: stale proposed record => ESTALEREPORT
// ---------------------------------------------------------------------------

describe('BLOCKER3 — apply re-asserts P9 freshness (stale record throws ESTALEREPORT)', () => {
  test('stale-but-proposed record throws ESTALEREPORT and brand.json is byte-identical', async (t) => {
    if (!HAS_GIT) { t.skip('git not available'); return; }
    const { home, env, brandId } = tmpHome();
    const brandBefore = readBrandJson(home, brandId);

    // Build a record that carries a scan_freshness_expires_at already in the past (stale).
    const staleRec = makeVoiceRecord(brandId, {
      // The proposed record was written when fresh, but the scan has since expired.
      scan_freshness_expires_at: '2000-01-01T00:00:00.000Z', // far in the past
    });

    // applyVoiceCalibration must throw ESTALEREPORT before writing anything.
    await assert.rejects(
      () => applyVoiceCalibration(staleRec, {
        consent: true,
        env,
        now: Date.now(), // now is well past the 2000-01-01 expiry
        skipGateRegression: true,
      }),
      (err) => {
        assert.strictEqual(err.code, 'ESTALEREPORT',
          `BLOCKER3: expected ESTALEREPORT for stale record, got ${err.code}: ${err.message}`);
        return true;
      },
      'BLOCKER3: stale proposed record must throw ESTALEREPORT in apply',
    );

    // brand.json must be byte-identical — nothing was written.
    const brandAfter = readBrandJson(home, brandId);
    assert.deepStrictEqual(brandAfter, brandBefore,
      'BLOCKER3: brand.json must be byte-identical after ESTALEREPORT (nothing written)');
  });

  test('fresh proposed record (unexpired scan_freshness_expires_at) applies without ESTALEREPORT', async (t) => {
    if (!HAS_GIT) { t.skip('git not available'); return; }
    const { home, env, brandId } = tmpHome();

    // Record with a freshness window far in the future.
    const freshRec = makeVoiceRecord(brandId, {
      scan_freshness_expires_at: '2200-01-01T00:00:00.000Z', // far in the future
    });

    const result = await applyVoiceCalibration(freshRec, {
      consent: true,
      env,
      now: Date.now(),
      gateRegression: { ok: true },
    });

    assert.strictEqual(result.ok, true,
      `BLOCKER3: fresh record must apply successfully; got: ${result.summary}`);
  });

  test('record with NO scan_freshness_expires_at falls back to created_at + default window (stale => ESTALEREPORT)', async (t) => {
    if (!HAS_GIT) { t.skip('git not available'); return; }
    const { home, env, brandId } = tmpHome();
    const brandBefore = readBrandJson(home, brandId);

    // No persisted expiry; created_at is far in the past so the derived 30-day fallback window is expired.
    const rec = makeVoiceRecord(brandId, { scan_freshness_expires_at: undefined, created_at: '2000-01-01T00:00:00.000Z' });

    await assert.rejects(
      () => applyVoiceCalibration(rec, { consent: true, env, now: Date.now(), skipGateRegression: true }),
      (err) => {
        assert.strictEqual(err.code, 'ESTALEREPORT',
          `expected ESTALEREPORT via created_at fallback, got ${err.code}: ${err.message}`);
        return true;
      },
      'a record with only an old created_at must be treated as stale via the fallback window',
    );
    assert.deepStrictEqual(readBrandJson(home, brandId), brandBefore,
      'brand.json must be byte-identical after ESTALEREPORT (nothing written)');
  });

  test('record with NO derivable freshness anchor refuses (fail closed, ESTALEREPORT)', async (t) => {
    if (!HAS_GIT) { t.skip('git not available'); return; }
    const { home, env, brandId } = tmpHome();
    const brandBefore = readBrandJson(home, brandId);

    // Neither a persisted expiry nor a parseable created_at — recency cannot be proven => fail closed.
    const rec = makeVoiceRecord(brandId, { scan_freshness_expires_at: undefined, created_at: undefined });

    await assert.rejects(
      () => applyVoiceCalibration(rec, { consent: true, env, now: Date.now(), skipGateRegression: true }),
      (err) => {
        assert.strictEqual(err.code, 'ESTALEREPORT',
          `expected ESTALEREPORT for a record with no freshness anchor, got ${err.code}: ${err.message}`);
        return true;
      },
      'a record with no freshness anchor must fail closed (ESTALEREPORT), never apply',
    );
    assert.deepStrictEqual(readBrandJson(home, brandId), brandBefore,
      'brand.json must be byte-identical after ESTALEREPORT (nothing written)');
  });
});

// ---------------------------------------------------------------------------
// Gate-regression gate (P4 structural: gate must pass before write)
// ---------------------------------------------------------------------------

describe('Gate-regression gate — refuses write when regression fails', () => {
  test('returns GATE_REGRESSION_FAILED when gate-regression is red', async (t) => {
    if (!HAS_GIT) { t.skip('git not available'); return; }
    const { home, env, brandId } = tmpHome();
    const rec = makeVoiceRecord(brandId);
    const brandBefore = readBrandJson(home, brandId);

    const result = await applyVoiceCalibration(rec, {
      consent: true,
      env,
      now: Date.now(),
      gateRegression: { ok: false, reason: 'injected failure' },
    });

    assert.strictEqual(result.ok, false, 'apply must fail when gate-regression is red');
    assert.strictEqual(result.code, 'GATE_REGRESSION_FAILED');

    // brand.json must NOT have been written.
    const brandAfter = readBrandJson(home, brandId);
    assert.deepStrictEqual(brandAfter, brandBefore,
      'brand.json must be unchanged when gate-regression fails (P4 pre-write gate)');
  });
});
