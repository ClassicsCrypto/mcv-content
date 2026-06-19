'use strict';

/**
 * tests/setup-providers.test.js  [N — new tests, SETUP-MEDIA-MODELS]
 *
 * Covers media-model detection (engine/setup/providers.js), the video-generation seam
 * (engine/library/video-provider.js — Hyperframes-ready), and the flow's media_models attachment
 * (release-spec §12.5 provider seams; the setup driver's model-detection step). The guarantees:
 *   - detection reports which §12.5 seams (vision / image-gen / video) are configured, honoring both
 *     the canonical `providers.*` block AND the legacy top-level aliases the runtime code reads;
 *   - it NEVER leaks a credential value — only the env-var NAME (endpoint_env);
 *   - the video seam resolves cli/http and degrades to skip on an absent/unknown kind;
 *   - the C4 + done frames carry a schema-valid media_models block.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const providersMod = require('../engine/setup/providers.js');
const videoProvider = require('../engine/library/video-provider.js');
const flow = require('../engine/setup/flow.js');
const setupState = require('../engine/setup/setup-state.js');
const { validate } = require('../scripts/validate-schemas.js');
const FRAME_SCHEMA = require('../schemas/artifacts/setup-frame.schema.json');

function initHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oce-prov-'));
  const env = { CONTENT_HOME: home };
  require('../engine/setup/init.js').initHome({ home, env });
  return { home, env };
}

test('detectProviders: empty config ⇒ nothing configured, all degrade to optional', () => {
  const d = providersMod.detectProviders({ config: {} });
  assert.equal(d.any_configured, false);
  assert.equal(d.visual.configured, false);
  assert.equal(d.image_gen.configured, false);
  assert.equal(d.video.configured, false);
});

test('detectProviders: canonical providers.* block + legacy aliases both detected, with source labels', () => {
  const cfg = {
    providers: {
      visual: { kind: 'cli', model: 'v', options: { command: 'x' } },
      video: { kind: 'http', model: 'hf-1', endpoint_env: 'HYPERFRAMES_API_KEY', options: { url: 'https://e' } },
    },
    image_gen: { kind: 'cli', model: 'img', options: { command: 'codex' } }, // legacy top-level alias
  };
  const d = providersMod.detectProviders({ config: cfg });
  assert.equal(d.any_configured, true);
  assert.equal(d.visual.configured, true);
  assert.equal(d.visual.source, 'providers.visual');
  assert.equal(d.image_gen.configured, true);
  assert.equal(d.image_gen.source, 'image_gen'); // detected via the legacy alias
  assert.equal(d.video.configured, true);
  assert.equal(d.video.source, 'providers.video');
  assert.equal(d.video.model, 'hf-1');
});

test('detection NEVER leaks a credential value — only the env-var NAME', () => {
  const cfg = { providers: { image_gen: { kind: 'http', endpoint_env: 'OPENAI_API_KEY', options: { url: 'https://api' } } } };
  const d = providersMod.detectProviders({ config: cfg, env: { OPENAI_API_KEY: 'REDACTME-not-a-real-key-value' } });
  const blob = JSON.stringify(d);
  assert.ok(!blob.includes('REDACTME-not-a-real-key-value'), 'no credential value may appear in the detection result');
  assert.equal(d.image_gen.endpoint_env, 'OPENAI_API_KEY'); // the NAME is fine to surface
});

test('video-provider seam: resolves cli/http, degrades to skip on absent/unknown kind', () => {
  assert.equal(videoProvider.hasProvider(null), false);
  assert.equal(videoProvider.hasProvider({ kind: 'nope' }), false);
  assert.equal(videoProvider.hasProvider({ kind: 'http', model: 'm', options: { url: 'https://x' } }), true);
  const r = videoProvider.resolveProvider({ kind: 'http', model: 'hf', endpoint_env: 'HYPERFRAMES_API_KEY' });
  assert.equal(r.kind, 'http');
  assert.equal(r.model, 'hf');
  assert.equal(r.endpointEnv, 'HYPERFRAMES_API_KEY');
  // The shipped Hyperframes reference is an env NAME only — never a value.
  assert.equal(videoProvider.HYPERFRAMES_REFERENCE.endpoint_env, 'HYPERFRAMES_API_KEY');
});

test('the C4 frame carries a schema-valid media_models block', () => {
  const { home, env } = initHome();
  // Reach C4: record C0..C3 passed so the active step is C4 (still failing on calendar).
  for (const id of ['C0', 'C1', 'C2', 'C3']) setupState.setCheckpoint(id, true, { env });
  const frame = flow.computeFrame({ env, record: false });
  assert.equal(frame.generated_for, 'C4');
  assert.ok(frame.media_models, 'C4 frame must carry media_models');
  assert.equal(frame.media_models.any_configured, false); // starter config has no providers
  // The media-models guidance action (incl. the Hyperframes video option) is present.
  const mmAction = frame.actions.find((a) => a.id === 'media-models');
  assert.ok(mmAction && mmAction.options.some((o) => /hyperframes/i.test(o.help || '') || /hyperframes/i.test(o.command || '')));
  const res = validate(frame, FRAME_SCHEMA);
  assert.ok(res.ok, `C4 frame must validate:\n${res.errors.join('\n')}`);
  fs.rmSync(home, { recursive: true, force: true });
});

test('the done frame carries a schema-valid media_models block', () => {
  const { home, env } = initHome();
  for (const id of setupState.CHECKPOINTS) setupState.setCheckpoint(id, true, { env });
  const frame = flow.computeFrame({ env, record: false });
  assert.equal(frame.done, true);
  assert.ok(frame.media_models);
  const res = validate(frame, FRAME_SCHEMA);
  assert.ok(res.ok, `done frame must validate:\n${res.errors.join('\n')}`);
  fs.rmSync(home, { recursive: true, force: true });
});
