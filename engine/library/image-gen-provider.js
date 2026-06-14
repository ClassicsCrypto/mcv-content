'use strict';

/**
 * engine/library/image-gen-provider.js  [A adapted — mirrors the §12.5 vision-provider seam]
 *
 * The image-GENERATION provider seam (release-spec §12.5 LLM/vision/media provider block; §4.6 —
 * the production per-vendor image-model / image-timeout / style-anchor env vars are "folded into the
 * §12.5 provider config block"). This is the generation counterpart to
 * engine/gate/visual-check/provider.js (which reads images): same block SHAPE, same hardening
 * invariants, same degrade-to-skip and injectable-for-tests contracts.
 *
 * Provider block shape (§12.5): { kind, model, endpoint_env, timeout_ms, options }.
 *   kind          'cli' | 'http' | (absent/unknown) ⇒ no provider ⇒ DEGRADE-TO-SKIP.
 *   model         image model id passed to the provider (CLI flag / HTTP body field).
 *   endpoint_env  the §4 env-var NAME whose value is the provider credential/endpoint (resolved
 *                 via shared/secrets.js — never a literal secret in config).
 *   timeout_ms    hard ceiling on the call (default 180000 — image gen is slower than vision).
 *   options       provider-specific knobs:
 *                   cli:  { command, args?, model_flag?, output_flag?, ref_flag?, style_anchor? }
 *                   http: { url?, headers? }
 *
 * Hardening invariants preserved from the vision provider (file header there explains why):
 *   - shell:false ALWAYS. The prompt travels via stdin, never the command line, so nothing can be
 *     reinterpreted by a shell; only operator-configured/path argv values are passed.
 *   - on win32, a .cmd/.bat command is routed through the OS interpreter with a proper argv array
 *     (Node refuses shell:false for shims), so paths with spaces work and there is no injection.
 *   - a bounded timeout from the provider block, never unbounded.
 *
 * This module performs the I/O of asking an image model to render a sheet and writing it to disk.
 * It NEVER fabricates success: a missing provider returns null (the caller degrades to skip); any
 * invocation failure throws ImageGenProviderError. The image-gen call is dependency-injectable in
 * the caller (character-sheets.js takes an injected generator), so tests run ZERO-KEY (RD-12).
 */

const DEFAULT_TIMEOUT_MS = 180000;

class ImageGenProviderError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ImageGenProviderError';
  }
}

/**
 * Normalize a §12.5 provider block into a runnable provider, or null when none is configured.
 * Pure: no I/O, no secret reads. Returns null (degrade-to-skip) for an absent/unknown kind —
 * identical decision shape to the vision provider's resolveProvider.
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

/** Is an image-generation provider configured for this block? (skip-decision predicate). */
function hasProvider(block) {
  return resolveProvider(block) != null;
}

/** Resolve the credential/endpoint named by provider.endpointEnv via the §4.4 resolver. */
function resolveEndpointSecret(provider, env = process.env) {
  if (!provider || !provider.endpointEnv) return null;
  // eslint-disable-next-line global-require
  const { getSecret } = require('../shared/secrets');
  return getSecret(provider.endpointEnv, { env });
}

/**
 * Render one character sheet via the configured image-generation provider and write it to
 * `outputPath` (resolved under $CONTENT_HOME). Returns { ok, output_path, bytes } on success;
 * throws ImageGenProviderError on any failure (the caller reports the failure honestly).
 *
 * @param {object}   args
 * @param {object}   args.provider    resolveProvider output (non-null).
 * @param {string}   args.prompt      the sheet prompt (travels via stdin — never the command line).
 * @param {string[]} [args.refs]      CONTENT_HOME-relative reference image paths (identity anchors).
 * @param {string}   args.outputPath  CONTENT_HOME-relative output path for the produced sheet.
 * @param {object}   [args.env]       environment (default process.env).
 * @param {function} [args.spawnSync] injectable child_process.spawnSync (tests).
 * @param {function} [args.httpPost]  injectable HTTP poster (tests / http kind).
 * @returns {{ok:boolean, output_path:string, bytes:(number|null)}}
 */
function runImageGen(args = {}) {
  const provider = args.provider;
  if (!provider) throw new ImageGenProviderError('no image-generation provider configured');
  const env = args.env || process.env;
  if (provider.kind === 'cli') return runCliProvider(provider, args, env);
  if (provider.kind === 'http') return runHttpProvider(provider, args, env);
  throw new ImageGenProviderError(`unsupported image-generation provider kind: ${provider.kind}`);
}

/** Absolutize a CONTENT_HOME-relative path; fall back to cwd-relative when CONTENT_HOME is unset. */
function absolutize(p, env) {
  const path = require('path'); // eslint-disable-line global-require
  if (path.isAbsolute(p)) return p;
  try {
    // eslint-disable-next-line global-require
    const paths = require('../shared/paths');
    return path.join(paths.contentHome(env), p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * CLI provider: spawn the configured command with refs/output as argv values and the prompt on
 * stdin. shell:false hardened (file header). The command + flags are operator-configured in §12.5
 * options — the engine ships no vendor name. A configured `style_anchor` (the production STYLE_ANCHOR
 * env, rename-map line 65) is prepended to the reference images so the sheet layout is anchored.
 */
function runCliProvider(provider, args, env) {
  const fs = require('fs'); // eslint-disable-line global-require
  const spawnSync = args.spawnSync || require('child_process').spawnSync; // eslint-disable-line global-require
  const opts = provider.options || {};
  const command = typeof opts.command === 'string' && opts.command.trim() ? opts.command.trim() : null;
  if (!command) {
    throw new ImageGenProviderError(
      'cli image-generation provider requires options.command (the image-generation command to invoke)',
    );
  }
  const outputFlag = typeof opts.output_flag === 'string' && opts.output_flag ? opts.output_flag : '--output';
  const refFlag = typeof opts.ref_flag === 'string' && opts.ref_flag ? opts.ref_flag : '--ref';
  const outAbs = absolutize(args.outputPath, env);

  // Style anchor (layout reference) first, then the character identity refs — mirrors the
  // production image-1 (style) + image-2 (character) convention.
  const refList = [];
  if (typeof opts.style_anchor === 'string' && opts.style_anchor) refList.push(absolutize(opts.style_anchor, env));
  for (const r of Array.isArray(args.refs) ? args.refs : []) refList.push(absolutize(String(r), env));

  const baseArgs = Array.isArray(opts.args) ? opts.args.map(String) : [];
  const modelArgs = provider.model && opts.model_flag ? [String(opts.model_flag), provider.model] : [];
  const refArgs = refList.flatMap((r) => [refFlag, r]);
  const cmdArgs = [...baseArgs, ...modelArgs, ...refArgs, outputFlag, outAbs];

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

  if (res.error) throw new ImageGenProviderError(`image-generation command failed to start: ${res.error.message}`);
  if (res.status !== 0) {
    const tail = String(res.stderr || '').split('\n').slice(-15).join('\n');
    throw new ImageGenProviderError(`image-generation command exited ${res.status}: ${tail}`);
  }
  let bytes = null;
  try {
    bytes = fs.existsSync(outAbs) ? fs.statSync(outAbs).size : null;
  } catch {
    bytes = null;
  }
  if (bytes == null) {
    throw new ImageGenProviderError(`image-generation command reported success but produced no file at ${outAbs}`);
  }
  return { ok: true, output_path: args.outputPath, bytes };
}

/**
 * HTTP provider: POST the prompt + refs to the configured endpoint, write the returned image bytes
 * to outputPath. The endpoint URL comes from options.url or the resolved endpoint_env; the
 * credential (when needed) is resolved via §4.4. v1 ships the CLI provider as the reference; an
 * HTTP poster must be injected (parity with the vision provider's defaultHttpPost).
 */
function runHttpProvider(provider, args, env) {
  const fs = require('fs'); // eslint-disable-line global-require
  const opts = provider.options || {};
  const credential = resolveEndpointSecret(provider, env);
  const url = typeof opts.url === 'string' && opts.url ? opts.url : credential;
  if (!url || !/^https?:\/\//i.test(String(url))) {
    throw new ImageGenProviderError(
      'http image-generation provider requires a URL (options.url or an endpoint_env resolving to one)',
    );
  }
  const httpPost = args.httpPost || defaultHttpPost;
  const headers = Object.assign({ 'content-type': 'application/json' }, opts.headers || {});
  if (credential && opts.url && !headers.authorization && !headers.Authorization) {
    headers.authorization = `Bearer ${credential}`;
  }
  const refsB64 = [];
  for (const r of Array.isArray(args.refs) ? args.refs : []) {
    try {
      refsB64.push(fs.readFileSync(absolutize(String(r), env)).toString('base64'));
    } catch (e) {
      throw new ImageGenProviderError(`could not read reference image ${r}: ${e.message}`);
    }
  }
  const body = JSON.stringify({ model: provider.model, prompt: args.prompt, refs_b64: refsB64 });
  const result = httpPost({ url: String(url), headers, body, timeoutMs: provider.timeoutMs });
  // The injected poster returns { image_b64 } (or a buffer); persist it.
  const outAbs = absolutize(args.outputPath, env);
  let buf;
  if (result && result.image_b64) buf = Buffer.from(result.image_b64, 'base64');
  else if (Buffer.isBuffer(result)) buf = result;
  else throw new ImageGenProviderError('http image-generation poster returned no image bytes (expected {image_b64} or Buffer)');
  try {
    const path = require('path'); // eslint-disable-line global-require
    fs.mkdirSync(path.dirname(outAbs), { recursive: true });
    fs.writeFileSync(outAbs, buf);
  } catch (e) {
    throw new ImageGenProviderError(`could not write generated sheet to ${outAbs}: ${e.message}`);
  }
  return { ok: true, output_path: args.outputPath, bytes: buf.length };
}

/** Default HTTP poster — v1 has no bundled network client (parity with the vision provider). */
function defaultHttpPost() {
  throw new ImageGenProviderError(
    'http image-generation provider needs an injected poster in v1; configure a cli provider instead (§12.5)',
  );
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  ImageGenProviderError,
  resolveProvider,
  hasProvider,
  resolveEndpointSecret,
  runImageGen,
};
