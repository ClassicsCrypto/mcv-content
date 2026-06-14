'use strict';

/**
 * engine/library/character-sheets.js  [A adapted — ported from the production character-sheet estate]
 *
 * Character sheets (original-design-spec §1.5 "Character Sheets": *check the library for existing
 * character sheets; if none exist, trigger a script to automatically generate them — if approved*).
 * release-spec §1.5 asset management; §12.5 provider seam (mirrored for image generation); §15.4 /
 * DD-18 estimate-and-confirm; §7.8 archive-index-entry shape (schemas/artifacts/archive-index-entry).
 *
 * WHAT THIS PORTS (the real production behavior, brand-stripped — regenerate-never-redact, §0.3):
 *   The production system kept a per-instance roster (canonical character → sheet path + reference
 *   images + bio) and a batch script that filled a parameterized character-sheet prompt template
 *   from each character's identity and handed it to an image-generation model with two reference
 *   images (a layout/style anchor + the character identity anchor). It could not invoke the model
 *   inline (image generation ran as its own session), so it EMITTED a manifest. The detection half
 *   scanned which characters already had a real sheet vs. a single-ref placeholder.
 *
 *   This module keeps that two-path shape but wires the generation half to the engine's §12.5
 *   provider seam (the production estate's per-vendor image-model + style-anchor env vars are folded
 *   into the provider config block — spec §4.6), so no operator OAuth tooling or vendor name is
 *   baked in. All brand specifics (the production character roster, persona codenames, the
 *   per-character ability/lore fills) are DROPPED: the roster is instance config, the prompt
 *   template is a brand-neutral default, and the parameterized fill comes from the operator's
 *   roster entries.
 *
 * TWO PATHS (per §1.5):
 *   1. detectCharacterSheets(opts) — CHEAP, DETERMINISTIC, ALWAYS AVAILABLE, ZERO-KEY. Reads the
 *      library index (schemas/artifacts/archive-index-entry) and the operator roster, and reports
 *      which roster characters already have a sheet in the library and which are MISSING. Marks an
 *      asset as a character sheet by any of: source_class marker, a `character-sheet` tag, a
 *      `character-sheets/` path segment, or a character_refs back-link. Never spends, never writes.
 *   2. generateCharacterSheet(opts) — METERED, APPROVAL-GATED. Builds the filled prompt for one
 *      missing character and invokes the configured image-generation provider. It is:
 *        - DEGRADE-TO-SKIP when no image-generation provider is configured (mirrors visual-check:
 *          returns {skipped:true} with a clear message — never crashes, never fabricates a sheet);
 *        - APPROVAL-GATED: requires explicit approve/yes AND presents a cost estimate FIRST
 *          (DD-18); without approval it HALTS with the estimate (the §1.5 "if approved" gate);
 *        - DRY-RUN by default (mutation safety): without apply it returns the planned action +
 *          estimate and writes nothing;
 *        - IDEMPOTENT: a character that already has a sheet is never re-generated (never re-bills
 *          an already-processed asset — DD-18 mutation-safety rule);
 *        - DEPENDENCY-INJECTABLE (RD-12): the image-gen call is injectable (like visual-check's
 *          spawnSync), so tests run ZERO-KEY with a fake generator and CI holds no secrets.
 *
 * Tier-3 cleanliness (§0.3 r6): no hardcoded ids/paths/handles/codenames/brand strings; the roster,
 * the provider, and the prompt fills are all operator config. Every instance path resolves through
 * engine/shared/paths.js (RD-3).
 */

const fs = require('fs');
const path = require('path');

const paths = require('../shared/paths.js');
const imageGen = require('./image-gen-provider.js');

/**
 * Indicative per-sheet image-generation cost band (USD), used ONLY for the DD-18 estimate preface.
 * Marked INDICATIVE / "measured as of release" (mirrors calibrate.js DEFAULT_PER_SAMPLE_USD and
 * docs/cost.md §15.4). Config overrides via `cost.per_image_usd`. A stale band is a docs bug, not a
 * blocker — the engine never bills the image model directly (the host runtime owns the spend, RD-2).
 */
const DEFAULT_PER_IMAGE_USD = { low: 0.04, high: 0.25 };

/** Markers that identify an index entry as a character sheet (brand-neutral, structural). */
const SHEET_TAG = 'character-sheet';
const SHEET_SOURCE_MARKER = 'character-sheet'; // an optional source_class-adjacent marker field.
const SHEET_PATH_SEGMENT = 'character-sheets'; // the §1.5 folder-sort lane for sheets.

/**
 * Resolve the library media index, tolerating BOTH index shapes in use across the engine
 * (engine/library/check.js reads `assets`; engine/setup/checkpoints.js reads `entries`). Empty /
 * missing / malformed ⇒ [] (empty-library mode, DD-21 — never throws).
 * @param {object} [env]
 * @returns {Array<object>} archive-index entries.
 */
function loadIndexEntries(env = process.env) {
  let file;
  try {
    file = paths.libraryIndex(env);
  } catch {
    return []; // CONTENT_HOME unset — caller is a CONTENT_HOME-free context.
  }
  if (!fs.existsSync(file)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed.assets)) return parsed.assets;
    if (Array.isArray(parsed.entries)) return parsed.entries;
    return [];
  } catch {
    return [];
  }
}

/**
 * Resolve the operator roster of characters that SHOULD have sheets. The roster is instance config
 * (config.character_sheets.roster), not engine code — the production brand roster is dropped. Each
 * entry is normalized to { name, key, aliases[], identity, abilities, palette, lore, refs[],
 * subtitle, collection }. A bare string is treated as a name-only entry.
 *
 * @param {object} [config]  the system.json config object (util.loadSystemConfig output).
 * @returns {Array<object>} normalized roster characters (possibly empty).
 */
function resolveRoster(config = {}) {
  const block = config && typeof config.character_sheets === 'object' ? config.character_sheets : {};
  const raw = Array.isArray(block.roster) ? block.roster : [];
  return raw
    .map((entry) => normalizeRosterEntry(entry))
    .filter((c) => c && c.name);
}

/** Normalize one roster entry (string or object) into the internal character shape. */
function normalizeRosterEntry(entry) {
  if (typeof entry === 'string') {
    const name = entry.trim();
    return name ? { name, key: characterKey(name), aliases: [], refs: [] } : null;
  }
  if (!entry || typeof entry !== 'object') return null;
  const name = String(entry.name || '').trim();
  if (!name) return null;
  const aliases = Array.isArray(entry.aliases) ? entry.aliases.map((a) => String(a).trim()).filter(Boolean) : [];
  const refs = Array.isArray(entry.canonical_refs)
    ? entry.canonical_refs.map(String).filter(Boolean)
    : Array.isArray(entry.refs)
      ? entry.refs.map(String).filter(Boolean)
      : [];
  return {
    name,
    key: characterKey(name),
    aliases,
    refs,
    collection: entry.collection ? String(entry.collection) : null,
    subtitle: entry.subtitle ? String(entry.subtitle) : null,
    identity: entry.identity || entry.bio || entry.identity_description || '',
    abilities: entry.abilities || '',
    palette: entry.palette || '',
    lore: entry.lore || '',
    // An explicit sheet path lets the operator name where the sheet lives/should land.
    sheet_path: entry.sheet_path || entry.contact_sheet || null,
  };
}

/** A stable, comparison-friendly key for a character name/alias (lower, separator-collapsed). */
function characterKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/['"]/gu, '')
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
}

/** Is an index entry a character sheet? (structural markers only — no brand knowledge). */
function entryIsCharacterSheet(entry) {
  if (!entry || typeof entry !== 'object') return false;
  const tags = Array.isArray(entry.tags) ? entry.tags.map((t) => String(t).toLowerCase()) : [];
  if (tags.includes(SHEET_TAG)) return true;
  if (String(entry.source_class || '').toLowerCase() === SHEET_SOURCE_MARKER) return true;
  if (entry.character_sheet === true || entry.is_character_sheet === true) return true;
  const p = String(entry.path || '').toLowerCase().replace(/\\/gu, '/');
  if (p.split('/').includes(SHEET_PATH_SEGMENT)) return true;
  return false;
}

/**
 * Build the set of character keys that a sheet entry covers. A sheet entry covers a character when:
 *   - its character_refs list a character key/name, OR
 *   - its tags / description / path mention the character name or an alias key.
 * Returns a Set of character keys (from the supplied roster) that this entry satisfies.
 */
function sheetCoversCharacters(entry, roster) {
  const covered = new Set();
  const refs = (Array.isArray(entry.character_refs) ? entry.character_refs : []).map((r) =>
    characterKey(String(r).replace(/\.[a-z0-9]+$/iu, '')),
  );
  const haystack = [
    String(entry.path || ''),
    String(entry.description || ''),
    ...(Array.isArray(entry.tags) ? entry.tags : []),
  ]
    .join(' ')
    .toLowerCase();

  for (const c of roster) {
    const keys = [c.key, ...c.aliases.map(characterKey)].filter(Boolean);
    // Direct ref-link match (strongest), or a name/alias token appears in the entry's text/path.
    const refMatch = keys.some((k) => refs.includes(k));
    const textMatch = keys.some((k) => k && (haystack.includes(k) || haystack.includes(k.replace(/-/gu, ' '))));
    if (refMatch || textMatch) covered.add(c.key);
  }
  return covered;
}

/**
 * DETECT — the cheap, deterministic, always-available path (§1.5 "check the library for existing
 * character sheets"). Scans the library index for character-sheet assets and reports, per roster
 * character, whether a sheet exists and which asset(s) cover it; and which characters are MISSING.
 *
 * Zero spend, zero writes, zero keys. When no roster is configured it still reports every detected
 * sheet asset (so an operator can see what the library holds) with an empty `missing` list and a
 * note that no roster is configured.
 *
 * @param {object} [opts]
 * @param {Array<object>} [opts.index]    pre-loaded index entries (else read from CONTENT_HOME).
 * @param {object}        [opts.config]   system.json config (for the roster); else {}.
 * @param {object}        [opts.env]      environment (default process.env).
 * @returns {{
 *   roster_size:number, sheet_assets:number, present:Array, missing:Array, sheets:Array, note?:string
 * }}
 */
function detectCharacterSheets(opts = {}) {
  const env = opts.env || process.env;
  const entries = opts.index || loadIndexEntries(env);
  const roster = resolveRoster(opts.config || {});

  const sheetEntries = entries.filter(entryIsCharacterSheet);
  const sheets = sheetEntries.map((e) => ({
    asset_id: e.asset_id || e.path || null,
    path: e.path || null,
    tags: Array.isArray(e.tags) ? e.tags : [],
    character_refs: Array.isArray(e.character_refs) ? e.character_refs : [],
  }));

  if (roster.length === 0) {
    return {
      roster_size: 0,
      sheet_assets: sheetEntries.length,
      present: [],
      missing: [],
      sheets,
      note:
        'No character roster configured (config.character_sheets.roster). Detected the library’s ' +
        'character-sheet assets above; add a roster to report which named characters have/need sheets (§1.5).',
    };
  }

  // Map roster character key → covering sheet asset ids.
  const coverage = new Map();
  for (const c of roster) coverage.set(c.key, []);
  for (const entry of sheetEntries) {
    const covers = sheetCoversCharacters(entry, roster);
    for (const key of covers) {
      coverage.get(key).push(entry.asset_id || entry.path || null);
    }
  }

  const present = [];
  const missing = [];
  for (const c of roster) {
    const covering = coverage.get(c.key).filter(Boolean);
    const row = { name: c.name, key: c.key, collection: c.collection || null };
    if (covering.length > 0) {
      present.push({ ...row, sheets: covering });
    } else {
      missing.push({ ...row, refs_available: c.refs.length, identity_available: Boolean(c.identity) });
    }
  }

  return { roster_size: roster.length, sheet_assets: sheetEntries.length, present, missing, sheets };
}

/**
 * The brand-neutral character-sheet prompt template. Ported (structure preserved) from the
 * production sheet-prompt template but with ALL brand/character specifics removed — the layout and
 * section vocabulary is generic concept-sheet craft, the identity/abilities/palette/lore are filled
 * from the operator's roster entry. The style anchor (a production per-instance env var) is a
 * provider option, not baked here (§4.6).
 *
 * @param {object} character  a normalized roster entry.
 * @returns {string} the filled prompt body.
 */
function buildSheetPrompt(character) {
  const subtitle = character.subtitle || '';
  const identity = character.identity || `the character "${character.name}" exactly as shown in the attached reference image`;
  const abilities = character.abilities || '';
  const palette = character.palette || 'the character’s dominant palette';
  const lore = character.lore || '';
  const subtitleLine = subtitle ? ` Subtitle: "${subtitle}".` : '';
  const abilitiesLine = abilities
    ? ` Abilities can be represented visually with icons and short labels: ${abilities}.`
    : '';
  const loreBlock = lore ? `\n\nLore snippet (small block at bottom): ${lore}` : '';

  return `Create a polished landscape character sheet / concept art reference page. Use the attached style-anchor image (if provided) for the SHEET STRUCTURE ONLY — clean design board, large dynamic hero pose, turnaround views, expression grid, accessory/detail callouts, outfit breakdown boxes, color palette swatches, ability cards, a small lore snippet, and name typography. Do not copy any character from the style anchor.

Use the attached character reference image(s) for the character identity EXACTLY: ${identity}. Preserve the canonical face, outfit cues, palette, and accessories.

Character sheet content: name the character "${character.name}" in bold lettering.${subtitleLine} Include sections with small readable labels: TURNAROUND, EXPRESSIONS, ACCESSORIES & DETAILS, OUTFIT BREAKDOWN, COLOR PALETTE, ABILITIES, LORE SNIPPET. Create front/side/back mini views, several expression portraits, and accessory callouts.${abilitiesLine}

Rendering style: high-quality concept sheet, crisp edges, vibrant colors, clean readable layout, dynamic but organized. Landscape 16:9 composition. Design-board background with ${palette} accent tones matching the character. Make the main subject readable immediately.${loreBlock}

Constraints: no watermark, no unrelated logos, no duplicate main subjects outside the sheet turnarounds/expression studies, no messy UI, no parameter syntax, no random extra characters. Keep text minimal and mostly section labels.`;
}

/**
 * The intended output path for a generated sheet (CONTENT_HOME-relative). Honors an explicit
 * roster `sheet_path`; else lands under the §1.5 folder-sort lane:
 *   library/character-sheets/<collection?>/<key>.png
 */
function sheetOutputPath(character) {
  if (character.sheet_path) return String(character.sheet_path);
  const parts = ['library', SHEET_PATH_SEGMENT];
  if (character.collection) parts.push(characterKey(character.collection));
  parts.push(`${character.key}.png`);
  return parts.join('/');
}

/** Build the DD-18 cost estimate preface for generating `count` sheets. */
function estimate(count, config = {}) {
  const band =
    config && config.cost && config.cost.per_image_usd && Number.isFinite(Number(config.cost.per_image_usd.low))
      ? { low: Number(config.cost.per_image_usd.low), high: Number(config.cost.per_image_usd.high) }
      : DEFAULT_PER_IMAGE_USD;
  return {
    image_count: count,
    per_image_usd: band,
    estimated_total_usd: { low: +(count * band.low).toFixed(2), high: +(count * band.high).toFixed(2) },
    note:
      'INDICATIVE band (measured as of release; see docs/cost.md §15.4). Image-generation spend is ' +
      'host-runtime-owned (RD-2); the engine cannot bill it directly.',
  };
}

/**
 * GENERATE — the metered, approval-gated path (§1.5 "if approved"; DD-18 estimate-and-confirm;
 * §12.5 provider seam mirrored for image-gen; RD-12 injectable provider for zero-key tests).
 *
 * Order of guards (each returns a structured result; only the final, fully-cleared path spends):
 *   1. character resolution     — needs a name (and ideally identity/refs).
 *   2. IDEMPOTENT skip          — if the character already has a sheet, never re-generate (no spend).
 *   3. DEGRADE-TO-SKIP          — if no image-gen provider is configured, return {skipped:true}.
 *   4. APPROVAL + ESTIMATE      — without approve/yes, HALT with the cost estimate (DD-18).
 *   5. DRY-RUN                   — approved but not applied: return the plan + estimate, write nothing.
 *   6. APPLY                     — invoke the (injectable) provider and report the produced sheet.
 *
 * @param {object} opts
 * @param {string}        [opts.character]    character name/key to generate (required to act).
 * @param {object}        [opts.config]       system.json config (roster + provider + cost).
 * @param {Array<object>} [opts.index]        pre-loaded index (for the idempotent existence check).
 * @param {boolean}       [opts.approve]      explicit approval (the §1.5 "if approved" gate).
 * @param {boolean}       [opts.apply]        actually invoke the provider (else dry-run).
 * @param {function}      [opts.generate]     INJECTABLE image-gen function (RD-12; zero-key tests).
 *                                            Signature: ({ provider, prompt, refs, outputPath, env }) ⇒
 *                                            { ok, output_path?, bytes?, raw? }.
 * @param {object}        [opts.env]          environment (default process.env).
 * @returns {object} a structured result (ok/summary/detail/data with skipped/awaiting flags).
 */
function generateCharacterSheet(opts = {}) {
  const env = opts.env || process.env;
  const config = opts.config || {};
  const roster = resolveRoster(config);

  // 1. Resolve the requested character (by name, key, or alias) against the roster.
  const requested = String(opts.character || '').trim();
  if (!requested) {
    return {
      ok: false,
      skipped: false,
      summary: 'generateCharacterSheet needs a character (name/key)',
      detail: 'Pass opts.character — the named character to generate a sheet for (§1.5).',
      data: { character: null },
    };
  }
  const wantKey = characterKey(requested);
  const character =
    roster.find((c) => c.key === wantKey || c.aliases.map(characterKey).includes(wantKey)) ||
    // Allow generating for a character not in the roster, using just the name (degraded identity).
    normalizeRosterEntry(requested);

  // 2. IDEMPOTENT existence check — never re-generate / re-bill an already-processed character.
  const detect = detectCharacterSheets({ index: opts.index, config, env });
  const alreadyPresent = detect.present.find((p) => p.key === character.key);
  if (alreadyPresent) {
    return {
      ok: true,
      skipped: true,
      summary: `character "${character.name}" already has a sheet — skipping (idempotent, no spend)`,
      detail: [`Existing sheet(s): ${alreadyPresent.sheets.join(', ')}`, 'Generation never re-bills an already-processed asset (DD-18).'],
      data: { character: character.name, present: true, sheets: alreadyPresent.sheets },
    };
  }

  // 3. DEGRADE-TO-SKIP — no image-generation provider configured (mirrors visual-check §12.5).
  const providerBlock = (config && (config.image_gen || config.imageGen)) || null;
  const provider = imageGen.resolveProvider(providerBlock);
  if (!provider && !opts.generate) {
    return {
      ok: true,
      skipped: true,
      summary: 'character-sheet generation skipped — no image-generation provider configured (§12.5)',
      detail: [
        'No image-generation provider is configured (config.image_gen). The public engine ships no',
        'image-gen provider wired by default; set a §12.5-shaped provider block (kind/model/endpoint_env/',
        'timeout_ms/options) to enable generation, or supply an injected generator. Detection still works.',
      ],
      data: { character: character.name, provider_configured: false, skipped: true },
    };
  }

  // Build the plan (prompt + refs + output path) — needed for estimate, dry-run, and apply.
  const prompt = buildSheetPrompt(character);
  const outputPath = sheetOutputPath(character);
  const est = estimate(1, config);
  const plan = {
    character: character.name,
    output_path: outputPath,
    refs: character.refs,
    identity_available: Boolean(character.identity),
    provider_kind: provider ? provider.kind : (opts.generate ? 'injected' : null),
  };

  // 4. APPROVAL + ESTIMATE — the §1.5 "if approved" gate + DD-18 estimate-and-confirm. Without
  //    explicit approval we HALT and present the estimate; the engine never generates unapproved.
  if (!opts.approve && !opts.yes) {
    return {
      ok: false,
      skipped: false,
      awaiting_approval: true,
      summary: `character-sheet generation requires approval: 1 sheet ≈ $${est.estimated_total_usd.low}–$${est.estimated_total_usd.high} (indicative)`,
      detail: [
        est.note,
        `Would generate a sheet for "${character.name}" → ${outputPath}.`,
        'Re-run with approve (and apply) to confirm and proceed (§1.5 "if approved"; DD-18).',
      ],
      data: { plan, estimate: est, approved: false, awaiting_approval: true },
    };
  }

  // 5. DRY-RUN — approved but not applied (mutation safety): show the plan, write nothing, no spend.
  if (!opts.apply) {
    return {
      ok: true,
      skipped: false,
      dry_run: true,
      summary: `[dry-run] approved — would generate a sheet for "${character.name}" (re-run with apply to spend)`,
      detail: [
        est.note,
        `Output: ${outputPath}`,
        `Reference images: ${character.refs.length ? character.refs.join(', ') : '(none in roster — identity-only prompt)'}`,
        'Dry-run by default for any metered/mutating action; pass apply to actually generate (DD-18).',
      ],
      data: { plan, estimate: est, approved: true, dry_run: true },
    };
  }

  // 6. APPLY — invoke the (injectable) image-gen provider. The injected generator (RD-12) runs
  //    zero-key in tests; in production the resolved §12.5 provider performs the call.
  const generate = opts.generate || imageGen.runImageGen;
  let produced;
  try {
    produced = generate({ provider, prompt, refs: character.refs, outputPath, env });
  } catch (err) {
    return {
      ok: false,
      skipped: false,
      summary: `character-sheet generation failed for "${character.name}"`,
      detail: [err && err.message ? err.message : String(err), 'No sheet was produced; nothing was billed for a failed call.'],
      data: { plan, estimate: est, approved: true, error: err && err.message ? err.message : String(err) },
    };
  }
  if (!produced || produced.ok === false) {
    return {
      ok: false,
      skipped: false,
      summary: `image-generation provider returned no usable sheet for "${character.name}"`,
      detail: [produced && produced.reason ? String(produced.reason) : 'provider returned an unusable result'],
      data: { plan, estimate: est, approved: true, produced: produced || null },
    };
  }

  return {
    ok: true,
    skipped: false,
    summary: `generated character sheet for "${character.name}" → ${produced.output_path || outputPath}`,
    detail: [
      'Generated. Review the sheet before adding it to the library index (the engine never auto-indexes',
      'a generated sheet without the operator’s approval-lineage — schemas/artifacts/archive-index-entry).',
    ],
    data: {
      plan,
      estimate: est,
      approved: true,
      produced: { output_path: produced.output_path || outputPath, bytes: produced.bytes ?? null },
      // The archive-index-entry an operator would add for this sheet (source_class marks it).
      suggested_index_entry: {
        asset_id: produced.output_path || outputPath,
        path: produced.output_path || outputPath,
        type: 'image',
        source_class: 'generated',
        tags: [SHEET_TAG],
        character_refs: [character.key],
      },
    },
  };
}

module.exports = {
  DEFAULT_PER_IMAGE_USD,
  SHEET_TAG,
  SHEET_PATH_SEGMENT,
  loadIndexEntries,
  resolveRoster,
  characterKey,
  entryIsCharacterSheet,
  buildSheetPrompt,
  sheetOutputPath,
  estimate,
  detectCharacterSheets,
  generateCharacterSheet,
};
