'use strict';

/**
 * engine/gate/re-gate.js  [A adapted]
 *
 * The DD-12 re-gate path (release-spec §14.5): operator edits (edit-counts-as-approval,
 * spec §2.4) and reviewer-attached media RE-ENTER the deterministic gate subset — limits,
 * formatting, platform gates, cooldown — before publish. A failure RETURNS the decision with
 * the reason (no silent publish, no silent block, DD-12); a pass lets the decision proceed to
 * the queue. There is NO second LLM review on the edit path — the card UI states this
 * explicitly (DR confusion #14); re-gating is deterministic only.
 *
 * Why this module exists as a seam, not inline in the listener: §14.5 is surface-neutral. Any
 * approval surface (Discord reference, or a future Slack-class one — §12.4) feeds an edit or
 * an attachment through the SAME deterministic subset. The listener owns surface I/O; this
 * module owns the gate composition.
 *
 * The deterministic subset, composed from the engine's existing deterministic gates:
 *   - formatting / limits / banned-pattern / variant checks  → engine/gate/pre-gate-lint.js
 *   - privacy/leak check on source-derived copy              → engine/gate/privacy-leak.js
 *   - per-platform packaging limits                          → engine/gate/platform-gates.js (optional)
 *   - audit-header / media-state / cooldown package gate     → engine/gate/validate-package.js (optional)
 *   - media reuse cooldown for an attached asset             → engine/library/usage-log.js
 *
 * The privacy/leak layer (SYS.PRIVATE_LEAK, engine/gate/privacy-leak.js) HARD-blocks an edit that
 * re-introduces a secret shape, a sensitive structural shape, or a configured private term into the
 * copy — the same defense-in-depth backstop the first-pass gate applies, re-run on the edit path so
 * a reviewer edit can never slip a leak past the card (the human is the final backstop, §2.4). It
 * runs whenever an edited draft is supplied; the configured deny set / source seed come from the
 * caller's `seed`/`config`, so non-source edits run only the universal secret-shape scan.
 *
 * pre-gate-lint is always present (a release-blocking module). platform-gates and
 * validate-package are LATER-batch modules; they are required OPTIONALLY (a `try` around the
 * require) so this seam exists and runs the subset that is wired today, and automatically
 * picks up the package/platform layers once they land — without this module changing. A pinned
 * end-to-end re-gate test is its own batch (P4); this module only guarantees the PATH exists
 * and composes honestly (no fabricated PASS).
 *
 * Tier-3 cleanliness (§1 per-path rule): no IDs, handles, absolute paths, or brand strings;
 * no production persona codenames (§0.3 rule 6). Config (banned patterns, platform limits,
 * cooldown windows) is supplied by the caller / resolved from $CONTENT_HOME, never hardcoded.
 */

const preGateLint = require('./pre-gate-lint.js');
const privacyLeak = require('./privacy-leak.js');
const usageLog = require('../library/usage-log.js');

// platform-gates.js / validate-package.js are later-batch modules (release-spec §1 tree). Load
// them if present so the subset grows as those land; absence is not an error today (the seam
// runs the lint + cooldown layers that ARE wired).
function optionalRequire(rel) {
  try {
    return require(rel);
  } catch (err) {
    if (err && err.code === 'MODULE_NOT_FOUND') return null;
    throw err;
  }
}

const platformGates = optionalRequire('./platform-gates.js');
const validatePackage = optionalRequire('./validate-package.js');

// Image media extensions — an attached image asset must clear its reuse cooldown before it can
// re-enter the publish path (§14.5 cooldown subset). Format-classification only; carries no
// instance specifics.
const IMAGE_EXT_RE = /\.(?:png|jpe?g|webp|gif)$/iu;

function isImageRef(ref) {
  return IMAGE_EXT_RE.test(String(ref || ''));
}

/**
 * Run the deterministic gate subset against an edit and/or an attachment.
 *
 * @param {object} input
 * @param {string}   input.content_id           the item under decision (for the result envelope).
 * @param {object}   [input.draft]              a §7.11 draft ({content_id, variants:[{label,text}]})
 *                                              reflecting the EDITED text — lint runs against this.
 * @param {string}   [input.attached_media_ref] CONTENT_HOME-relative ref to reviewer-attached media —
 *                                              cooldown runs against this.
 * @param {string}   [input.platform]           platform id, for the platform-gate layer when present.
 * @param {string}   [input.package_ref]        CONTENT_HOME-relative package path, for the package layer.
 * @param {object}   [input.rules]              rule config passed to pre-gate-lint (banned_patterns,
 *                                              target_chars, variant_count, env, …).
 * @param {object}   [input.seed]               the originating content-source seed (work-recap /
 *                                              trend) carrying privacy_flags + private_terms, threaded
 *                                              into the privacy/leak layer for source-derived edits.
 * @param {object}   [input.config]             resolved config/system.json (work_recap.private_terms,
 *                                              work_recap.extra_secret_keys) for the privacy/leak layer.
 * @param {object}   [input.cooldown]           cooldown options ({hardDays, targetDays, env, now}).
 * @param {object}   [input.env]                env for path/ledger resolution (default process.env).
 * @returns {object} { ok, content_id, layers:[{layer, ok, reason?, detail?}], reasons:[] }
 *                   ok === true only when EVERY wired layer passed (fail-closed; DD-12).
 */
function reGate(input = {}) {
  const env = input.env || process.env;
  const layers = [];

  // 1. Deterministic pre-gate (limits, formatting, banned-pattern, variant checks) on the
  //    edited text. Only runs when an edited draft is supplied (edit path). A lint FAIL or a
  //    PASS_ALTERNATE_ONLY both surface — but only a hard FAIL blocks the re-gate (a soft code
  //    that merely bars the Recommended slot is not a publish blocker; it travels with the item).
  if (input.draft) {
    const lintResult = preGateLint.lint(input.draft, input.rules || {});
    const lintOk = lintResult.verdict !== 'FAIL';
    layers.push({
      layer: 'pre-gate-lint',
      ok: lintOk,
      reason: lintOk ? null : 'edited text failed the deterministic pre-gate',
      detail: lintResult.detected_codes,
    });
  }

  // 1.5 Privacy / leak check (SYS.PRIVATE_LEAK) on the edited copy. Defense in depth: a reviewer
  //     edit must not re-introduce a secret shape, a sensitive structural shape, or a configured
  //     private term into the copy before the card. Runs on the edit path (when a draft is supplied);
  //     the deny set / source flags come from input.seed + input.config (a non-source edit runs only
  //     the universal secret-shape + structural scan). HARD failure returns the decision (DD-12).
  if (input.draft) {
    const privResult = privacyLeak.checkPrivacy({
      draft: input.draft,
      seed: input.seed,
      config: input.config,
      content_id: input.content_id,
    });
    const privOk = privResult.verdict !== 'FAIL';
    layers.push({
      layer: 'privacy-leak',
      ok: privOk,
      reason: privOk ? null : 'edited copy carries residual sensitive material (privacy/leak block)',
      detail: privResult.detected_codes,
    });
  }

  // 2. Per-platform packaging limits (optional layer — present once the batch lands).
  if (platformGates && input.platform && typeof platformGates.check === 'function') {
    const pg = platformGates.check({
      content_id: input.content_id,
      platform: input.platform,
      draft: input.draft,
      package_ref: input.package_ref,
      env,
    });
    const pgOk = pg && pg.ok !== false;
    layers.push({
      layer: 'platform-gates',
      ok: Boolean(pgOk),
      reason: pgOk ? null : (pg && (pg.reason || (pg.failures || []).join('; '))) || 'platform gate failed',
      detail: pg && pg.failures,
    });
  }

  // 3. Package gate (audit-header integrity, media/visual-state, package-level cooldown) —
  //    optional layer (present once the batch lands).
  if (validatePackage && input.package_ref && typeof validatePackage.validate === 'function') {
    const vp = validatePackage.validate({
      content_id: input.content_id,
      platform: input.platform,
      package_ref: input.package_ref,
      env,
    });
    const vpOk = vp && vp.ok !== false;
    layers.push({
      layer: 'validate-package',
      ok: Boolean(vpOk),
      reason: vpOk ? null : (vp && (vp.reason || (vp.failures || []).join('; '))) || 'package gate failed',
      detail: vp && vp.failures,
    });
  }

  // 4. Media reuse cooldown for a reviewer-attached image asset (§14.5 cooldown subset; DD-14
  //    canonical ledger). A blocked asset returns the card with the reason — never a silent
  //    publish of an asset inside its reuse window.
  if (input.attached_media_ref && isImageRef(input.attached_media_ref)) {
    const cd = usageLog.cooldownStatus(input.attached_media_ref, {
      ...(input.cooldown || {}),
      env,
    });
    const cdOk = !cd.cooldown_blocked;
    layers.push({
      layer: 'cooldown',
      ok: cdOk,
      reason: cdOk
        ? null
        : `attached media is inside its reuse cooldown (${cd.recent_use_count} use(s) in the last ${cd.cooldown_days} days)`,
      detail: cd,
    });
  }

  const reasons = layers.filter((l) => !l.ok).map((l) => l.reason).filter(Boolean);
  return {
    ok: reasons.length === 0,
    content_id: input.content_id || (input.draft && input.draft.content_id) || null,
    layers,
    reasons,
  };
}

module.exports = {
  reGate,
  isImageRef,
};
