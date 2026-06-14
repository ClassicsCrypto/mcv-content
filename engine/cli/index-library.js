'use strict';

/**
 * engine/cli/index-library.js  [N net-new]
 *
 * `engine index-library` — the content-library auto-indexing entry point (release-spec §1.5 asset
 * indexing; §15.4 / §11.2 budget pre-run estimate; DD-18 estimate-and-confirm).
 *
 * v1 STATUS: the automatic visual-tagging indexer (the model that scans the content library and
 * writes index.json entries with captions/tags) is a ROADMAP capability (release-spec Appendix B);
 * it is NOT shipped in v1. This verb exists so the documented CLI surface and the §15.4 cost-estimate
 * contract are real, and so an operator gets an honest, actionable answer instead of "unknown verb".
 *
 * v1 supported paths for the Archive (DD-21):
 *   - empty-library mode (default): leave the library disabled; retrieval returns generate-only
 *     decisions and nothing in the chain hard-depends on an index (C4 passes).
 *   - manual population: hand-author index.json entries (schemas/artifacts/archive-index-entry).
 *
 * When the indexer ships it will, per DD-18/§15.4, present a pre-run cost estimate (the visual model
 * is metered) and require confirmation before spending. Tier-3 cleanliness (§0.3 r6): no hardcoded
 * ids/paths/codenames; instance paths (when the indexer lands) resolve via shared/paths.js.
 */

const util = require('./util');

const HELP = `engine index-library [options]

Build the content-library index by visual-tagging assets (release-spec §1.5).

v1 STATUS: the automatic indexer is FORTHCOMING (roadmap, Appendix B) — not shipped in v1.
For the Archive in v1 (DD-21):
  - empty-library mode (default): retrieval returns generate-only; no index required.
  - manual population: author index.json entries (archive-index-entry schema).

When shipped, this verb will present a pre-run cost estimate and require confirmation (DD-18/§15.4).

  --json       emit the structured result.
  -h, --help   show this help.`;

function run(ctx = {}) {
  const flags = ctx.flags || {};
  if (util.flagOn(flags.help)) return { ok: true, summary: HELP.split('\n')[0], detail: HELP };
  return {
    ok: false,
    exitCode: 3, // not-yet-present dependency: the indexer is roadmap (Appendix B), not a v1 error.
    summary: 'library auto-indexing is forthcoming (roadmap) — not available in v1',
    detail: [
      'The automatic visual-tagging indexer is not shipped in v1 (release-spec Appendix B roadmap).',
      'For the Archive in v1 (DD-21):',
      '  - empty-library mode (default): retrieval returns generate-only decisions; no index required.',
      '  - manual population: author index.json entries (schemas/artifacts/archive-index-entry).',
      'When shipped, this verb will present a pre-run cost estimate + confirmation (DD-18 / §15.4).',
    ],
    data: { available: false, roadmap: true, v1_paths: ['empty-library', 'manual-index'] },
  };
}

module.exports = { run, HELP };
