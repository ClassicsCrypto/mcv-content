'use strict';

/**
 * tests/helpers/fake-memory-reader.js  [SRC-FIXTURES]
 *
 * Zero-key injectable MEMORY READER for the WORK-RECAP content source (release-spec §3.3 operator/
 * founder/team accounts with flexible voice; §2.1 seeding; §12 injectable seams; §13.3 redaction;
 * RD-12 "CI holds no secrets — the external call/read MUST be dependency-injectable so tests run
 * ZERO-KEY with a fake"). It is the memory-pathway counterpart of tests/helpers/fake-vision.js and
 * tests/helpers/fake-trend-adapter.js.
 *
 * Why injectable: the work-recap source ships the MECHANISM pointed at a CONFIGURED memory path; it
 * NEVER bundles or commits real memory. So the file-reading edge is a seam: production resolves the
 * operator's configured `work_recap.memory_path`; tests inject THIS reader pointed at the SYNTHETIC
 * fixture memory under fixtures/work-recap-acme/ (a fake MEMORY.md + memory/YYYY-MM-DD.md daily
 * files describing fictional Acme Cosmos work). PRIVACY IS LOAD-BEARING: that fixture memory PLANTS
 * sensitive items (an obviously-fake secret, a fake partner, an unreleased codename) so a test can
 * prove the redaction pre-pass + gate leak-check BLOCK them before the human approval card.
 *
 * The work-recap pathway is a CONTENT SOURCE, not a publish bypass: a memory read yields a pre-seed
 * (§2.1) that feeds the EXISTING chain (matcher → brief → writer → the hybrid gate incl. the
 * privacy/leak check → package → queue → the HUMAN approval card, §2.4). Nothing here auto-publishes;
 * SAFE is the default.
 *
 * Exports a reader bound to a base dir (defaults to the fixture memory dir):
 *   makeFakeMemoryReader({ baseDir? }) -> {
 *     baseDir,
 *     readMemoryFile(relPath) -> string                 // raw text of one memory file
 *     readCurated() -> string                           // MEMORY.md (the curated long-term file)
 *     readDaily(date) -> string                         // memory/<date>.md  (date = 'YYYY-MM-DD')
 *     listDailyDates() -> string[]                      // sorted YYYY-MM-DD of the daily files
 *     readRecent({ days?, dates? }) -> Array<{date, path, text}>   // recent daily logs (recap window)
 *     loadPrivateTerms() -> { case_insensitive, terms[], secret_literals[] }  // config-extendable deny list
 *     loadExpectedLeakCheck() -> object                 // the ground-truth pins (expected/leak-check.json)
 *   }
 *
 * HONEST-STATUS: a missing memory file THROWS (a test asking for an unrecorded file is a test bug,
 * not a silent pass) — matching the engine's "never fabricate" rule.
 *
 * This reader performs NO redaction itself — it is the raw-read seam. The redaction pre-pass
 * (engine/shared/redact.js + the deny list) and the gate privacy/leak check run on what it returns,
 * which is exactly what makes the planted-secret block testable end to end.
 *
 * ALL FIXTURES ARE SYNTHETIC. See fixtures/work-recap-acme/PROVENANCE.md and fixtures/PROVENANCE.md.
 */

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_BASE = path.join(__dirname, '..', '..', 'fixtures', 'work-recap-acme');
const DAILY_RE = /^(\d{4}-\d{2}-\d{2})\.md$/;

function readFileOrThrow(file, label) {
  if (!fs.existsSync(file)) {
    throw new Error(`fake-memory-reader: ${label || 'memory file'} not found (${file})`);
  }
  return fs.readFileSync(file, 'utf8');
}

/**
 * @param {object} [opts]
 * @param {string} [opts.baseDir]  the configured memory path to read (defaults to the fixture dir).
 */
function makeFakeMemoryReader(opts = {}) {
  const baseDir = opts.baseDir || DEFAULT_BASE;

  function readMemoryFile(relPath) {
    const full = path.join(baseDir, relPath);
    return readFileOrThrow(full, `memory file "${relPath}"`);
  }

  function readCurated() {
    return readMemoryFile('MEMORY.md');
  }

  function readDaily(date) {
    return readMemoryFile(path.join('memory', `${date}.md`));
  }

  function listDailyDates() {
    const dir = path.join(baseDir, 'memory');
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .map((name) => {
        const m = DAILY_RE.exec(name);
        return m ? m[1] : null;
      })
      .filter(Boolean)
      .sort();
  }

  /**
   * The recap window: recent daily logs. By default returns ALL daily files (sorted); pass
   * { dates: [...] } to select explicit dates or { days: N } to take the last N by sort order.
   * @returns {Array<{date:string, path:string, text:string}>}
   */
  function readRecent(sel = {}) {
    let dates = listDailyDates();
    if (Array.isArray(sel.dates) && sel.dates.length) {
      dates = sel.dates.slice().sort();
    } else if (Number.isInteger(sel.days) && sel.days > 0) {
      dates = dates.slice(-sel.days);
    }
    return dates.map((date) => ({
      date,
      path: path.join('memory', `${date}.md`),
      text: readDaily(date),
    }));
  }

  function loadPrivateTerms() {
    const raw = JSON.parse(readFileOrThrow(path.join(baseDir, 'private-terms.json'), 'private-terms.json'));
    delete raw.$comment;
    return raw;
  }

  function loadExpectedLeakCheck() {
    const raw = JSON.parse(
      readFileOrThrow(path.join(baseDir, 'expected', 'leak-check.json'), 'expected/leak-check.json'),
    );
    delete raw.$comment;
    return raw;
  }

  return {
    baseDir,
    readMemoryFile,
    readCurated,
    readDaily,
    listDailyDates,
    readRecent,
    loadPrivateTerms,
    loadExpectedLeakCheck,
  };
}

module.exports = {
  DEFAULT_BASE,
  makeFakeMemoryReader,
};
