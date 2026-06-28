'use strict';

/**
 * engine/gate/__tests__/privacy-leak-cli.test.js  [N — privacy-leak CLI entrypoint coverage]
 *
 * The gate pipeline imports checkPrivacy() and never shells out, so the `require.main` CLI block +
 * the synthetic self-test live untested by the in-process suite. This file drives them as a child
 * process (coverage merges via the inherited NODE_V8_COVERAGE the test runner sets). ZERO-KEY,
 * no network, synthetic Acme-Cosmos copy only (§0.3 r6): the draft/seed/config are temp fixtures.
 *
 * The bar: --selftest is green; a clean draft PASSes (exit 0); a draft carrying a secret-shape is
 * blocked (exit 1); usage errors (no draft / bad JSON) fail CLOSED with exit 2.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'privacy-leak.js');

/** Run the CLI, returning { status, stdout, stderr } without throwing on a non-zero exit. */
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
    { label: 'recommended', text: 'The Acme Cosmos beta wrapped with sixty builders shipping live demos.' },
    { label: 'variant-a', text: 'Sixty builders shipped working demos at the Acme Cosmos beta this week.' },
    { label: 'variant-b', text: 'We asked for working demos and sixty arrived. Here is the recap.' },
  ],
};

const leakDraft = {
  content_id: 'cli-leak',
  brand: 'acme-cosmos',
  platform: 'twitter',
  format: 'text',
  variants: [
    { label: 'recommended', text: 'Shipped the deploy with token abcDEF123456ghiJKL789012mnoPQR345678stuVWX live' },
    { label: 'variant-a', text: 'Sixty builders shipped working demos at the Acme Cosmos beta this week.' },
    { label: 'variant-b', text: 'We asked for working demos and sixty arrived. Here is the recap.' },
  ],
};

test('--selftest runs the synthetic self-test green (exit 0)', () => {
  const r = runCli(['--selftest']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /PASS: privacy-leak self-test green/);
});

test('a clean draft PASSes with --json (exit 0)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oce-pl-'));
  const draft = writeJson(dir, 'clean.json', cleanDraft);
  const r = runCli(['--draft', draft, '--json']);
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.verdict, 'PASS');
});

test('a draft carrying a secret-shape is blocked (exit 1, human-readable output)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oce-pl-'));
  const draft = writeJson(dir, 'leak.json', leakDraft);
  const r = runCli(['--draft', draft]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /FAIL — leak blocked/);
});

test('a configured private term carried via --seed and --config is blocked', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oce-pl-'));
  const draft = writeJson(dir, 'term.json', {
    ...cleanDraft,
    variants: [{ label: 'recommended', text: 'Big news: we partnered with Stardust Partners on the launch' }, ...cleanDraft.variants.slice(1)],
  });
  const seed = writeJson(dir, 'seed.json', { source: 'work-recap', private_terms: ['Stardust Partners'] });
  const config = writeJson(dir, 'config.json', { work_recap: { private_terms: ['Stardust Partners'] } });
  const r = runCli(['--draft', draft, '--seed', seed, '--config', config]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /FAIL/);
});

test('a missing --draft is a usage error (exit 2)', () => {
  const r = runCli([]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--draft <draft.json> required/);
});

test('a non-JSON --draft is a usage error (exit 2)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oce-pl-'));
  const bad = path.join(dir, 'bad.json');
  fs.writeFileSync(bad, '{not valid json');
  const r = runCli(['--draft', bad]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /not valid JSON/);
});
