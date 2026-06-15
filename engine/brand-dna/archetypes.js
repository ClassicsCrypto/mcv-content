'use strict';

/**
 * engine/brand-dna/archetypes.js  [A adapted — production seed: research/x-comparator-corpus
 *   classify-archetypes-v3.js + score-archetype-engagement.js, regenerated brand-clean]
 *
 * The DETERMINISTIC archetype categorizer for the Brand-DNA / competitor-ingestion flow
 * (original-design-spec §1.2 "Content Categorization": bucket the user's AND comparators'/
 * competitors' content into "Content Archetypes" by theme, and capture idea seeds + strong
 * argument patterns + hooks per archetype). NO LLM, NO network — pure functions over an array of
 * schemas/inputs/corpus-item.schema.json items. Reproducible: same corpus in => same catalog out.
 *
 * WHY DETERMINISTIC (BRAND-DNA FEATURE LAW / RD-2): the engine never calls chain/analysis LLMs
 * directly. The auditable archetype clustering is engine code; turning the catalog into voice prose
 * is the HOST DNA-synthesis seat the runtime wires (a separate seam). This module ships the stats.
 *
 * WHAT AN ARCHETYPE IS HERE: a reusable CONTENT PATTERN (the same notion as
 * templates/brand/archetypes.template.md). We bucket corpus items by a brand-NEUTRAL signal family
 * (cadence/structure/format/hook signals — never brand-specific vocabulary), multi-label (an item
 * may match 0..N families), then per archetype we surface, from OWN content only:
 *   - idea seeds         — short representative DERIVED snippets (capped, own-corpus only),
 *   - argument patterns  — the recurring structural moves the family detects,
 *   - hook families      — the leading-opener signals that fire for the family,
 * and, when items carry engagement metrics, the engagement weight (median + lift vs the corpus
 * baseline) so the matcher/strategy can favor what actually lands.
 *
 * COMPETITOR / VERBATIM-COPY POSTURE (BRAND-DNA FEATURE LAW; RD-9; spec §18.2(3)): competitor
 * (Zone-U) content is analyzed for PATTERNS only and NEVER republished verbatim. Concretely:
 *   - idea-seed snippets are drawn from OWN content only (own = trust_class operator-curated, or
 *     items flagged own by the caller via opts.ownPredicate); competitor items contribute to
 *     COUNTS, ENGAGEMENT, and STRUCTURE signals but contribute NO copied text to the catalog.
 *   - every snippet is capped (default 160 chars), whitespace-collapsed, and provenance-tagged.
 *   - assertNoVerbatimCompetitorCopy(catalog, corpus) is exported so the writer of the DNA /
 *     archetype catalog can FAIL CLOSED if any competitor item's text appears embedded — the check
 *     the feature law requires.
 *
 * The archetype FAMILY definitions below are a brand-clean regeneration of the production
 * 14-archetype classifier. The production regexes embedded brand-private vocabulary (collection
 * names, ritual names, ticker/lore terms) — those are DROPPED. Only generic, structural signals
 * remain, so the catalog is portable across any brand and contains zero instance content
 * (release-spec §0.3 r6; model §13.3 r1/r4 regenerate-not-redact).
 *
 * Tier-3 cleanliness: no IDs/handles/absolute paths/brand strings/persona codenames. Pure values
 * in/values out; the only I/O is the caller's (this module never reads disk or the network).
 */

const { collapseWhitespace, stripUrls, hasMedia, isOwn, metricsOf, median } = require('./corpus-util');

// ---------------------------------------------------------------------------
// Archetype family catalog — brand-NEUTRAL structural/signal detectors.
//
// Each family: { desc, hooks[], argument_patterns[], test(text, item) -> boolean }.
//   - desc              : human-readable definition (ships into the catalog doc).
//   - hooks             : the opener/hook families this archetype tends to use (derived, generic).
//   - argument_patterns : the recurring structural argument moves (the "strong argument patterns"
//                         of spec §1.2) — generic, never brand-specific copy.
//   - test              : deterministic predicate over (classification text, corpus item).
//
// `test` receives the already-lowercased classification text PLUS the raw item (for media/format/
// quote signals). Detectors use only generic linguistic/structural cues — NO brand vocabulary.
// ---------------------------------------------------------------------------

const ARCHETYPES = Object.freeze({
  RITUAL: {
    desc: 'Recurring scheduled/ceremonial posts — daily greetings, weekly check-ins, roll calls.',
    hooks: ['short greeting opener', 'recurring day/ritual name', 'roll-call / say-it-back prompt'],
    argument_patterns: ['repetition as belonging', 'low-effort high-frequency presence', 'invite a reflexive reply'],
    test: (t) =>
      /^\s*(gm|gn|good (morning|night)|happy (monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b/i.test(t)
      || /\b(roll call|say it back|who.?s (here|up|awake|around)|daily (check.?in|ritual)|weekly (check.?in|sync.?up|recap))\b/i.test(t)
      || /^\s*gm[\s!.,]/i.test(t),
  },

  ANNOUNCEMENT: {
    desc: 'Concrete product/feature news — introducing / now live / just launched / shipped today.',
    hooks: ['"Introducing …"', '"Now live / available"', '"Just shipped/launched"'],
    argument_patterns: ['name the thing plainly', 'state what is new and when', 'one clear next step'],
    test: (t) =>
      /\b(introducing|now live|now available|just (launched|dropped|shipped|released|announced)|is here[.!]|we.?re (excited|thrilled) to announce|is now (live|available|supported))\b/i.test(t)
      || /\b(launch(ing|ed)?|drop(s|ping)?|ship(s|ping)?)\s+(today|tonight|tomorrow|this week|next week|now)\b/i.test(t),
  },

  NUMBERED_THESIS: {
    desc: 'Structured explainer / thread — numbered anchors, "here\'s why/what/how", "N reasons".',
    hooks: ['"1/" thread anchor', '"Here\'s why/how/what"', '"N reasons/ways/things"'],
    argument_patterns: ['enumerate then expand', 'thesis up front, proof below', 'one idea per beat'],
    test: (t) =>
      /^\s*(1\/|1\.|🧵)/u.test(t)
      || /^\s*(here.?s|here is)\s+(why|what|how|a)\b/i.test(t)
      || /^\s*(let me|i.?ll)\s+(explain|break (this|it) down|walk you through|tell you why)\b/i.test(t)
      || /^\s*\d+\s+(reasons?|ways?|things?|lessons?|takeaways?|truths?|rules?|steps?)\b/i.test(t)
      || /\bthread\s*🧵/u.test(t),
  },

  TEASER: {
    desc: 'Forward-looking cryptic hype with no current proof — soon / incoming / coming / stay tuned.',
    hooks: ['"Soon"', '"Coming / incoming"', '"Stay tuned"'],
    argument_patterns: ['withhold to create anticipation', 'vague forward promise', 'curiosity gap'],
    test: (t, item) => {
      const noUrl = stripUrls(t).trim();
      if (/^(soon|coming soon|incoming|imminent|tomorrow|tonight|stay tuned|wait for it)[.!?\s]*$/i.test(noUrl)) return true;
      if (/\b(soon|coming soon|incoming|stay tuned|wait for it|won.?t want to miss)\b/i.test(noUrl) && noUrl.length <= 60) return true;
      return false;
    },
  },

  VISUAL_SHOWCASE: {
    desc: 'Image/clip drop with minimal caption — has media, very short text, not forward-teasing.',
    hooks: ['no caption / single word', 'short evocative caption'],
    argument_patterns: ['let the visual carry the post', 'minimal text, maximal image'],
    test: (t, item) => {
      const noUrl = stripUrls(t).trim();
      if (!hasMedia(item)) return false;
      if (noUrl.length === 0) return true;
      if (noUrl.length > 60) return false;
      if (/\b(soon|coming|incoming|stay tuned|wait for it)\b/i.test(noUrl)) return false; // TEASER's job
      if (/^\s*gm[\s!.,]?$/i.test(noUrl)) return false; // RITUAL's job
      return true;
    },
  },

  PARTNERSHIP_DROP: {
    desc: 'Collaboration / partnership — "teamed up with", "in collaboration with", X × Y framing.',
    hooks: ['"X × Y"', '"Teamed up with …"', '"In collaboration with …"'],
    argument_patterns: ['borrow the partner\'s credibility', 'two audiences, one moment', 'mutual endorsement'],
    test: (t) =>
      /\b(teamed up with|partnering with|in (collaboration|partnership) with|presents|proud to (partner|work) with)\b/i.test(t)
      || /\bcollab(oration|ing)?\s+with\b/i.test(t)
      || /\s[×x]\s@?\w/.test(t),
  },

  MILESTONE: {
    desc: 'Numeric achievements — anniversaries, follower/holder/community counts, volume crossings.',
    hooks: ['"N years of …"', '"We hit/crossed/reached N"', '"Milestone:"'],
    argument_patterns: ['social proof via numbers', 'gratitude framed as scale', 'momentum signal'],
    test: (t) =>
      /\b\d+\s*(years?|yrs?|months?)\s+(of|in|since|ago|anniversary)\b/i.test(t)
      || /\b\d[\d,]*\s*(k|m|b)?\+?\s+(views?|holders?|members?|followers?|subscribers?|impressions?|users?|downloads?|sold|minted|signups?)\b/i.test(t)
      || /\b(passed|crossed|reached|hit|surpassed|over)\s+\$?\d[\d,]*\+?\s*(k|m|b)?\b/i.test(t)
      || /\b(milestone|historic|first ever|record)\b/i.test(t),
  },

  SHIP_IT_UPDATE: {
    desc: 'Progress / dev-log / behind-the-scenes — "update:", "week N", patch notes, "what we\'re building".',
    hooks: ['"Update:"', '"Week N"', '"Behind the scenes"'],
    argument_patterns: ['build in the open', 'incremental concrete progress', 'transparency as trust'],
    test: (t) =>
      /^\s*(update:?|week\s*\d+|patch notes|changelog|dev ?log)\b/i.test(t)
      || /\b(patch notes|behind the scenes|what we.?re (working on|building|shipping)|where (we|things) (are|stand)|progress (update|report)|shipping (this|next) week)\b/i.test(t)
      || /\bweek\s*\d+\b/i.test(t),
  },

  SCARCITY_FOMO: {
    desc: 'Urgency / limited supply — only N / limited / last chance / deadline / window closing.',
    hooks: ['"Only N left"', '"Last chance"', '"Ends in …"'],
    argument_patterns: ['urgency drives action', 'fear of missing out', 'finite supply framing'],
    test: (t) =>
      /\b(only\s+\d+|limited (edition|time|run|drop|series|spots?|supply)|last chance|final (hours?|call)|deadline|allow ?list|white ?list)\b/i.test(t)
      || /\b\d+\s+spots?\s+(only|left|remaining|available)\b/i.test(t)
      || /\b(closing|ending|selling out)\s+(soon|fast)|don.?t miss|\d+\s*(hours?|hrs?|days?)\s+(left|until|to go)\b/i.test(t),
  },

  ENGAGEMENT_BAIT: {
    desc: 'Reply/RT solicitation — giveaways, "caption this", "tag a friend", short question hooks.',
    hooks: ['"Caption this"', '"Tag a friend"', '"Drop a …"', 'short question opener'],
    argument_patterns: ['ask for a cheap reply', 'reward participation', 'lower the reply barrier'],
    test: (t) => {
      if (/\b(giveaway|caption (this|it)|rt to (enter|win)|reply (with|below)|comment below|tag (a|your|three|3|two|2)|like\s*\+\s*rt|drop (a|your)|who wants (one|this|it))\b/i.test(t)) return true;
      const firstLine = (t.split('\n')[0] || '');
      if (/\?\s*$/.test(firstLine.trim()) && stripUrls(t).trim().length < 120) return true; // short question hook
      return false;
    },
  },

  GRATITUDE_SHOUTOUT: {
    desc: 'Appreciation — thank you / shout-out / congrats / "so proud" / "grateful".',
    hooks: ['"Thank you …"', '"Shout-out to …"', '"So proud of …"'],
    argument_patterns: ['public appreciation builds loyalty', 'spotlight the community/partner', 'reciprocity'],
    test: (t) =>
      /\b(thank you|thanks (to|so much|for)|shout ?out|huge (congrats|thanks)|congratulations|so proud|grateful|appreciate (you|the|all)|much love|hats off|tip of the (hat|cap))\b/i.test(t),
  },

  CONVERSATIONAL_REPLY: {
    desc: 'Short reactive / quote post — reactions, banter, one-liners (not a market thesis).',
    hooks: ['one-word reaction', 'short quote-reply', 'banter opener'],
    argument_patterns: ['react in the moment', 'personality over information', 'lightweight presence'],
    test: (t, item) => {
      const noUrl = stripUrls(t).trim();
      if (item && item.is_quote_tweet === true && noUrl.length <= 100) return true;
      if (/^(lol|lmao|haha|wow|wild|incredible|based|sheesh|same|this|exactly|so true|facts|nah|yep|yes)[.!]*$/i.test(noUrl)) return true;
      if (noUrl.length > 0 && noUrl.length <= 30 && !/^(soon|gm|coming|incoming|tomorrow)/i.test(noUrl)) return true;
      return false;
    },
  },

  TOOL_OR_PLATFORM_COMMENTARY: {
    desc: 'Commentary on a tool/platform/protocol — comparisons, migrations, economics, infra takes.',
    hooks: ['"I switched from X to Y"', '"X just changed everything"', 'cost/economics framing'],
    argument_patterns: ['receipts from real usage', 'compare the alternatives', 'practitioner credibility'],
    test: (t) => {
      const noUrl = stripUrls(t).trim();
      if (noUrl.length < 30) return false;
      const toolMention = /\b(api|sdk|cli|llm|model|models|tool|tools|platform|protocol|app|framework|workflow|stack|agent|agents|pipeline|dashboard|integration|self[- ]?host(ed|ing)?|open[- ]?source)\b/i.test(t);
      const commentaryVerb = /\b(switched (from|to)|migrat(ed|ing)|replac(ed|ing)|tried|comparing|vs\.?|versus|costs? (less|more|about)|per (hour|month|year|token|seat)|subscription|saves? (you|me|us|time|money)|feels? like|biggest (change|upgrade|deal)|game ?changer|tradeoffs?|economics?|under the hood|in practice)\b/i.test(t);
      const meta = /\b(prompt(ing| engineering)?|agentic|autonomous|reasoning|context window|hallucinat|fine[- ]?tun(e|ing)|vector (db|store|search)|rag\b)\b/i.test(t);
      return (toolMention && commentaryVerb) || meta;
    },
  },

  THESIS_OR_RECEIPT: {
    desc: 'Opinion / market commentary — contrarian takes, "people don\'t realize", predictions, frames.',
    hooks: ['"People don\'t realize …"', '"Hot take:"', '"My prediction …"'],
    argument_patterns: ['stake a clear position', 'contrarian framing', 'claim now, cite the receipt'],
    test: (t) =>
      /\b(people don.?t (realize|understand|see)|nobody (sees|notices|tells you|asked)|the (real|hard|uncomfortable) truth|here.?s the (truth|reality|deal)|i (called|told you) (it|so)|aged (well|like)|do the math|let.?s be honest)\b/i.test(t)
      || /\b(hot take|unpopular opinion|controversial|my (take|prediction|bet)|gut (says|tells me)|the dirty secret|whitespace|moat|defensible|positioning|tradeoff)\b/i.test(t)
      || /\b(bull(ish)?|bear(ish)?|cycle|narrative|capitulation|maxi(s|sts)?)\b/i.test(t),
  },
});

/** All archetype codes, in a stable declaration order. */
const ARCHETYPE_CODES = Object.freeze(Object.keys(ARCHETYPES));

/**
 * Primary-archetype priority (ported from the production comparator classifier): when an item is
 * multi-label, the PRIMARY archetype is the most specific match. More-specific (news-shaped)
 * archetypes win over generic (reaction-shaped) ones. Ties broken by declaration order.
 */
const PRIMARY_PRIORITY = Object.freeze([
  'ANNOUNCEMENT', 'PARTNERSHIP_DROP', 'MILESTONE', 'SHIP_IT_UPDATE', 'NUMBERED_THESIS',
  'SCARCITY_FOMO', 'ENGAGEMENT_BAIT', 'GRATITUDE_SHOUTOUT', 'TOOL_OR_PLATFORM_COMMENTARY',
  'THESIS_OR_RECEIPT', 'RITUAL', 'TEASER', 'VISUAL_SHOWCASE', 'CONVERSATIONAL_REPLY',
]);

/** Default cap on a derived idea-seed snippet (chars). Keeps the catalog from carrying copy. */
const DEFAULT_SNIPPET_CHARS = 160;
/** Default max idea seeds captured per archetype (own content only). */
const DEFAULT_SEEDS_PER_ARCHETYPE = 6;
/** Minimum cell size before per-archetype engagement medians are reported (production: ≥3). */
const MIN_ENGAGEMENT_CELL = 3;

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/** The text a detector sees: text body joined with the optional first_line, lowercased upstream-safe. */
function classificationText(item) {
  const text = item && typeof item.text === 'string' ? item.text : '';
  const firstLine = item && typeof item.first_line === 'string' ? item.first_line : '';
  return firstLine ? `${text}\n${firstLine}` : text;
}

/**
 * Classify a single corpus item → the multi-label set of archetype codes it matches.
 * @returns {string[]} matched codes, in declaration order (possibly empty).
 */
function classifyItem(item) {
  const t = classificationText(item);
  if (!t.trim()) return [];
  const matches = [];
  for (const code of ARCHETYPE_CODES) {
    try {
      if (ARCHETYPES[code].test(t, item || {})) matches.push(code);
    } catch {
      // a malformed item must never crash the deterministic pass — skip the detector.
    }
  }
  return matches;
}

/** The primary archetype for a multi-label match set (most specific wins; null if none). */
function primaryArchetype(matches) {
  if (!matches || !matches.length) return null;
  const ranked = [...matches].sort((a, b) => {
    const pa = PRIMARY_PRIORITY.indexOf(a);
    const pb = PRIMARY_PRIORITY.indexOf(b);
    return (pa < 0 ? 999 : pa) - (pb < 0 ? 999 : pb);
  });
  return ranked[0];
}

// ---------------------------------------------------------------------------
// The categorizer — the exported entry point
// ---------------------------------------------------------------------------

/**
 * Bucket a brand corpus (own + competitor) into Content Archetypes (original-design-spec §1.2).
 *
 * DETERMINISTIC + REPRODUCIBLE: pure over the corpus array; same input => byte-identical output
 * (no Date.now, no randomness, no I/O). The caller decides what is "own": pass opts.ownPredicate,
 * else trust_class === 'operator-curated' is treated as own (the schema's promoted class).
 *
 * VERBATIM-COPY GUARD (BRAND-DNA LAW): idea_seeds are derived from OWN content ONLY and capped to
 * short snippets; competitor (Zone-U) items feed COUNTS / ENGAGEMENT / STRUCTURE signals but
 * contribute NO copied text. Use assertNoVerbatimCompetitorCopy() to fail-closed before writing.
 *
 * @param {Array<object>} corpus  corpus-item.schema.json items (own + competitor mixed).
 * @param {object} [opts]
 * @param {(item:object)=>boolean} [opts.ownPredicate]  classify an item as own (else competitor).
 * @param {number} [opts.snippetChars]      idea-seed snippet cap (default 160).
 * @param {number} [opts.seedsPerArchetype] max idea seeds per archetype (default 6).
 * @param {number} [opts.minEngagementCell] min items before per-archetype medians (default 3).
 * @returns {{archetypes: Array<object>, totals: object, codes: string[]}}
 *   archetypes[]: { code, definition, hooks[], argument_patterns[], counts:{own,competitor,total},
 *     primary_count, share_own, idea_seeds[], engagement } sorted by total count desc.
 */
function categorizeArchetypes(corpus, opts = {}) {
  const items = Array.isArray(corpus) ? corpus : [];
  const ownPredicate = typeof opts.ownPredicate === 'function' ? opts.ownPredicate : isOwn;
  const snippetChars = Number(opts.snippetChars) > 0 ? Number(opts.snippetChars) : DEFAULT_SNIPPET_CHARS;
  const seedsPer = Number(opts.seedsPerArchetype) > 0 ? Number(opts.seedsPerArchetype) : DEFAULT_SEEDS_PER_ARCHETYPE;
  const minCell = Number.isFinite(opts.minEngagementCell) && opts.minEngagementCell >= 0
    ? Number(opts.minEngagementCell) : MIN_ENGAGEMENT_CELL;

  // Per-archetype accumulators.
  const acc = {};
  for (const code of ARCHETYPE_CODES) {
    acc[code] = {
      own: 0, competitor: 0, primary: 0,
      ownSeeds: [],                 // derived snippets from OWN content only
      metrics: [],                  // engagement metrics across ALL items in the family
    };
  }
  let ownTotal = 0;
  let competitorTotal = 0;
  let classifiedItems = 0;

  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const own = Boolean(ownPredicate(item));
    if (own) ownTotal += 1; else competitorTotal += 1;

    const matches = classifyItem(item);
    if (matches.length) classifiedItems += 1;
    const primary = primaryArchetype(matches);
    const m = metricsOf(item);

    for (const code of matches) {
      const cell = acc[code];
      if (own) cell.own += 1; else cell.competitor += 1;
      if (m) cell.metrics.push(m);
      // idea seeds: OWN content only, capped + collapsed (never competitor copy).
      if (own && cell.ownSeeds.length < seedsPer) {
        const snippet = collapseWhitespace(stripUrls(item.text || '')).slice(0, snippetChars);
        if (snippet) {
          cell.ownSeeds.push({
            snippet,
            archetype: code,
            is_primary: code === primary,
            provenance: { trust_class: item.trust_class || null, source: item.source || null, captured_at: item.captured_at || null },
          });
        }
      }
    }
    if (primary) acc[primary].primary += 1;
  }

  // Corpus-wide engagement baseline (median per metric across every item that carries metrics).
  const allMetrics = items.map(metricsOf).filter(Boolean);
  const baseline = engagementBaseline(allMetrics);

  const archetypes = ARCHETYPE_CODES.map((code) => {
    const cell = acc[code];
    const total = cell.own + cell.competitor;
    return {
      code,
      definition: ARCHETYPES[code].desc,
      hooks: ARCHETYPES[code].hooks.slice(),
      argument_patterns: ARCHETYPES[code].argument_patterns.slice(),
      counts: { own: cell.own, competitor: cell.competitor, total },
      primary_count: cell.primary,
      share_own: ownTotal ? round2(cell.own / ownTotal) : 0,
      share_competitor: competitorTotal ? round2(cell.competitor / competitorTotal) : 0,
      idea_seeds: cell.ownSeeds,
      engagement: engagementForCell(cell.metrics, baseline, minCell),
    };
  }).filter((a) => a.counts.total > 0)
    .sort((a, b) => b.counts.total - a.counts.total || ARCHETYPE_CODES.indexOf(a.code) - ARCHETYPE_CODES.indexOf(b.code));

  return {
    archetypes,
    codes: ARCHETYPE_CODES.slice(),
    totals: {
      items: items.length,
      own: ownTotal,
      competitor: competitorTotal,
      classified: classifiedItems,
      unclassified: items.length - classifiedItems,
      baseline,
    },
  };
}

// ---------------------------------------------------------------------------
// Engagement helpers (ported from production score-archetype-engagement.js)
// ---------------------------------------------------------------------------

const METRIC_KEYS = Object.freeze(['likes', 'replies', 'reposts', 'impressions', 'bookmarks']);

/** Median per metric over a list of normalized metric objects. Empty => null. */
function engagementBaseline(metricList) {
  if (!metricList || !metricList.length) return null;
  const out = {};
  for (const k of METRIC_KEYS) out[k] = median(metricList.map((m) => Number(m[k]) || 0));
  out.n = metricList.length;
  return out;
}

/**
 * Per-archetype engagement: median per metric + lift vs the corpus baseline (median/median).
 * Lift > 1 => the archetype over-performs the corpus median; < 1 => under-performs. Suppressed
 * (null) below minCell items (production used ≥3) so a thin cell never produces a confident number.
 */
function engagementForCell(metricList, baseline, minCell) {
  if (!metricList || metricList.length < minCell || !baseline) {
    return { n: metricList ? metricList.length : 0, available: false };
  }
  const out = { n: metricList.length, available: true, median: {}, lift: {} };
  for (const k of METRIC_KEYS) {
    const med = median(metricList.map((m) => Number(m[k]) || 0));
    out.median[k] = med;
    const base = baseline[k];
    out.lift[k] = base ? round2(med / base) : null;
  }
  return out;
}

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

// ---------------------------------------------------------------------------
// Verbatim-copy guard (BRAND-DNA FEATURE LAW — competitor copy must never be republished)
// ---------------------------------------------------------------------------

/** Normalize for substring comparison: collapse whitespace + lowercase. */
function normForCompare(s) {
  return collapseWhitespace(String(s || '')).toLowerCase();
}

/**
 * Fail-closed check that a generated catalog (or any DNA artifact carrying snippets) does NOT embed
 * a competitor (Zone-U, non-own) corpus item's text verbatim. The feature law requires "a check
 * must enforce this". The DNA/archetype WRITER calls this before persisting; it throws on a hit.
 *
 * Method: build the set of competitor item texts (>= minLen chars after normalization), then scan
 * every catalog string field; if any competitor text is a substring of a catalog string (or vice
 * versa for short competitor posts), it is a verbatim leak. Own content is exempt (it is the
 * brand's own voice). Pure + deterministic.
 *
 * @param {object} catalog  the categorizeArchetypes() result (or any object with string fields).
 * @param {Array<object>} corpus  the same corpus the catalog was built from.
 * @param {object} [opts] { ownPredicate?, minLen? (default 40) }
 * @returns {{ ok: true }}  on success.
 * @throws {Error} code 'EVERBATIMCOPY' with .leaks[] when a competitor item's text is embedded.
 */
function assertNoVerbatimCompetitorCopy(catalog, corpus, opts = {}) {
  const ownPredicate = typeof opts.ownPredicate === 'function' ? opts.ownPredicate : isOwn;
  const minLen = Number(opts.minLen) > 0 ? Number(opts.minLen) : 40;
  const items = Array.isArray(corpus) ? corpus : [];

  const competitorTexts = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    if (ownPredicate(item)) continue; // own content may legitimately appear
    const norm = normForCompare(item.text);
    if (norm.length >= minLen) competitorTexts.push(norm);
  }
  if (!competitorTexts.length) return { ok: true };

  const haystacks = collectStrings(catalog).map(normForCompare).filter((s) => s.length >= minLen);
  const leaks = [];
  for (const comp of competitorTexts) {
    for (const hay of haystacks) {
      if (hay.includes(comp) || comp.includes(hay)) {
        leaks.push(comp.slice(0, 80));
        break;
      }
    }
  }
  if (leaks.length) {
    const err = new Error(
      `verbatim competitor copy detected in the generated catalog (${leaks.length} item(s)). ` +
        `Competitor (Zone-U) content must be analyzed for PATTERNS only and NEVER republished ` +
        `verbatim (BRAND-DNA feature law / RD-9). Regenerate the catalog from derived patterns.`,
    );
    err.code = 'EVERBATIMCOPY';
    err.leaks = leaks;
    throw err;
  }
  return { ok: true };
}

/** Recursively collect every string value in an object/array (for the verbatim scan). */
function collectStrings(node, out = []) {
  if (node == null) return out;
  if (typeof node === 'string') { out.push(node); return out; }
  if (Array.isArray(node)) { for (const v of node) collectStrings(v, out); return out; }
  if (typeof node === 'object') { for (const v of Object.values(node)) collectStrings(v, out); return out; }
  return out;
}

module.exports = {
  // the exported API
  categorizeArchetypes,
  assertNoVerbatimCompetitorCopy,
  // classification primitives (exported for analyze.js + tests)
  classifyItem,
  primaryArchetype,
  classificationText,
  // catalog + vocabulary
  ARCHETYPES,
  ARCHETYPE_CODES,
  PRIMARY_PRIORITY,
  METRIC_KEYS,
  // engagement helpers (shared with analyze.js)
  engagementBaseline,
  engagementForCell,
};
