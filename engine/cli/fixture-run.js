'use strict';

/**
 * engine/cli/fixture-run.js  [N net-new]
 *
 * `engine fixture-run` — the zero-key, deterministic end-to-end proof (release-spec §2.2 C0 step
 * 2; §5.4 fixture run; model §13.1 "the zero-key fixture run is a MUST"; ratification item (b):
 * the deterministic spine runs LIVE while the LLM seats replay RECORDED fixture artifacts). This
 * is the "is this for me / does it work" proof BEFORE any spend or account linking (DR Risk 2). It
 * MUST succeed on a fresh clone with NO credentials and NO CONTENT_HOME set — one of the only two
 * CONTENT_HOME-free commands (§4.1; the other is `engine init`).
 *
 * How it stays zero-key + deterministic (ratification (b)):
 *   - the LLM seats are NOT called (RD-2). Instead the recorded fixture stage outputs
 *     (fixtures/stage-outputs/) are replayed as the seat outputs, so the matcher/writer/gate/media
 *     /packager artifacts are fixed inputs — no provider, no token, no network;
 *   - the DETERMINISTIC SPINE runs live over those fixtures: pre-gate lint, retrieval scoring,
 *     package/platform validation + cooldown, the queue write — the real engine code, exercised
 *     end-to-end to a mock approval-card artifact the operator can inspect (§5.4);
 *   - WORKFLOW_LEDGER_DISABLE=1 + a throwaway temp CONTENT_HOME keep it side-effect-free: it
 *     writes only under an OS temp dir it creates and removes, never the operator's instance.
 *
 * Fixtures land in the P4 batch. This handler WIRES the path now and degrades gracefully: when
 * fixtures/stage-outputs is absent it reports "fixtures not present (P4)" with a clear, non-zero
 * exit — it never fabricates a passing run (the fixture run is the literal Step-9 audit target, so
 * a false green would be the worst possible outcome). When the fixtures + the runner module
 * (fixtures/run.js, P4) are present, it delegates to them.
 *
 * Tier-3 cleanliness (§0.3 r6): the temp home is OS-tmp-derived, never an operator path; the
 * synthetic brand is the Acme Cosmos fixture (P4); no real ids/handles/codenames.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const util = require('./util');

/** Repo root (two up from engine/cli/). */
const REPO_ROOT = path.resolve(__dirname, '..', '..');

const HELP = `engine fixture-run [options]

The zero-key, deterministic end-to-end proof (§2.2 C0 step 2 / §5.4 / model §13.1). Runs on a fresh
clone with NO credentials and NO CONTENT_HOME: the deterministic spine (lint → retrieval → package
validation → queue) runs live while the LLM seats replay recorded fixture artifacts, producing a
mock approval-card artifact you can inspect. The proof BEFORE any spend (DR Risk 2).

  --keep           keep the temp working dir (default: removed after the run).
  --json           emit the structured result.
  -h, --help       show this help.

Fixtures ship in the P4 batch; until then this reports "fixtures not present (P4)" with a non-zero
exit — it never fabricates a passing run (it is the Step-9 audit target).`;

/** Where the recorded fixtures + their runner live (authored by the P4 fixtures batch). */
function fixturePaths() {
  return {
    dir: path.join(REPO_ROOT, 'fixtures'),
    stageOutputs: path.join(REPO_ROOT, 'fixtures', 'stage-outputs'),
    runner: path.join(REPO_ROOT, 'fixtures', 'run.js'),
  };
}

function fixturesPresent(fp) {
  try {
    return fs.existsSync(fp.stageOutputs) &&
      fs.readdirSync(fp.stageOutputs).some((f) => !f.startsWith('.'));
  } catch {
    return false;
  }
}

/**
 * @param {object} ctx  { flags, env }
 * @returns {Promise<{ ok, summary, detail?, data?, exitCode? }>}
 */
async function run(ctx = {}) {
  const flags = ctx.flags || {};
  if (util.flagOn(flags.help)) return { ok: true, summary: HELP.split('\n')[0], detail: HELP };

  const fp = fixturePaths();

  if (!fixturesPresent(fp)) {
    return {
      ok: false,
      exitCode: 3,
      summary: 'fixtures not present (P4)',
      detail: [
        `Expected recorded stage outputs at: ${path.relative(REPO_ROOT, fp.stageOutputs)}`,
        'The zero-key fixture set + its runner are the P4 batch (fixtures/stage-outputs/, fixtures/run.js).',
        'The fixture-run path is wired; it will run end-to-end once the fixtures land.',
        'It does NOT fabricate a passing run — fixture-run is the Step-9 audit target (model §13.1).',
      ],
      data: { ok: false, fixtures_present: false, expected: { stage_outputs: fp.stageOutputs, runner: fp.runner } },
    };
  }

  // Fixtures present: run side-effect-free under a throwaway temp CONTENT_HOME with the ledger off.
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'oce-fixture-'));
  const env = { ...(ctx.env || process.env), CONTENT_HOME: tmpHome, WORKFLOW_LEDGER_DISABLE: '1' };
  let result;
  try {
    let runner = null;
    try {
      // eslint-disable-next-line global-require, import/no-dynamic-require
      runner = fs.existsSync(fp.runner) ? require(fp.runner) : null;
    } catch {
      runner = null;
    }
    if (!runner || typeof runner.runFixture !== 'function') {
      return {
        ok: false,
        exitCode: 3,
        summary: 'fixtures present but the fixture runner (fixtures/run.js) is missing or invalid (P4)',
        detail: ['fixtures/run.js must export runFixture({ env }) → outcome — authored by the P4 fixtures batch.'],
        data: { ok: false, fixtures_present: true, runner_present: false },
      };
    }
    result = await runner.runFixture({ env, fixturesDir: fp.dir });
  } catch (err) {
    return { ok: false, exitCode: 1, summary: 'fixture-run errored', detail: util.describeError(err), data: { ok: false, error: err.message } };
  } finally {
    if (!util.flagOn(flags.keep)) {
      try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
    }
  }

  const ok = result && result.ok !== false;
  return {
    ok,
    exitCode: ok ? 0 : 1,
    summary: ok
      ? `fixture-run PASSED — deterministic spine green end-to-end; mock approval card produced (zero keys)`
      : `fixture-run FAILED — ${result && result.reason ? result.reason : 'see detail'}`,
    detail: [
      result && result.stages ? `stages: ${result.stages.join(' → ')}` : null,
      result && result.card_ref ? `mock approval card: ${result.card_ref}` : null,
      util.flagOn(flags.keep) ? `temp home kept: ${tmpHome}` : 'temp home removed (side-effect-free).',
    ].filter(Boolean),
    data: { ok, result },
  };
}

module.exports = { run, HELP };
