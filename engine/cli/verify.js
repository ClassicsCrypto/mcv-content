'use strict';

/**
 * engine/cli/verify.js  [N net-new]
 *
 * `engine verify [--checkpoint C0..C4]` — run the deterministic setup checkpoint verifier(s)
 * (release-spec §2.2–§2.6 C0–C4; §2.1 resumable setup; model §12 setup row "halt with named
 * failed step + remediation"). THE C0–C4 gate.
 *
 * This handler is a THIN wiring layer over engine/setup.verifyCheckpoint (already on disk):
 *   - with `--checkpoint c2`, runs exactly that verifier and records its outcome into
 *     setup-state.json (so the resumable flow knows what passed — §2.1);
 *   - with no checkpoint flag, walks the ladder from the first incomplete checkpoint forward,
 *     stopping at the first FAIL (a failed checkpoint halts the ladder with its named remediation,
 *     model §12) — the "where am I in setup, what's next" surface;
 *   - the verifiers are DETERMINISTIC and zero-key (no live API calls — §16.5); a missing/blank
 *     required credential is a permanent FAIL naming the variable, never the value (§15.1).
 *
 * Recording the outcome is the verify verb's job (the verifiers are pure read-only checks);
 * setCheckpoint() is the durable record the resumable setup + `engine status` lifecycle read.
 * C3 is special: its verifier evaluates a RECORDED calibration result — `engine calibrate` writes
 * that result; `verify --checkpoint c3` only grades it (it never spends — §2.5).
 *
 * Tier-3 cleanliness (§0.3 r6): no hardcoded IDs/paths/codenames; reviewer/channel ids come from
 * operator config, read by the verifiers.
 */

const setup = require('../setup');
const util = require('./util');

const HELP = `engine verify [--checkpoint C0..C4]

Run the deterministic setup checkpoint verifier(s) — the C0–C4 gate (§2.2–§2.6). Each check
returns pass/fail/skip with a named remediation; a fail halts with the step to fix (§12). Outcomes
are recorded into setup-state.json to drive the resumable flow (§2.1).

  --checkpoint <C0..C4>   verify exactly one checkpoint (alias: --setup, accepts c0..c4 or 0..4).
                          Omit to walk from the first incomplete checkpoint, stopping at the first
                          failure.
  --json                  emit the structured verifier result(s).
  -h, --help              show this help.

Verifiers are zero-key: no live API calls. C3 grades the RECORDED calibration result; run
"engine calibrate" first to produce it (§2.5).`;

/** Run one checkpoint, record its outcome, and shape a verb result. */
function runOne(id, env) {
  const result = setup.verifyCheckpoint(id, { env });
  // Record the pass/fail into setup-state (the durable resumable record — §2.1). Best-effort:
  // when CONTENT_HOME is unset (e.g. a bare C0 fit-check), there is no state file to write — skip.
  try {
    setup.setCheckpoint(result.checkpoint, result.passed, {
      detail: summarizeChecks(result),
      env,
    });
  } catch { /* CONTENT_HOME unset / not yet initialized — C0 is CONTENT_HOME-free */ }
  return result;
}

/** A tiny, instance-data-free summary of the checks for setup-state.detail (§5.4 keep-it-small). */
function summarizeChecks(result) {
  return {
    passed: result.passed,
    checks: (result.checks || []).map((c) => ({ name: c.name, status: c.status })),
  };
}

/** Format one checkpoint result into human detail lines. */
function detailFor(result) {
  const lines = [`${result.checkpoint}: ${result.passed ? 'PASS' : 'FAIL'} (project_state → ${result.project_state})`];
  for (const c of result.checks || []) {
    const tag = c.status === 'pass' ? '✓' : c.status === 'skip' ? '~' : '✗';
    lines.push(`  ${tag} ${c.name}: ${c.detail || c.status}`);
    if (c.status === 'fail' && c.remediation) lines.push(`      → ${c.remediation}`);
  }
  return lines;
}

/**
 * @param {object} ctx  { flags, positionals, env }
 * @returns {{ ok, summary, detail?, data?, exitCode? }}
 */
function run(ctx = {}) {
  const flags = ctx.flags || {};
  if (util.flagOn(flags.help)) return { ok: true, summary: HELP.split('\n')[0], detail: HELP };

  const env = ctx.env || process.env;
  const cpFlag = flags.checkpoint != null ? flags.checkpoint : (flags.setup != null ? flags.setup : ctx.positionals && ctx.positionals[0]);

  // Single-checkpoint mode.
  if (cpFlag != null && cpFlag !== true) {
    let result;
    try {
      result = runOne(cpFlag, env);
    } catch (err) {
      return { ok: false, exitCode: 2, summary: 'verify failed', detail: util.describeError(err) };
    }
    return {
      ok: result.passed,
      exitCode: result.passed ? 0 : 1,
      summary: `${result.checkpoint} ${result.passed ? 'passed' : 'FAILED'}${result.passed ? '' : ` — ${result.remediation || 'see checks'}`}`,
      detail: detailFor(result),
      data: result,
    };
  }

  // Ladder mode: from the first incomplete checkpoint forward, stop at the first failure.
  let start;
  try {
    start = setup.firstIncompleteCheckpoint(env);
  } catch {
    start = setup.CHECKPOINTS[0]; // CONTENT_HOME-resident state unreadable → begin at C0
  }
  const order = setup.CHECKPOINTS;
  const from = start ? order.indexOf(start) : order.length;
  if (from === -1 || from >= order.length) {
    return { ok: true, summary: 'all checkpoints (C0–C4) already passed — project is operational', data: { all_passed: true } };
  }

  const results = [];
  let allOk = true;
  for (let i = from; i < order.length; i++) {
    let result;
    try {
      result = runOne(order[i], env);
    } catch (err) {
      return { ok: false, exitCode: 2, summary: `verify ${order[i]} failed`, detail: util.describeError(err) };
    }
    results.push(result);
    if (!result.passed) { allOk = false; break; }
  }

  const last = results[results.length - 1];
  return {
    ok: allOk,
    exitCode: allOk ? 0 : 1,
    summary: allOk
      ? `verified ${results.map((r) => r.checkpoint).join(', ')} — resume point clear`
      : `${last.checkpoint} FAILED — ${last.remediation || 'see checks'} (halted; fix and re-run)`,
    detail: results.flatMap(detailFor),
    data: { results, all_passed: allOk },
  };
}

module.exports = { run, HELP };
