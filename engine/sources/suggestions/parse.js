'use strict';

/**
 * engine/sources/suggestions/parse.js  [N net-new — manual-Grok paste-back parser]
 *
 * Parses the FREE manual-Grok suggestion path: the operator runs a shipped prompt
 * (templates/grok-prompts/) on their own Grok/X account and pastes the result back; this extracts the
 * `oce-suggestions` block out of that pasted text and validates it into a clean suggestion set
 * (schemas/inputs/suggestion-set.schema.json shape). No spend, no network, no LLM call here — just
 * deterministic extraction + validation so a malformed paste fails LOUDLY instead of half-applying.
 *
 * Extraction is tolerant of how a model/operator pastes:
 *   1. a fenced ```oce-suggestions … ``` block (the format the prompts ask for), or
 *   2. any fenced ```json … ``` / ``` … ``` block whose JSON has a `kind`, or
 *   3. a bare JSON object in the text whose JSON has a `kind`.
 * The CONTENT is Zone-U (a model produced it) — it only ever configures tracking/analysis targets,
 * never rules; the caller treats every value as untrusted (handles/keywords, not code).
 */

const FENCE_TAG = 'oce-suggestions';
const VALID_KINDS = Object.freeze(new Set(['competitors', 'tracked_accounts', 'keywords', 'breakout']));
const ITEM_KEYS = Object.freeze(new Set(['handle', 'term', 'name', 'category', 'why', 'signal']));

/**
 * Pull the candidate JSON text out of a pasted blob. Returns the raw JSON string, or null.
 */
function extractJsonText(text) {
  const s = String(text == null ? '' : text);

  // 1. The exact fenced block the prompts request.
  const tagged = s.match(/```(?:oce-suggestions)\s*\n([\s\S]*?)```/i);
  if (tagged) return tagged[1].trim();

  // 2. Any fenced block whose body parses to an object with a `kind`.
  const fenceRe = /```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)```/g;
  let m;
  while ((m = fenceRe.exec(s)) !== null) {
    const body = m[1].trim();
    if (looksLikeSet(body)) return body;
  }

  // 3. A bare {...} object in the text whose JSON has a `kind`.
  const firstBrace = s.indexOf('{');
  const lastBrace = s.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const body = s.slice(firstBrace, lastBrace + 1);
    if (looksLikeSet(body)) return body;
  }
  return null;
}

/** Cheap pre-check: does this text parse to an object carrying a `kind`? */
function looksLikeSet(body) {
  try {
    const o = JSON.parse(body);
    return o && typeof o === 'object' && typeof o.kind === 'string';
  } catch {
    return false;
  }
}

/**
 * Validate a parsed suggestion-set object against the schema shape (structural; the CI strict gate is
 * scripts/validate-schemas.js). Returns a list of problems (empty when valid).
 */
function validateSet(set) {
  const errs = [];
  if (!set || typeof set !== 'object' || Array.isArray(set)) return ['suggestion set is not an object'];
  for (const k of Object.keys(set)) {
    if (!['kind', 'brand', 'generated_at', 'note', 'items'].includes(k)) errs.push(`unexpected top-level key "${k}"`);
  }
  if (!VALID_KINDS.has(set.kind)) errs.push(`kind must be one of ${[...VALID_KINDS].join(', ')} (got ${JSON.stringify(set.kind)})`);
  if (!Array.isArray(set.items) || set.items.length < 1) {
    errs.push('items must be a non-empty array');
    return errs;
  }
  set.items.forEach((item, i) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      errs.push(`items[${i}] is not an object`);
      return;
    }
    for (const k of Object.keys(item)) {
      if (!ITEM_KEYS.has(k)) errs.push(`items[${i}] has unexpected key "${k}"`);
      else if (item[k] != null && typeof item[k] !== 'string') errs.push(`items[${i}].${k} must be a string`);
    }
    const hasHandle = typeof item.handle === 'string' && item.handle.trim();
    const hasTerm = typeof item.term === 'string' && item.term.trim();
    if (!hasHandle && !hasTerm) errs.push(`items[${i}] must carry a handle or a term`);
  });
  return errs;
}

/** Normalize a handle to a bare '@handle' (single leading @, trimmed). */
function normHandle(h) {
  const bare = String(h || '').trim().replace(/^@+/, '');
  return bare ? `@${bare}` : '';
}

/**
 * Parse pasted text into a clean suggestion set + the derived, deduped values the verb applies.
 *
 * @param {string} text  the pasted Grok output (or a file's contents).
 * @returns {{
 *   ok:boolean, errors:string[],
 *   set:(object|null),                  // the validated suggestion set (kind/items/…)
 *   handles:string[],                   // deduped @handles (competitors / tracked_accounts / breakout)
 *   terms:string[],                     // deduped keyword terms (keywords / breakout)
 *   items:Array<object>                 // the cleaned items (handle normalized)
 * }}
 */
function parseSuggestions(text) {
  const json = extractJsonText(text);
  if (json == null) {
    return { ok: false, errors: ['no oce-suggestions block found in the pasted text (expected a ```oce-suggestions fenced JSON block).'], set: null, handles: [], terms: [], items: [] };
  }
  let set;
  try {
    set = JSON.parse(json);
  } catch (e) {
    return { ok: false, errors: [`the suggestion block is not valid JSON: ${e.message}`], set: null, handles: [], terms: [], items: [] };
  }
  const problems = validateSet(set);
  if (problems.length) {
    return { ok: false, errors: problems, set: null, handles: [], terms: [], items: [] };
  }

  const handles = [];
  const terms = [];
  const seenH = new Set();
  const seenT = new Set();
  const items = [];
  for (const raw of set.items) {
    const item = {};
    if (raw.handle) item.handle = normHandle(raw.handle);
    if (raw.term) item.term = String(raw.term).trim();
    for (const k of ['name', 'category', 'why', 'signal']) if (raw[k]) item[k] = String(raw[k]).trim();
    items.push(item);
    if (item.handle && !seenH.has(item.handle.toLowerCase())) { seenH.add(item.handle.toLowerCase()); handles.push(item.handle); }
    if (item.term && !seenT.has(item.term.toLowerCase())) { seenT.add(item.term.toLowerCase()); terms.push(item.term); }
  }

  return { ok: true, errors: [], set, handles, terms, items };
}

module.exports = {
  FENCE_TAG,
  VALID_KINDS,
  extractJsonText,
  validateSet,
  normHandle,
  parseSuggestions,
};
