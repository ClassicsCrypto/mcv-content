'use strict';

/**
 * tests/helpers/fake-vision.js  [LIB-FIXTURES]
 *
 * Zero-key fake vision provider for library-indexer tests (release-spec §1.5 auto-index/tag;
 * §12.5 vision-provider seam; §15.4 / DD-18 metered-action estimate-and-confirm; fixtures §5;
 * RD-12 "CI holds no secrets — the vision call MUST be dependency-injectable so tests run
 * ZERO-KEY with a fake vision function").
 *
 * This is the test-side counterpart of the §12.5 provider seam's injectable spawnSync (see
 * engine/gate/visual-check/__tests__/visual-check.test.js `stubProviderReturning`). It lets a
 * library-indexer test exercise the WHOLE describe/tag path with zero keys, zero network, and
 * zero real image decoding: every answer is read from the recorded fixture responses in
 * fixtures/library-acme/expected/vision-responses.json, keyed by the asset's BASENAME.
 *
 * Two consumption shapes are exported so a test can inject at whichever layer it owns:
 *
 *   makeFakeVisionFn()  -> visionFn(filenameOrPath) => { type, description, tags, ... }
 *       The high-level injection LIB-CORE consumes via `opts.visionFn`. Returns the recorded
 *       structured answer object (deep-cloned so a caller mutating it can't poison the fixture).
 *       Accepts a full path or a bare filename; only the basename is used to look up the answer.
 *
 *   makeFakeSpawnSync() -> spawnSync(cmd, args, opts) => { status, stdout, stderr }
 *       The low-level injection for code that goes through engine/gate/visual-check/provider.js
 *       (the CLI provider). It mirrors the real provider contract: the image path is the LAST
 *       argv value, so we look the answer up by basename(lastArg) and return it as one JSON line
 *       on stdout (the provider/parser reads a JSON-line event stream). shell:false-safe — it
 *       never executes anything.
 *
 * HONEST-STATUS: an unknown filename throws (a test asking for an unrecorded asset is a test
 * bug, not a silent pass) — matching the engine's "never fabricate a pass" rule. Use
 * makeFakeVisionFn({ onMissing: 'skip' }) to instead return null (degrade-to-skip) when a test
 * deliberately exercises the missing-answer path.
 *
 * ALL FIXTURES ARE SYNTHETIC. See fixtures/library-acme/PROVENANCE.md and fixtures/PROVENANCE.md.
 */

const fs = require('node:fs');
const path = require('node:path');

const RESPONSES_PATH = path.join(
  __dirname, '..', '..', 'fixtures', 'library-acme', 'expected', 'vision-responses.json',
);

/** Load + cache the recorded responses, stripping the documentation $comment key. */
let _cache = null;
function loadResponses() {
  if (_cache) return _cache;
  const raw = JSON.parse(fs.readFileSync(RESPONSES_PATH, 'utf8'));
  const out = {};
  for (const [key, val] of Object.entries(raw)) {
    if (key === '$comment') continue;
    out[key] = val;
  }
  _cache = out;
  return out;
}

/** Normalize any path/filename to the lookup key (basename, forward-slash safe). */
function toKey(filenameOrPath) {
  return path.basename(String(filenameOrPath || '').replace(/\\/g, '/'));
}

/** Deep clone via JSON so callers can mutate returned answers without poisoning the fixture. */
function clone(obj) {
  return obj == null ? obj : JSON.parse(JSON.stringify(obj));
}

/**
 * Build the high-level fake visionFn that LIB-CORE injects via opts.visionFn.
 * @param {object} [opts]
 * @param {'throw'|'skip'} [opts.onMissing='throw']  behavior for an unrecorded filename.
 * @returns {function(string): (object|null)}
 */
function makeFakeVisionFn(opts = {}) {
  const onMissing = opts.onMissing === 'skip' ? 'skip' : 'throw';
  const responses = loadResponses();
  return function fakeVisionFn(filenameOrPath) {
    const key = toKey(filenameOrPath);
    if (Object.prototype.hasOwnProperty.call(responses, key)) {
      return clone(responses[key]);
    }
    if (onMissing === 'skip') return null;
    throw new Error(
      `fake-vision: no recorded response for "${key}" (have: ${Object.keys(responses).join(', ')})`,
    );
  };
}

/**
 * Build a fake spawnSync for code that drives the §12.5 CLI provider seam directly. Returns the
 * recorded answer as a single JSON line on stdout (the provider parser reads JSON-line streams).
 * The image path is taken from the LAST argv value, matching provider.js's `[...args, imageFlag,
 * imagePath]` layout (the image path is the only attacker-influenced argv, always last).
 * @param {object} [opts]  same { onMissing } contract as makeFakeVisionFn.
 * @returns {function(string, string[], object): {status:number, stdout:string, stderr:string}}
 */
function makeFakeSpawnSync(opts = {}) {
  const visionFn = makeFakeVisionFn(opts);
  return function fakeSpawnSync(_cmd, args, _spawnOpts) {
    const argv = Array.isArray(args) ? args : [];
    const imagePath = argv.length ? argv[argv.length - 1] : '';
    const answer = visionFn(imagePath);
    if (answer == null) {
      // Degrade-to-skip path: emit nothing parseable; caller treats as no-answer.
      return { status: 0, stdout: '', stderr: '' };
    }
    return { status: 0, stdout: `${JSON.stringify(answer)}\n`, stderr: '' };
  };
}

/** All recorded filenames (handy for a test that iterates the fixture set). */
function recordedFilenames() {
  return Object.keys(loadResponses());
}

/** The raw recorded answer for one filename (no clone) — for read-only assertions. */
function recordedAnswer(filenameOrPath) {
  const responses = loadResponses();
  return responses[toKey(filenameOrPath)] || null;
}

module.exports = {
  RESPONSES_PATH,
  makeFakeVisionFn,
  makeFakeSpawnSync,
  recordedFilenames,
  recordedAnswer,
  toKey,
};
