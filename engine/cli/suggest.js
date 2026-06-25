'use strict';

/**
 * engine/cli/suggest.js  [N net-new — the FREE manual-Grok suggestion path]
 *
 * `engine suggest` — the zero-cost alternative to an LLM suggestion API: it (1) hands the operator a
 * ready-to-paste Grok prompt for a suggestion task, and (2) parses the pasted result back into
 * CONFIRMED config (competitors / tracked accounts / keywords). The operator runs the prompt on their
 * own Grok/X account (free, live X data); the engine never calls a paid API for this.
 *
 *   engine suggest prompt <kind>            print the Grok prompt for <kind> to copy-paste.
 *   engine suggest apply --file <path>      parse a pasted result file → PROPOSAL (dry-run).
 *   engine suggest apply --file <path> --yes   confirm + write the additions into config.
 *     (omit --file to read the pasted text from stdin.)
 *
 * kinds: competitors | tracked_accounts | keywords | breakout.
 *
 * GOVERNANCE: suggestions are advisory and Zone-U (a model produced them). Nothing is added to config
 * without an explicit `--yes` (dry-run is the default); additions are APPEND + DEDUP (never remove an
 * operator's existing entries); competitors are brand-scoped (--brand). This is the "suggest →
 * operator confirms/edits" pattern — the engine proposes, the human decides.
 */

const fs = require('fs');
const path = require('path');

const util = require('./util');
const paths = require('../shared/paths');
const { parseSuggestions, VALID_KINDS } = require('../sources/suggestions/parse');

const KIND_TEMPLATE = Object.freeze({
  competitors: 'competitors.md',
  tracked_accounts: 'tracked-accounts.md',
  keywords: 'keywords.md',
  breakout: 'breakout-discovery.md',
});

const HELP = `engine suggest <prompt|apply> [options]

The FREE manual-Grok suggestion path — run a prompt on your own Grok/X account (no API spend), then
paste the result back for the engine to turn into CONFIRMED config.

  engine suggest prompt <kind>             print the Grok prompt for <kind> to copy-paste.
  engine suggest apply --file <path>       parse a pasted result → PROPOSAL (dry-run, writes nothing).
  engine suggest apply --file <path> --yes confirm + APPEND the additions into config (dedup).
                                           (omit --file to read the pasted text from stdin.)

kinds: ${[...VALID_KINDS].join(' | ')}
  competitors       ≥5 comparator/competitor accounts (brand-scoped — pass --brand).
  tracked_accounts  accounts to track each trend pass (competitors + industry creators).
  keywords          keywords/hashtags to track each trend pass.
  breakout          monthly: new competitors + breakout keywords.

  --brand <id>   brand to scope competitor/breakout-account additions to (required for those).
  --json         emit the structured result.
  -h, --help     show this help.

Suggestions are advisory (Zone-U): nothing is written without --yes, and additions only APPEND +
DEDUP — your existing config is never removed.`;

/** Read a Grok prompt template from templates/grok-prompts/. */
function readPromptTemplate(kind) {
  const file = KIND_TEMPLATE[kind];
  if (!file) return null;
  try {
    return fs.readFileSync(path.resolve(__dirname, '..', '..', 'templates', 'grok-prompts', file), 'utf8');
  } catch {
    return null;
  }
}

/** Atomic JSON write (tmp + rename) so a crash never leaves a half-written config. */
function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

function readJsonIfExists(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** Append new strings to an array, deduped case-insensitively; returns { merged, added }. */
function appendDedup(existing, additions) {
  const out = Array.isArray(existing) ? [...existing] : [];
  const seen = new Set(out.map((s) => String(s).toLowerCase()));
  const added = [];
  for (const a of additions) {
    const key = String(a).toLowerCase();
    if (!seen.has(key)) { seen.add(key); out.push(a); added.push(a); }
  }
  return { merged: out, added };
}

/** Read the pasted text from --file or stdin. */
function readPastedText(flags) {
  if (typeof flags.file === 'string' && flags.file.trim()) {
    return fs.readFileSync(flags.file.trim(), 'utf8');
  }
  try {
    return fs.readFileSync(0, 'utf8'); // stdin
  } catch {
    return '';
  }
}

/** Apply tracked_accounts/keywords into system.json trends (append+dedup). */
function applyToSystemTrends(env, { accounts = [], keywords = [] }, write) {
  const file = paths.systemConfig(env);
  const sys = readJsonIfExists(file) || {};
  sys.trends = (sys.trends && typeof sys.trends === 'object') ? sys.trends : {};
  const a = appendDedup(sys.trends.tracked_accounts, accounts);
  const k = appendDedup(sys.trends.keywords, keywords);
  if (write) {
    sys.trends.tracked_accounts = a.merged;
    sys.trends.keywords = k.merged;
    writeJsonAtomic(file, sys);
  }
  return { added_accounts: a.added, added_keywords: k.added, target: 'config/system.json → trends' };
}

/** Apply competitor handles into brand.json ingestion.competitors (append+dedup by handle). */
function applyToBrandCompetitors(env, brand, items, write) {
  const file = paths.brandConfig(brand, env);
  const cfg = readJsonIfExists(file);
  if (!cfg) return { error: `brand.json not found for "${brand}" — register the brand first (engine setup / C2).` };
  cfg.ingestion = (cfg.ingestion && typeof cfg.ingestion === 'object') ? cfg.ingestion : {};
  const existing = Array.isArray(cfg.ingestion.competitors) ? cfg.ingestion.competitors : [];
  const have = new Set();
  for (const c of existing) for (const h of (c && Array.isArray(c.handles) ? c.handles : [])) {
    if (h && typeof h.handle === 'string') have.add(h.handle.toLowerCase().replace(/^@+/, ''));
  }
  const added = [];
  const next = [...existing];
  for (const item of items) {
    if (!item.handle) continue;
    const bare = item.handle.toLowerCase().replace(/^@+/, '');
    if (have.has(bare)) continue;
    have.add(bare);
    const entry = { name: item.name || item.handle, handles: [{ handle: item.handle }] };
    next.push(entry);
    added.push(item.handle);
  }
  if (write && added.length) {
    cfg.ingestion.competitors = next;
    writeJsonAtomic(file, cfg);
  }
  return { added_competitors: added, target: `brands/${brand}/brand.json → ingestion.competitors` };
}

/** The `prompt` subcommand: print the Grok prompt for a kind. */
function runPrompt(kind) {
  if (!kind) {
    return { ok: false, exitCode: 2, summary: 'usage: engine suggest prompt <kind>', detail: [`kinds: ${[...VALID_KINDS].join(' | ')}`] };
  }
  if (!VALID_KINDS.has(kind)) {
    return { ok: false, exitCode: 2, summary: `unknown kind "${kind}"`, detail: [`kinds: ${[...VALID_KINDS].join(' | ')}`] };
  }
  const tpl = readPromptTemplate(kind);
  if (!tpl) return { ok: false, exitCode: 1, summary: `prompt template for "${kind}" not found`, detail: ['Expected templates/grok-prompts/<kind>.md.'] };
  return {
    ok: true,
    summary: `Grok prompt for "${kind}" — copy everything below, fill the <PLACEHOLDERS>, run it on grok.com or X, then paste the result into \`engine suggest apply\`.`,
    detail: ['', tpl],
    data: { kind, prompt: tpl },
  };
}

/** The `apply` subcommand: parse a pasted result → proposal (or apply with --yes). */
function runApply(env, flags) {
  const text = readPastedText(flags);
  if (!text || !text.trim()) {
    return { ok: false, exitCode: 2, summary: 'no input — pass --file <path> or pipe the pasted text on stdin', detail: [] };
  }
  const parsed = parseSuggestions(text);
  if (!parsed.ok) {
    return { ok: false, exitCode: 1, summary: 'could not parse the pasted suggestions', detail: parsed.errors.map((e) => `  ✗ ${e}`) };
  }

  const kind = parsed.set.kind;
  const brand = (typeof flags.brand === 'string' && flags.brand.trim()) ? flags.brand.trim() : (parsed.set.brand || null);
  const apply = util.flagOn(flags.yes);
  const results = [];
  const detail = [`parsed ${parsed.items.length} item(s) (kind: ${kind})${parsed.handles.length ? `; ${parsed.handles.length} handle(s)` : ''}${parsed.terms.length ? `; ${parsed.terms.length} term(s)` : ''}.`];

  // Route by kind.
  if (kind === 'keywords') {
    results.push(applyToSystemTrends(env, { keywords: parsed.terms }, apply));
  } else if (kind === 'tracked_accounts') {
    results.push(applyToSystemTrends(env, { accounts: parsed.handles }, apply));
  } else if (kind === 'competitors') {
    if (!brand) return { ok: false, exitCode: 2, summary: 'competitor suggestions are brand-scoped — pass --brand <id>', detail };
    results.push(applyToBrandCompetitors(env, brand, parsed.items, apply));
  } else if (kind === 'breakout') {
    // breakout = new competitors (handles) + breakout keywords (terms).
    if (parsed.terms.length) results.push(applyToSystemTrends(env, { keywords: parsed.terms }, apply));
    if (parsed.handles.length) {
      if (!brand) detail.push('  ~ breakout handles need --brand to add as competitors; skipped the handles (keywords still apply).');
      else results.push(applyToBrandCompetitors(env, brand, parsed.items.filter((i) => i.handle), apply));
    }
  }

  for (const r of results) {
    if (r.error) { detail.push(`  ✗ ${r.error}`); continue; }
    const adds = [];
    if (r.added_accounts) adds.push(`accounts: ${r.added_accounts.length ? r.added_accounts.join(', ') : '(none new)'}`);
    if (r.added_keywords) adds.push(`keywords: ${r.added_keywords.length ? r.added_keywords.join(', ') : '(none new)'}`);
    if (r.added_competitors) adds.push(`competitors: ${r.added_competitors.length ? r.added_competitors.join(', ') : '(none new)'}`);
    detail.push(`  ${apply ? '✓ wrote' : '· would add'} → ${r.target}: ${adds.join(' | ')}`);
  }
  const anyError = results.some((r) => r.error);
  if (!apply) detail.push('Re-run with --yes to confirm and APPEND these to your config (dedup; nothing is removed).');

  return {
    ok: !anyError,
    exitCode: anyError ? 1 : 0,
    summary: `suggest apply (${kind}): ${apply ? 'applied' : 'dry-run'} — ${parsed.items.length} item(s)${anyError ? ' (with errors)' : ''}`,
    detail,
    data: { kind, brand, applied: apply, parsed: { handles: parsed.handles, terms: parsed.terms, items: parsed.items }, results },
  };
}

/**
 * @param {object} ctx  { flags, positionals, env }
 * @returns {{ ok, summary, detail?, data?, exitCode? }}
 */
function run(ctx = {}) {
  const flags = ctx.flags || {};
  if (util.flagOn(flags.help)) return { ok: true, summary: HELP.split('\n')[0], detail: HELP };
  const env = ctx.env || process.env;
  const positionals = ctx.positionals || [];
  const sub = positionals[0];

  if (sub === 'prompt') return runPrompt(positionals[1]);
  if (sub === 'apply') return runApply(env, flags);
  return { ok: false, exitCode: 2, summary: 'usage: engine suggest <prompt|apply> …', detail: HELP.split('\n') };
}

module.exports = { run, HELP, readPromptTemplate, appendDedup };
