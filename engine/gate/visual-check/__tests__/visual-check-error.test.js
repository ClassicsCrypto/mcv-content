'use strict';

/**
 * Characterization test for the visual gate's TOOL-ERROR + DEGRADE-TO-SKIP contracts
 * (release-spec §14.1 visual layer; §12.5; §15.2). Ported from the production
 * visual-check-error characterization test, adapted to the public API (no codename, no
 * brand packs, no vendor-CLI coupling).
 *
 * Pins:
 *   - on a tool error (e.g. media not found) the gate ALWAYS writes a verdict JSON with
 *     vision_pass:null + VIS.CHECK_ERROR (consumers must treat null as NOT-pass);
 *   - with NO provider configured the gate DEGRADES TO SKIP — never crashes — returning
 *     PASS_PENDING_MEDIA + a soft VIS.SKIPPED_NO_PROVIDER that bars Recommended;
 *   - a provider that throws is caught and turned into VIS.CHECK_ERROR (never propagates).
 *
 * Runner: Node's built-in node:test (zero deps, no keys). CI wiring is batch P4.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { visualCheck } = require('../index');

function codes(result) {
  return result.detected_codes.map((d) => d.code);
}

test('no provider configured ⇒ degrade-to-skip (no crash), PASS_PENDING_MEDIA + soft VIS.SKIPPED_NO_PROVIDER', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-skip-'));
  try {
    const result = visualCheck(
      { content_id: 'test-vc-skip', media_path: 'whatever.png', brand: 'acme-cosmos' },
      { provider: null, outDir: tmp, env: {} },
    );
    assert.equal(result.stage, 'visual');
    assert.equal(result.verdict, 'PASS_PENDING_MEDIA');
    assert.deepEqual(codes(result), ['VIS.SKIPPED_NO_PROVIDER']);
    const skipCode = result.detected_codes[0];
    assert.equal(skipCode.tier, 'soft');
    assert.equal(skipCode.bars_recommended, true);
    assert.equal(result['x-visual'].skipped, true);
    assert.equal(result['x-visual'].vision_pass, null);
    // A durable verdict is still written on the skip path.
    const jsonPath = path.join(tmp, 'visual-check-test-vc-skip.json');
    assert.ok(fs.existsSync(jsonPath), 'skip path writes a durable verdict');
    const j = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    assert.equal(j.vision_pass, null);
    assert.equal(j.skipped, true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('tool error (media not found) ⇒ always-write vision_pass:null + VIS.CHECK_ERROR, verdict FAIL', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-err-'));
  try {
    const result = visualCheck(
      {
        content_id: 'test-vc-error',
        media_path: '__does_not_exist__.png',
        brand: 'acme-cosmos',
      },
      // A configured CLI provider so we get past the skip path and hit the media-not-found
      // check (which exits before any spawn — runs with no external dependency).
      { provider: { kind: 'cli', options: { command: 'true' } }, outDir: tmp, env: {} },
    );
    assert.equal(result.verdict, 'FAIL');
    assert.deepEqual(codes(result), ['VIS.CHECK_ERROR']);
    assert.equal(result['x-visual'].vision_pass, null);

    const jsonPath = path.join(tmp, 'visual-check-test-vc-error.json');
    assert.ok(fs.existsSync(jsonPath), 'verdict JSON is written even on a tool error');
    const j = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    assert.equal(j.vision_pass, null, 'vision_pass is null on a tool error');
    assert.match(String(j.error), /media not found/);
    assert.equal(j.content_id, 'test-vc-error');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('provider that throws ⇒ caught as VIS.CHECK_ERROR (never propagates)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-throw-'));
  const img = path.join(tmp, 'img.png');
  fs.writeFileSync(img, 'not-a-real-image');
  try {
    const result = visualCheck(
      { content_id: 'test-vc-throw', media_path: img, brand: 'acme-cosmos' },
      {
        provider: { kind: 'cli', options: { command: 'true' } },
        spawnSync: () => ({ error: new Error('spawn blew up') }),
        outDir: tmp,
        env: {},
      },
    );
    assert.equal(result.verdict, 'FAIL');
    assert.deepEqual(codes(result), ['VIS.CHECK_ERROR']);
    assert.equal(result['x-visual'].vision_pass, null);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('a non-zero provider exit ⇒ VIS.CHECK_ERROR with the stderr tail in the verdict', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-status-'));
  const img = path.join(tmp, 'img.png');
  fs.writeFileSync(img, 'x');
  try {
    const result = visualCheck(
      { content_id: 'test-vc-status', media_path: img, brand: 'acme-cosmos' },
      {
        provider: { kind: 'cli', options: { command: 'true' } },
        spawnSync: () => ({ status: 7, stdout: '', stderr: 'boom: the provider failed' }),
        outDir: tmp,
        env: {},
      },
    );
    assert.deepEqual(codes(result), ['VIS.CHECK_ERROR']);
    const j = JSON.parse(fs.readFileSync(path.join(tmp, 'visual-check-test-vc-status.json'), 'utf8'));
    assert.match(String(j.error), /exited 7/);
    assert.match(String(j.error), /boom/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
