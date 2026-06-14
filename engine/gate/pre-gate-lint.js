'use strict';

/**
 * engine/gate/pre-gate-lint.js  [A adapted]
 *
 * The deterministic PRE-GATE — layer 1 of the hybrid gate (release-spec §14.1 layer 1;
 * DD-3 deterministic backstop). Cheap structural/lexical checks on the writer's draft
 * BEFORE any LLM gate spend. Exit-fail routes the draft straight back to the writer, so
 * the writer<->gate retry loop never pays for failures a regex can catch for free.
 *
 * This is the lint ENGINE only. It authors NO rules: the rule CONTENT/registry lives in
 * rules/codes.md + rules/core/*.md (a separate batch). The engine consumes the
 * code-registry-entry shape (spec §7.3/§10.2) and emits LINT.* codes into the §7.2
 * validation-result detected_codes shape. Where a check needs brand-specific terms (the
 * banned-pattern check), it reads them from the config-driven seam (the `rules` argument /
 * $CONTENT_HOME), never from code — the engine ships an empty default (spec §0.3 r6, §10.3).
 *
 * Layer-1 checks (LINT.* family — §10.2):
 *   LINT.EM_DASH         mid-sentence em dash (rule_ref: rule.core.formatting)
 *   LINT.INFLATION       significance-inflation phrasing (rule_ref: rule.core.humanizer)
 *   LINT.FINANCIAL       price/floor/market talk (rule_ref: rule.core.voice-register)
 *   LINT.BANNED_PATTERN  a config-supplied banned phrase appears in copy (rule.core.banned-patterns)
 *   LINT.VARIANT_DUP     >=2 variants share a thesis (opener + n-gram shingle similarity)
 *   LINT.VARIANT_COUNT   draft does not carry exactly N=3 labeled variants (DD-11)
 *   LINT.LENGTH          a variant is outside the brief's target_chars window
 *   LINT.TENSE_SLIP      a [HISTORICAL]-marked entity framed in present-continuous tense
 *   LINT.PLACEHOLDER     an unresolved template token ({...}) left in copy  [SOFT]
 *   LINT.NEGPAR          negated-parallelism ("not just X but Y") humanizer tell  [SOFT]
 *
 * Tiering (spec §14.4, RD-21): HARD codes block the variant and FAIL the draft (route back
 * to the writer). SOFT codes (PLACEHOLDER, NEGPAR) do NOT block the LLM gate and do NOT force
 * a writer retry; they travel forward in the detected_codes union for the verdict layer to
 * tier. PLACEHOLDER additionally carries bars_recommended (a brace can never publish, so the
 * affected variant ships A/B-only once filled). Per RD-21 every shipped soft code is
 * disposition `warn`.
 *
 * Verdict (spec §14.2): any hard code => FAIL; soft-only => PASS_ALTERNATE_ONLY when a soft
 * code bars the Recommended slot, else PASS; clean => PASS.
 *
 * Programmatic API (the gate pipeline calls this):
 *   const { lint } = require('./pre-gate-lint');
 *   const result = lint(draft, rules);   // draft per schemas/inputs/draft.schema.json
 *   // result is a validation-result (spec §7.2): { stage:'lint', verdict, detected_codes, ... }
 *
 * CLI (operator/debug + the zero-key fixture run, §5.4):
 *   node engine/gate/pre-gate-lint.js --draft <draft.json> [--brief <brief.json>]
 *                                     [--rules <rules.json>] [--json]
 *   node engine/gate/pre-gate-lint.js --selftest        # synthetic fixtures, no CONTENT_HOME
 * Exit: 0 PASS (spawn the LLM gate) · 1 FAIL (route back to writer, no LLM spend) · 2 usage.
 *
 * CONTENT_HOME-free: the engine performs no instance I/O of its own — paths are only touched
 * to LOAD operator banned-pattern lists when CONTENT_HOME is set (via shared/paths.js); when
 * it is unset (fixture-run, §5.4) the engine runs on the in-memory default empty list. The
 * ENGINE_TEST_MODE diagnostic toggle is honored (§4.5): it only annotates the result.
 */

const STAGE = 'lint';
const SOURCE = 'lint';
const FAMILY = 'LINT';

// --- Deterministic lexical patterns (contract; brand-NEUTRAL by construction) ---------------
// These carry no brand terms. Brand-specific banned phrases come from the config seam below.

// A mid-sentence em dash: non-space char, optional space, em dash, optional space, non-space.
const EM_DASH = /\S\s?—\s?\S/u;

// Significance-inflation phrasing the humanizer rule rejects.
const INFLATION =
  /\b(pivotal|crucial|vital|testament|broader landscape|underscores|game-?chang(e|ing)|revolutioniz|unprecedented|paradigm)\b/i;

// Price/floor/market talk the voice-register rule rejects in non-financial brand voice.
// Financial-context only (a bare "$X" ticker shape, not arbitrary dollar amounts).
const FINANCIAL =
  /\b(floor price|market cap|mcap|price target|pump and dump|pump(?:ed|ing)? (?:it|the bag|bags)|to the moon|all-?time high|ATH|sweep the floor|\$[A-Z]{2,6})\b/i;

// Any brace-enclosed token left in copy is an unfilled template slot (FM-FABRICATION
// ancestor, SOFT). Braces never belong in published copy, so this is high-recall by design;
// each distinct token is reported for auditability.
const PLACEHOLDER = /\{[^}\n]{1,80}\}/g;

// Negated-parallelism humanizer tell (SOFT). Two high-precision forms (the LLM gate keeps
// full recall, incl. bare "X, not Y" couplets, which are intentionally left out here to avoid
// firing on ", not sure"-style negatives):
//   A) negated "just/only ... but/it's"  -> "not just X but Y", "isn't just X, it's Y"
//   B) determiner contrastive couplet     -> "X, not a/the/just Y"
const NEGPAR_JUSTBUT =
  /\b(?:not|isn[’']?t|aren[’']?t|wasn[’']?t|weren[’']?t|doesn[’']?t|don[’']?t|didn[’']?t|won[’']?t)\s+(?:just|only|merely|simply)\b[^.?!\n]{0,60}\b(?:but|it[’']?s|they[’']?re|that[’']?s|we[’']?re|you[’']?re)\b/i;
const NEGPAR_DET = /,\s+not\s+(?:a|an|the|just|your|our|another|some|simply|merely|only)\b/i;
const negparFires = (t) => NEGPAR_JUSTBUT.test(t) || NEGPAR_DET.test(t);

// Present-continuous markers that conflict with [HISTORICAL] framing (tense-slip).
const PRESENT_TENSE_MARKERS =
  /\b(still|right now|currently|today|live now|happening now|smashing records|going strong|active right now|continues to|keeps (?:climbing|growing|smashing|running))\b/i;
// Explicit past-tense markers that SAVE an otherwise present-tense sentence (suppress FPs).
const PAST_TENSE_SAVERS =
  /\b(was|were|had|finished|completed?|complete|ended|done|over|historic|then|formerly|previously|used to|back when|once|wrapped|earlier|launched|shipped|hit|reached|got|made|did)\b/i;

// Variant-count + length contract defaults (config-driven via the brief / rules).
const DEFAULT_VARIANT_COUNT = 3; // DD-11 N=3 labeled variants.
const DEFAULT_LENGTH_WINDOW = [1, 280]; // generic platform default; overridden by the brief.
// Variant-distinctness knobs: GENERIC day-one defaults (spec §10.3 sanctions shipping the rule
// shape WITH a default). Config-tunable via config/system.json `gate.variant_distinctness`
// (threaded in through the `rules` arg); the operator/maintainer's CALIBRATED values are not
// shipped (DD-9, §10.3).
const DEFAULT_DUP_SHINGLE_N = 5; // word n-gram (shingle) size.
const DEFAULT_DUP_JACCARD_THRESHOLD = 0.45; // generic similarity default; tune per brand voice.
const DEFAULT_DUP_OPENER_CHARS = 30;

// LINT.* code metadata (tier/disposition/route/rule_ref) — the registry contract this engine
// emits against (spec §7.3/§10.2). The registry file (rules/codes.md) is the source of truth;
// this table is the engine's emit-side view, kept consistent with it.
const CODES = {
  EM_DASH:       { code: 'LINT.EM_DASH',       tier: 'hard', disposition: 'block', route: 'writer', rule_ref: 'rule.core.formatting' },
  INFLATION:     { code: 'LINT.INFLATION',     tier: 'hard', disposition: 'block', route: 'writer', rule_ref: 'rule.core.humanizer' },
  FINANCIAL:     { code: 'LINT.FINANCIAL',     tier: 'hard', disposition: 'block', route: 'writer', rule_ref: 'rule.core.voice-register' },
  BANNED_PATTERN:{ code: 'LINT.BANNED_PATTERN',tier: 'hard', disposition: 'block', route: 'writer', rule_ref: 'rule.core.banned-patterns' },
  VARIANT_DUP:   { code: 'LINT.VARIANT_DUP',   tier: 'hard', disposition: 'block', route: 'writer', rule_ref: 'rule.core.variant' },
  VARIANT_COUNT: { code: 'LINT.VARIANT_COUNT', tier: 'hard', disposition: 'block', route: 'writer', rule_ref: 'rule.core.variant' },
  LENGTH:        { code: 'LINT.LENGTH',        tier: 'hard', disposition: 'block', route: 'writer', rule_ref: 'rule.platform.limits' },
  TENSE_SLIP:    { code: 'LINT.TENSE_SLIP',    tier: 'hard', disposition: 'block', route: 'writer', rule_ref: 'rule.core.claims-safety' },
  PLACEHOLDER:   { code: 'LINT.PLACEHOLDER',   tier: 'soft', disposition: 'warn',  route: 'writer', rule_ref: 'rule.core.fabrication', bars_recommended: true },
  NEGPAR:        { code: 'LINT.NEGPAR',        tier: 'soft', disposition: 'warn',  route: 'writer', rule_ref: 'rule.core.humanizer' },
};

/** Build a §7.2 detected_codes entry from a CODES table row + explanation. */
function makeCode(meta, explanation, label) {
  const entry = {
    code: meta.code,
    family: FAMILY,
    tier: meta.tier,
    source: SOURCE,
    disposition: meta.disposition,
    rule_ref: meta.rule_ref,
    explanation,
  };
  if (meta.bars_recommended) entry.bars_recommended = true;
  if (label) entry.variant_label = label;
  return entry;
}

// --- Config-driven banned-pattern seam (replaces the production brand-lore regex) -----------
// The engine ships ZERO banned phrases (spec §0.3 r6, §10.3 brand-neutral default). The
// operator supplies brand-private banned terms two ways, unioned:
//   1. rules.banned_patterns: string[] | RegExp[]   (passed by the gate pipeline / config)
//   2. $CONTENT_HOME banned-pattern files, when CONTENT_HOME is set (loaded lazily, never
//      required — fixture-run runs CONTENT_HOME-free on the empty default).
// Each pattern is a literal phrase (case-insensitive) or a /.../ -delimited regex.

/** Compile a banned-pattern entry (string literal or "/re/flags") into a RegExp. */
function compileBannedPattern(p) {
  if (p instanceof RegExp) return p;
  const s = String(p).trim();
  if (!s) return null;
  const m = s.match(/^\/(.+)\/([a-z]*)$/iu);
  if (m) {
    try {
      return new RegExp(m[1], m[2].includes('i') ? m[2] : `${m[2]}i`);
    } catch {
      return null; // malformed operator pattern: skip, never crash the gate.
    }
  }
  // Literal phrase -> case-insensitive, whitespace-tolerant, escaped.
  const escaped = s.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&').replace(/\s+/gu, '\\s+');
  try {
    return new RegExp(escaped, 'i');
  } catch {
    return null;
  }
}

/**
 * Resolve the active banned-pattern list. Unions the caller-supplied `rules.banned_patterns`
 * with any operator list under $CONTENT_HOME (only when CONTENT_HOME is set). Returns compiled
 * RegExps. Never throws; a missing/blank instance file yields no patterns.
 * @param {object} rules
 * @param {object} [env]
 * @returns {RegExp[]}
 */
function resolveBannedPatterns(rules = {}, env = process.env) {
  const raw = [];
  if (Array.isArray(rules.banned_patterns)) raw.push(...rules.banned_patterns);

  // Operator instance list, loaded lazily so the engine has no hard CONTENT_HOME dependency.
  try {
    const paths = require('../shared/paths');
    let home;
    try {
      home = paths.contentHome(env);
    } catch (err) {
      if (err instanceof paths.ContentHomeUnsetError) home = null;
      else throw err;
    }
    if (home) {
      const fs = require('fs');
      const path = require('path');
      // Operator banned-pattern list: one pattern per line, '#' comments skipped.
      const file = path.join(home, 'config', 'banned-patterns.txt');
      if (fs.existsSync(file)) {
        for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/u)) {
          const t = line.trim();
          if (t && !t.startsWith('#')) raw.push(t);
        }
      }
    }
  } catch {
    // Any I/O problem with the optional operator list is non-fatal: the gate still runs on
    // the caller-supplied + empty default. (Banned-pattern absence never blocks layer 1.)
  }

  return raw.map(compileBannedPattern).filter(Boolean);
}

// --- Variant similarity helpers --------------------------------------------------------------

function norm(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function shingles(s, n = DEFAULT_DUP_SHINGLE_N) {
  const w = norm(s).split(' ').filter(Boolean);
  const out = new Set();
  for (let i = 0; i + n <= w.length; i++) out.add(w.slice(i, i + n).join(' '));
  return out;
}
function jaccard(x, y) {
  if (!x.size || !y.size) return 0;
  let inter = 0;
  for (const s of x) if (y.has(s)) inter++;
  return inter / (x.size + y.size - inter);
}

// --- Tense-slip helpers (LINT.TENSE_SLIP) ----------------------------------------------------
// Historical entities arrive as a list the matcher/brief marks [HISTORICAL] (spec brief
// pre-seed). The engine no longer parses a production-shaped packet: callers pass the entity
// phrases via rules.historical_entities (string[]). Empty list => the check no-ops.

function checkTenseSlip(variantText, historicalEntities) {
  if (!historicalEntities || !historicalEntities.size) return [];
  const violations = [];
  const sentences = String(variantText)
    .split(/(?<=[.!?])\s+|\n+/)
    .filter((s) => s.trim().length > 0);
  const seen = new Set();
  for (const sentence of sentences) {
    for (const entity of historicalEntities) {
      if (sentence.includes(entity)) {
        if (PRESENT_TENSE_MARKERS.test(sentence) && !PAST_TENSE_SAVERS.test(sentence)) {
          if (seen.has(entity)) continue;
          seen.add(entity);
          violations.push({
            entity,
            sentence: sentence.trim().slice(0, 100),
          });
        }
      }
    }
  }
  return violations;
}

// --- Draft normalization ---------------------------------------------------------------------
// The public entry contract is the parsed draft object (schemas/inputs/draft.schema.json):
// { content_id, brand, platform, format, variants: [{label, text}, ...] }. The CLI also
// accepts that JSON shape (replacing the production markdown-scraping `variants()` parser:
// public drafts are schema'd artifacts, not loosely-formatted markdown).

function variantsOf(draft) {
  if (!draft || !Array.isArray(draft.variants)) return [];
  return draft.variants.map((v, i) => ({
    label: v.label || `variant-${i + 1}`,
    text: String(v.text == null ? '' : v.text),
  }));
}

// --- The lint engine -------------------------------------------------------------------------

/**
 * Run the deterministic pre-gate over a writer draft.
 *
 * @param {object} draft  a draft per schemas/inputs/draft.schema.json.
 * @param {object} [rules]
 * @param {string[]|RegExp[]} [rules.banned_patterns]   brand-private banned phrases (config seam).
 * @param {string[]}          [rules.historical_entities] entities marked [HISTORICAL] for tense-slip.
 * @param {[number,number]}   [rules.target_chars]        [min,max] length window (overrides default).
 * @param {number}            [rules.variant_count]       expected labeled-variant count (default 3).
 * @param {object}            [rules.variant_distinctness] {shingle_n, jaccard_threshold, opener_chars} —
 *                                                         config-tunable distinctness knobs over generic
 *                                                         defaults; calibrated values are operator/maintainer
 *                                                         config, not shipped (DD-9, §10.3).
 * @param {object}            [rules.env]                 env object (default process.env), for the
 *                                                        optional CONTENT_HOME banned-pattern file.
 * @returns {object} a validation-result (spec §7.2): { content_id, stage:'lint', verdict,
 *                   detected_codes[], rationale, x-pre-gate:{...routing} }.
 */
function lint(draft, rules = {}) {
  const env = rules.env || process.env;
  const vs = variantsOf(draft);
  const expectedCount = Number.isInteger(rules.variant_count)
    ? rules.variant_count
    : DEFAULT_VARIANT_COUNT;
  const tc = Array.isArray(rules.target_chars) && rules.target_chars.length === 2
    ? [Number(rules.target_chars[0]), Number(rules.target_chars[1])]
    : DEFAULT_LENGTH_WINDOW.slice();
  // Variant-distinctness knobs: config seam (rules.variant_distinctness, from system.json
  // gate.variant_distinctness) over generic defaults — calibrated values are not shipped (DD-9).
  const vd = (rules.variant_distinctness && typeof rules.variant_distinctness === 'object')
    ? rules.variant_distinctness : {};
  const shingleN = Number.isInteger(vd.shingle_n) ? vd.shingle_n : DEFAULT_DUP_SHINGLE_N;
  const jaccardThreshold = Number.isFinite(vd.jaccard_threshold) ? vd.jaccard_threshold : DEFAULT_DUP_JACCARD_THRESHOLD;
  const openerChars = Number.isInteger(vd.opener_chars) ? vd.opener_chars : DEFAULT_DUP_OPENER_CHARS;
  const banned = resolveBannedPatterns(rules, env);
  const historical = new Set(
    Array.isArray(rules.historical_entities) ? rules.historical_entities.filter(Boolean) : [],
  );

  const detected = [];

  // Draft-level: exactly N labeled variants (DD-11).
  if (vs.length !== expectedCount) {
    detected.push(
      makeCode(
        CODES.VARIANT_COUNT,
        `expected ${expectedCount} labeled variants, found ${vs.length}`,
      ),
    );
  }

  // Per-variant checks.
  for (const v of vs) {
    if (EM_DASH.test(v.text)) {
      detected.push(makeCode(CODES.EM_DASH, `${v.label} has a mid-sentence em dash`, v.label));
    }
    const inflMatch = v.text.match(INFLATION);
    if (inflMatch) {
      detected.push(makeCode(CODES.INFLATION, `${v.label} significance-inflation phrasing: "${inflMatch[0]}"`, v.label));
    }
    const finMatch = v.text.match(FINANCIAL);
    if (finMatch) {
      detected.push(makeCode(CODES.FINANCIAL, `${v.label} price/market talk: "${finMatch[0]}"`, v.label));
    }
    for (const re of banned) {
      const bm = v.text.match(re);
      if (bm) {
        detected.push(makeCode(CODES.BANNED_PATTERN, `${v.label} contains a banned phrase: "${bm[0]}"`, v.label));
        break; // one banned-pattern hit per variant is enough to route back.
      }
    }
    const len = v.text.replace(/\s+/g, ' ').trim().length;
    if (len < tc[0] || len > tc[1]) {
      detected.push(makeCode(CODES.LENGTH, `${v.label} ${len} chars outside ${tc.join('-')}`, v.label));
    }
    for (const ts of checkTenseSlip(v.text, historical)) {
      detected.push(
        makeCode(
          CODES.TENSE_SLIP,
          `${v.label}: "${ts.entity}" marked [HISTORICAL] but framed as ongoing: "${ts.sentence}"`,
          v.label,
        ),
      );
    }
    // SOFT: unresolved template tokens. Each distinct token reported; bars_recommended.
    const ph = [...new Set(v.text.match(PLACEHOLDER) || [])];
    if (ph.length) {
      detected.push(
        makeCode(
          CODES.PLACEHOLDER,
          `${v.label} unresolved template token(s) ${ph.join(', ')} (fill, then A/B-eligible)`,
          v.label,
        ),
      );
    }
    // SOFT: negated-parallelism humanizer tell.
    const negHit = NEGPAR_JUSTBUT.exec(v.text) || NEGPAR_DET.exec(v.text);
    if (negHit) {
      detected.push(
        makeCode(
          CODES.NEGPAR,
          `${v.label} negated-parallelism: "${negHit[0].trim().slice(0, 60)}"`,
          v.label,
        ),
      );
    }
  }

  // Variant distinctness: pairwise opener + n-gram body similarity (HARD).
  for (let i = 0; i < vs.length; i++) {
    for (let j = i + 1; j < vs.length; j++) {
      const sim = jaccard(shingles(vs[i].text, shingleN), shingles(vs[j].text, shingleN));
      const sameOpener = norm(vs[i].text).slice(0, openerChars) === norm(vs[j].text).slice(0, openerChars);
      if (sim >= jaccardThreshold || sameOpener) {
        detected.push(
          makeCode(
            CODES.VARIANT_DUP,
            `${vs[i].label} vs ${vs[j].label} too similar (shingle ${(sim * 100).toFixed(0)}%${sameOpener ? ', identical opener' : ''}) — same thesis reworded`,
          ),
        );
      }
    }
  }

  // Verdict (spec §14.2). HARD => FAIL (route back to writer, no LLM spend). SOFT-only =>
  // PASS_ALTERNATE_ONLY when a soft code bars the Recommended slot, else PASS.
  const hasHard = detected.some((d) => d.tier === 'hard');
  const barsRecommended = detected.some((d) => d.tier === 'soft' && d.bars_recommended);
  let verdict;
  if (hasHard) verdict = 'FAIL';
  else if (barsRecommended) verdict = 'PASS_ALTERNATE_ONLY';
  else verdict = 'PASS';

  const result = {
    content_id: (draft && draft.content_id) || null,
    stage: STAGE,
    verdict,
    detected_codes: detected,
    rationale:
      verdict === 'FAIL'
        ? 'Deterministic pre-gate found a hard violation; route back to the writer (no LLM gate spend).'
        : barsRecommended
          ? 'Deterministic pre-gate clean of hard violations; a soft code bars the Recommended slot (ships A/B).'
          : 'Deterministic pre-gate clean; advance to the LLM gate.',
    // Engine-internal routing hint (not part of the §7.2 schema; additionalProperties allows it).
    'x-pre-gate': {
      variants: vs.length,
      target_chars: tc,
      routing:
        verdict === 'FAIL'
          ? 'RETURN_TO_WRITER (no LLM gate spawn — saves the gate cycle)'
          : 'ADVANCE_TO_LLM_GATE',
    },
  };
  if (env.ENGINE_TEST_MODE === '1') result['x-pre-gate'].test_mode = true;
  return result;
}

module.exports = {
  lint,
  // Exposed for the registry-integrity check + tests (the emit-side code table).
  CODES,
  // Exposed for the self-test + gate-regression runner.
  resolveBannedPatterns,
  compileBannedPattern,
  // Exposed for characterization tests of the distinctness math.
  jaccard,
  shingles,
  negparFires,
};

// --- CLI ------------------------------------------------------------------------------------
// Only runs when invoked directly. The gate pipeline imports lint() and never shells out.

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
    process.stderr.write('--draft <draft.json> required\n');
    process.exit(2);
  }
  let draft;
  try {
    draft = JSON.parse(fs.readFileSync(df, 'utf8'));
  } catch (e) {
    process.stderr.write(`--draft is not valid JSON: ${e.message}\n`);
    process.exit(2);
  }

  const rules = {};
  const bf = arg('brief');
  if (bf && fs.existsSync(bf)) {
    try {
      const brief = JSON.parse(fs.readFileSync(bf, 'utf8'));
      if (brief && brief.target_chars) rules.target_chars = brief.target_chars;
      if (brief && Array.isArray(brief.historical_entities)) {
        rules.historical_entities = brief.historical_entities;
      }
    } catch {
      /* a malformed brief is treated as no brief — defaults apply. */
    }
  }
  const rf = arg('rules');
  if (rf && fs.existsSync(rf)) {
    try {
      Object.assign(rules, JSON.parse(fs.readFileSync(rf, 'utf8')));
    } catch {
      /* malformed rules file => defaults. */
    }
  }

  const result = lint(draft, rules);
  const pass = result.verdict !== 'FAIL';
  if (asJson) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(
      `pre-gate-lint: ${pass ? `${result.verdict} — advance to the LLM gate` : 'FAIL — return to writer, no LLM gate spend'}\n`,
    );
    for (const d of result.detected_codes) {
      const marker = d.tier === 'hard' ? '-' : '~';
      process.stdout.write(`  ${marker} ${d.tier}: ${d.code} ${d.explanation}\n`);
    }
  }
  process.exitCode = pass ? 0 : 1;
}

/**
 * Self-test on SYNTHETIC fixtures (no real corpus, no CONTENT_HOME). Asserts NEGPAR
 * precision/recall and a representative HARD/SOFT/clean draft set. Returns an exit code.
 * Kept inside the module so `--selftest` works on a bare clone (spec §5.4 fixture-run smoke).
 */
function runSelfTest() {
  let fails = 0;
  const log = (s) => process.stdout.write(`${s}\n`);
  const err = (s) => process.stderr.write(`${s}\n`);

  // NEGPAR labeled fixtures (synthetic Acme Cosmos copy; positives = canonical negpar forms,
  // negatives = copy that contains "not"/contrast but is NOT negpar).
  const POS = [
    'the loyalty layer Acme Cosmos communities actually run on, not a snapshot of who held longest',
    'That is a count, not a vibe.',
    'shipping is a URL someone else can use, not a tweet about plans',
    'This is not just a mint, but a movement',
    "This isn't just a mint, it's a movement",
  ];
  const NEG = [
    "Most projects can't run an event for week 3",
    "the room is real, you're not first",
    "Most 'we're building' posts have nothing you can click. Ours does.",
    'the bridge is open. It is free.',
    '60+ communities chose to spend a Wednesday in one persistent world.',
    'The Acme Cosmos beta sold out on 2025-08-09 because that runway carried it.',
    'you collect a badge while you play',
  ];
  for (const t of POS) {
    if (!negparFires(t)) { err(`FAIL recall: missed POSITIVE: ${t}`); fails++; }
    else log(`ok pos: ${t.slice(0, 48)}...`);
  }
  for (const t of NEG) {
    if (negparFires(t)) { err(`FAIL precision: fired on NEGATIVE: ${t}`); fails++; }
    else log(`ok neg: ${t.slice(0, 48)}...`);
  }

  // A clean 3-variant draft must PASS.
  const cleanDraft = {
    content_id: 'selftest-clean',
    brand: 'acme-cosmos',
    platform: 'twitter',
    format: 'text',
    variants: [
      { label: 'recommended', text: 'The Acme Cosmos beta wrapped with 60 builders shipping live demos.' },
      { label: 'variant-a', text: 'Sixty builders. One weekend. Every demo went out as a working link.' },
      { label: 'variant-b', text: 'We asked for working demos and got sixty. Here is what the beta produced.' },
    ],
  };
  const clean = lint(cleanDraft, { env: {} });
  if (clean.verdict !== 'PASS') { err(`FAIL: clean draft did not PASS (got ${clean.verdict})`); fails++; }
  else log('ok clean: 3 distinct variants PASS');

  // A draft with a hard em-dash must FAIL.
  const hardDraft = {
    content_id: 'selftest-hard',
    brand: 'acme-cosmos',
    platform: 'twitter',
    format: 'text',
    variants: [
      { label: 'recommended', text: 'The beta wrapped—and the demos shipped live for everyone to use.' },
      { label: 'variant-a', text: 'Sixty builders showed up and every single demo went out as a link.' },
      { label: 'variant-b', text: 'We asked for working demos. Sixty arrived. Here is the full recap.' },
    ],
  };
  const hard = lint(hardDraft, { env: {} });
  if (hard.verdict !== 'FAIL' || !hard.detected_codes.some((d) => d.code === 'LINT.EM_DASH')) {
    err(`FAIL: em-dash draft did not FAIL with LINT.EM_DASH (got ${hard.verdict})`); fails++;
  } else log('ok hard: em-dash FAILs with LINT.EM_DASH');

  // A placeholder must produce a SOFT code that bars Recommended (PASS_ALTERNATE_ONLY).
  const softDraft = {
    content_id: 'selftest-soft',
    brand: 'acme-cosmos',
    platform: 'twitter',
    format: 'text',
    variants: [
      { label: 'recommended', text: 'The beta wrapped and {METRIC} builders shipped working demos this weekend.' },
      { label: 'variant-a', text: 'Sixty builders arrived and every demo went out as a usable link today.' },
      { label: 'variant-b', text: 'We asked for working demos. Many arrived. Here is the complete recap.' },
    ],
  };
  const soft = lint(softDraft, { env: {} });
  if (soft.verdict !== 'PASS_ALTERNATE_ONLY' || !soft.detected_codes.some((d) => d.code === 'LINT.PLACEHOLDER' && d.bars_recommended)) {
    err(`FAIL: placeholder draft did not PASS_ALTERNATE_ONLY with bars_recommended (got ${soft.verdict})`); fails++;
  } else log('ok soft: placeholder => PASS_ALTERNATE_ONLY, bars_recommended');

  // The config-driven banned-pattern seam must fire on an operator-supplied phrase.
  const bannedResult = lint(cleanDraft, { env: {}, banned_patterns: ['working demos'] });
  if (!bannedResult.detected_codes.some((d) => d.code === 'LINT.BANNED_PATTERN')) {
    err('FAIL: banned-pattern seam did not fire on a supplied phrase'); fails++;
  } else log('ok banned: config-driven banned-pattern seam fires');

  if (fails) { err(`\nFAIL: ${fails} pre-gate-lint self-test assertion(s).`); return 1; }
  log(`\nPASS: pre-gate-lint self-test green (${POS.length} pos / ${NEG.length} neg + draft/seam fixtures).`);
  return 0;
}
