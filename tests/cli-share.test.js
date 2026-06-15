'use strict';

/**
 * tests/cli-share.test.js  [N — IS-CLI verb smoke]
 *
 * Smoke coverage for the IMPROVEMENT-SHARING CLI verbs wired into the dispatcher (bin/engine.js):
 *   - `engine share`                 (engine/cli/share.js)                — the OUTBOUND/operator side
 *   - `engine evaluate-contribution` (engine/cli/evaluate-contribution.js) — the INBOUND/maintainer side
 *
 * The bar these tests pin (the DD-7 LAW): improvement-sharing is OFF by default; `share` DEFAULTS to
 * REVIEW (sanitize + SHOW the exact abstract payload, write/transmit NOTHING); --prepare requires
 * explicit --yes consent; there is NO auto-send path; the maintainer harness ACCEPTS a clean
 * gate-neutral contribution and REJECTS a gate-loosener / human-only one, and NEVER auto-merges.
 * Honest exit codes throughout. Deterministic + zero-key (RD-12): no API calls, no network; records
 * + contributions come from the synthetic Acme fixtures or a throwaway $CONTENT_HOME.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const engine = require('../bin/engine.js');
const shareVerb = require('../engine/cli/share.js');
const evalVerb = require('../engine/cli/evaluate-contribution.js');

const FIX = path.join(__dirname, '..', 'fixtures', 'improvement-sharing-acme');
const cleanRecord = () => JSON.parse(fs.readFileSync(path.join(FIX, 'outbound', 'lr-clean-abstract.json'), 'utf8'));

/**
 * A clean, harness-shaped INBOUND contribution: the canonical { kind:'rule-diff', target, change }
 * shape engine/improvement-sharing/evaluate.js accepts (mirrors that module's own cleanContribution).
 * Gate-neutral, allowlisted, specifics-free — so the harness ACCEPTS it (admissible for manual review,
 * never auto-merged). We build it in-test rather than depending on the IS-FIXTURES contrib-clean-accept
 * file, which carries a $comment documentation field that the harness's deep specifics scan flags and
 * omits the top-level kind:'rule-diff' discriminator — that is an IS-FIXTURES shape defect, not a CLI
 * concern; the CLI must surface the harness verdict faithfully (never weaken it — DD-7 governance).
 */
function cleanInbound() {
  return {
    kind: 'rule-diff',
    target: { kind: 'calendar-weighting' },
    change: { op: 'increase_weight', values: { 'theme-explainer': 0.6 } },
    rationale: 'Generalizable: this content type tends to outperform on a rolling window; raise its calendar weighting.',
  };
}

function enabledConfig(over = {}) {
  return {
    improvement_sharing: {
      enabled: true,
      share: { payload_kind: 'abstract_rule_diff' },
      require_operator_confirmation: true,
      ...over,
    },
  };
}
function disabledConfig() {
  return { improvement_sharing: { enabled: false } };
}

function tempHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oce-cli-is-'));
  return { CONTENT_HOME: home };
}

async function capture(fn) {
  const outChunks = []; const errChunks = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (c) => { outChunks.push(String(c)); return true; };
  process.stderr.write = (c) => { errChunks.push(String(c)); return true; };
  try { const code = await fn(); return { code, stdout: outChunks.join(''), stderr: errChunks.join('') }; }
  finally { process.stdout.write = origOut; process.stderr.write = origErr; }
}

// ---------------------------------------------------------------------------
// registration + help routing
// ---------------------------------------------------------------------------

test('share + evaluate-contribution are registered verbs with --help (exit 0)', async () => {
  assert.ok(engine.VERB_ORDER.includes('share'));
  assert.ok(engine.VERB_ORDER.includes('evaluate-contribution'));
  for (const verb of ['share', 'evaluate-contribution']) {
    const { code, stdout } = await capture(() => engine.main(['node', 'engine.js', verb, '--help']));
    assert.equal(code, 0, `${verb} --help exits 0`);
    assert.ok(stdout.length > 0);
  }
});

// ---------------------------------------------------------------------------
// engine share — OFF by default (DD-7 (1))
// ---------------------------------------------------------------------------

test('share is OFF by default — clean no-op, exit 0, prepares + transmits nothing', () => {
  const res = shareVerb.run({ flags: { record: 'r1' }, env: tempHome(), config: disabledConfig(), record: cleanRecord() });
  assert.equal(res.ok, true);
  assert.equal(res.exitCode, 0);
  assert.equal(res.data.mode, 'disabled');
  assert.equal(res.data.enabled, false);
  assert.match(res.summary, /OFF by default/i);
});

// ---------------------------------------------------------------------------
// engine share — DEFAULT is REVIEW (sanitize + show, write nothing) (DD-7 (3))
// ---------------------------------------------------------------------------

test('share DEFAULTS to review: sanitizes + shows the exact payload, writes nothing', () => {
  const env = tempHome();
  const res = shareVerb.run({ flags: { record: 'r1' }, env, config: enabledConfig(), record: cleanRecord() });
  assert.equal(res.ok, true);
  assert.equal(res.exitCode, 0);
  assert.equal(res.data.mode, 'review');
  assert.equal(res.data.written, false);
  assert.equal(res.data.path, null);
  // The preview is the EXACT package that would be shared — an abstract rule-diff + provenance.
  assert.ok(res.data.preview && typeof res.data.preview === 'object');
  assert.equal(res.data.preview.provenance.transport, 'manual-pr-only');
  // Nothing was written to disk (no contributions/ dir created).
  assert.equal(fs.existsSync(path.join(env.CONTENT_HOME, 'contributions')), false);
  // The verbatim sanitized payload carries no brand/handle/snowflake/path — it round-trips the guard.
  const sanitize = require('../engine/improvement-sharing/sanitize.js');
  assert.doesNotThrow(() => sanitize.assertShareable(res.data.preview.rule_diff || res.data.preview));
});

test('share --prepare WITHOUT --yes is a usage error (exit 2), writes nothing (DD-7 (3) consent)', () => {
  const env = tempHome();
  const res = shareVerb.run({ flags: { record: 'r1', prepare: true }, env, config: enabledConfig(), record: cleanRecord() });
  assert.equal(res.ok, false);
  assert.equal(res.exitCode, 2);
  assert.match(res.summary, /requires explicit consent/i);
  assert.equal(fs.existsSync(path.join(env.CONTENT_HOME, 'contributions')), false);
});

// ---------------------------------------------------------------------------
// engine share --prepare --yes — WRITES a LOCAL package only (no transmit) (DD-7 (1))
// ---------------------------------------------------------------------------

test('share --prepare --yes writes a LOCAL contribution package (and transmits nothing)', () => {
  const env = tempHome();
  const now = Date.UTC(2099, 4, 2);
  const res = shareVerb.run(
    { flags: { record: 'r1', prepare: true, yes: true }, env, config: enabledConfig(), record: cleanRecord(), now },
  );
  assert.equal(res.ok, true);
  assert.equal(res.exitCode, 0);
  assert.equal(res.data.mode, 'written');
  assert.equal(res.data.written, true);
  assert.ok(res.data.path, 'a local package path was returned');
  assert.ok(fs.existsSync(res.data.path), 'the package file exists on disk');
  // The written file is the abstract contribution package — and it has no transmit metadata.
  const pkg = JSON.parse(fs.readFileSync(res.data.path, 'utf8'));
  assert.equal(pkg.provenance.transport, 'manual-pr-only');
  assert.equal(pkg.schema, 'improvement-contribution');
  assert.match(res.summary, /NOTHING was transmitted/i);
});

test('share requires --record when no record is injected (exit 2 usage)', () => {
  const res = shareVerb.run({ flags: {}, env: tempHome(), config: enabledConfig() });
  assert.equal(res.ok, false);
  assert.equal(res.exitCode, 2);
  assert.match(res.summary, /--record/);
});

test('share resolves a learning record from $CONTENT_HOME/learning/applied/<id>.json', () => {
  const env = tempHome();
  const appliedDir = path.join(env.CONTENT_HOME, 'learning', 'applied');
  fs.mkdirSync(appliedDir, { recursive: true });
  const rec = cleanRecord();
  fs.writeFileSync(path.join(appliedDir, `${rec.id}.json`), JSON.stringify(rec));
  const res = shareVerb.run({ flags: { record: rec.id }, env, config: enabledConfig() });
  assert.equal(res.ok, true);
  assert.equal(res.data.mode, 'review');
  assert.ok(res.data.preview);
});

test('share fails (exit 1) when --record names a record that does not exist', () => {
  const res = shareVerb.run({ flags: { record: 'does-not-exist' }, env: tempHome(), config: enabledConfig() });
  assert.equal(res.ok, false);
  assert.equal(res.exitCode, 1);
  assert.match(res.summary, /could not resolve/i);
});

// ---------------------------------------------------------------------------
// the no-auto-send LAW is structurally provable on the real IS-CONSENT module
// ---------------------------------------------------------------------------

test('the consent/package module references NO transport (no auto-send path, DD-7 (1))', () => {
  const pkgMod = require('../engine/improvement-sharing/package.js');
  // assertNoAutoSendPath reads the real module source and proves it requires no http/https/net/.../fetch.
  assert.doesNotThrow(() => pkgMod.assertNoAutoSendPath());
});

// ---------------------------------------------------------------------------
// engine evaluate-contribution — ACCEPT a clean gate-neutral contribution
// ---------------------------------------------------------------------------

test('evaluate-contribution ACCEPTS a clean, gate-neutral, allowlisted contribution (exit 0, NOT a merge)', () => {
  const res = evalVerb.run({ flags: { 'skip-gate-regression': true }, env: { PATH: process.env.PATH }, contribution: cleanInbound() });
  assert.equal(res.ok, true);
  assert.equal(res.exitCode, 0);
  assert.match(res.summary, /ACCEPTED/);
  assert.equal(res.data.accepted, true);
  assert.equal(res.data.auto_merge, false); // NEVER auto-merge (DD-7 (4))
});

// ---------------------------------------------------------------------------
// engine evaluate-contribution — REJECT a gate-loosener (ENEVERLOOSEN) and a human-only target
// ---------------------------------------------------------------------------

test('evaluate-contribution REJECTS a gate-loosening contribution (exit 1, never auto-merge)', () => {
  const contribution = JSON.parse(fs.readFileSync(path.join(FIX, 'inbound', 'contrib-loosens-gate.json'), 'utf8'));
  const res = evalVerb.run({ flags: { 'skip-gate-regression': true }, env: { PATH: process.env.PATH }, contribution });
  assert.equal(res.ok, false);
  assert.equal(res.exitCode, 1);
  assert.match(res.summary, /REJECTED/);
  assert.equal(res.data.accepted, false);
  assert.equal(res.data.auto_merge, false);
  // a never-loosen rejection is in the reasons.
  assert.match(JSON.stringify(res.data.reasons), /loosen/i);
});

test('evaluate-contribution REJECTS a human-only target (exit 1)', () => {
  const contribution = JSON.parse(fs.readFileSync(path.join(FIX, 'inbound', 'contrib-targets-human-only.json'), 'utf8'));
  const res = evalVerb.run({ flags: { 'skip-gate-regression': true }, env: { PATH: process.env.PATH }, contribution });
  assert.equal(res.ok, false);
  assert.equal(res.exitCode, 1);
  assert.equal(res.data.accepted, false);
  assert.match(JSON.stringify(res.data.reasons), /human-only/i);
});

// ---------------------------------------------------------------------------
// engine evaluate-contribution — file reading + usage errors
// ---------------------------------------------------------------------------

test('evaluate-contribution reads an inbound contribution from a file path', () => {
  const home = tempHome().CONTENT_HOME;
  const file = path.join(home, 'contrib.json');
  fs.writeFileSync(file, JSON.stringify(cleanInbound()));
  const res = evalVerb.run({ flags: { 'skip-gate-regression': true }, positionals: [file], env: { PATH: process.env.PATH } });
  assert.equal(res.ok, true);
  assert.equal(res.exitCode, 0);
  assert.match(JSON.stringify(res.detail), /contrib\.json/);
});

test('evaluate-contribution needs a <file> argument when none injected (exit 2 usage)', () => {
  const res = evalVerb.run({ flags: {}, positionals: [], env: { PATH: process.env.PATH } });
  assert.equal(res.ok, false);
  assert.equal(res.exitCode, 2);
  assert.match(res.summary, /<file>/);
});

test('evaluate-contribution on unparseable JSON is a usage error (exit 2)', () => {
  const home = tempHome().CONTENT_HOME;
  const bad = path.join(home, 'bad.json');
  fs.writeFileSync(bad, '{ not json');
  const res = evalVerb.run({ flags: {}, positionals: [bad], env: { PATH: process.env.PATH } });
  assert.equal(res.ok, false);
  assert.equal(res.exitCode, 2);
  assert.match(res.summary, /not valid JSON/);
});

// ---------------------------------------------------------------------------
// dispatcher routing — both verbs route through main() with honest exit codes
// ---------------------------------------------------------------------------

test('evaluate-contribution routes through main(): ACCEPT → exit 0, REJECT → exit 1', async () => {
  const home = tempHome().CONTENT_HOME;
  const accept = path.join(home, 'accept.json');
  fs.writeFileSync(accept, JSON.stringify(cleanInbound()));
  const reject = path.join(FIX, 'inbound', 'contrib-loosens-gate.json'); // a clean payload but a gate-loosener
  const a = await capture(() => engine.main(['node', 'engine.js', 'evaluate-contribution', accept, '--skip-gate-regression']));
  assert.equal(a.code, 0, `accept stdout:\n${a.stdout}`);
  assert.match(a.stdout, /ACCEPTED/);
  const r = await capture(() => engine.main(['node', 'engine.js', 'evaluate-contribution', reject, '--skip-gate-regression']));
  assert.equal(r.code, 1);
  assert.match(r.stdout, /REJECTED/);
});

test('share routes through main() and is OFF by default in a CONTENT_HOME-free run (exit 0 no-op)', async () => {
  // No CONTENT_HOME + no config => loadSystemConfig returns {} => improvement_sharing disabled => no-op.
  const { code, stdout } = await capture(() =>
    engine.main(['node', 'engine.js', 'share', '--record', 'r1']));
  assert.equal(code, 0, `stdout:\n${stdout}`);
  assert.match(stdout, /OFF by default/i);
});
