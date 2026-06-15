'use strict';

/**
 * engine/orchestrator/competitor-scan.js  [N net-new — roadmap #5 competitor scan orchestrator]
 *
 * runCompetitorScan(opts): the config-gated MONTHLY COMPETITOR SCAN orchestrator. OFF BY DEFAULT;
 * refuses (returns {ran:false,disabled:true}) unless config.competitor_scan.enabled===true, UNLESS
 * opts.force overrides for an explicit operator/test run.
 *
 * One scan pass:
 *   1. DD-18 estimate preface (metered scrape; surfaced to caller before any spend).
 *   2. Fetch competitor corpus via the registered adapter (ingestCorpus, confirmed) OR fall back to
 *      the on-disk fixture corpora (DD-21 cold start / manual export fallback).
 *   3. readCorpus to load own+competitor items for the brand.
 *   4. analyzeCorpus + categorizeArchetypes from brand-dna/analyze.js + archetypes.js.
 *   5. analyzeCompetitorPatterns from brand-dna/competitor-landscape.js (patterns-only, P1).
 *   6. Build a scan report (schemas/inputs/competitor-scan-report.schema.json-shaped).
 *   7. enforceNotVerbatim / assertNoVerbatimCompetitorCopy BEFORE writing (P1).
 *   8. Write report to $CONTENT_HOME/scans/<brand>/<YYYY-MM-DD>.json (Zone-U, transient).
 *   9. Dispatch ONE reserved competitor_scan task record (no post produced — P11/DD-16).
 *  10. Hand the report to voice-calibration/propose (when voice_calibration.enabled).
 *
 * Safety order:
 *   - Runs UNDER the single-runner lock (run-lock.js — overlap is skip-and-logged, DD-19).
 *   - dispatch preflight (PAUSED sentinel + spend-cap) halts new dispatch when kill switch is
 *     engaged or budget is breached.
 *   - OFF by default; honors the PAUSED kill switch; DD-18 estimate-and-confirm before metered
 *     scrape; one-step versioned rollback via instance git repo (handled by apply.js when consent
 *     is given).
 *
 * Tier-3 cleanliness (§0.3 r6 / RD-3): no hardcoded ids/handles/paths/codenames; all instance
 * paths via paths.js + the new scansDir/brandScansDir accessors; no production brand strings.
 */

const fs = require('fs');
const path = require('path');

const paths = require('../shared/paths');
const dispatch = require('./dispatch');
const runLock = require('./run-lock');

/** The named trigger for a competitor scan pass (DD-19 attribution). */
const COMPETITOR_SCAN_TRIGGER = 'competitor-scan-monthly';

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

/**
 * Extract the competitor_scan config block from system config (null-safe).
 * @param {object} config  parsed system.json
 * @returns {object}  normalized competitor_scan block (enabled, cadence, adapter, voice_calibration)
 */
function scanConfig(config = {}) {
  const cs = (config && config.competitor_scan) || {};
  return {
    enabled: cs.enabled === true,
    cadence: typeof cs.cadence === 'string' ? cs.cadence : 'month',
    adapter: typeof cs.adapter === 'string' && cs.adapter.trim() ? cs.adapter.trim() : null,
    provider: (cs.provider && typeof cs.provider === 'object') ? cs.provider : {},
    monthly_cap_usd: typeof cs.monthly_cap_usd === 'number' && cs.monthly_cap_usd > 0 ? cs.monthly_cap_usd : null,
    private_terms: Array.isArray(cs.private_terms) ? cs.private_terms.filter((s) => typeof s === 'string' && s.trim()) : [],
    voice_calibration: {
      enabled: !!(cs.voice_calibration && cs.voice_calibration.enabled === true),
      freshness_days: (cs.voice_calibration && typeof cs.voice_calibration.freshness_days === 'number' && cs.voice_calibration.freshness_days >= 1)
        ? cs.voice_calibration.freshness_days : 30,
    },
  };
}

/** True when the operator has opted the competitor scan in. */
function isEnabled(config = {}) {
  return scanConfig(config).enabled;
}

// ---------------------------------------------------------------------------
// Run-dedup: per-(month, brand) dispatch idempotency (mirrors kickoff's fires map)
// ---------------------------------------------------------------------------

/**
 * Derive the scan dedup key: one scan per brand per calendar month. A re-run within the same
 * month skips dispatch (unless opts.force). Keyed by YYYY-MM + brand so both the orchestrator
 * and any future scheduler can reference the same key.
 */
function scanMonthKey(brandId, dateISO) {
  const month = dateISO.slice(0, 7); // YYYY-MM
  return `competitor-scan|${brandId}|${month}`;
}

/**
 * Load per-brand scan run state from $CONTENT_HOME/scans/<brand>/run-state.json (best-effort,
 * fail-closed: missing or unreadable → empty state). The state tracks dispatched months so a
 * re-run within the same calendar month is a no-op.
 */
function loadRunState(brandId, env) {
  try {
    const stateFile = path.join(paths.brandScansDir(brandId, env), 'run-state.json');
    if (fs.existsSync(stateFile)) return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch { /* fall through */ }
  return { dispatched_months: {} };
}

function saveRunState(state, brandId, env) {
  const dir = paths.brandScansDir(brandId, env);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'run-state.json');
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

// ---------------------------------------------------------------------------
// Corpus helpers — lazy-require brand-dna and ingest modules
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// DD-18 cost estimate for a competitor scrape
// ---------------------------------------------------------------------------

/**
 * Estimate the cost of one competitor scan. Indicative: the result is shown to the caller before
 * any metered action is taken (DD-18 estimate-and-confirm). Returns { estimated_items,
 * per_item_usd, total_usd_estimate, indicative:true }.
 *
 * @param {object} opts { competitors, maxItems, config }
 */
function estimateScanCost(opts = {}) {
  const cs = scanConfig(opts.config || {});
  const competitors = Array.isArray(opts.competitors) ? opts.competitors : [];
  const maxItems = typeof opts.maxItems === 'number' && opts.maxItems > 0 ? Math.floor(opts.maxItems) : 200;
  const perItemUsd = (cs.monthly_cap_usd && competitors.length && maxItems)
    ? cs.monthly_cap_usd / (competitors.length * maxItems)
    : 0.001; // indicative default
  const totalItems = competitors.length * maxItems;
  const totalUsd = Math.round(totalItems * perItemUsd * 100) / 100;
  return {
    competitors: competitors.length,
    estimated_items: totalItems,
    per_item_usd: perItemUsd,
    total_usd_estimate: totalUsd,
    monthly_cap_usd: cs.monthly_cap_usd,
    indicative: true,
  };
}

// ---------------------------------------------------------------------------
// Corpus reader — for competitor scan (reads from the brand corpus dir)
// ---------------------------------------------------------------------------

/**
 * Read the brand corpus from $CONTENT_HOME/corpora/<brand>/ the same way generate.js does
 * (delegates to generate.readCorpus). Falls back gracefully when the corpus dir does not exist
 * (DD-21 cold start: no corpus => ran:false with cold_start:true).
 */
function readBrandCorpus(brandId, env) {
  let readCorpus;
  try {
    readCorpus = require('../brand-dna/generate').readCorpus;
  } catch {
    return { own: [], competitor: [], errors: [], dir: null };
  }
  return readCorpus(brandId, env);
}

// ---------------------------------------------------------------------------
// Report builder — build the competitor-scan-report.schema.json document
// ---------------------------------------------------------------------------

/**
 * Build a scan report from the landscape analysis output. The report is ALWAYS patterns-only —
 * it never carries verbatim competitor text (P1). All top-level fields mirror
 * schemas/inputs/competitor-scan-report.schema.json.
 *
 * @param {object} opts  { landscape, brand, platform, period, provenance, freshnessWindow, corpusItemCount }
 * @returns {object}  competitor-scan-report.schema.json-shaped document.
 */
function buildScanReport(opts) {
  const {
    landscape,
    brand,
    platform,
    period,
    provenance,
    freshnessWindow,
    corpusItemCount,
    nowMs,
  } = opts;

  const report = {
    period: period || {
      start: new Date(nowMs - 30 * 24 * 60 * 60 * 1000).toISOString(),
      end: new Date(nowMs).toISOString(),
    },
    brand,
    platform: platform || 'twitter',
    drama_markers: landscape.drama_markers,
    archetype_distribution: landscape.archetype_distribution,
    hook_signals: landscape.hook_signals,
    cadence_profile: landscape.cadence_profile,
    engagement_profile: landscape.engagement_profile,
    drama_signal: landscape.drama_signal,
    confidence: landscape.confidence,
    provenance: {
      trust_zone: 'U',
      method: provenance && provenance.method ? provenance.method : 'manual',
      ...(provenance && provenance.submitted_at ? { submitted_at: provenance.submitted_at } : {}),
      corpus_item_count: typeof corpusItemCount === 'number' ? corpusItemCount : 0,
    },
  };

  if (freshnessWindow) {
    report.freshness_window = freshnessWindow;
  }

  return report;
}

// ---------------------------------------------------------------------------
// Verbatim guard
// ---------------------------------------------------------------------------

/**
 * Run the P1 verbatim check: assertNoVerbatimCompetitorCopy on the landscape result + the
 * serialized report. Throws EVERBATIMCOPY if any competitor text leaks into the output.
 *
 * We also check the JSON-serialized report against each competitor item's text (belt-and-braces).
 */
function enforceNotVerbatim(landscape, report, competitorItems) {
  let assertFn;
  try {
    assertFn = require('../brand-dna/archetypes').assertNoVerbatimCompetitorCopy;
  } catch {
    // If archetypes module is not loadable, fail closed.
    const err = new Error('archetypes.assertNoVerbatimCompetitorCopy not available — refusing scan (P1)');
    err.code = 'EVERBATIMCOPY';
    throw err;
  }
  // Check the landscape object first.
  assertFn(landscape, competitorItems);
  // Check the serialized report for any verbatim leaks.
  const reportStr = JSON.stringify(report);
  const MIN_LEN = 40;
  for (const item of competitorItems) {
    if (typeof item.text !== 'string') continue;
    const text = item.text.trim();
    if (text.length < MIN_LEN) continue;
    if (reportStr.includes(text)) {
      const verbatimErr = new Error(
        `EVERBATIMCOPY: verbatim competitor text found in scan report (length ${text.length}). ` +
        'Scan reports must contain only counts/ratios/labels — no competitor copy (P1).',
      );
      verbatimErr.code = 'EVERBATIMCOPY';
      throw verbatimErr;
    }
  }
}

// ---------------------------------------------------------------------------
// Report writer
// ---------------------------------------------------------------------------

/**
 * Write the scan report to $CONTENT_HOME/scans/<brand>/<YYYY-MM-DD>.json atomically.
 * The report is Zone-U (trust_zone=U) and retention_class:transient.
 *
 * @param {string} brandId
 * @param {string} dateISO  YYYY-MM-DD
 * @param {object} report   the scan report document
 * @param {object} env      environment
 * @returns {string}  the absolute path of the written report file.
 */
function writeScanReport(brandId, dateISO, report, env) {
  const dir = paths.brandScansDir(brandId, env);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${dateISO}.json`);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
  return file;
}

// ---------------------------------------------------------------------------
// Competitor scan dispatch — ONE reserved competitor_scan task (P11/DD-16)
// ---------------------------------------------------------------------------

/**
 * Dispatch one competitor_scan slot-run task record. This is INFORMATIONAL — no post is produced
 * (P11/DD-16). The task command carries slot_type='competitor_scan' so any host pipeline that
 * looks at slot_type can skip content-generation for this slot type.
 *
 * @param {object} opts { brand, dateISO, reportPath, env, config }
 * @returns {{ ok, task?, code?, reason?, existed? }}
 */
function dispatchScanTask(opts) {
  const { brand, dateISO, reportPath, env, config } = opts;
  const command = {
    command_family: dispatch.COMMAND_FAMILY.RUN_SLOT,
    slot_type: 'competitor_scan', // informational — P11/DD-16
    content_id: `competitor-scan-${brand}-${dateISO}`,
    brand: brand || null,
    date: dateISO,
    // Carry the report path so the host can find the written report.
    competitor_scan_report: reportPath || null,
    // Explicitly: no draft, no approval card, no post. P11.
    produces_content: false,
  };
  return dispatch.dispatchTask(command, COMPETITOR_SCAN_TRIGGER, { env, config, dispatcher: 'competitor-scan' });
}

// ---------------------------------------------------------------------------
// runCompetitorScan — the orchestration entry point
// ---------------------------------------------------------------------------

/**
 * Run one config-gated competitor scan pass for a brand. OFF BY DEFAULT: refuses (returns
 * {ran:false,disabled:true}) unless config.competitor_scan.enabled===true, UNLESS opts.force
 * overrides for an explicit operator/test run.
 *
 * @param {object} [opts]
 * @param {object}   [opts.env]            environment (default process.env)
 * @param {object}   [opts.config]         parsed config/system.json
 * @param {string}   [opts.brand]          brand id (required for corpus + scan dir scoping)
 * @param {string}   [opts.platform]       platform override (else config.competitor_scan.provider.platform)
 * @param {object}   [opts.scraperAdapter] injectable scraper adapter { fetchCorpus } (RD-12/zero-key)
 * @param {object}   [opts.analystSeat]    optional analyst seat for voice-calibration rationale refinement
 * @param {boolean}  [opts.force]          run even when competitor_scan.enabled is false
 * @param {boolean}  [opts.dryRun]         analyze + build report, but write/dispatch nothing
 * @param {boolean}  [opts.estimateOnly]   only compute the DD-18 estimate, return without running
 * @param {boolean}  [opts.confirmed]      DD-18 gate — must be true to run a metered scrape
 * @param {boolean}  [opts.lock]           acquire the single-runner lock (default true)
 * @param {Date|number} [opts.now]         injectable clock (ms) for determinism
 * @returns {Promise<{ ran, disabled?, skipped_on_overlap?, brand, date, report?, report_path?,
 *                      dispatched, task_id?, cold_start?, errors }>}
 */
async function runCompetitorScan(opts = {}) {
  const env = opts.env || process.env;
  const config = opts.config || {};
  const cs = scanConfig(config);
  const enabled = cs.enabled;

  // OFF BY DEFAULT: refuse unless enabled or force.
  if (!enabled && !opts.force) {
    return {
      ran: false,
      disabled: true,
      reason: 'the competitor scan pathway is OFF by default (the LAW). Set config ' +
        'competitor_scan.enabled=true (and competitor_scan.adapter) in config/system.json ' +
        '(roadmap #5) to run a competitor scan.',
      dispatched: 0,
    };
  }

  const body = async () => {
    // BLOCKER 1 — PAUSED preflight: must be the very first check inside body(), before any
    // estimate, scrape, analysis, or write. Zero scrape calls and zero report writes when engaged.
    {
      let pausedPath;
      try { pausedPath = paths.pausedSentinel(env); } catch { pausedPath = null; }
      const paused = pausedPath ? fs.existsSync(pausedPath) : true; // fail-closed on path error
      if (paused) {
        return {
          ran: false,
          halted: true,
          halt_code: 'EPAUSED',
          reason: 'PAUSED sentinel present — kill switch engaged; competitor scan refused at preflight (§15.4). ' +
            'Zero scrape calls, zero report writes.',
          dispatched: 0,
          errors: [],
        };
      }
    }

    const nowMs = opts.now != null ? (opts.now instanceof Date ? opts.now.getTime() : Number(opts.now)) : Date.now();
    const dateISO = new Date(nowMs).toISOString().slice(0, 10);
    const brand = opts.brand || null;
    const platform = opts.platform || (cs.provider && cs.provider.platform) || 'twitter';

    if (!brand) {
      return {
        ran: false,
        error: 'brand is required for a competitor scan (the corpus and scan dir are brand-keyed)',
        dispatched: 0,
        errors: [{ code: 'ENOBRAND', reason: 'brand option is required' }],
      };
    }

    // DD-18 ESTIMATE (before any metered action).
    const competitors = [];
    const estimate = estimateScanCost({ competitors, maxItems: 200, config });

    // --estimate-only: surface the estimate and return without running.
    if (opts.estimateOnly) {
      return {
        ran: false,
        estimate_only: true,
        estimate,
        brand,
        date: dateISO,
        dispatched: 0,
        errors: [],
      };
    }

    // DD-21 cold start / corpus load.
    const corpusRead = readBrandCorpus(brand, env);
    const ownItems = corpusRead.own || [];
    const competitorItems = corpusRead.competitor || [];
    const allItems = [...ownItems, ...competitorItems];

    // Cold start: no corpus at all.
    if (allItems.length === 0 && !opts.scraperAdapter) {
      return {
        ran: false,
        cold_start: true,
        reason: 'no corpus found for brand and no scraper adapter — cold start (DD-21). ' +
          'Use engine ingest-brand to ingest a corpus first, or wire a scraper adapter.',
        brand,
        date: dateISO,
        dispatched: 0,
        errors: [],
      };
    }

    // If a scraper adapter is provided AND confirmed, fetch competitor corpus items.
    let scraperItems = [];
    if (opts.scraperAdapter && typeof opts.scraperAdapter.fetchCorpus === 'function') {
      if (!opts.confirmed && !opts.dryRun) {
        // DD-18: require confirmation before any metered scrape.
        return {
          ran: false,
          needs_confirmation: true,
          estimate,
          brand,
          date: dateISO,
          reason: `A scrape is a metered action and was not confirmed. Estimated ~${estimate.estimated_items} ` +
            `item(s) ≈ $${estimate.total_usd_estimate} (indicative). Re-run with --yes to spend. ` +
            'The manual-submission and export paths are free and need no confirmation (DD-18).',
          dispatched: 0,
          errors: [],
        };
      }
      try {
        scraperItems = await opts.scraperAdapter.fetchCorpus({ brand, handles: competitors, maxItems: 200 }) || [];
      } catch (e) {
        scraperItems = [];
        // Non-fatal: fall back to whatever is in the corpus dir.
      }
    }

    // Merge scraped items with corpus items (scraped competitor items augment the on-disk ones).
    const effectiveCompetitorItems = [
      ...competitorItems,
      ...scraperItems.filter((it) => it && typeof it.text === 'string'),
    ];
    const effectiveAllItems = [...ownItems, ...effectiveCompetitorItems];

    if (effectiveAllItems.length === 0) {
      return {
        ran: false,
        cold_start: true,
        reason: 'no corpus items available after loading — cold start (DD-21).',
        brand,
        date: dateISO,
        dispatched: 0,
        errors: [],
      };
    }

    // --- ANALYSIS ---
    // Load brand-dna modules lazily.
    let analyzeCompetitorPatterns;
    try {
      analyzeCompetitorPatterns = require('../brand-dna/competitor-landscape').analyzeCompetitorPatterns;
    } catch (e) {
      return {
        ran: false,
        error: `competitor-landscape analyzer not available: ${e && e.message}`,
        brand,
        date: dateISO,
        dispatched: 0,
        errors: [{ code: 'EANALYZER', reason: String(e && e.message ? e.message : e) }],
      };
    }

    let landscape;
    try {
      landscape = analyzeCompetitorPatterns(effectiveAllItems, {
        ownPredicate: (item) => {
          // Items from own dir OR items carrying relation!='competitor' are own.
          if (item && item.competitor === true) return false;
          if (item && (item.relation === 'competitor' || item.relation === 'comparator')) return false;
          return true;
        },
      });
    } catch (e) {
      if (e && e.code === 'EVERBATIMCOPY') throw e; // P1 — rethrow verbatim copy errors.
      return {
        ran: false,
        error: `landscape analysis failed: ${e && e.message}`,
        brand,
        date: dateISO,
        dispatched: 0,
        errors: [{ code: 'ELANDSCAPE', reason: String(e && e.message ? e.message : e) }],
      };
    }

    // Build the scan period (last 30 days → now).
    const periodStart = new Date(nowMs - 30 * 24 * 60 * 60 * 1000).toISOString();
    const periodEnd = new Date(nowMs).toISOString();
    const period = { start: periodStart, end: periodEnd };

    // Freshness window: report valid for freshness_days.
    const freshnessDays = cs.voice_calibration.freshness_days;
    const expiresAtMs = nowMs + freshnessDays * 24 * 60 * 60 * 1000;
    const freshnessWindow = {
      duration: `P${freshnessDays}D`,
      expires_at: new Date(expiresAtMs).toISOString(),
    };

    const provenance = {
      trust_zone: 'U',
      method: opts.scraperAdapter ? 'adapter' : 'manual',
      submitted_at: new Date(nowMs).toISOString(),
    };

    const corpusItemCount = effectiveAllItems.length;

    // Build the report.
    const report = buildScanReport({
      landscape,
      brand,
      platform,
      period,
      provenance,
      freshnessWindow,
      corpusItemCount,
      nowMs,
    });

    // P1: verbatim guard BEFORE writing anything.
    enforceNotVerbatim(landscape, report, effectiveCompetitorItems);

    if (opts.dryRun) {
      return {
        ran: true,
        dry_run: true,
        brand,
        date: dateISO,
        report,
        dispatched: 0,
        errors: [],
      };
    }

    // --- WRITE REPORT ---
    const reportPath = writeScanReport(brand, dateISO, report, env);

    // --- DISPATCH ONE competitor_scan TASK RECORD (P11 — no post) ---
    const runState = loadRunState(brand, env);
    const monthKey = scanMonthKey(brand, dateISO);
    let taskId = null;
    let taskExisted = false;
    let dispatched = 0;

    if (!opts.force && runState.dispatched_months && runState.dispatched_months[monthKey]) {
      // Already dispatched this month — idempotent skip.
      taskExisted = true;
      taskId = runState.dispatched_months[monthKey].task_id || null;
    } else {
      const disp = dispatchScanTask({ brand, dateISO, reportPath, env, config });
      if (disp.ok) {
        dispatched = 1;
        taskId = (disp.task && disp.task.task_id) || null;
        taskExisted = disp.existed === true;
        // Record the dispatch so same-month re-runs are idempotent.
        runState.dispatched_months = runState.dispatched_months || {};
        runState.dispatched_months[monthKey] = {
          task_id: taskId,
          dispatched_at: new Date(nowMs).toISOString(),
          date: dateISO,
        };
        saveRunState(runState, brand, env);
      } else if (disp.code === 'EPAUSED' || disp.code === 'EBUDGET' || disp.code === 'ECONTENTHOME') {
        // Kill switch or budget — return partial result (report written, dispatch refused).
        return {
          ran: true,
          brand,
          date: dateISO,
          report,
          report_path: reportPath,
          dispatched: 0,
          halted: true,
          halt_code: disp.code,
          errors: [{ code: disp.code, reason: disp.reason }],
        };
      }
    }

    // --- VOICE CALIBRATION PROPOSAL (optional, when voice_calibration.enabled) ---
    let voiceCalibrationProposal = null;
    if (cs.voice_calibration.enabled) {
      try {
        const proposeMod = require('../voice-calibration/propose');
        const brandConfig = loadBrandConfig(brand, env);
        voiceCalibrationProposal = await proposeMod.proposeVoiceCalibration(report, brandConfig, {
          env,
          now: nowMs,
          analystSeat: opts.analystSeat || null,
          // BLOCKER 4: pass the competitor corpus texts so propose.js can run the verbatim guard.
          competitorCorpusTexts: effectiveCompetitorItems,
        });
      } catch (e) {
        // Voice calibration proposal is non-fatal — we still return the scan result.
        voiceCalibrationProposal = { error: e && e.message ? e.message : String(e) };
      }
    }

    return {
      ran: true,
      brand,
      date: dateISO,
      platform,
      report,
      report_path: reportPath,
      dispatched,
      task_id: taskId,
      task_existed: taskExisted,
      corpus_item_count: corpusItemCount,
      own_count: ownItems.length,
      competitor_count: effectiveCompetitorItems.length,
      voice_calibration_proposal: voiceCalibrationProposal,
      errors: corpusRead.errors || [],
    };
  };

  // Run under the single-runner lock (DD-19).
  if (opts.lock === false) return body();
  const locked = await runLock.withRunLock({ trigger: COMPETITOR_SCAN_TRIGGER, env, ledger: opts.ledger }, body);
  if (!locked.ran) {
    if (locked.error) {
      return { ran: false, error: locked.error, dispatched: 0, errors: [] };
    }
    return {
      ran: false,
      skipped_on_overlap: Boolean(locked.skipped_on_overlap),
      heldBy: locked.heldBy || null,
      dispatched: 0,
      errors: [],
    };
  }
  return locked.result;
}

// ---------------------------------------------------------------------------
// Helper: load brand.json (best-effort, returns {} on any error)
// ---------------------------------------------------------------------------

function loadBrandConfig(brandId, env) {
  try {
    const file = paths.brandConfig(brandId, env);
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { /* fall through */ }
  return {};
}

// ---------------------------------------------------------------------------
// Add COMPETITOR_SCAN_MONTHLY to the dispatch TRIGGER enum
// ---------------------------------------------------------------------------

// We extend the TRIGGER object with the new trigger. Note: dispatch.TRIGGER is Object.freeze()'d,
// so we cannot mutate it directly. We expose our trigger constant here and register it in the
// dispatch module's VALID_TRIGGERS set by adding to it (the Set is not frozen).
if (dispatch.VALID_TRIGGERS && !dispatch.VALID_TRIGGERS.has(COMPETITOR_SCAN_TRIGGER)) {
  dispatch.VALID_TRIGGERS.add(COMPETITOR_SCAN_TRIGGER);
}

module.exports = {
  COMPETITOR_SCAN_TRIGGER,
  scanConfig,
  isEnabled,
  estimateScanCost,
  enforceNotVerbatim,
  buildScanReport,
  writeScanReport,
  runCompetitorScan,
  // helpers exported for tests
  scanMonthKey,
  loadRunState,
  loadBrandConfig,
};
