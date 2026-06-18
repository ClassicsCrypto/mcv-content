'use strict';

/**
 * engine/shared/secrets.js  [A adapted]
 *
 * The ONE env resolver for the whole engine (release-spec §4.4 resolution rule; DD-8).
 *
 * Resolution order is fixed and TERMINATES (§4.4):
 *   1. process.env (or an injected env object)
 *   2. $CONTENT_HOME/.env  (located via shared/paths.js — never a hardcoded path)
 * There is NO further fallback — not into the code checkout, a legacy directory, or any
 * unlisted path. This deliberately removes the production fallback-chain hazard recorded in
 * gap §2.5 (the adapted source searched an arbitrary caller-supplied path list); each
 * credential is fetched by NAME and resolution stops at $CONTENT_HOME/.env.
 *
 * What is preserved from the adapted source (the good behavior):
 *   - the correct indexOf-based .env parse (split on the FIRST '=' so values may contain '=';
 *     keys/values trimmed; blanks and '#' comments skipped) — the production hand parsers
 *     disagreed on this and one TRUNCATED '='-bearing values.
 *   - missing/unreadable .env file is treated as "no values", never an error by itself.
 *
 * What changed (the v1 hardening, §15.1):
 *   - missing OR blank credential => a typed CredentialMissingError that NAMES the variable
 *     and its consumer, never the value, and instructs the operator. Callers fail fast at
 *     startup; there is NO retry loop — a missing/invalid credential is permanent until the
 *     operator acts (the production token-rotation crash-loop is the recorded counter-example).
 *   - the caller-supplied arbitrary `paths` list is gone; the only .env consulted is the one
 *     paths.js locates at $CONTENT_HOME. Repo-tracked secrets are never read.
 *
 * Names referenced by callers are the §4 public variable names (e.g. POSTIZ_API_KEY,
 * GIPHY_API_KEY) — this module hardcodes NO credential values.
 */

const fs = require('fs');
const paths = require('./paths');

/**
 * Thrown when a required credential is unresolved (unset or blank). Typed so callers present
 * the §15.1 fail-fast remediation instead of a generic error, and so the variable name is
 * machine-available for `engine status`'s wiring self-check.
 */
class CredentialMissingError extends Error {
  /**
   * @param {string} name      the §4 variable name (e.g. 'POSTIZ_API_KEY').
   * @param {string} [consumer] the component that needs it (e.g. 'publisher adapter (postiz)').
   */
  constructor(name, consumer) {
    const who = consumer ? ` (required by ${consumer})` : '';
    super(
      `Credential "${name}" is missing or blank${who}. Set ${name} in your process ` +
        `environment or in $CONTENT_HOME/.env, then restart. The engine does not retry ` +
        `credential resolution — a missing or invalid credential is permanent until you act.`,
    );
    this.name = 'CredentialMissingError';
    this.variable = name;
    this.consumer = consumer || null;
  }
}

/**
 * Parse `.env`-style text into a plain object.
 *  - blank lines and `#` comments are skipped
 *  - split on the FIRST `=` so values may contain `=`
 *  - keys and values are trimmed
 * (Preserved verbatim in behavior from the adapted source — the correct parse.)
 */
function parseEnvFile(raw) {
  const out = {};
  for (const rawLine of String(raw).split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    if (key) out[key] = line.slice(idx + 1).trim();
  }
  return out;
}

/** Read+parse a .env file. Missing/unreadable file -> {} (never throws). */
function loadEnvFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return {};
    return parseEnvFile(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * Locate $CONTENT_HOME/.env via paths.js. If CONTENT_HOME is unset (e.g. the two
 * CONTENT_HOME-free commands, §4.1), there is no instance .env to read — return null and let
 * resolution rely on process.env alone.
 * @param {object} env
 * @returns {string|null}
 */
function instanceEnvFile(env) {
  try {
    return paths.envFile(env);
  } catch (err) {
    if (err instanceof paths.ContentHomeUnsetError) return null;
    throw err;
  }
}

/**
 * Resolve a credential/config value by name. process.env first, then $CONTENT_HOME/.env.
 * @param {string} name      the §4 variable name.
 * @param {object} [opts]
 * @param {object}   [opts.env]       env object to read first (default process.env).
 * @param {boolean}  [opts.required]  throw CredentialMissingError if unresolved (default false).
 * @param {string}   [opts.consumer]  component name for the error message (§15.1).
 * @returns {string|null} the resolved value, or null when absent and not required.
 * @throws {CredentialMissingError} when required and unresolved (missing or blank).
 */
function getSecret(name, opts = {}) {
  const env = opts.env || process.env;

  // 1. process.env (blank counts as absent — §15.1 "missing or blank").
  if (env[name] != null && env[name] !== '') return env[name];

  // 2. $CONTENT_HOME/.env (the terminating source — §4.4).
  const envPath = instanceEnvFile(env);
  if (envPath) {
    const vals = loadEnvFile(envPath);
    if (Object.prototype.hasOwnProperty.call(vals, name) && vals[name] !== '') {
      return vals[name];
    }
  }

  if (opts.required) throw new CredentialMissingError(name, opts.consumer);
  return null;
}

/**
 * Convenience for the common case: fetch a credential that MUST exist.
 * @param {string} name
 * @param {string} [consumer]
 * @param {object} [env]
 * @returns {string}
 */
function requireSecret(name, consumer, env = process.env) {
  return getSecret(name, { required: true, consumer, env });
}

module.exports = {
  CredentialMissingError,
  parseEnvFile,
  loadEnvFile,
  getSecret,
  requireSecret,
};
