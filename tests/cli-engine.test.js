'use strict';

/**
 * tests/cli-engine.test.js  [N — new tests, P3-CLI smoke]
 *
 * Smoke coverage for the CLI dispatcher (bin/engine.js) + the verb handlers (engine/cli/*)
 * (release-spec §1 tree bin/; §2.8 quick-start verbs; §13.1 status; §15.4 kill switch; §4.1
 * CONTENT_HOME-free init/fixture-run). Deterministic + zero-key: no live API calls, no network;
 * every verb is exercised against a throwaway temp CONTENT_HOME or CONTENT_HOME-free.
 *
 * The dispatcher's main() returns an exit CODE and prints through the verb result envelope, so the
 * smoke test drives main() with captured stdout/stderr (no child process) and asserts the routing
 * + exit-code contract; the verb handlers are also called directly for their structured result.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const engine = require('../bin/engine.js');
const util = require('../engine/cli/util.js');
const initVerb = require('../engine/cli/init.js');
const verifyVerb = require('../engine/cli/verify.js');
const statusVerb = require('../engine/cli/status.js');
const fixtureRun = require('../engine/cli/fixture-run.js');
const pauseVerb = require('../engine/cli/pause.js');
const dispatchVerb = require('../engine/cli/dispatch.js');
const purgeVerb = require('../engine/cli/purge-corpora.js');
const calibrateVerb = require('../engine/cli/calibrate.js');
const runSlotVerb = require('../engine/cli/run-slot.js');

const paths = require('../engine/shared/paths.js');

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'oce-cli-'));
}

/** Capture stdout/stderr while running fn (which may be async). */
async function capture(fn) {
  const outChunks = [];
  const errChunks = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (c) => { outChunks.push(String(c)); return true; };
  process.stderr.write = (c) => { errChunks.push(String(c)); return true; };
  try {
    const code = await fn();
    return { code, stdout: outChunks.join(''), stderr: errChunks.join('') };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

// ---------------------------------------------------------------------------
// argv parser (util) — the dispatcher's contract
// ---------------------------------------------------------------------------

test('parseArgs handles --flag value, --flag=value, boolean --flag, and positionals', () => {
  const { flags, positionals } = util.parseArgs(['--home', '/tmp/x', '--mode=LIVE', '--now', 'slot-1']);
  assert.equal(flags.home, '/tmp/x');
  assert.equal(flags.mode, 'LIVE');
  assert.equal(flags.now, true);
  assert.deepEqual(positionals, ['slot-1']);
});

test('flagOn treats "false"/empty as off, true/non-empty as on', () => {
  assert.equal(util.flagOn(true), true);
  assert.equal(util.flagOn('yes'), true);
  assert.equal(util.flagOn('false'), false);
  assert.equal(util.flagOn(''), false);
  assert.equal(util.flagOn(undefined), false);
});

// ---------------------------------------------------------------------------
// dispatcher routing + exit codes
// ---------------------------------------------------------------------------

test('top-level help lists every verb and exits 0', async () => {
  const { code, stdout } = await capture(() => engine.main(['node', 'engine.js', '--help']));
  assert.equal(code, 0);
  for (const verb of engine.VERB_ORDER) assert.match(stdout, new RegExp(verb));
});

test('no args prints help and exits 0', async () => {
  const { code, stdout } = await capture(() => engine.main(['node', 'engine.js']));
  assert.equal(code, 0);
  assert.match(stdout, /Usage: engine <verb>/);
});

test('--version prints the package version', async () => {
  const { code, stdout } = await capture(() => engine.main(['node', 'engine.js', '--version']));
  assert.equal(code, 0);
  assert.match(stdout.trim(), /^\d+\.\d+\.\d+/);
});

test('unknown verb exits 64 (EX_USAGE) with a named error', async () => {
  const { code, stderr } = await capture(() => engine.main(['node', 'engine.js', 'frobnicate']));
  assert.equal(code, 64);
  assert.match(stderr, /Unknown verb "frobnicate"/);
});

test('every registered verb has a --help that exits 0', async () => {
  for (const verb of engine.VERB_ORDER) {
    const { code, stdout } = await capture(() => engine.main(['node', 'engine.js', verb, '--help']));
    assert.equal(code, 0, `${verb} --help should exit 0`);
    assert.ok(stdout.length > 0, `${verb} --help should print`);
  }
});

// ---------------------------------------------------------------------------
// init (CONTENT_HOME-free) + verify routing through the dispatcher
// ---------------------------------------------------------------------------

test('init scaffolds a fresh home and routes through main() with exit 0', async () => {
  const home = tempHome();
  const target = path.join(home, 'instance');
  const { code, stdout } = await capture(() => engine.main(['node', 'engine.js', 'init', '--home', target, '--no-git']));
  assert.equal(code, 0);
  assert.match(stdout, /initialized CONTENT_HOME/);
  assert.ok(fs.existsSync(path.join(target, 'config', 'system.json')));
  assert.ok(fs.existsSync(path.join(target, 'queue', 'locks')));
});

test('init refuses a CONTENT_HOME inside the code checkout (DD-8) with a named error, exit 1', () => {
  const inside = path.join(paths_repoRoot(), 'tmp-inside-home');
  const result = initVerb.run({ flags: { home: inside, 'no-git': true }, env: { ...process.env } });
  assert.equal(result.ok, false);
  assert.match(String(result.detail), /UnsafeContentHomeError|inside the code checkout/);
});

function paths_repoRoot() {
  return path.resolve(__dirname, '..');
}

test('verify --checkpoint C0 passes CONTENT_HOME-free (the zero-key fit check)', () => {
  const result = verifyVerb.run({ flags: { checkpoint: 'C0' }, env: { PATH: process.env.PATH } });
  assert.equal(result.data.checkpoint, 'C0');
  // C0 only asserts node/version + repo hygiene files; on this repo it should pass.
  assert.equal(result.ok, true);
});

test('verify --checkpoint C1 FAILS on a fresh home missing the Discord token (fail-fast §15.1)', () => {
  const home = tempHome();
  const env = initVerb.run({ flags: { home: path.join(home, 'i'), 'no-git': true }, env: { ...process.env } }).data
    ? { ...process.env, CONTENT_HOME: path.join(home, 'i') }
    : null;
  assert.ok(env, 'init should have produced a home');
  const result = verifyVerb.run({ flags: { checkpoint: 'C1' }, env });
  assert.equal(result.ok, false);
  // The token check names the variable, never a value.
  const tokenCheck = result.data.checks.find((c) => c.name === 'discord_token');
  assert.ok(tokenCheck);
  assert.match(JSON.stringify(result.data), /DISCORD_BOT_TOKEN/);
  assert.doesNotMatch(JSON.stringify(result.data), /sk-|Bot [A-Za-z0-9]/); // no value-shaped leak
});

// ---------------------------------------------------------------------------
// fixture-run dispatch routing (full end-to-end behavior is tests/fixture-run.test.js)
// ---------------------------------------------------------------------------

test('fixture-run routes through main() and PASSES the zero-key end-to-end proof (exit 0)', async () => {
  // The fixtures (fixtures/stage-outputs/ + the Acme fixtures) and the runner (fixtures/run.js)
  // ship in P4; the verb now runs the §5.4 spine end-to-end CONTENT_HOME-free. Detailed contract
  // assertions live in tests/fixture-run.test.js; here we only pin the dispatcher routing + exit.
  const { code, stdout } = await capture(() =>
    engine.main(['node', 'engine.js', 'fixture-run']));
  assert.equal(code, 0, `fixture-run should exit 0. stdout:\n${stdout}`);
  assert.match(stdout, /PASSED/);
});

test('fixture-run direct handler returns a structured PASS with the full stage list', async () => {
  const result = await fixtureRun.run({ flags: {}, env: { PATH: process.env.PATH } });
  assert.equal(result.ok, true);
  assert.equal(result.exitCode, 0);
  assert.match(result.summary, /PASSED/);
  assert.ok(Array.isArray(result.data.result.stages) && result.data.result.stages.length >= 6);
});

// ---------------------------------------------------------------------------
// pause / resume kill switch (§15.4)
// ---------------------------------------------------------------------------

test('pause writes the PAUSED sentinel + flips config; resume reverses it', () => {
  const home = tempHome();
  const target = path.join(home, 'i');
  initVerb.run({ flags: { home: target, 'no-git': true }, env: { ...process.env } });
  const env = { ...process.env, CONTENT_HOME: target };

  const paused = pauseVerb.pauseRun({ flags: { reason: 'maintenance' }, env });
  assert.equal(paused.ok, true);
  assert.ok(fs.existsSync(paths.pausedSentinel(env)));
  assert.equal(JSON.parse(fs.readFileSync(paths.systemConfig(env), 'utf8')).paused, true);

  const resumed = pauseVerb.resumeRun({ flags: {}, env });
  assert.equal(resumed.ok, true);
  assert.equal(fs.existsSync(paths.pausedSentinel(env)), false);
  assert.equal(JSON.parse(fs.readFileSync(paths.systemConfig(env), 'utf8')).paused, false);
});

test('dispatch refuses (EPAUSED) while paused — kill switch halts new dispatch (§15.4)', () => {
  const home = tempHome();
  const target = path.join(home, 'i');
  initVerb.run({ flags: { home: target, 'no-git': true }, env: { ...process.env } });
  const env = { ...process.env, CONTENT_HOME: target };
  pauseVerb.pauseRun({ flags: {}, env });

  const result = dispatchVerb.run({ flags: { family: 'RUN_SLOT', slot: 's1', brand: 'acme' }, env });
  assert.equal(result.ok, false);
  assert.match(JSON.stringify(result.data), /EPAUSED/);
});

// ---------------------------------------------------------------------------
// status (§13.1) — reads queue + ledger + mode + honest spend scope
// ---------------------------------------------------------------------------

test('status reports mode, project state, and the honest engine-metered-only spend scope (RD-19)', () => {
  const home = tempHome();
  const target = path.join(home, 'i');
  initVerb.run({ flags: { home: target, 'no-git': true }, env: { ...process.env } });
  const env = { ...process.env, CONTENT_HOME: target };

  const result = statusVerb.run({ flags: {}, env });
  assert.equal(result.data.mode, 'SAFE'); // fresh install defaults SAFE (RD-16f)
  assert.equal(result.data.spend.scope, 'engine-metered only (partial)');
  assert.match(result.data.spend.note, /host-runtime-owned/);
  assert.equal(result.data.pending_tasks, 0);
});

// ---------------------------------------------------------------------------
// purge-corpora retention (RD-9) — dry-run default, honors retention_class
// ---------------------------------------------------------------------------

test('purge-corpora dry-runs by default and never purges a "retained" item', () => {
  const home = tempHome();
  const target = path.join(home, 'i');
  initVerb.run({ flags: { home: target, 'no-git': true }, env: { ...process.env } });
  const env = { ...process.env, CONTENT_HOME: target };

  const corpus = path.join(paths.corporaDir(env), 'acme');
  fs.mkdirSync(corpus, { recursive: true });
  const old = new Date(Date.now() - 200 * 86400000).toISOString();
  fs.writeFileSync(path.join(corpus, 'a.json'), JSON.stringify({ source: 'manual', captured_at: old, text: 't', trust_class: 'untrusted-scraped', retention_class: 'standard' }));
  fs.writeFileSync(path.join(corpus, 'b.json'), JSON.stringify({ source: 'manual', captured_at: old, text: 't', trust_class: 'operator-curated', retention_class: 'retained' }));

  const dry = purgeVerb.run({ flags: {}, env });
  assert.equal(dry.data.apply, false);
  assert.equal(dry.data.eligible.length, 1); // the standard item only
  assert.equal(dry.data.eligible[0].file, 'acme/a.json');
  assert.ok(fs.existsSync(path.join(corpus, 'a.json'))); // dry-run deletes nothing

  const applied = purgeVerb.run({ flags: { apply: true }, env });
  assert.equal(applied.data.purged, 1);
  assert.equal(fs.existsSync(path.join(corpus, 'a.json')), false);
  assert.ok(fs.existsSync(path.join(corpus, 'b.json'))); // retained survives
});

// ---------------------------------------------------------------------------
// calibrate — DD-18 estimate-and-confirm; never bypasses the gate
// ---------------------------------------------------------------------------

test('calibrate requires confirmation before spending (DD-18 estimate-and-confirm)', async () => {
  const home = tempHome();
  const target = path.join(home, 'i');
  initVerb.run({ flags: { home: target, 'no-git': true }, env: { ...process.env } });
  const env = { ...process.env, CONTENT_HOME: target };

  const unconfirmed = await calibrateVerb.run({ flags: { brand: 'acme' }, env });
  assert.equal(unconfirmed.data.awaiting_confirmation, true);
  assert.match(unconfirmed.summary, /requires confirmation/);

  const estOnly = await calibrateVerb.run({ flags: { brand: 'acme', 'estimate-only': true }, env });
  assert.equal(estOnly.ok, true);
  assert.ok(estOnly.data.estimate.estimated_total_usd.high >= estOnly.data.estimate.estimated_total_usd.low);
});

test('calibrate --result grades against the C3 criteria and records C3 (a passing battery → calibrated)', async () => {
  const home = tempHome();
  const target = path.join(home, 'i');
  initVerb.run({ flags: { home: target, 'no-git': true }, env: { ...process.env } });
  const env = { ...process.env, CONTENT_HOME: target };

  const passing = JSON.stringify({ sample_count: 10, gate_clear: 9, on_voice: 7, fabrication_codes: 0 });
  const result = await calibrateVerb.run({ flags: { brand: 'acme', yes: true, result: passing }, env });
  assert.equal(result.ok, true);
  assert.match(result.summary, /calibration PASSED/);

  const failing = JSON.stringify({ sample_count: 10, gate_clear: 4, on_voice: 2, fabrication_codes: 1 });
  const bad = await calibrateVerb.run({ flags: { brand: 'acme', yes: true, result: failing }, env });
  assert.equal(bad.ok, false);
  assert.match(bad.summary, /calibration FAILED/);
});

// ---------------------------------------------------------------------------
// run-slot — fail-closed on an unknown slot; dispatch-only by default
// ---------------------------------------------------------------------------

test('run-slot fails closed on a slot not in the calendar (§6.1)', async () => {
  const home = tempHome();
  const target = path.join(home, 'i');
  initVerb.run({ flags: { home: target, 'no-git': true }, env: { ...process.env } });
  const env = { ...process.env, CONTENT_HOME: target };

  const result = await runSlotVerb.run({ flags: {}, positionals: ['nope'], env });
  assert.equal(result.ok, false);
  assert.match(result.summary, /not in the calendar/);
});

test('run-slot dispatches a pending task for a known slot and lands SAFE by default', async () => {
  const home = tempHome();
  const target = path.join(home, 'i');
  initVerb.run({ flags: { home: target, 'no-git': true }, env: { ...process.env } });
  const env = { ...process.env, CONTENT_HOME: target };

  // Seed a minimal calendar the kickoff reader parses (## Slots markdown table, §6.5 columns).
  const cal = [
    '## Slots',
    '| slot_id | brand | platform | day | time | pillar | content_type | command_family | format | slot_type | state | notes |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    '| mon-am | acme | twitter | Mon | 09:00 | launch | single | RUN_SLOT | tweet | regular | active | |',
    '',
  ].join('\n');
  fs.mkdirSync(paths.calendarDir(env), { recursive: true });
  fs.writeFileSync(path.join(paths.calendarDir(env), 'calendar.md'), cal);

  const result = await runSlotVerb.run({ flags: {}, positionals: ['mon-am'], env });
  assert.equal(result.ok, true);
  assert.equal(result.data.mode, 'SAFE');
  assert.equal(result.data.lane, 'text-heavy'); // a tweet/twitter slot → flagship text-heavy
  assert.ok(result.data.dispatch.task.task_id);
});
