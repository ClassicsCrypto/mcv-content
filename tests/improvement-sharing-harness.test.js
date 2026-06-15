'use strict';

// tests/improvement-sharing-harness.test.js
// Exercises two things the unit suites previously left unguarded (roadmap #4 / DD-7(4)):
//   1. the INBOUND maintainer-evaluation fixtures actually evaluate to their committed
//      ground truth (fixtures/.../expected/evaluate-outcomes.json) — and reject for the RIGHT
//      structural reason, not on shape/internal_id noise. Guards against fixture drift.
//   2. contributionsDir honors config.improvement_sharing.package_output_path (the configured
//      LOCAL output location for a manual PR; DD-7 (1) no auto-send).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const ev = require('../engine/improvement-sharing/evaluate.js');
const pkg = require('../engine/improvement-sharing/package.js');

const FIX = path.join(REPO, 'fixtures/improvement-sharing-acme');

// 1. Inbound fixtures → committed ground-truth verdicts.
test('inbound fixtures evaluate to their committed ground-truth verdicts', () => {
  const truth = JSON.parse(fs.readFileSync(path.join(FIX, 'expected/evaluate-outcomes.json'), 'utf8'));
  // The text signature each rejection code must carry (reasons, not a structured code field).
  const codeSignature = {
    ENEVERLOOSEN: /loosen|§3\.1/i,
    EHUMANONLY: /human-only|DD-6/i,
  };
  for (const row of truth.contributions) {
    const c = JSON.parse(fs.readFileSync(path.join(FIX, row.contribution), 'utf8'));
    const v = ev.evaluateContribution(c, { gateRegression: { ok: true } });
    const reasons = (v.reasons || []).join(' | ');
    assert.equal(v.accepted, row.decision === 'accept', row.contribution + ' decision — reasons: ' + reasons);
    if (row.decision === 'accept') {
      assert.equal(reasons, '', row.contribution + ' must accept cleanly with no reasons');
    } else {
      assert.match(reasons, codeSignature[row.code], row.contribution + ' must reject for ' + row.code);
      // The reject must come from the structural assertion, NOT a shape/internal_id artifact.
      assert.doesNotMatch(reasons, /internal_id|kind is/, row.contribution + ' must reject without shape/internal_id noise');
    }
  }
});

// 2. contributionsDir honors the configured output path.
test('contributionsDir honors config.improvement_sharing.package_output_path', () => {
  const env = { CONTENT_HOME: path.join(REPO, '.tmp-content-home-test') };

  const base = pkg.contributionsDir(env, {});
  assert.equal(path.basename(base), 'contributions', 'default is <CONTENT_HOME>/contributions');
  const home = path.dirname(base);

  const rel = pkg.contributionsDir(env, { improvement_sharing: { package_output_path: 'out/shared' } });
  assert.equal(rel, path.join(home, 'out', 'shared'), 'a relative override resolves under CONTENT_HOME');

  const absTarget = path.join(REPO, '.tmp-abs-out-test');
  const abs = pkg.contributionsDir(env, { improvement_sharing: { package_output_path: absTarget } });
  assert.equal(abs, absTarget, 'an absolute override is honored as-is');

  // An empty/whitespace configured value falls back to the default.
  const blank = pkg.contributionsDir(env, { improvement_sharing: { package_output_path: '   ' } });
  assert.equal(blank, base, 'a blank override falls back to <CONTENT_HOME>/contributions');
});
