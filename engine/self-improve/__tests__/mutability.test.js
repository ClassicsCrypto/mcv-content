'use strict';

/**
 * Tests for engine/self-improve/mutability.js — the DD-6 safety core (release-spec §3.1, §8.9,
 * §10.1; original-design-spec §2.6/§3.1). Zero-key, deterministic, no LLM, no network. Real rule
 * fixtures are read from a temp dir; everything else is pure descriptor classification.
 * node:test + node:assert only (RD-12).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const m = require('../mutability');

/* -------------------------------------------------------------------- classifier: human-only */

test('always-human-only kinds classify human-only (gate/guardrail/threshold/budget/mode/kill-switch)', () => {
  for (const kind of ['gate', 'guardrail', 'threshold', 'hard-fail', 'firewall', 'reviewer-allowlist', 'budget', 'mode', 'kill-switch']) {
    const v = m.classifyTarget({ kind });
    assert.equal(v.classification, m.CLASSIFICATION.HUMAN_ONLY, `${kind} must be human-only`);
  }
});

test('a non-object / unknown target defaults to human-only (fail closed)', () => {
  assert.equal(m.classifyTarget(null).classification, m.CLASSIFICATION.HUMAN_ONLY);
  assert.equal(m.classifyTarget(undefined).classification, m.CLASSIFICATION.HUMAN_ONLY);
  assert.equal(m.classifyTarget({ kind: 'brand-dna' }).classification, m.CLASSIFICATION.HUMAN_ONLY);
  assert.equal(m.classifyTarget({ kind: 'voice' }).classification, m.CLASSIFICATION.HUMAN_ONLY);
  assert.equal(m.classifyTarget({}).classification, m.CLASSIFICATION.HUMAN_ONLY);
});

test('config paths under human-only prefixes are human-only', () => {
  for (const p of ['gate.thresholds.hard', 'system.gate.weights', 'thresholds.pass', 'budget.monthly_cap', 'reviewers', 'publish.auto_publish_allowed', 'mode', 'paused', 'calibration.pass_criteria', 'firewall.fact']) {
    assert.equal(m.classifyTarget({ kind: 'config', path: p }).classification, m.CLASSIFICATION.HUMAN_ONLY, `${p} must be human-only`);
  }
});

test('config naming a gate source layer is human-only', () => {
  for (const source of m.GATE_SOURCE_LAYERS) {
    assert.equal(m.classifyTarget({ kind: 'config', path: 'something.harmless', source }).classification, m.CLASSIFICATION.HUMAN_ONLY);
  }
});

/* ---------------------------------------------------------------- classifier: machine-changeable */

test('calendar-weighting kind is machine-changeable', () => {
  const v = m.classifyTarget({ kind: 'calendar-weighting' });
  assert.equal(v.classification, m.CLASSIFICATION.MACHINE_CHANGEABLE);
  assert.equal(v.kind, 'calendar-weighting');
  assert.equal(v.bounded, true);
});

test('calendar weighting via a config path is machine-changeable', () => {
  assert.equal(m.classifyTarget({ kind: 'config', path: 'calendar.weights.evergreen' }).classification, m.CLASSIFICATION.MACHINE_CHANGEABLE);
  assert.equal(m.classifyTarget({ kind: 'config', path: 'scheduler.content_type_weights.thread' }).classification, m.CLASSIFICATION.MACHINE_CHANGEABLE);
});

test('archetype / content-type prioritization is machine-changeable', () => {
  assert.equal(m.classifyTarget({ kind: 'archetype-prioritization' }).classification, m.CLASSIFICATION.MACHINE_CHANGEABLE);
  assert.equal(m.classifyTarget({ kind: 'content-type-prioritization' }).classification, m.CLASSIFICATION.MACHINE_CHANGEABLE);
  assert.equal(m.classifyTarget({ kind: 'config', path: 'archetype.priority.builder' }).classification, m.CLASSIFICATION.MACHINE_CHANGEABLE);
});

test('a bounded tunable-dial is machine-changeable; an unbounded one is not', () => {
  assert.equal(m.classifyTarget({ kind: 'tunable-dial', machine_tunable: true, bounds: { min: 0, max: 1 } }).classification, m.CLASSIFICATION.MACHINE_CHANGEABLE);
  // missing bounds => not matched => human-only
  assert.equal(m.classifyTarget({ kind: 'tunable-dial', machine_tunable: true }).classification, m.CLASSIFICATION.HUMAN_ONLY);
  // not flagged machine_tunable => human-only
  assert.equal(m.classifyTarget({ kind: 'tunable-dial', bounds: { min: 0, max: 1 } }).classification, m.CLASSIFICATION.HUMAN_ONLY);
});

/* ------------------------------------------------------------------------- rule frontmatter */

function withRuleFile(frontmatter, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oce-mut-'));
  const fp = path.join(dir, 'rule.md');
  fs.writeFileSync(fp, `---\n${frontmatter}\n---\n\n# rule body\n`, 'utf8');
  try {
    fn(fp);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('rule with mutability:human-only is human-only (via file)', () => {
  withRuleFile('id: rule.core.fabrication\ncategory: safety\nseverity: soft\nmutability: human-only', (fp) => {
    assert.equal(m.classifyTarget({ kind: 'rule', rule_path: fp }).classification, m.CLASSIFICATION.HUMAN_ONLY);
  });
});

test('rule with category:safety is human-only even if mutability says learnable', () => {
  withRuleFile('id: rule.core.claims-safety\ncategory: safety\nseverity: hard\nmutability: learnable', (fp) => {
    const v = m.classifyTarget({ kind: 'rule', rule_path: fp });
    assert.equal(v.classification, m.CLASSIFICATION.HUMAN_ONLY);
  });
});

test('a learnable non-safety rule is still NOT machine-applicable in v1 (rule bodies off allowlist)', () => {
  withRuleFile('id: rule.core.humanizer\ncategory: voice\nseverity: soft\nmutability: learnable', (fp) => {
    assert.equal(m.classifyTarget({ kind: 'rule', rule_path: fp }).classification, m.CLASSIFICATION.HUMAN_ONLY);
  });
});

test('a missing/unreadable rule file is human-only (fail closed)', () => {
  assert.equal(m.classifyTarget({ kind: 'rule', rule_path: '/no/such/rule-xyz.md' }).classification, m.CLASSIFICATION.HUMAN_ONLY);
  assert.equal(m.classifyTarget({ kind: 'rule' }).classification, m.CLASSIFICATION.HUMAN_ONLY);
});

test('frontmatter reader tolerates quotes + inline comments', () => {
  const block = m.frontmatterBlock('---\nmutability: human-only   # DD-6 class\nid: "rule.x"\n---\nbody');
  assert.equal(m.frontmatterField(block, 'mutability'), 'human-only');
  assert.equal(m.frontmatterField(block, 'id'), 'rule.x');
});

test('the real shipped fabrication rule (mutability:human-only) classifies human-only', () => {
  const shipped = path.join(__dirname, '..', '..', '..', 'rules', 'core', 'fabrication.md');
  if (fs.existsSync(shipped)) {
    assert.equal(m.classifyTarget({ kind: 'rule', rule_path: shipped }).classification, m.CLASSIFICATION.HUMAN_ONLY);
  }
});

/* ---------------------------------------------------- assertMachineChangeAllowed (EHUMANONLY) */

test('assertMachineChangeAllowed THROWS EHUMANONLY for a human-only target', () => {
  assert.throws(
    () => m.assertMachineChangeAllowed({ kind: 'gate' }, { field: 'x' }),
    (e) => e instanceof m.HumanOnlyViolation && e.code === 'EHUMANONLY',
  );
  assert.throws(
    () => m.assertMachineChangeAllowed({ kind: 'config', path: 'gate.thresholds.hard' }, {}),
    (e) => e.code === 'EHUMANONLY',
  );
});

test('assertMachineChangeAllowed returns the verdict for a machine-changeable target', () => {
  const v = m.assertMachineChangeAllowed({ kind: 'calendar-weighting' }, { field: 'weight' });
  assert.equal(v.classification, m.CLASSIFICATION.MACHINE_CHANGEABLE);
});

/* ---------------------------------------------------- assertNotGateLoosening (ENEVERLOOSEN) */

test('disposition weakening block→warn THROWS ENEVERLOOSEN', () => {
  assert.throws(
    () => m.assertNotGateLoosening({ kind: 'gate' }, { disposition: { before: 'block', after: 'warn' } }),
    (e) => e instanceof m.NeverLoosenViolation && e.code === 'ENEVERLOOSEN',
  );
});

test('disposition tightening warn→block is allowed', () => {
  assert.equal(m.assertNotGateLoosening({ kind: 'gate' }, { disposition: { before: 'warn', after: 'block' } }), true);
});

test('severity weakening hard→soft THROWS; soft→hard allowed', () => {
  assert.throws(() => m.assertNotGateLoosening({}, { severity: { before: 'hard', after: 'soft' } }), (e) => e.code === 'ENEVERLOOSEN');
  assert.equal(m.assertNotGateLoosening({}, { severity: { before: 'soft', after: 'hard' } }), true);
});

test('bars_recommended true→false THROWS; false→true allowed', () => {
  assert.throws(() => m.assertNotGateLoosening({}, { bars_recommended: { before: true, after: false } }), (e) => e.code === 'ENEVERLOOSEN');
  assert.equal(m.assertNotGateLoosening({}, { bars_recommended: { before: false, after: true } }), true);
});

test('threshold numeric without declared direction fails closed', () => {
  assert.throws(
    () => m.assertNotGateLoosening({}, { field: 'gate.hard_fail_threshold', before: 5, after: 3 }),
    (e) => e.code === 'ENEVERLOOSEN',
  );
});

test('threshold numeric with declared direction: loosening throws, tightening passes', () => {
  // higher-is-stricter: lowering loosens
  assert.throws(() => m.assertNotGateLoosening({}, { numeric: { field: 't', before: 8, after: 6, direction: 'higher-is-stricter' } }), (e) => e.code === 'ENEVERLOOSEN');
  assert.equal(m.assertNotGateLoosening({}, { numeric: { field: 't', before: 6, after: 8, direction: 'higher-is-stricter' } }), true);
  // lower-is-stricter: raising loosens
  assert.throws(() => m.assertNotGateLoosening({}, { numeric: { field: 't', before: 6, after: 8, direction: 'lower-is-stricter' } }), (e) => e.code === 'ENEVERLOOSEN');
});

test('widening a human-set bounds envelope THROWS (machine must stay within bounds)', () => {
  assert.throws(
    () => m.assertNotGateLoosening({ kind: 'tunable-dial' }, { bounds: { before: { min: 0, max: 1 }, after: { min: -1, max: 2 } } }),
    (e) => e.code === 'ENEVERLOOSEN',
  );
  // narrowing/equal bounds is fine
  assert.equal(m.assertNotGateLoosening({ kind: 'tunable-dial' }, { bounds: { before: { min: 0, max: 1 }, after: { min: 0.2, max: 0.8 } } }), true);
});

test('unrecognized disposition/severity tokens fail closed', () => {
  assert.throws(() => m.assertNotGateLoosening({}, { disposition: { before: 'block', after: 'maybe' } }), (e) => e.code === 'ENEVERLOOSEN');
  assert.throws(() => m.assertNotGateLoosening({}, { severity: { before: 'hard', after: 'mild' } }), (e) => e.code === 'ENEVERLOOSEN');
});

test('a pure content-preference weighting change (no gate axis) is not loosening', () => {
  // changing a calendar weight value is not a gate axis — no throw.
  assert.equal(m.assertNotGateLoosening({ kind: 'calendar-weighting' }, { field: 'calendar.weights.evergreen', before: 0.3, after: 0.5 }), true);
});

test('effects[] array: any single loosening effect throws', () => {
  assert.throws(
    () => m.assertNotGateLoosening({ kind: 'gate' }, { effects: [
      { field: 'note', before: 'a', after: 'b' },
      { field: 'disposition', before: 'block', after: 'warn' },
    ] }),
    (e) => e.code === 'ENEVERLOOSEN',
  );
});

/* ------------------------------------------------------------------------------- registry */

test('the machine-changeable registry is the small explicit allowlist (3 bounded kinds)', () => {
  assert.ok(Array.isArray(m.MACHINE_CHANGEABLE_REGISTRY));
  const kinds = m.MACHINE_CHANGEABLE_REGISTRY.map((e) => e.kind).sort();
  assert.deepEqual(kinds, ['archetype-prioritization', 'calendar-weighting', 'tunable-dial']);
  for (const e of m.MACHINE_CHANGEABLE_REGISTRY) {
    assert.equal(typeof e.match, 'function');
    assert.equal(e.bounded, true);
  }
  // registry is frozen (cannot be mutated at runtime)
  assert.throws(() => { m.MACHINE_CHANGEABLE_REGISTRY.push({ kind: 'x' }); });
});
