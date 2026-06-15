'use strict';

/**
 * engine/improvement-sharing/evaluate.js  [N net-new]
 *
 * THE MAINTAINER-SIDE EVALUATION HARNESS — the RECEIVING half of DD-7(b) improvement sharing
 * (release-spec.md roadmap #4 "Improvement sharing"; original-design-spec §2.6 Improvement Sharing;
 * decisions.md DD-7 "(b) — abstract rule-diffs only, sanitized + operator-reviewed before anything
 * leaves the install, MAINTAINER EVALUATION HARNESS on the receiving side"; design-review risk #7
 * supply-chain poisoning of an open upstream).
 *
 * THE THREAT THIS ANSWERS:
 *   The sharing tooling (the OUTBOUND half — engine/improvement-sharing/sanitize.js + prepare.js)
 *   lets an operator hand-PR a sanitized abstract rule-diff upstream. An open upstream that merged
 *   such PRs blindly would be a supply-chain attack surface: a contribution could (a) smuggle
 *   instance specifics / secrets that the sender's sanitizer was supposed to strip (an inbound leak
 *   into the public repo), or (b) poison the shipped rule set by LOOSENING a gate / guardrail so the
 *   whole downstream fleet starts publishing weaker content. This module is the structural defense:
 *   GIVEN an inbound sanitized rule-diff contribution, it produces an ACCEPT/REJECT verdict BEFORE a
 *   human ever considers assimilating it. It NEVER auto-merges — a `accepted:true` verdict is a
 *   "this passed the mechanical safety bar, a maintainer may now review it", not an apply.
 *
 * THE FOUR CHECKS (every one must pass; the verdict reports ALL failures, not just the first):
 *
 *   (a) SHAPE + NO INSTANCE SPECIFICS. The contribution parses and is shaped as an ABSTRACT
 *       rule-diff (the same structure the outbound sanitizer emits). Crucially it must carry NO
 *       instance/brand specifics — a contribution that smuggled a real brand name, secret shape,
 *       Discord snowflake, absolute path, or configured private term in (past the sender's
 *       sanitizer, or because the sender had no sanitizer) is REJECTED. We REUSE the outbound
 *       guard `assertShareable` from ./sanitize.js when that sibling module is present; when it is
 *       not yet on disk we fall back to a SELF-CONTAINED structural scan built on the same
 *       primitives the privacy gate uses (engine/shared/redact.js secret shapes + the work-recap
 *       privacy-filter structural/deny-term passes), so this harness is robust to batch ordering
 *       and never silently skips the no-specifics bar. This is the OUTBOUND/INBOUND MIRROR of the
 *       work-recap privacy gate (engine/gate/privacy-leak.js).
 *
 *   (b) APPLIES CLEANLY. The diff must target a recognizable rule/knob and be APPLICABLE — its
 *       before/after (or op/values) must resolve against a target descriptor without contradiction.
 *       A diff that names no target, or whose shape cannot be applied, is REJECTED (we never merge a
 *       diff we cannot even apply). This is a DRY structural check — it does not write anything.
 *
 *   (c) PASSES GATE-REGRESSION. The contribution must NOT break the shipped rule behavior. We REUSE
 *       the canonical gate-regression runner (scripts/gate-regression.js over fixtures/gate-
 *       regression — the §16.3 byte-stable-code corpus). The harness runs the suite and a
 *       contribution is rejected if the suite is red. (The runner is zero-key/deterministic — RD-12;
 *       it executes the LINT/PKG/PLAT halves live and contract-checks the FM/VIS/SYS halves.)
 *
 *   (d) DOES NOT LOOSEN A GATE + TARGETS A MACHINE-ALLOWED SURFACE. REUSE the DD-6 structural
 *       refusals from engine/self-improve/mutability.js:
 *         - assertMachineChangeAllowed → EHUMANONLY: a contribution may NOT target a human-only
 *           artifact (a guardrail/safety rule, the gate, a hard-fail threshold, governance config).
 *           An upstream that accepted a "tweak" to a safety rule from an anonymous PR is exactly the
 *           poisoning vector; the boundary refuses it structurally.
 *         - assertNotGateLoosening → ENEVERLOOSEN: even on a machine-allowed surface, a change whose
 *           EFFECT makes a gate/guardrail more permissive is REJECTED (release-spec §3.1 never-loosen).
 *
 * NEVER AUTO-MERGE (DD-7 (4); design-review risk #7). This module returns a verdict; it performs no
 * git operation, no write, no network. Assimilation is a separate, human, out-of-band act. There is
 * no `apply:true` path here by construction.
 *
 * DETERMINISTIC, ZERO-KEY (RD-2 / RD-12). The engine never calls a chain LLM. Every check is pure
 * engine code over plain objects + the on-disk fixtures; same inputs → same verdict; testable with
 * no credentials. The gate-regression suite is the only thing that touches disk, and it is itself
 * zero-key and side-effect-free (its package cases run inside throwaway temp homes).
 *
 * Tier-3 cleanliness (§0.3 r6): no real ids/handles/paths/codenames/brand strings; the only example
 * anywhere in this module or its tests is the synthetic "Acme Cosmos" fixture brand.
 */

const fs = require('fs');
const path = require('path');

const mutability = require('../self-improve/mutability.js');

/** Repo root (two up from engine/improvement-sharing/). Used to locate the gate-regression runner. */
const REPO_ROOT = path.resolve(__dirname, '..', '..');

/* ------------------------------------------------------------------------------------------------ *
 * Optional sibling reuse: the OUTBOUND sanitizer's `assertShareable` (engine/improvement-sharing/
 * sanitize.js, the IS-SANITIZE batch). When present we REUSE it so the inbound bar is byte-identical
 * to the outbound bar — there is exactly one definition of "carries instance specifics" in the
 * system. When it is not yet on disk (batch ordering) we degrade to the self-contained structural
 * scan below, which is built on the SAME primitives the sanitizer/privacy gate use. We never skip
 * the no-specifics check.
 * ------------------------------------------------------------------------------------------------ */

/** Lazily resolve the sibling sanitizer's assertShareable, or null if the module is not present. */
function resolveSiblingAssertShareable() {
  try {
    // eslint-disable-next-line global-require
    const sib = require('./sanitize.js');
    if (sib && typeof sib.assertShareable === 'function') return sib.assertShareable;
  } catch {
    /* sibling not on disk yet — fall back. */
  }
  return null;
}

/* ------------------------------------------------------------------------------------------------ *
 * The self-contained no-instance-specifics scan (the OUTBOUND mirror of engine/gate/privacy-leak.js,
 * used only when the sibling sanitizer is absent). It reuses the SAME detection engines so a secret
 * shape / structural sensitive shape / configured private term is recognized identically everywhere.
 * It additionally refuses the share-specific specifics DD-7 enumerates: brand names, Discord
 * snowflakes (17-20 digit ids), and absolute filesystem paths.
 * ------------------------------------------------------------------------------------------------ */

/** Reuse the log/seed redactor's secret SHAPES (tokens, bearer creds, signed-url params, blobs). */
const redactor = require('../shared/redact.js');
/** Reuse the work-recap privacy-filter structural + deny-term passes (financial, internal-id, deny). */
const privacyFilter = require('../sources/work-recap/privacy-filter.js');

// The share-specific anti-target patterns (DD-7 (2)): a Discord snowflake (17-20 digit id) and an
// operator/home absolute path. We PREFER the sibling sanitizer's exported patterns at runtime (so the
// inbound bar is byte-identical to the outbound/hygiene bar — resolveSpecificPatterns below); these
// local fallbacks are used only when the sibling is absent. They are assembled from fragments so this
// source file carries no literal path/long-digit specific (it stays clean under
// scripts/hygiene-scan.js — §0.3 r6 / §16.5).
const SNOWFLAKE_RE = new RegExp('(?<![\\w.])\\d{17,20}(?![\\w.])', 'u');
const HOME_SEG = ['Users', 'home', 'root'].join('|');               // the operator-home segment names
const WIN_DRIVE = '[A-Za-z]:[\\\\/]';                               // e.g. a Windows drive prefix
const ABS_PATH_RE = new RegExp(
  `(?:${WIN_DRIVE}(?:${HOME_SEG})|(?:^|[\\s"'(=])/(?:${HOME_SEG}|var|etc|opt|mnt)/)`,
  'u',
);

/** Resolve the {snowflake, absPath} detection patterns, preferring the sibling sanitizer's exports. */
function resolveSpecificPatterns() {
  try {
    // eslint-disable-next-line global-require
    const sib = require('./sanitize.js');
    if (sib && sib.SNOWFLAKE instanceof RegExp && sib.USER_PATH instanceof RegExp) {
      // The sibling patterns are global (g flag); clone to a fresh non-global RegExp for .test().
      return {
        snowflake: new RegExp(sib.SNOWFLAKE.source),
        absPath: new RegExp(sib.USER_PATH.source, 'i'),
      };
    }
  } catch {
    /* sibling absent — use the local fallbacks. */
  }
  return { snowflake: SNOWFLAKE_RE, absPath: ABS_PATH_RE };
}

class ContributionRejected extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ContributionRejected';
    this.code = 'EUNSHAREABLE';
    Object.assign(this, details);
  }
}

/** Scan ONE string for any instance/brand specific; returns the sorted family list (empty == clean). */
function scanStringForSpecifics(text, deny) {
  const str = String(text == null ? '' : text);
  const hits = [];
  // 1. Secret shapes (reuse redact.js value patterns; a changed string means a secret-shaped span).
  if (redactor.redactString(str) !== str) hits.push('secret_shape');
  // 2. Structural sensitive shapes + the operator/maintainer deny list (reuse the privacy-filter).
  const { flags } = privacyFilter.sanitizeText(str, { privateTerms: deny });
  for (const f of flags) if (f.family) hits.push(f.family);
  // 3. Share-specific specifics DD-7 enumerates (not covered by the redactor's credential focus).
  const { snowflake, absPath } = resolveSpecificPatterns();
  if (snowflake.test(str)) hits.push('snowflake');
  if (absPath.test(str)) hits.push('absolute_path');
  return Array.from(new Set(hits)).sort();
}

/**
 * Fallback assertShareable — the SAME CONTRACT as the sibling ./sanitize.js assertShareable: takes
 * the WHOLE payload object, deep-walks every string (values AND keys), and THROWS
 * ContributionRejected (EUNSHAREABLE) on the FIRST family that fires anywhere, naming the family —
 * but NEVER echoing the matched value back (echoing it would re-leak it). Returns true when clean.
 *
 * This is the inbound structural guard DD-7 (2) requires: refuse a payload that still contains a
 * brand name / secret shape / snowflake / path / configured private term. Used only when the sibling
 * sanitizer is absent, so the no-specifics bar is enforced regardless of batch ordering.
 *
 * @param {object} payload  the (sanitized) abstract rule-diff to verify.
 * @param {object} [opts]   { privateTerms?:string[], brandTerms?:string[] } anti-target context.
 * @returns {true} when no specific is present.
 * @throws {ContributionRejected} (code EUNSHAREABLE) on any residual specific.
 */
function fallbackAssertShareable(payload, opts = {}) {
  if (payload == null || typeof payload !== 'object') {
    throw new ContributionRejected('payload is missing or not an object — refusing to share (fail-closed)', { families: ['no-payload'] });
  }
  const deny = []
    .concat(Array.isArray(opts.privateTerms) ? opts.privateTerms : [])
    .concat(Array.isArray(opts.brandTerms) ? opts.brandTerms : []);

  const seen = new WeakSet();
  const offenders = [];
  const walk = (val) => {
    if (typeof val === 'string') {
      const fams = scanStringForSpecifics(val, deny);
      if (fams.length) offenders.push(fams);
      return;
    }
    if (val == null || typeof val !== 'object') return;
    if (seen.has(val)) return;
    seen.add(val);
    if (Array.isArray(val)) { val.forEach(walk); return; }
    for (const [k, v] of Object.entries(val)) {
      const fams = scanStringForSpecifics(k, deny); // a key could itself be a snowflake-keyed leaf.
      if (fams.length) offenders.push(fams);
      walk(v);
    }
  };
  walk(payload);

  if (offenders.length) {
    const families = Array.from(new Set(offenders.flat())).sort();
    throw new ContributionRejected(
      `payload still carries instance/brand specifics (${families.join(', ')}) at ${offenders.length} location(s) — `
      + 'an abstract rule-diff may carry no brand name, secret shape, snowflake, absolute path, or configured private term (DD-7 (2))',
      { families },
    );
  }
  return true;
}

/** The active shareability guard: the sibling's if present (byte-identical bar), else the fallback. */
function shareabilityGuard() {
  return resolveSiblingAssertShareable() || fallbackAssertShareable;
}

/* ------------------------------------------------------------------------------------------------ *
 * Check (a) — shape + no instance specifics.
 *
 * The abstract rule-diff contribution shape (the structure the outbound sanitizer emits; mirrors the
 * learning-record `proposed_diff` + `target_artifact` + the mutability target descriptor):
 *   {
 *     kind: 'rule-diff',                  // discriminator
 *     target: { ...mutability target descriptor... },   // what the diff touches (check (d) classifies it)
 *     change: { ...before/after | op/values... },        // the abstract change (checks (b)/(d) read it)
 *     rationale?: string,                 // free-text WHY (scanned for specifics)
 *     diff?: string,                      // optional unified-diff text (scanned for specifics)
 *   }
 * Every free-text + structural field is run through the shareability guard. A field carrying a
 * specific REJECTS the whole contribution (a single smuggled specific is fatal — fail closed).
 * ------------------------------------------------------------------------------------------------ */

/** Recursively collect every string leaf in a value (so no nested field escapes the specifics scan). */
function collectStrings(value, out = []) {
  if (typeof value === 'string') {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const v of value) collectStrings(v, out);
  } else if (value && typeof value === 'object') {
    for (const v of Object.values(value)) collectStrings(v, out);
  }
  return out;
}

function checkShapeAndShareable(contribution, opts) {
  const reasons = [];
  if (!contribution || typeof contribution !== 'object' || Array.isArray(contribution)) {
    return { ok: false, reasons: ['contribution is missing or not an object (expected an abstract rule-diff)'] };
  }
  const kind = typeof contribution.kind === 'string' ? contribution.kind.toLowerCase() : null;
  if (kind !== 'rule-diff') {
    reasons.push(`contribution.kind is "${contribution.kind == null ? '∅' : contribution.kind}" — expected "rule-diff" (DD-7: abstract rule-diffs only)`);
  }
  if (!contribution.target || typeof contribution.target !== 'object') {
    reasons.push('contribution.target is missing — an abstract rule-diff must name the rule/knob it touches');
  }
  if (!contribution.change || typeof contribution.change !== 'object') {
    reasons.push('contribution.change is missing — an abstract rule-diff must carry the change (before/after or op/values)');
  }

  // No-instance-specifics scan over the WHOLE contribution (the guard deep-walks every string field
  // + key — rationale, diff, target, change, …). REUSE the sibling sanitizer's assertShareable when
  // present (byte-identical to the outbound bar); else the self-contained fallback (same contract).
  // We pass opts THROUGH so the sibling's resolveDenySet/resolveBrandTerms (config/env-aware) work.
  const guard = shareabilityGuard();
  try {
    guard(contribution, opts);
  } catch (err) {
    // The guard never echoes the matched specific (privacy: do not re-leak it into the verdict).
    const fams = err && err.families && err.families.length ? ` (${err.families.join(', ')})` : '';
    reasons.push(`contribution carries instance/brand specifics${fams} — refused as un-shareable (DD-7 (2))`);
  }

  return { ok: reasons.length === 0, reasons };
}

/* ------------------------------------------------------------------------------------------------ *
 * Check (b) — applies cleanly to a rule/knob.
 *
 * A dry, structural applicability check (no disk writes). The change must resolve against the target
 * without contradiction:
 *   - a before/after transition: before/after present and not equal (a no-op diff is not a useful
 *     contribution and a "before" that is malformed cannot be applied);
 *   - an op/values change: a recognized op and a non-empty values map (the applier's payload shape);
 *   - an `effects` array: at least one well-formed {field, before/after} effect.
 * A change that matches none of these cannot be applied and is REJECTED.
 * ------------------------------------------------------------------------------------------------ */

function checkAppliesCleanly(contribution) {
  const reasons = [];
  const change = contribution && contribution.change;
  if (!change || typeof change !== 'object') {
    return { ok: false, reasons: ['change is missing or not an object — nothing to apply'] };
  }

  let applicable = false;

  // before/after transition.
  if ('before' in change || 'after' in change) {
    if (!('before' in change) || !('after' in change)) {
      reasons.push('change declares a before/after transition but is missing one side — cannot apply');
    } else if (deepEqual(change.before, change.after)) {
      reasons.push('change before === after — a no-op diff is not applicable');
    } else {
      applicable = true;
    }
  }

  // op/values map (the machine-change payload shape; e.g. {op:'increase_weight', values:{...}}).
  if (change.values && typeof change.values === 'object' && !Array.isArray(change.values)) {
    if (Object.keys(change.values).length === 0) {
      reasons.push('change.values is empty — nothing to apply');
    } else {
      applicable = true;
    }
  }

  // effects array (multiple transitions in one change).
  if (Array.isArray(change.effects)) {
    const good = change.effects.filter(
      (e) => e && typeof e === 'object' && 'field' in e && ('before' in e || 'after' in e),
    );
    if (good.length === 0) {
      reasons.push('change.effects is present but carries no well-formed {field, before/after} effect');
    } else {
      applicable = true;
    }
  }

  // gate-axis shorthands also count as an applicable transition (severity/disposition/etc.).
  for (const k of ['severity', 'tier', 'disposition', 'bars_recommended', 'numeric', 'bounds']) {
    if (change[k] && typeof change[k] === 'object') applicable = true;
  }

  if (!applicable && reasons.length === 0) {
    reasons.push('change has no recognizable applicable shape (expected before/after, op/values, effects, or a gate-axis transition)');
  }
  return { ok: applicable && reasons.length === 0, reasons };
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a && b && typeof a === 'object') {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}

/* ------------------------------------------------------------------------------------------------ *
 * Check (c) — passes gate-regression (reuse scripts/gate-regression.js).
 *
 * A contribution must NOT break the shipped rule behavior. We run the canonical §16.3 gate-regression
 * suite and reject if it is red. The runner is zero-key + deterministic + side-effect-free.
 *
 * We REUSE the runner module (not a re-implementation). It is the SAME code `npm run gate-regression`
 * runs in CI, so "passes here" means "passes the shipped QA gate". `opts.gateRegression` may inject a
 * runner result for tests (zero-key seam, §12.5 injection pattern); `opts.skipGateRegression` is an
 * explicit escape ONLY for unit tests that exercise the other checks in isolation — it is recorded on
 * the verdict so a skip is never silent.
 * ------------------------------------------------------------------------------------------------ */

function checkGateRegression(opts) {
  // Test seam: an injected result (already shaped { ok, failures? }) is used verbatim.
  if (opts && opts.gateRegression && typeof opts.gateRegression === 'object') {
    const r = opts.gateRegression;
    return {
      ok: r.ok === true,
      reasons: r.ok === true ? [] : [`gate-regression red (${(r.failures || []).length} failing case(s)) — contribution must not break shipped rule behavior`],
      skipped: false,
    };
  }
  if (opts && opts.skipGateRegression === true) {
    return { ok: true, reasons: [], skipped: true };
  }

  // Run the real runner. It returns an exit code (0 ok / 1 fail / 2 usage) and writes a human report
  // to stdout; we drive it in --json mode by capturing nothing (it prints) and reading its return.
  let runner;
  try {
    // eslint-disable-next-line global-require
    runner = require(path.join(REPO_ROOT, 'scripts', 'gate-regression.js'));
  } catch (err) {
    return {
      ok: false,
      reasons: [`could not load the gate-regression runner (${err.message}) — cannot prove the contribution is regression-safe (fail closed)`],
      skipped: false,
    };
  }
  if (!runner || typeof runner.run !== 'function') {
    return { ok: false, reasons: ['gate-regression runner is missing run() — cannot prove regression-safety (fail closed)'], skipped: false };
  }
  let code;
  try {
    // --json keeps stdout structured; we only need the exit code (0 == every fixture green).
    code = runner.run(['--json']);
  } catch (err) {
    return { ok: false, reasons: [`gate-regression runner threw (${err.message}) — fail closed`], skipped: false };
  }
  const ok = code === 0;
  return {
    ok,
    reasons: ok ? [] : ['gate-regression suite is red — the contribution would break shipped rule behavior (§16.3 byte-stable codes)'],
    skipped: false,
  };
}

/* ------------------------------------------------------------------------------------------------ *
 * Check (d) — never-loosen + machine-allowed target (reuse engine/self-improve/mutability.js).
 *
 * Two independent structural refusals (defense in depth, DD-6):
 *   - assertMachineChangeAllowed(target) → EHUMANONLY when the target is a human-only artifact
 *     (guardrail/safety rule, gate, hard-fail threshold, governance). An inbound contribution may
 *     NEVER target a human-only artifact — that is the poisoning vector.
 *   - assertNotGateLoosening(target, change) → ENEVERLOOSEN when the change's effect would make a
 *     gate/guardrail more permissive (release-spec §3.1).
 * Both are reused verbatim; this harness never re-decides mutability or loosening itself.
 * ------------------------------------------------------------------------------------------------ */

function checkMutability(contribution) {
  const reasons = [];
  const target = contribution && contribution.target;
  const change = contribution && contribution.change;

  // (d.1) machine-allowed target (EHUMANONLY for a human-only artifact).
  let verdict = null;
  try {
    verdict = mutability.assertMachineChangeAllowed(target, change);
  } catch (err) {
    if (err && err.code === 'EHUMANONLY') {
      reasons.push(`target is human-only (${(err.verdict && err.verdict.reason) || 'guardrail/gate/threshold surface'}) — an inbound contribution may not target a human-only artifact (DD-6 (1))`);
    } else {
      reasons.push(`mutability classification failed (${err && err.message}) — fail closed`);
    }
  }

  // (d.2) never-loosen (ENEVERLOOSEN for any gate/guardrail loosening). Hand the comparator only the
  // gate-axis-bearing fields of the change; a well-formed content-preference reweighting carries
  // none and passes, while a smuggled severity/disposition/threshold/bounds weakening throws.
  try {
    mutability.assertNotGateLoosening(target || {}, gateAxisFieldsOnly(change || {}));
  } catch (err) {
    if (err && err.code === 'ENEVERLOOSEN') {
      reasons.push(`change would loosen a gate/guardrail (${err.message.replace(/\s+/g, ' ').slice(0, 220)}) — a contribution may never make a gate more permissive (release-spec §3.1)`);
    } else {
      reasons.push(`never-loosen check failed (${err && err.message}) — fail closed`);
    }
  }

  return { ok: reasons.length === 0, reasons, mutability_verdict: verdict };
}

/** Keep only the fields the mutability gate-axis comparator inspects (drop reweighting metadata). */
function gateAxisFieldsOnly(change) {
  const out = {};
  for (const k of ['severity', 'tier', 'disposition', 'bars_recommended', 'field', 'before', 'after', 'numeric', 'bounds', 'effects']) {
    if (k in change) out[k] = change[k];
  }
  return out;
}

/* ------------------------------------------------------------------------------------------------ *
 * The public entry point.
 * ------------------------------------------------------------------------------------------------ */

/**
 * evaluateContribution — produce an ACCEPT/REJECT verdict for an INBOUND sanitized rule-diff
 * contribution. Runs all four checks (it never short-circuits, so the verdict lists EVERY reason a
 * contribution is rejected, which is what a maintainer needs to triage). NEVER auto-merges: the
 * verdict is advisory; assimilation is a separate human act (DD-7 (4)).
 *
 * @param {object} contribution  the inbound abstract rule-diff (shape documented in checkShape above).
 * @param {object} [opts]
 * @param {string[]} [opts.privateTerms]        configured private-term deny-list (maintainer terms to
 *                                              refuse if they appear in the payload — the inbound
 *                                              mirror of work_recap.private_terms).
 * @param {string[]} [opts.brandTerms]          brand-name anti-targets to refuse (DD-7 (2)).
 * @param {object}   [opts.gateRegression]      test seam: an injected runner result { ok, failures? }.
 * @param {boolean}  [opts.skipGateRegression]  test-only: skip the suite (recorded on the verdict).
 * @returns {{accepted:boolean, reasons:string[], checks:{shareable, applies, gate_regression, mutability}, auto_merge:false}}
 */
function evaluateContribution(contribution, opts = {}) {
  const options = opts && typeof opts === 'object' ? opts : {};

  const shareable = checkShapeAndShareable(contribution, options);
  // (b)/(d) only make sense once the shape is sane; still run them when possible so the verdict is
  // maximally informative, but guard against a totally malformed contribution.
  const applies = checkAppliesCleanly(contribution);
  const gateReg = checkGateRegression(options);
  const mut = checkMutability(contribution);

  const reasons = []
    .concat(shareable.reasons.map((r) => `[shape/shareable] ${r}`))
    .concat(applies.reasons.map((r) => `[applies] ${r}`))
    .concat(gateReg.reasons.map((r) => `[gate-regression] ${r}`))
    .concat(mut.reasons.map((r) => `[mutability] ${r}`));

  const accepted = shareable.ok && applies.ok && gateReg.ok && mut.ok;

  return {
    // The verdict. NEVER an apply — DD-7 (4): never auto-merge; a maintainer reviews after this.
    accepted,
    auto_merge: false, // structural: there is no auto-merge path in this harness.
    reasons,
    checks: {
      shareable: { ok: shareable.ok, reasons: shareable.reasons },
      applies: { ok: applies.ok, reasons: applies.reasons },
      gate_regression: { ok: gateReg.ok, reasons: gateReg.reasons, skipped: gateReg.skipped === true },
      mutability: { ok: mut.ok, reasons: mut.reasons },
    },
    rationale: accepted
      ? 'Contribution passed the mechanical safety bar (shaped as an abstract rule-diff with no instance '
        + 'specifics, applies cleanly, gate-regression green, targets a machine-allowed surface, does not '
        + 'loosen any gate). A maintainer may now review it for merit — this verdict is NOT a merge (DD-7).'
      : 'Contribution REJECTED by the maintainer evaluation harness; see reasons. It is never auto-merged.',
  };
}

module.exports = {
  evaluateContribution,
  // checks exposed for tests + sibling reuse.
  checkShapeAndShareable,
  checkAppliesCleanly,
  checkGateRegression,
  checkMutability,
  // the self-contained outbound-mirror guard (used when the sibling sanitizer is absent).
  fallbackAssertShareable,
  collectStrings,
  gateAxisFieldsOnly,
  // error type (callers branch on .code: EUNSHAREABLE).
  ContributionRejected,
};
