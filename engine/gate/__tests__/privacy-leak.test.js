'use strict';

/**
 * Tests for the privacy/leak gate (engine/gate/privacy-leak.js).
 * release-spec §2.4 (the double gate) · §3.3 (accounts) · §8.8 (a source feeds the chain) ·
 * §13.3 (redact-at-write) · §10.2 (SYS.* family) · RD-12 (zero-key).
 *
 * Zero-key by construction: pure functions over synthetic copy + fake source seeds; no fs, no
 * network, no secrets. All fixture content is SYNTHETIC and brand-neutral ("Acme Cosmos") per
 * §0.3 r6 — no instance data, no production codenames, no real secrets (the "token" strings are
 * obviously-synthetic shapes, not real credentials).
 *
 * Runner: Node's built-in node:test (zero-dependency, Node >= 22).
 *
 * Asserts:
 *   - HARD-block on each leak class: secret shape, financial shape, internal-id shape, configured
 *     private term, and a seed-carried private term.
 *   - PASS on clean copy (with and without source context) — ordinary brand content is not penalized.
 *   - clean final copy is NOT blocked merely because the source's upstream privacy_flags say it
 *     masked something (the pre-pass did its job).
 *   - every emitted code is SYS.PRIVATE_LEAK with the §7.2 detected_codes shape (source 'package').
 *   - the explanation/result NEVER echoes the matched secret/term back (no re-leak).
 *   - draft, package, and raw-string/array inputs are all accepted.
 *   - emit-side CODES table is consistent with the registry contract (hard ⇒ block, valid family).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const privacyLeak = require('../privacy-leak.js');
const { checkPrivacy, scanText, copyUnits, resolvePrivacyContext, CODES } = privacyLeak;
const { MASK } = require('../../shared/redact.js');

// An obviously-synthetic 40+ char opaque token shape (matches redact.js's generic-blob pattern).
// Not a real credential — a shape used purely to exercise the secret-shape detector.
const SYNTH_TOKEN = 'abcDEF123456ghiJKL789012mnoPQR345678stuVWX';

/** Build a 3-variant draft (DD-11 N=3) with the leak (if any) on the recommended variant. */
function draftOf(recommended, over = {}) {
  return {
    content_id: 'priv-test',
    brand: 'acme-cosmos',
    platform: 'twitter',
    format: 'text',
    variants: [
      { label: 'recommended', text: recommended },
      { label: 'variant-a', text: 'Sixty builders shipped working demos at the Acme Cosmos beta this week.' },
      { label: 'variant-b', text: 'We asked for working demos and sixty arrived. Here is the recap.' },
    ],
    ...over,
  };
}

function codeList(result) {
  return result.detected_codes.map((d) => d.code);
}

// --- Shape + emit-side contract --------------------------------------------------------------

test('CODES.PRIVATE_LEAK is SYS-family HARD/block, route writer', () => {
  const m = CODES.PRIVATE_LEAK;
  assert.equal(m.code, 'SYS.PRIVATE_LEAK');
  assert.equal(m.tier, 'hard');
  assert.equal(m.disposition, 'block');
  assert.equal(m.route, 'writer');
  assert.equal(m.rule_ref, 'rule.sys.privacy-leak');
});

test('a detected code carries the §7.2 shape with source "package" and family "SYS"', () => {
  const r = checkPrivacy({ draft: draftOf(`Shipped with token ${SYNTH_TOKEN} live`) });
  assert.equal(r.stage, 'package');
  const d = r.detected_codes[0];
  assert.equal(d.code, 'SYS.PRIVATE_LEAK');
  assert.equal(d.family, 'SYS');
  assert.equal(d.tier, 'hard');
  assert.equal(d.source, 'package'); // SYS convention: validation-result source enum has no privacy value.
  assert.equal(d.disposition, 'block');
  assert.equal(d.rule_ref, 'rule.sys.privacy-leak');
  assert.equal(typeof d.explanation, 'string');
  assert.equal(d.variant_label, 'recommended');
});

// --- HARD-block: each leak class -------------------------------------------------------------

test('HARD-blocks a secret/credential shape in the copy', () => {
  const r = checkPrivacy({ draft: draftOf(`Deploy went out with token ${SYNTH_TOKEN} today`) });
  assert.equal(r.verdict, 'FAIL');
  assert.deepEqual(codeList(r), ['SYS.PRIVATE_LEAK']);
  assert.ok(r['x-privacy'].per_unit[0].families.includes('secret_shape'));
});

test('HARD-blocks a financial structural shape', () => {
  const r = checkPrivacy({ draft: draftOf('We closed a $500,000 round and shipped the dashboard') });
  assert.equal(r.verdict, 'FAIL');
  assert.ok(r['x-privacy'].per_unit.some((u) => u.families.includes('financial')));
});

test('HARD-blocks an internal-id structural shape', () => {
  const r = checkPrivacy({ draft: draftOf('Resolved PROJ-1234 and shipped onboarding') });
  assert.equal(r.verdict, 'FAIL');
  assert.ok(r['x-privacy'].per_unit.some((u) => u.families.includes('internal_id')));
});

test('HARD-blocks a configured work_recap.private_term (from config)', () => {
  const r = checkPrivacy({
    draft: draftOf('Big news: we partnered with Stardust Partners on the launch'),
    config: { work_recap: { private_terms: ['Stardust Partners'] } },
  });
  assert.equal(r.verdict, 'FAIL');
  assert.ok(r['x-privacy'].per_unit.some((u) => u.families.includes('private_term')));
  assert.equal(r['x-privacy'].deny_terms, 1);
});

test('HARD-blocks a private term carried on the source seed (not just config)', () => {
  const r = checkPrivacy({
    draft: draftOf('Shipped the Nebula codename preview to early testers'),
    seed: { source: 'work-recap', private_terms: ['Nebula'], privacy_flags: { any_redacted: true, families: [] } },
  });
  assert.equal(r.verdict, 'FAIL');
  assert.ok(r['x-privacy'].per_unit.some((u) => u.families.includes('private_term')));
  assert.equal(r['x-privacy'].from_source, true);
});

test('blocks the work-recap seed deny-list object shape {terms, secret_literals}', () => {
  const r = checkPrivacy({
    draft: draftOf('We launched with Stardust Partners this week'),
    config: { work_recap: { private_terms: { terms: ['Stardust Partners'], secret_literals: [] } } },
  });
  assert.equal(r.verdict, 'FAIL');
  assert.ok(r['x-privacy'].per_unit.some((u) => u.families.includes('private_term')));
});

// --- PASS: clean content ---------------------------------------------------------------------

test('PASSes ordinary clean brand copy with no source context', () => {
  const r = checkPrivacy({ draft: draftOf('The Acme Cosmos beta wrapped with sixty builders shipping live demos') });
  assert.equal(r.verdict, 'PASS');
  assert.deepEqual(r.detected_codes, []);
  assert.equal(r['x-privacy'].from_source, false);
});

test('PASSes clean source-derived copy even when upstream privacy_flags say it masked something', () => {
  // The source pre-pass masked a financial line elsewhere (any_redacted true), but the FINAL copy
  // is clean — it must NOT be blocked. Only RESIDUAL leakage in the copy blocks.
  const r = checkPrivacy({
    draft: draftOf('Shipped the new onboarding flow and fixed the lock-heartbeat bug this week'),
    seed: { source: 'work-recap', privacy_flags: { any_redacted: true, families: ['financial'] }, private_terms: ['Stardust Partners'] },
    config: { work_recap: { private_terms: ['Stardust Partners'] } },
  });
  assert.equal(r.verdict, 'PASS');
  assert.deepEqual(r.detected_codes, []);
  assert.equal(r['x-privacy'].upstream_redacted, true); // evidence carried, but not blocking.
  assert.deepEqual(r['x-privacy'].upstream_families, ['financial']);
});

test('a configured private term that does NOT appear in clean copy does not block', () => {
  const r = checkPrivacy({
    draft: draftOf('Shipped the public docs refresh and fixed a typo'),
    config: { work_recap: { private_terms: ['Stardust Partners', 'Nebula'] } },
  });
  assert.equal(r.verdict, 'PASS');
  assert.equal(r['x-privacy'].deny_terms, 2);
});

// --- No re-leak: the result/explanation never echoes the matched secret/term -----------------

test('the explanation NEVER echoes the matched private term back (no re-leak)', () => {
  const r = checkPrivacy({
    draft: draftOf('Big news with Stardust Partners and codename Nebula'),
    config: { work_recap: { private_terms: ['Stardust Partners', 'Nebula'] } },
  });
  assert.equal(r.verdict, 'FAIL');
  const blob = JSON.stringify(r);
  assert.ok(!blob.includes('Stardust Partners'), 'partner name not echoed into the result');
  assert.ok(!blob.includes('Nebula'), 'codename not echoed into the result');
});

test('the explanation NEVER echoes a matched secret shape back', () => {
  const r = checkPrivacy({ draft: draftOf(`token ${SYNTH_TOKEN} leaked`) });
  const blob = JSON.stringify(r);
  assert.ok(!blob.includes(SYNTH_TOKEN), 'raw token not echoed into the result');
});

// --- Input shapes: draft / package / raw -----------------------------------------------------

test('accepts a package input ({recommended,variant_a,variant_b})', () => {
  const pkg = {
    audit_header: { content_id: 'pkg-1', platform: 'twitter' },
    recommended: { text: `Shipped with token ${SYNTH_TOKEN}` },
    variant_a: { text: 'A clean variant about shipping demos' },
    variant_b: { text: 'Another clean variant about the beta' },
  };
  const r = checkPrivacy({ package: pkg });
  assert.equal(r.verdict, 'FAIL');
  assert.equal(r.content_id, 'pkg-1');
  assert.ok(r['x-privacy'].per_unit.some((u) => u.label === 'Recommended' && u.families.includes('secret_shape')));
});

test('accepts a raw string and a string[] of bodies', () => {
  assert.equal(checkPrivacy({ draft: 'a clean public sentence' }).verdict, 'PASS');
  const r = checkPrivacy({ draft: ['clean one', 'a $250,000 leak'] });
  assert.equal(r.verdict, 'FAIL');
  assert.equal(r['x-privacy'].units_scanned, 2);
});

test('content_id resolves from the draft, then the seed', () => {
  assert.equal(checkPrivacy({ draft: draftOf('clean copy') }).content_id, 'priv-test');
  assert.equal(
    checkPrivacy({ draft: 'clean copy', seed: { content_id: 'seed-7' } }).content_id,
    'seed-7',
  );
});

// --- Unit helpers ----------------------------------------------------------------------------

test('scanText detects each family and is detect-only (does not mask in place)', () => {
  const hit = scanText(`token ${SYNTH_TOKEN} and $1,000,000 and PROJ-1234`, ['Stardust']);
  assert.ok(hit.secret_shape);
  assert.ok(hit.financial);
  assert.ok(hit.internal_id);
  assert.equal(hit.private_term, false); // 'Stardust' not present in the text.
  // scanText returns family hits, not masked text; the caller (checkPrivacy) blocks, never masks.
  assert.ok(Array.isArray(hit.families));
});

test('scanText on clean text returns no families', () => {
  const hit = scanText('a perfectly clean public sentence', []);
  assert.deepEqual(hit.families, []);
});

test('copyUnits maps draft variants, package variants, strings, and arrays', () => {
  assert.equal(copyUnits(draftOf('x')).length, 3);
  assert.equal(copyUnits({ recommended: { text: 'r' }, variant_a: { text: 'a' }, variant_b: { text: 'b' } }).length, 3);
  assert.deepEqual(copyUnits('hello'), [{ label: 'body', text: 'hello' }]);
  assert.equal(copyUnits(['a', 'b']).length, 2);
  assert.deepEqual(copyUnits(null), []);
});

test('resolvePrivacyContext unions config + seed deny terms and reads upstream flags', () => {
  const ctx = resolvePrivacyContext(
    { source: 'work-recap', private_terms: ['Nebula'], privacy_flags: { any_redacted: true, families: ['financial'], terms: ['Aurora'] } },
    { work_recap: { private_terms: ['Stardust Partners'], extra_secret_keys: ['internal_db_url'] } },
  );
  assert.ok(ctx.denySet.includes('Nebula'));
  assert.ok(ctx.denySet.includes('Stardust Partners'));
  assert.ok(ctx.denySet.includes('Aurora'));
  assert.ok(ctx.extraSecretKeys.includes('internal_db_url'));
  assert.equal(ctx.fromSource, true);
  assert.equal(ctx.upstreamFlags.any_redacted, true);
});

test('resolvePrivacyContext with no seed/config yields an empty deny set and non-source', () => {
  const ctx = resolvePrivacyContext(undefined, undefined);
  assert.deepEqual(ctx.denySet, []);
  assert.equal(ctx.fromSource, false);
  assert.equal(ctx.upstreamFlags, null);
});

// --- Integration sanity: masked-marker copy is itself clean ----------------------------------

test('copy that already contains the redaction MASK marker is treated as clean (already-masked)', () => {
  // If the pre-pass masked a span to [REDACTED], that masked copy is safe — the secret is gone.
  const r = checkPrivacy({ draft: draftOf(`We closed a ${MASK} round with ${MASK} this week`) });
  assert.equal(r.verdict, 'PASS');
});
