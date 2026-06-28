'use strict';

/**
 * tests/pre-gate-lint-cli.test.js  [N — pre-gate-lint CLI entrypoint coverage]
 *
 * The gate pipeline imports lint() and never shells out, so the `require.main` CLI block + the
 * synthetic self-test are untested by the in-process suite. This drives them as a child process
 * (coverage merges via the inherited NODE_V8_COVERAGE the test runner sets). ZERO-KEY, no network,
 * synthetic Acme-Cosmos copy only (§0.3 r6): the draft/brief/rules are temp fixtures.
 *
 * The bar: --selftest is green; a clean draft advances (exit 0); a hard em-dash draft FAILs
 * (exit 1, no LLM-gate spend); usage errors (no draft / bad JSON) fail CLOSED with exit 2.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'engine', 'gate', 'pre-gate-lint.js');

function runCli(args) {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    return { status: err.status, stdout: String(err.stdout || ''), stderr: String(err.stderr || '') };
  }
}

function writeJson(dir, name, obj) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
  return p;
}

const cleanDraft = {
  content_id: 'cli-clean',
  brand: 'acme-cosmos',
  platform: 'twitter',
  format: 'text',
  variants: [
    { label: 'recommended', text: 'The Acme Cosmos beta wrapped with 60 builders shipping live demos.' },
    { label: 'variant-a', text: 'Sixty builders. One weekend. Every demo went out as a working link.' },
    { label: 'variant-b', text: 'We asked for working demos and got sixty. Here is what the beta produced.' },
  ],
};

const hardDraft = {
  content_id: 'cli-hard',
  brand: 'acme-cosmos',
  platform: 'twitter',
  format: 'text',
  variants: [
    { label: 'recommended', text: 'The beta wrapped—and the demos shipped live for everyone to use.' },
    { label: 'variant-a', text: 'Sixty builders showed up and every single demo went out as a link.' },
    { label: 'variant-b', text: 'We asked for working demos. Sixty arrived. Here is the full recap.' },
  ],
};

test('--selftest runs the synthetic self-test green (exit 0)', () => {
  const r = runCli(['--selftest']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /PASS: pre-gate-lint self-test green/);
});

test('a clean draft advances to the LLM gate (exit 0), honoring --brief and --rules', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oce-pgl-'));
  const draft = writeJson(dir, 'clean.json', cleanDraft);
  const brief = writeJson(dir, 'brief.json', { target_chars: 280, historical_entities: ['Acme Cosmos'] });
  const rules = writeJson(dir, 'rules.json', { banned_patterns: ['totally-absent-phrase'] });
  const r = runCli(['--draft', draft, '--brief', brief, '--rules', rules, '--json']);
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.notEqual(out.verdict, 'FAIL');
});

test('a hard em-dash draft FAILs the pre-gate (exit 1, no LLM-gate spend)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oce-pgl-'));
  const draft = writeJson(dir, 'hard.json', hardDraft);
  const r = runCli(['--draft', draft]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /FAIL — return to writer/);
});

test('a missing --draft is a usage error (exit 2)', () => {
  const r = runCli([]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--draft <draft.json> required/);
});

test('a non-JSON --draft is a usage error (exit 2)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oce-pgl-'));
  const bad = path.join(dir, 'bad.json');
  fs.writeFileSync(bad, '{not valid json');
  const r = runCli(['--draft', bad]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /not valid JSON/);
});
