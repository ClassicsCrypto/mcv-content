'use strict';

/**
 * engine/gate/visual-check/__tests__/provider.test.js  [N — vision provider HTTP/edge coverage]
 *
 * Focused coverage for the vision-provider seam (engine/gate/visual-check/provider.js; §12.5). The
 * CLI path + resolveProvider are exercised by the visual-check gate tests; this file pins the
 * remaining seam surface ZERO-KEY (RD-12): hasProvider, the endpoint-secret resolver, the HTTP
 * provider (with an injected poster — no network), and the loud no-bundled-client default.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const prov = require('../provider.js');

function tmpImage() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oce-vision-'));
  const img = path.join(dir, 'shot.png');
  fs.writeFileSync(img, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  return img;
}

test('hasProvider is true only for a resolvable cli/http block', () => {
  assert.equal(prov.hasProvider({ kind: 'http', options: { url: 'https://x.test' } }), true);
  assert.equal(prov.hasProvider({ kind: 'nope' }), false);
});

test('resolveEndpointSecret reads the named env var, null when undeclared', () => {
  const provider = prov.resolveProvider({ kind: 'http', endpoint_env: 'VISION_KEY' });
  assert.equal(prov.resolveEndpointSecret(provider, { VISION_KEY: 'abc' }), 'abc');
  assert.equal(prov.resolveEndpointSecret(prov.resolveProvider({ kind: 'http' }), {}), null);
});

test('runVision throws on an unsupported kind', () => {
  assert.throws(
    () => prov.runVision({ kind: 'weird' }, { prompt: 'q', imagePath: 'x' }),
    /unsupported vision provider kind/,
  );
});

test('http provider posts prompt + base64 image and returns the poster answer', () => {
  const img = tmpImage();
  const provider = prov.resolveProvider({ kind: 'http', model: 'v', options: { url: 'https://vision.test/ask' } });
  let posted;
  const httpPost = (req) => { posted = JSON.parse(req.body); return 'PASS'; };
  const out = prov.runVision(provider, { prompt: 'is this on brand?', imagePath: img, httpPost, env: {} });
  assert.equal(out, 'PASS');
  assert.equal(posted.model, 'v');
  assert.ok(posted.image_b64 && posted.image_b64.length > 0);
});

test('http provider attaches a Bearer header when a credential resolves and url comes from options', () => {
  const img = tmpImage();
  const provider = prov.resolveProvider({ kind: 'http', endpoint_env: 'VISION_KEY', options: { url: 'https://vision.test/ask' } });
  let headers;
  const httpPost = (req) => { headers = req.headers; return 'ok'; };
  prov.runVision(provider, { prompt: 'q', imagePath: img, httpPost, env: { VISION_KEY: 'tok' } });
  assert.equal(headers.authorization, 'Bearer tok');
});

test('http provider throws when no URL resolves', () => {
  const provider = prov.resolveProvider({ kind: 'http', options: {} });
  assert.throws(
    () => prov.runVision(provider, { prompt: 'q', imagePath: tmpImage(), httpPost: () => 'x', env: {} }),
    /requires a URL/,
  );
});

test('http provider throws when the image cannot be read', () => {
  const provider = prov.resolveProvider({ kind: 'http', options: { url: 'https://vision.test/ask' } });
  assert.throws(
    () => prov.runVision(provider, { prompt: 'q', imagePath: '/no/such/image.png', httpPost: () => 'x', env: {} }),
    /could not read image/,
  );
});

test('the default http poster fails loudly (no bundled client in v1)', () => {
  const provider = prov.resolveProvider({ kind: 'http', options: { url: 'https://vision.test/ask' } });
  assert.throws(
    () => prov.runVision(provider, { prompt: 'q', imagePath: tmpImage(), env: {} }),
    /needs an injected poster/,
  );
});
