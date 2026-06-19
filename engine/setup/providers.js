'use strict';

/**
 * engine/setup/providers.js  [N net-new]
 *
 * MEDIA-MODEL DETECTION for the guided setup driver — "which media models are already wired, and what
 * is missing?" (release-spec §12.5 provider seams; §1.5 library/media generation; the setup driver's
 * model-detection step). The engine is host-runtime-agnostic and cannot know the host's chat model, so
 * detection is HONEST about what it can see: it reports which §12.5 provider BLOCKS are configured +
 * resolvable in config/system.json (read-only, no secret values, no network), and leaves the "is your
 * host model's built-in image generation good enough" judgment to the operator.
 *
 * Three capabilities (all OPTIONAL — absent ⇒ that capability degrades to skip, never fails, DD-21):
 *   - visual     the VISION provider that READS images (visual gate + library auto-index).
 *   - image_gen  the image-GENERATION provider (character sheets, generated media). If the host model
 *                already generates images (e.g. a Codex-class CLI), wire a kind:'cli' block at it.
 *   - video      the OPTIONAL video-generation provider (e.g. a Hyperframes-class endpoint).
 *
 * Config homes (matches what the engine code actually reads): visual = `visual_provider` OR
 * `providers.visual`; image_gen = `image_gen` / `imageGen` OR `providers.image_gen`; video =
 * `providers.video` OR `video_provider`. The resolver is the same brand-neutral §12.5 normalizer the
 * runtime seams use, so "configured" here means the same thing as "runnable" there.
 *
 * Tier-3 cleanliness (§0.3 r6): reads config only; never prints or returns a credential VALUE (only
 * the env-var NAME from endpoint_env); no hardcoded ids/paths.
 */

const imageGen = require('../library/image-gen-provider');
const video = require('../library/video-provider');

/** Pick the configured block for a capability from the system config, honoring the legacy aliases. */
function pickBlock(sys, capability) {
  const providers = (sys && typeof sys.providers === 'object' && sys.providers) || {};
  if (capability === 'visual') return sys.visual_provider || providers.visual || null;
  if (capability === 'image_gen') return sys.image_gen || sys.imageGen || providers.image_gen || null;
  if (capability === 'video') return providers.video || sys.video_provider || null;
  return null;
}

/** Where the picked block lives, for an honest "source" label in the report. */
function blockSource(sys, capability) {
  const providers = (sys && typeof sys.providers === 'object' && sys.providers) || {};
  if (capability === 'visual') return sys.visual_provider ? 'visual_provider' : (providers.visual ? 'providers.visual' : null);
  if (capability === 'image_gen') {
    if (sys.image_gen) return 'image_gen';
    if (sys.imageGen) return 'imageGen';
    return providers.image_gen ? 'providers.image_gen' : null;
  }
  if (capability === 'video') return providers.video ? 'providers.video' : (sys.video_provider ? 'video_provider' : null);
  return null;
}

/** Resolve+describe one capability's provider. resolveProvider is the same shape for all three. */
function describe(sys, capability) {
  const block = pickBlock(sys, capability);
  const resolved = imageGen.resolveProvider(block); // generic §12.5 normalizer (shared shape)
  if (!resolved) {
    return { capability, configured: false, kind: null, model: null, endpoint_env: null, source: null };
  }
  return {
    capability,
    configured: true,
    kind: resolved.kind,
    model: resolved.model,
    // endpoint_env is a NAME, never a value — safe to surface (RD-3 / §15.1).
    endpoint_env: resolved.endpointEnv,
    source: blockSource(sys, capability),
  };
}

/**
 * Detect the media-model providers configured for this instance.
 *
 * @param {object} [opts]
 * @param {object} [opts.config]  pre-loaded system config (else read via engine/cli/util).
 * @param {object} [opts.env]     environment (default process.env) — injectable for tests.
 * @returns {{
 *   visual: object, image_gen: object, video: object,
 *   any_configured: boolean, summary: string,
 *   hyperframes_reference: object
 * }}
 */
function detectProviders(opts = {}) {
  const env = opts.env || process.env;
  let sys = opts.config;
  if (!sys) {
    // eslint-disable-next-line global-require
    const util = require('../cli/util');
    sys = util.loadSystemConfig(env) || {};
  }

  const visual = describe(sys, 'visual');
  const image_gen = describe(sys, 'image_gen');
  const vid = describe(sys, 'video');
  const anyConfigured = visual.configured || image_gen.configured || vid.configured;

  const bits = [
    `vision ${visual.configured ? `✓ (${visual.kind})` : '— not set'}`,
    `image-gen ${image_gen.configured ? `✓ (${image_gen.kind})` : '— not set'}`,
    `video ${vid.configured ? `✓ (${vid.kind})` : '— optional, not set'}`,
  ];
  const summary = `media models: ${bits.join(' · ')}`;

  return {
    visual,
    image_gen,
    video: vid,
    any_configured: anyConfigured,
    summary,
    // A brand-neutral reference for wiring a Hyperframes-class video provider (env NAME only).
    hyperframes_reference: video.HYPERFRAMES_REFERENCE,
  };
}

module.exports = { detectProviders, pickBlock, blockSource };
