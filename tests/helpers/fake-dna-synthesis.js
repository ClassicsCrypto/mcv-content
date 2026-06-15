'use strict';

/**
 * tests/helpers/fake-dna-synthesis.js  [BD-FIXTURES]
 *
 * Zero-key fake DNA-SYNTHESIS seat for the brand-identity pathway (release-spec §1.1 Brand DNA
 * Generation; RD-2 "the engine NEVER calls chain/analysis LLMs directly — DNA synthesis is a HOST
 * seat the runtime wires, INJECTABLE for tests like the §12.5 vision seam"; RD-12 zero-key fixture
 * test). This is the brand-DNA counterpart of tests/helpers/fake-vision.js (the injected vision
 * seam) and fake-scraper-adapter.js (the injected scraper seam).
 *
 * The production DNA seat is handed the DETERMINISTIC corpus analysis (auditable stats — produced
 * by the engine with NO LLM) and returns brand-DNA voice PROSE. The engine ships the SEAM; the
 * host runtime wires a real seat. DNA synthesis is a METERED action gated by a pre-run cost
 * estimate (DD-18). When NO seat is wired the flow degrades gracefully to the manual authoring
 * template (DD-21) — this fake exists only to exercise the seat-wired path zero-key.
 *
 * The fake replays the canned output recorded in
 *   fixtures/brand-dna-acme/recorded/dna-synthesis.json
 * keyed by brand id. The returned brand_dna_md carries DERIVED patterns only and NO verbatim
 * competitor copy (the no-verbatim-check.json test asserts this against the output).
 *
 * Injection shape (matches a host DNA-synthesis seat interface — RD-2):
 *   makeFakeDnaSynthesis() -> { name, synthesize, estimate, capabilities }
 *     synthesize({ brand, analysis }) => Promise<{ brand_dna_md, synthesis_meta }>
 *       Replays the recorded markdown for `brand` (deep-cloned). `analysis` is accepted (the real
 *       seat consumes it) but the fake returns canned prose regardless — deterministic for tests.
 *       An unknown brand THROWS (unrecorded brand = test bug, not a silent pass); pass
 *       { onMissing: 'null' } to instead resolve null (degrade / no-seat-style path).
 *     estimate({ analysis_tokens_est }) => { est_cost_usd, requires_confirm }  the DD-18 estimate.
 *     capabilities() => static { name, methods, requires_key: false }.
 *
 * makeFakeSynthesize() returns just the synthesize fn for code that injects the function directly.
 *
 * ALL FIXTURES ARE SYNTHETIC. The seat holds NO credentials and performs NO I/O beyond reading the
 * recorded JSON. See fixtures/brand-dna-acme/PROVENANCE.md and fixtures/PROVENANCE.md.
 */

const fs = require('node:fs');
const path = require('node:path');

const RECORDING_PATH = path.join(
  __dirname, '..', '..', 'fixtures', 'brand-dna-acme', 'recorded', 'dna-synthesis.json',
);

/** Load + cache the recorded output, stripping the documentation $comment key. */
let _cache = null;
function loadRecording() {
  if (_cache) return _cache;
  const raw = JSON.parse(fs.readFileSync(RECORDING_PATH, 'utf8'));
  const out = {};
  for (const [key, val] of Object.entries(raw)) {
    if (key === '$comment') continue;
    out[key] = val;
  }
  _cache = out;
  return out;
}

/** Deep clone via JSON so callers can mutate returned output without poisoning the fixture. */
function clone(obj) {
  return obj == null ? obj : JSON.parse(JSON.stringify(obj));
}

/**
 * Build the fake synthesize(req) the brand-DNA flow injects.
 * @param {object} [opts]
 * @param {'throw'|'null'} [opts.onMissing='throw']  behavior for an unrecorded brand id.
 * @returns {function(object): Promise<object|null>}
 */
function makeFakeSynthesize(opts = {}) {
  const onMissing = opts.onMissing === 'null' ? 'null' : 'throw';
  const recording = loadRecording();
  return async function fakeSynthesize(req = {}) {
    const brand = String(req.brand || '').trim();
    if (Object.prototype.hasOwnProperty.call(recording, brand)) {
      return clone(recording[brand]);
    }
    if (onMissing === 'null') return null;
    throw new Error(
      `fake-dna-synthesis: no recorded output for brand "${brand}" (have: ${Object.keys(recording).join(', ')})`,
    );
  };
}

/**
 * The zero-spend pre-run cost estimate the DD-18 gate presents before DNA synthesis.
 * @param {object} [q]  { analysis_tokens_est }
 */
function estimate(q = {}) {
  return {
    action: 'dna-synthesis',
    analysis_tokens_est: Number(q.analysis_tokens_est) || 0,
    est_cost_usd: 0,
    requires_confirm: true,
    note: 'fixture seat — zero spend; a real host seat reports actual metered spend the budget caps',
  };
}

/**
 * Build a full fake seat object conforming to a host DNA-synthesis seat interface (RD-2).
 * @param {object} [opts]  same { onMissing } contract as makeFakeSynthesize.
 */
function makeFakeDnaSynthesis(opts = {}) {
  const synthesize = makeFakeSynthesize(opts);
  return {
    name: 'fixture-dna-seat',
    synthesize,
    estimate,
    capabilities() {
      return {
        name: 'fixture-dna-seat',
        methods: ['synthesize', 'estimate'],
        requires_key: false,
      };
    },
  };
}

/** Brand ids present in the recording (handy for a test that iterates the fixture set). */
function recordedBrands() {
  return Object.keys(loadRecording());
}

module.exports = {
  RECORDING_PATH,
  makeFakeDnaSynthesis,
  makeFakeSynthesize,
  estimate,
  recordedBrands,
};
