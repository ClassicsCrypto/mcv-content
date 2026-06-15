'use strict';

// tests/improvement-sharing-schema.test.js
// Makes the validate-schemas "sub-validated in tests" binding note true (§16.5): the
// system.improvement-sharing.json fragment's `improvement_sharing` block validates against
// system.schema.json #/properties/improvement_sharing (root passed so any $ref resolves).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const V = require('../scripts/validate-schemas.js');

test('improvement_sharing config fragment validates against system.schema #/properties/improvement_sharing', () => {
  const sys = JSON.parse(fs.readFileSync(path.join(REPO, 'schemas/config/system.schema.json'), 'utf8'));
  const sub = sys.properties && sys.properties.improvement_sharing;
  assert.ok(sub, 'improvement_sharing is declared in system.schema.json');
  const frag = JSON.parse(fs.readFileSync(path.join(REPO, 'fixtures/improvement-sharing-acme/system.improvement-sharing.json'), 'utf8'));
  const errors = [];
  const ok = V.validateNode(frag.improvement_sharing, sub, sys, '', errors);
  assert.ok(ok && errors.length === 0, 'fragment.improvement_sharing validates: ' + JSON.stringify(errors.slice(0, 3)));
});
