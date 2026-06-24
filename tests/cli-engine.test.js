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
const setupState = require('../engine/setup/setup-state.js');

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

test('verify --checkpoint C1 does not require a Discord bot token when channels are host-managed', () => {
  const home = tempHome();
  const env = initVerb.run({ flags: { home: path.join(home, 'i'), 'no-git': true }, env: { ...process.env } }).data
    ? { ...process.env, CONTENT_HOME: path.join(home, 'i') }
    : null;
  assert.ok(env, 'init should have produced a home');
  const result = verifyVerb.run({ flags: { checkpoint: 'C1' }, env });
  assert.equal(result.ok, false);
  const permissionCheck = result.data.checks.find((c) => c.name === 'approval_surface_permissions');
  assert.ok(permissionCheck);
  assert.equal(permissionCheck.status, 'pass');
  assert.doesNotMatch(JSON.stringify(result.data), /DISCORD_BOT_TOKEN/);
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

test('calibrate --result records per-brand results without replacing prior brands', async () => {
  const home = tempHome();
  const target = path.join(home, 'i');
  initVerb.run({ flags: { home: target, 'no-git': true }, env: { ...process.env } });
  const env = { ...process.env, CONTENT_HOME: target };

  for (const id of ['jay', 'bp']) {
    fs.mkdirSync(paths.brandDir(id, env), { recursive: true });
    fs.writeFileSync(paths.brandConfig(id, env), JSON.stringify({
      id,
      display_name: id.toUpperCase(),
      account_class: id === 'jay' ? 'operator' : 'brand',
      platforms: [{ platform: 'twitter', publisher: 'postiz' }],
      cold_start: true,
    }, null, 2));
  }

  const passing = JSON.stringify({ sample_count: 10, gate_clear: 9, on_voice: 7, fabrication_codes: 0 });
  const jay = await calibrateVerb.run({ flags: { brand: 'jay', yes: true, result: passing }, env });
  assert.equal(jay.ok, false, 'project is not calibrated until bp is calibrated too');

  const bp = await calibrateVerb.run({ flags: { brand: 'bp', yes: true, result: passing }, env });
  assert.equal(bp.ok, true, JSON.stringify(bp, null, 2));

  const state = setupState.readSetupState(env);
  assert.ok(state.checkpoints.C3.detail.by_brand.jay);
  assert.ok(state.checkpoints.C3.detail.by_brand.bp);
});

// ---------------------------------------------------------------------------
// ingest-brand (BD-CLI) — the one-command flow: ingest -> analyze -> generate
// ---------------------------------------------------------------------------

const ingestBrandVerb = require('../engine/cli/ingest-brand.js');

test('ingest-brand is registered and routes through main() with a --help (exit 0)', async () => {
  assert.ok(engine.VERB_ORDER.includes('ingest-brand'));
  const { code, stdout } = await capture(() => engine.main(['node', 'engine.js', 'ingest-brand', '--help']));
  assert.equal(code, 0);
  assert.match(stdout, /one-command/i);
});

test('ingest-brand needs --brand (exit 2 usage)', async () => {
  const result = await ingestBrandVerb.run({ flags: {}, env: { PATH: process.env.PATH } });
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 2);
  assert.match(result.summary, /needs --brand/);
});

test('ingest-brand without --yes halts with the metered cost band, spends nothing (DD-18)', async () => {
  const home = tempHome();
  const target = path.join(home, 'i');
  initVerb.run({ flags: { home: target, 'no-git': true }, env: { ...process.env } });
  const env = { ...process.env, CONTENT_HOME: target };

  const unconfirmed = await ingestBrandVerb.run({ flags: { brand: 'acme' }, env });
  assert.equal(unconfirmed.ok, false);
  assert.equal(unconfirmed.exitCode, 0); // refused-by-design, not an error
  assert.equal(unconfirmed.data.awaiting_confirmation, true);
  assert.match(unconfirmed.summary, /requires confirmation/);
  // No brand-dna.md was written by the unconfirmed default.
  assert.equal(fs.existsSync(path.join(target, 'brands', 'acme', 'brand-dna.md')), false);

  const estOnly = await ingestBrandVerb.run({ flags: { brand: 'acme', 'estimate-only': true }, env });
  assert.equal(estOnly.ok, true);
  assert.equal(estOnly.data.confirmed, false);
  // No corpus + no scraper configured => scrape: none, synthesis: cold-start (free).
  assert.equal(estOnly.data.scrape.willScrape, false);
});

test('ingest-brand --yes with no corpus + no scraper degrades to the cold-start template (DD-21, exit 0)', async () => {
  const home = tempHome();
  const target = path.join(home, 'i');
  initVerb.run({ flags: { home: target, 'no-git': true }, env: { ...process.env } });
  const env = { ...process.env, CONTENT_HOME: target };

  // Register a minimal brand.json so generate can update voice fields (and the verb reads ingestion).
  const brandDir = path.join(target, 'brands', 'acme');
  fs.mkdirSync(brandDir, { recursive: true });
  fs.writeFileSync(path.join(brandDir, 'brand.json'), JSON.stringify({
    id: 'acme', display_name: 'Acme Cosmos', account_class: 'brand',
    platforms: [{ platform: 'twitter', publisher: 'manual' }],
  }, null, 2));

  const res = await ingestBrandVerb.run({ flags: { brand: 'acme', yes: true }, env });
  assert.equal(res.ok, true);
  assert.equal(res.exitCode, 0);
  // Stage 1 ingest was skipped (off-by-default scraper); stage generate ran cold-start.
  const ingestStage = res.data.stages.find((s) => s.stage === 'ingest');
  assert.equal(ingestStage.skipped, true);
  assert.match(ingestStage.reason, /OFF-by-default|manual\/export corpus only/);
  assert.equal(res.data.generate_status, 'cold-start');
  // The manual authoring template was written — onboarding is never blocked.
  assert.ok(fs.existsSync(path.join(brandDir, 'brand-dna.md')));
});

test('ingest-brand --yes with a manual corpus + injected DNA seat generates DNA end-to-end (zero-key)', async () => {
  const home = tempHome();
  const target = path.join(home, 'i');
  initVerb.run({ flags: { home: target, 'no-git': true }, env: { ...process.env } });
  const env = { ...process.env, CONTENT_HOME: target };

  const brandDir = path.join(target, 'brands', 'acme');
  fs.mkdirSync(brandDir, { recursive: true });
  fs.writeFileSync(path.join(brandDir, 'brand.json'), JSON.stringify({
    id: 'acme', display_name: 'Acme Cosmos', account_class: 'brand',
    platforms: [{ platform: 'twitter', publisher: 'manual' }],
  }, null, 2));

  // Drop an own-corpus item directly into corpora/acme/ (the manual path — no scraper, no keys).
  const corpus = path.join(target, 'corpora', 'acme');
  fs.mkdirSync(corpus, { recursive: true });
  fs.writeFileSync(path.join(corpus, 'own-1.json'), JSON.stringify({
    source: 'manual', captured_at: new Date().toISOString(),
    text: 'We are building an open content engine in public, one honest update at a time.',
    trust_class: 'untrusted-scraped', retention_class: 'retained',
  }));

  // Inject a host DNA seat (the §12.5-style seam — engine never calls an LLM itself, RD-2).
  const dnaSeat = async () => ({
    identity: 'A builder studio shipping in the open.',
    tone: 'Plainspoken, confident, kind.',
    voice: 'Short sentences. Concrete nouns. No hype.',
    do: ['Show the work'], do_not: ['Overpromise'],
    signature_moves: ['One honest update at a time'],
    drama_dial: 'medium',
  });

  const res = await ingestBrandVerb.run({ flags: { brand: 'acme', yes: true }, env, dnaSeat });
  assert.equal(res.ok, true);
  assert.equal(res.exitCode, 0);
  assert.match(res.data.generate_status, /generated/);
  const dna = fs.readFileSync(path.join(brandDir, 'brand-dna.md'), 'utf8');
  assert.match(dna, /A builder studio shipping in the open/);
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
