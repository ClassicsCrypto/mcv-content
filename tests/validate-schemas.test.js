'use strict';

/**
 * tests/validate-schemas.test.js  [N — schema-validation CI gate coverage]
 *
 * Coverage for the JSON-schema validation gate (scripts/validate-schemas.js; §16.5). Offline +
 * zero-key (RD-12): the gate is run against the shipped schemas/ + fixtures/ (its real job), the
 * mini validator is exercised across its keyword subset, and the failure path is pinned with a
 * tiny synthetic schema+fixture in a throwaway root (so a real fixture is never broken to test it).
 *
 * The bar: the live gate is GREEN against the repo; a fixture that violates its bound schema fails
 * LOUDLY (exit 1); usage errors fail closed (exit 2); the validator never silently passes an
 * unsupported keyword.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const vs = require('../scripts/validate-schemas.js');

/** Run a thunk with stdout/stderr captured (the gate prints a summary). */
function capture(fn) {
  const out = [];
  const err = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (c) => { out.push(String(c)); return true; };
  process.stderr.write = (c) => { err.push(String(c)); return true; };
  try {
    const rv = fn();
    return { rv, stdout: out.join(''), stderr: err.join('') };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

// --- the live gate -------------------------------------------------------------------------

test('the gate is GREEN against the shipped schemas + fixtures (exit 0)', () => {
  const { rv, stdout } = capture(() => vs.run([]));
  assert.equal(rv, 0);
  assert.match(stdout, /all schemas parse and every bound fixture validates/);
});

test('--json emits a machine-readable report with ok:true', () => {
  const { rv, stdout } = capture(() => vs.run(['--json']));
  assert.equal(rv, 0);
  const report = JSON.parse(stdout);
  assert.equal(report.ok, true);
  assert.ok(report.schemas.length > 0);
  assert.ok(report.fixtures.length > 0);
});

test('--help prints usage and exits 0', () => {
  const { rv, stdout } = capture(() => vs.run(['--help']));
  assert.equal(rv, 0);
  assert.match(stdout, /validate-schemas/);
});

test('an unknown arg fails closed (exit 2)', () => {
  const { rv, stderr } = capture(() => vs.run(['--bogus']));
  assert.equal(rv, 2);
  assert.match(stderr, /unknown arg/);
});

test('an empty --root has no schemas or fixtures and still exits 0', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'oce-vs-empty-'));
  const { rv } = capture(() => vs.run(['--root', empty]));
  assert.equal(rv, 0);
});

test('a fixture that violates its bound schema fails LOUDLY (exit 1)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oce-vs-bad-'));
  fs.mkdirSync(path.join(root, 'schemas', 'config'), { recursive: true });
  fs.mkdirSync(path.join(root, 'fixtures', 'brand-acme'), { recursive: true });
  fs.writeFileSync(path.join(root, 'schemas', 'config', 'brand.schema.json'), JSON.stringify({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://open-content-engine.example/schemas/config/brand/v1',
    'x-stability': 'stable',
    type: 'object',
    required: ['name'],
    properties: { name: { type: 'string' } },
  }));
  // bound by p === 'fixtures/brand-acme/brand.json' — missing the required "name" => invalid.
  fs.writeFileSync(path.join(root, 'fixtures', 'brand-acme', 'brand.json'), JSON.stringify({ slug: 'acme' }));
  const { rv, stderr } = capture(() => vs.run(['--root', root]));
  assert.equal(rv, 1);
  assert.match(stderr, /FAILED/);
  assert.match(stderr, /missing required property "name"/);
});

// --- the mini validator --------------------------------------------------------------------

test('validate accepts a conforming instance and rejects a type mismatch', () => {
  const schema = { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'] };
  assert.equal(vs.validate({ n: 3 }, schema).ok, true);
  const bad = vs.validate({ n: 'three' }, schema);
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => /expected type integer/.test(e)));
});

test('validate enforces enum, const, string length/pattern, and number bounds', () => {
  assert.equal(vs.validate('a', { enum: ['a', 'b'] }).ok, true);
  assert.equal(vs.validate('z', { enum: ['a', 'b'] }).ok, false);
  assert.equal(vs.validate(5, { const: 5 }).ok, true);
  assert.equal(vs.validate('hi', { type: 'string', minLength: 3 }).ok, false);
  assert.equal(vs.validate('abc', { type: 'string', pattern: '^a' }).ok, true);
  assert.equal(vs.validate(11, { type: 'number', maximum: 10 }).ok, false);
  assert.equal(vs.validate(4, { type: 'number', exclusiveMinimum: 4 }).ok, false);
});

test('validate enforces array and object applicators', () => {
  assert.equal(vs.validate([1, 1], { type: 'array', uniqueItems: true }).ok, false);
  assert.equal(vs.validate([1, 2, 3], { type: 'array', items: { type: 'integer' }, minItems: 2 }).ok, true);
  assert.equal(vs.validate({ a: 1, extra: 2 }, { type: 'object', properties: { a: {} }, additionalProperties: false }).ok, false);
  // anyOf / oneOf / not / if-then-else.
  assert.equal(vs.validate(3, { anyOf: [{ type: 'string' }, { type: 'integer' }] }).ok, true);
  assert.equal(vs.validate(3, { oneOf: [{ type: 'integer' }, { minimum: 0 }] }).ok, false);
  assert.equal(vs.validate('x', { not: { type: 'integer' } }).ok, true);
  assert.equal(vs.validate(2, { if: { type: 'integer' }, then: { minimum: 5 } }).ok, false);
});

test('validate resolves local $ref and rejects an unsupported keyword loudly', () => {
  const schema = { $defs: { id: { type: 'string' } }, $ref: '#/$defs/id' };
  assert.equal(vs.validate('hello', schema).ok, true);
  // An unknown ASSERTION keyword must surface as a validator error, never a silent pass.
  const bad = vs.validate({}, { unknownAssertion: true });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => /unsupported schema keyword/.test(e)));
});

// --- loadSchema structural self-check ------------------------------------------------------

test('loadSchema reports parse + metadata + structural defects', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oce-vs-schema-'));
  const notJson = path.join(dir, 'a.json');
  fs.writeFileSync(notJson, '{nope');
  assert.equal(vs.loadSchema(notJson).ok, false);

  const missingMeta = path.join(dir, 'b.json');
  fs.writeFileSync(missingMeta, JSON.stringify({ type: 'object' }));
  const r = vs.loadSchema(missingMeta);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /\$schema must be draft-2020-12/.test(e)));
  assert.ok(r.errors.some((e) => /\$id must be a versioned id/.test(e)));
  assert.ok(r.errors.some((e) => /x-stability/.test(e)));

  const sound = path.join(dir, 'c.json');
  fs.writeFileSync(sound, JSON.stringify({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://open-content-engine.example/schemas/x/v1',
    'x-stability': 'experimental',
    type: 'object',
  }));
  assert.equal(vs.loadSchema(sound).ok, true);
});

test('discovery helpers find the shipped schemas and fixtures', () => {
  const repoRoot = path.join(__dirname, '..');
  assert.ok(vs.findSchemas(repoRoot).length > 0);
  assert.ok(vs.findFixtureFiles(repoRoot).length > 0);
  assert.ok(vs.buildBindings().length > 0);
});
