'use strict';

/**
 * tests/image-gen-provider.test.js  [N — image-gen provider seam coverage]
 *
 * Coverage for the image-GENERATION provider seam (engine/library/image-gen-provider.js; §12.5).
 * ZERO-KEY (RD-12): the child process (spawnSync) and the HTTP poster (httpPost) are injected, so
 * nothing real is spawned and no network is touched. The tests pin the seam's hardening contract:
 * a missing/unknown provider degrades or throws honestly, the CLI path reports byte counts (or
 * fails when the command produced no file), and the HTTP path persists the returned bytes.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const prov = require('../engine/library/image-gen-provider.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'oce-imggen-'));
}

// --- resolveProvider / hasProvider / resolveEndpointSecret ---------------------------------

test('resolveProvider returns null for absent/unknown kinds and a runnable provider for cli/http', () => {
  assert.equal(prov.resolveProvider(null), null);
  assert.equal(prov.resolveProvider({ kind: 'mystery' }), null);
  const cli = prov.resolveProvider({ kind: 'CLI', model: 'm', timeout_ms: 5000, options: { command: 'x' } });
  assert.equal(cli.kind, 'cli');
  assert.equal(cli.model, 'm');
  assert.equal(cli.timeoutMs, 5000);
  const def = prov.resolveProvider({ kind: 'http' });
  assert.equal(def.timeoutMs, prov.DEFAULT_TIMEOUT_MS);
});

test('hasProvider mirrors resolveProvider as a skip-decision predicate', () => {
  assert.equal(prov.hasProvider({ kind: 'cli', options: { command: 'x' } }), true);
  assert.equal(prov.hasProvider({}), false);
});

test('resolveEndpointSecret reads the named env var and is null when none is declared', () => {
  const provider = prov.resolveProvider({ kind: 'http', endpoint_env: 'IMG_KEY' });
  assert.equal(prov.resolveEndpointSecret(provider, { IMG_KEY: 'sekret' }), 'sekret');
  const noEnv = prov.resolveProvider({ kind: 'http' });
  assert.equal(prov.resolveEndpointSecret(noEnv, {}), null);
});

// --- runImageGen dispatch ------------------------------------------------------------------

test('runImageGen throws when no provider is configured', () => {
  assert.throws(() => prov.runImageGen({}), prov.ImageGenProviderError);
});

test('runImageGen throws on an unsupported provider kind', () => {
  assert.throws(
    () => prov.runImageGen({ provider: { kind: 'weird' }, prompt: 'p', outputPath: 'o.png' }),
    /unsupported image-generation provider kind/,
  );
});

// --- CLI provider --------------------------------------------------------------------------

test('cli provider requires options.command', () => {
  const provider = prov.resolveProvider({ kind: 'cli', options: {} });
  assert.throws(
    () => prov.runImageGen({ provider, prompt: 'p', outputPath: 'o.png', spawnSync: () => ({ status: 0 }) }),
    /requires options.command/,
  );
});

test('cli provider returns ok + byte count when the command produces a file', () => {
  const dir = tmpDir();
  const out = path.join(dir, 'sheet.png');
  const provider = prov.resolveProvider({ kind: 'cli', model: 'img-2', options: { command: 'gen', model_flag: '--model', style_anchor: path.join(dir, 'anchor.png') } });
  let received;
  const spawnSync = (cmd, args) => {
    received = { cmd, args };
    fs.writeFileSync(out, Buffer.from([1, 2, 3, 4]));
    return { status: 0, stdout: 'done', stderr: '' };
  };
  const res = prov.runImageGen({ provider, prompt: 'render', refs: ['ref.png'], outputPath: out, spawnSync, env: {} });
  assert.equal(res.ok, true);
  assert.equal(res.bytes, 4);
  // model flag + ref flags + output flag all reach the argv.
  assert.ok(received.args.includes('--model'));
  assert.ok(received.args.includes('--output'));
});

test('cli provider surfaces a spawn start error', () => {
  const provider = prov.resolveProvider({ kind: 'cli', options: { command: 'gen' } });
  const spawnSync = () => ({ error: new Error('ENOENT') });
  assert.throws(
    () => prov.runImageGen({ provider, prompt: 'p', outputPath: 'o.png', spawnSync, env: {} }),
    /failed to start/,
  );
});

test('cli provider surfaces a non-zero exit with the stderr tail', () => {
  const provider = prov.resolveProvider({ kind: 'cli', options: { command: 'gen' } });
  const spawnSync = () => ({ status: 3, stderr: 'boom' });
  assert.throws(
    () => prov.runImageGen({ provider, prompt: 'p', outputPath: 'o.png', spawnSync, env: {} }),
    /exited 3/,
  );
});

test('cli provider fails when the command reports success but writes no file', () => {
  const dir = tmpDir();
  const provider = prov.resolveProvider({ kind: 'cli', options: { command: 'gen' } });
  const spawnSync = () => ({ status: 0, stdout: '', stderr: '' });
  assert.throws(
    () => prov.runImageGen({ provider, prompt: 'p', outputPath: path.join(dir, 'missing.png'), spawnSync, env: {} }),
    /produced no file/,
  );
});

// --- HTTP provider -------------------------------------------------------------------------

test('http provider persists returned image_b64 bytes via an injected poster', () => {
  const dir = tmpDir();
  const out = path.join(dir, 'http.png');
  const provider = prov.resolveProvider({ kind: 'http', model: 'img', options: { url: 'https://example.test/gen' } });
  const httpPost = () => ({ image_b64: Buffer.from([9, 9, 9]).toString('base64') });
  const res = prov.runImageGen({ provider, prompt: 'p', outputPath: out, httpPost, env: {} });
  assert.equal(res.ok, true);
  assert.equal(res.bytes, 3);
  assert.equal(fs.readFileSync(out).length, 3);
});

test('http provider also accepts a raw Buffer from the poster', () => {
  const dir = tmpDir();
  const out = path.join(dir, 'http2.png');
  const provider = prov.resolveProvider({ kind: 'http', options: { url: 'https://example.test/gen' } });
  const httpPost = () => Buffer.from([1, 2]);
  const res = prov.runImageGen({ provider, prompt: 'p', outputPath: out, httpPost, env: {} });
  assert.equal(res.bytes, 2);
});

test('http provider throws when no URL resolves', () => {
  const provider = prov.resolveProvider({ kind: 'http', options: {} });
  assert.throws(
    () => prov.runImageGen({ provider, prompt: 'p', outputPath: 'o.png', httpPost: () => ({}), env: {} }),
    /requires a URL/,
  );
});

test('http provider throws when the poster returns no image bytes', () => {
  const provider = prov.resolveProvider({ kind: 'http', options: { url: 'https://example.test/gen' } });
  assert.throws(
    () => prov.runImageGen({ provider, prompt: 'p', outputPath: 'o.png', httpPost: () => ({ nope: true }), env: {} }),
    /no image bytes/,
  );
});

test('http provider throws when a reference image cannot be read', () => {
  const provider = prov.resolveProvider({ kind: 'http', options: { url: 'https://example.test/gen' } });
  assert.throws(
    () => prov.runImageGen({ provider, prompt: 'p', refs: ['/no/such/ref.png'], outputPath: 'o.png', httpPost: () => ({}), env: {} }),
    /could not read reference image/,
  );
});

test('the default http poster fails loudly (no bundled network client in v1)', () => {
  const dir = tmpDir();
  const provider = prov.resolveProvider({ kind: 'http', options: { url: 'https://example.test/gen' } });
  assert.throws(
    () => prov.runImageGen({ provider, prompt: 'p', outputPath: path.join(dir, 'x.png'), env: {} }),
    /needs an injected poster/,
  );
});
