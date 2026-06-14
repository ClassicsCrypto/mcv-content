'use strict';

/**
 * tests/setup-init.test.js  [N — new tests]
 *
 * Covers engine/setup/init.js (release-spec §1.2 instance layout; §2.3 C1 step 1; DD-8 hygiene
 * invariant; §2.1 idempotence): scaffolds the full §1.2 directory layout, seeds a schema-valid
 * starter system.json + a starter .env, is idempotent (re-run never overwrites operator content),
 * and REFUSES a CONTENT_HOME inside the code checkout (DD-8).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const init = require('../engine/setup/init.js');
const paths = require('../engine/shared/paths.js');
const setupState = require('../engine/setup/setup-state.js');

function tempHomePath() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'oce-init-'));
}

test('initHome scaffolds the full §1.2 directory layout under the target home', () => {
  const home = tempHomePath();
  const { env } = init.initHome({ home, git: false });

  // A representative spread of the §1.2 dirs (and the nested ones).
  for (const p of [
    paths.configDir(env),
    paths.brandsDir(env),
    paths.calendarDir(env),
    paths.campaignsDir(env),
    paths.corporaDir(env),
    paths.queueDir(env),
    paths.queueLocksDir(env),
    paths.workspacesDir(env),
    paths.libraryDir(env),
    paths.libraryMediaDir(env),
    paths.analyticsDir(env),
    paths.learningProposedDir(env),
    paths.learningAppliedDir(env),
    paths.ledgerDir(env),
    paths.tasksDir(env),
    paths.logsDir(env),
  ]) {
    assert.ok(fs.existsSync(p) && fs.statSync(p).isDirectory(), `expected dir: ${p}`);
  }
});

test('initHome seeds a schema-valid SAFE-mode starter system.json + a starter .env + setup-state', () => {
  const home = tempHomePath();
  const { env } = init.initHome({ home, git: false });

  const sys = JSON.parse(fs.readFileSync(paths.systemConfig(env), 'utf8'));
  assert.equal(sys.mode, 'SAFE');
  assert.equal(sys.publish.draft_only, true);
  assert.equal(sys.budget.indexing_requires_estimate, true);
  assert.ok(Array.isArray(sys.reviewers) && sys.reviewers.length >= 1);
  for (const role of ['content-review', 'content-published', 'content-ops', 'media-bank']) {
    assert.ok(role in sys.approval_surface.channels, `channel role bound: ${role}`);
  }

  const envBody = fs.readFileSync(paths.envFile(env), 'utf8');
  assert.match(envBody, /DISCORD_BOT_TOKEN=/);
  // CONTENT_HOME must NOT be settable in the instance .env (§4.1 placement rule).
  assert.doesNotMatch(envBody, /^CONTENT_HOME=/mu);

  assert.equal(setupState.readSetupState(env).project_state, setupState.LIFECYCLE.UNINITIALIZED);
});

test('initHome is idempotent: a re-run never overwrites operator-edited config or .env', () => {
  const home = tempHomePath();
  const first = init.initHome({ home, git: false });

  // Operator edits both seed files.
  const sysFile = paths.systemConfig(first.env);
  const envFile = paths.envFile(first.env);
  fs.writeFileSync(sysFile, JSON.stringify({ mode: 'LIVE_PREVIEW', mine: true }), 'utf8');
  fs.writeFileSync(envFile, 'DISCORD_BOT_TOKEN=operator-real-value\n', 'utf8');

  const second = init.initHome({ home, git: false });
  assert.equal(second.created['config/system.json'], 'kept');
  assert.equal(second.created['.env'], 'kept');

  // Operator content survived.
  assert.equal(JSON.parse(fs.readFileSync(sysFile, 'utf8')).mine, true);
  assert.match(fs.readFileSync(envFile, 'utf8'), /operator-real-value/);
});

test('initHome REFUSES a CONTENT_HOME inside the code checkout (DD-8 hygiene invariant)', () => {
  const insideCheckout = path.join(init.REPO_ROOT, 'tmp-instance-should-be-refused');
  assert.throws(
    () => init.initHome({ home: insideCheckout, git: false }),
    (err) => err instanceof init.UnsafeContentHomeError && /inside the code checkout/u.test(err.message),
  );
  // Nothing was created.
  assert.equal(fs.existsSync(insideCheckout), false);
});

test('initHome throws ContentHomeUnsetError when no home is given and CONTENT_HOME is unset', () => {
  const env = {}; // no CONTENT_HOME
  assert.throws(() => init.initHome({ env, git: false }), paths.ContentHomeUnsetError);
});

test('initHome does not mutate the passed env / process.env', () => {
  const home = tempHomePath();
  const baseEnv = {};
  init.initHome({ home, env: baseEnv, git: false });
  assert.equal(baseEnv.CONTENT_HOME, undefined);
});

test('starterSystemConfig conforms to the system.schema.json required shape (structural)', () => {
  const cfg = init.starterSystemConfig();
  // Required top-level keys per §11.2 system.schema.json.
  for (const key of ['mode', 'reviewers', 'budget', 'publish', 'approval_surface', 'scheduler']) {
    assert.ok(key in cfg, `required key: ${key}`);
  }
  assert.match(cfg.scheduler.kickoff_time, /^([01]\d|2[0-3]):[0-5]\d$/u);
});
