'use strict';

/**
 * engine/brand-dna/generate.js  [A adapted — the BRAND DNA GENERATOR]
 *
 * Batch: BD-GENERATE. The one-command Brand DNA generator that upgrades the v1 AGENT-ASSISTED C2
 * onboarding (manual templates/brand/brand-dna-authoring.md) into an ingest -> deterministic
 * analysis -> generate flow (release-spec / original-design-spec §1.1 Data Ingestion & Brand
 * Identity + §1.2 Context & Competitor Analysis; roadmap #2). It runs in the C2 setup checkpoint
 * (release-spec §2.4 step 3 Brand DNA).
 *
 * WHAT IT DOES (orchestration only — it wires, it never re-implements analysis or calls a chain LLM):
 *   read the brand's ingested corpus  (own + competitor, $CONTENT_HOME/corpora/<brand>/, Zone U)
 *     -> analyzeCorpus + categorizeArchetypes  (the DETERMINISTIC analyzer — BD-ANALYZE, no LLM)
 *     -> invoke the HOST DNA-SYNTHESIS seat    (opts.dnaSeat — turns the deterministic analysis
 *                                               into voice PROSE; INJECTABLE like the §12.5 vision
 *                                               seam; the engine NEVER calls a chain/analysis LLM
 *                                               directly — RD-2)
 *     -> write brands/<id>/brand-dna.md         (identity, tone, voice, do/do-not, signature moves)
 *      + the archetype catalog                  (brands/<id>/archetypes/<id>.md)
 *      + update brand.json voice fields          (drama_dial + paths.dna/archetypes)
 *
 * THE SYNTHESIS IS A HOST SEAT, NOT AN ENGINE LLM CALL (RD-2): the engine ships the ingestion
 * adapter SEAM (the corpus reader here), the DETERMINISTIC corpus analyzer (BD-ANALYZE — auditable
 * stats, zero LLM), the archetype categorizer, the cost-estimate gate (DD-18), the CLI
 * orchestration, and the writers. The DNA SYNTHESIS (analysis -> voice prose) is an INJECTABLE
 * HOST seat (opts.dnaSeat). It degrades gracefully when no seat is wired.
 *
 * DEGRADE / COLD-START / FALLBACK (DD-21 — never block onboarding):
 *   - corpus present + seat wired  -> full generation (DNA prose + archetype catalog + brand.json).
 *   - corpus present + NO seat      -> emit the deterministic analysis + the authoring template
 *                                      (templates/brand/brand-dna-authoring.md) PREFILLED with the
 *                                      analysis, for the agent to finish (today's agent-assisted
 *                                      path preserved).
 *   - NO corpus (cold start)        -> the cold-start manual authoring template (unprefilled) +
 *                                      the starter archetype template. The manual path always works.
 *
 * COMPETITOR-NOT-VERBATIM (RD-9, the design-review risk): ingested competitor content is analyzed
 * for PATTERNS only and is NEVER republished verbatim. The generated DNA/archetypes carry only
 * DERIVED patterns. This module ENFORCES that: it scans every generated output string for a
 * >=N-word shingle overlap with any competitor corpus item; on a hit it STRIPS the offending span
 * (replacing it with a neutral marker) and FLAGS it, so no copied competitor copy can leak into the
 * output. The check runs on whatever the (untrusted) host seat produced before anything is written.
 *
 * METERED-ACTION GATE (DD-18): DNA synthesis is the metered action (the host seat is an LLM seat).
 * generateBrandDna presents a pre-run cost estimate and REQUIRES confirmation (opts.yes) before
 * invoking the seat — the same estimate-and-confirm contract as engine/cli/calibrate.js and
 * engine/library/indexer.js. The deterministic analysis itself spends nothing and runs freely;
 * estimateDnaCost is the safe-any-time preface. The degrade-to-template paths spend nothing.
 *
 * IDEMPOTENT: a re-run does not duplicate. Existing brand-dna.md / archetype files are LEFT IN
 * PLACE unless --force; --force regenerates. A re-run never re-bills an already-written DNA.
 *
 * TESTABILITY (RD-12, no secrets in CI): the dnaSeat AND the analyzer are dependency-injectable
 * (opts.dnaSeat, opts.analyzeCorpus, opts.categorizeArchetypes). Tests drive the whole flow with a
 * fake seat + fake analyzer over a synthetic corpus, zero keys, zero network, zero child process.
 * The default analyzer lazy-requires the BD-ANALYZE sibling (engine/brand-dna/analyze.js) and
 * degrades to a minimal built-in deterministic analyzer if that batch has not landed yet, so this
 * module is buildable and testable on its own.
 *
 * Tier-3 cleanliness (§0.3 r6 / RD-3): no hardcoded ids/handles/absolute paths/brand strings; no
 * production persona codenames. Every instance path resolves through engine/shared/paths.js; the
 * only example brand is the synthetic "Acme Cosmos" (fixtures/docs). Header cites the spec sections
 * above per the feature-law file-header rule.
 */

const fs = require('fs');
const path = require('path');

const paths = require('../shared/paths');
const { redact } = require('../shared/redact');

/** Repo root (two up from engine/brand-dna/) — to locate the shipped authoring/archetype templates. */
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const AUTHORING_TEMPLATE = path.join(REPO_ROOT, 'templates', 'brand', 'brand-dna-authoring.md');
const ARCHETYPE_TEMPLATE = path.join(REPO_ROOT, 'templates', 'brand', 'archetypes.template.md');

/**
 * Indicative DNA-synthesis cost band (USD), used ONLY for the pre-run estimate preface. Marked
 * INDICATIVE / measured-as-of-release (§3.3/§17.6); config overrides it. NEVER a fabricated "real"
 * number — a documented placeholder until Step 8 measures the live figure into docs/cost.md.
 * Mirrors calibrate.js DEFAULT_PER_SAMPLE_USD / indexer.js DEFAULT_PER_ASSET_USD convention.
 */
const DEFAULT_SYNTHESIS_USD = Object.freeze({ low: 0.05, high: 0.40 });

/**
 * Competitor-not-verbatim shingle width: the minimum consecutive-word run that counts as a verbatim
 * overlap with a competitor corpus item. 7 words is a conservative "copied a phrase" threshold —
 * short enough to catch a lifted sentence fragment, long enough not to flag ordinary shared
 * vocabulary. Config-tunable (config.brand_dna.verbatim_shingle_words).
 */
const DEFAULT_SHINGLE_WORDS = 7;

/** The neutral marker a stripped verbatim span is replaced with (so the leak is visible + auditable). */
const STRIP_MARKER = '[derived pattern; competitor copy removed]';

// ---------------------------------------------------------------------------
// Corpus reading (the ingestion adapter SEAM's read side) — Zone U, trust-tagged.
// ---------------------------------------------------------------------------

/**
 * Read a brand's ingested corpus from $CONTENT_HOME/corpora/<brand>/ — every *.json file conforming
 * to schemas/inputs/corpus-item.schema.json (the shape engine/cli/purge-corpora.js already manages).
 * Each item is split into OWN vs COMPETITOR by its source/author signal: competitor items are the
 * Zone-U third-party set the verbatim check protects against; own items seed voice. We do NOT decide
 * trust here beyond what the item declares — we only PARTITION for analysis. Tolerant: an absent
 * corpora dir or an unreadable/invalid file is reported, never fatal (DD-21 cold start = empty list).
 *
 * Partition rule (deterministic, no network): an item is COMPETITOR when it carries
 * `competitor: true`, or `relation: "competitor"`, or lives under a `competitors/` subdir of the
 * brand corpus; everything else is OWN. (The intake paths tag relation at write time — release-spec
 * §2.4 step 4; this read honors whatever was tagged and defaults unknown to OWN, the safe default
 * for the verbatim check since OWN text is allowed to appear.)
 *
 * @param {string} brandId
 * @param {object} [env]  default process.env
 * @returns {{ own: object[], competitor: object[], errors: object[], dir: string|null }}
 */
function readCorpus(brandId, env = process.env) {
  let dir;
  try {
    dir = paths.brandCorpusDir(brandId, env);
  } catch {
    return { own: [], competitor: [], errors: [], dir: null };
  }
  const own = [];
  const competitor = [];
  const errors = [];

  const walk = (absDir, forcedCompetitor) => {
    let entries;
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return; // absent/unreadable dir — empty (cold start), never throw.
    }
    for (const dirent of entries) {
      const name = dirent.name;
      if (name.startsWith('.')) continue;
      const abs = path.join(absDir, name);
      if (dirent.isDirectory()) {
        // A `competitors/` subdir marks everything beneath it as competitor (intake convention).
        walk(abs, forcedCompetitor || /^competitors?$/i.test(name));
        continue;
      }
      if (!dirent.isFile() || !name.toLowerCase().endsWith('.json')) continue;
      let item;
      try {
        item = JSON.parse(fs.readFileSync(abs, 'utf8'));
      } catch (err) {
        errors.push({ file: name, error: err && err.message ? err.message : String(err) });
        continue;
      }
      if (!item || typeof item !== 'object' || typeof item.text !== 'string') {
        errors.push({ file: name, error: 'not a corpus item (missing text)' });
        continue;
      }
      const isCompetitor =
        forcedCompetitor === true ||
        item.competitor === true ||
        item.relation === 'competitor' ||
        item.relation === 'comparator';
      (isCompetitor ? competitor : own).push(item);
    }
  };

  walk(dir, false);
  return { own, competitor, errors, dir };
}

// ---------------------------------------------------------------------------
// Deterministic analyzer seam (BD-ANALYZE) — injectable, with a built-in fallback.
// ---------------------------------------------------------------------------

/**
 * Resolve the deterministic analyzer as a NORMALIZED adapter, regardless of which concrete analyzer
 * is wired. Priority: caller-injected (tests / a host) first, then the BD-ANALYZE sibling
 * (engine/brand-dna/analyze.js + archetypes.js) when it has landed, then a minimal built-in fallback
 * so THIS batch is buildable + testable on its own. Every source is deterministic + zero-LLM,
 * honoring the "engine never calls an analysis LLM" rule.
 *
 * BD-ANALYZE's real contract differs from the built-in fallback's: its `analyzeCorpus(corpus, opts)`
 * takes ONE mixed corpus array + an `ownPredicate`, splits it internally, and NESTS the archetype
 * catalog under `analysis.archetypes`; its `categorizeArchetypes` lives in the sibling archetypes.js.
 * The injected/test shape passes `(own, opts)` + `(own, competitor, opts)`. This adapter hides that
 * difference behind a single `{ analyze(own, competitor, ownPredicate) } -> { analysis, archetypes }`
 * call so the orchestrator never branches on which analyzer is present.
 *
 * @param {object} opts  { analyzeCorpus?, categorizeArchetypes? }  (injected analyzers, optional)
 * @returns {{ analyze: function, source: string }}  analyze(own, competitor, ownPredicate) ⇒
 *          { analysis, archetypes:Array }.
 */
function resolveAnalyzer(opts = {}) {
  // 1) Injected (tests / host): the (own, opts) + (own, competitor, opts) shape.
  if (typeof opts.analyzeCorpus === 'function' && typeof opts.categorizeArchetypes === 'function') {
    return {
      source: 'injected',
      analyze: async (own, competitor) => {
        const analysis = await opts.analyzeCorpus(own, { competitor });
        const archetypes = await opts.categorizeArchetypes(own, competitor, { analysis });
        return { analysis, archetypes };
      },
    };
  }

  // 2) BD-ANALYZE sibling (the real deterministic analyzer). analyzeCorpus takes a MIXED corpus +
  //    ownPredicate and nests `archetypes`; categorizeArchetypes (in archetypes.js) is the same
  //    catalog. We prefer the nested catalog (one pass), falling back to a direct categorize call.
  let analyzeMod = null;
  let archetypesMod = null;
  try {
    // eslint-disable-next-line global-require, import/no-unresolved
    analyzeMod = require('./analyze');
  } catch { analyzeMod = null; }
  try {
    // eslint-disable-next-line global-require, import/no-unresolved
    archetypesMod = require('./archetypes');
  } catch { archetypesMod = null; }

  if (analyzeMod && typeof analyzeMod.analyzeCorpus === 'function') {
    return {
      source: 'bd-analyze',
      analyze: async (own, competitor, ownPredicate) => {
        const mixed = [...own, ...competitor];
        const analysis = await analyzeMod.analyzeCorpus(mixed, { ownPredicate });
        let archetypes = analysis && analysis.archetypes;
        if (archetypes && !Array.isArray(archetypes)) {
          // BD-ANALYZE's catalog is an object keyed by archetype; flatten to the writer's array shape.
          archetypes = flattenAnalyzeArchetypes(archetypes);
        }
        if ((!archetypes || !archetypes.length) && archetypesMod && typeof archetypesMod.categorizeArchetypes === 'function') {
          const cat = archetypesMod.categorizeArchetypes(mixed, { ownPredicate });
          archetypes = Array.isArray(cat) ? cat : flattenAnalyzeArchetypes(cat);
        }
        return { analysis, archetypes: archetypes || [] };
      },
    };
  }

  // 3) Built-in fallback (until BD-ANALYZE lands): the (own, competitor) shape.
  return {
    source: 'builtin-fallback',
    analyze: async (own, competitor) => ({
      analysis: builtinAnalyzeCorpus(own, { competitor }),
      archetypes: builtinCategorizeArchetypes(own, competitor),
    }),
  };
}

/**
 * Flatten BD-ANALYZE's archetype catalog (which may be an object keyed by archetype id, or carry a
 * `{ catalog: [...] }` / `{ archetypes: [...] }` array) into the writer's flat array of archetype
 * descriptors. Tolerant of either shape so a catalog-shape change in the sibling never crashes us.
 */
function flattenAnalyzeArchetypes(cat) {
  if (!cat) return [];
  if (Array.isArray(cat)) return cat;
  if (Array.isArray(cat.catalog)) return cat.catalog;
  if (Array.isArray(cat.archetypes)) return cat.archetypes;
  if (typeof cat === 'object') {
    return Object.entries(cat).map(([id, v]) => (v && typeof v === 'object' ? { id, ...v } : { id, name: id }));
  }
  return [];
}

/** Tokenize a string into lowercase word tokens (shared by the fallback analyzer + verbatim check). */
function words(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ') // drop URLs (not voice signal).
    .replace(/[^a-z0-9'#@]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Minimal deterministic OWN-corpus analysis (fallback only — BD-ANALYZE is the real one). Computes
 * auditable stats: item count, average/median post length, top vocabulary (stop-word filtered),
 * hashtag/emoji usage, and the most common opening words (hook signal). NO LLM. Returns a shape
 * BD-ANALYZE is expected to be a superset of.
 */
function builtinAnalyzeCorpus(ownItems /* , opts */) {
  const items = Array.isArray(ownItems) ? ownItems.filter((i) => i && typeof i.text === 'string') : [];
  const lengths = items.map((i) => words(i.text).length).sort((a, b) => a - b);
  const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'but', 'to', 'of', 'in', 'on', 'for', 'is', 'it', 'we', 'you', 'i', 'this', 'that', 'with', 'as', 'at', 'by', 'be', 'are', 'our', 'your', 'so', 'if', 'not', 'can', 'will', 'just', 'all', 'from', 'have', 'has']);
  const freq = new Map();
  const openers = new Map();
  let hashtags = 0;
  let mentions = 0;
  for (const it of items) {
    const ws = words(it.text);
    if (ws.length) {
      const op = ws[0];
      openers.set(op, (openers.get(op) || 0) + 1);
    }
    for (const w of ws) {
      if (w.startsWith('#')) hashtags += 1;
      else if (w.startsWith('@')) mentions += 1;
      else if (!STOP.has(w) && w.length > 2) freq.set(w, (freq.get(w) || 0) + 1);
    }
  }
  const top = (m, n) => [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n).map(([term, count]) => ({ term, count }));
  const median = lengths.length ? lengths[Math.floor(lengths.length / 2)] : 0;
  const avg = lengths.length ? Math.round(lengths.reduce((s, n) => s + n, 0) / lengths.length) : 0;
  return {
    item_count: items.length,
    length: { avg_words: avg, median_words: median, min_words: lengths[0] || 0, max_words: lengths[lengths.length - 1] || 0 },
    top_vocabulary: top(freq, 20),
    common_openers: top(openers, 8),
    hashtag_uses: hashtags,
    mention_uses: mentions,
    analyzer: 'builtin-fallback',
    note: 'Minimal built-in deterministic analysis (BD-ANALYZE not present). Auditable stats only, zero LLM.',
  };
}

/**
 * Minimal deterministic archetype categorizer (fallback only). Buckets items into coarse content
 * archetypes by keyword signal — the §1.2 "Content Categorization: bucket into Content Archetypes"
 * intent, distilled. NO LLM. Returns one archetype descriptor per non-empty bucket; competitor items
 * contribute only to PATTERN counts (never copied text). BD-ANALYZE is expected to produce a richer
 * matrix; this guarantees a non-empty catalog when a corpus exists.
 */
function builtinCategorizeArchetypes(ownItems, competitorItems /* , opts */) {
  const BUCKETS = [
    { id: 'announcement', name: 'Announcement', match: /\b(launch|announc|releas|introduc|now live|shipping|drop)\b/i },
    { id: 'teaching-thread', name: 'Teaching / Explainer', match: /\b(how to|here'?s how|guide|learn|explain|tip|lesson|thread)\b/i },
    { id: 'build-in-public', name: 'Build in Public', match: /\b(built|building|shipped|progress|behind the scenes|update|working on)\b/i },
    { id: 'community', name: 'Community Shout-out', match: /\b(thank|shout ?out|congrats|welcome|community|gm|grateful)\b/i },
    { id: 'thesis', name: 'Thesis / Conviction', match: /\b(believe|why|matters|the future|conviction|long[- ]term|thesis)\b/i },
  ];
  const counts = new Map(BUCKETS.map((b) => [b.id, { own: 0, competitor: 0 }]));
  const tally = (items, key) => {
    for (const it of items || []) {
      const t = it && typeof it.text === 'string' ? it.text : '';
      for (const b of BUCKETS) {
        if (b.match.test(t)) counts.get(b.id)[key] += 1;
      }
    }
  };
  tally(ownItems, 'own');
  tally(competitorItems, 'competitor');
  return BUCKETS
    .filter((b) => counts.get(b.id).own > 0 || counts.get(b.id).competitor > 0)
    .map((b) => ({
      id: b.id,
      name: b.name,
      own_examples: counts.get(b.id).own,
      competitor_pattern_count: counts.get(b.id).competitor, // PATTERN counts only — never copied text.
      when_to_use: `Slots themed around ${b.name.toLowerCase()} (derived from corpus frequency).`,
      analyzer: 'builtin-fallback',
    }));
}

// ---------------------------------------------------------------------------
// Competitor-not-verbatim check (RD-9) — strip + flag verbatim competitor overlap.
// ---------------------------------------------------------------------------

/**
 * Build the set of competitor word-shingles (length n) from the competitor corpus. A generated
 * output string contains a verbatim leak if it shares any n-word shingle with this set. We index
 * shingles, not raw text, so the check is O(text length) and order-sensitive (it catches a lifted
 * phrase, not coincidental shared vocabulary).
 * @returns {Set<string>}
 */
function buildCompetitorShingles(competitorItems, n) {
  const set = new Set();
  for (const it of competitorItems || []) {
    const ws = words(it && it.text);
    for (let i = 0; i + n <= ws.length; i++) {
      set.add(ws.slice(i, i + n).join(' '));
    }
  }
  return set;
}

/**
 * Scan one generated string for verbatim competitor overlap and STRIP every offending span,
 * replacing it with STRIP_MARKER. Returns the scrubbed text plus the list of stripped spans (the
 * flags). The scan walks the string's own n-word windows; a hit greedily extends to cover the whole
 * overlapping run before stripping, so a long lifted sentence becomes one marker, not many.
 *
 * @param {string} text
 * @param {Set<string>} shingleSet
 * @param {number} n
 * @returns {{ text: string, hits: string[] }}
 */
function stripVerbatim(text, shingleSet, n) {
  const src = String(text || '');
  if (!shingleSet || shingleSet.size === 0 || !src.trim()) return { text: src, hits: [] };

  // Tokenize WITH offsets so we can rebuild the string around stripped spans (preserve own copy).
  const tokens = [];
  const re = /[A-Za-z0-9'#@]+/g;
  let m;
  while ((m = re.exec(src))) {
    tokens.push({ word: m[0].toLowerCase(), start: m.index, end: m.index + m[0].length });
  }
  if (tokens.length < n) return { text: src, hits: [] };

  const hits = [];
  // Mark token index ranges that begin a competitor shingle, merging overlaps into spans.
  const spans = []; // [{ from, to }] inclusive token indices to strip.
  for (let i = 0; i + n <= tokens.length; i++) {
    const shingle = tokens.slice(i, i + n).map((t) => t.word).join(' ');
    if (shingleSet.has(shingle)) {
      const from = i;
      let to = i + n - 1;
      // Greedily extend while the next sliding window still matches.
      let j = i + 1;
      while (j + n <= tokens.length && shingleSet.has(tokens.slice(j, j + n).map((t) => t.word).join(' '))) {
        to = j + n - 1;
        j += 1;
      }
      const last = spans[spans.length - 1];
      if (last && from <= last.to + 1) last.to = Math.max(last.to, to);
      else spans.push({ from, to });
      i = to; // jump past the covered run.
    }
  }
  if (spans.length === 0) return { text: src, hits: [] };

  // Rebuild the string, replacing each span's character range with the marker.
  let out = '';
  let cursor = 0;
  for (const span of spans) {
    const cStart = tokens[span.from].start;
    const cEnd = tokens[span.to].end;
    hits.push(src.slice(cStart, cEnd));
    out += src.slice(cursor, cStart) + STRIP_MARKER;
    cursor = cEnd;
  }
  out += src.slice(cursor);
  return { text: out, hits };
}

/**
 * Apply the competitor-not-verbatim check to every string in a synthesized DNA result (the DNA prose
 * fields + each archetype's prose). Mutates a CLONE; returns { synthesis, flags }. flags is the full
 * list of stripped spans across the whole output (empty = clean). This is the enforcement point the
 * feature law requires: "on a hit, strip/flag" — nothing copied from a competitor reaches disk.
 */
function enforceNotVerbatim(synthesis, competitorItems, n) {
  const shingleSet = buildCompetitorShingles(competitorItems, n);
  const flags = [];
  const scrub = (val, where) => {
    if (typeof val !== 'string') return val;
    const r = stripVerbatim(val, shingleSet, n);
    for (const h of r.hits) flags.push({ where, span: h });
    return r.text;
  };
  const clone = synthesis && typeof synthesis === 'object' ? JSON.parse(JSON.stringify(synthesis)) : {};

  // DNA prose fields.
  for (const k of ['identity', 'tone', 'voice', 'signature_moves_prose', 'summary']) {
    if (typeof clone[k] === 'string') clone[k] = scrub(clone[k], `dna.${k}`);
  }
  for (const listKey of ['do', 'do_not', 'signature_moves']) {
    if (Array.isArray(clone[listKey])) clone[listKey] = clone[listKey].map((s, idx) => scrub(s, `dna.${listKey}[${idx}]`));
  }
  // Archetype prose.
  if (Array.isArray(clone.archetypes)) {
    clone.archetypes = clone.archetypes.map((arch, idx) => {
      if (!arch || typeof arch !== 'object') return arch;
      const a = { ...arch };
      for (const k of ['angle', 'hook_direction', 'structure', 'voice_notes', 'example', 'when_to_use']) {
        if (typeof a[k] === 'string') a[k] = scrub(a[k], `archetype[${idx}=${a.id || ''}].${k}`);
      }
      if (Array.isArray(a.must_include)) a.must_include = a.must_include.map((s, j) => scrub(s, `archetype[${idx}].must_include[${j}]`));
      return a;
    });
  }
  return { synthesis: clone, flags };
}

/**
 * Run BD-ANALYZE's canonical fail-closed verbatim assertion over an already-scrubbed synthesis, when
 * the sibling ships it. Returns { ok:true } when clean, the sibling is absent, or the check errors
 * for any non-leak reason (we never block onboarding on a tooling fault); { ok:false, leaks } only on
 * a confirmed residual competitor-copy leak (EVERBATIMCOPY). This is the substring-based counterpart
 * to the shingle-based enforceNotVerbatim strip — together they satisfy the RD-9 "a check must
 * enforce this" requirement.
 */
function canonicalVerbatimGuard(synthesis, competitorItems) {
  let archetypesMod = null;
  try {
    // eslint-disable-next-line global-require, import/no-unresolved
    archetypesMod = require('./archetypes');
  } catch {
    archetypesMod = null;
  }
  if (!archetypesMod || typeof archetypesMod.assertNoVerbatimCompetitorCopy !== 'function') {
    return { ok: true }; // sibling check not present — the shingle strip already ran.
  }
  // The canonical check splits own/competitor by ownPredicate over a mixed corpus; we pass ONLY the
  // competitor items (each is non-own by construction) so its default/own logic cannot exempt a leak.
  const corpus = (competitorItems || []).map((it) => ({ ...it, __competitor: true }));
  const pred = () => false; // every item we pass is competitor (non-own).
  try {
    archetypesMod.assertNoVerbatimCompetitorCopy(synthesis, corpus, { ownPredicate: pred });
    return { ok: true };
  } catch (err) {
    if (err && err.code === 'EVERBATIMCOPY') {
      return { ok: false, leaks: Array.isArray(err.leaks) ? err.leaks : [String(err.message || 'verbatim leak')] };
    }
    // Any other error (shape mismatch, etc.) is a tooling fault, not a confirmed leak — do not block.
    return { ok: true };
  }
}

// ---------------------------------------------------------------------------
// Cost estimate (DD-18) — safe-any-time preface for the metered synthesis.
// ---------------------------------------------------------------------------

/** Resolve the synthesis cost band: config.brand_dna.synthesis_usd / config.cost.per_synthesis_usd → default. */
function costBandFor(env) {
  try {
    // eslint-disable-next-line global-require
    const util = require('../cli/util');
    const config = util.loadSystemConfig(env);
    const c =
      (config && config.brand_dna && config.brand_dna.synthesis_usd) ||
      (config && config.cost && config.cost.per_synthesis_usd) ||
      null;
    if (c && Number.isFinite(Number(c.low)) && Number.isFinite(Number(c.high))) {
      return { low: Number(c.low), high: Number(c.high) };
    }
  } catch {
    /* fall through to default */
  }
  return DEFAULT_SYNTHESIS_USD;
}

/** Resolve the verbatim shingle width from config (config.brand_dna.verbatim_shingle_words → default). */
function shingleWidthFor(env) {
  try {
    // eslint-disable-next-line global-require
    const util = require('../cli/util');
    const config = util.loadSystemConfig(env);
    const w = config && config.brand_dna && Number(config.brand_dna.verbatim_shingle_words);
    if (Number.isFinite(w) && w >= 3) return Math.floor(w);
  } catch {
    /* default */
  }
  return DEFAULT_SHINGLE_WORDS;
}

/**
 * Estimate the cost of a Brand DNA synthesis run (DD-18 / §15.4). DNA synthesis is ONE metered host
 * seat call (the analysis itself is free/deterministic), so the estimate is a single synthesis ×
 * the configured band. Reads the corpus to report what would be synthesized; spends NOTHING and
 * makes NO seat/LLM call — safe to run any time (mirrors `engine calibrate --estimate-only`).
 *
 * @param {object} opts  { brand (required), env?, corpus? }
 * @returns {{ brand, synthesis_calls, own_items, competitor_items, per_synthesis_usd, estimated_total_usd, note }}
 */
function estimateDnaCost(opts = {}) {
  const env = opts.env || process.env;
  const brand = opts.brand;
  const corpus = opts.corpus || readCorpus(brand, env);
  const band = costBandFor(env);
  // No corpus -> no synthesis spend at all (cold-start template path is free).
  const hasCorpus = corpus.own.length > 0 || corpus.competitor.length > 0;
  const calls = hasCorpus ? 1 : 0;
  return {
    brand,
    synthesis_calls: calls,
    own_items: corpus.own.length,
    competitor_items: corpus.competitor.length,
    per_synthesis_usd: band,
    estimated_total_usd: { low: +(calls * band.low).toFixed(2), high: +(calls * band.high).toFixed(2) },
    note:
      'INDICATIVE band (measured as of release; see docs/cost.md). DNA synthesis is a host-runtime ' +
      'seat (RD-2) — the engine cannot bill it directly. The deterministic corpus analysis is FREE. ' +
      (hasCorpus ? '' : 'No corpus present: cold-start template path spends nothing (DD-21).'),
  };
}

// ---------------------------------------------------------------------------
// Markdown writers (brand-dna.md, archetype catalog) + brand.json voice update.
// ---------------------------------------------------------------------------

/** Render the brand-dna.md document from a (verbatim-scrubbed) synthesis + the analysis (provenance). */
function renderDnaMarkdown(brandId, synthesis, analysis, meta) {
  const s = synthesis || {};
  const list = (arr) => (Array.isArray(arr) && arr.length ? arr.map((x) => `- ${x}`).join('\n') : '- _(none yet — add as you learn)_');
  const lines = [
    `# Brand DNA — ${s.display_name || brandId}`,
    '',
    '> Generated by `engine generate-dna` (release-spec §1.1 / §2.4 C2). Derived from the brand\'s',
    '> ingested corpus via the deterministic analyzer + the host DNA-synthesis seat. Competitor',
    '> content informed PATTERNS only — no competitor copy is reproduced here (RD-9). Edit freely;',
    '> re-run calibration (§2.5) after changes.',
    '',
    '## 1. Identity',
    '',
    s.identity || '_Describe what this brand is, in plain language._',
    '',
    '## 2. Tone',
    '',
    s.tone || '_The emotional register of the voice._',
    '',
    `Drama dial: \`${s.drama_dial || meta.drama_dial || 'medium'}\` (keep consistent with brand.json).`,
    '',
    '## 3. Voice',
    '',
    s.voice || '_How the brand actually phrases things._',
    '',
    '## 4. Do / Do not',
    '',
    '### Always do',
    list(s.do),
    '',
    '### Never do',
    list(s.do_not),
    '',
    '## 5. Signature moves',
    '',
    list(s.signature_moves),
    s.signature_moves_prose ? `\n${s.signature_moves_prose}` : '',
    '',
    '---',
    '',
    '## Analysis provenance (deterministic, auditable — no LLM)',
    '',
    '```json',
    JSON.stringify(redactAnalysis(analysis), null, 2),
    '```',
    '',
    `_Synthesis source: ${meta.synthesis_source}. Analyzer: ${meta.analyzer_source}. Generated ${meta.generated_at}._`,
    meta.verbatim_flags && meta.verbatim_flags.length
      ? `\n> NOTE: ${meta.verbatim_flags.length} verbatim competitor span(s) were stripped from the synthesis (RD-9).`
      : '',
    '',
  ];
  return lines.filter((l) => l !== undefined).join('\n');
}

/** Defensive: strip any secret-shaped value from the analysis blob before embedding it in the doc. */
function redactAnalysis(analysis) {
  try {
    return JSON.parse(redact(JSON.stringify(analysis == null ? {} : analysis)));
  } catch {
    return {};
  }
}

/** Render one archetype catalog file (mirrors templates/brand/archetypes.template.md fields). */
function renderArchetypeMarkdown(arch) {
  const a = arch || {};
  const id = a.id || 'archetype';
  const mustInclude = Array.isArray(a.must_include) && a.must_include.length
    ? a.must_include.map((x) => `- ${x}`).join('\n')
    : '- _(add the elements every draft of this archetype must contain)_';
  return [
    `## Archetype: \`${id}\``,
    '',
    `- **Id:** \`${id}\`  (stable; matches the brief \`archetype\` field)`,
    `- **Display name:** ${a.name || id}`,
    `- **When the matcher should pick this:** ${a.when_to_use || '_the slot/theme situation this fits_'}`,
    `- **Platforms / formats:** ${a.platforms || '_e.g. twitter single tweet | thread_'}`,
    '',
    '### Angle (seeds `pre_seed.angle`)',
    a.angle || '_the core argument or point this archetype makes_',
    '',
    '### Hook direction (seeds `pre_seed.hook_direction`)',
    a.hook_direction || '_how the opening should grab attention_',
    '',
    '### Must include (seeds `pre_seed.must_include`)',
    mustInclude,
    '',
    '### Structure / pacing',
    a.structure || '_the shape — e.g. "hook -> one concrete example -> takeaway"_',
    '',
    '### Voice notes for this archetype',
    a.voice_notes || '_defaults to the Brand DNA voice_',
    '',
    '### Example (optional)',
    a.example || '_one short example in your brand voice — a seed, not a literal template_',
    '',
    a.competitor_pattern_count
      ? `<!-- Derived from ${a.competitor_pattern_count} competitor PATTERN observation(s); no competitor copy reproduced (RD-9). -->`
      : '',
    '',
  ].filter((l) => l !== undefined).join('\n');
}

/** Read a shipped template file, tolerant of absence (returns '' so we never crash onboarding). */
function readTemplate(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/**
 * Prefill the authoring template with the deterministic analysis (the no-seat-but-corpus degrade
 * path — DD-21). We do NOT rewrite the template's structure; we PREPEND an analysis block the agent
 * uses to finish the authoring by hand. This preserves the agent-assisted path exactly while giving
 * it the free deterministic signal. Competitor info appears as PATTERN counts only.
 */
function prefillAuthoringTemplate(brandId, analysis, archetypes, competitorCount) {
  const base = readTemplate(AUTHORING_TEMPLATE);
  const block = [
    `<!-- AUTO-PREFILL for "${brandId}" (engine generate-dna, no synthesis seat wired — DD-21).`,
    '     Deterministic corpus analysis below (auditable, no LLM). Use it to fill the sections that',
    '     follow; competitor signal is PATTERN counts only — never copy competitor text (RD-9). -->',
    '',
    '## Auto analysis (deterministic — finish the authoring using this)',
    '',
    '```json',
    JSON.stringify(redactAnalysis(analysis), null, 2),
    '```',
    '',
    `Detected archetypes (${(archetypes || []).length}): ${(archetypes || []).map((a) => a.id).join(', ') || 'none'}`,
    `Competitor corpus items analyzed for patterns: ${competitorCount}`,
    '',
    '---',
    '',
  ].join('\n');
  return `${block}${base}`;
}

// ---------------------------------------------------------------------------
// brand.json voice-field update (idempotent, schema-conformant).
// ---------------------------------------------------------------------------

/**
 * Update brands/<id>/brand.json voice fields: set drama_dial (from synthesis when present, else
 * leave/default) and paths.dna/paths.archetypes to the written locations. We read-modify-write only
 * the fields we own; everything else in brand.json is untouched (idempotent). Tolerant of a missing
 * brand.json (records that it could not update rather than crashing onboarding).
 *
 * @returns {{ updated: boolean, reason?: string, drama_dial?: string }}
 */
function updateBrandVoiceFields(brandId, synthesis, env) {
  let file;
  try {
    file = paths.brandConfig(brandId, env);
  } catch {
    return { updated: false, reason: 'CONTENT_HOME unset' };
  }
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { updated: false, reason: 'brand.json missing or unreadable — create it before generating DNA (templates/brand/brand.json.template)' };
  }
  const validDrama = new Set(['low', 'medium', 'high']);
  const drama = synthesis && validDrama.has(synthesis.drama_dial) ? synthesis.drama_dial : (validDrama.has(cfg.drama_dial) ? cfg.drama_dial : 'medium');
  cfg.drama_dial = drama;
  cfg.paths = {
    ...(cfg.paths || {}),
    dna: `brands/${brandId}/brand-dna.md`,
    archetypes: `brands/${brandId}/archetypes`,
    corpora: (cfg.paths && cfg.paths.corpora) || `corpora/${brandId}`,
  };
  // Atomic write (write temp then rename) — never truncate the live brand.json on a failed write
  // (MEMORY: shell `>` truncate hazard; mirror that discipline in-process).
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
  return { updated: true, drama_dial: drama };
}

// ---------------------------------------------------------------------------
// The orchestrator: generateBrandDna(opts).
// ---------------------------------------------------------------------------

/**
 * Generate (or degrade-to-template) a brand's Brand DNA + archetype catalog from its ingested corpus.
 *
 * @param {object} opts
 * @param {string}   opts.brand                 brand id (required).
 * @param {object}   [opts.env]                 default process.env.
 * @param {boolean}  [opts.yes]                 DD-18 confirmation — REQUIRED before the metered seat call.
 * @param {boolean}  [opts.estimateOnly]        return the estimate and exit (no spend).
 * @param {boolean}  [opts.force]               regenerate even if brand-dna.md already exists.
 * @param {function} [opts.dnaSeat]             INJECTABLE host synthesis seat:
 *                                                (input) => { identity, tone, voice, do[], do_not[],
 *                                                signature_moves[], drama_dial?, display_name?,
 *                                                archetypes:[{id,name,angle,hook_direction,...}] }.
 *                                                May be async. Absent ⇒ degrade to template (DD-21).
 * @param {function} [opts.analyzeCorpus]       injectable BD-ANALYZE analyzer (tests/host).
 * @param {function} [opts.categorizeArchetypes] injectable BD-ANALYZE categorizer (tests/host).
 * @param {object}   [opts.corpus]              pre-read corpus (tests / reuse a prior read).
 * @returns {Promise<{ ok, status, summary, detail?, data, exitCode? }>}
 */
async function generateBrandDna(opts = {}) {
  const env = opts.env || process.env;
  const brand = opts.brand;
  if (!brand || typeof brand !== 'string') {
    return { ok: false, exitCode: 1, status: 'usage', summary: 'generate-dna needs a brand id', detail: ['Usage: engine generate-dna --brand <id> (§2.4 C2).'], data: {} };
  }

  // Resolve brand dir / output paths up front (also validates CONTENT_HOME).
  let brandDir, dnaFile, archetypesDir;
  try {
    brandDir = paths.brandDir(brand, env);
    dnaFile = path.join(brandDir, 'brand-dna.md');
    archetypesDir = path.join(brandDir, 'archetypes');
  } catch (err) {
    return { ok: false, exitCode: 1, status: 'no-home', summary: 'generate-dna needs CONTENT_HOME', detail: [err && err.message ? err.message : String(err)], data: {} };
  }

  const corpus = opts.corpus || readCorpus(brand, env);
  const hasCorpus = corpus.own.length > 0 || corpus.competitor.length > 0;
  const estimate = estimateDnaCost({ brand, env, corpus });
  const n = shingleWidthFor(env);

  // Estimate-only: report and exit (no spend, no write).
  if (opts.estimateOnly) {
    return {
      ok: true,
      status: 'estimate-only',
      summary: hasCorpus
        ? `DNA estimate for ${brand}: 1 synthesis ≈ $${estimate.estimated_total_usd.low}–$${estimate.estimated_total_usd.high} (indicative)`
        : `DNA estimate for ${brand}: no corpus — cold-start template path is free (DD-21)`,
      detail: [estimate.note, `own items: ${estimate.own_items} | competitor items: ${estimate.competitor_items}`],
      data: { brand, estimate, corpus_summary: corpusSummary(corpus) },
    };
  }

  // Idempotency: an existing brand-dna.md is left in place unless --force.
  const dnaExists = fs.existsSync(dnaFile);
  if (dnaExists && !opts.force) {
    return {
      ok: true,
      status: 'exists',
      summary: `brand-dna.md already exists for ${brand} — left in place (re-run with --force to regenerate)`,
      detail: [`Existing: ${rel(env, dnaFile)}`, 'Idempotent: no spend, no overwrite.'],
      data: { brand, dna_path: rel(env, dnaFile), regenerated: false },
    };
  }

  // ---- COLD START (DD-21): no corpus -> manual authoring template + starter archetype. Free. ----
  if (!hasCorpus) {
    return writeColdStart(brand, env, { brandDir, dnaFile, archetypesDir, corpus });
  }

  // ---- Corpus present: run the DETERMINISTIC analysis (free, no LLM) regardless of seat. ----
  // The own/competitor partition was decided by readCorpus (relation/subdir tags). We hand the
  // analyzer an ownPredicate keyed on object identity so a mixed-corpus analyzer (BD-ANALYZE) splits
  // EXACTLY the same way readCorpus did — the verbatim check and the analysis agree on what is
  // "competitor". (The readCorpus default-OWN-on-unknown is the safe side for the verbatim check.)
  const ownSet = new Set(corpus.own);
  const ownPredicate = (item) => ownSet.has(item);
  const analyzer = resolveAnalyzer(opts);
  let analysis, archetypes;
  try {
    const out = await analyzer.analyze(corpus.own, corpus.competitor, ownPredicate);
    analysis = out.analysis;
    archetypes = Array.isArray(out.archetypes) ? out.archetypes : [];
  } catch (err) {
    return { ok: false, exitCode: 1, status: 'analysis-failed', summary: `corpus analysis failed for ${brand}`, detail: [err && err.message ? err.message : String(err)], data: { brand } };
  }

  // ---- No seat wired -> DEGRADE: write the prefilled authoring template (agent finishes). Free. ----
  if (typeof opts.dnaSeat !== 'function') {
    return writeDegradeToTemplate(brand, env, { brandDir, dnaFile, archetypesDir, analysis, archetypes, corpus });
  }

  // ---- Seat wired = the METERED path. DD-18: require confirmation before invoking the seat. ----
  if (!opts.yes) {
    return {
      ok: false,
      exitCode: 0, // a confirmation halt is the system behaving correctly, surfaced honestly.
      status: 'awaiting-confirmation',
      summary: `DNA synthesis requires confirmation: 1 synthesis ≈ $${estimate.estimated_total_usd.low}–$${estimate.estimated_total_usd.high} (indicative)`,
      detail: [estimate.note, 'Re-run with --yes to confirm and synthesize the Brand DNA (DD-18 estimate-and-confirm — §2.5).'],
      data: { brand, estimate, awaiting_confirmation: true, corpus_summary: corpusSummary(corpus) },
    };
  }

  // Invoke the host synthesis seat (turns the deterministic analysis into voice prose). The seat is
  // UNTRUSTED w.r.t. the verbatim rule (it may echo competitor text it was shown) — so its output
  // is scrubbed BEFORE anything is written.
  let raw;
  try {
    raw = await opts.dnaSeat({
      brand,
      account_class: corpus.account_class,
      analysis,
      archetypes,
      // The seat sees competitor PATTERNS via the analysis; we also pass the raw competitor texts so a
      // capable seat can study mechanics — but the post-hoc verbatim check guarantees none leak through.
      competitor_corpus: corpus.competitor,
      own_corpus: corpus.own,
    });
  } catch (err) {
    // Seat failure must NOT block onboarding (DD-21): fall back to the prefilled template path.
    const fallback = writeDegradeToTemplate(brand, env, { brandDir, dnaFile, archetypesDir, analysis, archetypes, corpus });
    fallback.status = 'seat-failed-degraded';
    fallback.summary = `DNA synthesis seat failed (${err && err.message ? err.message : String(err)}) — wrote prefilled authoring template instead (DD-21).`;
    fallback.data = { ...fallback.data, seat_error: err && err.message ? err.message : String(err) };
    return fallback;
  }

  const synthesis = normalizeSynthesis(raw, brand, analysis, archetypes);

  // COMPETITOR-NOT-VERBATIM enforcement (RD-9): strip + flag any verbatim competitor overlap.
  const { synthesis: clean, flags } = enforceNotVerbatim(synthesis, corpus.competitor, n);

  // CANONICAL FAIL-CLOSED GUARD (RD-9): if BD-ANALYZE ships its substring-based
  // assertNoVerbatimCompetitorCopy, run it over the ALREADY-SCRUBBED synthesis as a belt-and-
  // suspenders final check. My shingle strip removes phrase-level overlap; the canonical check
  // catches whole-item substring leaks a shingle window might miss. On a residual hit we REFUSE to
  // write the contaminated output rather than ship copied competitor copy — onboarding falls back to
  // the (clean) deterministic template path (DD-21). The combined check satisfies the feature law's
  // "a check must enforce this".
  const guard = canonicalVerbatimGuard(clean, corpus.competitor, ownPredicate);
  if (!guard.ok) {
    const fallback = writeDegradeToTemplate(brand, env, { brandDir, dnaFile, archetypesDir, analysis, archetypes, corpus });
    fallback.status = 'seat-verbatim-leak-refused';
    fallback.summary =
      `DNA synthesis produced residual verbatim competitor copy (${guard.leaks.length} leak(s)) that the ` +
      `strip pass could not fully remove — REFUSED to write it (RD-9). Wrote the clean deterministic ` +
      `template instead (DD-21).`;
    fallback.data = { ...fallback.data, refused_verbatim_leaks: guard.leaks };
    return fallback;
  }

  // Write outputs (idempotent: --force already cleared the gate above; we (re)write the DNA +
  // catalog, removing stale archetype files only on --force so a re-run does not orphan-duplicate).
  fs.mkdirSync(brandDir, { recursive: true });
  const meta = {
    drama_dial: clean.drama_dial,
    synthesis_source: 'host-seat',
    analyzer_source: analyzer.source,
    generated_at: new Date().toISOString(),
    verbatim_flags: flags,
  };
  const dnaMd = renderDnaMarkdown(brand, clean, analysis, meta);
  writeFileAtomic(dnaFile, dnaMd);

  const writtenArchetypes = writeArchetypeCatalog(archetypesDir, clean.archetypes, Boolean(opts.force));
  const voice = updateBrandVoiceFields(brand, clean, env);

  return {
    ok: true,
    status: flags.length ? 'generated-with-stripped-verbatim' : 'generated',
    summary:
      `Brand DNA generated for ${brand}: ${rel(env, dnaFile)} + ${writtenArchetypes.length} archetype file(s)` +
      (flags.length ? `; ${flags.length} verbatim competitor span(s) STRIPPED (RD-9)` : '') +
      (voice.updated ? `; brand.json voice fields updated (drama_dial=${voice.drama_dial})` : `; brand.json NOT updated (${voice.reason})`),
    detail: [
      `dna: ${rel(env, dnaFile)}`,
      `archetypes: ${writtenArchetypes.map((a) => a.id).join(', ') || 'none'}`,
      flags.length ? `STRIPPED verbatim (${flags.length}): ${flags.slice(0, 5).map((f) => `${f.where}`).join('; ')}${flags.length > 5 ? ' …' : ''}` : 'verbatim check: clean',
      voice.updated ? `brand.json: drama_dial=${voice.drama_dial}, paths.dna/archetypes set` : `brand.json: ${voice.reason}`,
    ],
    data: {
      brand,
      regenerated: dnaExists,
      dna_path: rel(env, dnaFile),
      archetypes: writtenArchetypes,
      verbatim_flags: flags,
      analysis,
      analyzer_source: analyzer.source,
      synthesis_source: 'host-seat',
      brand_json: voice,
      estimate,
      corpus_summary: corpusSummary(corpus),
    },
  };
}

// ---------------------------------------------------------------------------
// Write helpers shared by the generation + degrade paths.
// ---------------------------------------------------------------------------

/** Atomic file write (temp + rename) so a failed write never truncates a live file. */
function writeFileAtomic(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, file);
}

/** CONTENT_HOME-relative display path (forward-slashed), falling back to the abs path. */
function rel(env, abs) {
  try {
    return path.relative(paths.contentHome(env), abs).split(path.sep).join('/');
  } catch {
    return abs;
  }
}

/** A small, log-safe summary of the corpus read (counts + any read errors). */
function corpusSummary(corpus) {
  return {
    own_items: corpus.own.length,
    competitor_items: corpus.competitor.length,
    read_errors: corpus.errors.length,
    dir: corpus.dir ? '<corpora>/<brand>' : null, // never echo an absolute path.
  };
}

/**
 * Normalize whatever the host seat returned into the synthesis shape the writers consume. Tolerant:
 * missing fields fall back to the deterministic analysis so the DNA is never blank. Coerces lists to
 * string arrays and trims.
 */
function normalizeSynthesis(raw, brand, analysis, archetypes) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const strList = (v) => (Array.isArray(v) ? v.filter((x) => x != null).map((x) => String(x).trim()).filter(Boolean) : []);
  const validDrama = new Set(['low', 'medium', 'high']);
  // Seat archetypes win when provided; else fall back to the deterministic catalog so the catalog is
  // never empty when a corpus produced one.
  const seatArchetypes = Array.isArray(r.archetypes) && r.archetypes.length ? r.archetypes : archetypes;
  return {
    display_name: typeof r.display_name === 'string' && r.display_name.trim() ? r.display_name.trim() : undefined,
    drama_dial: validDrama.has(r.drama_dial) ? r.drama_dial : undefined,
    identity: typeof r.identity === 'string' ? r.identity.trim() : '',
    tone: typeof r.tone === 'string' ? r.tone.trim() : '',
    voice: typeof r.voice === 'string' ? r.voice.trim() : '',
    summary: typeof r.summary === 'string' ? r.summary.trim() : '',
    do: strList(r.do),
    do_not: strList(r.do_not || r.dont || r.do_nots),
    signature_moves: strList(r.signature_moves || r.signature),
    signature_moves_prose: typeof r.signature_moves_prose === 'string' ? r.signature_moves_prose.trim() : '',
    archetypes: (Array.isArray(seatArchetypes) ? seatArchetypes : []).map(normalizeArchetype),
  };
}

/** Normalize one archetype object into the writer's field set. */
function normalizeArchetype(a) {
  const x = a && typeof a === 'object' ? a : {};
  const slug = (s) => String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const id = slug(x.id || x.name) || 'archetype';
  return {
    id,
    name: typeof x.name === 'string' && x.name.trim() ? x.name.trim() : id,
    when_to_use: typeof x.when_to_use === 'string' ? x.when_to_use.trim() : '',
    platforms: typeof x.platforms === 'string' ? x.platforms.trim() : '',
    angle: typeof x.angle === 'string' ? x.angle.trim() : '',
    hook_direction: typeof x.hook_direction === 'string' ? x.hook_direction.trim() : '',
    must_include: Array.isArray(x.must_include) ? x.must_include.map((s) => String(s).trim()).filter(Boolean) : [],
    structure: typeof x.structure === 'string' ? x.structure.trim() : '',
    voice_notes: typeof x.voice_notes === 'string' ? x.voice_notes.trim() : '',
    example: typeof x.example === 'string' ? x.example.trim() : '',
    competitor_pattern_count: Number.isFinite(Number(x.competitor_pattern_count)) ? Number(x.competitor_pattern_count) : 0,
  };
}

/**
 * Write the archetype catalog directory: one file per archetype. On --force we first remove existing
 * generated .md files so a regenerate does not leave orphans/duplicates; without --force the dir is
 * created and only missing files are written (idempotent add). Returns the written descriptors.
 */
function writeArchetypeCatalog(archetypesDir, archetypes, force) {
  fs.mkdirSync(archetypesDir, { recursive: true });
  if (force) {
    try {
      for (const f of fs.readdirSync(archetypesDir)) {
        if (f.toLowerCase().endsWith('.md')) fs.rmSync(path.join(archetypesDir, f), { force: true });
      }
    } catch {
      /* tolerate */
    }
  }
  const written = [];
  const usedIds = new Set();
  for (const arch of archetypes || []) {
    let id = arch.id || 'archetype';
    // Avoid id collisions producing a single overwritten file.
    let unique = id;
    let i = 2;
    while (usedIds.has(unique)) unique = `${id}-${i++}`;
    usedIds.add(unique);
    const file = path.join(archetypesDir, `${unique}.md`);
    writeFileAtomic(file, renderArchetypeMarkdown({ ...arch, id: unique }));
    written.push({ id: unique, file: file });
  }
  return written;
}

/** Cold-start path (DD-21): no corpus -> manual authoring template + a starter archetype. Free. */
function writeColdStart(brand, env, ctx) {
  fs.mkdirSync(ctx.brandDir, { recursive: true });
  // brand-dna.md = the manual authoring template verbatim (the cold-start path, §2.9). If the
  // template is missing (should not happen in a real checkout) we still write a minimal stub.
  const tmpl = readTemplate(AUTHORING_TEMPLATE) || `# Brand DNA — ${brand}\n\n_Author this brand's voice by hand (cold start, DD-21)._\n`;
  writeFileAtomic(ctx.dnaFile, tmpl);
  // Starter archetype = the shipped archetype template (a seed for the agent/operator to copy).
  fs.mkdirSync(ctx.archetypesDir, { recursive: true });
  const starter = readTemplate(ARCHETYPE_TEMPLATE);
  if (starter) writeFileAtomic(path.join(ctx.archetypesDir, '_starter.md'), starter);
  const voice = updateBrandVoiceFields(brand, null, env);
  return {
    ok: true,
    status: 'cold-start',
    summary: `no corpus for ${brand} — wrote the cold-start manual authoring template (DD-21); fill it by hand or ingest a corpus and re-run`,
    detail: [
      `dna (manual template): ${rel(env, ctx.dnaFile)}`,
      starter ? `starter archetype: ${rel(env, path.join(ctx.archetypesDir, '_starter.md'))}` : 'archetype template not found (skipped)',
      voice.updated ? `brand.json: paths set, drama_dial=${voice.drama_dial}` : `brand.json: ${voice.reason}`,
      'Onboarding is never blocked: the manual path always works (DD-21).',
    ],
    data: { brand, status: 'cold-start', dna_path: rel(env, ctx.dnaFile), brand_json: voice, corpus_summary: corpusSummary(ctx.corpus) },
  };
}

/** Degrade path (DD-21): corpus present, no seat -> prefilled authoring template + deterministic catalog. Free. */
function writeDegradeToTemplate(brand, env, ctx) {
  fs.mkdirSync(ctx.brandDir, { recursive: true });
  const prefilled = prefillAuthoringTemplate(brand, ctx.analysis, ctx.archetypes, ctx.corpus.competitor.length);
  writeFileAtomic(ctx.dnaFile, prefilled);
  // The deterministic catalog IS written (it carries derived patterns only; the verbatim check still
  // runs over the deterministic archetype prose for belt-and-suspenders).
  const { synthesis: scrubbedArchetypesWrap, flags } = enforceNotVerbatim({ archetypes: ctx.archetypes.map(normalizeArchetype) }, ctx.corpus.competitor, shingleWidthFor(env));
  const written = writeArchetypeCatalog(ctx.archetypesDir, scrubbedArchetypesWrap.archetypes, true);
  const voice = updateBrandVoiceFields(brand, null, env);
  return {
    ok: true,
    status: 'degraded-no-seat',
    summary:
      `no DNA-synthesis seat wired for ${brand} — wrote the deterministic analysis + a PREFILLED authoring ` +
      `template (the agent finishes the voice) + ${written.length} archetype file(s) (DD-21)` +
      (flags.length ? `; ${flags.length} verbatim competitor span(s) stripped (RD-9)` : ''),
    detail: [
      `dna (prefilled authoring template): ${rel(env, ctx.dnaFile)}`,
      `archetypes (deterministic): ${written.map((a) => a.id).join(', ') || 'none'}`,
      'Wire a host DNA-synthesis seat (opts.dnaSeat) to auto-generate the voice prose; the agent-assisted path is preserved.',
      voice.updated ? `brand.json: paths set, drama_dial=${voice.drama_dial}` : `brand.json: ${voice.reason}`,
    ],
    data: {
      brand,
      status: 'degraded-no-seat',
      dna_path: rel(env, ctx.dnaFile),
      archetypes: written,
      analysis: ctx.analysis,
      verbatim_flags: flags,
      brand_json: voice,
      corpus_summary: corpusSummary(ctx.corpus),
    },
  };
}

module.exports = {
  generateBrandDna,
  estimateDnaCost,
  // Exposed for the CLI verb + tests (the seams + the enforcement the feature law names).
  readCorpus,
  enforceNotVerbatim,
  canonicalVerbatimGuard,
  stripVerbatim,
  buildCompetitorShingles,
  resolveAnalyzer,
  flattenAnalyzeArchetypes,
  costBandFor,
  shingleWidthFor,
  renderDnaMarkdown,
  renderArchetypeMarkdown,
  normalizeSynthesis,
  updateBrandVoiceFields,
  DEFAULT_SYNTHESIS_USD,
  DEFAULT_SHINGLE_WORDS,
  STRIP_MARKER,
  // Built-in deterministic fallbacks (used only until BD-ANALYZE lands; exported for testing).
  builtinAnalyzeCorpus,
  builtinCategorizeArchetypes,
};
