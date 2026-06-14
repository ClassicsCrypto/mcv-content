'use strict';

/**
 * engine/cli/init.js  [N net-new]
 *
 * `engine init --home <dir>` — scaffold the $CONTENT_HOME instance directory (release-spec §2.3
 * C1 step 1; §1.2 instance layout; DD-5 setup order; DD-21 cold-start). One of the only two
 * commands that run WITHOUT CONTENT_HOME already set (it is what creates it — §4.1; the other is
 * `engine fixture-run`).
 *
 * This handler is a THIN wiring layer over engine/setup.initHome (already on disk): it parses the
 * --home flag, calls initHome (idempotent + resumable — §2.1), and reports what was created vs
 * kept. The hygiene invariant (refuse a CONTENT_HOME inside the code checkout — DD-8) lives in
 * initHome and surfaces here as a named remediation, never a raw stack trace (§15.1).
 *
 * Tier-3 cleanliness (§0.3 r6): the only absolute path handled is the operator-supplied --home;
 * no hardcoded IDs/paths/codenames.
 */

const setup = require('../setup');
const util = require('./util');

const HELP = `engine init --home <dir>

Scaffold the $CONTENT_HOME instance directory (§2.3 C1 step 1): the §1.2 layout, a SAFE-mode
starter config/system.json, a starter .env to fill as C1 produces credentials, a local-only git
repo (for DD-6 learning-record rollback), and setup-state.json. Idempotent: re-running fills any
missing pieces and never overwrites operator content (§2.1).

  --home <dir>   instance root (created outside the code checkout — DD-8 refuses inside it).
                 When omitted, CONTENT_HOME must already be set in the environment.
  --no-git       skip initializing the local-only git repo (§1.2 SHOULD).
  --json         emit the structured result.
  -h, --help     show this help.`;

/**
 * @param {object} ctx  { flags, positionals, env }
 * @returns {{ ok, summary, detail?, data?, exitCode? }}
 */
function run(ctx = {}) {
  const flags = ctx.flags || {};
  if (util.flagOn(flags.help)) return { ok: true, summary: HELP.split('\n')[0], detail: HELP };

  const env = ctx.env || process.env;
  const home = typeof flags.home === 'string' ? flags.home : undefined;
  const git = !util.flagOn(flags['no-git']);

  let out;
  try {
    out = setup.initHome({ home, git, env });
  } catch (err) {
    // UnsafeContentHomeError / ContentHomeUnsetError carry their own remediation (§15.1 / DD-8).
    return { ok: false, exitCode: 1, summary: 'init failed', detail: util.describeError(err) };
  }

  const created = Object.entries(out.created || {})
    .map(([name, status]) => `${status === 'created' ? '+' : '='} ${name} (${status})`);
  const gitNote = out.results && out.results.git ? `git: ${out.results.git}` : null;

  return {
    ok: true,
    summary: `initialized CONTENT_HOME at ${out.home} (${out.results.dirs.length} dirs, ${git ? 'git ' + out.results.git : 'git skipped'})`,
    detail: [
      ...created,
      ...(gitNote ? [gitNote] : []),
      'Next: C1 — create the Discord bot + token, the four channels, and fill config/system.json (§2.3).',
    ],
    data: {
      ok: true,
      home: out.home,
      dirs: out.results.dirs,
      created: out.created,
      git: out.results.git,
    },
  };
}

module.exports = { run, HELP };
