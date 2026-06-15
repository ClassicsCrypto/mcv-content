'use strict';

/**
 * engine/cli/voice-calibrate.js  [N net-new — roadmap #5 voice-calibration CLI stub]
 *
 * `engine voice-calibrate` — the consent-gated VOICE-DNA CALIBRATION CLI (roadmap #5).
 *
 * This verb is the human-only path for applying a voice-calibration proposal:
 *   --show     display the pending calibration card (default)
 *   --apply --consent   apply the pending proposal with explicit consent (ECONSENTREQUIRED otherwise)
 *   --rollback [--to-baseline <ref>]  rollback a previous calibration
 *
 * Governance (NON-NEGOTIABLE):
 *   - Every calibration target is HUMAN-ONLY (target_mutability:human-only, target_artifact:brand:*:voice).
 *   - self-improve applyGovernedChange MUST refuse it with EHUMANONLY.
 *   - apply requires explicit --consent flag (ECONSENTREQUIRED without it).
 *   - NEVER loosens a gate (ENEVERLOOSEN on any smuggled gate axis).
 *
 * NOTE: The propose/apply/display modules (engine/voice-calibration/) are built in a later stage
 * (Stage 4). Until they land, this verb surfaces a "not yet available" message at exit 0 so the
 * wiring is verified without blocking Stage 3.
 *
 * Tier-3 cleanliness (§0.3 r6 / RD-3): no hardcoded ids/handles/roots/codenames.
 */

const util = require('./util');

const HELP = `engine voice-calibrate [options]

Consent-gated voice-DNA calibration (roadmap #5): propose, display, apply, or rollback
a structured calibration of the four voice axes (drama_dial, archetype_emphasis,
hook_preferences, cadence_preferences) in brand.json. HUMAN-ONLY path — never auto-applied.

  --brand <id>             brand to calibrate.
  --show                   display the pending calibration card (default).
  --apply --consent        apply the pending proposal (requires explicit --consent).
  --rollback               rollback the most recent voice calibration.
  --to-baseline <ref>      rollback to a specific instance-repo commit ref.
  --json                   emit the structured result.
  -h, --help               show this help.

Governance: voice calibration is HUMAN-ONLY (EHUMANONLY for machine-apply paths).
Explicit --consent is required for --apply (ECONSENTREQUIRED without it).
Gate axes are never touched (ENEVERLOOSEN on any smuggled gate transition).`;

/**
 * @param {object} ctx  { flags, positionals, env, config }
 * @returns {Promise<{ ok, summary, detail?, data?, exitCode? }>}
 */
async function run(ctx = {}) {
  const flags = ctx.flags || {};
  if (util.flagOn(flags.help)) return { ok: true, summary: HELP.split('\n')[0], detail: HELP };

  const env = ctx.env || process.env;
  const config = ctx.config || util.loadSystemConfig(env);

  const brand = typeof flags.brand === 'string' && flags.brand.trim() ? flags.brand.trim() : null;

  // --- Arg validation (exit 2 for bad args, BEFORE touching any module) ---

  // --brand is required.
  if (!brand) {
    return {
      ok: false,
      exitCode: 2,
      summary: 'bad args: --brand <id> is required for voice-calibrate',
      detail: ['Usage: engine voice-calibrate --brand <id> [--show | --apply --consent | --rollback]', HELP],
    };
  }

  // Mutually-exclusive flags: --show and --apply cannot both be set.
  if (util.flagOn(flags.show) && util.flagOn(flags.apply)) {
    return {
      ok: false,
      exitCode: 2,
      summary: 'bad args: --show and --apply are mutually exclusive',
      detail: ['Use --show to display the pending card, or --apply --consent to apply it — not both.'],
    };
  }

  // --rollback requires a resolvable ref when --to-baseline is given (a bare --to-baseline=true is not a ref).
  // Additionally, --rollback without the apply module available will surface later, but a
  // `--rollback --to-baseline` with a boolean value (no string ref) is a usage error, not a module error.
  if (util.flagOn(flags.rollback)) {
    const toBaseline = flags['to-baseline'];
    // If --to-baseline was given but has no string value (boolean true => no ref supplied).
    if (toBaseline !== undefined && !(typeof toBaseline === 'string' && toBaseline.trim() && toBaseline !== 'true')) {
      if (util.flagOn(toBaseline)) {
        return {
          ok: false,
          exitCode: 2,
          summary: 'bad args: --rollback --to-baseline requires a commit ref',
          detail: ['Usage: engine voice-calibrate --brand <id> --rollback --to-baseline <ref>'],
        };
      }
    }
  }

  // Try to load the voice-calibration modules (may not exist yet in Stage 3).
  let proposeMod, displayMod, applyMod;
  try { proposeMod = require('../voice-calibration/propose'); } catch { proposeMod = null; }
  try { displayMod = require('../voice-calibration/display'); } catch { displayMod = null; }
  try { applyMod = require('../voice-calibration/apply'); } catch { applyMod = null; }

  if (!proposeMod && !displayMod && !applyMod) {
    return {
      ok: true,
      summary: 'voice-calibrate: voice-calibration modules not yet available (Stage 4). Verb registered and wired.',
      detail: [
        'The voice-calibration sub-modules (engine/voice-calibration/propose.js, display.js, apply.js)',
        'are built in a later stage. This verb is registered and the CLI wiring is verified.',
        'To use voice calibration: first run `engine competitor-scan --brand <id>` to generate a scan report.',
      ],
      data: { available: false, brand, stage: 'wiring-only' },
    };
  }

  const doApply = util.flagOn(flags.apply);
  const doRollback = util.flagOn(flags.rollback);
  const consent = util.flagOn(flags.consent);

  if (doApply && !consent) {
    return {
      ok: false,
      exitCode: 1,
      summary: 'voice-calibrate --apply requires explicit --consent (ECONSENTREQUIRED)',
      detail: 'Voice calibration is a human-only operation. Pass --consent to apply explicitly.',
    };
  }

  // Route to the appropriate sub-action.
  if (doRollback) {
    if (!applyMod || typeof applyMod.rollbackVoiceCalibration !== 'function') {
      return { ok: false, exitCode: 1, summary: 'rollback not available (apply module not loaded)', detail: null };
    }
    try {
      const ref = typeof flags['to-baseline'] === 'string' ? flags['to-baseline'] : null;
      const result = await applyMod.rollbackVoiceCalibration(ref, { env, brand });
      return {
        ok: result.ok !== false,
        summary: result.summary || `voice calibration rollback ${result.ok !== false ? 'succeeded' : 'failed'}`,
        detail: result.detail || null,
        data: result,
      };
    } catch (err) {
      return { ok: false, exitCode: 1, summary: 'rollback failed', detail: util.describeError(err) };
    }
  }

  if (doApply) {
    if (!applyMod || typeof applyMod.applyVoiceCalibration !== 'function') {
      return { ok: false, exitCode: 1, summary: 'apply not available (apply module not loaded)', detail: null };
    }
    // Load the pending proposal from the learning proposed dir.
    try {
      // The apply module handles loading the pending proposal.
      const result = await applyMod.applyVoiceCalibration(null, { consent: true, env, brand, now: Date.now() });
      return {
        ok: result.ok !== false,
        summary: result.summary || `voice calibration apply ${result.ok !== false ? 'succeeded' : 'failed'}`,
        detail: result.detail || null,
        data: result,
      };
    } catch (err) {
      if (err && err.code === 'ECONSENTREQUIRED') {
        return { ok: false, exitCode: 1, summary: 'consent required (ECONSENTREQUIRED)', detail: err.message };
      }
      if (err && err.code === 'ENEVERLOOSEN') {
        return { ok: false, exitCode: 1, summary: 'refused: would loosen a gate (ENEVERLOOSEN)', detail: err.message };
      }
      if (err && err.code === 'EHUMANONLY') {
        return { ok: false, exitCode: 1, summary: 'refused: human-only target (EHUMANONLY)', detail: err.message };
      }
      return { ok: false, exitCode: 1, summary: 'apply failed', detail: util.describeError(err) };
    }
  }

  // Default: --show (display the calibration card).
  if (displayMod && typeof displayMod.displayCalibrationCard === 'function') {
    // Load the most recent proposed record (delegated to display module).
    try {
      const card = displayMod.displayCalibrationCard(null, env);
      return {
        ok: true,
        summary: 'voice calibration card:',
        detail: card && card.cliPrompt ? card.cliPrompt.split('\n') : ['(no pending proposal)'],
        data: card,
      };
    } catch (err) {
      return { ok: false, exitCode: 1, summary: 'display failed', detail: util.describeError(err) };
    }
  }

  return {
    ok: true,
    summary: 'voice-calibrate: no pending proposal found (run `engine competitor-scan` first).',
    detail: null,
    data: { brand },
  };
}

module.exports = { run, HELP };
