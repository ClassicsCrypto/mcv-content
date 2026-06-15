'use strict';

/**
 * engine/sources/seed.js  [N net-new — content-source → brief-seed bridge]
 *
 * The bridge from the two CONFIG-GATED content sources into the EXISTING chain. Both sources
 * produce a SEED — an idea/argument pre-seed (release-spec §2.1) shaped as a
 * schemas/inputs/brief.schema.json brief — that the matcher hands the writer. NEITHER source
 * bypasses the chain: a seed enters the SAME path as any calendar slot — matcher pre-seed →
 * writer → the universal hybrid gate (pre-gate-lint + LLM voice/quality + claims/privacy
 * firewall) → packager → validate-package → queue (awaiting_approval) → the HUMAN approval card
 * (the double gate, §2.4). NOTHING here publishes; SAFE is the default mode (RD-16f).
 *
 * Two sources, two seed shapes, ONE brief contract:
 *
 *   1. TREND  (release-spec §6.7, §8.8; DD-16) — a Trend Report
 *      (schemas/inputs/trend-report.schema.json, always Zone U) → a TREND-SLOT brief seed.
 *      The seed carries the report's suggested ANGLES only (never drafted comment/reply text —
 *      §1.4 restated as principle), fills a RESERVED `trend` calendar slot (never out-of-calendar,
 *      DD-16), sets `content_form` (standalone | quote-retweet — DD-16, quote-retweet is a
 *      first-class gated content_form), and inherits the report's freshness window as the
 *      trend-card TTL/expiry basis (DD-15). It points the writer at the trend/quote-retweet
 *      framework (rules/frameworks/trend-quote-retweet.md).
 *
 *   2. WORK-RECAP (release-spec §3.3 operator/founder/team accounts, flexible voice) — a
 *      redacted work-recap item → a BUILD-IN-PUBLIC brief seed. It targets OPERATOR-class
 *      accounts (a founder/team sharing the work, not the brand IP), points the writer at the
 *      build-in-public framework (rules/frameworks/build-in-public.md), and is authentic and
 *      specific with no hype-inflation (the humanizer rule, rule.core.humanizer).
 *
 * PRIVACY (load-bearing for work-recap): project memory is SENSITIVE. The work-recap source is
 * the MECHANISM only — it never bundles or reads real memory in this module. The CALLER (the
 * work-recap source/adapter, a sibling batch) runs the redaction/privacy PRE-PASS through
 * engine/shared/redact.js + a config-extendable private-term deny list BEFORE handing a recap to
 * mapWorkRecapSeed. This module additionally:
 *   - re-runs redact() over every recap-derived string as a belt-and-suspenders write-time pass,
 *   - threads the recap's `must_not_include` privacy guardrails (deny-list terms + caller-supplied
 *     forbidden facts) onto the brief's pre_seed.must_not_include AND enrichment.proof_stack.
 *     fact_safety, so the writer is told what it must not say and the gate's privacy/leak check
 *     (rule.core.claims-safety FM.* privacy codes) has the explicit forbidden set to enforce
 *     BEFORE the approval card. Human approval is the final backstop.
 *
 * TESTABILITY (RD-12, no secrets in CI): this module is PURE mapping over plain objects. It makes
 * NO external calls — the trend provider read and the memory file read are the CALLER's job and
 * are injectable exactly like the §12.5 vision seam, so tests drive mapTrendSeed/mapWorkRecapSeed
 * with fake reports/recaps and zero keys. The only dependency is engine/shared/redact.js (a pure,
 * value-in/value-out helper).
 *
 * CONFIG-GATED, OFF BY DEFAULT: both pathways ship disabled. The operator opts in via the
 * `trends` and `work_recap` config blocks (config/system.json, a sibling schema batch). The
 * gating decision belongs to the orchestrator/source caller; the helpers here accept the resolved
 * config and FAIL CLOSED (mapTrendSeed/mapWorkRecapSeed throw if asked to map while their
 * pathway's config says disabled), so an accidental call cannot silently inject content.
 *
 * Tier-3 cleanliness (§0.3 r6 / RD-3): no IDs/handles/absolute paths/brand strings; no production
 * persona codenames. The only example brand anywhere downstream is the synthetic "Acme Cosmos"
 * (fixtures/docs). Repo-relative framework refs only; no $CONTENT_HOME path is constructed here.
 */

const { redact } = require('../shared/redact');

// ---------------------------------------------------------------------------
// Constants — the shipped framework refs + the source/content-form vocabulary
// ---------------------------------------------------------------------------

/** Repo-relative writing-framework refs the seed points the writer at (§9.3). */
const FRAMEWORK_REF = Object.freeze({
  TREND_QUOTE_RETWEET: 'rules/frameworks/trend-quote-retweet.md',
  BUILD_IN_PUBLIC: 'rules/frameworks/build-in-public.md',
});

/** The content-source kinds this bridge maps (provenance stamped onto every seed). */
const SOURCE = Object.freeze({
  TREND: 'trend',
  WORK_RECAP: 'work-recap',
});

/** content_form vocabulary (DD-16; queue-entry §7.1). standalone is the default. */
const CONTENT_FORM = Object.freeze({
  STANDALONE: 'standalone',
  QUOTE_RETWEET: 'quote-retweet',
});

const VALID_CONTENT_FORMS = new Set(Object.values(CONTENT_FORM));

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

/** Redact a string for safe carry into the brief (work-time belt-and-suspenders, §13.3). */
function clean(str) {
  if (str == null) return str;
  return redact(String(str));
}

/** Redact every string in an array, dropping empties. */
function cleanList(arr) {
  if (!Array.isArray(arr)) return [];
  return arr
    .map((s) => clean(s))
    .filter((s) => typeof s === 'string' && s.trim().length > 0);
}

/** Dedupe a string list preserving order. */
function uniq(arr) {
  const seen = new Set();
  const out = [];
  for (const s of arr) {
    if (!seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  return out;
}

/** The brief.schema.json top-level keys (additionalProperties:false). Anything else is dropped. */
const BRIEF_KEYS = Object.freeze([
  'content_id', 'brand', 'platform', 'format', 'mode', 'slot_ref', 'archetype',
  'pillar', 'theme', 'pre_seed', 'target_length', 'framework_ref', 'media_decision_hint',
  'enrichment',
]);

/**
 * Build a STRICTLY brief.schema.json-conformant brief from a candidate object. The schema is
 * additionalProperties:false and requires string types on optional scalars when present, so we:
 *   - keep ONLY the allowed top-level keys (slot/source extras live on the envelope, not here),
 *   - DROP any key whose value is null/undefined/'' (the schema rejects a null where it wants a
 *     string; absence validates), and
 *   - leave required keys (content_id, brand, platform, format, slot_ref, archetype, pre_seed) to
 *     the caller — a missing required value surfaces as a schema-validation failure, not a silent
 *     null. (Trend/recap callers always supply a slot, so brand/platform/format come from it.)
 * Returns a new object; the input is never mutated.
 */
function withSchemaBrief(candidate) {
  const out = {};
  for (const key of BRIEF_KEYS) {
    const v = candidate[key];
    if (v === null || v === undefined || v === '') continue;
    out[key] = v;
  }
  return out;
}

/**
 * Is a source pathway enabled in config? Fail-closed: absence / non-true ⇒ disabled. Reads
 * `config.trends.enabled` / `config.work_recap.enabled` (the sibling config-schema blocks).
 */
function pathwayEnabled(config, blockKey) {
  const block = config && typeof config === 'object' ? config[blockKey] : null;
  return Boolean(block && block.enabled === true);
}

/** Throw a precise "pathway disabled" error (the config gate is honored, not bypassed). */
function refuseDisabled(blockKey) {
  const err = new Error(
    `content source "${blockKey}" is disabled. Both source pathways ship OFF by default; ` +
      `the operator opts in via the config "${blockKey}" block (config/system.json) before any ` +
      `seed may be mapped. NOTHING auto-publishes; the seed still passes the full chain + human approval.`,
  );
  err.code = 'ESOURCEDISABLED';
  err.block = blockKey;
  throw err;
}

// ---------------------------------------------------------------------------
// (1a) TREND → trend-slot brief seed (matcher pre-seed; §2.1, §6.7, §8.8; DD-16/DD-15)
// ---------------------------------------------------------------------------

/**
 * Collapse a Trend Report's topics into a single matcher pre-seed angle + the supporting angle
 * set. Angles ONLY — drafted comment/reply text is never produced or carried (§1.4 principle).
 * Source links travel as references (Zone-U provenance) so the writer/operator can find the
 * originating posts to engage authentically; they are NOT drafted into the content.
 */
function summarizeTrend(report) {
  const topics = Array.isArray(report.topics) ? report.topics : [];
  const angles = [];
  const links = [];
  const topicLabels = [];
  for (const t of topics) {
    if (!t || typeof t !== 'object') continue;
    if (t.topic) topicLabels.push(clean(t.topic));
    for (const a of cleanList(t.suggested_angles)) angles.push(a);
    for (const l of (Array.isArray(t.source_links) ? t.source_links : [])) {
      if (typeof l === 'string' && l.trim()) links.push(l.trim());
    }
  }
  return {
    topicLabels: uniq(topicLabels.filter(Boolean)),
    angles: uniq(angles),
    links: uniq(links),
  };
}

/**
 * Map a Trend Report → a trend-slot brief seed (a brief.schema.json-shaped pre-seed brief).
 *
 * The seed is a SLOT-RUN ENVELOPE the orchestrator dispatches into a RESERVED `trend` calendar
 * slot (DD-16: trend fills reserved slots, never out-of-calendar). It carries the slot/source/
 * trend metadata the pipeline already reads (pipelines/shared.js makeRunCtx / matcherInput /
 * buildQueueFields read slot_type, content_form, trend_report(_ref), pre_seed at the SLOT level)
 * PLUS an embedded `brief` that is STRICTLY schema-conformant (brief.schema.json is
 * additionalProperties:false — the brief carries no slot/source extras; those live on the
 * envelope). The matcher consumes the brief; the slot extras drive trend handling. Splitting them
 * keeps the brief a clean schema artifact and the envelope the dispatch command.
 *
 * @param {object} report  a trend-report.schema.json object (always Zone U). The CALLER obtained
 *   it from the manual path or an injected trend adapter (the §12.2 seam) — never read here.
 * @param {object} opts
 * @param {object} opts.slot      the reserved trend calendar slot to fill: { slot_id, brand,
 *   platform, format, theme?, pillar?, archetype? }. REQUIRED — DD-16 forbids out-of-calendar.
 * @param {object} [opts.config]  resolved config/system.json. mapping is REFUSED unless
 *   config.trends.enabled === true (fail-closed config gate).
 * @param {string} [opts.content_form]  standalone | quote-retweet (DD-16). Default standalone.
 * @param {string} [opts.mode]    SAFE | LIVE_PREVIEW | LIVE inherited from the originating command
 *   (default omitted ⇒ the chain resolves SAFE).
 * @param {string} [opts.trend_report_ref]  CONTENT_HOME-relative ref to the stored report (the
 *   queue entry's trend_source_ref / the matcher's report_ref). The report BODY is not embedded.
 * @returns {object} a trend-slot seed envelope: { source, slot_type:'trend', content_form,
 *   content_id, brand, platform, format, slot_ref, mode?, pre_seed, trend_report, trend_report_ref?,
 *   freshness_window?, expires_basis?, provenance, brief } — `brief` validates against brief.schema.json.
 */
function mapTrendSeed(report, opts = {}) {
  if (!pathwayEnabled(opts.config, 'trends')) refuseDisabled('trends');
  if (!report || typeof report !== 'object' || !Array.isArray(report.topics) || report.topics.length === 0) {
    throw new Error('mapTrendSeed: a trend-report.schema.json object with at least one topic is required');
  }
  const slot = opts.slot;
  if (!slot || typeof slot !== 'object' || !slot.slot_id) {
    throw new Error('mapTrendSeed: a reserved trend calendar slot (with slot_id) is required — DD-16 forbids out-of-calendar trend content');
  }
  // The brief.schema requires `brand`; the reserved trend slot names the brand it produces for.
  if (!slot.brand) {
    throw new Error('mapTrendSeed: slot.brand is required — the reserved trend slot names the brand it produces for (§6.5)');
  }

  const contentForm = VALID_CONTENT_FORMS.has(opts.content_form) ? opts.content_form : CONTENT_FORM.STANDALONE;
  const { topicLabels, angles, links } = summarizeTrend(report);

  // The pre-seed ANGLE: the matcher's core direction. We hand the matcher the topic + the
  // strongest suggested angle; the matcher (an LLM seat) refines it against brand voice. We never
  // draft comment text — the angle is a direction, not a reply.
  const primaryTopic = topicLabels[0] || 'the trending topic';
  const primaryAngle = angles[0]
    ? `Engage the trend "${primaryTopic}" via this angle: ${angles[0]}`
    : `Take a brand-authentic angle on the trending topic "${primaryTopic}".`;

  const mustNotInclude = [
    // Hard principle: trend content suggests angles; it NEVER drafts reply/comment text (§1.4/DD-16).
    'drafted reply or comment text for someone else\'s post',
    'fabricated trend metrics or made-up volume/velocity numbers',
  ];
  if (contentForm === CONTENT_FORM.QUOTE_RETWEET) {
    mustNotInclude.push('restating the quoted post instead of adding a distinct take');
  }

  const content_id = opts.content_id || `${slot.slot_id}-trend`;
  const platform = report.platform || slot.platform || null;

  // The schema-conformant brief (brief.schema.json, additionalProperties:false). The matcher may
  // refine this; the seed pre-populates it from the trend angles.
  const brief = withSchemaBrief({
    content_id,
    brand: slot.brand,
    platform,
    format: slot.format,
    mode: opts.mode,
    slot_ref: slot.slot_id,
    archetype: slot.archetype || 'trend-response',
    theme: slot.theme,
    pre_seed: {
      angle: clean(primaryAngle),
      hook_direction: 'Open on the brand\'s genuine point of view on the trend — not a recap of the trend itself.',
      must_include: topicLabels.length ? [`a clear connection to: ${topicLabels.join(', ')}`] : [],
      must_not_include: mustNotInclude,
      tone: 'timely and specific; in the brand\'s real voice, never bandwagon hype',
    },
    framework_ref: FRAMEWORK_REF.TREND_QUOTE_RETWEET,
    enrichment: {
      summary: clean(primaryAngle),
      proof_stack: {
        // Suggested angles are the writer's option set — angles only, NOT drafted text.
        primary: angles.slice(0, 1),
        supporting: angles.slice(1),
        fact_safety: [
          'do not state trend volume/velocity as fact unless the report supplies a verified number',
          'do not put words in the quoted/original author\'s mouth',
        ],
      },
      core_tension: topicLabels.length ? `Why "${topicLabels[0]}" matters to the brand's audience right now.` : 'Why this trend matters to the brand\'s audience right now.',
      humanizer_notes: [
        'no bandwagon hype ("everyone is talking about…"); say the specific thing the brand actually thinks',
        'authentic engagement is a real point of view, not a trend-chasing template',
      ],
    },
  });

  // The slot-run envelope the orchestrator dispatches (the slot/source/trend extras live HERE,
  // not on the brief). pipelines/shared.js makeRunCtx reads slot_type/content_form/trend_report
  // off this; the matcher receives `brief` as its pre-seed.
  const seed = {
    source: SOURCE.TREND,
    slot_type: 'trend',
    content_form: contentForm,
    content_id,
    brand: slot.brand || null,
    platform,
    format: slot.format || null,
    slot_ref: slot.slot_id,
    pre_seed: brief.pre_seed,
    // The report rides along so the pipeline can carry trend provenance + freshness onto the queue
    // entry (buildQueueFields). It is the SAME Zone-U report — no drafted text is added.
    trend_report: report,
    provenance: {
      // Always Zone U: trend reports are untrusted external input (§6.7).
      trust_zone: 'U',
      source: SOURCE.TREND,
      method: (report.provenance && report.provenance.method) || 'manual',
      source_links: links,
    },
    brief,
  };
  if (opts.mode) seed.mode = opts.mode;
  if (opts.trend_report_ref) seed.trend_report_ref = opts.trend_report_ref;

  // Freshness window → expiry basis (DD-15 TTL). Inherited verbatim from the report so the
  // trend-card TTL is bound to the report's freshness window (card_ttl.trend = freshness-window-bound).
  if (report.freshness_window && (report.freshness_window.expires_at || report.freshness_window.duration)) {
    seed.freshness_window = { ...report.freshness_window };
    seed.expires_basis = 'freshness_window';
  }
  return seed;
}

// ---------------------------------------------------------------------------
// (1b) WORK-RECAP → build-in-public brief seed (matcher pre-seed; §2.1, §3.3)
// ---------------------------------------------------------------------------

/**
 * Coerce a deny-list value into a flat string[] of forbidden terms. Accepts EITHER:
 *   - a flat string[] (`["TermA","TermB"]`), or
 *   - the fixture/config deny-list object `{ terms[], secret_literals[] }` (what the work-recap
 *     memory source's private-terms.json carries — case_insensitive is honored by the gate, not
 *     here). Both `terms` and `secret_literals` are forbidden-to-print anti-targets.
 * Anything else ⇒ []. The result holds only PUBLIC anti-targets (terms NOT to print); the secret
 * VALUES themselves were already stripped by the caller's redaction pre-pass.
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

/**
 * Build the privacy deny-set the writer must avoid and the gate's privacy/leak check enforces.
 * Unions: (a) the config-extendable private-term deny list (config.work_recap.private_terms — a
 * flat array OR a { terms, secret_literals } object), and (b) the caller-supplied forbidden facts
 * on the recap (recap.private_terms / recap.forbidden, same shapes). These names are PUBLIC
 * anti-targets (terms NOT to print) — they are NOT secrets themselves, so they are safe to carry on
 * the brief. The caller's redaction PRE-PASS has already removed secret VALUES from the recap text;
 * this list catches sensitive TERMS (partner names, codenames, unreleased feature names) the writer
 * must not surface.
 */
function privacyDenySet(recap, config) {
  const fromConfig = config && config.work_recap ? coerceDenyList(config.work_recap.private_terms) : [];
  const fromRecap = []
    .concat(coerceDenyList(recap.private_terms))
    .concat(coerceDenyList(recap.forbidden));
  return uniq(
    fromConfig
      .concat(fromRecap)
      .map((s) => String(s || '').trim())
      .filter(Boolean),
  );
}

/**
 * Normalize a work-recap INPUT into the simple { shipped, learned, next, highlight, private_terms,
 * account_class, period } shape mapWorkRecapSeed maps. Accepts EITHER:
 *   - the simple recap shape directly (passed through), OR
 *   - the work-recap SOURCE seed produced by engine/sources/work-recap/build-seed.js
 *     ({ source:'work-recap'|'work_recap', work_items:[{summary,...}], angle, privacy_flags,
 *       account, ... }). Its sanitized `work_items[].summary` lines become the `shipped` set, its
 *       `angle` becomes the `highlight`, and any item-level `privacy_flags.terms`/source
 *       private terms feed the deny-set. This lets the cross-source bridge consume the source
 *       batch's native seed without the caller re-shaping it.
 */
function normalizeRecap(input) {
  if (!input || typeof input !== 'object') return input;
  const isSourceSeed = Array.isArray(input.work_items)
    || input.source === 'work-recap' || input.source === 'work_recap'
    || input.slot_type === 'work_recap';
  if (!isSourceSeed) return input; // already the simple recap shape
  const items = Array.isArray(input.work_items) ? input.work_items : [];
  const shipped = items.map((it) => (it && (it.summary || it.text)) || '').filter(Boolean);
  // Collect any item-level / seed-level forbidden TERMS the source flagged (anti-targets only).
  const denyTerms = [];
  const pf = input.privacy_flags || {};
  for (const t of coerceDenyList(pf.terms || pf.private_terms)) denyTerms.push(t);
  for (const it of items) {
    const ipf = (it && it.privacy_flags) || {};
    for (const t of coerceDenyList(ipf.terms || ipf.private_terms)) denyTerms.push(t);
  }
  if (Array.isArray(input.private_terms)) denyTerms.push(...input.private_terms);
  return {
    shipped,
    learned: Array.isArray(input.learned) ? input.learned : [],
    next: Array.isArray(input.next) ? input.next : [],
    highlight: input.highlight || input.angle || (shipped.length ? shipped[0] : ''),
    private_terms: uniq(denyTerms),
    account_class: input.account_class || 'operator',
    period: input.period || (input.provenance && input.provenance.period) || null,
  };
}

/**
 * Map a (REDACTED) work-recap item → a build-in-public brief seed.
 *
 * The recap is the work-in-the-open material: what shipped / what was learned / what is next,
 * already run through the caller's redaction + privacy pre-pass (engine/shared/redact.js + the
 * config private-term deny list). It may be the simple recap shape OR the work-recap source seed
 * (engine/sources/work-recap/build-seed.js) — normalizeRecap accepts both. The seed targets an
 * OPERATOR-class account (a founder/team sharing the build — §3.3 flexible voice) and points the
 * writer at the build-in-public framework.
 *
 * Privacy is threaded TWICE: the deny-set lands on pre_seed.must_not_include (the writer's "do not
 * say" list) AND on enrichment.proof_stack.fact_safety (the gate's privacy/leak check input,
 * rule.core.claims-safety). Human approval is the final backstop.
 *
 * @param {object} recap  a redacted work-recap item:
 *     { shipped?: string[], learned?: string[], next?: string[], highlight?: string,
 *       period?: {start,end}, private_terms?: string[], forbidden?: string[],
 *       account_class?: 'operator' }  — the CALLER produced this; this module re-redacts defensively.
 * @param {object} opts
 * @param {object} opts.slot      the calendar slot this recap fills: { slot_id, brand?, platform,
 *   format, archetype? }. REQUIRED (recaps fill calendar slots like any content; no out-of-calendar).
 * @param {object} [opts.config]  resolved config/system.json. mapping is REFUSED unless
 *   config.work_recap.enabled === true (fail-closed config gate).
 * @param {string} [opts.account_ref]  the operator/founder/team account this targets (Tier-3 ref
 *   carried for the packager; never a hardcoded handle).
 * @param {string} [opts.mode]    SAFE | LIVE_PREVIEW | LIVE inherited from the originating command.
 * @param {string} [opts.memory_source_ref]  CONTENT_HOME-relative ref to the memory the recap was
 *   distilled from (provenance for the approval card; the memory body is never embedded).
 * @returns {object} a build-in-public seed envelope: { source, slot_type, content_form, content_id,
 *   brand, platform, format, slot_ref, account_class, account_ref?, mode?, pre_seed, provenance,
 *   brief } — `brief` validates against brief.schema.json.
 */
function mapWorkRecapSeed(recapInput, opts = {}) {
  if (!pathwayEnabled(opts.config, 'work_recap')) refuseDisabled('work_recap');
  if (!recapInput || typeof recapInput !== 'object') {
    throw new Error('mapWorkRecapSeed: a redacted work-recap item object is required');
  }
  // Accept either the simple recap shape or the work-recap source seed (build-seed.js).
  const recap = normalizeRecap(recapInput);
  const slot = opts.slot;
  if (!slot || typeof slot !== 'object' || !slot.slot_id) {
    throw new Error('mapWorkRecapSeed: a calendar slot (with slot_id) is required — recaps fill calendar slots, never out-of-calendar');
  }
  // The operator/founder/team account is a brand entry with account_class=operator (§6.4/§11.3,
  // brand-keyed from day one). The brief.schema requires `brand`, so the slot MUST name it.
  if (!slot.brand) {
    throw new Error('mapWorkRecapSeed: slot.brand is required — the operator/founder/team account is registered as a brand with account_class=operator (§3.3/§6.4)');
  }

  const shipped = cleanList(recap.shipped);
  const learned = cleanList(recap.learned);
  const next = cleanList(recap.next);
  const highlight = clean(recap.highlight);

  if (!shipped.length && !learned.length && !next.length && !highlight) {
    throw new Error('mapWorkRecapSeed: the recap has no shippable substance (need at least one of shipped/learned/next/highlight after redaction)');
  }

  const denySet = privacyDenySet(recap, opts.config);
  // The writer's "do not say" list = the privacy deny-set + the build-in-public anti-hype rules.
  const mustNotInclude = uniq([
    ...denySet.map((t) => `the sensitive term "${t}" (privacy: do not surface)`),
    'unreleased partner names, codenames, or roadmap specifics not in the recap',
    'secrets, credentials, internal IDs, or file paths',
    'hype-inflation or vague "big things coming" filler (rule.core.humanizer)',
    'fabricated metrics — only numbers present in the recap',
  ]);

  // The core angle: the strongest concrete thing from the recap, framed as work-in-the-open.
  const anchor = highlight || shipped[0] || learned[0] || next[0];
  const angle = `Share the work in the open from a founder/operator POV: ${anchor}`;

  const content_id = opts.content_id || `${slot.slot_id}-recap`;

  // The schema-conformant brief (brief.schema.json, additionalProperties:false). Slot/source/
  // privacy-provenance extras live on the envelope below, NOT on the brief.
  const brief = withSchemaBrief({
    content_id,
    brand: slot.brand,
    platform: slot.platform,
    format: slot.format,
    mode: opts.mode,
    slot_ref: slot.slot_id,
    archetype: slot.archetype || 'build-in-public',
    pillar: 'build-in-public',
    pre_seed: {
      angle: clean(angle),
      hook_direction: 'Open on one concrete, specific thing that happened — a real detail, not a status-update cliche.',
      must_include: shipped.length ? [`at least one specific, concrete detail (e.g. ${shipped[0]})`] : ['one concrete, specific detail from the recap'],
      must_not_include: mustNotInclude,
      tone: 'authentic, specific, plain-spoken founder/operator voice (§3.3 flexible voice); honest, not promotional',
    },
    framework_ref: FRAMEWORK_REF.BUILD_IN_PUBLIC,
    enrichment: {
      summary: clean(angle),
      proof_stack: {
        primary: shipped.length ? shipped : (highlight ? [highlight] : learned),
        supporting: uniq([...learned, ...next]),
        // fact_safety doubles as the gate's privacy/leak check input (rule.core.claims-safety):
        // the explicit set of things the draft MUST NOT say, BEFORE the approval card.
        fact_safety: uniq([
          ...denySet,
          'no claim, number, or named entity that is not present in the recap',
          'no unreleased detail, partner name, or codename',
        ]),
      },
      core_tension: 'The honest middle of building — real progress and real open problems, not a victory lap.',
      reader_takeaway: highlight ? clean(highlight) : 'a real, specific look at what is actually being built',
      humanizer_notes: [
        'specific beats grand: one true detail outperforms ten adjectives',
        'no hype-inflation, no "not just X but Y", no generic positive closer (rule.core.humanizer)',
        'it should read like a person who did the work, not a brand announcement',
      ],
    },
  });

  // The slot-run envelope the orchestrator dispatches. Privacy provenance (the leak-check evidence)
  // and the operator account class live HERE, off the schema brief.
  const seed = {
    source: SOURCE.WORK_RECAP,
    slot_type: 'regular',
    content_form: CONTENT_FORM.STANDALONE,
    content_id,
    brand: slot.brand || null,
    platform: slot.platform || null,
    format: slot.format || null,
    slot_ref: slot.slot_id,
    account_class: recap.account_class || 'operator',
    pre_seed: brief.pre_seed,
    provenance: {
      // Operator-provided trusted input distilled from SENSITIVE memory: the privacy pre-pass +
      // gate privacy check are mandatory (see module header). Trust-zone O after redaction; the
      // forbidden set still travels so the gate enforces it.
      trust_zone: 'O',
      source: SOURCE.WORK_RECAP,
      privacy_checked: true,
      private_terms_count: denySet.length,
      private_terms: denySet,
      memory_source_ref: opts.memory_source_ref || null,
      period: recap.period || null,
    },
    brief,
  };
  if (opts.mode) seed.mode = opts.mode;
  if (opts.account_ref) seed.account_ref = opts.account_ref;
  return seed;
}

// ---------------------------------------------------------------------------
// Dispatcher — one entry point that routes by source kind (the exported API)
// ---------------------------------------------------------------------------

/**
 * Map any supported source item → a brief seed. Routes by `source`:
 *   - SOURCE.TREND      → mapTrendSeed(item, opts)
 *   - SOURCE.WORK_RECAP → mapWorkRecapSeed(item, opts)
 * Both honor the per-pathway config gate (fail-closed) and produce a brief.schema.json-shaped
 * seed that the matcher consumes. NOTHING here publishes or bypasses the gate/approval card.
 *
 * @param {string} source  SOURCE.TREND | SOURCE.WORK_RECAP
 * @param {object} item    the trend report or redacted work-recap item
 * @param {object} opts    per-source mapping options (slot, config, …)
 * @returns {object} a brief seed
 */
function mapSeed(source, item, opts = {}) {
  switch (source) {
    case SOURCE.TREND:
      return mapTrendSeed(item, opts);
    case SOURCE.WORK_RECAP:
      return mapWorkRecapSeed(item, opts);
    default:
      throw new Error(`mapSeed: unknown content source "${source}" (expected one of: ${Object.values(SOURCE).join(', ')})`);
  }
}

module.exports = {
  // vocabulary
  SOURCE,
  CONTENT_FORM,
  FRAMEWORK_REF,
  // the seed-mapping API
  mapSeed,
  mapTrendSeed,
  mapWorkRecapSeed,
  // helpers (exported for tests / sibling source adapters)
  pathwayEnabled,
  privacyDenySet,
  coerceDenyList,
  summarizeTrend,
  withSchemaBrief,
};
