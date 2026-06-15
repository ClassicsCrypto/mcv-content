'use strict';

/**
 * engine/cli/evaluate-contribution.js  [N net-new]  — batch IS-CLI
 *
 * `engine evaluate-contribution <file>` — the thin CLI surface over the MAINTAINER-SIDE evaluation
 * harness, the RECEIVING half of DD-7(b) improvement sharing (release-spec.md roadmap #4; original-
 * design-spec §2.6 Improvement Sharing; decisions.md DD-7 "(b) — ... MAINTAINER EVALUATION HARNESS on
 * the receiving side"; design-review risk #7 supply-chain poisoning of an open upstream). Per DD-1(c)
 * the CLI is the thin runner: this file owns ONLY arg parsing + reading the inbound file + wiring + the
 * result envelope; every decision lives in engine/improvement-sharing/evaluate.js (it wires, never
 * re-implements), which itself REUSES the DD-6 structural refusals (engine/self-improve/mutability.js
 * assertMachineChangeAllowed / assertNotGateLoosening) and the §16.3 gate-regression runner.
 *
 * WHAT IT DOES: given an INBOUND sanitized abstract rule-diff contribution (a JSON file an operator
 * received via a manual PR), run the four-check harness and print an ACCEPT/REJECT verdict with the
 * per-check reasons:
 *   (a) shape + NO instance specifics  — the inbound mirror of the outbound shareability guard;
 *   (b) applies cleanly                — the diff resolves against a target without contradiction;
 *   (c) passes gate-regression         — the §16.3 byte-stable-code suite is green (zero-key runner);
 *   (d) never-loosen + machine-allowed — EHUMANONLY (human-only target) / ENEVERLOOSEN (gate-loosener).
 *
 * NEVER AUTO-MERGE (DD-7 (4)): the verdict is advisory. An ACCEPT means "passed the mechanical safety
 * bar, a maintainer MAY now review it" — it is NOT a merge. This verb performs no git op, no write, no
 * network; assimilation is a separate, human, out-of-band act. The harness has no apply path by
 * construction, and this CLI adds none.
 *
 * HONEST EXIT CODES (mirrors bin/engine.js §): 0 when the contribution is ACCEPTED (admissible for
 * manual review). 1 when it is REJECTED — a refused-by-design rejection (would-loosen, human-only,
 * unshareable, does-not-apply, gate-regression red) is a real "do not merge this" signal the operator
 * needs reflected in the exit code (it is reported, never bypassed). 2 for a usage error (missing/bad
 * file argument, unreadable/unparseable JSON).
 *
 * RD-2 / RD-12: deterministic, zero-key. The harness never calls a chain LLM; the only thing that
 * touches disk is the gate-regression runner, which is itself zero-key + side-effect-free.
 *
 * Tier-3 cleanliness (§0.3 r6 / RD-3): constructs no instance paths, hardcodes no ids/handles/roots/
 * codenames/brand strings; the only literals are public flag/field names + the §4.5 vocabulary.
 */

const fs = require('fs');

const evaluateMod = require('../improvement-sharing/evaluate');
const util = require('./util');

const EVAL_HELP = `engine evaluate-contribution <file> [options]

Evaluate an INBOUND sanitized improvement contribution (a JSON file received via a manual upstream
pull request) with the maintainer-side harness (DD-7(b) / §2.6; design-review risk #7). Prints an
ACCEPT/REJECT verdict and the per-check reasons. NEVER auto-merges — an ACCEPT means "admissible for
manual review", not a merge (DD-7 (4)); this verb performs no git op, no write, no network.

  <file>                 path to the inbound contribution JSON (positional, required).
  --private-term <term>  a maintainer private term to REFUSE if it appears in the payload (repeatable).
  --brand-term <term>    a brand-name anti-target to REFUSE if it appears (repeatable; DD-7 (2)).
  --skip-gate-regression test-only: skip the §16.3 suite (recorded on the verdict, never silent).
  --json                 emit the structured verdict.
  -h, --help             show this help.

The four checks (ALL must pass; the verdict reports EVERY failure, not just the first):
  shape/shareable  parses as an abstract rule-diff carrying NO instance/brand specifics;
  applies          the diff resolves against a target without contradiction;
  gate-regression  the shipped rule behavior is unbroken (§16.3 byte-stable codes);
  mutability       targets a machine-allowed surface (not EHUMANONLY) AND loosens no gate (not
                   ENEVERLOOSEN — release-spec §3.1 never-loosen). A human-only or gate-loosening
                   contribution is REJECTED; an upstream never assimilates such a PR blindly.`;

/**
 * @param {object} ctx  { flags, positionals, env, contribution? }
 *   - contribution  injected inbound contribution object (zero-key tests pass one directly, bypassing
 *                   disk). When absent, the first positional is read as a JSON file path.
 *   - opts seams    flags map onto the harness's test seams (gateRegression injection happens only via
 *                   a direct evaluateContribution call in tests; the CLI exposes --skip-gate-regression).
 * @returns {{ ok, summary, detail?, data?, exitCode? }}
 */
function run(ctx = {}) {
  const flags = ctx.flags || {};
  if (util.flagOn(flags.help)) return { ok: true, summary: EVAL_HELP.split('\n')[0], detail: EVAL_HELP };

  const positionals = Array.isArray(ctx.positionals) ? ctx.positionals : [];

  // Resolve the inbound contribution (injected for tests, else read from the positional file path).
  let contribution = ctx.contribution;
  let sourceLabel = '(injected)';
  if (contribution === undefined) {
    const file = positionals[0];
    if (!file || typeof file !== 'string') {
      return {
        ok: false,
        exitCode: 2,
        summary: 'evaluate-contribution: a <file> argument is required (the inbound contribution JSON)',
        detail: ['Usage: engine evaluate-contribution <file> [--private-term <t>] [--brand-term <t>]'],
      };
    }
    const read = readContributionFile(file);
    if (!read.ok) {
      return { ok: false, exitCode: 2, summary: `evaluate-contribution: ${read.reason}`, detail: read.detail };
    }
    contribution = read.contribution;
    sourceLabel = file;
  }

  // Map the repeatable deny-list flags into the harness options (the inbound mirror of the operator's
  // configured private_terms / brand denylist). A single --flag value yields a string; the parser does
  // not coalesce repeats, so we accept either a string or an array defensively.
  const opts = {
    privateTerms: asTermList(flags['private-term']),
    brandTerms: asTermList(flags['brand-term']),
    skipGateRegression: util.flagOn(flags['skip-gate-regression']),
  };

  let verdict;
  try {
    verdict = evaluateMod.evaluateContribution(contribution, opts);
  } catch (err) {
    return {
      ok: false,
      exitCode: 1,
      summary: 'evaluate-contribution: the harness errored while evaluating',
      detail: [util.describeError(err)],
    };
  }

  return summarize(verdict, { sourceLabel, opts });
}

/** Read + parse an inbound contribution JSON file. Returns { ok, contribution? , reason?, detail? }. */
function readContributionFile(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return { ok: false, reason: `cannot read contribution file "${file}"`, detail: [(err && err.message) || String(err)] };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, reason: `contribution file "${file}" is not valid JSON`, detail: [(err && err.message) || String(err)] };
  }
  return { ok: true, contribution: parsed };
}

/** Coerce a repeatable --term flag (string | string[] | undefined) into a trimmed, non-empty list. */
function asTermList(value) {
  const arr = Array.isArray(value) ? value : (value == null ? [] : [value]);
  return arr.map((v) => String(v == null ? '' : v).trim()).filter(Boolean);
}

/** Build the final result envelope from the harness verdict. */
function summarize(verdict, { sourceLabel, opts }) {
  const checks = verdict.checks || {};
  const accepted = verdict.accepted === true;

  // Per-check status lines (✓/✗), then every reason the harness produced (REJECT lists ALL failures).
  const checkLine = (label, c) => {
    const skipped = c && c.skipped ? ' (skipped)' : '';
    return `  ${c && c.ok ? '✓' : '✗'} ${label}${skipped}`;
  };
  const detail = [
    `source: ${sourceLabel}`,
    `auto_merge: ${verdict.auto_merge === false ? 'false (NEVER — DD-7 (4); a maintainer reviews after this)' : String(verdict.auto_merge)}`,
    checkLine('shape + no instance specifics', checks.shareable),
    checkLine('applies cleanly', checks.applies),
    checkLine('gate-regression', checks.gate_regression),
    checkLine('mutability (machine-allowed + never-loosen)', checks.mutability),
    ...(verdict.reasons || []).map((r) => `  · ${r}`),
    accepted
      ? 'ACCEPTED is NOT a merge — it means the contribution cleared the mechanical safety bar and a '
        + 'maintainer may now review it for merit (DD-7 (4)).'
      : 'REJECTED — do NOT merge this contribution. It is never auto-merged (DD-7 (4)).',
  ];
  if (opts.skipGateRegression) detail.push('NOTE: gate-regression was SKIPPED by --skip-gate-regression (test-only; the verdict records the skip).');

  return {
    ok: accepted,
    exitCode: accepted ? 0 : 1,
    summary: accepted
      ? 'evaluate-contribution: ACCEPTED — passed the mechanical safety bar (admissible for manual review; NOT a merge)'
      : 'evaluate-contribution: REJECTED — see reasons (never auto-merged)',
    detail,
    data: verdict,
  };
}

module.exports = {
  run,
  EVAL_HELP,
  // internals for the smoke test
  readContributionFile,
  asTermList,
  summarize,
};
