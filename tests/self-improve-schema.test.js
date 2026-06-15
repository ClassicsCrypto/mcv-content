'use strict';

// tests/self-improve-schema.test.js
// Schema conformance for the SI-FIXTURES governed-loop fixtures (release-spec §16.5). Makes the
// "sub-validated in tests" binding note (scripts/validate-schemas.js) true: (1) the
// system.self-improve.json fragment's `self_improve` block validates against
// system.schema.json #/properties/self_improve (with the root passed so any $ref resolves), and
// (2) the learning-record fixtures conform to learning-record.schema.json.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const V = require('../scripts/validate-schemas.js');

test('self_improve config fragment validates against system.schema #/properties/self_improve', () => {
  const sys = JSON.parse(fs.readFileSync(path.join(REPO, 'schemas/config/system.schema.json'), 'utf8'));
  const sub = sys.properties && sys.properties.self_improve;
  assert.ok(sub, 'self_improve is declared in system.schema.json');
  const frag = JSON.parse(fs.readFileSync(path.join(REPO, 'fixtures/self-improve-acme/system.self-improve.json'), 'utf8'));
  const errors = [];
  const ok = V.validateNode(frag.self_improve, sub, sys, '', errors);
  assert.ok(ok && errors.length === 0, 'fragment.self_improve validates: ' + JSON.stringify(errors.slice(0, 3)));
});

test('self-improve learning-record fixtures conform to learning-record.schema.json', () => {
  const lr = JSON.parse(fs.readFileSync(path.join(REPO, 'schemas/artifacts/learning-record.schema.json'), 'utf8'));
  const dir = path.join(REPO, 'fixtures/self-improve-acme/learning-records');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  assert.ok(files.length > 0, 'there are learning-record fixtures to check');
  for (const f of files) {
    const rec = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    const errors = [];
    const ok = V.validateNode(rec, lr, lr, '', errors);
    assert.ok(ok && errors.length === 0, `${f} conforms to learning-record.schema.json: ` + JSON.stringify(errors.slice(0, 3)));
  }
});
