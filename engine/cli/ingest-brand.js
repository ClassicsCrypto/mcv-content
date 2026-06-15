'use strict';

/**
 * engine/cli/ingest-brand.js  [N net-new — the ONE-COMMAND brand-onboarding verb (BD-CLI)]
 *
 * `engine ingest-brand --brand <id>` — the one-command DATA-INGESTION & BRAND-IDENTITY flow that runs
 * in the C2 setup checkpoint (release-spec / original-design-spec §1.1 Data Ingestion & Brand Identity
 * + §1.2 Context & Competitor Analysis; roadmap #2). It chains the three stage-1 batches end-to-end:
 *
 *   INGEST   (engine/sources/ingest — BD-INGEST)   pull/import the operator's OWN corpus + the
 *            COMPETITOR corpus into $CONTENT_HOME/corpora/<brand>/ (Zone U, trust-tagged at write).
 *      ->
 *   ANALYZE  (engine/brand-dna/analyze — BD-ANALYZE, driven by generate.js) DETERMINISTIC corpus
 *            analysis (auditable stats, NO LLM) + archetype categorization.
 *      ->
 *   GENERATE (engine/brand-dna/generate — BD-GENERATE) write brands/<id>/brand-dna.md + the archetype
 *            catalog + brand.json voice fields. DNA SYNTHESIS is a HOST seat (RD-2), injectable; it
 *            degrades to the prefilled/cold-start authoring template when no seat is wired (DD-21).
 *
 * THIN WIRING ONLY (DD-1(c)): this file parses flags, reads config, and calls the stage-1 modules. It
 * never scrapes, analyzes, calls a chain/analysis LLM, or writes a corpus item / DNA file itself — the
 * engine NEVER calls a chain/analysis LLM directly (RD-2). The DNA-synthesis seat is the host runtime's
 * seam; the bare CLI passes none, so generation degrades gracefully (onboarding is never blocked).
 *
 * THE DD-18 METERED GATE (the LAW): the two metered actions are the SCRAPE (a provider quota) and the
 * DNA SYNTHESIS (an LLM seat). Default (no --yes) is the SAFE preface: it shows WHAT would be ingested
 * + generated and the indicative COST BAND, and SPENDS NOTHING. --yes confirms BOTH metered actions.
 * --estimate-only prints only the estimate and exits. The first-class non-metered intake paths (manual
 * submission + official-account EXPORTS, --manual) are FREE and need no confirmation (RD-9 / DD-21).
 *
 * SCRAPING POSTURE (RD-9): scraping is BYO + OFF BY DEFAULT (brand_dna.enabled + a configured
 * scraper.adapter). When the scraper pathway is disabled or no adapter is configured, the verb does
 * NOT fail — it skips the scrape and continues with whatever corpus already exists on disk (the
 * manual/export path), then analyzes + generates from that. --manual forces the no-scrape path even
 * when a scraper is configured. Competitor content is Zone U, analyzed for PATTERNS only — the
 * BD-GENERATE no-verbatim check enforces that no competitor copy reaches the generated DNA.
 *
 * COLD START / FALLBACK (DD-21 — never block onboarding): no scraper + no corpus => the generate step
 * still writes the manual authoring template (the agent finishes by hand). No seat but a corpus =>
 * generate emits the deterministic analysis + a PREFILLED authoring template. The manual authoring
 * path (templates/brand/brand-dna-authoring.md) always works.
 *
 * Honest exit codes (model §12; bin/engine.js contract): 0 success / refused-by-design (a DD-18
 * confirmation halt, a cold-start/degrade write — the system behaving correctly, surfaced honestly);
 * 2 a usage/setup error (no --brand, bad flag); 3 a genuinely absent dependency (a confirmed scrape
 * whose configured adapter is not registered). A disabled-scraper / no-corpus path is NOT exit 3 — it
 * is the supported manual/cold-start fallback (DD-21), exit 0.
 *
 * Tier-3 cleanliness (§0.3 r6 / RD-3): no hardcoded ids/handles/absolute paths/brand strings; no
 * production persona codenames. The brand comes from the flag; competitors/handles come from the
 * brand's `ingestion` config (DD-10 brand-keyed) or the --competitors override; every instance path
 * resolves through shared/paths.js inside the called modules.
 */

const util = require('./util');
const ingest = require('../sources/ingest');
const generator = require('../brand-dna/generate');

const HELP = `engine ingest-brand --brand <id> [options]

The ONE-COMMAND brand onboarding flow (release-spec §1.1/§1.2; §2.4 C2). Ingests the operator's OWN
corpus + the COMPETITOR corpus, runs the DETERMINISTIC analyzer (no LLM) + archetype categorizer,
then writes brands/<id>/brand-dna.md + the archetype catalog + brand.json voice fields. Competitor
content informs PATTERNS only and is never reproduced verbatim (RD-9).

  --brand <id>      the brand to onboard (required; corpora are brand-keyed — DD-10).
  --yes             confirm the metered actions (the BYO SCRAPE + the DNA SYNTHESIS) and run them.
  --estimate-only   print the pre-run cost band for ingest + synthesis and exit (no spend).
  --manual          skip scraping; use only the already-imported manual / exported corpus on disk.
  --competitors <a,b>   override the configured competitor handles for this run (comma-separated).
  --account <handle>    override the configured own-account handle for the scrape.
  --since <iso>     only ingest items captured on/after this ISO date (scrape lower bound).
  --max <n>         per-account scrape cap (else the configured max_items_per_handle).
  --force           regenerate brand-dna.md even if it already exists (idempotent otherwise).
  --json            emit the structured result.
  -h, --help        show this help.

DD-18: scraping + DNA synthesis are METERED. Without --yes the command shows what WOULD be ingested
and generated plus the indicative cost band, and spends nothing. RD-9: scraping is BYO and OFF by
default (config brand_dna.enabled + a scraper.adapter); manual submission + official-account EXPORTS
are first-class and free. DD-21: no scraper / no corpus -> the manual authoring path still works;
onboarding is never blocked.`;

/**
 * Resolve the effective config the chain consumes: the instance system.json with the per-brand
 * `ingestion` block merged in (DD-10 brand-keyed). The BD-INGEST source reads an `ingest` config
 * block (off-by-default scraper gate); the operator's posture lives in system.json `brand_dna`
 * (enabled + scraper) and the per-brand `ingestion` block (account_handles + competitors). This
 * bridges those into the single `config` object ingestCorpus expects, without changing either schema.
 *
 * @returns {{ system, brand, ingestConfigBlock, brandDnaEnabled }}
 */
function resolveConfig(env, brandId) {
  const system = util.loadSystemConfig(env) || {};
  const brand = readBrandConfig(env, brandId);
  const brandDna = (system.brand_dna && typeof system.brand_dna === 'object') ? system.brand_dna : {};
  const brandIngestion = (brand && brand.ingestion && typeof brand.ingestion === 'object') ? brand.ingestion : {};

  // The scraper adapter ref: per-brand override wins over the system default (DD-10).
  const scraper =
    (brandIngestion.scraper && typeof brandIngestion.scraper === 'object' && brandIngestion.scraper) ||
    (brandDna.scraper && typeof brandDna.scraper === 'object' && brandDna.scraper) ||
    {};

  // Build the `ingest` block ingestCorpus reads (engine/sources/ingest/source.js#ingestConfig). The
  // SCRAPER pathway is enabled only when BOTH the brand_dna master gate is on AND a scraper.adapter is
  // configured (RD-9 BYO + OFF-by-default). max_items_per_handle / retention_class come from the
  // brand_dna.scraper + per-brand ingestion blocks.
  const adapter = typeof scraper.adapter === 'string' && scraper.adapter.trim() ? scraper.adapter.trim() : null;
  const ingestConfigBlock = {
    enabled: brandDna.enabled === true && Boolean(adapter),
    adapter,
    provider: (scraper.provider && typeof scraper.provider === 'object') ? scraper.provider : {},
    max_per_account: Number.isFinite(Number(scraper.max_items_per_handle)) && Number(scraper.max_items_per_handle) > 0
      ? Math.floor(Number(scraper.max_items_per_handle))
      : undefined,
    retention_class: typeof brandIngestion.retention_class === 'string' ? brandIngestion.retention_class : undefined,
    private_terms: mergePrivateTerms(brandDna.private_terms),
  };

  return {
    system,
    brand,
    brandIngestion,
    ingestConfigBlock,
    brandDnaEnabled: brandDna.enabled === true,
    scraperConfigured: Boolean(adapter),
  };
}

/** Read brands/<id>/brand.json tolerantly (a missing/invalid file just yields null — never throws). */
function readBrandConfig(env, brandId) {
  try {
    // eslint-disable-next-line global-require
    const fs = require('fs');
    // eslint-disable-next-line global-require
    const paths = require('../shared/paths');
    return JSON.parse(fs.readFileSync(paths.brandConfig(brandId, env), 'utf8'));
  } catch {
    return null;
  }
}

/** Normalize the brand_dna.private_terms shape (array | {terms,...}) into a flat string[]. */
function mergePrivateTerms(pt) {
  if (Array.isArray(pt)) return pt.filter((s) => typeof s === 'string' && s.trim());
  if (pt && typeof pt === 'object' && Array.isArray(pt.terms)) {
    return pt.terms.filter((s) => typeof s === 'string' && s.trim());
  }
  return [];
}

/** First own-account handle from the brand ingestion block (string handle, '@' kept as configured). */
function configuredAccount(brandIngestion) {
  const list = Array.isArray(brandIngestion.account_handles) ? brandIngestion.account_handles : [];
  const first = list.find((h) => h && typeof h.handle === 'string' && h.handle.trim());
  return first ? first.handle.trim() : null;
}

/** Flatten the brand ingestion competitors[] (each {name,handles[]}) into a flat list of handles. */
function configuredCompetitors(brandIngestion) {
  const out = [];
  const comps = Array.isArray(brandIngestion.competitors) ? brandIngestion.competitors : [];
  for (const c of comps) {
    const handles = c && Array.isArray(c.handles) ? c.handles : [];
    for (const h of handles) {
      if (h && typeof h.handle === 'string' && h.handle.trim()) out.push(h.handle.trim());
    }
  }
  return out;
}

/** Parse a comma/space-separated --competitors override into a clean handle list. */
function parseHandleList(value) {
  if (typeof value !== 'string') return [];
  return value.split(/[\s,]+/u).map((s) => s.trim()).filter(Boolean);
}

/** The default scrape platform descriptor (the brand_dna.scraper.provider may scope its own). */
function scrapePlatform(cfg) {
  const provider = cfg.ingestConfigBlock.provider || {};
  return typeof provider.platform === 'string' && provider.platform.trim() ? provider.platform.trim() : 'twitter';
}

/**
 * @param {object} ctx  { flags, positionals, env, ingestImpl?, fetchImpl?, dnaSeat?, analyzeCorpus?,
 *                         categorizeArchetypes? }
 *   ingestImpl   — INJECTABLE ingest module override (tests pass a stub; defaults to BD-INGEST).
 *   fetchImpl    — INJECTABLE provider call forwarded to the scraper adapter (RD-12 seam).
 *   dnaSeat      — INJECTABLE host DNA-synthesis seat forwarded to BD-GENERATE (RD-2).
 *   analyzeCorpus / categorizeArchetypes — INJECTABLE BD-ANALYZE analyzers forwarded to BD-GENERATE.
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
    return {
      ok: false,
      exitCode: 2,
      summary: 'ingest-brand needs --brand <id>',
      detail: ['Usage: engine ingest-brand --brand <id> (§2.4 C2; corpora are brand-keyed — DD-10).'],
    };
  }

  const ingestMod = ctx.ingestImpl || ingest;
  const yes = util.flagOn(flags.yes);
  const estimateOnly = util.flagOn(flags['estimate-only']);
  const manual = util.flagOn(flags.manual);
  const force = util.flagOn(flags.force);

  const cfg = resolveConfig(env, brand);

  // Resolve the ingest targets: --competitors / --account overrides win over the brand config (DD-10).
  const account = (typeof flags.account === 'string' && flags.account.trim())
    ? flags.account.trim()
    : configuredAccount(cfg.brandIngestion);
  const competitors = (typeof flags.competitors === 'string')
    ? parseHandleList(flags.competitors)
    : configuredCompetitors(cfg.brandIngestion);
  const max = Number.isFinite(Number(flags.max)) && Number(flags.max) > 0 ? Math.floor(Number(flags.max)) : undefined;
  const since = typeof flags.since === 'string' && flags.since.trim() ? flags.since.trim() : undefined;

  // Will a metered SCRAPE run this invocation? Only when not --manual, the scraper pathway is enabled
  // (brand_dna.enabled + a configured adapter), and there is an own/competitor handle to pull.
  const scrapeWanted = !manual && cfg.ingestConfigBlock.enabled && (Boolean(account) || competitors.length > 0);

  // The pre-run cost band (DD-18): the SCRAPE estimate (if any) + the DNA-SYNTHESIS estimate. Both are
  // computed without spending; they are the safe-any-time preface.
  const scrapeEstimate = scrapeWanted
    ? ingestMod.estimateScrapeCost({ account, competitors, max: max || cfg.ingestConfigBlock.max_per_account })
    : null;
  const dnaEstimate = generator.estimateDnaCost({ brand, env });

  // ----- ESTIMATE-ONLY: print the combined preface and exit (no spend, no write). -----
  if (estimateOnly) {
    return {
      ok: true,
      summary: `ingest-brand estimate for ${brand}: ${estimateLine(scrapeEstimate, dnaEstimate, scrapeWanted)}`,
      detail: estimatePreface(cfg, scrapeWanted, scrapeEstimate, dnaEstimate, manual),
      data: {
        brand,
        scrape: scrapeWanted ? { willScrape: true, account: account ? '<own-account>' : null, competitors: competitors.length, estimate: scrapeEstimate } : { willScrape: false },
        dna_estimate: dnaEstimate,
        manual,
        confirmed: false,
      },
    };
  }

  // ----- SAFE DEFAULT (no --yes): show what WOULD run + the cost band, spend nothing (DD-18). -----
  // The metered actions (scrape + synthesis) require explicit confirmation. We still preview the FREE
  // work (manual corpus on disk + the deterministic analysis path) so the operator sees the full plan.
  if (!yes) {
    return {
      ok: false,
      exitCode: 0, // a confirmation halt is the system behaving correctly, surfaced honestly.
      summary: `ingest-brand for ${brand} requires confirmation (metered): ${estimateLine(scrapeEstimate, dnaEstimate, scrapeWanted)}`,
      detail: [
        ...estimatePreface(cfg, scrapeWanted, scrapeEstimate, dnaEstimate, manual),
        'Re-run with --yes to confirm and run the flow (DD-18 estimate-and-confirm).',
        '--estimate-only prints only the band; --manual skips scraping (free); the manual/export path is always free.',
      ],
      data: {
        brand,
        awaiting_confirmation: true,
        scrape: { willScrape: scrapeWanted, estimate: scrapeEstimate },
        dna_estimate: dnaEstimate,
        manual,
        confirmed: false,
      },
    };
  }

  // ======================= CONFIRMED RUN (--yes) =======================
  const stages = [];

  // ----- STAGE 1: INGEST (the metered BYO scrape, when enabled + wanted). -----
  let ingestResult = null;
  if (scrapeWanted) {
    try {
      ingestResult = await ingestMod.ingestCorpus({
        config: { ingest: cfg.ingestConfigBlock },
        env,
        brand,
        account: account || null,
        competitors,
        since: since || null,
        max: max || cfg.ingestConfigBlock.max_per_account,
        confirmed: true, // --yes is the DD-18 confirmation for the scrape
        fetchImpl: ctx.fetchImpl, // injectable provider call (RD-12); adapter defaults to global fetch
      });
      stages.push({
        stage: 'ingest',
        ran: true,
        written: ingestResult.written.length,
        by_class: ingestResult.by_class,
        invalid: ingestResult.invalid.length,
        adapter: ingestResult.adapter,
      });
    } catch (err) {
      // A configured-but-unregistered adapter on a CONFIRMED scrape is a genuinely absent dependency
      // (exit 3). Everything else (disabled / not-confirmed cannot happen here since we gate above) is
      // surfaced — but we DO NOT block onboarding: fall through to analyze+generate over whatever
      // corpus exists on disk (the manual/cold-start fallback, DD-21).
      const absentAdapter = err && err.name === 'IngestAdapterNotRegisteredError';
      stages.push({ stage: 'ingest', ran: false, error: err && err.message ? err.message : String(err), error_name: err && err.name });
      if (absentAdapter) {
        return {
          ok: false,
          exitCode: 3,
          summary: `ingest-brand: the configured scraper adapter is not registered for ${brand} (genuinely absent dependency)`,
          detail: [
            err.message,
            'Register the adapter (engine/sources/ingest#register) or set brand_dna.scraper.adapter to a shipped one (reference | fixture).',
            'The manual-submission / official-account EXPORT paths need no adapter and are always available (RD-9 / DD-21).',
          ],
          data: { brand, stages },
        };
      }
      // Non-absent error: continue to analyze/generate from on-disk corpus (degrade, DD-21).
    }
  } else {
    const why = manual
      ? 'manual mode (--manual): scraping skipped; using the on-disk manual/exported corpus'
      : (!cfg.brandDnaEnabled
          ? 'scraper pathway off (brand_dna.enabled is not true) — manual/export corpus only (RD-9 OFF-by-default)'
          : (!cfg.scraperConfigured
              ? 'no scraper adapter configured — manual/export corpus only (RD-9 BYO)'
              : 'no own-account or competitor handle configured to scrape — manual/export corpus only'));
    stages.push({ stage: 'ingest', ran: false, skipped: true, reason: why });
  }

  // ----- STAGE 2+3: ANALYZE + GENERATE (BD-GENERATE drives the deterministic analyzer + the host
  // seat). generateBrandDna reads the now-up-to-date corpus, runs the free deterministic analysis,
  // invokes the injected DNA seat (if any) behind its own DD-18 confirm, enforces the no-verbatim
  // rule (RD-9), and writes brand-dna.md + the archetype catalog + brand.json. With no seat it
  // degrades to the prefilled/cold-start authoring template (DD-21). -----
  let genResult;
  try {
    genResult = await generator.generateBrandDna({
      brand,
      env,
      yes: true, // the operator already confirmed the metered chain at this verb's gate (DD-18)
      force,
      dnaSeat: typeof ctx.dnaSeat === 'function' ? ctx.dnaSeat : undefined,
      analyzeCorpus: typeof ctx.analyzeCorpus === 'function' ? ctx.analyzeCorpus : undefined,
      categorizeArchetypes: typeof ctx.categorizeArchetypes === 'function' ? ctx.categorizeArchetypes : undefined,
    });
  } catch (err) {
    return {
      ok: false,
      exitCode: 1,
      summary: `ingest-brand: generation failed for ${brand}`,
      detail: [err && err.message ? err.message : String(err)],
      data: { brand, stages },
    };
  }
  stages.push({
    stage: 'generate',
    ran: true,
    status: genResult.status,
    dna_path: genResult.data && genResult.data.dna_path,
    archetypes: genResult.data && Array.isArray(genResult.data.archetypes) ? genResult.data.archetypes.length : undefined,
    verbatim_stripped: genResult.data && Array.isArray(genResult.data.verbatim_flags) ? genResult.data.verbatim_flags.length : 0,
  });

  // The chain's overall verdict mirrors the generate step (the terminal stage). generateBrandDna
  // returns honest exit codes already (0 for generated / degraded / cold-start; 1 for a hard fail).
  const ok = genResult.ok !== false;
  return {
    ok,
    exitCode: typeof genResult.exitCode === 'number' ? genResult.exitCode : (ok ? 0 : 1),
    summary: `ingest-brand for ${brand}: ${genResult.summary}`,
    detail: [
      ...stages.map(describeStage),
      ...(Array.isArray(genResult.detail) ? genResult.detail : (genResult.detail ? [String(genResult.detail)] : [])),
    ],
    data: {
      brand,
      stages,
      generate: genResult.data,
      generate_status: genResult.status,
    },
  };
}

/** One-line cost summary for the headline. */
function estimateLine(scrapeEstimate, dnaEstimate, scrapeWanted) {
  const parts = [];
  if (scrapeWanted && scrapeEstimate) {
    parts.push(`scrape ~${scrapeEstimate.item_estimate} item(s) ≈ $${scrapeEstimate.total_usd_estimate}`);
  } else {
    parts.push('scrape: none (manual/export corpus)');
  }
  const t = dnaEstimate.estimated_total_usd || {};
  parts.push(dnaEstimate.synthesis_calls > 0
    ? `synthesis ≈ $${t.low}–$${t.high}`
    : 'synthesis: none (cold-start template — free)');
  return `${parts.join(' + ')} (indicative)`;
}

/** The multi-line estimate preface shared by --estimate-only and the unconfirmed default. */
function estimatePreface(cfg, scrapeWanted, scrapeEstimate, dnaEstimate, manual) {
  const lines = [];
  if (scrapeWanted && scrapeEstimate) {
    lines.push(
      `INGEST (metered scrape, BYO — RD-9): ~${scrapeEstimate.accounts} account(s) × ${scrapeEstimate.max_per_account} ` +
        `= ~${scrapeEstimate.item_estimate} item(s) at ~$${scrapeEstimate.per_item_usd}/item ≈ $${scrapeEstimate.total_usd_estimate} (indicative).`,
    );
  } else if (manual) {
    lines.push('INGEST: --manual — scraping skipped; the on-disk manual/exported corpus is used (free).');
  } else if (!cfg.brandDnaEnabled) {
    lines.push('INGEST: scraper pathway OFF (brand_dna.enabled is not true) — manual/export corpus only (free, RD-9 OFF-by-default).');
  } else if (!cfg.scraperConfigured) {
    lines.push('INGEST: no scraper adapter configured — manual/export corpus only (free, RD-9 BYO).');
  } else {
    lines.push('INGEST: no own-account / competitor handle to scrape — manual/export corpus only (free).');
  }
  lines.push(dnaEstimate.note);
  lines.push(`SYNTHESIS: own items on disk: ${dnaEstimate.own_items} | competitor items: ${dnaEstimate.competitor_items}.`);
  return lines;
}

/** Human one-liner per stage for the verb detail block. */
function describeStage(s) {
  if (s.stage === 'ingest') {
    if (s.ran) {
      return `ingest: ${s.written} item(s) written (own ${s.by_class.own || 0} / competitor ${s.by_class.competitor || 0}` +
        `${s.invalid ? `, ${s.invalid} invalid` : ''}) via "${s.adapter}".`;
    }
    if (s.skipped) return `ingest: skipped — ${s.reason}.`;
    return `ingest: did not run — ${s.error || 'unknown'} (continuing from on-disk corpus, DD-21).`;
  }
  if (s.stage === 'generate') {
    return `generate: ${s.status}${s.dna_path ? ` → ${s.dna_path}` : ''}` +
      `${s.archetypes != null ? ` (${s.archetypes} archetype file(s))` : ''}` +
      `${s.verbatim_stripped ? `; ${s.verbatim_stripped} verbatim span(s) stripped (RD-9)` : ''}.`;
  }
  return `${s.stage}: ${s.ran ? 'ran' : 'skipped'}.`;
}

module.exports = { run, HELP, resolveConfig, configuredAccount, configuredCompetitors, parseHandleList };
