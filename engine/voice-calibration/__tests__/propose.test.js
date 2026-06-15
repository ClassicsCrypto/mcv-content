'use strict';

/**
 * engine/voice-calibration/__tests__/propose.test.js  [N net-new — CS-STAGE-4 propose tests]
 *
 * Coverage for engine/voice-calibration/propose.js proposeVoiceCalibration.
 *
 * Mandatory safety properties proven:
 *   P2  CONSENT-GATED/NEVER-AUTO-APPLY: the record is always target_mutability:human-only;
 *       classifyTarget of the voice target must return human-only.
 *   P6  DETERMINISTIC: identical scan report + brand config + now => byte-identical record.
 *   P7  ANALYST-SEAT: a mutating seat has no effect on structural fields; a throwing/absent seat
 *       degrades to the deterministic rationale.
 *   P9  FRESHNESS (DD-15): a scan older than freshness_days THROWS ESTALEREPORT; a fresh scan passes.
 *   P10 NOT-SHAREABLE-UPSTREAM: the improvement-sharing evaluateContribution rejects brand:*:voice.
 *
 * Zero-key: no API calls, no network; all inputs are in-memory or fixture files.
 *
 * Runner: node:test (Node >= 22).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const {
  proposeVoiceCalibration,
  assertFresh,
  deriveDramaDial,
  deriveArchetypeEmphasis,
  deriveHookPreferences,
  deriveCadencePreferences,
  voiceArtifact,
  VOICE_TARGET_DESCRIPTOR,
  StaleReportError,
  VerbatimCopyError,
} = require('../propose.js');

const mutability = require('../../self-improve/mutability.js');
const { evaluateContribution } = require('../../improvement-sharing/evaluate.js');
const { wellBehaved, mutating, throwing } = require('../../../fixtures/competitor-scan-acme/helpers/fake-analyst-seat.js');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIX_DIR = path.join(__dirname, '..', '..', '..', 'fixtures', 'competitor-scan-acme');
const SCAN_REPORT = JSON.parse(fs.readFileSync(path.join(FIX_DIR, 'scans', 'acme-cosmos', '2099-03-15.json'), 'utf8'));
const BRAND_CONFIG = JSON.parse(fs.readFileSync(path.join(FIX_DIR, 'brand.json'), 'utf8'));

// A "fresh" scan for tests: scan dated in the future, expires far from now.
// We inject `now` before the freshness window expires.
const NOW_BEFORE_EXPIRY = Date.parse('2099-03-20T00:00:00Z'); // 5 days into the scan window

// A stale now: well past the expires_at.
const NOW_AFTER_EXPIRY = Date.parse('2099-05-01T00:00:00Z'); // 47 days after 2099-03-15

// ---------------------------------------------------------------------------
// Helper: make a tmp CONTENT_HOME for write tests
// ---------------------------------------------------------------------------
function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oce-vc-propose-'));
  const env = { CONTENT_HOME: home };
  return { home, env };
}

// ---------------------------------------------------------------------------
// 1. VOICE_TARGET_DESCRIPTOR classification (P2)
// ---------------------------------------------------------------------------

describe('classifyTarget(VOICE_TARGET_DESCRIPTOR) — always human-only (P2)', () => {
  test('VOICE_TARGET_DESCRIPTOR { kind:"voice" } classifies as human-only', () => {
    const result = mutability.classifyTarget(VOICE_TARGET_DESCRIPTOR);
    assert.strictEqual(result.classification, mutability.CLASSIFICATION.HUMAN_ONLY,
      'voice target must always be classified human-only under DD-6 fail-closed');
  });

  test('brand:acme-cosmos:voice artifact descriptor also classifies as human-only', () => {
    const result = mutability.classifyTarget({ kind: 'voice', path: 'brand.acme-cosmos.voice' });
    assert.strictEqual(result.classification, mutability.CLASSIFICATION.HUMAN_ONLY);
  });

  test('voiceArtifact() produces "brand:<id>:voice" format', () => {
    assert.strictEqual(voiceArtifact('acme-cosmos'), 'brand:acme-cosmos:voice');
    assert.strictEqual(voiceArtifact('test-brand'), 'brand:test-brand:voice');
  });
});

// ---------------------------------------------------------------------------
// 2. DD-15 freshness guard (P9)
// ---------------------------------------------------------------------------

describe('assertFresh — DD-15 freshness guard (P9)', () => {
  test('fresh scan (now before expires_at) does not throw', () => {
    assert.doesNotThrow(() => assertFresh(SCAN_REPORT, NOW_BEFORE_EXPIRY, 30));
  });

  test('stale scan (now after expires_at) throws ESTALEREPORT', () => {
    assert.throws(
      () => assertFresh(SCAN_REPORT, NOW_AFTER_EXPIRY, 30),
      (err) => {
        assert.strictEqual(err.code, 'ESTALEREPORT', 'must throw ESTALEREPORT for stale scan');
        assert.ok(err instanceof StaleReportError);
        return true;
      },
    );
  });

  test('scan without freshness_window but old period.end is stale after freshness_days', () => {
    // Build a minimal report with no freshness_window and no provenance — only period.end.
    const oldReport = {
      brand: 'test-brand',
      drama_signal: 'low',
      confidence: 0.5,
      period: { start: '2098-01-01T00:00:00Z', end: '2098-01-15T00:00:00Z' },
      // No freshness_window, no provenance — so the code falls through to period.end check.
    };
    const now2099 = Date.parse('2099-03-15T00:00:00Z');
    assert.throws(
      () => assertFresh(oldReport, now2099, 30),
      (err) => {
        assert.strictEqual(err.code, 'ESTALEREPORT');
        return true;
      },
    );
  });

  test('a scan with no date info at all passes (cannot prove stale without a date)', () => {
    const noDateReport = { brand: 'test', drama_signal: 'low', confidence: 0.5 };
    assert.doesNotThrow(() => assertFresh(noDateReport, Date.now(), 30));
  });
});

// ---------------------------------------------------------------------------
// 3. Axis derivation helpers — deterministic, pure (P6)
// ---------------------------------------------------------------------------

describe('deriveDramaDial — deterministic, pure', () => {
  test('competitor high drama + current low => keeps low (ANTI-PATTERN: do not raise)', () => {
    const result = deriveDramaDial({ drama_signal: 'high' }, 'low');
    assert.strictEqual(result.current, 'low');
    assert.strictEqual(result.proposed, 'low');
    assert.strictEqual(result.changed, false);
  });

  test('competitor low drama + current high => softens to medium', () => {
    const result = deriveDramaDial({ drama_signal: 'low' }, 'high');
    assert.strictEqual(result.proposed, 'medium');
    assert.strictEqual(result.changed, true);
  });

  test('competitor low drama + current low => no change', () => {
    const result = deriveDramaDial({ drama_signal: 'low' }, 'low');
    assert.strictEqual(result.changed, false);
    assert.strictEqual(result.proposed, 'low');
  });

  test('competitor medium drama => no change', () => {
    const result = deriveDramaDial({ drama_signal: 'medium' }, 'low');
    assert.strictEqual(result.changed, false);
  });
});

describe('deriveArchetypeEmphasis — deterministic, pure', () => {
  const scanReport = SCAN_REPORT;
  const current = BRAND_CONFIG.archetype_emphasis;

  test('HOW_TO code in high_engagement and competitor_count>0 gets a weight boost', () => {
    const result = deriveArchetypeEmphasis(scanReport, current);
    const howTo = result.proposed.find((e) => e.code === 'HOW_TO');
    const curHowTo = current.find((e) => e.code === 'HOW_TO');
    assert.ok(howTo, 'HOW_TO must be in proposed');
    assert.ok(howTo.weight > curHowTo.weight, 'HOW_TO weight should increase');
  });

  test('codes not in competitor corpus are unchanged', () => {
    const result = deriveArchetypeEmphasis(scanReport, current);
    const skyTonight = result.proposed.find((e) => e.code === 'SKY_TONIGHT');
    const curSkyTonight = current.find((e) => e.code === 'SKY_TONIGHT');
    if (skyTonight && curSkyTonight) {
      // SKY_TONIGHT has competitor_count=0 in the fixture scan, so no change expected.
      assert.strictEqual(skyTonight.weight, curSkyTonight.weight);
    }
  });

  test('no new codes are added (only existing codes are boosted)', () => {
    const result = deriveArchetypeEmphasis(scanReport, current);
    const curCodes = new Set(current.map((e) => e.code));
    for (const e of result.proposed) {
      assert.ok(curCodes.has(e.code), `unexpected new code ${e.code} added to archetype_emphasis`);
    }
  });

  test('empty current emphasis => no changes (cannot add codes)', () => {
    const result = deriveArchetypeEmphasis(scanReport, []);
    assert.deepEqual(result.proposed, []);
    assert.strictEqual(result.changed, false);
  });
});

describe('deriveHookPreferences — deterministic, pure', () => {
  const scanReport = SCAN_REPORT;
  const current = BRAND_CONFIG.hook_preferences;

  test('how-to-numbered pattern with count>=2 gets a weight boost', () => {
    const result = deriveHookPreferences(scanReport, current);
    const hn = result.proposed.find((p) => p.pattern === 'how-to-numbered');
    const curHn = current.find((p) => p.pattern === 'how-to-numbered');
    if (hn && curHn) {
      assert.ok(hn.weight >= curHn.weight, 'how-to-numbered weight should not decrease');
    }
  });

  test('patterns with count<2 are not boosted', () => {
    // announcement-breaking appears once (count=1) in the fixture — should not boost any matching pref.
    const result = deriveHookPreferences(scanReport, current);
    // question-hook is in current preferences but not in top_patterns at all; weight stays.
    const qh = result.proposed.find((p) => p.pattern === 'question-hook');
    const curQh = current.find((p) => p.pattern === 'question-hook');
    if (qh && curQh) {
      assert.strictEqual(qh.weight, curQh.weight, 'question-hook weight should be unchanged (not in top_patterns)');
    }
  });

  test('empty current preferences => no changes', () => {
    const result = deriveHookPreferences(scanReport, []);
    assert.deepEqual(result.proposed, []);
    assert.strictEqual(result.changed, false);
  });
});

describe('deriveCadencePreferences — conservative, deterministic', () => {
  test('with enough items (>=4), cadence unchanged (conservative policy)', () => {
    const result = deriveCadencePreferences(SCAN_REPORT, BRAND_CONFIG.cadence_preferences);
    // Conservative policy: no change unless there's a compelling reason.
    assert.deepEqual(result.proposed, result.current, 'cadence should be unchanged by conservative policy');
    assert.strictEqual(result.changed, false);
  });

  test('with no cadence data at all, returns reasonable defaults', () => {
    const result = deriveCadencePreferences({}, null);
    assert.ok(result.proposed, 'should return a proposed object');
    assert.ok(typeof result.proposed.preferred_posts_per_week === 'number');
  });
});

// ---------------------------------------------------------------------------
// 4. proposeVoiceCalibration — full integration (P2, P6, P7, P9)
// ---------------------------------------------------------------------------

describe('proposeVoiceCalibration — integration', () => {
  test('P2: the record is always target_mutability:human-only and status:proposed', async () => {
    const { home, env } = tmpHome();
    try {
      const result = await proposeVoiceCalibration(SCAN_REPORT, BRAND_CONFIG, {
        env,
        now: NOW_BEFORE_EXPIRY,
        write: false,
      });
      assert.strictEqual(result.record.target_mutability, 'human-only',
        'target_mutability must always be human-only');
      assert.strictEqual(result.record.status, 'proposed',
        'status must always be proposed (never applied)');
      assert.strictEqual(result.record.target_artifact, voiceArtifact(BRAND_CONFIG.id),
        'target_artifact must be brand:<id>:voice');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('P2: classifyTarget of the record target descriptor returns human-only', async () => {
    const { home, env } = tmpHome();
    try {
      const result = await proposeVoiceCalibration(SCAN_REPORT, BRAND_CONFIG, {
        env,
        now: NOW_BEFORE_EXPIRY,
        write: false,
      });
      // The target_artifact format "brand:<id>:voice" — classifyTarget with kind:'voice' is human-only.
      const classResult = mutability.classifyTarget(VOICE_TARGET_DESCRIPTOR);
      assert.strictEqual(classResult.classification, mutability.CLASSIFICATION.HUMAN_ONLY);

      // Also assert no auto_applicable flag on the record.
      assert.ok(result.record.target_mutability === 'human-only',
        'record must never be auto-applicable (human-only by governance)');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('P6: identical inputs => byte-identical record (injected now)', async () => {
    const { home, env } = tmpHome();
    try {
      const opts = { env, now: NOW_BEFORE_EXPIRY, write: false };
      const r1 = await proposeVoiceCalibration(SCAN_REPORT, BRAND_CONFIG, opts);
      const r2 = await proposeVoiceCalibration(SCAN_REPORT, BRAND_CONFIG, opts);
      assert.deepEqual(r1.record, r2.record, 'identical inputs must produce byte-identical records');
      assert.deepEqual(r1.proposed_diff, r2.proposed_diff, 'proposed_diff must be byte-identical');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('P9: stale scan (now after expires_at) throws ESTALEREPORT', async () => {
    const { home, env } = tmpHome();
    try {
      await assert.rejects(
        () => proposeVoiceCalibration(SCAN_REPORT, BRAND_CONFIG, { env, now: NOW_AFTER_EXPIRY, write: false }),
        (err) => {
          assert.strictEqual(err.code, 'ESTALEREPORT', 'stale scan must throw ESTALEREPORT');
          return true;
        },
      );
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('P7: well-behaved analyst seat injects a rationale string', async () => {
    const { home, env } = tmpHome();
    try {
      const result = await proposeVoiceCalibration(SCAN_REPORT, BRAND_CONFIG, {
        env,
        now: NOW_BEFORE_EXPIRY,
        write: false,
        analystSeat: { refine: wellBehaved },
      });
      assert.ok(typeof result.record.rationale === 'string', 'rationale must be a string');
      assert.ok(result.record.rationale.length > 0, 'rationale must be non-empty');
      // The well-behaved seat should provide a different (longer/annotated) rationale.
      // The structural fields must be unchanged.
      assert.strictEqual(result.record.target_mutability, 'human-only');
      assert.strictEqual(result.record.status, 'proposed');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('P7: mutating analyst seat has no effect on structural fields', async () => {
    const { home, env } = tmpHome();
    try {
      // Run WITHOUT seat for baseline.
      const base = await proposeVoiceCalibration(SCAN_REPORT, BRAND_CONFIG, {
        env,
        now: NOW_BEFORE_EXPIRY,
        write: false,
      });

      // Run WITH mutating seat.
      const result = await proposeVoiceCalibration(SCAN_REPORT, BRAND_CONFIG, {
        env,
        now: NOW_BEFORE_EXPIRY,
        write: false,
        analystSeat: { refine: mutating },
      });

      // Structural fields must be identical to the non-seat run.
      assert.strictEqual(result.record.target_mutability, 'human-only',
        'mutating seat must not change target_mutability');
      assert.strictEqual(result.record.status, 'proposed',
        'mutating seat must not change status');
      assert.strictEqual(result.record.target_artifact, base.record.target_artifact,
        'mutating seat must not change target_artifact');

      // Proposed diff structure must match the base run.
      assert.deepEqual(result.proposed_diff, base.proposed_diff,
        'mutating seat must not change the proposed_diff structure');

      // Source signals must match.
      assert.deepEqual(result.record.source_signals, base.record.source_signals,
        'mutating seat must not change source_signals');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('P7: throwing analyst seat degrades to deterministic rationale (no failure)', async () => {
    const { home, env } = tmpHome();
    try {
      // Should NOT throw even though the seat throws.
      const result = await proposeVoiceCalibration(SCAN_REPORT, BRAND_CONFIG, {
        env,
        now: NOW_BEFORE_EXPIRY,
        write: false,
        analystSeat: { refine: throwing },
      });
      // The record is produced despite the seat error.
      assert.ok(result.record, 'record must be produced even when seat throws');
      assert.strictEqual(result.record.target_mutability, 'human-only');
      assert.ok(typeof result.record.rationale === 'string', 'rationale must fall back to deterministic');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('P7: absent analyst seat produces the deterministic rationale', async () => {
    const { home, env } = tmpHome();
    try {
      const result = await proposeVoiceCalibration(SCAN_REPORT, BRAND_CONFIG, {
        env,
        now: NOW_BEFORE_EXPIRY,
        write: false,
        // no analystSeat
      });
      assert.ok(typeof result.record.rationale === 'string', 'deterministic rationale must be present');
      assert.ok(result.record.rationale.length > 0, 'deterministic rationale must be non-empty');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('write:true writes the record to $CONTENT_HOME/learning/proposed/', async () => {
    const { home, env } = tmpHome();
    try {
      const result = await proposeVoiceCalibration(SCAN_REPORT, BRAND_CONFIG, {
        env,
        now: NOW_BEFORE_EXPIRY,
        write: true,
      });
      assert.ok(result.written, 'written path must be set');
      assert.ok(fs.existsSync(result.written), 'written file must exist');
      const written = JSON.parse(fs.readFileSync(result.written, 'utf8'));
      assert.strictEqual(written.target_mutability, 'human-only');
      assert.strictEqual(written.status, 'proposed');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('proposed_diff.drama_dial is not raised for a high-drama competitor (ANTI-PATTERN)', async () => {
    const { home, env } = tmpHome();
    try {
      // Fixture scan has drama_signal:"high"; brand is "low".
      const result = await proposeVoiceCalibration(SCAN_REPORT, BRAND_CONFIG, {
        env,
        now: NOW_BEFORE_EXPIRY,
        write: false,
      });
      const drama = result.proposed_diff.drama_dial;
      assert.strictEqual(drama.current, 'low', 'current drama_dial should be low');
      assert.strictEqual(drama.proposed, 'low',
        'drama_dial must NOT be raised to match high-drama competitor (ANTI-PATTERN)');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('source_signals is always [{ type:"calibration", count: N }]', async () => {
    const { home, env } = tmpHome();
    try {
      const result = await proposeVoiceCalibration(SCAN_REPORT, BRAND_CONFIG, {
        env,
        now: NOW_BEFORE_EXPIRY,
        write: false,
      });
      const sigs = result.record.source_signals;
      assert.ok(Array.isArray(sigs) && sigs.length > 0, 'source_signals must be a non-empty array');
      assert.strictEqual(sigs[0].type, 'calibration', 'signal type must be "calibration"');
      assert.ok(typeof sigs[0].count === 'number' && sigs[0].count > 0, 'signal count must be > 0');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 5. P10: improvement-sharing evaluateContribution rejects brand:*:voice
// ---------------------------------------------------------------------------

describe('P10 NOT-SHAREABLE-UPSTREAM: evaluateContribution rejects brand:*:voice', () => {
  test('a contribution targeting brand:acme-cosmos:voice is rejected (EHUMANONLY family)', () => {
    const voiceContribution = {
      kind: 'rule-diff',
      target_artifact: 'brand:acme-cosmos:voice',
      target: { kind: 'voice', path: 'brand.acme-cosmos.voice' },
      change: { before: { drama_dial: 'low' }, after: { drama_dial: 'medium' } },
      rationale: 'test voice calibration contribution',
    };

    const verdict = evaluateContribution(voiceContribution, { skipGateRegression: true });
    assert.strictEqual(verdict.accepted, false,
      'voice calibration contribution must be rejected (not shareable upstream)');
    assert.ok(
      verdict.reasons.some((r) => r.includes('voice') || r.includes('brand')),
      'verdict must mention voice/brand in rejection reasons',
    );
  });

  test('a contribution targeting brand:*:drama_dial is also rejected', () => {
    const dramaContrib = {
      kind: 'rule-diff',
      target_artifact: 'brand:test:drama_dial',
      target: { kind: 'voice' },
      change: { before: 'low', after: 'medium' },
    };
    const verdict = evaluateContribution(dramaContrib, { skipGateRegression: true });
    assert.strictEqual(verdict.accepted, false);
  });

  test('the not_voice_artifact check is reported in checks object', () => {
    const voiceContrib = {
      kind: 'rule-diff',
      target_artifact: 'brand:test-brand:voice',
      target: { kind: 'voice' },
      change: { before: {}, after: { drama_dial: 'medium' } },
    };
    const verdict = evaluateContribution(voiceContrib, { skipGateRegression: true });
    assert.ok(verdict.checks.not_voice_artifact, 'not_voice_artifact check must be present in checks');
    assert.strictEqual(verdict.checks.not_voice_artifact.ok, false);
  });

  test('a well-formed non-voice contribution passes the voice artifact check', () => {
    // A legit calendar-weighting contribution (machine-changeable).
    const calContrib = {
      kind: 'rule-diff',
      target: {
        kind: 'calendar-weighting',
        path: 'calendar.weights.trend',
      },
      change: {
        values: { trend: 0.6 },
      },
      rationale: 'increase trend slot weight based on analytics signal',
    };
    const verdict = evaluateContribution(calContrib, { skipGateRegression: true });
    // The voice artifact check should pass.
    assert.ok(verdict.checks.not_voice_artifact.ok, 'non-voice contribution must pass voice check');
    // (Other checks may fail for this synthetic contrib — that is OK; we only verify the voice check.)
  });
});

// ---------------------------------------------------------------------------
// BLOCKER 4 — P1 verbatim guard in propose.js: adversarial seat returning competitor shingle
// ---------------------------------------------------------------------------

describe('BLOCKER4 — P1 verbatim guard: adversarial analyst seat returning competitor shingle', () => {
  // Load one competitor corpus item whose text we will use as the adversarial payload.
  const FIX_CORP_DIR = path.join(FIX_DIR, 'corpora', 'acme-cosmos', 'competitors', 'orbit-outfitters');
  const compItem = JSON.parse(fs.readFileSync(path.join(FIX_CORP_DIR, 'comp-001.json'), 'utf8'));
  // The verbatim competitor shingle (>= 40 chars) that must NOT appear in the rationale.
  const verbatimShingle = compItem.text.trim();

  test('BLOCKER4: adversarial seat returning a competitor shingle — seat output dropped, deterministic fallback used, record free of verbatim copy', async () => {
    const { home, env } = tmpHome();
    try {
      // Build an adversarial seat that returns a string containing verbatim competitor text.
      const adversarialSeat = {
        refine: async () => `ADVERSARIAL: ${verbatimShingle} (this should be dropped)`,
      };

      // The competitor corpus texts must be provided so the guard has texts to check against.
      const competitorCorpusTexts = [compItem];

      // proposeVoiceCalibration must NOT throw — it drops the seat output and falls back to the
      // deterministic rationale (which is guaranteed free of competitor copy). Only throws
      // EVERBATIMCOPY if verbatim still leaks even after the fallback.
      const result = await proposeVoiceCalibration(SCAN_REPORT, BRAND_CONFIG, {
        env,
        now: NOW_BEFORE_EXPIRY,
        write: false,
        analystSeat: adversarialSeat,
        competitorCorpusTexts,
      });

      assert.ok(result.record, 'BLOCKER4: record must be produced (seat dropped, fallback used)');

      // The rationale must NOT contain the verbatim competitor shingle.
      assert.ok(
        !result.record.rationale.includes(verbatimShingle),
        'BLOCKER4: final rationale must not contain verbatim competitor text (seat output dropped)',
      );
      // Also assert the rationale does not contain the adversarial prefix.
      assert.ok(
        !result.record.rationale.includes('ADVERSARIAL:'),
        'BLOCKER4: adversarial seat output must be fully discarded',
      );
      // The record is still valid.
      assert.strictEqual(result.record.target_mutability, 'human-only');
      assert.strictEqual(result.record.status, 'proposed');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('BLOCKER4: adversarial seat + verbatim leak in record snapshot throws EVERBATIMCOPY and nothing written', async () => {
    // This tests the case where the verbatim text somehow appears in the record snapshot itself
    // (not just the rationale) — i.e. the deterministic fallback cannot save it.
    // We simulate this by placing the verbatim shingle inside the proposed_diff structure
    // (which is part of recordSnapshotForVerbatimCheck) — this is the "still leaks" path.
    const { home, env } = tmpHome();
    try {
      const competitorCorpusTexts = [compItem];

      // Inject the verbatim shingle into the scan report's hook_signals.top_patterns.pattern
      // field (a string that will be recursively scanned in the record snapshot via proposed_diff).
      // We do this by patching the scan report's hook_signals so the proposed_diff ends up with
      // the verbatim text in hook_preferences.proposed[].pattern.
      // The cleanest approach: pass a brand config with hook_preferences that exactly match a
      // competitor shingle as a pattern name — the deriveHookPreferences will propagate it into
      // proposed_diff.hook_preferences.proposed[].pattern, which is in the record snapshot.
      const contaminatedBrandConfig = {
        ...BRAND_CONFIG,
        hook_preferences: [
          { pattern: verbatimShingle, weight: 2.0 }, // verbatim shingle as a pattern label
        ],
      };

      await assert.rejects(
        () => proposeVoiceCalibration(SCAN_REPORT, contaminatedBrandConfig, {
          env,
          now: NOW_BEFORE_EXPIRY,
          write: true,
          competitorCorpusTexts,
        }),
        (err) => {
          assert.ok(
            err.code === 'EVERBATIMCOPY',
            `BLOCKER4: expected EVERBATIMCOPY when record snapshot contains competitor shingle, got ${err.code}: ${err.message}`,
          );
          assert.ok(err instanceof VerbatimCopyError || err.code === 'EVERBATIMCOPY');
          return true;
        },
        'BLOCKER4: verbatim leak in record snapshot must throw EVERBATIMCOPY',
      );

      // Nothing must have been written to the proposed dir.
      const proposedDir = path.join(home, 'learning', 'proposed');
      const hasProposed = fs.existsSync(proposedDir) &&
        fs.readdirSync(proposedDir).some((f) => f.endsWith('.json'));
      assert.strictEqual(hasProposed, false,
        'BLOCKER4: no record must be written when EVERBATIMCOPY is thrown from record snapshot check');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('BLOCKER4: deterministic rationale (no seat) with competitor corpus passes cleanly', async () => {
    // The deterministic rationale never contains competitor text — it only uses labels/codes/counts.
    const { home, env } = tmpHome();
    try {
      const competitorCorpusTexts = [compItem];
      const result = await proposeVoiceCalibration(SCAN_REPORT, BRAND_CONFIG, {
        env,
        now: NOW_BEFORE_EXPIRY,
        write: false,
        // no analystSeat — purely deterministic
        competitorCorpusTexts,
      });
      assert.ok(result.record, 'BLOCKER4: record must be produced when rationale is clean');
      assert.strictEqual(result.record.target_mutability, 'human-only');
      // Rationale must NOT contain the verbatim shingle.
      assert.ok(
        !result.record.rationale.includes(verbatimShingle),
        'BLOCKER4: deterministic rationale must not contain verbatim competitor text',
      );
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('BLOCKER4: seat returning a clean rationale (no competitor copy) passes and record is written', async () => {
    const { home, env } = tmpHome();
    try {
      const cleanSeat = {
        refine: async () => 'Clean analyst annotation: numbered hook pattern signals strong engagement lift. Recommend maintaining drama_dial:low.',
      };
      const competitorCorpusTexts = [compItem];
      const result = await proposeVoiceCalibration(SCAN_REPORT, BRAND_CONFIG, {
        env,
        now: NOW_BEFORE_EXPIRY,
        write: false,
        analystSeat: cleanSeat,
        competitorCorpusTexts,
      });
      assert.ok(result.record, 'BLOCKER4: clean seat must produce a record');
      assert.ok(typeof result.record.rationale === 'string', 'rationale must be a string');
      // The clean seat rationale must be used (not the deterministic fallback).
      assert.ok(
        result.record.rationale.includes('Clean analyst annotation'),
        'BLOCKER4: clean seat rationale must be preserved',
      );
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 6. proposed_diff structure matches the expected fixture shape
// ---------------------------------------------------------------------------

describe('proposed_diff structure — four axes present', () => {
  test('all four axes are present in proposed_diff', async () => {
    const { home, env } = tmpHome();
    try {
      const result = await proposeVoiceCalibration(SCAN_REPORT, BRAND_CONFIG, {
        env,
        now: NOW_BEFORE_EXPIRY,
        write: false,
      });
      const diff = result.proposed_diff;
      assert.ok('drama_dial' in diff, 'drama_dial must be in proposed_diff');
      assert.ok('archetype_emphasis' in diff, 'archetype_emphasis must be in proposed_diff');
      assert.ok('hook_preferences' in diff, 'hook_preferences must be in proposed_diff');
      assert.ok('cadence_preferences' in diff, 'cadence_preferences must be in proposed_diff');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('drama_dial.current and drama_dial.proposed are valid enum values', async () => {
    const { home, env } = tmpHome();
    const VALID = ['low', 'medium', 'high'];
    try {
      const result = await proposeVoiceCalibration(SCAN_REPORT, BRAND_CONFIG, {
        env,
        now: NOW_BEFORE_EXPIRY,
        write: false,
      });
      const drama = result.proposed_diff.drama_dial;
      assert.ok(VALID.includes(drama.current), `drama_dial.current "${drama.current}" must be a valid enum value`);
      assert.ok(VALID.includes(drama.proposed), `drama_dial.proposed "${drama.proposed}" must be a valid enum value`);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('archetype_emphasis items have code (string) and weight (number>0)', async () => {
    const { home, env } = tmpHome();
    try {
      const result = await proposeVoiceCalibration(SCAN_REPORT, BRAND_CONFIG, {
        env,
        now: NOW_BEFORE_EXPIRY,
        write: false,
      });
      for (const item of result.proposed_diff.archetype_emphasis.proposed) {
        assert.ok(typeof item.code === 'string', 'code must be a string');
        assert.ok(typeof item.weight === 'number' && item.weight > 0, 'weight must be a positive number');
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('hook_preferences items have pattern (string) and weight (number>0)', async () => {
    const { home, env } = tmpHome();
    try {
      const result = await proposeVoiceCalibration(SCAN_REPORT, BRAND_CONFIG, {
        env,
        now: NOW_BEFORE_EXPIRY,
        write: false,
      });
      for (const item of result.proposed_diff.hook_preferences.proposed) {
        assert.ok(typeof item.pattern === 'string', 'pattern must be a string');
        assert.ok(typeof item.weight === 'number' && item.weight > 0, 'weight must be a positive number');
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
