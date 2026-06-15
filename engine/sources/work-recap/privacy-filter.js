'use strict';

/**
 * engine/sources/work-recap/privacy-filter.js  [N net-new]
 *
 * The PRIVACY PRE-PASS for the work-recap / build-in-public memory source (the prompt's
 * MEMORY-SOURCE law; release-spec §13.3 redact-at-write; §2.4 the double gate; §8 trust zones).
 *
 * WHY IT EXISTS:
 *   Project memory is SENSITIVE — it carries secrets, partner names, unreleased codenames,
 *   financials, and internal ids. Before any memory-derived text can become a SHAREABLE seed it
 *   MUST be run through this filter, which:
 *     1. REUSES engine/shared/redact.js secret SHAPES + the §4 credential variable names to mask
 *        token/key/secret-shaped spans (the same write-time redactor the logs use).
 *     2. Applies a CONFIG-EXTENDABLE private-term DENY LIST (work_recap.private_terms) for the
 *        non-secret-shaped sensitive spans redact.js cannot know about: partner names, unreleased
 *        codenames, financial figures, internal ids. Operators extend it per instance; the repo
 *        ships only neutral STRUCTURAL patterns (money, internal-id shapes) — never real terms.
 *     3. STRIPS or FLAGS sensitive spans and carries a `privacy_flags` record so the DOWNSTREAM
 *        GATE can HARD-BLOCK on residual leakage before the human approval card. The human is the
 *        final backstop (§2.4) — this pre-pass is the mechanism, not the sole guarantee.
 *
 * HONEST SCOPE (matches redact.js §13.3): pattern + known-name redaction, NOT semantic DLP.
 * It cannot infer that an unflagged proper noun is a secret partner. That is exactly why
 * (a) the deny list is operator-extendable and (b) the gate's privacy check + the human card
 * sit downstream. This module hardcodes NO real private terms or values.
 *
 * Tier-3 cleanliness (§0.3 r6): no real IDs/handles/brand strings/codenames anywhere.
 */

const redactor = require('../../shared/redact.js');

const MASK = redactor.MASK; // '[REDACTED]' — same marker the log redactor uses.

/**
 * Neutral STRUCTURAL deny patterns the repo MAY ship safely (no real terms). These catch common
 * sensitive SHAPES that redact.js (credential-focused) does not target:
 *   - money/financials (currency-prefixed or magnitude-suffixed amounts)
 *   - internal-id shapes (UPPER-PREFIX-1234 style ticket/record ids)
 * Each carries a `flag` family so privacy_flags records WHY a span was masked.
 */
const STRUCTURAL_PATTERNS = [
  // Currency amounts: $1,234  £50k  €2.5M  USD 10000
  {
    flag: 'financial',
    re: /(?:[$£€]\s?\d[\d,]*(?:\.\d+)?\s?[kKmMbB]?\b|\b(?:USD|EUR|GBP)\s?\d[\d,]*(?:\.\d+)?\s?[kKmMbB]?\b|\b\d[\d,]*(?:\.\d+)?\s?[kKmMbB]?\s?(?:dollars|usd)\b)/g,
  },
  // Internal-id shapes: PROJ-1234, TICKET_88, INT-ABCD-01 (uppercase prefix + delimiter + alnum).
  {
    flag: 'internal_id',
    re: /\b[A-Z]{2,}[-_][A-Z0-9]{2,}(?:[-_][A-Z0-9]+)?\b/g,
  },
];

/**
 * Escape a user-supplied deny term for safe use inside a RegExp (the deny list is operator-data;
 * never trust it as a pattern). Returns a word-boundary-anchored, case-insensitive matcher.
 */
function denyTermToRegExp(term) {
  const escaped = String(term).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!escaped) return null;
  // \b is unreliable around punctuation/unicode; anchor on non-word OR string edges instead.
  return new RegExp(`(^|[^\\w])(${escaped})(?=$|[^\\w])`, 'gi');
}

/**
 * Apply the operator's private-term deny list to a string, masking each hit and recording a flag.
 *
 * PRIVACY: the flag records a NON-REVERSIBLE marker (a short fingerprint + the term's length),
 * never the matched term itself. Echoing the sensitive term back into the flag record would
 * re-introduce it into the seed (which is shared downstream) — the exact leak this filter exists
 * to prevent. The fingerprint lets an operator correlate which deny entry fired without exposing it.
 * @returns {{text:string, flags:Array<{family:string, term_fp:string, term_len:number}>}}
 */
function applyDenyList(text, terms, flags) {
  let out = String(text);
  for (const term of terms || []) {
    const re = denyTermToRegExp(term);
    if (!re) continue;
    const normalized = String(term).trim();
    out = out.replace(re, (m, pre) => {
      flags.push({ family: 'private_term', term_fp: fingerprint(normalized), term_len: normalized.length });
      return `${pre}${MASK}`;
    });
  }
  return out;
}

/**
 * A short, non-reversible fingerprint of a deny term (so a flag can be correlated to a deny-list
 * entry without echoing the sensitive term). Deliberately tiny — collision-tolerant, identity-safe;
 * it is a correlation aid, not a security primitive. Pure JS (no deps).
 */
function fingerprint(str) {
  let h = 5381;
  const s = String(str).toLowerCase();
  for (let i = 0; i < s.length; i += 1) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return `fp_${h.toString(36)}`;
}

/** Apply the neutral structural patterns, masking each hit and recording its flag family. */
function applyStructural(text, flags) {
  let out = String(text);
  for (const { flag, re } of STRUCTURAL_PATTERNS) {
    out = out.replace(re, (m) => {
      flags.push({ family: flag, sample_len: m.length });
      return MASK;
    });
  }
  return out;
}

/**
 * Sanitize a single string through the full pre-pass: redact.js secret shapes, then the structural
 * patterns, then the operator deny list. Order matters — secret shapes first so a credential that
 * also matches an id shape is caught as a credential. Returns the sanitized text + the flags it
 * raised. A non-empty `flags` array means sensitive material WAS present (and is now masked).
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {string[]} [opts.privateTerms]  operator deny list (work_recap.private_terms).
 * @param {string[]} [opts.extraSecretKeys] extra sensitive key names for redact.js (§13.3).
 * @returns {{text:string, flags:Array<object>, redacted:boolean}}
 */
function sanitizeText(text, opts = {}) {
  const flags = [];
  // 1. Credential/secret shapes (same engine as the log redactor). redactString is value-only.
  const beforeSecrets = String(text);
  let out = redactor.redactString(beforeSecrets);
  if (out !== beforeSecrets) flags.push({ family: 'secret_shape' });
  // 2. Neutral structural shapes (financial, internal-id).
  out = applyStructural(out, flags);
  // 3. Operator-extendable private-term deny list.
  out = applyDenyList(out, opts.privateTerms, flags);

  return { text: out, flags, redacted: flags.length > 0 };
}

/**
 * Run the privacy pre-pass over a list of work items (the scanMemory output shape). Each item's
 * `summary` is sanitized; the RAW field is DROPPED from the sanitized output entirely (it may
 * carry un-flagged sensitive context the masking missed — only the sanitized summary travels).
 * A per-item `privacy_flags` array records what was masked; an aggregate `privacy_flags` record
 * on the result lets the downstream gate hard-block on residual leakage.
 *
 * @param {Array<object>} items  scanMemory items ({ summary, raw, time, source_rel, date }).
 * @param {object} [opts]  { privateTerms, extraSecretKeys }.
 * @returns {{
 *   items: Array<{summary:string, time:string|null, source_rel:string, date:string|null,
 *                 privacy_flags:Array<object>, redacted:boolean}>,
 *   privacy_flags: { any_redacted:boolean, families:string[], count:number, per_item:number }
 * }}
 */
function sanitizeItems(items, opts = {}) {
  const familySet = new Set();
  let totalFlags = 0;
  let redactedItems = 0;

  const sanitized = (items || []).map((item) => {
    const { text, flags, redacted } = sanitizeText(item.summary || '', opts);
    for (const f of flags) familySet.add(f.family);
    totalFlags += flags.length;
    if (redacted) redactedItems += 1;
    return {
      summary: text,
      time: item.time != null ? item.time : null,
      source_rel: item.source_rel || null,
      date: item.date != null ? item.date : null,
      privacy_flags: flags,
      redacted,
      // NOTE: `raw` is deliberately NOT carried forward — see function doc.
    };
  });

  return {
    items: sanitized,
    privacy_flags: {
      any_redacted: totalFlags > 0,
      families: Array.from(familySet).sort(),
      count: totalFlags,
      per_item: redactedItems,
    },
  };
}

module.exports = {
  MASK,
  STRUCTURAL_PATTERNS,
  denyTermToRegExp,
  fingerprint,
  applyDenyList,
  applyStructural,
  sanitizeText,
  sanitizeItems,
};
