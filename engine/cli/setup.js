'use strict';

/**
 * engine/cli/setup.js  [N net-new]
 *
 * `engine setup` — the GUIDED, STRICT, RESUMABLE setup driver: the single front door that replaces
 * "read a wall of docs, run commands by hand, guess what's next" with "here is exactly where you are,
 * here is the ONE next thing, I won't let you skip ahead" (release-spec §2.1 resumable setup; §2.8
 * quick-start; model §12 named-step remediation).
 *
 * This is a THIN renderer over engine/setup/flow.computeFrame (the brain). It does not decide the
 * step or re-implement any verifier — it asks the flow engine for the current FRAME and renders it:
 *   - default: a human-readable "changing menu" (progress strip → this step → what's left → the
 *     numbered next actions with their literal commands);
 *   - `--json`: the raw frame object, which is the PUBLISHED CONTRACT
 *     (schemas/artifacts/setup-frame.schema.json) a host-runtime adapter (e.g. a Discord component
 *     renderer) consumes to draw buttons. Same brain, two surfaces — the engine owns no Discord
 *     connection or token (the connector is host-runtime-owned).
 *
 * Re-run it after each step: computeFrame re-verifies from the resume point and records each pass, so
 * `engine setup` self-advances. It is informational/advancing, not a gate — it exits 0 whether or not
 * setup is complete (use `engine verify` for the pass/fail exit-code gate). `--no-record` makes it a
 * pure read-only preview (no setup-state mutation).
 *
 * Tier-3 cleanliness (§0.3 r6): no hardcoded ids/paths/codenames — every operator value is a
 * <PLACEHOLDER> the operator fills.
 */

const util = require('./util');
const flow = require('../setup/flow');

const HELP = `engine setup

The guided, strict, resumable setup driver — the single front door from a clean clone to an
operational engine (§2.1). Shows where you are in the C0–C4 ladder, the ONE next thing to do with
its exact command, and won't surface a later step until the current one verifies. Re-run after each
step; it re-checks from where you are and moves you on automatically.

  --json        emit the raw frame (the contract a host-runtime/Discord adapter renders as buttons).
  --no-record   read-only preview: compute the frame without recording verifier outcomes.
  -h, --help    show this help.

This command never spends and never posts. Steps that DO cost money (calibration, indexing) are
shown as metered actions you confirm yourself — the engine never auto-spends behind this command.`;

const STATUS_GLYPH = { done: '✓', active: '▶', locked: '·' };
const ACTION_TAG = { run: 'run', input: 'edit', verify: 'check', choice: 'pick', finish: 'done', link: 'open' };

/** The whole-ladder progress strip. */
function renderProgress(progress) {
  const lines = [];
  for (const cp of progress.checkpoints) {
    const glyph = STATUS_GLYPH[cp.status] || '·';
    const here = cp.status === 'active' ? '   ← you are here' : '';
    lines.push(`  ${glyph} ${cp.id}  ${cp.label}${here}`);
  }
  return lines;
}

/** Render one action (and, for a choice, its options) into indented lines. */
function renderAction(action, n) {
  const tag = ACTION_TAG[action.type] || action.type;
  const lines = [`  ${n}. [${tag}] ${action.label}${action.spends ? '  ($ costs money — you confirm first)' : ''}`];
  if (action.help) lines.push(`        ${action.help}`);
  if (action.command) lines.push(`        $ ${action.command}`);
  if (Array.isArray(action.options)) {
    for (const opt of action.options) {
      lines.push(`         • ${opt.label}${opt.spends ? '  ($)' : ''}`);
      if (opt.help) lines.push(`           ${opt.help}`);
      if (opt.command) lines.push(`           $ ${opt.command}`);
    }
  }
  return lines;
}

/** Render the full frame into an array of human lines (the dispatcher indents them under the summary). */
function renderFrame(frame) {
  const lines = [];
  lines.push('open-content-engine — guided setup');
  lines.push('──────────────────────────────────');
  lines.push(...renderProgress(frame.progress));
  lines.push('');

  // Advancement note: which checkpoints just confirmed-passing in this run.
  if (Array.isArray(frame.just_passed) && frame.just_passed.length) {
    lines.push(`✓ Just confirmed: ${frame.just_passed.join(', ')}`);
    lines.push('');
  }

  // The current step header.
  const header = frame.done ? frame.title : `${frame.generated_for} · ${frame.title}`;
  lines.push(header);
  if (frame.headline) lines.push(frame.headline);
  lines.push('');
  for (const b of frame.body || []) lines.push(b);

  // What's still needed (the verifier's failing checks).
  if (Array.isArray(frame.todo) && frame.todo.length) {
    lines.push('');
    lines.push('Still needed:');
    for (const t of frame.todo) {
      lines.push(`  ✗ ${t.name} — ${t.detail || ''}`);
      if (t.remediation) lines.push(`      → ${t.remediation}`);
    }
  }

  // What's already satisfied (so the operator sees momentum).
  if (Array.isArray(frame.satisfied) && frame.satisfied.length) {
    lines.push('');
    lines.push('Already done:');
    for (const s of frame.satisfied) lines.push(`  ✓ ${s.name}${s.detail ? ` — ${s.detail}` : ''}`);
  }

  // The numbered next actions.
  if (Array.isArray(frame.actions) && frame.actions.length) {
    lines.push('');
    lines.push(frame.done ? 'From here:' : 'Do this next:');
    frame.actions.forEach((a, i) => lines.push(...renderAction(a, i + 1)));
  }

  if (frame.note) {
    lines.push('');
    lines.push(`Note: ${frame.note}`);
  }

  lines.push('');
  if (frame.next_command) lines.push(`→ Next: ${frame.next_command}`);
  if (!frame.done) {
    lines.push('  Re-run `engine setup` after each step — it re-checks and moves you on automatically.');
  }
  if (frame.doc) lines.push(`  More detail: ${frame.doc}`);
  return lines;
}

/** A concise one-line summary for the dispatcher's `[OK] …` head. */
function summaryLine(frame) {
  const p = frame.progress || { done: 0, total: 5 };
  if (frame.done) return `setup complete — ${p.done}/${p.total} checkpoints passed; project is operational`;
  return `${frame.generated_for} · ${frame.title} — ${p.done}/${p.total} checkpoints done`;
}

/**
 * @param {object} ctx  { flags, positionals, env }
 * @returns {{ ok, summary, detail?, data?, exitCode? }}
 */
function run(ctx = {}) {
  const flags = ctx.flags || {};
  if (util.flagOn(flags.help)) return { ok: true, summary: HELP.split('\n')[0], detail: HELP };

  const env = ctx.env || process.env;
  const record = !util.flagOn(flags['no-record']);

  let frame;
  try {
    frame = flow.computeFrame({ env, record });
  } catch (err) {
    return { ok: false, exitCode: 1, summary: 'setup failed to compute the next step', detail: util.describeError(err) };
  }

  return {
    ok: true,
    exitCode: 0, // informational/advancing — mid-setup is not an error (use `engine verify` for the gate).
    summary: summaryLine(frame),
    detail: renderFrame(frame),
    data: frame,
  };
}

module.exports = { run, HELP, renderFrame, summaryLine };
