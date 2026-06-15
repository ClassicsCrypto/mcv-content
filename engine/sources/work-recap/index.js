'use strict';

/**
 * engine/sources/work-recap/index.js  [N net-new]
 *
 * The MEMORY SOURCE for the work-recap / build-in-public pathway (release-spec §2.1 seeding;
 * §3.3 operator/founder/team accounts; §2.4 the double gate; §8.8 a source feeds the EXISTING
 * chain; §12 seams; §13.3 redact-at-write; original-design-spec §1.4 reporting).
 *
 * Public surface (the two functions the prompt requires plus the privacy helpers a host/gate may
 * reuse):
 *   - scanMemory(opts)          → scan a CONFIGURED external memory path and extract recent RAW
 *                                 work items. OFF BY DEFAULT (work_recap.enabled). Clean no-op for
 *                                 missing/empty path. fs injectable for zero-key tests.
 *   - buildWorkRecapSeed(opts)  → scan + run the PRIVACY PRE-PASS + emit a sanitized WORK-RECAP
 *                                 SEED (sanitized work summary + build-in-public angle +
 *                                 privacy_flags for the downstream gate). Hands the matcher a
 *                                 pre-seed; NEVER auto-publishes; NEVER bundles real memory.
 *   - sanitizeText / sanitizeItems → the privacy pre-pass, exposed so the gate's privacy/leak
 *                                 check can re-verify residual leakage on the draft.
 *
 * This source is CONFIG-GATED and OFF BY DEFAULT; the operator opts in via the `work_recap`
 * config block. The repo ships the mechanism pointed at a configured path; it ships NO real memory.
 */

const { scanMemory, workRecapConfig } = require('./scan-memory.js');
const { buildWorkRecapSeed, SEED_SOURCE, SEED_SLOT_TYPE } = require('./build-seed.js');
const { sanitizeText, sanitizeItems } = require('./privacy-filter.js');

module.exports = {
  // Required public API.
  scanMemory,
  buildWorkRecapSeed,
  // Config helper + seed constants.
  workRecapConfig,
  SEED_SOURCE,
  SEED_SLOT_TYPE,
  // Privacy pre-pass, reusable by the downstream gate's privacy/leak check.
  sanitizeText,
  sanitizeItems,
};
