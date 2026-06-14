#!/usr/bin/env node
'use strict';

/**
 * bin/engine.js  [N net-new]
 *
 * The thin CLI entry point — the dispatcher / arg-parser that wires the engine end-to-end
 * (release-spec §1 tree `bin/engine.js`; §2 setup verbs; §2.8 quick-start; §13.1 status; DD-18;
 * RD-18). The "thin runner" edge of the kit-plus-thin-runner product (DD-1(c)): every verb is a
 * thin handler in engine/cli/ over the already-on-disk engine modules (setup, orchestrator,
 * pipelines, analytics, shared). This file owns ONLY argument parsing, verb routing, the SAFE
 * default + mode-ladder loud-notice surface, consistent --help, and process exit codes.
 *
 * Invocation convention (§2.2): `engine <verb>` throughout the docs is shorthand for
 * `node bin/engine.js <verb>` (package.json wires the `engine` bin). The long form always works.
 *
 * Verbs (§1 tree + the batch contract):
 *   init           scaffold $CONTENT_HOME            (engine/setup initHome)          — CONTENT_HOME-free
 *   verify         the C0–C4 setup gate              (engine/setup verifyCheckpoint)
 *   fixture-run    zero-key deterministic E2E        (fixtures/run.js — P4)           — CONTENT_HOME-free
 *   run-slot       on-demand single-slot run         (orchestrator dispatch + pipelines)
 *   kickoff        the canonical daily batch         (orchestrator runKickoff)
 *   dispatch       write one slot-run task record    (orchestrator dispatchTask, RD-18)
 *   status         the §13.1 operational surface     (queue + ledger + mode + spend scope)
 *   calibrate      the C3 calibration runner         (estimate-and-confirm, DD-18/§2.5)
 *   purge-corpora  retention purge by retention_class (RD-9)
 *   pause / resume the kill switch                   (PAUSED sentinel + config, §15.4)
 *
 * Exit codes: 0 success; 1 a verb-level failure (a failed checkpoint, a refused/erroring run); 2 a
 * usage / setup error (unknown checkpoint, bad arg); 3 a not-yet-present dependency (fixtures, P4);
 * 64 an unknown verb. A refused-by-design dispatch (PAUSED / over budget) exits 0 — it is the
 * system behaving correctly, surfaced honestly, not an error.
 *
 * The SAFE default + mode ladder is honored by every verb that runs the pipeline / dispatches
 * (run-slot, kickoff, dispatch, status) through the ONE ladder authority (engine/orchestrator/
 * mode.js): explicit --mode > ENGINE_MODE env > config.mode > SAFE (§8.3 / RD-16f), with the §4.5
 * loud diagnostic-override notice surfaced in the verb output. Safety posture lives in declared
 * config, not in this wrapper (§4.5).
 *
 * Tier-3 cleanliness (§0.3 r6 / RD-3): this file constructs no instance paths, hardcodes no
 * IDs/handles/roots, and carries no production persona codenames.
 */

const util = require('../engine/cli/util');

const PKG_VERSION = (() => {
  try { return require('../package.json').version; } catch { return '0.0.0'; }
})();

/**
 * The verb registry. Each entry: { run, help, sync? }. `run` returns (or resolves to) the verb
 * result envelope { ok, summary, detail?, data?, exitCode? }. Handlers that perform I/O-bound async
 * work (run-slot, kickoff, calibrate, fixture-run) are awaited; the sync ones are awaited too
 * (await of a non-promise is a no-op), so the dispatch loop is uniform.
 */
const VERBS = {
  init: { mod: require('../engine/cli/init'), fn: 'run' },
  verify: { mod: require('../engine/cli/verify'), fn: 'run' },
  'fixture-run': { mod: require('../engine/cli/fixture-run'), fn: 'run' },
  'run-slot': { mod: require('../engine/cli/run-slot'), fn: 'run' },
  kickoff: { mod: require('../engine/cli/kickoff'), fn: 'run' },
  dispatch: { mod: require('../engine/cli/dispatch'), fn: 'run' },
  status: { mod: require('../engine/cli/status'), fn: 'run' },
  calibrate: { mod: require('../engine/cli/calibrate'), fn: 'run' },
  'index-library': { mod: require('../engine/cli/index-library'), fn: 'run' },
  'purge-corpora': { mod: require('../engine/cli/purge-corpora'), fn: 'run' },
  pause: { mod: require('../engine/cli/pause'), fn: 'pauseRun' },
  resume: { mod: require('../engine/cli/pause'), fn: 'resumeRun' },
};

const VERB_ORDER = ['init', 'verify', 'fixture-run', 'run-slot', 'kickoff', 'dispatch', 'status', 'calibrate', 'index-library', 'purge-corpora', 'pause', 'resume'];

/** One-line summary per verb for the top-level help (kept short; --help <verb> has the full text). */
const VERB_SUMMARY = {
  init: 'scaffold $CONTENT_HOME (CONTENT_HOME-free)',
  verify: 'run the C0–C4 setup gate',
  'fixture-run': 'zero-key deterministic end-to-end proof (CONTENT_HOME-free)',
  'run-slot': 'run one calendar slot on demand',
  kickoff: 'run the canonical daily kickoff batch (--now)',
  dispatch: 'write one pending slot-run task record (RD-18)',
  status: 'the one-command operational surface (§13.1)',
  calibrate: 'the C3 calibration runner (estimate-and-confirm)',
  'index-library': 'build the library index (forthcoming — roadmap)',
  'purge-corpora': 'enforce corpus retention windows (RD-9)',
  pause: 'engage the kill switch (PAUSED sentinel + config)',
  resume: 'reverse the kill switch',
};

function topLevelHelp() {
  const lines = [
    `open-content-engine — engine CLI (v${PKG_VERSION})`,
    '',
    'Usage: engine <verb> [options]   (shorthand for: node bin/engine.js <verb> [options])',
    '',
    'Verbs:',
    ...VERB_ORDER.map((v) => `  ${v.padEnd(15)} ${VERB_SUMMARY[v]}`),
    '',
    'Global:',
    '  --json           machine-readable output (any verb).',
    '  -h, --help       this help; or "engine <verb> --help" for a verb.',
    '  --version        print the engine version.',
    '',
    'Mode ladder (§8.3): SAFE → LIVE_PREVIEW → LIVE. Default SAFE (RD-16f). Override per run with',
    '--mode, or set config/system.json mode; ENGINE_MODE is a loud diagnostic override only (§4.5).',
  ];
  return lines.join('\n');
}

async function main(argv) {
  const args = argv.slice(2);

  // Top-level help / version (before any verb).
  if (args.length === 0 || args[0] === '-h' || args[0] === '--help' || args[0] === 'help') {
    process.stdout.write(`${topLevelHelp()}\n`);
    return 0;
  }
  if (args[0] === '--version' || args[0] === '-v') {
    process.stdout.write(`${PKG_VERSION}\n`);
    return 0;
  }

  const verbName = args[0];
  const entry = VERBS[verbName];
  if (!entry) {
    process.stderr.write(`Unknown verb "${verbName}". Run "engine --help" for the verb list.\n`);
    return 64; // EX_USAGE
  }

  const { flags, positionals } = util.parseArgs(args.slice(1));
  const json = util.flagOn(flags.json);

  let result;
  try {
    const handler = entry.mod[entry.fn];
    result = await handler({ flags, positionals, env: process.env });
  } catch (err) {
    // Defense-in-depth: a handler SHOULD return a result envelope rather than throw, but a typed
    // engine error (CONTENT_HOME unset, credential missing) still gets a named line, not a stack.
    process.stderr.write(`${util.describeError(err)}\n`);
    return 1;
  }

  if (!result || typeof result !== 'object') {
    process.stderr.write(`verb "${verbName}" returned no result\n`);
    return 1;
  }

  util.printResult(result, { json });
  // Exit code: explicit verb exitCode wins; else 0 on ok, 1 on not-ok.
  if (typeof result.exitCode === 'number') return result.exitCode;
  return result.ok === false ? 1 : 0;
}

// Only run when invoked directly (so the smoke test can require the dispatcher's helpers without
// triggering a process exit — the test imports the verb modules + util directly).
if (require.main === module) {
  main(process.argv)
    .then((code) => { process.exitCode = code; })
    .catch((err) => {
      process.stderr.write(`${util.describeError(err)}\n`);
      process.exitCode = 1;
    });
}

module.exports = { main, VERBS, VERB_ORDER, topLevelHelp };
