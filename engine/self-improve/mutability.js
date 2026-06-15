'use strict';

/**
 * engine/self-improve/mutability.js  [N net-new]
 *
 * THE MUTABILITY BOUNDARY — the DD-6 safety core of the governed self-improvement loop
 * (release-spec.md §8.9 analytics/learning loop; §10.1 mutability frontmatter; original-design-spec
 * §2.6 self-improvement, §3.1 "the objective is NOT to make the gating mechanism more permissive";
 * decisions.md DD-6 "guardrail rules & hard-fail thresholds human-change-only").
 *
 * This module is the structural answer to the single most safety-critical question in the loop:
 * *is the system even ALLOWED to change this?* It is what makes the whole loop safe, so it is built
 * first and enforced structurally — not as a prompt request to an LLM, but as deterministic engine
 * code that THROWS. Every machine-application path (the future applier, P6/roadmap B.3 #3) MUST
 * route every candidate change through `assertMachineChangeAllowed` + `assertNotGateLoosening`
 * before touching anything on disk; the applier never decides for itself what is mutable.
 *
 * It enforces three DD-6 invariants, in order of how a change is checked:
 *
 *   (1) HUMAN-ONLY boundary (DD-6 (1); §9.1 "be tuned permissive by any automated loop" prohibition).
 *       A target is MACHINE-CHANGEABLE only if it is BOTH (a) on the small, explicit allowlist of
 *       machine-changeable target kinds (the registry below) AND (b) not classified human-only.
 *       Guardrail/safety rules, the gate, and hard-fail thresholds are human-only ALWAYS, regardless
 *       of frontmatter. Any rules/*.md carrying `mutability: human-only` is human-only. Anything we
 *       cannot positively classify as machine-changeable defaults to HUMAN-ONLY (conservative — the
 *       boundary fails closed). `assertMachineChangeAllowed` THROWS `EHUMANONLY` for a human-only
 *       target — a structural refusal the applier cannot talk its way past.
 *
 *   (2) NEVER-LOOSEN invariant (release-spec §3.1; original-design-spec §3.1). Even on a
 *       machine-changeable target, a change may NEVER make a gate/guardrail more permissive.
 *       `assertNotGateLoosening` inspects the change's EFFECT against the strictness orderings the
 *       gate contract defines (severity hard>soft, disposition block>correct>warn, bars_recommended
 *       true>false, and the directional bound-widening of numeric dials) and THROWS `ENEVERLOOSEN`
 *       for any loosening. This is belt-and-suspenders with (1): even if a future allowlist entry is
 *       wrong, a loosening change still cannot land.
 *
 *   (3) The classifier `classifyTarget` returns the full {classification, reason, ...} so callers
 *       (the applier, `engine status`, the event ledger) can SURFACE why a target is/ isn't machine-
 *       changeable. Auditability is part of the governance, not a side effect.
 *
 * The OTHER DD-6 invariants — evidence threshold, canary→observe→promote/rollback, versioned one-step
 * rollback, off-by-default + kill switch — live in the sibling self-improve modules (evidence gate,
 * applier, canary controller) and call INTO this module. This file owns only the boundary + the two
 * structural refusals; keeping it small and pure is the point (it is the part that must never have a
 * subtle bug). RD-2/RD-12: pure, deterministic, zero-key, no LLM, no network, testable offline.
 *
 * Tier-3 cleanliness (§0.3 r6): no IDs, no handles, no absolute paths, no codenames, no brand strings.
 */

const fs = require('fs');

/* ------------------------------------------------------------------------------------------------ *
 * Error types — distinct, named, with stable `code` strings so callers branch on the code, never on
 * the message text. These are the two structural refusals DD-6 requires.
 * ------------------------------------------------------------------------------------------------ */

/** Thrown when a machine change is attempted against a HUMAN-ONLY target (DD-6 (1)). */
class HumanOnlyViolation extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'HumanOnlyViolation';
    this.code = 'EHUMANONLY';
    Object.assign(this, details);
  }
}

/** Thrown when a change's effect would make a gate/guardrail more permissive (release-spec §3.1). */
class NeverLoosenViolation extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'NeverLoosenViolation';
    this.code = 'ENEVERLOOSEN';
    Object.assign(this, details);
  }
}

/* ------------------------------------------------------------------------------------------------ *
 * Classification vocabulary.
 * ------------------------------------------------------------------------------------------------ */

const CLASSIFICATION = Object.freeze({
  MACHINE_CHANGEABLE: 'machine-changeable',
  HUMAN_ONLY: 'human-only',
});

/* ------------------------------------------------------------------------------------------------ *
 * THE MACHINE-CHANGEABLE REGISTRY (DD-6 (1) "Machine-allowed targets ONLY").
 *
 * This is the small, explicit allowlist of target KINDS the loop is permitted to touch. It is an
 * allowlist, never a denylist: a target kind not named here is HUMAN-ONLY by default (fail closed).
 * It maps directly onto original-design-spec §2.6 ("the system automatically adjusts ... calendar
 * weightings to prioritize high-performing content types") and DD-6's enumerated allowed targets:
 *   - calendar weightings,
 *   - content-type / archetype prioritization,
 *   - explicitly machine-tunable dials WITHIN human-set bounds.
 *
 * Each entry declares:
 *   - kind            stable id of the target kind.
 *   - description     what it is, why it is safe to machine-tune.
 *   - match(target)   predicate that returns true when a target descriptor is of this kind.
 *   - bounded         true if values are constrained by human-set bounds (the dials).
 *
 * Crucially, NOTHING that is a gate/guardrail/threshold can ever be added here without also being
 * human-only by classification (see GATE_GUARDRAIL_* below) — the two checks are independent so an
 * erroneous registry entry still cannot loosen a gate. Adding a kind here is a HUMAN decision
 * (editing this shipped file is a human-only act by §10.1 — code is shipped, human-owned).
 * ------------------------------------------------------------------------------------------------ */

const MACHINE_CHANGEABLE_REGISTRY = Object.freeze([
  Object.freeze({
    kind: 'calendar-weighting',
    description:
      'Relative weighting of calendar slot types / content types in the calendar generator and ' +
      'slot scheduler (original-design-spec §2.6 "calendar weightings to prioritize high-performing ' +
      'content types"). Tunes WHAT to schedule more of — never a gate, never a publish gate.',
    bounded: true,
    match: (t) =>
      t.kind === 'calendar-weighting' ||
      (t.kind === 'config' && typeof t.path === 'string' &&
        /^(calendar|scheduler)\.(weight|weights|weighting|slot_weights|content_type_weights)\b/u.test(t.path)),
  }),
  Object.freeze({
    kind: 'archetype-prioritization',
    description:
      'Prioritization / ranking among brand archetypes and content types for matcher seeding ' +
      '(original-design-spec §2.6 "what content types, themes, formats ... performed best"). Tunes ' +
      'ORDER/PREFERENCE of generation inputs — never alters what the gate accepts.',
    bounded: true,
    match: (t) =>
      t.kind === 'archetype-prioritization' ||
      t.kind === 'content-type-prioritization' ||
      (t.kind === 'config' && typeof t.path === 'string' &&
        /^(archetype|content_type|archetypes|content_types)\.(priority|priorities|prioritization|ranking|order)\b/u.test(t.path)),
  }),
  Object.freeze({
    kind: 'tunable-dial',
    description:
      'An explicitly machine-tunable dial declared with human-set bounds (DD-6 (1) "explicitly ' +
      'machine-tunable dials within human-set bounds"). A dial is machine-changeable ONLY when the ' +
      'target descriptor carries machine_tunable:true AND a numeric bounds:{min,max} envelope. ' +
      'Used for non-gate generation dials (e.g. variant emphasis weights). NEVER a gate threshold.',
    bounded: true,
    match: (t) =>
      t.kind === 'tunable-dial' &&
      t.machine_tunable === true &&
      t.bounds && typeof t.bounds === 'object' &&
      typeof t.bounds.min === 'number' && typeof t.bounds.max === 'number',
  }),
]);

/* ------------------------------------------------------------------------------------------------ *
 * Always-human-only surfaces (DD-6 (1); §9.1; original-design-spec §3.1). These are recognized
 * regardless of any frontmatter or registry entry — they are the load-bearing safety surfaces and
 * are human-only ALWAYS.
 * ------------------------------------------------------------------------------------------------ */

/** rule categories that are guardrails/safety and therefore always human-only (§10.1 frontmatter). */
const GUARDRAIL_RULE_CATEGORIES = Object.freeze(['safety']);

/**
 * config keys / key-prefixes that are gate / hard-fail-threshold / guardrail surfaces and are always
 * human-only. Anything under these is a structural refusal target. Prefix-matched against a dotted
 * config path (e.g. `gate.thresholds.hard`, `budget.monthly_cap` stays human-only too — caps are a
 * §15.4 safety governance surface, not a content dial).
 */
const HUMAN_ONLY_CONFIG_PREFIXES = Object.freeze([
  'gate',            // anything under the gate
  'thresholds',      // hard-fail / pass thresholds
  'hard_fail',
  'hardfail',
  'guardrail',
  'firewall',        // fact firewall
  'budget',          // §15.4 spend caps + kill-switch governance
  'reviewers',       // §11.2 DD-17 approver allowlist
  'publish',         // §11.2 publish posture / auto_publish — human-only
  'auto_publish',
  'mode',            // §8.3 mode ladder
  'paused',          // §15.4 kill switch
  'calibration',     // §2.5 pass criteria are human-set
]);

/** Source layers (code-registry `source`) that are gate layers — targeting one is human-only. */
const GATE_SOURCE_LAYERS = Object.freeze(['lint', 'llm-voice', 'llm-quality', 'package', 'platform', 'visual']);

/* ------------------------------------------------------------------------------------------------ *
 * Strictness orderings for the NEVER-LOOSEN comparator (release-spec §3.1).
 *
 * For each ordered axis: a HIGHER index = STRICTER (less permissive). A change is LOOSENING when it
 * moves a value to a LOWER index (more permissive). Unknown tokens are treated conservatively (a
 * move to/from an unknown token on a gate axis is treated as a potential loosening unless it is a
 * provable tightening). The orderings mirror the gate contract: code-registry-entry.schema.json
 * (tier hard|soft; disposition block|correct|warn — hard⇒block) and rule frontmatter §10.1.
 * ------------------------------------------------------------------------------------------------ */

// disposition: block (strictest) > correct > warn (most permissive). (§10.1; DD-20/RD-21.)
const DISPOSITION_STRICTNESS = Object.freeze(['warn', 'correct', 'block']);
// severity / tier: soft < hard. (code-registry: hard always implies disposition block.)
const SEVERITY_STRICTNESS = Object.freeze(['soft', 'hard']);

/** index of a token in an ordering, or -1 if unknown. */
function strictnessIndex(ordering, value) {
  return ordering.indexOf(String(value).trim().toLowerCase());
}

/* ------------------------------------------------------------------------------------------------ *
 * Frontmatter reading (rules/*.md, §10.1). Intentionally minimal/tolerant single-line YAML reader —
 * the same posture campaign.js takes for runtime frontmatter reads (the strict schema runner is the
 * canonical validator; this is the runtime read). We only need a handful of scalar keys.
 * ------------------------------------------------------------------------------------------------ */

/** Extract the `---\n ... \n---` frontmatter block from a markdown string, or '' if none. */
function frontmatterBlock(raw) {
  const m = String(raw).match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/u);
  return m ? m[1] : '';
}

/** First single-line `key: value` scalar field in a frontmatter block, lowercased+trimmed, or null. */
function frontmatterField(block, key) {
  const re = new RegExp(`^\\s*${key}\\s*:\\s*(.+?)\\s*$`, 'mu');
  const m = block.match(re);
  if (!m) return null;
  // strip surrounding quotes + an inline comment.
  let v = m[1].trim();
  v = v.replace(/\s+#.*$/u, '').trim();
  v = v.replace(/^["']|["']$/gu, '').trim();
  return v;
}

/**
 * Read the §10.1 mutability-relevant frontmatter of a rule file. Returns null when the file cannot
 * be read or has no frontmatter — and a missing/unreadable rule is treated as HUMAN-ONLY by the
 * classifier (fail closed; you cannot machine-change what you cannot prove is learnable).
 *
 * @param {string} filePath  absolute path to a rules/*.md file.
 * @returns {{mutability:(string|null), category:(string|null), severity:(string|null), id:(string|null)}|null}
 */
function readRuleFrontmatter(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  const block = frontmatterBlock(raw);
  if (!block) return null;
  return {
    id: frontmatterField(block, 'id'),
    mutability: lc(frontmatterField(block, 'mutability')),
    category: lc(frontmatterField(block, 'category')),
    severity: lc(frontmatterField(block, 'severity')),
  };
}

function lc(v) {
  return typeof v === 'string' ? v.toLowerCase() : v;
}

/* ------------------------------------------------------------------------------------------------ *
 * Target descriptor.
 *
 * A `target` is a plain descriptor of WHAT a change would touch. Shapes the classifier understands:
 *   - { kind: 'rule', rule_path: '<abs path to rules/*.md>' }            classify by frontmatter (§10.1)
 *   - { kind: 'rule', rule_frontmatter: {mutability, category, ...} }    classify by supplied frontmatter
 *   - { kind: 'config', path: 'a.b.c' }                                  classify by config path
 *   - { kind: 'gate' | 'guardrail' | 'threshold', ... }                 always human-only
 *   - { kind: 'calendar-weighting' | 'archetype-prioritization', ... }  registry-matched, machine-changeable
 *   - { kind: 'content-type-prioritization', ... }                      registry-matched
 *   - { kind: 'tunable-dial', machine_tunable:true, bounds:{min,max} }  registry-matched dial
 *   - { kind: 'brand-dna' | 'voice' | 'rules', ... }                    not on the allowlist => human-only
 *
 * Anything unrecognized => HUMAN-ONLY (conservative default — DD-6 (1) "default to human-only on
 * any doubt").
 * ------------------------------------------------------------------------------------------------ */

/** Always-human-only kinds, recognized structurally regardless of registry/frontmatter. */
const ALWAYS_HUMAN_ONLY_KINDS = Object.freeze(['gate', 'guardrail', 'threshold', 'hard-fail', 'firewall', 'reviewer-allowlist', 'budget', 'mode', 'kill-switch']);

/**
 * Does a dotted config path fall under a human-only prefix? Matched at ANY segment depth so e.g.
 * `system.gate.thresholds` is caught by the `gate` prefix (a gate buried under a namespace is still
 * a gate). Conservative by design.
 */
function isHumanOnlyConfigPath(dotted) {
  if (typeof dotted !== 'string' || dotted === '') return false;
  return dotted
    .split('.')
    .filter(Boolean)
    .some((seg) => HUMAN_ONLY_CONFIG_PREFIXES.includes(seg.toLowerCase()));
}

/**
 * classifyTarget — the deterministic classifier (DD-6 (1)). Returns the classification plus a human-
 * readable reason and the registry kind (when machine-changeable) so callers can surface it.
 *
 * Order of decision (most-restrictive wins; fail closed):
 *   1. always-human-only kinds            => human-only
 *   2. rule with human-only frontmatter,  => human-only
 *      guardrail/safety category, or a
 *      missing/unreadable rule
 *   3. config path under a human-only      => human-only
 *      prefix, or a gate source layer
 *   4. a registry-matched machine kind     => machine-changeable
 *      (AND not caught by 1–3)
 *   5. anything else                       => human-only (conservative default)
 *
 * @param {object} target  the target descriptor (see above).
 * @returns {{classification:string, reason:string, kind:(string|null), bounded:boolean}}
 */
function classifyTarget(target) {
  if (!target || typeof target !== 'object') {
    return deny('target is missing or not an object — defaulting to human-only');
  }
  const kind = typeof target.kind === 'string' ? target.kind.toLowerCase() : null;

  // (1) Structurally-always-human-only kinds — the load-bearing safety surfaces.
  if (kind && ALWAYS_HUMAN_ONLY_KINDS.includes(kind)) {
    return deny(`target kind "${kind}" is a gate/guardrail/threshold surface — human-only always (DD-6)`);
  }

  // (2) Rules — classified by §10.1 frontmatter. Guardrail/safety => human-only; mutability:human-only
  //     => human-only; a missing/unreadable rule => human-only (fail closed). The whole rules/ kind is
  //     not on the machine-changeable allowlist, so even a `learnable` rule is NOT machine-applicable
  //     by THIS module — `learnable` only means "a learning record may be CREATED" (§7.10/learning.js);
  //     machine APPLICATION to rule bodies is never on the allowlist in v1 (B.3 #3 roadmap). We still
  //     surface the frontmatter so callers see why.
  if (kind === 'rule' || kind === 'rules') {
    let fm = target.rule_frontmatter || null;
    if (!fm && typeof target.rule_path === 'string') fm = readRuleFrontmatter(target.rule_path);
    if (!fm) {
      return deny('rule frontmatter missing/unreadable — human-only (fail closed)');
    }
    if (fm.mutability === 'human-only') {
      return deny(`rule "${fm.id || target.rule_path || '?'}" frontmatter mutability:human-only`);
    }
    if (GUARDRAIL_RULE_CATEGORIES.includes(fm.category)) {
      return deny(`rule "${fm.id || target.rule_path || '?'}" is category:${fm.category} (guardrail/safety) — human-only always`);
    }
    // A `learnable` non-safety rule: still not on the machine-application allowlist for v1.
    return deny(
      `rule "${fm.id || target.rule_path || '?'}" is mutability:${fm.mutability || '?'} but rule-body ` +
      'machine-application is not on the v1 allowlist (learning records are human-applied, §8.9/B.3 #3)',
    );
  }

  // (3) Config — gate / threshold / guardrail / governance prefixes are human-only.
  if (kind === 'config') {
    if (isHumanOnlyConfigPath(target.path)) {
      return deny(`config path "${target.path}" is under a human-only prefix (gate/threshold/governance)`);
    }
    // gate source layer escape hatch: a descriptor explicitly naming a gate source layer is human-only.
    if (typeof target.source === 'string' && GATE_SOURCE_LAYERS.includes(target.source.toLowerCase())) {
      return deny(`config target names gate source layer "${target.source}" — human-only`);
    }
    // fall through to (4): a config path may still match a machine-changeable registry kind.
  }

  // (4) Machine-changeable registry match.
  for (const entry of MACHINE_CHANGEABLE_REGISTRY) {
    let matched = false;
    try {
      matched = entry.match(target) === true;
    } catch {
      matched = false;
    }
    if (matched) {
      return {
        classification: CLASSIFICATION.MACHINE_CHANGEABLE,
        reason: `matches machine-changeable kind "${entry.kind}" (${entry.description.split('.')[0]})`,
        kind: entry.kind,
        bounded: entry.bounded === true,
      };
    }
  }

  // (5) Conservative default — human-only on any doubt (DD-6).
  return deny(
    `target kind "${kind || '?'}" is not on the machine-changeable allowlist — human-only by default (DD-6 fail-closed)`,
  );
}

function deny(reason) {
  return {
    classification: CLASSIFICATION.HUMAN_ONLY,
    reason,
    kind: null,
    bounded: false,
  };
}

/** True iff the target is machine-changeable (thin wrapper over classifyTarget). */
function isMachineChangeable(target) {
  return classifyTarget(target).classification === CLASSIFICATION.MACHINE_CHANGEABLE;
}

/* ------------------------------------------------------------------------------------------------ *
 * assertMachineChangeAllowed — STRUCTURAL REFUSAL #1 (DD-6 (1)). THROWS EHUMANONLY for a human-only
 * target. The applier calls this before any disk write; there is no way to "pass a flag" to bypass
 * it — refusing is the function's only behavior on a human-only target.
 * ------------------------------------------------------------------------------------------------ */

/**
 * @param {object} target  target descriptor.
 * @param {object} [change]  the proposed change (recorded on the error for auditing; not required to classify).
 * @returns {{classification:string, reason:string, kind:(string|null), bounded:boolean}} on success.
 * @throws {HumanOnlyViolation} (code EHUMANONLY) when the target is human-only.
 */
function assertMachineChangeAllowed(target, change) {
  const verdict = classifyTarget(target);
  if (verdict.classification !== CLASSIFICATION.MACHINE_CHANGEABLE) {
    throw new HumanOnlyViolation(
      `Refusing machine change: ${verdict.reason}. Machine application is permitted only for the ` +
      'allowlisted target kinds (calendar weightings, archetype/content-type prioritization, ' +
      'explicitly bounded tunable dials). This target must be changed by a human (DD-6).',
      { target: summarizeTarget(target), change: summarizeChange(change), verdict },
    );
  }
  return verdict;
}

/* ------------------------------------------------------------------------------------------------ *
 * assertNotGateLoosening — STRUCTURAL REFUSAL #2 (release-spec §3.1; original-design-spec §3.1).
 * THROWS ENEVERLOOSEN for any change whose EFFECT makes a gate/guardrail more permissive. This is
 * independent of (1): it is checked even on machine-changeable targets, so a mis-scoped allowlist
 * entry still cannot loosen a gate. It compares the change's before/after along the gate strictness
 * axes (severity, disposition, bars_recommended, and numeric bound-widening).
 * ------------------------------------------------------------------------------------------------ */

/**
 * A `change` is a before/after descriptor. Recognized fields (any subset):
 *   { field, before, after }                       a single named field transition
 *   { effects: [ {field, before, after}, ... ] }   multiple transitions in one change
 *   { severity:{before,after} } / { disposition:{before,after} } / { bars_recommended:{before,after} }
 *   { numeric:{field, before, after, direction} }  a numeric dial where direction:'higher-is-stricter'
 *                                                   | 'lower-is-stricter' declares which way loosens.
 *   { bounds:{ before:{min,max}, after:{min,max} } } a human-set bounds envelope (widening it loosens).
 *
 * Any transition the comparator cannot PROVE is non-loosening on a gate axis is treated as a
 * potential loosening and rejected (fail closed). Pure content-preference dials with no declared
 * gate semantics are not gate axes and pass.
 *
 * @param {object} target  target descriptor (used only for the error report + bounds context).
 * @param {object} change  the change descriptor.
 * @returns {true} when no loosening is detected.
 * @throws {NeverLoosenViolation} (code ENEVERLOOSEN) on any detected/possible loosening of a gate axis.
 */
function assertNotGateLoosening(target, change) {
  const transitions = collectTransitions(change);
  for (const t of transitions) {
    const loosening = detectLoosening(t);
    if (loosening) {
      throw new NeverLoosenViolation(
        `Refusing change: it would make a gate/guardrail more permissive — ${loosening}. A machine ` +
        'change may NEVER loosen a gate or guardrail (release-spec §3.1; original-design-spec §3.1).',
        { target: summarizeTarget(target), change: summarizeChange(change), axis: t.field || t.axis },
      );
    }
  }
  return true;
}

/** Normalize any accepted change shape into a flat list of {axis, field, before, after, ...} transitions. */
function collectTransitions(change) {
  if (!change || typeof change !== 'object') return [];
  const out = [];

  const pushBeforeAfter = (axis, field, ba) => {
    if (ba && typeof ba === 'object' && ('before' in ba || 'after' in ba)) {
      out.push({ axis, field: field || axis, before: ba.before, after: ba.after });
    }
  };

  // gate-axis shorthands.
  pushBeforeAfter('severity', 'severity', change.severity);
  pushBeforeAfter('tier', 'tier', change.tier);
  pushBeforeAfter('disposition', 'disposition', change.disposition);
  pushBeforeAfter('bars_recommended', 'bars_recommended', change.bars_recommended);

  // generic single transition.
  if ('field' in change && ('before' in change || 'after' in change)) {
    out.push({ axis: inferAxis(change.field), field: change.field, before: change.before, after: change.after });
  }

  // numeric dial with declared direction.
  if (change.numeric && typeof change.numeric === 'object') {
    const n = change.numeric;
    out.push({
      axis: 'numeric',
      field: n.field || 'numeric',
      before: n.before,
      after: n.after,
      direction: n.direction,
    });
  }

  // bounds envelope (widening human-set bounds is loosening).
  if (change.bounds && typeof change.bounds === 'object') {
    out.push({ axis: 'bounds', field: 'bounds', before: change.bounds.before, after: change.bounds.after });
  }

  // multiple effects array.
  if (Array.isArray(change.effects)) {
    for (const e of change.effects) {
      if (e && typeof e === 'object' && 'field' in e) {
        out.push({ axis: inferAxis(e.field), field: e.field, before: e.before, after: e.after, direction: e.direction });
      }
    }
  }

  return out;
}

/** Map a field name to a known gate axis (so a generic {field,before,after} is checked correctly). */
function inferAxis(field) {
  const f = String(field || '').toLowerCase();
  if (f.endsWith('severity') || f === 'severity' || f.endsWith('tier') || f === 'tier') return 'severity';
  if (f.endsWith('disposition') || f === 'disposition') return 'disposition';
  if (f.endsWith('bars_recommended') || f === 'bars_recommended') return 'bars_recommended';
  if (f.includes('threshold') || f.includes('hard_fail') || f.includes('hardfail') || f.includes('min_') || f.includes('cap')) return 'threshold-numeric';
  return 'unknown';
}

/**
 * Detect whether a single transition is loosening. Returns a human-readable reason string when it IS
 * (or might be) loosening, or null when it is provably non-loosening. Fail closed on gate axes.
 */
function detectLoosening(t) {
  if (!t) return null;
  const noChange = t.before === undefined || t.after === undefined || t.before === t.after;

  switch (t.axis) {
    case 'severity':
    case 'tier': {
      if (noChange) return null;
      const bi = strictnessIndex(SEVERITY_STRICTNESS, t.before);
      const ai = strictnessIndex(SEVERITY_STRICTNESS, t.after);
      if (bi === -1 || ai === -1) {
        return `severity transition ${fmt(t.before)}→${fmt(t.after)} uses an unrecognized token — cannot prove it is not a loosening`;
      }
      if (ai < bi) return `severity weakened ${fmt(t.before)}→${fmt(t.after)} (hard>soft)`;
      return null;
    }

    case 'disposition': {
      if (noChange) return null;
      const bi = strictnessIndex(DISPOSITION_STRICTNESS, t.before);
      const ai = strictnessIndex(DISPOSITION_STRICTNESS, t.after);
      if (bi === -1 || ai === -1) {
        return `disposition transition ${fmt(t.before)}→${fmt(t.after)} uses an unrecognized token — cannot prove it is not a loosening`;
      }
      if (ai < bi) return `disposition weakened ${fmt(t.before)}→${fmt(t.after)} (block>correct>warn)`;
      return null;
    }

    case 'bars_recommended': {
      if (noChange) return null;
      // true (bars the Recommended pick) is stricter than false. true→false is loosening.
      if (asBool(t.before) === true && asBool(t.after) === false) {
        return 'bars_recommended weakened true→false (stops barring the Recommended pick)';
      }
      return null;
    }

    case 'numeric':
    case 'threshold-numeric': {
      if (noChange) return null;
      const b = Number(t.before);
      const a = Number(t.after);
      if (!Number.isFinite(b) || !Number.isFinite(a)) {
        return `numeric transition ${fmt(t.before)}→${fmt(t.after)} is non-numeric — cannot prove it is not a loosening`;
      }
      if (a === b) return null;
      // Direction MUST be declared for a gate/threshold numeric, else we cannot know which way loosens.
      const dir = String(t.direction || '').toLowerCase();
      if (t.axis === 'threshold-numeric' && dir === '') {
        return `threshold ${fmt(t.field)} changed ${b}→${a} with no declared strictness direction — cannot prove it is not a loosening`;
      }
      if (dir === 'higher-is-stricter' && a < b) {
        return `threshold ${fmt(t.field)} lowered ${b}→${a} (higher is stricter)`;
      }
      if (dir === 'lower-is-stricter' && a > b) {
        return `threshold ${fmt(t.field)} raised ${b}→${a} (lower is stricter)`;
      }
      // A declared-direction numeric dial moving in the stricter direction (or a non-gate dial) is fine.
      return null;
    }

    case 'bounds': {
      // Widening a human-set bounds envelope is loosening (the machine must stay WITHIN human bounds).
      const before = t.before;
      const after = t.after;
      if (!before || !after) {
        return 'bounds change without a complete before/after envelope — cannot prove it is not a widening';
      }
      const wider =
        Number(after.min) < Number(before.min) || Number(after.max) > Number(before.max);
      if (wider) {
        return `human-set bounds widened [${before.min},${before.max}]→[${after.min},${after.max}] (machine may only tune WITHIN human bounds)`;
      }
      return null;
    }

    default:
      // Unknown axis: not a recognized gate axis. A pure content-preference dial (weighting/priority)
      // is not a gate, so it is allowed. We only fail closed on the GATE axes above.
      return null;
  }
}

function asBool(v) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return v.trim().toLowerCase() === 'true';
  return Boolean(v);
}

function fmt(v) {
  return v === undefined ? '∅' : String(v);
}

/* ------------------------------------------------------------------------------------------------ *
 * Small, redaction-safe summaries for error payloads (never echo a raw diff/secret into an error).
 * ------------------------------------------------------------------------------------------------ */

function summarizeTarget(target) {
  if (!target || typeof target !== 'object') return { kind: null };
  return {
    kind: target.kind || null,
    path: typeof target.path === 'string' ? target.path : undefined,
    rule_id: target.rule_frontmatter && target.rule_frontmatter.id ? target.rule_frontmatter.id : undefined,
  };
}

function summarizeChange(change) {
  if (!change || typeof change !== 'object') return null;
  const keys = Object.keys(change);
  return { fields: keys.slice(0, 8) };
}

/* ------------------------------------------------------------------------------------------------ *
 * Exports — the classifier, the two structural assertions, and the machine-changeable registry
 * (DD-6 the whole point: this module is what makes the loop safe).
 * ------------------------------------------------------------------------------------------------ */

module.exports = {
  // classification
  CLASSIFICATION,
  classifyTarget,
  isMachineChangeable,
  // the two structural refusals (DD-6 (1) + release-spec §3.1)
  assertMachineChangeAllowed,
  assertNotGateLoosening,
  // the machine-changeable allowlist (DD-6 (1) "machine-allowed targets ONLY")
  MACHINE_CHANGEABLE_REGISTRY,
  // error types (callers branch on .code: EHUMANONLY / ENEVERLOOSEN)
  HumanOnlyViolation,
  NeverLoosenViolation,
  // strictness orderings (shared with the future applier/canary controller)
  DISPOSITION_STRICTNESS,
  SEVERITY_STRICTNESS,
  // internals exposed for tests
  readRuleFrontmatter,
  frontmatterBlock,
  frontmatterField,
  isHumanOnlyConfigPath,
  GUARDRAIL_RULE_CATEGORIES,
  HUMAN_ONLY_CONFIG_PREFIXES,
  GATE_SOURCE_LAYERS,
};
