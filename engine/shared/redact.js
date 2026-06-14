'use strict';

/**
 * engine/shared/redact.js  [N net-new]
 *
 * Write-time log/ledger redaction (release-spec §13.3; model §9 rule 3 redact-at-write;
 * gap §2.2 redaction row — no production implementation existed).
 *
 * The bar (§13.3):
 *   - All engine logging routes through this helper BEFORE anything hits a log or ledger.
 *     Redaction happens at WRITE time, not share time, because logs and memory feed future
 *     learning loops — masking only when sharing would leave secrets in the substrate.
 *   - It masks (a) the VALUES of every credential variable named in §4, given by name, and
 *     (b) token/key/secret-SHAPED substrings (long opaque tokens, bearer tokens, signed-URL
 *     query params) wherever they appear in free text or nested structures.
 *   - v1 scope is honest: pattern + known-name redaction, NOT semantic DLP (§13.3).
 *
 * Never logged (§13.3): secrets, full credential-bearing URLs, signed CDN URLs (the
 * production Tier-2 leak class). The default sensitive-key list and patterns target exactly
 * those classes. This module hardcodes NO real values — only the SHAPES of secrets and the
 * variable NAMES from §4 (which are public; they ship in .env.example).
 */

const MASK = '[REDACTED]';

/**
 * Sensitive key names (case-insensitive). These are the §4 credential/secret variable names
 * plus the generic key fragments that mark a secret-bearing field. A value under any of these
 * keys is masked regardless of its shape. Names only — no values.
 */
const SENSITIVE_KEYS = [
  // §4.1 / §4.2 / §4.3 named credentials (Tier 1 secrets).
  'DISCORD_BOT_TOKEN',
  'POSTIZ_API_KEY',
  'GIPHY_API_KEY',
  'APIFY_API_KEY',
  'XAI_API_KEY',
  'GROK_API_KEY',
  'OPENROUTER_API_KEY',
  'GEMINI_API_KEY',
  'OPENAI_API_KEY',
  // Generic secret-bearing field-name fragments (substring match, lower-cased).
  'token',
  'secret',
  'apikey',
  'api_key',
  'password',
  'passwd',
  'authorization',
  'auth_token',
  'access_token',
  'refresh_token',
  'bearer',
  'credential',
  'private_key',
  'signature',
  'session_key',
];

/**
 * Value-shape patterns. Each replaces the secret-shaped substring with MASK. Patterns are
 * conservative (long/opaque/obviously-credential shapes) to avoid masking ordinary content,
 * matching the "pattern/known-name, not semantic DLP" honesty bar of §13.3.
 */
const VALUE_PATTERNS = [
  // Bearer tokens in Authorization-style strings: "Bearer <token>".
  { re: /\b[Bb]earer\s+[A-Za-z0-9._~+/=-]{8,}/g, to: `Bearer ${MASK}` },
  // Discord bot tokens: three dot-separated base64url segments (24+.6+.27+ -ish).
  {
    re: /\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}\b/g,
    to: MASK,
  },
  // Signed-URL / credential-bearing query params: ?sig=… &token=… &key=… &X-Amz-Signature=…
  // (the production Tier-2 signed-CDN-URL leak class — mask the value, keep the param name).
  {
    re: /([?&](?:sig|signature|token|key|api[_-]?key|access[_-]?key|x-amz-signature|x-amz-credential)=)[^&\s"']+/gi,
    to: `$1${MASK}`,
  },
  // Long opaque high-entropy tokens (prefixed-key families and generic 32+ char blobs).
  { re: /\b(?:sk|pk|rk|xai|gsk|key|tok)[-_][A-Za-z0-9]{16,}\b/gi, to: MASK },
  { re: /\b[A-Za-z0-9_-]{40,}\b/g, to: MASK },
];

/** Is this key name sensitive? Case-insensitive exact-or-substring match against the list. */
function isSensitiveKey(key) {
  if (key == null) return false;
  const k = String(key).toLowerCase();
  return SENSITIVE_KEYS.some((s) => {
    const sl = s.toLowerCase();
    return k === sl || k.includes(sl);
  });
}

/** Apply value-shape patterns to a string. */
function redactString(str) {
  let out = String(str);
  for (const { re, to } of VALUE_PATTERNS) {
    out = out.replace(re, to);
  }
  return out;
}

/**
 * Redact a value of any type for safe write-time logging.
 *  - strings: value-shape patterns applied.
 *  - objects/arrays: recursed; a value under a sensitive KEY is fully masked (its shape is
 *    irrelevant — the name says it is a secret); other values are pattern-scrubbed.
 *  - primitives (number/boolean/null/undefined): returned as-is.
 * Cycles are handled via a seen-set so logging a self-referential object can't hang.
 *
 * @param {*} value
 * @param {object} [opts]
 * @param {string[]} [opts.extraKeys]  additional sensitive key names (instance-configured, §13.3).
 * @returns {*} a redacted copy (input is never mutated).
 */
function redact(value, opts = {}) {
  const extra = (opts.extraKeys || []).map((s) => String(s).toLowerCase());
  const keySensitive = (key) => isSensitiveKey(key) || extra.includes(String(key).toLowerCase());
  const seen = new WeakSet();

  function walk(val, parentKeyIsSensitive) {
    if (parentKeyIsSensitive) return MASK;
    if (typeof val === 'string') return redactString(val);
    if (val == null || typeof val !== 'object') return val;
    if (seen.has(val)) return '[Circular]';
    seen.add(val);
    if (Array.isArray(val)) return val.map((v) => walk(v, false));
    const out = {};
    for (const [k, v] of Object.entries(val)) {
      out[k] = walk(v, keySensitive(k));
    }
    return out;
  }

  return walk(value, false);
}

/**
 * Redact then JSON-serialize — the convenience the ledger/log writers use so a single call
 * guarantees no raw secret reaches the file (§13.3 redact-at-write).
 */
function redactToJson(value, opts = {}) {
  return JSON.stringify(redact(value, opts));
}

module.exports = {
  MASK,
  SENSITIVE_KEYS,
  isSensitiveKey,
  redactString,
  redact,
  redactToJson,
};
