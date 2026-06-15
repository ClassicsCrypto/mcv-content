'use strict';

/**
 * engine/cli/util.js  [N net-new]
 *
 * Shared helpers for the CLI verb handlers (release-spec §2.8 quick-start verbs; §13.1 status;
 * §1 tree bin/engine.js). The dispatcher (bin/engine.js) parses argv into { verb, flags,
 * positionals } and hands the parsed flags to a verb handler; this module holds the small,
 * verb-agnostic plumbing every handler shares so each handler stays a thin wiring layer over the
 * already-on-disk engine modules (it wires, never re-implements):
 *
 *   - a tiny argv parser (long `--flag value` / `--flag=value` / boolean `--flag`, short `-h`),
 *     with NO third-party dependency (package.json ships engine deps only — §1 tree);
 *   - structured stdout: JSON when `--json` is set (machine-readable for the agent-first audience,
 *     §17.1), else a compact human line; both go through one printer so a verb never console.logs
 *     ad hoc;
 *   - config loading: read $CONTENT_HOME/config/system.json through paths.js (RD-3), tolerant of a
 *     missing file (the two CONTENT_HOME-free verbs — fixture-run, init — never need it, §4.1);
 *   - the SAFE-default + mode-ladder resolution surfaced to every verb through mode.js (the ONE
 *     ladder authority — §8.3 / RD-16f), with the loud diagnostic-override notice (§4.5);
 *   - typed-error presentation: a ContentHomeUnsetError / CredentialMissingError / UnsafeContentHome
 *     error becomes a named remediation line (fail-fast, name the variable never the value — §15.1),
 *     not a raw stack trace.
 *
 * Tier-3 cleanliness (§0.3 r6 / RD-3): no hardcoded IDs/handles/absolute paths/brand strings; no
 * production persona codenames. Every instance path is derived by paths.js; this module constructs
 * none of its own.
 */

const fs = require('fs');

const paths = require('../shared/paths');
const mode = require('../orchestrator/mode');

/**
 * The known BOOLEAN flags across all verbs: these never consume the following token as a value, so
 * `engine kickoff --now mon-am` reads as { now:true } + positional "mon-am" rather than
 * { now:"mon-am" }. A minimal dependency-free parser can't disambiguate boolean-vs-value without
 * this set; every boolean flag any verb honors is listed here (the verbs' own help is the source).
 */
const BOOLEAN_FLAGS = new Set([
  'help', 'json', 'now', 'force', 'dry-run', 'apply', 'yes', 'estimate-only',
  'dispatch-only', 'no-git', 'keep',
  // rollback (SI-CLI): --last is a presence flag (one-step revert) that never consumes the following
  // token; --to-baseline / --record DO take a value, so they are intentionally NOT boolean here.
  'last',
  // ingest-brand (BD-CLI): --manual is a presence flag (skip scraping) that never consumes the
  // following token (so `engine ingest-brand --manual --brand acme` parses cleanly).
  'manual',
  // index-library sub-actions + modifiers (LIB-CLI): each is a presence flag that never
  // consumes the following token (so `engine index-library --organize --apply` parses cleanly).
  'organize', 'character-sheets', 'generate', 'no-hash',
  // improvement-sharing (IS-CLI): `engine share` --prepare/--refuse-residual and
  // `engine evaluate-contribution` --skip-gate-regression are presence flags that never consume the
  // following token (so `engine share --record r1 --prepare --yes` parses cleanly). --operator,
  // --private-term, --brand-term DO take a value, so they are intentionally NOT boolean here.
  'prepare', 'refuse-residual', 'skip-gate-regression',
]);

/**
 * Parse a verb's argv tail into { flags, positionals, _raw }. Long forms only for options
 * (`--home <v>`, `--home=<v>`, boolean `--now`); `-h`/`--help` are normalized to flags.help. Known
 * boolean flags (BOOLEAN_FLAGS) never consume the next token. The parser is intentionally minimal
 * and dependency-free; it never throws on unknown flags (a verb decides which flags it honors,
 * fail-closed where it must — §6.1).
 *
 * @param {string[]} argv  the args AFTER the verb (process.argv.slice(3)-shaped)
 * @returns {{ flags: object, positionals: string[], _raw: string[] }}
 */
function parseArgs(argv = []) {
  const flags = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === '-h' || tok === '--help') {
      flags.help = true;
      continue;
    }
    if (tok.startsWith('--')) {
      const body = tok.slice(2);
      const eq = body.indexOf('=');
      if (eq !== -1) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
        continue;
      }
      // A known boolean flag is always true and never consumes the next token; an option flag
      // takes the next token as its value when it is not itself another --flag.
      const next = argv[i + 1];
      if (!BOOLEAN_FLAGS.has(body) && next != null && !next.startsWith('--')) {
        flags[body] = next;
        i++;
      } else {
        flags[body] = true;
      }
      continue;
    }
    positionals.push(tok);
  }
  return { flags, positionals, _raw: argv };
}

/** True when a flag is present and truthy (boolean true, or any non-empty string except "false"). */
function flagOn(value) {
  if (value === true) return true;
  if (typeof value === 'string') return value.trim() !== '' && value.trim().toLowerCase() !== 'false';
  return false;
}

/**
 * Print a verb result. `--json` emits the structured object (one JSON document to stdout); the
 * default emits a compact, human-first summary line plus an optional multi-line detail block. A
 * verb returns { ok, summary, detail?, data? }; this is the ONE place output is written.
 *
 * @param {object} result  { ok:boolean, summary:string, detail?:string|string[], data?:object }
 * @param {object} [opts]   { json:boolean }
 */
function printResult(result, opts = {}) {
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(result.data !== undefined ? result.data : result, null, 2)}\n`);
    return;
  }
  const mark = result.ok === false ? 'FAIL' : 'OK';
  process.stdout.write(`[${mark}] ${result.summary || ''}\n`);
  if (result.detail != null) {
    const lines = Array.isArray(result.detail) ? result.detail : String(result.detail).split('\n');
    for (const line of lines) process.stdout.write(`  ${line}\n`);
  }
}

/**
 * Present a thrown error as a named, actionable line rather than a stack trace. Typed engine
 * errors (CONTENT_HOME unset, credential missing, unsafe home) carry their own remediation in the
 * message; we surface .message and, when present, the named .variable (§15.1 — name the variable,
 * never the value). Returns the string a handler/dispatcher writes to stderr.
 */
function describeError(err) {
  if (!err) return 'unknown error';
  const named = err.variable ? ` [variable: ${err.variable}]` : '';
  return `${err.name || 'Error'}: ${err.message}${named}`;
}

/**
 * Load the instance system.json (config layer 2, §11.2) through paths.js. Returns {} when the file
 * is missing or unparseable (a verb that needs a valid config validates it via the C1 verifier,
 * not here) and null-safely returns {} when CONTENT_HOME is unset so a CONTENT_HOME-free verb can
 * still ask for config without blowing up.
 *
 * @param {object} [env]  default process.env
 * @returns {object} parsed system.json, or {}
 */
function loadSystemConfig(env = process.env) {
  let file;
  try {
    file = paths.systemConfig(env);
  } catch {
    return {}; // CONTENT_HOME unset — caller is a CONTENT_HOME-free verb.
  }
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * Resolve the effective mode for a verb run through the ONE ladder authority (mode.js): explicit
 * `--mode` override > ENGINE_MODE env > config.mode > SAFE (§8.3 / RD-16f / §4.5). Returns the
 * mode verdict PLUS a `notice` string the verb prints loudly when an env/override source or an
 * invalid (fell-closed-to-SAFE) value was used — the §4.5 "loud at startup" contract.
 *
 * @param {object} [opts]  { override, config, env }
 * @returns {{ mode, source, invalid, notice:(string|null) }}
 */
function resolveModeWithNotice(opts = {}) {
  const verdict = mode.resolveMode(opts);
  let notice = null;
  if (verdict.invalid) {
    notice = `mode value was unrecognized and fell CLOSED to SAFE (a typo can only make the engine safer, never LIVE) — source: ${verdict.source}`;
  } else if (verdict.source === 'env') {
    notice = `mode ${verdict.mode} came from the ${mode.MODE_ENV_VAR} diagnostic override env var (§4.5) — config is the declared home of posture`;
  } else if (verdict.source === 'override') {
    notice = `mode ${verdict.mode} set by an explicit --mode override for this run only`;
  }
  return { ...verdict, notice };
}

/** Read whether the PAUSED kill-switch sentinel is present (§15.4). False when CONTENT_HOME unset. */
function isPaused(env = process.env) {
  try {
    return fs.existsSync(paths.pausedSentinel(env));
  } catch {
    return false;
  }
}

module.exports = {
  BOOLEAN_FLAGS,
  parseArgs,
  flagOn,
  printResult,
  describeError,
  loadSystemConfig,
  resolveModeWithNotice,
  isPaused,
};
