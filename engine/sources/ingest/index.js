'use strict';

/**
 * engine/sources/ingest/index.js  [N net-new]
 *
 * The BRAND/COMPETITOR INGESTION SOURCE public entry point (release-spec §2.4 C2 corpus intake, the
 * three supported paths — RD-9; original-design-spec §1.1/§1.2; roadmap #2). Re-exports the seam
 * (ingestCorpus, the adapter interface, the registry, the cost-estimate gate) and the FIRST-CLASS
 * no-scraper import helpers (importManualSubmission, importAccountExport), and ensures the two
 * shipped adapters self-register on require, so importing this one module gives a populated registry
 * (reference + fixture) — mirroring the trend + publisher seams' import-to-register convention.
 *
 * Importing this module does NOT enable the SCRAPER pathway: it ships CONFIG-GATED and OFF BY
 * DEFAULT (the LAW). ingestCorpus throws IngestDisabledError until the operator sets
 * `ingest.enabled: true` (and an `ingest.adapter`) in config/system.json, and refuses any metered
 * scrape without the DD-18 estimate-and-confirm. Requiring the adapters only makes them AVAILABLE to
 * be selected; it contacts no provider and reads no credential. The MANUAL submission and
 * OFFICIAL-ACCOUNT EXPORT helpers need no opt-in and are ALWAYS available (the cold-start fallback,
 * DD-21) — onboarding never blocks.
 *
 * Usage (the C2 setup checkpoint / orchestrator calls this):
 *   const ingest = require('engine/sources/ingest');
 *
 *   // First-class, no keys, no opt-in — always works:
 *   ingest.importManualSubmission({ brand, dir });               // drop files -> corpus
 *   ingest.importAccountExport({ brand, file, format:'twitter', handle });  // own export -> corpus
 *
 *   // BYO scraper (off by default + metered): show the estimate, then confirm.
 *   const est = ingest.estimateScrapeCost({ account, competitors, max });   // DD-18 pre-run estimate
 *   const result = await ingest.ingestCorpus({ config, brand, account, competitors, since, confirmed:true });
 *   // result.written -> $CONTENT_HOME/corpora/<brand>/*.json (Zone-U, trust-tagged, purge-managed)
 *
 * Custom adapters: register through the seam exactly like the shipped ones —
 *   require('engine/sources/ingest').register('my-provider', { async fetch(args) { … } });
 */

const source = require('./source');
const manual = require('./manual');

// Self-register the shipped adapters (each calls source.register on require).
const referenceAdapter = require('./reference-adapter');
const fixtureAdapter = require('./fixture-adapter');

module.exports = {
  // The orchestration entry point (the LAW: export ingestCorpus).
  ingestCorpus: source.ingestCorpus,

  // The FIRST-CLASS no-scraper import helpers (the LAW: export the manual import helpers).
  importManualSubmission: manual.importManualSubmission,
  importAccountExport: manual.importAccountExport,
  CONVERTERS: manual.CONVERTERS,
  exportFormats: manual.exportFormats,

  // The adapter interface + registry (the LAW: export the adapter interface and a registry).
  REQUIRED_METHODS: source.REQUIRED_METHODS,
  register: source.register,
  get: source.get,
  has: source.has,
  list: source.list,
  unregister: source.unregister,
  isAdapter: source.isAdapter,
  missingMethods: source.missingMethods,

  // Vocabulary (corpus-item.schema.json enums + own/competitor labels).
  SOURCE: source.SOURCE,
  TRUST_CLASS: source.TRUST_CLASS,
  RETENTION_CLASS: source.RETENTION_CLASS,
  ACCOUNT_CLASS: source.ACCOUNT_CLASS,

  // Config gate (off by default for the scraper path) + cost estimate (DD-18).
  ingestConfig: source.ingestConfig,
  isEnabled: source.isEnabled,
  estimateScrapeCost: source.estimateScrapeCost,

  // Item validation / normalization / write (under CONTENT_HOME via paths.js).
  validateItem: source.validateItem,
  normalizeItem: source.normalizeItem,
  corpusDir: source.corpusDir,
  writeItem: source.writeItem,
  ingestRawItems: source.ingestRawItems,

  // Typed errors callers branch on.
  IngestDisabledError: source.IngestDisabledError,
  IngestNotConfirmedError: source.IngestNotConfirmedError,
  IngestAdapterNotRegisteredError: source.IngestAdapterNotRegisteredError,

  // The shipped adapters (also registered under "reference" / "fixture").
  referenceAdapter,
  fixtureAdapter,
};
