'use strict';

/**
 * engine/gate/visual-check/provider.js  [A adapted]
 *
 * The vision-provider seam for the visual gate (release-spec §12.5 LLM/vision/media provider
 * block; §3.1 "Vision-capable LLM access ... optional — visual gate degrades to skip-with-
 * warning without it"; DD-10 LLM-provider leg for engine-side LLM calls).
 *
 * What this replaces (and why): the production visual-check hard-coded a single vendor image
 * CLI as an operator-OAuth-coupled invocation baked at the call site.
 * The public engine reads the provider from the §12.5 config block instead, so no operator's
 * auth tooling is assumed and model/timeout selection lives in config, never in vendor-named
 * env vars (§4.5/§4.6). The hardened invocation properties the production module earned are
 * PRESERVED exactly:
 *   - shell:false always (the image path is the only attacker-influenced argv value; the
 *     prompt — incl. any scene hint — travels via stdin, never the command line, so nothing
 *     can be reinterpreted by a shell);
 *   - on platforms where the configured command is a .cmd/.bat shim, Node refuses shell:false
 *     spawns, so we route through the OS command interpreter with the args as a proper argv
 *     array (the interpreter quotes them — no injection, and paths with spaces work);
 *   - a bounded timeout from the provider block, never unbounded.
 *
 * Provider block shape (§12.5): { kind, model, endpoint_env, timeout_ms, options }.
 *   kind          'cli' | 'http' | (absent/unknown) ⇒ no provider ⇒ DEGRADE-TO-SKIP.
 *   model         model id passed to the provider (CLI flag / HTTP body field).
 *   endpoint_env  the §4 env-var NAME whose value is the provider credential/endpoint
 *                 (resolved via shared/secrets.js — never a literal secret in config).
 *   timeout_ms    hard ceiling on the call (default 120000).
 *   options       provider-specific knobs:
 *                   cli:  { command: string, args?: string[], image_flag?: string }
 *                   http: { url?: string, headers?: object }
 *
 * This module performs the I/O of asking a vision model a question about an image and returns
 * its raw text answer. It NEVER fabricates a pass: a missing provider returns {skipped:true};
 * any invocation failure throws VisionProviderError (the caller writes the always-write
 * NOT-pass verdict). Honest-status contract mirrors the publisher seam's RD-7 rule.
 */

const DEFAULT_TIMEOUT_MS = 120000;

class VisionProviderError extends Error {
  constructor(message) {
    super(message);
    this.name = 'VisionProviderError';
  }
}

/**
 * Normalize a §12.5 provider block into a runnable provider, or null when none is configured.
 * Pure: no I/O, no secret reads. Returns null (degrade-to-skip) for an absent or unknown kind.
 *
 * @param {object|null|undefined} block  the system.json §12.5 provider block.
 * @returns {{kind:string, model:(string|null), endpointEnv:(string|null), timeoutMs:number, options:object}|null}
 */
function resolveProvider(block) {
  if (!block || typeof block !== 'object') return null;
  const kind = typeof block.kind === 'string' ? block.kind.trim().toLowerCase() : '';
  if (kind !== 'cli' && kind !== 'http') return null; // unknown/absent ⇒ skip.
  const timeoutMs = Number.isFinite(block.timeout_ms) && block.timeout_ms > 0
    ? Number(block.timeout_ms)
    : DEFAULT_TIMEOUT_MS;
  return {
    kind,
    model: typeof block.model === 'string' && block.model ? block.model : null,
    endpointEnv: typeof block.endpoint_env === 'string' && block.endpoint_env
      ? block.endpoint_env
      : null,
    timeoutMs,
    options: block.options && typeof block.options === 'object' ? block.options : {},
  };
}

/** Is a vision provider configured for this block? (skip-decision predicate). */
function hasProvider(block) {
  return resolveProvider(block) != null;
}

/**
 * Resolve the credential/endpoint named by provider.endpointEnv via the §4.4 resolver.
 * Returns null when no endpoint_env is declared (e.g. a local CLI needing no key).
 */
function resolveEndpointSecret(provider, env = process.env) {
  if (!provider || !provider.endpointEnv) return null;
  // Lazy require so this module has no hard dependency at load time (tests inject env).
  // eslint-disable-next-line global-require
  const { getSecret } = require('../../shared/secrets');
  return getSecret(provider.endpointEnv, { env });
}

/**
 * Ask the configured vision provider one question about one image. Returns the provider's raw
 * text answer (the caller extracts/parses JSON). Throws VisionProviderError on any failure.
 *
 * @param {object}   provider  output of resolveProvider (non-null).
 * @param {object}   args
 * @param {string}   args.prompt     the question text (travels via stdin — never the cmdline).
 * @param {string}   args.imagePath  absolute path to the image to inspect.
 * @param {object}   [args.env]      environment (default process.env).
 * @param {function} [args.spawnSync] injectable child_process.spawnSync (tests).
 * @param {function} [args.httpPost]  injectable HTTP poster (tests / http kind).
 * @returns {string} the raw model answer text.
 */
function runVision(provider, args) {
  if (!provider) throw new VisionProviderError('no vision provider configured');
  const env = args.env || process.env;
  if (provider.kind === 'cli') return runCliProvider(provider, args, env);
  if (provider.kind === 'http') return runHttpProvider(provider, args, env);
  throw new VisionProviderError(`unsupported vision provider kind: ${provider.kind}`);
}

/**
 * CLI provider: spawn the configured command with the image as an argv value and the prompt on
 * stdin. shell:false hardened (see file header). The command is operator-configured in §12.5
 * options.command — the engine ships no vendor name.
 */
function runCliProvider(provider, args, env) {
  const spawnSync = args.spawnSync || require('child_process').spawnSync; // eslint-disable-line global-require
  const path = require('path'); // eslint-disable-line global-require
  const opts = provider.options || {};
  const command = typeof opts.command === 'string' && opts.command.trim() ? opts.command.trim() : null;
  if (!command) {
    throw new VisionProviderError(
      'cli vision provider requires options.command (the image-capable command to invoke)',
    );
  }
  const imageFlag = typeof opts.image_flag === 'string' && opts.image_flag ? opts.image_flag : '--image';
  // Operator-supplied static args, then the model flag (when a model is set), then the image
  // flag + path. The prompt is NOT on the command line — it goes via stdin.
  const baseArgs = Array.isArray(opts.args) ? opts.args.map(String) : [];
  const modelArgs = provider.model && opts.model_flag ? [String(opts.model_flag), provider.model] : [];
  const cmdArgs = [...baseArgs, ...modelArgs, imageFlag, args.imagePath];

  // On Windows a .cmd/.bat shim cannot be spawned with shell:false; route through the OS
  // command interpreter with a proper argv array (no injection — the interpreter quotes).
  const isCmdShim = process.platform === 'win32' && /\.(cmd|bat)$/i.test(command);
  const spawnCmd = isCmdShim ? (env.ComSpec || 'cmd.exe') : command;
  const spawnArgs = isCmdShim ? ['/d', '/s', '/c', command, ...cmdArgs] : cmdArgs;

  const res = spawnSync(spawnCmd, spawnArgs, {
    input: args.prompt,
    encoding: 'utf8',
    windowsHide: true,
    shell: false, // HARD invariant: never a shell (file header).
    timeout: provider.timeoutMs,
    env,
  });

  if (res.error) {
    throw new VisionProviderError(`vision command failed to start: ${res.error.message}`);
  }
  if (res.status !== 0) {
    const tail = String(res.stderr || '').split('\n').slice(-15).join('\n');
    throw new VisionProviderError(`vision command exited ${res.status}: ${tail}`);
  }
  const out = String(res.stdout || '');
  // Suppress the unused-binding lint without touching behavior; path is required above only
  // for callers that pre-absolutize, which the engine does before calling us.
  void path;
  return out;
}

/**
 * HTTP provider: POST the prompt + image to the configured endpoint and return the response
 * body text. The endpoint URL comes from options.url or the resolved endpoint_env value; the
 * credential (when needed) is resolved via §4.4. Image bytes are read here (the path is local).
 */
function runHttpProvider(provider, args, env) {
  const opts = provider.options || {};
  const credential = resolveEndpointSecret(provider, env);
  const url = typeof opts.url === 'string' && opts.url ? opts.url : credential;
  if (!url || !/^https?:\/\//i.test(String(url))) {
    throw new VisionProviderError(
      'http vision provider requires a URL (options.url or an endpoint_env resolving to one)',
    );
  }
  const httpPost = args.httpPost || defaultHttpPost;
  let imageB64 = null;
  try {
    const fs = require('fs'); // eslint-disable-line global-require
    imageB64 = fs.readFileSync(args.imagePath).toString('base64');
  } catch (e) {
    throw new VisionProviderError(`could not read image for vision provider: ${e.message}`);
  }
  const headers = Object.assign({ 'content-type': 'application/json' }, opts.headers || {});
  if (credential && opts.url && !headers.authorization && !headers.Authorization) {
    headers.authorization = `Bearer ${credential}`;
  }
  const body = JSON.stringify({ model: provider.model, prompt: args.prompt, image_b64: imageB64 });
  return httpPost({ url: String(url), headers, body, timeoutMs: provider.timeoutMs });
}

/** Default synchronous-ish HTTP poster used when none is injected. Throws on any failure. */
function defaultHttpPost() {
  // v1 ships the CLI provider as the reference; a built-in HTTP client is intentionally not
  // bundled (no network dependency in the engine edge). Operators wanting HTTP inject a poster
  // or supply a CLI command. Failing loudly here keeps the always-write NOT-pass contract.
  throw new VisionProviderError(
    'http vision provider needs an injected poster in v1; configure a cli provider instead (§12.5)',
  );
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  VisionProviderError,
  resolveProvider,
  hasProvider,
  resolveEndpointSecret,
  runVision,
};
