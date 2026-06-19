'use strict';

/**
 * engine/library/video-provider.js  [N net-new]
 *
 * The VIDEO-generation provider seam (release-spec §12.5 LLM/vision/media provider block, extended to
 * video). Sibling to engine/library/image-gen-provider.js: same §12.5 block SHAPE, same
 * degrade-to-skip and BYO-credential invariants — for short video / animation generation (e.g. a
 * Hyperframes-class endpoint).
 *
 * SCOPE HONESTY: this ships the SEAM + DETECTION, not a chain-wired video-generation pipeline. The
 * public engine has no caller that generates video in v1 (image generation has one — character
 * sheets — video does not yet), so this module exists so that (a) a video provider is FIRST-CLASS and
 * VALIDATEABLE in config (schemas/config/system.schema.json `providers.video`), and (b) the setup
 * driver can DETECT whether one is configured and offer to wire it (engine/setup/providers.js). When a
 * video-generation step is added (roadmap), it resolves its provider here exactly as image generation
 * does — `resolveProvider` + the same cli/http transports. No vendor credentials are bundled (BYO,
 * RD-9): `endpoint_env` NAMES the env var; the value resolves via secrets.js, never lives in config.
 *
 * Provider block shape (§12.5): { kind:'cli'|'http', model?, endpoint_env?, timeout_ms?, options? }.
 * An absent/unknown kind ⇒ no provider ⇒ DEGRADE-TO-SKIP (the same decision shape as the vision and
 * image-gen seams).
 *
 * Tier-3 cleanliness (§0.3 r6): no hardcoded credentials/endpoints; the only constant is a
 * brand-neutral REFERENCE config example (HYPERFRAMES_REFERENCE) the docs/setup driver can show — it
 * carries an env-var NAME, never a value.
 */

const DEFAULT_TIMEOUT_MS = 300000; // video generation is slower than image — a generous default ceiling.

/**
 * A brand-neutral REFERENCE block showing how to wire a Hyperframes-class video provider. It is an
 * EXAMPLE the docs + setup driver can surface — never auto-applied, and it carries only an env-var
 * NAME (HYPERFRAMES_API_KEY), never a credential value. Operators adapt the url/model to their account.
 */
const HYPERFRAMES_REFERENCE = Object.freeze({
  kind: 'http',
  model: '<hyperframes-model-id>',
  endpoint_env: 'HYPERFRAMES_API_KEY',
  timeout_ms: DEFAULT_TIMEOUT_MS,
  options: { url: '<https://your-hyperframes-endpoint>' },
});

/**
 * Normalize a §12.5 provider block into a runnable provider, or null when none is configured.
 * Pure: no I/O, no secret reads. Returns null (degrade-to-skip) for an absent/unknown kind —
 * identical decision shape to the image-gen + vision seams.
 * @param {object|null|undefined} block
 * @returns {{kind:string, model:(string|null), endpointEnv:(string|null), timeoutMs:number, options:object}|null}
 */
function resolveProvider(block) {
  if (!block || typeof block !== 'object') return null;
  const kind = typeof block.kind === 'string' ? block.kind.trim().toLowerCase() : '';
  if (kind !== 'cli' && kind !== 'http') return null; // unknown/absent ⇒ skip.
  const timeoutMs =
    Number.isFinite(block.timeout_ms) && block.timeout_ms > 0 ? Number(block.timeout_ms) : DEFAULT_TIMEOUT_MS;
  return {
    kind,
    model: typeof block.model === 'string' && block.model ? block.model : null,
    endpointEnv: typeof block.endpoint_env === 'string' && block.endpoint_env ? block.endpoint_env : null,
    timeoutMs,
    options: block.options && typeof block.options === 'object' ? block.options : {},
  };
}

/** Is a video-generation provider configured for this block? (skip-decision predicate). */
function hasProvider(block) {
  return resolveProvider(block) != null;
}

/** Resolve the credential/endpoint named by provider.endpointEnv via the §4.4 resolver (BY NAME). */
function resolveEndpointSecret(provider, env = process.env) {
  if (!provider || !provider.endpointEnv) return null;
  // eslint-disable-next-line global-require
  const { getSecret } = require('../shared/secrets');
  return getSecret(provider.endpointEnv, { env });
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  HYPERFRAMES_REFERENCE,
  resolveProvider,
  hasProvider,
  resolveEndpointSecret,
};
