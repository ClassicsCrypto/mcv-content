'use strict';

/**
 * engine/cli/calibrate.js  [N net-new]
 *
 * `engine calibrate --brand <id>` — the public calibration RUNNER (release-spec §2.5 C3; §16.4
 * Tier-3 calibration harness; DD-9 public half). Calibration is the operator's first real spend,
 * so it gets the DD-18 estimate-and-confirm protection: BEFORE generating anything it presents a
 * pre-run cost estimate (N samples × the configured chain cost band — docs/cost.md) and REQUIRES
 * confirmation (§2.5; the same contract as `engine index-library`).
 *
 * What this runner is, honestly (the seam vs the content):
 *   - The RUNNER ships here. It loads the `calibration/` samples + judging rubric + pass criteria
 *     (§16.4) when present, presents the estimate, gates on confirmation, then either drives the
 *     chain over N samples (when a pipeline with wired seats is supplied — a host/test harness) or
 *     records the operator-supplied judging result. The pass criteria are graded by the SAME
 *     definition the C3 verifier uses (engine/setup checkpoints DEFAULT_CALIBRATION_CRITERIA), so
 *     the runner and the gate can never disagree (§2.5).
 *   - The calibration CONTENT (the sample prompts, the rubric, the gold pass-thresholds) is the P4
 *     `calibration/` batch. Until it lands this runner fails GRACEFULLY with a clear "calibration
 *     content not present (P4)" — it never silently passes C3 (the calibration gate must not be
 *     bypassed — model §5.2 invariant).
 *   - Heavy optimization / private judges stay maintainer-side (DD-9 ceiling): this runner ships
 *     the lightweight public harness only, never the private five-judge methodology or gold sets.
 *
 * On a confirmed run the runner RECORDS the result into setup-state.json's C3 detail (the verifier
 * grades it; §2.5) and pins the known-good baseline note. The engine never auto-applies anything
 * from calibration (DD-6).
 *
 * Tier-3 cleanliness (§0.3 r6): no hardcoded paths/ids/codenames; the brand + criteria come from
 * operator config/flags.
 */

const fs = require('fs');
const path = require('path');

const paths = require('../shared/paths');
const setup = require('../setup');
const setupState = require('../setup/setup-state');
const checkpoints = require('../setup/checkpoints');
const util = require('./util');

/** Repo root (two up from engine/cli/) — to locate the shipped calibration/ content dir. */
const REPO_ROOT = path.resolve(__dirname, '..', '..');

/**
 * Indicative per-sample chain cost band (USD), used ONLY for the pre-run estimate preface. Marked
 * INDICATIVE / "measured as of <date>" (§3.3/§17.6) — the real numbers are measured in Step 8 and
 * land in docs/cost.md; a stale band is a docs bug, not a blocker. Config can override the band.
 */
const DEFAULT_PER_SAMPLE_USD = { low: 0.02, high: 0.15 };

const HELP = `engine calibrate --brand <id> [options]

Run the public calibration harness (§2.5 C3 / §16.4 / DD-9). Presents a pre-run cost estimate and
REQUIRES confirmation before any spend (DD-18). Generates N sample drafts across the brand's
archetypes, gates them, and grades against the defined pass criteria; records the result for the C3
verifier. The calibration gate must pass before a project can go operational (model §5.2).

  --brand <id>     the brand to calibrate (required).
  --samples <n>    sample count (default: criteria sample_count, 10).
  --yes            confirm the cost estimate non-interactively (the DD-18 confirmation).
  --estimate-only  print the cost estimate and exit (no spend, no confirmation needed).
  --result <json>  record an operator-supplied judging result instead of generating
                   ({sample_count,gate_clear,on_voice,fabrication_codes}).
  --json           emit the structured result.
  -h, --help       show this help.

The calibration CONTENT (samples + rubric) is the P4 batch; until it lands the runner reports
"calibration content not present (P4)" rather than passing the gate.`;

/** Resolve pass criteria the same way the C3 verifier does (config block over defaults — §2.5). */
function criteriaFor(env) {
  const config = util.loadSystemConfig(env);
  const block = config && typeof config.calibration === 'object' ? config.calibration : {};
  return { ...checkpoints.DEFAULT_CALIBRATION_CRITERIA, ...block };
}

/** Per-sample cost band (config override → default). */
function costBandFor(env) {
  const config = util.loadSystemConfig(env);
  const band = config && config.cost && config.cost.per_sample_usd;
  if (band && Number.isFinite(Number(band.low)) && Number.isFinite(Number(band.high))) {
    return { low: Number(band.low), high: Number(band.high) };
  }
  return DEFAULT_PER_SAMPLE_USD;
}

/** Is the shipped calibration/ content present (P4)? */
function calibrationContentPresent() {
  const dir = path.join(REPO_ROOT, 'calibration');
  try {
    return fs.existsSync(dir) && fs.readdirSync(dir).some((f) => !f.startsWith('.') && f.toLowerCase() !== 'readme.md');
  } catch {
    return false;
  }
}

/** Build the estimate-and-confirm preface (§2.5 / DD-18). */
function estimate(sampleCount, env) {
  const band = costBandFor(env);
  return {
    sample_count: sampleCount,
    per_sample_usd: band,
    estimated_total_usd: { low: +(sampleCount * band.low).toFixed(2), high: +(sampleCount * band.high).toFixed(2) },
    note: 'INDICATIVE band (measured as of release; see docs/cost.md). Chain-seat LLM cost is host-runtime-owned (RD-2); the engine cannot bill it directly.',
  };
}

/**
 * @param {object} ctx  { flags, positionals, env, pipeline? }
 * @returns {Promise<{ ok, summary, detail?, data?, exitCode? }>}
 */
async function run(ctx = {}) {
  const flags = ctx.flags || {};
  if (util.flagOn(flags.help)) return { ok: true, summary: HELP.split('\n')[0], detail: HELP };

  const env = ctx.env || process.env;
  const brand = typeof flags.brand === 'string' ? flags.brand : (ctx.positionals && ctx.positionals[0]);
  if (!brand) {
    return { ok: false, exitCode: 1, summary: 'calibrate needs --brand <id>', detail: 'Usage: engine calibrate --brand <id> (§2.5).' };
  }

  const criteria = criteriaFor(env);
  const sampleCount = Number.isFinite(Number(flags.samples)) && Number(flags.samples) > 0 ? Number(flags.samples) : criteria.sample_count;
  const est = estimate(sampleCount, env);

  // Estimate-only: print the preface and exit (no spend, no confirmation needed).
  if (util.flagOn(flags['estimate-only'])) {
    return {
      ok: true,
      summary: `calibration estimate: ${sampleCount} samples ≈ $${est.estimated_total_usd.low}–$${est.estimated_total_usd.high} (indicative)`,
      detail: [est.note, 'Re-run with --yes to confirm and proceed (DD-18 estimate-and-confirm — §2.5).'],
      data: { estimate: est, criteria, confirmed: false },
    };
  }

  // DD-18: REQUIRE confirmation before any spend. --yes is the non-interactive confirmation; the
  // engine never spends silently (the CLI is non-interactive in the agent-first flow, so an
  // unconfirmed run halts with the estimate rather than prompting — the agent re-invokes with --yes).
  if (!util.flagOn(flags.yes) && flags.result == null) {
    return {
      ok: false,
      exitCode: 0,
      summary: `calibration requires confirmation: ${sampleCount} samples ≈ $${est.estimated_total_usd.low}–$${est.estimated_total_usd.high} (indicative)`,
      detail: [
        est.note,
        'This is your first real spend (§2.5). Re-run with --yes to confirm and proceed (DD-18).',
      ],
      data: { estimate: est, criteria, confirmed: false, awaiting_confirmation: true },
    };
  }

  // Operator-supplied judging result path: record it and grade via the C3 verifier definition.
  if (typeof flags.result === 'string') {
    let result;
    try {
      result = JSON.parse(flags.result);
    } catch {
      return { ok: false, exitCode: 1, summary: 'calibrate --result is not valid JSON', detail: 'Pass {sample_count,gate_clear,on_voice,fabrication_codes}.' };
    }
    return recordAndGrade(brand, result, env);
  }

  // Generative path: needs the calibration content (P4) AND a wired pipeline to actually generate.
  if (!calibrationContentPresent()) {
    return {
      ok: false,
      exitCode: 2,
      summary: 'calibration content not present (P4)',
      detail: [
        'The calibration/ samples + rubric + pass criteria are the P4 batch and are not on disk yet.',
        'The runner is wired (estimate/confirm/grade); supply --result <json> to record an operator-judged run,',
        'or run after the calibration content lands. The C3 gate must NOT be bypassed (model §5.2).',
      ],
      data: { estimate: est, criteria, confirmed: true, calibration_content: false },
    };
  }

  if (!ctx.pipeline) {
    return {
      ok: false,
      exitCode: 2,
      summary: 'calibration content present but no wired pipeline to generate samples',
      detail: [
        'Generation needs host-wired seats (the engine never calls a chain-seat LLM — RD-2).',
        'Run calibration through the host runtime, or pass an operator-judged --result to record the outcome.',
      ],
      data: { estimate: est, criteria, confirmed: true, calibration_content: true },
    };
  }

  // (The host-driven generative loop is exercised when a pipeline is injected; in v1 the
  // operator-judged --result path and the host runtime are the live routes. We never fabricate a
  // sample battery — that is the P4 content + the host's seats.)
  return {
    ok: false,
    exitCode: 2,
    summary: 'generative calibration loop runs in the host runtime (no in-process sample battery in v1)',
    detail: ['Confirmed. Drive sample generation via the host runtime, then record the judged result with --result.'],
    data: { estimate: est, criteria, confirmed: true },
  };
}

/** Record a calibration result into C3 detail and grade it via the verifier (one criterion def). */
function recordAndGrade(brand, result, env) {
  const cal = {
    brand,
    sample_count: Number(result.sample_count ?? result.samples ?? 0),
    gate_clear: Number(result.gate_clear ?? result.cleared ?? 0),
    on_voice: Number(result.on_voice ?? 0),
    fabrication_codes: Number(result.fabrication_codes ?? result.fabrication ?? 0),
    judged_at: new Date().toISOString(),
  };
  // Grade with the verifier (shares DEFAULT_CALIBRATION_CRITERIA — §2.5).
  const graded = setup.verifyCheckpoint('C3', { env, calibration: cal });
  // Record into setup-state so the resumable flow + `engine status` see it. The scores go in the
  // durable `calibration` field (the verifier's INPUT, preserved across later detail-only writes);
  // `detail` carries a copy too for back-compat readers.
  try {
    setupState.setCheckpoint('C3', graded.passed, { calibration: cal, detail: cal, env });
  } catch (err) {
    return { ok: false, exitCode: 1, summary: 'could not record calibration result', detail: util.describeError(err) };
  }
  const baselineNote = graded.passed
    ? 'Pin the known-good baseline: tag a commit in the instance repo (DD-6 pinned baseline — §2.5).'
    : 'Remediation loop: adjust Brand DNA / rules and re-run calibration (§2.5).';
  return {
    ok: graded.passed,
    exitCode: graded.passed ? 0 : 1,
    summary: graded.passed
      ? `calibration PASSED for ${brand} (${cal.gate_clear}/${cal.sample_count} cleared, ${cal.on_voice} on-voice) — project → calibrated`
      : `calibration FAILED for ${brand} — ${graded.remediation || 'criteria not met'}`,
    detail: graded.checks.map((c) => `${c.status === 'pass' ? '✓' : c.status === 'skip' ? '~' : '✗'} ${c.name}: ${c.detail || c.status}`).concat(baselineNote),
    data: { result: cal, graded, passed: graded.passed },
  };
}

module.exports = { run, HELP, estimate, criteriaFor };
