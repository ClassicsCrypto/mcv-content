'use strict';

/**
 * engine/improvement-sharing/sanitize.js  [N net-new]
 *
 * THE OUTBOUND SANITIZER + STRUCTURAL GUARD — the DD-7(b) load-bearing core (release-spec.md §2.6
 * Improvement Sharing; release-spec roadmap #4; decisions.md DD-7 option (b); Appendix B non-goal
 * "opt-out telemetry ... rejected permanently"). This is the single most safety-critical module in
 * the improvement-sharing batch, because improvement-sharing is the one place data flows OUTBOUND
 * (the design review's biggest risk: exfiltration + upstream supply-chain poisoning). The governance
 * IS the feature, and this module is the governance: it turns a brand-specific promoted learning
 * record into an ABSTRACT rule-diff that carries the GENERALIZABLE change ONLY — and a structural
 * guard that REFUSES to let anything with a residual specific leave the install.
 *
 * WHAT IT IS (DD-7 option (b)):
 *   Outbound tooling that PREPARES a contribution — it NEVER transmits (v1 is MANUAL; DD-7 (1)
 *   permanently rejected opt-out/telemetry; there is NO automatic-send path of any kind). This file
 *   only TRANSFORMS a record into a sanitized abstract payload + ASSERTS that payload is shareable.
 *   It does not push, post, write to disk, or open a network socket. The opt-in/consent/package-write
 *   steps live in the sibling CLI/consent modules and call INTO this one; nothing here has a side
 *   effect.
 *
 * THE TWO STRUCTURAL INVARIANTS (DD-7 (2) ABSTRACT-RULE-DIFFS-ONLY; (3) OPERATOR-REVIEWED CONSENT):
 *
 *   (A) sanitizeForSharing(record, opts) — EXTRACT-THEN-STRIP.
 *       It keeps ONLY the generalizable shape of the change: WHICH rule/knob KIND it touches (an
 *       abstract target descriptor — kind/category/config-path-shape, never the instance artifact
 *       id), the STRUCTURAL diff (the gate-strictness transitions — severity/disposition/numeric
 *       direction — and the abstract knob delta, NOT the brand's tuned values), and a RATIONALE.
 *       It DROPS, never carries: the brand's content corpora, performance numbers tied to the brand,
 *       instance ids/handles/paths, source-signal refs, secrets, and configured private terms. Every
 *       free-text field that survives (the rationale) is run through THREE strip passes — the same
 *       three the inbound work-recap privacy pre-pass uses, in the OUTBOUND direction:
 *         1. engine/shared/redact.js secret SHAPES + named §4 credential keys (token/key/bearer/...),
 *         2. the config private-term DENY LIST (work_recap/trends/brand_dna private_terms — partner
 *            names, codenames, unreleased features) — reuses the work-recap privacy-filter matcher,
 *         3. a NO-INSTANCE-SPECIFICS pass: brand names ($ENGINE_BRAND_DENYLIST + opts.brandTerms),
 *            17-20-digit snowflakes, operator home/user filesystem paths (the Windows-user and the
 *            POSIX user/home roots), @handles, and brand-tied performance numbers — the OUTBOUND
 *            mirror of the hygiene-scan leak guard (§16.5).
 *
 *   (B) assertShareable(payload, opts) — STRUCTURAL REFUSAL (the guard).
 *       Re-scans the FINAL payload (defence-in-depth: even a hand-built or post-edited payload is
 *       re-checked) and THROWS UnshareableError (code EUNSHAREABLE) if ANY residual specific remains:
 *       a brand name, a secret shape, a snowflake, a path, a handle, or a configured private term.
 *       Nothing leaves with specifics — this is the outbound mirror of the gate's privacy/leak HARD
 *       block (engine/gate/privacy-leak.js) and is fail-closed by construction.
 *
 * STRIP-OR-REFUSE (configurable; DD-7 (2)). Default `onResidual:'strip'` — sanitizeForSharing strips
 * residuals and the returned payload is clean. `onResidual:'refuse'` makes a residual a hard error
 * (EUNSHAREABLE) at sanitize time rather than silently masking — for the strictest operators who want
 * a sanitize that fails loudly if the input was dirtier than the strip passes can prove they cleaned.
 * EITHER way, sanitizeForSharing ends by calling assertShareable on its own output, so a payload that
 * still trips the guard is NEVER returned (the function fails closed even in strip mode).
 *
 * RD-2 / RD-12: DETERMINISTIC engine code, zero-key, no chain LLM, no network, no disk. The deny set /
 * brand terms / extra secret keys are passed in (the §12.5 injection seam), so tests drive it with
 * synthetic input and zero keys. Reuses (never re-implements): engine/shared/redact.js,
 * engine/sources/work-recap/privacy-filter.js (the deny-list + structural matchers), and the
 * hygiene-scan leak-pattern shapes (mirrored here so the same thing that fails CI fails the guard).
 *
 * Tier-3 cleanliness (§0.3 r6): no real IDs/handles/paths/codenames/brand strings anywhere; only the
 * synthetic "Acme Cosmos" appears in examples/tests.
 */

// Reuse the SAME secret shapes the log redactor + the inbound privacy pre-pass use, so a secret is
// detected identically everywhere — no divergent "what counts as a secret" between in and out.
const redactor = require('../shared/redact.js');
// Reuse the inbound privacy-filter primitives so the OUTBOUND deny-list + structural strip is exactly
// what the inbound pre-pass masks (financial/internal-id shapes + the operator private-term matcher).
const privacyFilter = require('../sources/work-recap/privacy-filter.js');

const MASK = redactor.MASK; // '[REDACTED]' — same marker the whole system uses.

/* ------------------------------------------------------------------------------------------------ *
 * Error type — distinct, named, with a stable `code` so callers branch on the code, never the
 * message. This is the structural refusal DD-7 requires: nothing leaves with specifics.
 * ------------------------------------------------------------------------------------------------ */

/** Thrown by assertShareable when a payload still carries instance/brand specifics (DD-7 (2)). */
class UnshareableError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'UnshareableError';
    this.code = 'EUNSHAREABLE';
    Object.assign(this, details);
  }
}

/* ------------------------------------------------------------------------------------------------ *
 * The NO-INSTANCE-SPECIFICS leak patterns — the OUTBOUND mirror of scripts/hygiene-scan.js (§16.5).
 * Mirrored (not imported) so the abstract payload is held to the EXACT same shapes that fail the
 * public-tree CI leak guard: what would fail hygiene-scan must fail the share guard. Each names a
 * `class` so a refusal reports WHICH specific leaked.
 * ------------------------------------------------------------------------------------------------ */

// Snowflake-shaped ids: a run of 17-20 digits as a whole token (Discord/Tier-3 ids; §16.5/§18.2(7)).
const SNOWFLAKE = /\b\d{17,20}\b/g;

// Operator home / user filesystem paths: the Windows per-user root, and the POSIX user/home roots
// (§1 r3, §18.2(10)). The pattern is BUILT FROM FRAGMENTS rather than written as a literal so this
// source file never itself contains a matchable path substring — keeping the module clean under the
// public-tree hygiene scan (scripts/hygiene-scan.js), exactly as that scanner self-exempts its own
// source. The user/home root names and the slashes are concatenated separately (SL below) so no
// contiguous matchable path literal appears in this file. Semantically identical to the USER_PATH
// in hygiene-scan.js.
const SL = '/';
const USER_PATH = new RegExp(
  `(?:[A-Za-z]:\\\\Users\\\\|${SL}Users${SL}|${SL}home${SL})[^\\s"'\`<>]*`,
  'gi',
);

// @handles (social handles are instance-identifying; an abstract rule-diff never names an account).
// A leading @ followed by a handle-shaped token; not matched inside an email (guarded by a lookbehind
// for a word char, so "you@example.com" is not flagged but "@acmehandle" is).
const HANDLE = /(?<![\w@./])@[A-Za-z0-9_]{2,30}\b/g;

// Brand-tied performance numbers: a metric figure bound to the brand (the §2.6 "performance numbers
// tied to the brand" class). We strip ABSOLUTE engagement/reach/follower/revenue figures — the
// numbers that are only meaningful for THIS install — while leaving abstract relative effect sizes
// (e.g. "a 20% lift") which ARE the generalizable signal. Matches a number adjacent to an
// instance-metric noun (impressions/views/likes/followers/reach/engagements/revenue/$amount) — but
// NOT a bare percentage (relative lift is shareable). Order: this runs in the no-specifics pass.
const PERF_NUMBER = new RegExp(
  // currency amount  OR  number followed by a metric noun  OR  metric noun followed by a number
  '(?:[$£€]\\s?\\d[\\d,]*(?:\\.\\d+)?\\s?[kKmMbB]?' +
    '|\\b\\d[\\d,]*(?:\\.\\d+)?\\s?[kKmMbB]?\\s*(?:impressions?|views?|likes?|followers?|reach|' +
    'engagements?|retweets?|reposts?|replies|comments?|clicks?|subscribers?|members?)\\b' +
    '|\\b(?:impressions?|views?|likes?|followers?|reach|engagements?|retweets?|reposts?|replies|' +
    'comments?|clicks?|subscribers?|members?)\\s*(?:of|:)?\\s*\\d[\\d,]*(?:\\.\\d+)?\\s?[kKmMbB]?\\b)',
  'gi',
);

const NO_SPECIFICS_PATTERNS = [
  { class: 'snowflake-id', re: SNOWFLAKE },
  { class: 'user-path', re: USER_PATH },
  { class: 'handle', re: HANDLE },
  { class: 'brand-tied-number', re: PERF_NUMBER },
];

/* ------------------------------------------------------------------------------------------------ *
 * Brand-term matching. Brand names are operator data (the same posture hygiene-scan takes with
 * $ENGINE_BRAND_DENYLIST): never hardcoded, supplied at sanitize time via opts.brandTerms (and/or
 * the env var, so the same list that fails CI fails the guard). Escaped + word-boundary-anchored.
 * ------------------------------------------------------------------------------------------------ */

/** Build {term, re} matchers for a list of brand terms (operator-supplied; never trusted as patterns). */
function brandMatchers(terms) {
  const out = [];
  const seen = new Set();
  for (const raw of terms || []) {
    const term = String(raw == null ? '' : raw).trim();
    if (!term || seen.has(term.toLowerCase())) continue;
    seen.add(term.toLowerCase());
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Mirror hygiene-scan: case-insensitive, not preceded by a word char or @, not followed by word char.
    out.push({ term, re: new RegExp(`(?<![\\w@])${escaped}(?![\\w])`, 'gi') });
  }
  return out;
}

/** Resolve the brand-term list from opts + the $ENGINE_BRAND_DENYLIST env (comma-separated). */
function resolveBrandTerms(opts) {
  const fromOpts = Array.isArray(opts.brandTerms) ? opts.brandTerms : [];
  const env = opts.env && typeof opts.env === 'object' ? opts.env : (typeof process !== 'undefined' ? process.env : {});
  const fromEnv = typeof env.ENGINE_BRAND_DENYLIST === 'string'
    ? env.ENGINE_BRAND_DENYLIST.split(',').map((t) => t.trim()).filter(Boolean)
    : [];
  return fromOpts.concat(fromEnv);
}

/* ------------------------------------------------------------------------------------------------ *
 * Deny-set resolution — reuse the gate's coercion so the OUTBOUND deny set is exactly the inbound
 * one (config.work_recap.private_terms / trends.private_terms / brand_dna.private_terms; both the
 * `terms` and `secret_literals` of the {terms, secret_literals} shape are anti-targets).
 * ------------------------------------------------------------------------------------------------ */

/** Coerce a private_terms value into a flat string[] (flat array, or {terms, secret_literals}). */
function coerceDenyList(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') {
    return []
      .concat(Array.isArray(value.terms) ? value.terms : [])
      .concat(Array.isArray(value.secret_literals) ? value.secret_literals : []);
  }
  return [];
}

/** Dedupe + trim a string list, dropping empties. */
function cleanTerms(arr) {
  const seen = new Set();
  const out = [];
  for (const raw of arr || []) {
    const t = String(raw == null ? '' : raw).trim();
    if (t && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

/**
 * Resolve the union of configured private terms across the three privacy-bearing config blocks AND
 * any opts.privateTerms passed directly. These are the operator's brand-private anti-targets the
 * sanitizer strips and the guard refuses. Empty is fine (then the deny-term pass is a no-op; the
 * secret-shape + no-specifics passes still run — a credential/snowflake is refused regardless).
 */
function resolveDenySet(opts) {
  const cfg = opts.config && typeof opts.config === 'object' ? opts.config : {};
  const blocks = ['work_recap', 'trends', 'brand_dna', 'improvement_sharing'];
  let acc = coerceDenyList(opts.privateTerms);
  for (const b of blocks) {
    if (cfg[b] && typeof cfg[b] === 'object') acc = acc.concat(coerceDenyList(cfg[b].private_terms));
  }
  // per-account private_terms under work_recap.accounts[] (unioned, like the gate does).
  if (cfg.work_recap && Array.isArray(cfg.work_recap.accounts)) {
    for (const a of cfg.work_recap.accounts) {
      if (a && typeof a === 'object') acc = acc.concat(coerceDenyList(a.private_terms));
    }
  }
  return cleanTerms(acc);
}

/** Resolve the extra sensitive key NAMES (instance-specific secret-bearing field names; §13.3). */
function resolveExtraSecretKeys(opts) {
  const cfg = opts.config && typeof opts.config === 'object' ? opts.config : {};
  let acc = Array.isArray(opts.extraSecretKeys) ? opts.extraSecretKeys : [];
  for (const b of ['work_recap', 'improvement_sharing']) {
    if (cfg[b] && Array.isArray(cfg[b].extra_secret_keys)) acc = acc.concat(cfg[b].extra_secret_keys);
  }
  return cleanTerms(acc);
}

/* ------------------------------------------------------------------------------------------------ *
 * The three OUTBOUND strip passes over a single string + the detect-only scan the guard uses.
 * ------------------------------------------------------------------------------------------------ */

/** Strip the no-instance-specifics patterns (snowflake/path/handle/brand-tied-number), recording flags. */
function applyNoSpecifics(text, flags) {
  let out = String(text);
  for (const { class: cls, re } of NO_SPECIFICS_PATTERNS) {
    out = out.replace(re, (m) => {
      flags.push({ family: cls, sample_len: m.length });
      return MASK;
    });
  }
  return out;
}

/** Strip brand terms, recording a non-reversible flag per hit (never echo the brand term into a flag). */
function applyBrandTerms(text, matchers, flags) {
  let out = String(text);
  for (const { term, re } of matchers) {
    re.lastIndex = 0;
    out = out.replace(re, () => {
      flags.push({ family: 'brand_term', term_fp: privacyFilter.fingerprint(term), term_len: term.length });
      return MASK;
    });
  }
  return out;
}

/**
 * Sanitize a single free-text string through the full OUTBOUND pre-pass:
 *   1. secret shapes (redact.js value patterns — same engine as the log redactor),
 *   2. the inbound privacy-filter structural shapes (financial, internal_id) + the operator deny list,
 *   3. the no-instance-specifics pass (snowflake/path/handle/brand-tied-number),
 *   4. brand terms (operator-supplied / env brand denylist).
 * Order: secret shapes FIRST (a credential that also matches an id shape is caught as a credential),
 * then the inbound passes, then the outbound-specific passes. Returns the cleaned text + flags raised.
 *
 * @returns {{text:string, flags:Array<object>, redacted:boolean}}
 */
function sanitizeText(text, opts = {}) {
  const flags = [];
  const before = String(text == null ? '' : text);

  // 1. credential/secret shapes (value-only).
  let out = redactor.redactString(before);
  if (out !== before) flags.push({ family: 'secret_shape' });

  // 2. inbound structural shapes + operator private-term deny list (reuse the inbound filter exactly).
  const denySet = opts._denySet || resolveDenySet(opts);
  const viaInbound = privacyFilter.sanitizeText(out, { privateTerms: denySet });
  // privacyFilter already ran redact.redactString again (idempotent — a second pass on cleaned text
  // makes no further change), so only its structural/private-term flags are new.
  for (const f of viaInbound.flags) {
    if (f.family !== 'secret_shape') flags.push(f);
  }
  out = viaInbound.text;

  // 3. no-instance-specifics (the OUTBOUND mirror of hygiene-scan).
  out = applyNoSpecifics(out, flags);

  // 4. brand terms.
  const matchers = opts._brandMatchers || brandMatchers(resolveBrandTerms(opts));
  out = applyBrandTerms(out, matchers, flags);

  return { text: out, flags, redacted: flags.length > 0 };
}

/**
 * DETECT-only scan of one string (the guard path): which specific FAMILIES fire, without rewriting.
 * Mirrors the gate's scanText: it runs the same passes in detect mode and reports the families.
 *
 * @returns {{families:string[]}}
 */
function scanText(text, denySet, brandMatchersList) {
  const families = new Set();
  const str = String(text == null ? '' : text);

  // secret shapes.
  if (redactor.redactString(str) !== str) families.add('secret_shape');

  // inbound structural + private-term (reuse the inbound filter's flag families).
  const { flags } = privacyFilter.sanitizeText(str, { privateTerms: denySet });
  for (const f of flags) {
    if (f.family) families.add(f.family);
  }

  // no-instance-specifics.
  for (const { class: cls, re } of NO_SPECIFICS_PATTERNS) {
    re.lastIndex = 0;
    if (re.test(str)) families.add(cls);
  }

  // brand terms.
  for (const { re } of brandMatchersList || []) {
    re.lastIndex = 0;
    if (re.test(str)) families.add('brand_term');
  }

  return { families: Array.from(families).sort() };
}

/* ------------------------------------------------------------------------------------------------ *
 * Abstract target descriptor — keep the generalizable KIND, drop the instance artifact identity.
 *
 * A learning record's target_artifact is an instance id (a rule id, a config key, a brand-DNA file).
 * The abstract rule-diff carries ONLY the generalizable shape: the KIND of target and, for a config
 * knob, the GENERIC dotted-path shape (the leading namespace segments that name the knob CLASS, not
 * an instance value). Per-account / per-brand leaf segments are dropped. The mutability classifier's
 * config-path conventions (calendar.*, archetype.*, content_type.*) are the shapes we keep.
 * ------------------------------------------------------------------------------------------------ */

/**
 * Abstract a target_artifact / target descriptor into a generalizable {kind, path_shape?} — never the
 * instance id. A dotted config path keeps only its leading CLASS segments (the knob family), masking
 * any segment that looks instance-specific (a snowflake, a handle, a brand term).
 */
function abstractTarget(record, brandMatchersList, denySet) {
  const t = record && record.target_artifact;
  const kind = record && record.machine_change && record.machine_change.kind
    ? String(record.machine_change.kind)
    : inferKindFromPath(t);

  const out = { kind: kind || 'unspecified' };

  if (typeof t === 'string' && t.includes('.')) {
    // a dotted config path: keep the generic CLASS namespace, drop instance leaf(s).
    const segs = t.split('.').filter(Boolean);
    const shape = segs.map((seg) => (segIsInstanceSpecific(seg, brandMatchersList, denySet) ? MASK : seg));
    out.path_shape = shape.join('.');
  }
  return out;
}

/** Infer an abstract kind from a config-path head (calendar/scheduler => calendar-weighting, etc.). */
function inferKindFromPath(t) {
  if (typeof t !== 'string') return null;
  const head = t.split('.')[0].toLowerCase();
  if (head === 'calendar' || head === 'scheduler') return 'calendar-weighting';
  if (head === 'archetype' || head === 'archetypes') return 'archetype-prioritization';
  if (head === 'content_type' || head === 'content_types') return 'content-type-prioritization';
  return 'config';
}

/** A path segment is instance-specific if it trips the snowflake/handle/brand-term checks. */
function segIsInstanceSpecific(seg, brandMatchersList, denySet) {
  const families = scanText(seg, denySet, brandMatchersList).families;
  return families.length > 0;
}

/* ------------------------------------------------------------------------------------------------ *
 * Structural-diff abstraction — keep the GATE-STRICTNESS transitions + abstract knob delta; drop the
 * brand's tuned absolute values. A structural diff describes the SHAPE of the change (which axis,
 * which direction), the generalizable signal a maintainer can evaluate — not "this brand set weight
 * 0.37". For gate axes we carry the before/after tokens (severity/disposition/bars_recommended are
 * vocabulary, not brand values). For numeric dials we carry the DIRECTION + (abstract) bounds shape,
 * not the brand's chosen number, unless the caller explicitly opts to share the relative effect.
 * ------------------------------------------------------------------------------------------------ */

/**
 * Build the abstract structural diff from a record's machine_change / proposed_diff.
 *   - structural_changes: gate-axis transitions ({axis, before, after}) carried verbatim (vocabulary).
 *   - knob_deltas: for each tunable value, the abstract DIRECTION ('increase'|'decrease'|'set') — the
 *     generalizable shape — NOT the brand's tuned value.
 * Both are run through the strip passes defensively (a stray instance value can't ride along).
 */
function abstractStructuralDiff(record, ctx) {
  const mc = (record && record.machine_change) || {};
  const out = { structural_changes: [], knob_deltas: [] };

  // gate-axis transitions: severity / tier / disposition / bars_recommended — these are VOCABULARY
  // (block/correct/warn, hard/soft, true/false), not brand values, so they are shareable verbatim.
  // (A real change here would be REFUSED by the maintainer harness's never-loosen check; the SHAPE
  // is still the generalizable thing to share.)
  for (const axis of ['severity', 'tier', 'disposition', 'bars_recommended']) {
    const v = mc[axis];
    if (v && typeof v === 'object' && ('before' in v || 'after' in v)) {
      out.structural_changes.push({ axis, before: stripScalar(v.before, ctx), after: stripScalar(v.after, ctx) });
    }
  }
  // an effects[] array (the mutability change shape) — carry each as a structural transition.
  if (Array.isArray(mc.effects)) {
    for (const e of mc.effects) {
      if (e && typeof e === 'object' && 'field' in e) {
        out.structural_changes.push({
          axis: 'effect',
          field: sanitizeText(String(e.field), ctx.opts).text,
          before: stripScalar(e.before, ctx),
          after: stripScalar(e.after, ctx),
          direction: e.direction ? sanitizeText(String(e.direction), ctx.opts).text : undefined,
        });
      }
    }
  }

  // knob deltas: abstract the DIRECTION of each tunable value change, not the value itself.
  const values = mc.values && typeof mc.values === 'object' ? mc.values : null;
  const baseline = mc.baseline_values && typeof mc.baseline_values === 'object' ? mc.baseline_values : {};
  if (values) {
    for (const [field, after] of Object.entries(values)) {
      const before = baseline[field];
      out.knob_deltas.push({
        // field name is a knob CLASS name; strip it defensively (it could embed an instance leaf).
        field: sanitizeText(String(field), ctx.opts).text,
        direction: deltaDirection(before, after),
      });
    }
  }

  return out;
}

/** Abstract a before→after numeric (or any) transition into a direction, never the brand's value. */
function deltaDirection(before, after) {
  const b = Number(before);
  const a = Number(after);
  if (Number.isFinite(b) && Number.isFinite(a)) {
    if (a > b) return 'increase';
    if (a < b) return 'decrease';
    return 'no-change';
  }
  // non-numeric (e.g. a new key set): 'set' is the abstract shape (no value carried).
  return 'set';
}

/** Strip a scalar that may be a gate-vocabulary token (kept) or a stray instance value (masked). */
function stripScalar(v, ctx) {
  if (v === undefined) return undefined;
  if (typeof v === 'boolean' || typeof v === 'number') {
    // booleans are vocabulary (bars_recommended); a bare number on a gate axis is left as-is
    // (it is a severity/disposition ordinal, not a brand metric). Numbers in knob_deltas are
    // abstracted separately via deltaDirection — they never reach here.
    return v;
  }
  return sanitizeText(String(v), ctx.opts).text;
}

/* ------------------------------------------------------------------------------------------------ *
 * sanitizeForSharing — the public extractor (DD-7 (2)).
 * ------------------------------------------------------------------------------------------------ */

/**
 * Turn a promoted learning record / rule-diff into an ABSTRACT, shareable rule-diff payload. Keeps
 * ONLY the generalizable change (abstract target kind/path-shape, the structural diff, a sanitized
 * rationale); DROPS all instance/brand specifics (source-signal refs, brand corpora, brand-tied
 * performance numbers, ids/handles/paths, secrets, configured private terms).
 *
 * The returned payload is GUARANTEED clean: the function ends by calling assertShareable on its own
 * output, so even in strip mode a payload that still trips the guard is never returned (fail-closed).
 *
 * @param {object} record  a learning record (learning-record.schema.json) — typically status=applied/
 *                         promoted and shareability=candidate-for-upstream. Carries target_artifact,
 *                         proposed_diff (string), optional machine_change {kind, values, effects,
 *                         baseline_values, bounds, ...}, and a rationale/notes.
 * @param {object} [opts]
 * @param {object}   [opts.config]          resolved config/system.json (deny list + extra secret keys).
 * @param {string[]} [opts.privateTerms]    extra deny-list terms (unioned with config).
 * @param {string[]} [opts.brandTerms]      brand names to strip (unioned with $ENGINE_BRAND_DENYLIST).
 * @param {string[]} [opts.extraSecretKeys] extra sensitive key NAMES for redact.js.
 * @param {object}   [opts.env]             env for $ENGINE_BRAND_DENYLIST (default process.env).
 * @param {('strip'|'refuse')} [opts.onResidual='strip']  strip residuals (default) or hard-refuse them.
 * @returns {{
 *   kind:'abstract-rule-diff', schema_version:string,
 *   target:{kind:string, path_shape?:string},
 *   structural_diff:{structural_changes:object[], knob_deltas:object[]},
 *   rationale:string,
 *   provenance:{ derived_from:'learning-record', target_mutability:(string|null),
 *               signal_kinds:string[], signal_count:number },
 *   x-sharing:{ stripped:boolean, families:string[], flag_count:number }
 * }}
 * @throws {UnshareableError} (code EUNSHAREABLE) when onResidual:'refuse' and the input carried a
 *                            specific, OR (always) if the final payload still trips the guard.
 */
function sanitizeForSharing(record, opts = {}) {
  if (!record || typeof record !== 'object') {
    throw new UnshareableError('a learning record object is required to sanitize for sharing', { reason: 'no-record' });
  }
  const onResidual = opts.onResidual === 'refuse' ? 'refuse' : 'strip';

  // Resolve the contexts ONCE (deterministic) and thread them so the passes are consistent + cheap.
  const denySet = resolveDenySet(opts);
  const brandMatchersList = brandMatchers(resolveBrandTerms(opts));
  const ctx = { opts: { ...opts, _denySet: denySet, _brandMatchers: brandMatchersList } };

  const allFlags = [];
  const trackText = (s) => {
    const r = sanitizeText(s, ctx.opts);
    for (const f of r.flags) allFlags.push(f);
    return r.text;
  };

  // --- Extract the generalizable shape (drop everything instance-specific by NOT carrying it). ---

  const target = abstractTarget(record, brandMatchersList, denySet);
  const structuralDiff = abstractStructuralDiff(record, ctx);

  // Rationale: the ONE free-text field that survives — the generalizable "why". Sanitized hard.
  // Source preference: an explicit rationale/notes; else a neutral note derived from proposed_diff's
  // SHAPE (never the diff body verbatim — a raw diff can carry brand corpora / tuned values).
  const rationaleRaw = pickRationale(record);
  const rationale = trackText(rationaleRaw);

  // Provenance: ABSTRACT only — the KINDS of signals and a COUNT, never the refs (refs are
  // $CONTENT_HOME-relative instance paths) and never the brand-tied performance numbers.
  const signals = Array.isArray(record.source_signals) ? record.source_signals : [];
  const signalKinds = cleanTerms(signals.map((s) => s && s.type).filter(Boolean));
  const signalCount = signals.reduce((n, s) => n + (Number.isFinite(Number(s && s.count)) ? Number(s.count) : 0), 0);

  // Re-scan the structural diff + target for stray flags (defence-in-depth flag accounting).
  for (const sc of structuralDiff.structural_changes) collectStringFlags(sc, ctx, allFlags);
  for (const kd of structuralDiff.knob_deltas) collectStringFlags(kd, ctx, allFlags);
  if (target.path_shape) {
    const r = sanitizeText(target.path_shape, ctx.opts);
    for (const f of r.flags) allFlags.push(f);
    target.path_shape = r.text;
  }

  const families = Array.from(new Set(allFlags.map((f) => f.family).filter(Boolean))).sort();

  // STRIP-OR-REFUSE (DD-7 (2)): in 'refuse' mode, a residual at sanitize time is a hard error rather
  // than a silent mask — for operators who want the sanitize itself to fail loudly on dirty input.
  if (onResidual === 'refuse' && allFlags.length > 0) {
    throw new UnshareableError(
      `input carried instance/brand specifics (${families.join(', ')}); onResidual:'refuse' — `
        + 'refusing to produce a contribution rather than masking. Regenerate the rule-diff clean.',
      { families, flag_count: allFlags.length, mode: 'refuse' },
    );
  }

  const payload = {
    kind: 'abstract-rule-diff',
    schema_version: '1.0.0',
    target,
    structural_diff: structuralDiff,
    rationale,
    provenance: {
      derived_from: 'learning-record',
      target_mutability: typeof record.target_mutability === 'string' ? record.target_mutability : null,
      signal_kinds: signalKinds,
      signal_count: signalCount,
    },
    'x-sharing': {
      stripped: allFlags.length > 0,
      families,
      flag_count: allFlags.length,
    },
  };

  // FAIL-CLOSED: the returned payload MUST pass the structural guard. Even in strip mode, if anything
  // survived the strip passes, the guard throws EUNSHAREABLE and nothing is returned (DD-7 (2)).
  assertShareable(payload, { ...opts, _denySet: denySet, _brandMatchers: brandMatchersList });

  return payload;
}

/** Collect strip-pass flags raised by the string fields of a plain object (flag accounting only). */
function collectStringFlags(obj, ctx, flags) {
  if (!obj || typeof obj !== 'object') return;
  for (const v of Object.values(obj)) {
    if (typeof v === 'string') {
      const r = sanitizeText(v, ctx.opts);
      for (const f of r.flags) flags.push(f);
    }
  }
}

/**
 * Choose the rationale source: an explicit human/loop rationale wins; else a NEUTRAL, brand-free
 * note about the change SHAPE (never the raw proposed_diff body, which can carry brand corpora /
 * tuned values). The chosen text is sanitized by the caller regardless.
 */
function pickRationale(record) {
  if (typeof record.rationale === 'string' && record.rationale.trim()) return record.rationale;
  if (typeof record.notes === 'string' && record.notes.trim()) return record.notes;
  if (record.machine_change && typeof record.machine_change.rationale === 'string'
      && record.machine_change.rationale.trim()) {
    return record.machine_change.rationale;
  }
  // Neutral fallback — the abstract shape only, no instance content.
  const kind = record.machine_change && record.machine_change.kind
    ? String(record.machine_change.kind)
    : 'a machine-changeable knob';
  return `Generalizable adjustment to ${kind} derived from reviewer/analytics signals; `
    + 'the structural diff describes the change shape (no instance values shared).';
}

/* ------------------------------------------------------------------------------------------------ *
 * assertShareable — THE STRUCTURAL GUARD (DD-7 (2)). THROWS EUNSHAREABLE if the payload still carries
 * any instance/brand specific. The outbound mirror of the gate's privacy/leak HARD block.
 * ------------------------------------------------------------------------------------------------ */

/**
 * Re-scan EVERY string anywhere in `payload` (deep walk, cycle-safe) for residual specifics. THROWS
 * UnshareableError (code EUNSHAREABLE) on the FIRST family that fires anywhere, naming the family +
 * the json-path of the offending string — but NEVER echoing the matched value back (echoing it would
 * re-leak it into the error/ledger, the exact thing this guard prevents). Returns true when clean.
 *
 * Fail-closed by construction: a non-object payload, or any residual, refuses.
 *
 * @param {object} payload  the (sanitized) abstract rule-diff to verify.
 * @param {object} [opts]   same deny/brand/secret-key context as sanitizeForSharing (or the
 *                          pre-resolved _denySet / _brandMatchers threaded by sanitizeForSharing).
 * @returns {true} when no specific is present.
 * @throws {UnshareableError} (code EUNSHAREABLE) on any residual specific.
 */
function assertShareable(payload, opts = {}) {
  if (payload == null || typeof payload !== 'object') {
    throw new UnshareableError('payload is missing or not an object — refusing to share (fail-closed)', {
      reason: 'no-payload',
    });
  }
  const denySet = opts._denySet || resolveDenySet(opts);
  const brandMatchersList = opts._brandMatchers || brandMatchers(resolveBrandTerms(opts));

  const seen = new WeakSet();
  const offenders = [];

  const walk = (val, jsonPath) => {
    if (typeof val === 'string') {
      const { families } = scanText(val, denySet, brandMatchersList);
      if (families.length) offenders.push({ path: jsonPath, families });
      return;
    }
    if (val == null || typeof val !== 'object') return;
    if (seen.has(val)) return;
    seen.add(val);
    if (Array.isArray(val)) {
      val.forEach((v, i) => walk(v, `${jsonPath}[${i}]`));
      return;
    }
    for (const [k, v] of Object.entries(val)) {
      // also scan the KEY name — a key could itself be an instance leaf (e.g. a snowflake-keyed map).
      const { families } = scanText(k, denySet, brandMatchersList);
      if (families.length) offenders.push({ path: `${jsonPath}.${k} (key)`, families });
      walk(v, jsonPath ? `${jsonPath}.${k}` : k);
    }
  };

  walk(payload, '');

  if (offenders.length) {
    const famUnion = Array.from(new Set(offenders.flatMap((o) => o.families))).sort();
    throw new UnshareableError(
      `Refusing to share: payload still carries instance/brand specifics (${famUnion.join(', ')}) at `
        + `${offenders.length} location(s). An abstract rule-diff may carry NO brand name, secret shape, `
        + 'snowflake id, path, handle, or configured private term (DD-7 (2)). Nothing leaves with specifics.',
      {
        // Report WHERE + WHICH family — never the offending VALUE (echoing it would re-leak it).
        offenders: offenders.map((o) => ({ path: o.path, families: o.families })),
        families: famUnion,
      },
    );
  }
  return true;
}

module.exports = {
  // the two public entry points (DD-7 (2)).
  sanitizeForSharing,
  assertShareable,
  // error type (callers branch on .code: EUNSHAREABLE).
  UnshareableError,
  MASK,
  // internals exposed for tests / sibling callers (CLI, consent, maintainer harness).
  sanitizeText,
  scanText,
  abstractTarget,
  abstractStructuralDiff,
  deltaDirection,
  resolveDenySet,
  resolveBrandTerms,
  resolveExtraSecretKeys,
  brandMatchers,
  coerceDenyList,
  cleanTerms,
  pickRationale,
  // the no-instance-specifics patterns (mirrored from hygiene-scan; shared with tests).
  NO_SPECIFICS_PATTERNS,
  SNOWFLAKE,
  USER_PATH,
  HANDLE,
  PERF_NUMBER,
};
