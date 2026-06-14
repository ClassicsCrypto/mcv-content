'use strict';

/**
 * engine/cli/purge-corpora.js  [N net-new]
 *
 * `engine purge-corpora` — the retention purge (release-spec §11.2 `retention` block; RD-9 data
 * policy; §18.2(3) scraped corpora never leave the instance). The operator is the data controller
 * (RD-9); this verb enforces the corpus retention windows by `retention_class` over the ingested
 * corpora under $CONTENT_HOME/corpora/<brand>/ — purging eligible items, never touching anything
 * outside CONTENT_HOME (RD-3). It is the command the §11.2 `purge_schedule` recipe runs on cadence.
 *
 * Retention model (RD-9 / corpus-item.schema.json `retention_class`):
 *   - `transient`  — shortest window: purged once older than transient_days (default 7).
 *   - `standard`   — purged once older than config retention.raw_corpus_days (default 90).
 *   - `retained`   — NEVER auto-purged (operator-curated keepers; explicit deletion only).
 * An item with no/invalid retention_class is treated conservatively as `standard` (it ages out on
 * the default window) — never as `retained` (we do not silently keep untagged scraped data).
 * Eligibility is by `captured_at` age; an item missing a parseable timestamp is left in place and
 * reported (we never purge on a guess).
 *
 * Safety: DRY-RUN by default (reports what WOULD be purged) — `--apply` performs the deletion.
 * Deletion uses fs.rm (recoverable-beats-permanent is the operator's backup discipline; the engine
 * does not ship a trash, but the dry-run-first default is the guard). Honors --brand to scope to
 * one brand. Tolerant: a missing corpora dir / unreadable file is reported, never fatal.
 *
 * Tier-3 cleanliness (§0.3 r6): paths via paths.js; no hardcoded ids/paths/codenames.
 */

const fs = require('fs');
const path = require('path');

const paths = require('../shared/paths');
const util = require('./util');

/** Default windows (days). `standard` reads config retention.raw_corpus_days (§11.2 default 90). */
const DEFAULT_TRANSIENT_DAYS = 7;
const DEFAULT_STANDARD_DAYS = 90;

const HELP = `engine purge-corpora [options]

Enforce corpus retention windows by retention_class (RD-9 / §11.2). DRY-RUN by default — reports
what would be purged; pass --apply to delete. Scoped to $CONTENT_HOME/corpora (RD-3) — never
touches anything outside CONTENT_HOME. The operator is the data controller (RD-9).

  --apply          actually delete eligible items (default: dry-run report only).
  --brand <id>     restrict to one brand's corpora.
  --json           emit the structured result.
  -h, --help       show this help.

retention_class: transient (purged after transient_days, default 7) · standard (config
retention.raw_corpus_days, default 90) · retained (never auto-purged). Untagged items age out on
the standard window (never kept silently).`;

function daysFor(retentionClass, config) {
  const r = (config && config.retention) || {};
  switch (retentionClass) {
    case 'transient': return Number(r.transient_days) > 0 ? Number(r.transient_days) : DEFAULT_TRANSIENT_DAYS;
    case 'retained': return Infinity; // never auto-purged
    case 'standard':
    default: return Number(r.raw_corpus_days) >= 0 ? Number(r.raw_corpus_days) : DEFAULT_STANDARD_DAYS;
  }
}

function ageDays(capturedAt, now) {
  const t = Date.parse(capturedAt || '');
  if (!Number.isFinite(t)) return null;
  return (now - t) / 86400000;
}

/** List brand dirs under corpora/ (optionally scoped to one). */
function brandDirs(env, only) {
  let base;
  try { base = paths.corporaDir(env); } catch { return { base: null, brands: [] }; }
  let names = [];
  try { names = fs.readdirSync(base).filter((n) => fs.statSync(path.join(base, n)).isDirectory()); } catch { names = []; }
  if (only) names = names.filter((n) => n === only);
  return { base, brands: names };
}

/**
 * @param {object} ctx  { flags, env, config }
 * @returns {{ ok, summary, detail?, data?, exitCode? }}
 */
function run(ctx = {}) {
  const flags = ctx.flags || {};
  if (util.flagOn(flags.help)) return { ok: true, summary: HELP.split('\n')[0], detail: HELP };

  const env = ctx.env || process.env;
  const config = ctx.config || util.loadSystemConfig(env);
  const apply = util.flagOn(flags.apply);
  const only = typeof flags.brand === 'string' ? flags.brand : null;
  const now = Date.now();

  const { base, brands } = brandDirs(env, only);
  if (!base) {
    return { ok: false, exitCode: 1, summary: 'purge-corpora needs CONTENT_HOME', detail: 'Set CONTENT_HOME (run `engine init --home <path>`).' };
  }

  const eligible = [];
  const kept = { retained: 0, within_window: 0, untimed: 0 };
  let scanned = 0;

  for (const brand of brands) {
    const dir = path.join(base, brand);
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { files = []; }
    for (const f of files) {
      scanned += 1;
      const file = path.join(dir, f);
      let item;
      try { item = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { item = null; }
      const cls = item && ['transient', 'standard', 'retained'].includes(item.retention_class) ? item.retention_class : 'standard';
      const windowDays = daysFor(cls, config);
      if (windowDays === Infinity) { kept.retained += 1; continue; }
      const age = ageDays(item && item.captured_at, now);
      if (age == null) { kept.untimed += 1; continue; } // never purge on a guess
      if (age >= windowDays) {
        eligible.push({ brand, file: `${brand}/${f}`, retention_class: cls, age_days: Math.round(age), window_days: windowDays, abs: file });
      } else {
        kept.within_window += 1;
      }
    }
  }

  let purged = 0;
  const errors = [];
  if (apply) {
    for (const e of eligible) {
      try { fs.rmSync(e.abs, { force: true }); purged += 1; }
      catch (err) { errors.push({ file: e.file, error: err.message }); }
    }
  }

  return {
    ok: errors.length === 0,
    summary: apply
      ? `purged ${purged}/${eligible.length} eligible corpus item(s) (scanned ${scanned}; ${kept.retained} retained, ${kept.within_window} within window, ${kept.untimed} untimed)`
      : `${eligible.length} corpus item(s) eligible for purge (DRY-RUN; scanned ${scanned}). Re-run with --apply to delete.`,
    detail: [
      ...eligible.map((e) => `  ${apply ? '-' : '·'} ${e.file} [${e.retention_class}] age ${e.age_days}d ≥ window ${e.window_days}d`),
      kept.retained ? `kept (retained, never auto-purged): ${kept.retained}` : null,
      kept.untimed ? `kept (no parseable captured_at — never purged on a guess): ${kept.untimed}` : null,
      ...errors.map((e) => `  ! ${e.file}: ${e.error}`),
    ].filter(Boolean),
    data: { apply, scanned, eligible, purged, kept, errors },
  };
}

module.exports = { run, HELP };
