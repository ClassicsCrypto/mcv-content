'use strict';

/**
 * engine/cli/generate-dna.js  [N net-new — thin CLI wiring for BD-GENERATE]
 *
 * `engine generate-dna --brand <id>` — the one-command Brand DNA generator entry point (release-spec
 * §1.1 Data Ingestion & Brand Identity / §1.2 Context & Competitor Analysis; §2.4 C2 Brand DNA step;
 * DD-18 estimate-and-confirm; DD-21 cold-start + degrade; RD-9 competitor-not-verbatim). It upgrades
 * the v1 agent-assisted C2 onboarding into ingest -> deterministic analysis -> generate.
 *
 * THIN WIRING ONLY: this file parses flags and calls engine/brand-dna/generate.js — it never reads a
 * corpus, runs the analysis, calls a seat, or writes a file itself. The DNA SYNTHESIS is a HOST seat
 * (RD-2); the engine CLI never calls a chain/analysis LLM directly. In the agent-first flow the host
 * runtime supplies the seat by driving generation through generateBrandDna (host/test harness); the
 * bare CLI path (no host seat) DEGRADES to the deterministic analysis + the prefilled authoring
 * template for the agent to finish (DD-21) — onboarding is never blocked.
 *
 * Honest exit codes (model §12; bin/engine.js contract): 0 success / refused-by-design (a DD-18
 * confirmation halt, a cold-start/degrade write — the system behaving correctly, surfaced honestly);
 * 1 a usage/setup error (no --brand, CONTENT_HOME unset, analysis failure).
 *
 * Tier-3 cleanliness (§0.3 r6): no hardcoded ids/paths/codenames; the brand comes from the flag, all
 * instance paths resolve through shared/paths.js inside the generator.
 */

const util = require('./util');
const generator = require('../brand-dna/generate');

const HELP = `engine generate-dna --brand <id> [options]

Generate a brand's Brand DNA + archetype catalog from its ingested corpus (release-spec §1.1/§1.2;
§2.4 C2). Reads $CONTENT_HOME/corpora/<id>/ -> deterministic analysis (no LLM) -> the host
DNA-synthesis seat (turns the analysis into voice prose) -> writes brands/<id>/brand-dna.md
(identity, tone, voice, do/do-not, signature moves) + the archetype catalog + brand.json voice
fields. Competitor content informs PATTERNS only and is never reproduced verbatim (RD-9).

  --brand <id>      the brand to generate DNA for (required).
  --yes             confirm the cost estimate and synthesize (the DD-18 confirmation).
  --estimate-only   print the pre-run cost estimate and exit (no spend).
  --force           regenerate even if brand-dna.md already exists (idempotent otherwise).
  --json            emit the structured result.
  -h, --help        show this help.

DD-18: DNA synthesis is metered — without --yes the command halts with a cost estimate and writes
nothing. DD-21: no corpus -> the cold-start manual authoring template; corpus but no host seat ->
the deterministic analysis + a PREFILLED authoring template for the agent to finish. The manual
authoring path (templates/brand/brand-dna-authoring.md) always works — onboarding is never blocked.`;

/**
 * @param {object} ctx  { flags, positionals, env, dnaSeat?, analyzeCorpus?, categorizeArchetypes? }
 * @returns {Promise<{ ok, summary, detail?, data?, exitCode? }>}
 */
async function run(ctx = {}) {
  const flags = ctx.flags || {};
  if (util.flagOn(flags.help)) return { ok: true, summary: HELP.split('\n')[0], detail: HELP };

  const env = ctx.env || process.env;
  const brand = typeof flags.brand === 'string' && flags.brand.trim()
    ? flags.brand.trim()
    : (ctx.positionals && ctx.positionals[0]);
  if (!brand) {
    return { ok: false, exitCode: 1, summary: 'generate-dna needs --brand <id>', detail: ['Usage: engine generate-dna --brand <id> (§2.4 C2).'] };
  }

  const res = await generator.generateBrandDna({
    brand,
    env,
    yes: util.flagOn(flags.yes),
    estimateOnly: util.flagOn(flags['estimate-only']),
    force: util.flagOn(flags.force),
    // The host runtime injects the synthesis seat (and may inject the analyzer) when it drives this
    // verb; the bare CLI passes none, so the generator degrades to the deterministic+template path.
    dnaSeat: typeof ctx.dnaSeat === 'function' ? ctx.dnaSeat : undefined,
    analyzeCorpus: typeof ctx.analyzeCorpus === 'function' ? ctx.analyzeCorpus : undefined,
    categorizeArchetypes: typeof ctx.categorizeArchetypes === 'function' ? ctx.categorizeArchetypes : undefined,
  });

  // The generator already returns the {ok, status, summary, detail, data, exitCode} envelope; pass it
  // through unchanged (a confirmation halt carries exitCode 0 — refused-by-design is honest success).
  return res;
}

module.exports = { run, HELP };
