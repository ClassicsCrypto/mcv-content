'use strict';

/**
 * engine/gate/privacy-leak.js  [N net-new]
 *
 * THE PRIVACY / LEAK gate for source-sourced content (release-spec §2.4 the double gate;
 * §3.3 operator/founder/team accounts; §8.8 a source feeds the EXISTING chain; §13.3
 * redact-at-write; the prompt's MEMORY-SOURCE / privacy-is-load-bearing law). This is the
 * deterministic privacy backstop that sits IN the chain between the writer/package and the
 * HUMAN approval card — defense in depth, even though the human is the final backstop (§2.4).
 *
 * WHY IT EXISTS:
 *   The work-recap source distils SENSITIVE project memory (secrets, partner names, unreleased
 *   codenames, financials, internal ids). The source runs a privacy PRE-PASS (engine/sources/
 *   work-recap/privacy-filter.js) that masks sensitive spans and emits a `privacy_flags` record.
 *   But the writer rewrites the seed into fresh copy — it could re-introduce a sensitive term the
 *   matcher/writer saw in the angle/proof-stack, or carry forward a residual leak the pre-pass
 *   missed. This gate RE-VERIFIES the final draft/package text deterministically so that NO leaked
 *   draft ever reaches a human on a card. A hit is HARD: it routes back to the writer (route
 *   `writer`), exactly like the fact firewall — no human ever sees a leaked draft on a card.
 *
 * WHAT IT HARD-BLOCKS (any one ⇒ SYS.PRIVATE_LEAK, HARD, route writer):
 *   1. UNRESOLVED PRIVACY FLAGS from the memory source. The source's `privacy_flags.any_redacted`
 *      marks that the pre-pass DID mask sensitive material. The gate treats unresolved upstream
 *      flags as a leak signal: if the source flagged sensitive content AND the final copy still
 *      carries a secret shape / structural sensitive shape / configured private term, it blocks.
 *      (A clean draft whose source merely flagged-and-masked is NOT blocked — only RESIDUAL
 *      leakage in the FINAL copy blocks; see "Two inputs" below.)
 *   2. SECRET SHAPES in the copy — reusing redact.js value-shape patterns (tokens, bearer creds,
 *      signed-url params, long opaque blobs, prefixed-key families). The same engine the log
 *      redactor and the source pre-pass use, so detection is consistent across the system.
 *   3. A configured work_recap.private_term (partner name, codename, unreleased feature) appears
 *      verbatim in the copy — reusing the source's privacy-filter deny-list matcher.
 *      Also catches the neutral STRUCTURAL shapes (financial amounts, internal-id shapes).
 *
 * TWO INPUTS, ONE VERDICT:
 *   - The COPY (the draft variants or the package's public variant bodies) — what a human would
 *     see. This is the thing that must be clean.
 *   - The upstream privacy CONTEXT (the source seed's privacy_flags + the resolved deny set +
 *     extra secret key names). This tells the gate WHAT to look for and that the content came from
 *     a sensitive source at all. For non-source content (no privacy context), the gate still runs
 *     the universal secret-shape + structural scan (a credential pasted into any draft is a leak),
 *     but the configured-private-term scan is a no-op (no deny set), so ordinary brand content is
 *     never penalized.
 *
 * HONEST SCOPE (matches redact.js / privacy-filter.js §13.3): pattern + known-name detection,
 * NOT semantic DLP. It cannot infer that an unflagged proper noun is a secret partner. That is
 * exactly why (a) the operator extends the deny list, (b) the source pre-pass runs first, and
 * (c) the human card is the final backstop. This module hardcodes NO real private terms/values
 * and ships brand-neutral (§0.3 r6): the only example anywhere is the synthetic "Acme Cosmos".
 *
 * REGISTRY / SCHEMA: emits SYS.PRIVATE_LEAK (rules/codes.md; rule.sys.privacy-leak). Per the SYS
 * convention (the validation-result `source` enum has no privacy/system value), the detected-code
 * entry registers with `source: 'package'` and `stage: 'package'` — the same publish-edge layer the
 * other SYS.* integrity codes use — so the result validates against
 * schemas/artifacts/validation-result.schema.json. tier hard ⇒ disposition block; route writer.
 *
 * TESTABILITY (RD-12, no secrets in CI): pure functions over plain objects + strings. No I/O, no
 * network, no keys. The deny set / extra secret keys / privacy flags are passed in (the §12.5
 * injection-seam pattern), so tests drive it with synthetic copy + fake flags and zero keys.
 *
 * Programmatic API (the gate pipeline + re-gate path call this):
 *   const { checkPrivacy } = require('./privacy-leak');
 *   const result = checkPrivacy({ draft, seed, config });   // a §7.2 validation-result
 *   // result.verdict is 'FAIL' (route back to writer) or 'PASS'.
 *
 * CLI (operator/debug + zero-key smoke):
 *   node engine/gate/privacy-leak.js --draft <draft.json> [--seed <seed.json>]
 *                                    [--config <system.json>] [--json]
 *   node engine/gate/privacy-leak.js --selftest        # synthetic fixtures, no CONTENT_HOME
 * Exit: 0 PASS (advance toward the card) · 1 FAIL (route back to writer) · 2 usage.
 */

const STAGE = 'package'; // SYS convention: publish-edge layer (validation-result source enum has no system value).
const SOURCE = 'package';
const FAMILY = 'SYS';

// Reuse the SAME redaction shapes the log redactor + the source privacy pre-pass use, so a secret
// is detected identically everywhere in the system (no divergent "what counts as a secret").
const redactor = require('../shared/redact.js');
// Reuse the source's privacy-filter primitives so the gate enforces EXACTLY what the pre-pass
// masked: the structural shapes (financial, internal_id) and the operator deny-list matcher.
const privacyFilter = require('../sources/work-recap/privacy-filter.js');

// SYS.* code metadata (code / tier / disposition / route / rule_ref) — emit-side mirror of
// rules/codes.md (spec §7.3/§10.2). HARD: a residual leak blocks the publish/approval edge and
// routes back to the writer (the seat that produced the copy). rules/codes.md is canonical.
const CODES = {
  PRIVATE_LEAK: {
    code: 'SYS.PRIVATE_LEAK',
    tier: 'hard',
    disposition: 'block',
    route: 'writer',
    rule_ref: 'rule.sys.privacy-leak',
  },
};

/** Build a §7.2 detected_codes entry from the CODES row + explanation (+ optional variant label). */
function makeCode(meta, explanation, variantLabel) {
  const entry = {
    code: meta.code,
    family: FAMILY,
    tier: meta.tier,
    source: SOURCE,
    disposition: meta.disposition,
    rule_ref: meta.rule_ref,
    explanation,
  };
  if (variantLabel) entry.variant_label = variantLabel;
  return entry;
}

// ---------------------------------------------------------------------------
// Deny-set / privacy-context resolution (reuses the source's coercion shapes)
// ---------------------------------------------------------------------------

/**
 * Coerce a deny-list value into a flat string[] of forbidden terms. Mirrors
 * engine/sources/seed.js coerceDenyList: accepts a flat string[] OR the config/source deny-list
 * object `{ terms[], secret_literals[] }` (what work_recap.private_terms / a source seed carry).
 * Both `terms` and `secret_literals` are forbidden-to-print anti-targets. Anything else ⇒ [].
 */
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
 * Resolve the privacy CONTEXT for a check from the (optional) source seed + (optional) config:
 *   - denySet:        the union of configured + seed-carried private terms (anti-targets to scan
 *                     the copy for). Reuses the §coerceDenyList shapes. May be empty for non-source
 *                     content (then the deny-term scan is a no-op; secret-shape + structural still run).
 *   - extraSecretKeys: extra sensitive key NAMES (config.work_recap.extra_secret_keys / §13.3) the
 *                     redactor treats as secret-bearing — surfaced so callers can extend redact.js.
 *   - upstreamFlags:  the source seed's aggregate privacy_flags (any_redacted/families/...) — the
 *                     evidence the pre-pass masked sensitive material; carried onto the result.
 *   - fromSource:     whether this content came from a content source at all (seed present).
 *
 * @param {object} [seed]    a content-source seed (work-recap seed or any source seed) with
 *                           privacy_flags / private_terms. Optional — absent ⇒ non-source content.
 * @param {object} [config]  resolved config/system.json (reads config.work_recap.private_terms,
 *                           config.work_recap.extra_secret_keys). Optional.
 */
function resolvePrivacyContext(seed, config) {
  const wr = (config && typeof config === 'object' && config.work_recap) ? config.work_recap : {};

  const fromConfig = coerceDenyList(wr.private_terms);

  let fromSeed = [];
  let upstreamFlags = null;
  let fromSource = false;
  if (seed && typeof seed === 'object') {
    fromSource = true;
    // A seed carries forbidden terms two ways: an explicit private_terms/forbidden list, and the
    // aggregate privacy_flags record (which may carry a residual `terms` anti-target list).
    fromSeed = fromSeed
      .concat(coerceDenyList(seed.private_terms))
      .concat(coerceDenyList(seed.forbidden));
    const pf = seed.privacy_flags && typeof seed.privacy_flags === 'object' ? seed.privacy_flags : null;
    if (pf) {
      upstreamFlags = pf;
      fromSeed = fromSeed.concat(coerceDenyList(pf.terms || pf.private_terms));
    }
    // provenance.private_terms (the work-recap seed envelope from engine/sources/seed.js carries
    // the resolved deny set on provenance).
    if (seed.provenance && typeof seed.provenance === 'object') {
      fromSeed = fromSeed.concat(coerceDenyList(seed.provenance.private_terms));
    }
  }

  return {
    denySet: cleanTerms(fromConfig.concat(fromSeed)),
    extraSecretKeys: cleanTerms(coerceDenyList(wr.extra_secret_keys)),
    upstreamFlags,
    fromSource,
  };
}

// ---------------------------------------------------------------------------
// The leak scan over a single string (the core detector)
// ---------------------------------------------------------------------------

/**
 * Scan one copy string for residual leakage. Runs the SAME three passes as the source pre-pass
 * (so the gate enforces exactly what the pre-pass was supposed to mask), but in DETECT mode — it
 * reports which families fired without rewriting the text. Returns the per-family hits.
 *
 * @param {string} text
 * @param {string[]} denySet      configured/seed private terms (operator anti-targets).
 * @returns {{ secret_shape:boolean, financial:boolean, internal_id:boolean,
 *             private_term:boolean, families:string[] }}
 */
function scanText(text, denySet) {
  const families = new Set();
  const str = String(text == null ? '' : text);

  // 1. Secret shapes (reuse redact.js value patterns; if the redactor would change the string, a
  //    secret-shaped span is present).
  const secretShape = redactor.redactString(str) !== str;
  if (secretShape) families.add('secret_shape');

  // 2 + 3. Structural shapes (financial, internal_id) + the operator deny list — reuse the source
  //    privacy-filter so detection is identical to what the pre-pass masks. sanitizeText returns
  //    the masked text + the flags it WOULD raise; we read the flags (detect-only — masked text
  //    is discarded here; the gate blocks rather than silently masking published copy).
  const { flags } = privacyFilter.sanitizeText(str, { privateTerms: denySet });
  for (const f of flags) {
    if (f.family) families.add(f.family);
  }

  return {
    secret_shape: families.has('secret_shape'),
    financial: families.has('financial'),
    internal_id: families.has('internal_id'),
    private_term: families.has('private_term'),
    families: Array.from(families).sort(),
  };
}

// ---------------------------------------------------------------------------
// Copy extraction — accept a draft OR a package OR raw strings
// ---------------------------------------------------------------------------

/**
 * Pull the human-visible COPY units out of the input as `{label, text}` rows. Accepts:
 *   - a draft (schemas/inputs/draft.schema.json): {variants:[{label,text}]}
 *   - a package (schemas/artifacts/package.schema.json): {recommended,variant_a,variant_b:{text}}
 *   - a plain string (a single body) or string[] (each a body)
 * Only the PUBLIC-FACING copy is scanned — the parts a human sees on the card / a follower sees on
 * the post. Internal scaffold (briefs, enrichment packets, provenance) is NOT scanned here: those
 * never reach a human card, and the source pre-pass + seed bridge already keep raw memory out of
 * the seed. (The package gate's PKG.ENRICHMENT_PACKET_LEAK guards scaffold-into-copy separately.)
 */
function copyUnits(input) {
  if (input == null) return [];
  if (typeof input === 'string') return [{ label: 'body', text: input }];
  if (Array.isArray(input)) {
    return input.map((t, i) => ({ label: `body-${i + 1}`, text: String(t == null ? '' : t) }));
  }
  if (typeof input !== 'object') return [];

  // Draft shape.
  if (Array.isArray(input.variants)) {
    return input.variants.map((v, i) => ({
      label: (v && v.label) || `variant-${i + 1}`,
      text: String((v && v.text) == null ? '' : v.text),
    }));
  }

  // Package shape.
  const out = [];
  const pushVariant = (slot, v) => {
    if (v && typeof v === 'object' && v.text != null) out.push({ label: slot, text: String(v.text) });
  };
  if (input.recommended || input.variant_a || input.variant_b) {
    pushVariant('Recommended', input.recommended);
    pushVariant('Variant A', input.variant_a);
    pushVariant('Variant B', input.variant_b);
    return out;
  }

  return out;
}

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

/**
 * Run the deterministic privacy/leak check over a draft or package, with the source's privacy
 * context. Returns a validation-result (spec §7.2). ANY residual leak ⇒ verdict FAIL with a
 * SYS.PRIVATE_LEAK code routed back to the writer (no human ever sees a leaked draft on a card).
 *
 * The check is HARD/fail-closed by construction. It never auto-corrects (a privacy leak is never
 * silently masked into published copy — that would risk an awkward [REDACTED] in a public post and
 * hide a real upstream problem); it blocks and routes back so the writer regenerates clean copy.
 *
 * @param {object} args
 * @param {object|string|string[]} [args.draft]   the writer draft (or package, or raw copy) to scan.
 * @param {object} [args.package]                 alias for a package input (same as draft).
 * @param {object} [args.seed]                    the originating content-source seed (work-recap /
 *                                                any source) carrying privacy_flags + private_terms.
 * @param {object} [args.config]                  resolved config/system.json (work_recap.private_terms,
 *                                                work_recap.extra_secret_keys).
 * @param {string} [args.content_id]              content id for the result envelope (else from input).
 * @returns {object} a §7.2 validation-result: { content_id, stage:'package', verdict, detected_codes[],
 *                   rationale, x-privacy:{...evidence} }.
 */
function checkPrivacy(args = {}) {
  const input = args.draft != null ? args.draft : args.package;
  const { denySet, extraSecretKeys, upstreamFlags, fromSource } = resolvePrivacyContext(args.seed, args.config);

  const contentId = args.content_id
    || (input && typeof input === 'object' && !Array.isArray(input) && (input.content_id
        || (input.audit_header && input.audit_header.content_id)))
    || (args.seed && (args.seed.content_id || (args.seed.provenance && args.seed.provenance.content_id)))
    || null;

  const units = copyUnits(input);
  const detected = [];
  const perUnit = [];

  for (const unit of units) {
    const hit = scanText(unit.text, denySet);
    perUnit.push({ label: unit.label, families: hit.families });
    if (hit.families.length === 0) continue;
    // Build a precise, NON-LEAKING explanation: name the families that fired, never echo the
    // matched secret/term back (echoing it would re-leak it into the result/ledger — the exact
    // thing this gate prevents). The family names tell the writer WHAT class to remove.
    const why = hit.families.join(', ');
    detected.push(makeCode(
      CODES.PRIVATE_LEAK,
      `${unit.label} carries residual sensitive material (${why}) — `
        + 'route back to the writer to regenerate clean copy before any human sees it',
      unit.label,
    ));
  }

  // Upstream-flag corroboration: if the source flagged that it masked sensitive material AND the
  // final copy still trips a detector, that is the worst case (a re-introduced leak). We do not
  // ADD a separate code for it (one SYS.PRIVATE_LEAK per leaking unit is the contract), but we
  // record it on the evidence so the route-back reason is auditable. A source that flagged-and-
  // masked with CLEAN final copy is correctly NOT blocked (the pre-pass did its job).
  const upstreamRedacted = Boolean(upstreamFlags && upstreamFlags.any_redacted);

  const hasHard = detected.some((d) => d.tier === 'hard');
  const verdict = hasHard ? 'FAIL' : 'PASS';

  return {
    content_id: contentId,
    stage: STAGE,
    verdict,
    detected_codes: detected,
    rationale: verdict === 'FAIL'
      ? 'Privacy/leak gate found residual sensitive material in the copy; HARD-block and route back '
        + 'to the writer so no human sees a leaked draft on the approval card (defense in depth, §2.4).'
      : (fromSource
          ? 'Privacy/leak gate clean: source-derived copy carries no residual secret shape, structural '
            + 'sensitive shape, or configured private term. The human card remains the final backstop.'
          : 'Privacy/leak gate clean: copy carries no secret shape or sensitive structural shape.'),
    // Engine-internal evidence (not part of the §7.2 schema; additionalProperties allows it).
    'x-privacy': {
      from_source: fromSource,
      deny_terms: denySet.length,
      extra_secret_keys: extraSecretKeys.length,
      upstream_redacted: upstreamRedacted,
      upstream_families: upstreamFlags && Array.isArray(upstreamFlags.families) ? upstreamFlags.families : [],
      units_scanned: units.length,
      per_unit: perUnit,
      routing: verdict === 'FAIL' ? 'RETURN_TO_WRITER (leak blocked before the approval card)' : 'ADVANCE',
    },
  };
}

module.exports = {
  checkPrivacy,
  // Exposed for the registry-integrity check + tests (emit-side code table).
  CODES,
  STAGE,
  // Exposed for tests / sibling callers.
  scanText,
  copyUnits,
  resolvePrivacyContext,
  coerceDenyList,
};

// --- CLI ------------------------------------------------------------------------------------
// Only runs when invoked directly. The gate pipeline imports checkPrivacy() and never shells out.

if (require.main === module) {
  // eslint-disable-next-line global-require
  const fs = require('fs');
  const arg = (n, d) => {
    const i = process.argv.indexOf(`--${n}`);
    return i >= 0 ? process.argv[i + 1] : d;
  };
  const asJson = process.argv.includes('--json');

  if (process.argv.includes('--selftest')) {
    process.exit(runSelfTest());
  }

  const df = arg('draft');
  if (!df || !fs.existsSync(df)) {
    process.stderr.write('--draft <draft.json> required (or use --selftest)\n');
    process.exit(2);
  }
  let draft;
  try {
    draft = JSON.parse(fs.readFileSync(df, 'utf8'));
  } catch (e) {
    process.stderr.write(`--draft is not valid JSON: ${e.message}\n`);
    process.exit(2);
  }

  let seed;
  const sf = arg('seed');
  if (sf && fs.existsSync(sf)) {
    try { seed = JSON.parse(fs.readFileSync(sf, 'utf8')); } catch { /* a malformed seed => no context */ }
  }
  let config;
  const cf = arg('config');
  if (cf && fs.existsSync(cf)) {
    try { config = JSON.parse(fs.readFileSync(cf, 'utf8')); } catch { /* malformed config => no context */ }
  }

  const result = checkPrivacy({ draft, seed, config });
  const pass = result.verdict !== 'FAIL';
  if (asJson) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(
      `privacy-leak: ${pass ? 'PASS — no residual leak' : 'FAIL — leak blocked, return to writer'}\n`,
    );
    for (const d of result.detected_codes) {
      process.stdout.write(`  - ${d.tier}: ${d.code} ${d.explanation}\n`);
    }
  }
  process.exitCode = pass ? 0 : 1;
}

/**
 * Self-test on SYNTHETIC fixtures (no real corpus, no CONTENT_HOME, no keys). Asserts the four
 * block classes (secret shape, financial, internal-id, configured private term) and the two clean
 * classes (clean source-derived copy, ordinary brand copy). Synthetic Acme Cosmos only (§0.3 r6).
 */
function runSelfTest() {
  let fails = 0;
  const log = (s) => process.stdout.write(`${s}\n`);
  const err = (s) => process.stderr.write(`${s}\n`);
  const draftOf = (text) => ({
    content_id: 'selftest',
    brand: 'acme-cosmos',
    platform: 'twitter',
    format: 'text',
    variants: [
      { label: 'recommended', text },
      { label: 'variant-a', text: 'Sixty builders shipped working demos at the Acme Cosmos beta this week.' },
      { label: 'variant-b', text: 'We asked for working demos and sixty arrived. Here is the recap.' },
    ],
  });
  const expectFail = (name, args, family) => {
    const r = checkPrivacy(args);
    const fired = r.detected_codes.some((d) => d.code === 'SYS.PRIVATE_LEAK');
    const fam = r['x-privacy'].per_unit.some((u) => u.families.includes(family));
    if (r.verdict !== 'FAIL' || !fired || !fam) {
      err(`FAIL: ${name} did not block on ${family} (verdict ${r.verdict})`); fails++;
    } else log(`ok block: ${name} → SYS.PRIVATE_LEAK (${family})`);
  };
  const expectPass = (name, args) => {
    const r = checkPrivacy(args);
    if (r.verdict !== 'PASS' || r.detected_codes.length) {
      err(`FAIL: ${name} should PASS (verdict ${r.verdict}, codes ${r.detected_codes.map((d) => d.code).join(',')})`); fails++;
    } else log(`ok pass: ${name}`);
  };

  // 1. Secret shape (a long opaque token reintroduced into copy).
  expectFail(
    'secret-shape',
    { draft: draftOf('Shipped the deploy with token abcDEF123456ghiJKL789012mnoPQR345678stuVWX live') },
    'secret_shape',
  );
  // 2. Financial figure.
  expectFail('financial', { draft: draftOf('We closed a $500,000 round this week and shipped the dashboard') }, 'financial');
  // 3. Internal-id shape.
  expectFail('internal-id', { draft: draftOf('Resolved PROJ-1234 and shipped the onboarding flow') }, 'internal_id');
  // 4. Configured private term (operator deny list via config).
  expectFail(
    'private-term',
    {
      draft: draftOf('Big news: we partnered with Stardust Partners on the launch'),
      config: { work_recap: { private_terms: ['Stardust Partners'] } },
    },
    'private_term',
  );
  // 5. Clean source-derived copy: source flagged-and-masked upstream, final copy is clean ⇒ PASS.
  expectPass('clean-source', {
    draft: draftOf('Shipped the new onboarding flow and fixed the lock-heartbeat bug this week'),
    seed: { source: 'work-recap', privacy_flags: { any_redacted: true, families: ['financial'] }, private_terms: ['Stardust Partners'] },
    config: { work_recap: { private_terms: ['Stardust Partners'] } },
  });
  // 6. Ordinary brand copy, no source context ⇒ PASS (no deny set, no secret shapes).
  expectPass('ordinary-brand', { draft: draftOf('The Acme Cosmos beta wrapped with sixty builders shipping live demos') });

  if (fails) { err(`\nFAIL: ${fails} privacy-leak self-test assertion(s).`); return 1; }
  log('\nPASS: privacy-leak self-test green (4 block classes + 2 clean classes).');
  return 0;
}
