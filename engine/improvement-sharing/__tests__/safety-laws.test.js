'use strict';

/**
 * engine/improvement-sharing/__tests__/safety-laws.test.js  [N net-new]  — batch IS-TESTS
 *
 * THE DD-7 SAFETY-LAW SUITE for the OUTBOUND + INBOUND improvement-sharing path
 * (release-spec.md roadmap #4 "Improvement-sharing automation — DD-7(b)"; original-design-spec §2.6
 * Improvement Sharing; decisions.md DD-7 option (b) + Appendix B non-goal "opt-out telemetry /
 * automatic upstream data sharing of ANY kind — rejected PERMANENTLY"; design-review risk #7
 * exfiltration + upstream supply-chain poisoning).
 *
 * WHY A SEPARATE SUITE. The sibling unit suites (sanitize.test.js / package.test.js / evaluate.test.js)
 * exercise each module in isolation with synthetic inline inputs + injected guards. THIS suite is the
 * END-TO-END, FIXTURE-DRIVEN proof that the four load-bearing DD-7 laws hold over the REAL on-disk
 * Acme-Cosmos fixtures (fixtures/improvement-sharing-acme/) and that the LIVE wiring of the three
 * modules reproduces the committed ground truth (expected/sanitize-outcomes.json +
 * expected/evaluate-outcomes.json). No guard is injected here — the real IS-SANITIZE guard, the real
 * IS-CONSENT packager, and the real IS-EVALUATE harness are driven so a regression in ANY of them
 * fails CI. The four laws this file proves:
 *
 *   (1) SANITIZATION (DD-7 (2)). The planted-specifics learning record is reduced to an ABSTRACT
 *       rule-diff: every planted specific (brand, partner, codename, fake-secret literal, snowflake,
 *       $CONTENT_HOME path, @handle) is stripped, and assertShareable REFUSES (EUNSHAREABLE) any
 *       payload with a residual specific. The CLEAN abstract diff passes (sanitizer is a no-op).
 *
 *   (2) NO-AUTO-SEND + OPT-IN (DD-7 (1)). With improvement_sharing OFF (the default), prepareContribution
 *       is a no-op (writes nothing). Even ENABLED, without explicit consent it only PREVIEWS. The ONLY
 *       output sink is a LOCAL file: none of the three modules require a transport (proven structurally
 *       via assertNoAutoSendPath over all three source files). There is NO transmit path.
 *
 *   (3) OPERATOR-REVIEW (DD-7 (3)). The preview the operator sees is EXACTLY the bytes that would be
 *       written — verified by comparing the review-mode preview to the written package on disk.
 *
 *   (4) MAINTAINER EVALUATION (DD-7 (4); supply-chain safety). evaluateContribution / checkMutability
 *       REJECTS a gate-loosening inbound (ENEVERLOOSEN), a human-only-target inbound (EHUMANONLY), and
 *       a payload that smuggled a specific (EUNSHAREABLE); ACCEPTS a clean, gate-neutral, machine-target
 *       contribution — and NEVER auto-merges (auto_merge:false in every verdict).
 *
 * RD-2 / RD-12: deterministic, zero-key, no chain LLM, no network. The only I/O is reading the
 * committed fixtures + a single LOCAL package write into a throwaway temp $CONTENT_HOME. node:test +
 * node:assert only. Tier-3 clean (§0.3 r6): the sole brand anywhere is the synthetic "Acme Cosmos",
 * and every planted specific is an obviously-fake, hygiene-scan-exempt placeholder.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const sanitize = require('../sanitize.js');
const pkg = require('../package.js');
const evaluate = require('../evaluate.js');

/* ------------------------------------------------------------------------------------------------ *
 * Fixture loading. The IS-FIXTURES batch wrote the canonical Acme-Cosmos corpus + the committed
 * ground-truth outcome files. We resolve them relative to this test so the suite is location-stable.
 * ------------------------------------------------------------------------------------------------ */

const FIXTURE_ROOT = path.resolve(__dirname, '..', '..', '..', 'fixtures', 'improvement-sharing-acme');

/** Read + parse a fixture JSON (throws loudly if a fixture is missing — never silently skip a law). */
function loadFixture(rel) {
  const abs = path.join(FIXTURE_ROOT, rel);
  return JSON.parse(fs.readFileSync(abs, 'utf8'));
}

const SYSTEM = loadFixture('system.improvement-sharing.json'); // partial config: improvement_sharing block
const SHARING_BLOCK = SYSTEM.improvement_sharing;

const DIRTY_RECORD = loadFixture('outbound/lr-dirty-with-specifics.json');
const CLEAN_RECORD = loadFixture('outbound/lr-clean-abstract.json');

const CONTRIB_LOOSENS = loadFixture('inbound/contrib-loosens-gate.json');
const CONTRIB_HUMAN_ONLY = loadFixture('inbound/contrib-targets-human-only.json');
const CONTRIB_CLEAN = loadFixture('inbound/contrib-clean-accept.json');

const EXPECTED_SANITIZE = loadFixture('expected/sanitize-outcomes.json');
const EXPECTED_EVALUATE = loadFixture('expected/evaluate-outcomes.json');

/** The OUTBOUND sanitize context the ground truth was produced with: the configured deny list (the
 *  {terms, secret_literals} object form) + the brand-term list. resolveDenySet/coerceDenyList flatten
 *  the object form; "Acme Cosmos" is in the deny terms so it is caught as private_term (the brand-term
 *  matcher runs after the deny pass has already masked it). Mirrors expected/sanitize-outcomes.json. */
const DENY_LIST = SHARING_BLOCK.private_terms; // { case_insensitive, terms[], secret_literals[] }
const BRAND_TERMS = EXPECTED_SANITIZE.brand_terms; // ['Acme Cosmos']
const SANITIZE_OPTS = Object.freeze({ privateTerms: DENY_LIST, brandTerms: BRAND_TERMS });

/** The inbound maintainer-side anti-target context (deny list flattened to terms+secret_literals). */
const INBOUND_DENY = []
  .concat(DENY_LIST.terms || [])
  .concat(DENY_LIST.secret_literals || []);

/** Pull the per-record ground-truth row out of expected/sanitize-outcomes.json. */
function expectedSanitize(recordRel) {
  const row = EXPECTED_SANITIZE.records.find((r) => r.record === recordRel);
  assert.ok(row, `expected sanitize row for ${recordRel} must exist`);
  return row;
}

/** Pull the per-contribution ground-truth row out of expected/evaluate-outcomes.json. */
function expectedEvaluate(contribRel) {
  const row = EXPECTED_EVALUATE.contributions.find((c) => c.contribution === contribRel);
  assert.ok(row, `expected evaluate row for ${contribRel} must exist`);
  return row;
}

/** A fresh throwaway $CONTENT_HOME so a written package never touches the real instance dir. */
function tmpHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'is-tests-'));
  return { env: { CONTENT_HOME: dir }, dir };
}

const NOW = Date.parse('2099-05-02T09:20:00.000Z'); // deterministic clock for filenames/timestamps.

/** The set of planted specifics the dirty fixture enumerates — none may survive into a payload. */
const PLANTED = DIRTY_RECORD.planted_specifics;
const PLANTED_VALUES = Object.freeze(
  Object.entries(PLANTED)
    .filter(([k]) => k !== '$comment')
    .map(([, v]) => v),
);

/** Assert no planted specific (and no deny term) appears anywhere in a JSON-serializable value. */
function assertNoSpecifics(value, label) {
  const json = JSON.stringify(value);
  for (const planted of PLANTED_VALUES) {
    assert.ok(!json.includes(planted), `${label} must not carry planted specific: ${JSON.stringify(planted)}`);
  }
  // The brand name is matched case-insensitively elsewhere; assert it textually too.
  assert.ok(!/Acme Cosmos/i.test(json), `${label} must not carry the brand name`);
  assert.ok(!/Nebula Nine Optics/i.test(json), `${label} must not carry the invented partner`);
  assert.ok(!/Project Dark Comet/i.test(json), `${label} must not carry the codename`);
  assert.ok(!/@acme_founder/.test(json), `${label} must not carry the handle`);
}

/* ================================================================================================ *
 * LAW (1) — SANITIZATION (DD-7 (2) abstract-rule-diffs only; the outbound sanitizer + structural guard).
 * ================================================================================================ */

test('LAW1 sanitize: onResidual:refuse REFUSES the dirty record with the ground-truth family set', () => {
  const expected = expectedSanitize('outbound/lr-dirty-with-specifics.json');
  let thrown;
  try {
    sanitize.sanitizeForSharing(DIRTY_RECORD, { ...SANITIZE_OPTS, onResidual: 'refuse' });
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown, 'refuse mode must throw on a dirty record');
  assert.equal(thrown.code, 'EUNSHAREABLE');
  assert.equal(thrown.code, EXPECTED_SANITIZE.refusal_error.code);
  assert.equal(thrown.name, EXPECTED_SANITIZE.refusal_error.name);
  assert.equal(thrown.mode, 'refuse');
  // The detected families must match the committed ground truth EXACTLY (handle/internal_id/
  // private_term/snowflake-id) — the OUTBOUND mirror of the work-recap privacy gate's coverage.
  assert.deepEqual([...thrown.families].sort(), [...expected.refuse_families].sort());
});

test('LAW1 sanitize: strip mode reduces the dirty record to a CLEAN abstract rule-diff (flag_count matches ground truth)', () => {
  const expected = expectedSanitize('outbound/lr-dirty-with-specifics.json');
  const payload = sanitize.sanitizeForSharing(DIRTY_RECORD, SANITIZE_OPTS);

  // It is an abstract rule-diff, not the raw record.
  assert.equal(payload.kind, 'abstract-rule-diff');
  assert.equal(payload.kind, expected.emitted_payload_kind);

  // x-sharing accounting matches the committed ground truth.
  assert.equal(payload['x-sharing'].stripped, true);
  assert.equal(payload['x-sharing'].flag_count, expected.after_strip_flag_count); // 7
  assert.deepEqual([...payload['x-sharing'].families].sort(), [...expected.refuse_families].sort());

  // NOT ONE planted specific survives anywhere in the payload (deep JSON scan).
  assertNoSpecifics(payload, 'stripped payload');

  // The fake-secret LITERAL (deliberately NOT credential-shaped) was caught by the deny secret_literals,
  // proving the deny list is required (redact.js alone would not have masked it).
  assert.ok(!JSON.stringify(payload).includes(PLANTED.fake_secret_literal));

  // The generalizable SHAPE survives: the tunable-dial kind + the INCREASE direction (0.20 -> 0.40),
  // never the brand's tuned absolute values.
  assert.equal(payload.target.kind, DIRTY_RECORD.machine_change.kind);
  const knob = payload.structural_diff.knob_deltas.find((k) => k.field === 'opener_repetition_penalty');
  assert.ok(knob, 'the opener_repetition_penalty knob delta is carried');
  assert.equal(knob.direction, 'increase');
  const json = JSON.stringify(payload);
  assert.ok(!json.includes('0.4') && !json.includes('0.2'), 'the brand-tuned absolute values are NOT carried');
});

test('LAW1 sanitize: the stripped dirty payload independently PASSES assertShareable (fail-closed self-assertion held)', () => {
  const expected = expectedSanitize('outbound/lr-dirty-with-specifics.json');
  const payload = sanitize.sanitizeForSharing(DIRTY_RECORD, SANITIZE_OPTS);
  // sanitizeForSharing re-asserts internally; an INDEPENDENT assert must also accept it.
  assert.equal(sanitize.assertShareable(payload, SANITIZE_OPTS), true);
  assert.equal(expected.after_strip_assertShareable, 'accept');
  assert.equal(expected.after_strip_residual_specifics, 0);
});

test('LAW1 sanitize: the CLEAN abstract record is a NO-OP (zero flags) and passes in BOTH modes', () => {
  const expected = expectedSanitize('outbound/lr-clean-abstract.json');
  const stripPayload = sanitize.sanitizeForSharing(CLEAN_RECORD, SANITIZE_OPTS);
  assert.equal(stripPayload.kind, 'abstract-rule-diff');
  assert.equal(stripPayload['x-sharing'].stripped, false);
  assert.equal(stripPayload['x-sharing'].flag_count, expected.after_strip_flag_count); // 0
  assert.deepEqual(stripPayload['x-sharing'].families, []);
  assert.equal(sanitize.assertShareable(stripPayload, SANITIZE_OPTS), true);

  // In refuse mode the already-clean record is ACCEPTED (nothing to refuse) — idempotent.
  assert.equal(expected.onResidual_refuse_decision, 'accept');
  const refusePayload = sanitize.sanitizeForSharing(CLEAN_RECORD, { ...SANITIZE_OPTS, onResidual: 'refuse' });
  assert.equal(refusePayload['x-sharing'].flag_count, 0);
  assertNoSpecifics(refusePayload, 'clean payload');
});

test('LAW1 guard: assertShareable REFUSES a residual brand / secret-literal / snowflake / path / handle / private-term', () => {
  // Each case re-builds a hand-edited payload (defence-in-depth: a post-edited payload is re-checked).
  const SL = '/';
  const cases = [
    { rationale: 'tuned for Acme Cosmos' }, // brand name (also in deny list)
    { rationale: `gated behind ${PLANTED.fake_secret_literal}` }, // fake-secret literal (deny secret_literals)
    { rationale: `tracked in thread ${PLANTED.snowflake_placeholder_shape}` }, // snowflake placeholder
    { rationale: `pulled from ${SL}home${SL}op${SL}notes.md` }, // user-path shape (assembled, hygiene-clean)
    { rationale: 'ping @acme_founder for context' }, // handle
    { rationale: 'this was the Project Dark Comet change' }, // configured private-term codename
  ];
  for (const c of cases) {
    const payload = { kind: 'abstract-rule-diff', rationale: c.rationale };
    assert.throws(
      () => sanitize.assertShareable(payload, SANITIZE_OPTS),
      (e) => e.code === 'EUNSHAREABLE',
      `assertShareable must refuse: ${c.rationale}`,
    );
  }
});

/* ================================================================================================ *
 * P10 / ROADMAP #5 — VOICE ARTIFACT GUARD (EHUMANONLY).
 *
 * Voice calibration records (target_artifact brand:*:voice or brand:*:drama_dial; target.kind
 * "voice"/"brand-dna") are instance-specific preferences for THIS install. They are NEVER
 * generalizable upstream rule-diffs. Two independent guards enforce this:
 *
 *   (A) assertShareable (sanitize.js) — EHUMANONLY pre-check at the TOP, before string-specifics.
 *   (B) checkShareable / prepareContribution GATE 2 (package.js) — isVoiceArtifact pre-check
 *       that fires before the assertShareable string walk.
 *
 * These tests use CLEAN voice payloads (no leaky instance strings) to prove the guards are
 * NON-VACUOUS: the string-specifics walk alone would pass a clean payload, so a vacuous guard
 * would produce mode:'written' — a P10 violation. Both guards must fail closed independently.
 * Synthetic brands only (Acme Cosmos / Orbit Outfitters) — real brand names fail hygiene CI.
 * ================================================================================================ */

test('P10 assertShareable REJECTS a clean brand:*:voice payload (no leaky strings) with code EHUMANONLY', () => {
  // A payload with a brand:*:voice target_artifact and NO leaked instance strings. The string-
  // specifics walk would pass this (nothing trips snowflake/handle/secret/path matchers). The voice
  // pre-check must catch it FIRST and throw EHUMANONLY, proving the guard is non-vacuous.
  const cleanVoicePayload = {
    kind: 'abstract-rule-diff',
    schema_version: '1.0.0',
    target_artifact: 'brand:acme-cosmos:voice',          // voice artifact — synthetic brand
    target: { kind: 'voice', path_shape: 'voice.tone' },
    structural_diff: { structural_changes: [], knob_deltas: [{ field: 'tone', direction: 'increase' }] },
    rationale: 'Generalizable adjustment to voice tone from reviewer signals; no instance values shared.',
    provenance: { derived_from: 'learning-record', signal_kinds: ['reviewer'], signal_count: 3 },
    'x-sharing': { stripped: false, families: [], flag_count: 0 },
  };

  let thrown;
  try {
    sanitize.assertShareable(cleanVoicePayload, SANITIZE_OPTS);
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown, 'assertShareable must throw on a clean brand:*:voice payload');
  assert.equal(thrown.code, 'EHUMANONLY', `expected EHUMANONLY but got ${thrown.code}: ${thrown.message}`);
  assert.ok(thrown.families && thrown.families.includes('voice-calibration-instance-specific'),
    'thrown error must name the voice-calibration-instance-specific family');

  // Also verify the drama_dial variant is caught.
  const dramaDial = { ...cleanVoicePayload, target_artifact: 'brand:orbit-outfitters:drama_dial' };
  let thrown2;
  try {
    sanitize.assertShareable(dramaDial, SANITIZE_OPTS);
  } catch (err) {
    thrown2 = err;
  }
  assert.ok(thrown2, 'assertShareable must throw on a clean brand:*:drama_dial payload');
  assert.equal(thrown2.code, 'EHUMANONLY');
});

test('P10 package.prepareContribution REFUSES a clean brand:*:voice record — mode != written, no file written', () => {
  // A voice record with a clean payload (no leaky strings). GATE 2 (checkShareable voice pre-check)
  // must refuse it before writing — mode must NOT be 'written' and no file may appear on disk.
  // Uses a throwaway CONTENT_HOME so the assertion is unambiguous.
  const cleanVoiceRecord = {
    id: 'lr-voice-orbit-001',
    target_artifact: 'brand:orbit-outfitters:voice',     // voice artifact — synthetic brand
    target_mutability: 'human-only',
    shareability: 'candidate-for-upstream',
    machine_change: { kind: 'voice', values: { tone: 0.8 }, baseline_values: { tone: 0.6 } },
    rationale: 'Generalizable adjustment derived from reviewer signals; no instance values shared.',
    source_signals: [{ type: 'reviewer', count: 2 }],
  };
  // A clean payload that carries no leaky strings — it would pass the string-specifics walk alone.
  const cleanVoicePayload = {
    kind: 'abstract-rule-diff',
    schema_version: '1.0.0',
    target_artifact: 'brand:orbit-outfitters:voice',
    target: { kind: 'voice', path_shape: 'voice.tone' },
    structural_diff: { structural_changes: [], knob_deltas: [{ field: 'tone', direction: 'increase' }] },
    rationale: 'Generalizable adjustment to voice tone; no instance values shared.',
    provenance: { derived_from: 'learning-record', signal_kinds: ['reviewer'], signal_count: 2 },
    'x-sharing': { stripped: false, families: [], flag_count: 0 },
  };

  const { env, dir } = tmpHome();
  const result = pkg.prepareContribution(cleanVoiceRecord, {
    config: SYSTEM,       // improvement_sharing.enabled === true
    payload: cleanVoicePayload,
    consent: true,        // explicit consent — only the voice guard should stop this
    env,
    now: NOW,
  });

  // The packager must refuse — not write — the voice record.
  assert.notEqual(result.mode, 'written', `mode must not be 'written' for a voice record; got ${result.mode}: ${result.summary}`);
  assert.equal(result.written, false, 'written must be false for a voice record');

  // No contribution file may be written under the throwaway CONTENT_HOME.
  const contribDir = path.join(dir, ...SYSTEM.improvement_sharing.package_output_path.split('/'));
  const filesWritten = fs.existsSync(contribDir) ? fs.readdirSync(contribDir) : [];
  assert.equal(filesWritten.length, 0,
    `no contribution file may be written for a voice record; found: ${filesWritten.join(', ')}`);
});

test('LAW1 guard: a refusal NEVER echoes the offending value back (privacy: no re-leak)', () => {
  const secret = PLANTED.fake_secret_literal;
  let thrown;
  try {
    sanitize.assertShareable({ kind: 'abstract-rule-diff', rationale: `oops ${secret}` }, SANITIZE_OPTS);
  } catch (e) {
    thrown = e;
  }
  assert.ok(thrown, 'must throw');
  assert.ok(!thrown.message.includes(secret), 'the error message must not re-leak the specific');
  assert.ok(!JSON.stringify(thrown.offenders).includes(secret), 'offenders must not re-leak the specific');
  // it still reports WHERE (json-path) + WHICH family.
  assert.ok(Array.isArray(thrown.offenders) && thrown.offenders[0].path.includes('rationale'));
});

/* ================================================================================================ *
 * LAW (2) — NO-AUTO-SEND + OPT-IN (DD-7 (1) opt-in/off-by-default; NO transmit path of any kind).
 * ================================================================================================ */

/** A sanitized packager-shaped payload (rule_diff + rationale) derived from the dirty fixture. */
function sanitizedPackagerPayload() {
  const abstract = sanitize.sanitizeForSharing(DIRTY_RECORD, SANITIZE_OPTS);
  return { rule_diff: abstract, rationale: abstract.rationale };
}

test('LAW2 opt-in: OFF by default (no improvement_sharing block) => prepareContribution is a NO-OP, writes nothing', () => {
  const { env } = tmpHome();
  // No config at all — the default. Even with consent + a clean payload, nothing is produced.
  const r = pkg.prepareContribution(DIRTY_RECORD, {
    payload: sanitizedPackagerPayload(),
    consent: true,
    env,
    now: NOW,
  });
  assert.equal(r.ok, true); // a by-design disabled no-op is a CORRECT outcome.
  assert.equal(r.mode, 'disabled');
  assert.equal(r.enabled, false);
  assert.equal(r.written, false);
  assert.equal(r.path, undefined);
  // Ground truth: off-by-default + disabled => produce nothing.
  assert.equal(EXPECTED_SANITIZE.consent_and_transmit.off_by_default, true);
  assert.equal(EXPECTED_SANITIZE.consent_and_transmit.disabled_decision, 'produce_nothing');
});

test('LAW2 opt-in: enabled must be STRICT true — no coercion of "true"/1/yes turns it on', () => {
  const { env } = tmpHome();
  for (const v of ['true', 1, 'yes', {}, null, undefined, 0]) {
    const r = pkg.prepareContribution(DIRTY_RECORD, {
      config: { improvement_sharing: { enabled: v } },
      payload: sanitizedPackagerPayload(),
      consent: true,
      env,
      now: NOW,
    });
    assert.equal(r.mode, 'disabled', `enabled=${JSON.stringify(v)} must stay disabled`);
    assert.equal(r.written, false);
  }
  // and the gate flips on ONLY for the strict boolean true (the fixture's enabled value).
  assert.equal(pkg.contributionEnabled(SYSTEM), true);
  assert.equal(SHARING_BLOCK.enabled, true);
});

test('LAW2 consent: ENABLED but no consent => REVIEW preview only, writes nothing (fail-closed)', () => {
  const { env, dir } = tmpHome();
  const r = pkg.prepareContribution(DIRTY_RECORD, {
    config: SYSTEM, // improvement_sharing.enabled === true
    payload: sanitizedPackagerPayload(),
    env,
    now: NOW,
    // consent absent
  });
  assert.equal(r.ok, true);
  assert.equal(r.mode, 'review');
  assert.equal(r.enabled, true);
  assert.equal(r.consented, false);
  assert.equal(r.written, false);
  assert.ok(r.preview, 'a review must surface the exact preview');
  // Nothing was written to the throwaway home.
  assert.ok(!fs.existsSync(path.join(dir, ...SYSTEM.improvement_sharing.package_output_path.split('/'))), 'no package output dir should exist after a review');
  assert.equal(EXPECTED_SANITIZE.consent_and_transmit.unconfirmed_decision, 'produce_nothing');
});

test('LAW2 consent: consent must be STRICT true — a truthy non-true value does NOT write', () => {
  const { env } = tmpHome();
  for (const v of ['yes', 1, {}, 'true']) {
    const r = pkg.prepareContribution(DIRTY_RECORD, {
      config: SYSTEM,
      payload: sanitizedPackagerPayload(),
      consent: v,
      env,
      now: NOW,
    });
    assert.equal(r.mode, 'review', `consent=${JSON.stringify(v)} must not write`);
    assert.equal(r.written, false);
  }
});

test('LAW2 no-transmit: the ONLY output sink is a LOCAL file (no transport require in ANY of the three modules)', () => {
  // The packager proves itself transport-free; point its structural scanner at the sibling sources too
  // so the WHOLE outbound+inbound surface is proven to require none of http/https/net/tls/dgram/dns/
  // child_process (+ bare fetch). A future edit that adds a send path makes this FAIL CI.
  const modules = [
    require.resolve('../package.js'),
    require.resolve('../sanitize.js'),
    require.resolve('../evaluate.js'),
  ];
  for (const m of modules) {
    const res = pkg.assertNoAutoSendPath(m);
    assert.equal(res.ok, true, `${path.basename(m)} must require no transport`);
  }
  // The law is also encoded as data the scanner reads — assert the forbidden set is the documented one.
  for (const forbidden of ['http', 'https', 'http2', 'net', 'tls', 'dgram', 'dns', 'child_process']) {
    assert.ok(pkg.FORBIDDEN_TRANSPORT_MODULES.includes(forbidden), `${forbidden} must be forbidden`);
  }
  // Ground truth: there is no transmit target; the only sink is a local package path.
  assert.equal(EXPECTED_SANITIZE.consent_and_transmit.transmit_target, null);
});

test('LAW2 no-transmit: assertNoAutoSendPath BITES — a module that requires a transport (or calls fetch) FAILS', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'is-autosend-'));
  const transportMod = path.join(dir, 'bad-transport.js');
  fs.writeFileSync(transportMod, "const https = require('https');\nmodule.exports = {};\n", 'utf8');
  assert.throws(() => pkg.assertNoAutoSendPath(transportMod), (e) => e.code === 'EAUTOSEND');

  const fetchMod = path.join(dir, 'bad-fetch.js');
  fs.writeFileSync(fetchMod, "async function go(){ return fetch('http://x'); }\nmodule.exports={go};\n", 'utf8');
  assert.throws(() => pkg.assertNoAutoSendPath(fetchMod), (e) => e.code === 'EAUTOSEND');
});

/* ================================================================================================ *
 * LAW (3) — OPERATOR-REVIEW (DD-7 (3)): the preview IS exactly what gets written, and only an
 * explicit consent transitions review -> a single LOCAL package write.
 * ================================================================================================ */

test('LAW3 review: the review preview equals the EXACT bytes later written on consent (no surprise payload)', () => {
  const payload = sanitizedPackagerPayload();

  // 1) Review (no consent): capture the verbatim preview.
  const reviewHome = tmpHome();
  const review = pkg.prepareContribution(DIRTY_RECORD, {
    config: SYSTEM,
    payload,
    env: reviewHome.env,
    now: NOW,
    operatorRef: 'maintainer-acme',
  });
  assert.equal(review.mode, 'review');
  assert.equal(review.written, false);
  assert.ok(review.preview && review.preview.schema === 'improvement-contribution');

  // 2) Consent: write the package; it must be byte-identical to the preview the operator reviewed.
  const writeHome = tmpHome();
  const written = pkg.prepareContribution(DIRTY_RECORD, {
    config: SYSTEM,
    payload,
    env: writeHome.env,
    consent: true,
    now: NOW,
    operatorRef: 'maintainer-acme',
  });
  assert.equal(written.mode, 'written');
  assert.equal(written.written, true);
  assert.ok(fs.existsSync(written.path));
  // The package lands under the operator-configured package_output_path (DD-7 (1) LOCAL sink only),
  // resolved relative to CONTENT_HOME — here the fixture's improvement_sharing.package_output_path.
  const expectedOutDir = path.join(writeHome.dir, ...SYSTEM.improvement_sharing.package_output_path.split('/'));
  assert.ok(written.path.includes(expectedOutDir), 'package lands under the configured package_output_path (' + SYSTEM.improvement_sharing.package_output_path + ')');

  const onDisk = JSON.parse(fs.readFileSync(written.path, 'utf8'));
  // The reviewed preview and the file the operator PRs by hand are the SAME object.
  assert.deepEqual(review.preview, onDisk, 'the reviewed preview must equal the written package exactly');
  assert.deepEqual(written.preview, onDisk, 'the written-result preview must equal the file on disk');
});

test('LAW3 review: the written package + its provenance carry NO planted specifics, NO refs, NO target id', () => {
  const { env } = tmpHome();
  const written = pkg.prepareContribution(DIRTY_RECORD, {
    config: SYSTEM,
    payload: sanitizedPackagerPayload(),
    env,
    consent: true,
    now: NOW,
    operatorRef: 'maintainer-acme',
  });
  const onDisk = JSON.parse(fs.readFileSync(written.path, 'utf8'));

  // No planted specific survives into the package the operator would PR.
  assertNoSpecifics(onDisk, 'written package');

  // Provenance is operator-reviewed + manual-pr-only + abstract (signal TYPES + counts, refs DROPPED).
  assert.equal(onDisk.provenance.operator_reviewed, true);
  assert.equal(onDisk.provenance.transport, 'manual-pr-only');
  assert.equal(onDisk.provenance.consent.attested, true);
  const provJson = JSON.stringify(onDisk.provenance);
  // The dirty fixture's source-signal refs ($CONTENT_HOME-relative instance pointers) must be DROPPED.
  for (const sig of DIRTY_RECORD.source_signals) {
    for (const ref of sig.refs || []) {
      assert.ok(!provJson.includes(ref), `provenance must not carry the source-signal ref ${ref}`);
    }
  }
  // The target_artifact id (instance-specific) must not appear.
  assert.ok(!provJson.includes(DIRTY_RECORD.target_artifact), 'provenance must not carry the target_artifact id');
  for (const s of onDisk.provenance.source_signal_types) {
    assert.deepEqual(Object.keys(s).sort(), ['count', 'type']); // only TYPE + COUNT — no refs.
  }
});

/* ================================================================================================ *
 * LAW (4) — MAINTAINER EVALUATION (DD-7 (4); design-review risk #7 supply-chain poisoning).
 * Reject gate-loosening (ENEVERLOOSEN), human-only-target (EHUMANONLY), and smuggled-specific
 * (EUNSHAREABLE) inbound; ACCEPT a clean machine-target gate-neutral one; NEVER auto-merge.
 * ================================================================================================ */

test('LAW4 evaluate: a GATE-LOOSENING inbound is REJECTED on the never-loosen axis (ENEVERLOOSEN)', () => {
  const expected = expectedEvaluate('inbound/contrib-loosens-gate.json');
  assert.equal(expected.decision, 'reject');
  assert.equal(expected.code, 'ENEVERLOOSEN');

  // The fixture clears the human-only boundary (allowlisted tunable-dial) but loosens 3 gate axes.
  const m = evaluate.checkMutability(CONTRIB_LOOSENS);
  assert.equal(m.ok, false, 'never-loosen must reject this contribution');
  assert.ok(m.reasons.some((r) => /loosen/i.test(r)), 'the rejection reason names gate-loosening');
  assert.ok(!m.reasons.some((r) => /human-only/i.test(r)), 'it is NOT rejected on the human-only axis');
});

test('LAW4 evaluate: a HUMAN-ONLY-target inbound is REJECTED independently of never-loosen (EHUMANONLY)', () => {
  const expected = expectedEvaluate('inbound/contrib-targets-human-only.json');
  assert.equal(expected.decision, 'reject');
  assert.equal(expected.code, 'EHUMANONLY');

  // The fixture's change is a deliberate TIGHTENING — so the rejection comes ONLY from the human-only
  // boundary (proving the two structural refusals are independent; most-restrictive wins).
  const m = evaluate.checkMutability(CONTRIB_HUMAN_ONLY);
  assert.equal(m.ok, false, 'human-only boundary must reject this contribution');
  assert.ok(m.reasons.some((r) => /human-only/i.test(r)), 'the rejection reason names the human-only boundary');
  assert.ok(!m.reasons.some((r) => /loosen/i.test(r)), 'a tightening change does NOT trip never-loosen');
});

test('LAW4 evaluate: a CLEAN, gate-neutral, machine-target contribution passes BOTH structural refusals', () => {
  const expected = expectedEvaluate('inbound/contrib-clean-accept.json');
  assert.equal(expected.decision, 'accept');
  assert.equal(expected.code, 'OK');
  assert.equal(expected.auto_merge, false);

  // The mutability axis (human-only + never-loosen) admits the clean fixture.
  const m = evaluate.checkMutability(CONTRIB_CLEAN);
  assert.equal(m.ok, true, m.reasons.join(' | '));
});

test('LAW4 evaluate: a well-shaped clean rule-diff is fully ACCEPTED end-to-end, auto_merge:false', () => {
  // The inbound fixtures carry the §3.1 maintainer-axis ground truth (human-only / never-loosen) but
  // are shaped as `inbound-contribution/v1`, not the harness's `kind:'rule-diff'` wire shape. Here we
  // drive the FULL verdict with a properly-shaped abstract rule-diff equivalent to the clean fixture
  // (same allowlisted calendar-weighting target + gate-neutral content-preference change) to prove the
  // ACCEPT path of evaluateContribution itself.
  const contribution = {
    kind: 'rule-diff',
    target: { kind: CONTRIB_CLEAN.target.kind, path: CONTRIB_CLEAN.target.path },
    change: { field: CONTRIB_CLEAN.change.field, before: CONTRIB_CLEAN.change.before, after: CONTRIB_CLEAN.change.after },
    rationale: 'Timely-event content tends to outperform on a rolling window; raise its calendar weighting.',
  };
  const v = evaluate.evaluateContribution(contribution, { gateRegression: { ok: true } });
  assert.equal(v.accepted, true, v.reasons.join(' | '));
  assert.equal(v.auto_merge, false); // structural: ACCEPT is never a merge (DD-7 (4)).
  assert.equal(v.checks.shareable.ok, true);
  assert.equal(v.checks.applies.ok, true);
  assert.equal(v.checks.gate_regression.ok, true);
  assert.equal(v.checks.mutability.ok, true);
  assert.deepEqual(v.reasons, []);
});

test('LAW4 evaluate: a contribution that SMUGGLED a specific is rejected as un-shareable (EUNSHAREABLE), no re-leak', () => {
  // A clean-LOOKING rule-diff that hid a planted snowflake in the rationale — the inbound shareability
  // guard (the OUTBOUND mirror) must catch it before any human review.
  const smuggled = {
    kind: 'rule-diff',
    target: { kind: 'calendar-weighting', path: 'calendar.content_type_weights.timely-event' },
    change: { field: 'calendar.content_type_weights.timely-event', before: 0.2, after: 0.3 },
    rationale: `Worked well; tracked in thread ${PLANTED.snowflake_placeholder_shape}.`,
  };
  const v = evaluate.evaluateContribution(smuggled, { gateRegression: { ok: true } });
  assert.equal(v.accepted, false);
  assert.equal(v.checks.shareable.ok, false);
  assert.ok(v.checks.shareable.reasons.some((r) => /instance\/brand specifics/i.test(r)));
  // The verdict must NOT echo the smuggled snowflake back.
  assert.ok(!JSON.stringify(v.reasons).includes(PLANTED.snowflake_placeholder_shape));
});

test('LAW4 evaluate: a SMUGGLED configured private term (deny list) is rejected on the receiving side too', () => {
  const smuggled = {
    kind: 'rule-diff',
    target: { kind: 'calendar-weighting', path: 'calendar.content_type_weights.timely-event' },
    change: { field: 'calendar.content_type_weights.timely-event', before: 0.2, after: 0.3 },
    rationale: `This pattern worked great for ${PLANTED.invented_partner}.`,
  };
  const v = evaluate.evaluateContribution(smuggled, { gateRegression: { ok: true }, privateTerms: INBOUND_DENY });
  assert.equal(v.accepted, false);
  assert.equal(v.checks.shareable.ok, false);
  assert.ok(!JSON.stringify(v.reasons).includes(PLANTED.invented_partner), 'no re-leak of the private term');
});

test('LAW4 evaluate: EVERY verdict is auto_merge:false — there is no auto-merge path by construction', () => {
  const verdicts = [
    evaluate.evaluateContribution({ kind: 'rule-diff', target: { kind: 'calendar-weighting' }, change: { op: 'x', values: { a: 1 } } }, { gateRegression: { ok: true } }),
    evaluate.evaluateContribution({ kind: 'rule-diff', target: { kind: 'gate' }, change: { field: 'x', before: 1, after: 2 } }, { gateRegression: { ok: true } }),
    evaluate.evaluateContribution({ kind: 'rule-diff', target: { kind: 'tunable-dial', machine_tunable: true }, change: { disposition: { before: 'block', after: 'warn' } } }, { gateRegression: { ok: true } }),
    evaluate.evaluateContribution(null, { skipGateRegression: true }),
  ];
  for (const v of verdicts) assert.equal(v.auto_merge, false);
  // The per-contribution ground truth also pins auto_merge:false for every inbound fixture.
  for (const c of EXPECTED_EVALUATE.contributions) assert.equal(c.auto_merge, false);
});

test('LAW4 evaluate: the verdict reports EVERY failing axis at once (maintainer can triage all of them)', () => {
  // Wrong shape + human-only target + a loosening change + a smuggled specific, simultaneously.
  const contribution = {
    kind: 'patch', // wrong discriminator -> shape failure
    target: { kind: 'gate' }, // human-only
    change: { disposition: { before: 'block', after: 'warn' } }, // loosening
    rationale: `tuned for ${PLANTED.private_term_codename}`, // smuggled private term
  };
  const v = evaluate.evaluateContribution(contribution, {
    gateRegression: { ok: false, failures: ['x'] },
    privateTerms: INBOUND_DENY,
  });
  assert.equal(v.accepted, false);
  assert.equal(v.auto_merge, false);
  assert.equal(v.checks.shareable.ok, false);
  assert.equal(v.checks.gate_regression.ok, false);
  assert.equal(v.checks.mutability.ok, false);
  assert.ok(v.reasons.some((r) => r.startsWith('[shape/shareable]')));
  assert.ok(v.reasons.some((r) => r.startsWith('[gate-regression]')));
  assert.ok(v.reasons.some((r) => r.startsWith('[mutability]')));
  assert.ok(!JSON.stringify(v.reasons).includes(PLANTED.private_term_codename), 'no re-leak of the smuggled codename');
});

/* ================================================================================================ *
 * CROSS-CUTTING — determinism + zero-key + no input mutation (RD-2 / RD-12).
 * ================================================================================================ */

test('determinism: sanitizeForSharing is deterministic and does NOT mutate the input record', () => {
  const snapshot = JSON.stringify(DIRTY_RECORD);
  const a = sanitize.sanitizeForSharing(DIRTY_RECORD, SANITIZE_OPTS);
  const b = sanitize.sanitizeForSharing(DIRTY_RECORD, SANITIZE_OPTS);
  assert.deepEqual(a, b, 'same inputs => same payload (deterministic)');
  assert.equal(JSON.stringify(DIRTY_RECORD), snapshot, 'the input record must not be mutated');
});

test('determinism: evaluateContribution is deterministic for the same inbound contribution', () => {
  const a = evaluate.evaluateContribution(CONTRIB_CLEAN, { gateRegression: { ok: true }, privateTerms: INBOUND_DENY });
  const b = evaluate.evaluateContribution(CONTRIB_CLEAN, { gateRegression: { ok: true }, privateTerms: INBOUND_DENY });
  assert.deepEqual(a, b);
});
