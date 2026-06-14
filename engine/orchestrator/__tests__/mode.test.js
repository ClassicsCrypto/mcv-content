'use strict';

/**
 * Tests for engine/orchestrator/mode.js (release-spec §8.3 mode ladder; RD-16f default SAFE).
 * Zero-key, no I/O — mode.js is pure. node:test + node:assert only.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const mode = require('../mode');

test('default falls closed to SAFE when nothing is set (RD-16f)', () => {
  const r = mode.resolveMode({ env: {} });
  assert.equal(r.mode, 'SAFE');
  assert.equal(r.source, 'default');
  assert.equal(r.invalid, false);
});

test('precedence: override > env > config > default', () => {
  assert.equal(mode.resolveMode({ override: 'LIVE', env: { ENGINE_MODE: 'SAFE' }, config: { mode: 'LIVE_PREVIEW' } }).mode, 'LIVE');
  assert.equal(mode.resolveMode({ env: { ENGINE_MODE: 'LIVE_PREVIEW' }, config: { mode: 'LIVE' } }).mode, 'LIVE_PREVIEW');
  assert.equal(mode.resolveMode({ env: {}, config: { mode: 'LIVE' } }).mode, 'LIVE');
});

test('env override is reported as source env (loud-diagnostic, §4.5)', () => {
  const r = mode.resolveMode({ env: { ENGINE_MODE: 'LIVE' }, config: { mode: 'SAFE' } });
  assert.equal(r.mode, 'LIVE');
  assert.equal(r.source, 'env');
});

test('unknown value falls CLOSED to SAFE and flags invalid', () => {
  const r = mode.resolveMode({ override: 'YOLO', env: {} });
  assert.equal(r.mode, 'SAFE');
  assert.equal(r.invalid, true);
});

test('normalizeMode is case-insensitive and trims', () => {
  assert.equal(mode.normalizeMode('  live  '), 'LIVE');
  assert.equal(mode.normalizeMode('Live_Preview'), 'LIVE_PREVIEW');
  assert.equal(mode.normalizeMode(null), 'SAFE');
  assert.equal(mode.normalizeMode('nope'), 'SAFE');
});

test('behavior contract: only LIVE calls the publisher; SAFE posts no cards', () => {
  assert.equal(mode.postsCards('SAFE'), false);
  assert.equal(mode.callsPublisher('SAFE'), false);
  assert.equal(mode.postsCards('LIVE_PREVIEW'), true);
  assert.equal(mode.callsPublisher('LIVE_PREVIEW'), false);
  assert.equal(mode.postsCards('LIVE'), true);
  assert.equal(mode.callsPublisher('LIVE'), true);
  // LIVE is draft-only by default (the second gate).
  assert.equal(mode.behaviorFor('LIVE').draft_only, true);
});

test('atLeast compares ladder permissiveness', () => {
  assert.equal(mode.atLeast('LIVE', 'LIVE_PREVIEW'), true);
  assert.equal(mode.atLeast('SAFE', 'LIVE_PREVIEW'), false);
  assert.equal(mode.atLeast('LIVE_PREVIEW', 'LIVE_PREVIEW'), true);
});

test('setMode returns a new command with a normalized mode (no mutation)', () => {
  const cmd = { command_family: 'RUN_SLOT', mode: 'SAFE' };
  const next = mode.setMode(cmd, 'live');
  assert.equal(next.mode, 'LIVE');
  assert.equal(cmd.mode, 'SAFE'); // original untouched
});
