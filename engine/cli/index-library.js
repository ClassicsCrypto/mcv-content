'use strict';

/**
 * engine/cli/index-library.js  [A adapted — the real verb, replacing the LIB-CORE thin stub]
 *
 * `engine index-library` — the content-library asset-management entry point (release-spec §1.5
 * asset management; original-design-spec §1.5 "Auto-Indexing / Folder Sorting / Character Sheets";
 * §2.6 step 3 / C4 library checkpoint; §15.4 / §11.2 budget pre-run estimate; §12.5 vision +
 * image-gen provider seams; DD-18 estimate-and-confirm; DD-21 empty-library mode).
 *
 * This is the THIN CLI wiring over the stage-1 library modules — it never re-implements scanning,
 * the vision call, the folder-sort, or the image-gen call. It parses flags, picks ONE sub-action,
 * runs the corresponding library module, and prints a uniform envelope:
 *
 *   (default / --estimate-only / --yes / --force / --no-hash)  → engine/library/indexer.js
 *     The metered AUTO-INDEX path. DD-18: without --yes it HALTS with the cost estimate and indexes
 *     nothing; --estimate-only prints the band and exits; --yes confirms + indexes; --force
 *     re-indexes; --no-hash fingerprints by path+size+mtime. Empty-library is a clean no-op (DD-21).
 *
 *   --organize [--apply]                                       → engine/library/organize.js
 *     The FOLDER-SORT path (Images / Videos / AI-generated). A pure FS reorganization — no spend —
 *     but still DRY-RUN by default for mutation safety; --apply (or --yes) performs the moves.
 *
 *   --character-sheets [--generate --yes [--apply]]            → engine/library/character-sheets.js
 *     The CHARACTER-SHEET path. Bare = DETECT (cheap, deterministic, zero-key): report which roster
 *     characters have/need sheets. --generate targets the missing ones; it is APPROVAL-GATED
 *     (--yes is the §1.5 "if approved" confirmation) and DRY-RUN until --apply (the metered image-gen
 *     call). Idempotent: an existing sheet is never re-generated.
 *
 * Default (no sub-action flags) = the auto-index estimate-and-confirm preface: show what WOULD be
 * indexed + the cost band, spend nothing (DD-18). Every metered action presents the estimate first.
 *
 * Honest exit codes (model §12; bin/engine.js contract): 0 success / refused-by-design (a DD-18
 * confirmation halt, an over-budget pause, a degrade-to-skip — the system behaving correctly,
 * surfaced honestly); 2 a usage/config error (bad flag combo); 3 ONLY when a genuine dependency is
 * absent (no vision provider configured for a confirmed index). A no-op empty-library is exit 0.
 *
 * --brand <id> scopes character-sheet roster + cost overrides to a brand's config layer when the
 * operator keys those per brand; absent, instance system.json is used. (Indexing + folder-sort are
 * instance-wide — the media library is not brand-partitioned in v1, §1.2 — so --brand is advisory
 * there and recorded in the envelope for traceability.)
 *
 * Tier-3 cleanliness (§0.3 r6): no hardcoded ids/paths/codenames; instance paths resolve via
 * shared/paths.js; the vision/image-gen model + credential live in the §12.5 provider config blocks,
 * never here.
 */

const util = require('./util');
const indexer = require('../library/indexer');
const organize = require('../library/organize');
const charSheets = require('../library/character-sheets');

const HELP = `engine index-library [options]

Manage the content library (release-spec §1.5; original-design-spec §1.5). Picks ONE sub-action:

AUTO-INDEX (default) — visual-tag assets through the §12.5 vision provider and write the archive
index retrieval consumes. Presents a pre-run cost estimate and REQUIRES confirmation before any
spend (DD-18). Incremental + idempotent: already-indexed assets are skipped and never re-billed.

  --yes              confirm the cost estimate and proceed with indexing (DD-18 confirmation).
  --estimate-only    print the cost estimate + item count and exit (no spend).
  --force            re-index every asset (a deliberate, confirmed re-spend).
  --no-hash          fingerprint by path+size+mtime instead of a content hash (faster scan).

FOLDER-SORT — sort media into Images / Videos / AI-generated template folders (no spend; pure FS).
  --organize         plan the folder-sort (DRY-RUN — changes nothing).
  --organize --apply perform the moves (mutation safety: dry-run is the default).

CHARACTER SHEETS — check the library for roster character sheets; generate missing ones if approved.
  --character-sheets                         detect present/missing sheets (cheap, zero-key).
  --character-sheets --generate              estimate + plan generation for missing (needs approval).
  --character-sheets --generate --yes        approve; DRY-RUN unless --apply (the metered image-gen).
  --character-sheets --generate --yes --apply  generate the missing sheets (spends — §12.5 image-gen).

Common:
  --brand <id>       scope roster/cost config to a brand (advisory for index/folder-sort, §1.2).
  --json             emit the structured result.
  -h, --help         show this help.

Empty-library mode (DD-21) is fully supported across every sub-action: with no media present each is
a clean no-op. Metered actions (index / sheet generation) never spend without an explicit confirm.`;

/** Load the effective config for the run: brand layer merged over instance system.json when --brand. */
function loadConfig(env, brand) {
  const sys = util.loadSystemConfig(env) || {};
  if (!brand) return sys;
  // Brand-scoped overlay: a brand may key its own character-sheet roster / cost block. We read the
  // brand config tolerantly (a missing brand file just falls back to the instance config) so the
  // verb never throws on an unknown --brand — it records the brand and uses what config exists.
  let brandCfg = {};
  try {
    // eslint-disable-next-line global-require
    const fs = require('fs');
    // eslint-disable-next-line global-require
    const paths = require('../shared/paths');
    brandCfg = JSON.parse(fs.readFileSync(paths.brandConfig(brand, env), 'utf8'));
  } catch {
    brandCfg = {};
  }
  // Shallow merge with brand winning for the blocks this verb consults.
  return {
    ...sys,
    ...brandCfg,
    character_sheets: { ...(sys.character_sheets || {}), ...(brandCfg.character_sheets || {}) },
    cost: { ...(sys.cost || {}), ...(brandCfg.cost || {}) },
    image_gen: brandCfg.image_gen || sys.image_gen || sys.imageGen || undefined,
  };
}

// ---------------------------------------------------------------------------
// Sub-action: FOLDER-SORT (--organize) — engine/library/organize.js
// ---------------------------------------------------------------------------

function runOrganize(env, flags, brand) {
  const apply = util.flagOn(flags.apply) || util.flagOn(flags.yes);
  const res = organize.organizeLibrary({ env, apply });
  const c = res.counts;
  const detail = [
    `library: ${res.libraryRoot}`,
    `scanned ${c.scanned} | ${apply ? 'moved' : 'to move'} ${apply ? c.moved : c.planned} | ` +
      `already-sorted ${c.already_sorted} | non-media ${c.non_media} | errors ${c.errors}`,
  ];
  if (c.index_updated) detail.push(`index entries ${apply ? 'updated' : 'to update'}: ${c.index_updated}`);
  for (const p of res.planned.slice(0, 12)) detail.push(`  ${p.from} → ${p.folder}/${p.to.split('/').pop()}`);
  if (res.planned.length > 12) detail.push(`  …and ${res.planned.length - 12} more`);
  for (const e of res.errors.slice(0, 5)) detail.push(`  error: ${e.path} — ${e.reason}`);
  if (!apply) detail.push('Re-run with --apply to perform the moves (DD-18 dry-run-by-default).');
  return {
    ok: res.errors.length === 0,
    // A dry-run with planned moves or an applied sort are both honest successes; errors don't change
    // the exit family (a single bad file is reported, not fatal) — surface them in the envelope.
    exitCode: 0,
    summary: res.summary,
    detail,
    data: { action: 'organize', brand: brand || null, ...res },
  };
}

// ---------------------------------------------------------------------------
// Sub-action: CHARACTER SHEETS (--character-sheets) — engine/library/character-sheets.js
// ---------------------------------------------------------------------------

function runCharacterSheets(env, flags, brand) {
  const config = loadConfig(env, brand);

  // DETECT (default for this sub-action): cheap, deterministic, zero-key.
  if (!util.flagOn(flags.generate)) {
    const det = charSheets.detectCharacterSheets({ env, config });
    const detail = [
      `roster: ${det.roster_size} | sheet assets in library: ${det.sheet_assets} | ` +
        `present: ${det.present.length} | missing: ${det.missing.length}`,
    ];
    if (det.note) detail.push(det.note);
    for (const m of det.missing.slice(0, 20)) detail.push(`  missing: ${m.name}`);
    if (det.missing.length > 20) detail.push(`  …and ${det.missing.length - 20} more`);
    if (det.missing.length > 0) {
      detail.push('Run with --generate --yes to generate the missing sheets (approval-gated, §1.5; DD-18).');
    }
    return {
      ok: true,
      summary:
        det.roster_size === 0
          ? `character-sheet detection: ${det.sheet_assets} sheet asset(s) in the library (no roster configured)`
          : `character-sheet detection: ${det.present.length}/${det.roster_size} present, ${det.missing.length} missing`,
      detail,
      data: { action: 'character-sheets', mode: 'detect', brand: brand || null, ...det },
    };
  }

  // GENERATE the missing sheets (metered, approval-gated). We detect first, then walk the missing
  // list through generateCharacterSheet — which itself enforces the idempotent skip, the
  // degrade-to-skip when no image-gen provider is configured, the DD-18 approval+estimate halt, and
  // the dry-run-until-apply contract. We only translate flags → its opts and aggregate the results.
  const det = charSheets.detectCharacterSheets({ env, config });
  if (det.missing.length === 0) {
    return {
      ok: true,
      summary: 'all roster characters already have sheets — nothing to generate (idempotent, no spend)',
      detail: [det.note || `present: ${det.present.length}/${det.roster_size}`],
      data: { action: 'character-sheets', mode: 'generate', brand: brand || null, generated: [], skipped: [], missing: [] },
    };
  }

  const approve = util.flagOn(flags.yes);
  const apply = util.flagOn(flags.apply);
  const est = charSheets.estimate(det.missing.length, config);

  // DD-18: without approval, HALT with the cost estimate for the WHOLE missing batch (the §1.5
  // "if approved" gate) — generate nothing.
  if (!approve) {
    return {
      ok: false,
      exitCode: 0,
      summary: `character-sheet generation requires approval: ${det.missing.length} sheet(s) ≈ $${est.estimated_total_usd.low}–$${est.estimated_total_usd.high} (indicative)`,
      detail: [
        est.note,
        `Would generate sheets for: ${det.missing.map((m) => m.name).join(', ')}.`,
        'Re-run with --generate --yes to approve (DRY-RUN unless --apply); §1.5 "if approved", DD-18.',
      ],
      data: {
        action: 'character-sheets', mode: 'generate', brand: brand || null,
        awaiting_approval: true, estimate: est, missing: det.missing,
      },
    };
  }

  // Approved: per-character, drive generateCharacterSheet. With --apply it spends (the real or an
  // injected provider); without --apply it is a dry-run plan. The module guards each transition.
  const generated = [];
  const skipped = [];
  const failed = [];
  for (const m of det.missing) {
    const r = charSheets.generateCharacterSheet({
      character: m.name,
      config,
      index: det.sheets ? undefined : undefined, // re-detected inside per-call (idempotent check)
      env,
      approve: true,
      apply,
    });
    if (r.skipped) skipped.push({ character: m.name, reason: r.summary });
    else if (r.ok) generated.push({ character: m.name, dry_run: Boolean(r.dry_run), data: r.data });
    else failed.push({ character: m.name, reason: r.summary, detail: r.detail });
  }

  const dryRun = !apply;
  const detail = [est.note];
  if (dryRun) detail.push('[dry-run] approved — re-run with --apply to spend on image generation (DD-18).');
  for (const g of generated) detail.push(`  ${dryRun ? 'would generate' : 'generated'}: ${g.character}`);
  for (const s of skipped) detail.push(`  skipped: ${s.character} — ${s.reason}`);
  for (const f of failed) detail.push(`  FAILED: ${f.character} — ${f.reason}`);

  // If every missing character degraded-to-skip (no provider), that is an honest no-op success (the
  // skip already explains the missing §12.5 image-gen provider) — not a hard failure.
  const allSkipped = generated.length === 0 && failed.length === 0 && skipped.length > 0;
  return {
    ok: failed.length === 0,
    exitCode: 0,
    summary:
      `character-sheet generation${dryRun ? ' [dry-run]' : ''}: ` +
      `${generated.length} ${dryRun ? 'planned' : 'generated'}, ${skipped.length} skipped` +
      (failed.length ? `, ${failed.length} failed` : '') +
      (allSkipped ? ' (no image-gen provider configured — §12.5)' : ''),
    detail,
    data: {
      action: 'character-sheets', mode: 'generate', brand: brand || null,
      dry_run: dryRun, estimate: est, generated, skipped, failed,
    },
  };
}

// ---------------------------------------------------------------------------
// Sub-action: AUTO-INDEX (default) — engine/library/indexer.js
// ---------------------------------------------------------------------------

async function runIndex(env, flags, brand) {
  const result = await indexer.buildLibraryIndex({
    env,
    yes: util.flagOn(flags.yes),
    estimateOnly: util.flagOn(flags['estimate-only']),
    force: util.flagOn(flags.force),
    hash: !util.flagOn(flags['no-hash']),
  });

  const est = result.estimate || {};
  const total = est.estimated_total_usd || {};
  const detailHead = [
    est.note,
    `scanned: ${est.total_scanned ?? '?'} | already indexed: ${est.already_indexed ?? '?'} | to index: ${est.asset_count ?? '?'}`,
  ].filter(Boolean);
  const withBrand = (data) => ({ action: 'index', brand: brand || null, ...data });

  // Awaiting confirmation: the DD-18 halt — not an error, exit 0 so the agent re-invokes with --yes.
  if (result.awaiting_confirmation) {
    return {
      ok: false,
      exitCode: 0,
      summary: result.summary,
      detail: [...detailHead, 'Re-run with --yes to confirm and proceed (DD-18 estimate-and-confirm — §15.4).'],
      data: withBrand(result),
    };
  }

  // Estimate-only / empty-library / up-to-date / indexed: all are OK envelopes.
  if (result.ok || result.status === 'estimate-only') {
    const extra = [];
    if (result.status === 'estimate-only') {
      extra.push(`estimated total: $${total.low ?? '?'}–$${total.high ?? '?'} (indicative)`);
      extra.push('Re-run with --yes to confirm and index (DD-18).');
    }
    if (result.failed && result.failed.length) {
      for (const f of result.failed.slice(0, 10)) extra.push(`failed: ${f.path} — ${f.error}`);
      if (result.failed.length > 10) extra.push(`…and ${result.failed.length - 10} more (retry next run).`);
    }
    return {
      ok: true,
      summary: result.summary,
      detail: [...detailHead, ...extra],
      data: withBrand(result),
    };
  }

  // no-provider is a genuine missing dependency (exit 3 per the bin/engine.js contract); any other
  // non-ok status is a verb-level failure (exit 1).
  return {
    ok: false,
    exitCode: result.status === 'no-provider' ? 3 : 1,
    summary: result.summary,
    detail: detailHead,
    data: withBrand(result),
  };
}

/**
 * @param {object} ctx  { flags, positionals, env }
 * @returns {Promise<{ ok, summary, detail?, data?, exitCode? }>}
 */
async function run(ctx = {}) {
  const flags = ctx.flags || {};
  if (util.flagOn(flags.help)) return { ok: true, summary: HELP.split('\n')[0], detail: HELP };

  const env = ctx.env || process.env;
  const brand = typeof flags.brand === 'string' && flags.brand.trim() ? flags.brand.trim() : null;

  // Exactly ONE sub-action. organize and character-sheets are mutually exclusive with each other and
  // with the index path; reject a contradictory combination rather than silently picking one (§6.1).
  const wantOrganize = util.flagOn(flags.organize);
  const wantSheets = util.flagOn(flags['character-sheets']);
  if (wantOrganize && wantSheets) {
    return {
      ok: false,
      exitCode: 2,
      summary: 'pick ONE sub-action: --organize OR --character-sheets (not both)',
      detail: ['Run the folder-sort and the character-sheet pass as separate invocations.'],
    };
  }

  if (wantOrganize) return runOrganize(env, flags, brand);
  if (wantSheets) return runCharacterSheets(env, flags, brand);
  return runIndex(env, flags, brand);
}

module.exports = { run, HELP, loadConfig };
