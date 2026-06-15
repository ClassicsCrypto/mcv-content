'use strict';

/**
 * engine/sources/trends/index.js  [N net-new]
 *
 * The TREND SOURCE public entry point (release-spec §8.8 trend pathway; §12.1 #1 scraper/trend
 * seam; roadmap automation #1). Re-exports the seam (pollTrends, the adapter interface, and the
 * registry) and ensures the two shipped adapters self-register on require, so that importing this
 * one module gives a populated registry (reference + fixture) — mirroring the publisher seam's
 * import-to-register convention.
 *
 * Importing this module does NOT enable the pathway: the trend source ships CONFIG-GATED and OFF BY
 * DEFAULT (the LAW). pollTrends throws TrendsDisabledError until the operator sets
 * `trends.enabled: true` (and a `trends.adapter`) in config/system.json (§8.8). Requiring the
 * adapters only makes them AVAILABLE to be selected; it contacts no provider and reads no credential.
 *
 * Usage (the operator's scheduler recipe / orchestrator calls this):
 *   const trends = require('engine/sources/trends');
 *   const result = await trends.pollTrends({ config, brand });   // throws if disabled
 *   // result.reports -> §6.7 trend reports written under $CONTENT_HOME/trends/ as SEEDS that the
 *   // chain processes for trend-RESERVED calendar slots (DD-16) to a human approval card (§2.4).
 *
 * Custom adapters: register through the seam exactly like the shipped ones —
 *   require('engine/sources/trends').register('my-provider', { async poll(args) { … } });
 */

const source = require('./source');

// Self-register the shipped adapters (each calls source.register on require).
const referenceAdapter = require('./reference-adapter');
const fixtureAdapter = require('./fixture-adapter');

module.exports = {
  // The orchestration entry point (the LAW: export pollTrends).
  pollTrends: source.pollTrends,

  // The adapter interface + registry (the LAW: export the adapter interface and a registry).
  REQUIRED_METHODS: source.REQUIRED_METHODS,
  register: source.register,
  get: source.get,
  has: source.has,
  list: source.list,
  unregister: source.unregister,
  isAdapter: source.isAdapter,
  missingMethods: source.missingMethods,

  // Cadences (§8.8) + the off-by-default config gate.
  CADENCE: source.CADENCE,
  VALID_CADENCES: source.VALID_CADENCES,
  trendsConfig: source.trendsConfig,
  isEnabled: source.isEnabled,
  resolveCadence: source.resolveCadence,

  // Report validation / normalization / write (under CONTENT_HOME via paths.js).
  validateReport: source.validateReport,
  normalizeReport: source.normalizeReport,
  reportDir: source.reportDir,
  writeReport: source.writeReport,

  // Typed errors callers branch on.
  TrendsDisabledError: source.TrendsDisabledError,
  TrendSourceNotRegisteredError: source.TrendSourceNotRegisteredError,

  // The shipped adapters (also registered under "reference" / "fixture").
  referenceAdapter,
  fixtureAdapter,
};
