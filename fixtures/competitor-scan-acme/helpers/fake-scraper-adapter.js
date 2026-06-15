'use strict';

/**
 * fixtures/competitor-scan-acme/helpers/fake-scraper-adapter.js  [CS-FIXTURES]
 *
 * Zero-key fake scraper adapter for competitor-scan tests (roadmap #5; RD-12 zero-key offline).
 * Returns the fixture corpus items pre-loaded from fixtures/competitor-scan-acme/corpora/ without
 * any network call, credentials, or Date.now/Math.random usage.
 *
 * Interface contract (mirrors the BYO scraper adapter contract consumed by runCompetitorScan):
 *   fetchCorpus({ brand, handles, maxItems }) -> Promise<CorpusItem[]>
 *
 * The returned items are a COPY (no mutation of the fixture data). Trust-class is set to
 * untrusted-scraped (Zone U, RD-8) on every item, matching what a real adapter would stamp.
 *
 * Usage in tests:
 *   const adapter = require('../../fixtures/competitor-scan-acme/helpers/fake-scraper-adapter');
 *   const items = await adapter.fetchCorpus({ brand: 'acme-cosmos', handles: [...], maxItems: 200 });
 */

const fs = require('fs');
const path = require('path');

const FIXTURE_CORPORA = path.resolve(__dirname, '..', 'corpora');

/**
 * Return corpus items for the given brand and handles from the fixture corpora directory.
 * @param {object} opts
 * @param {string} opts.brand - Brand id (e.g. 'acme-cosmos').
 * @param {Array<{platform:string,handle:string}>} [opts.handles] - Handles to fetch for (ignored
 *   in fake — returns all items under corpora/<brand>/competitors/).
 * @param {number} [opts.maxItems=200] - Max items to return (soft cap, applied after reading).
 * @returns {Promise<object[]>} Corpus items as plain objects.
 */
async function fetchCorpus({ brand, maxItems = 200 }) {
  const brandCorpusDir = path.join(FIXTURE_CORPORA, brand);
  const competitorsDir = path.join(brandCorpusDir, 'competitors');
  const items = [];

  let competitorDirs;
  try {
    competitorDirs = fs.readdirSync(competitorsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    competitorDirs = [];
  }

  for (const competitorSlug of competitorDirs) {
    const dir = path.join(competitorsDir, competitorSlug);
    let files;
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
    } catch {
      files = [];
    }
    for (const file of files) {
      const abs = path.join(dir, file);
      try {
        const raw = JSON.parse(fs.readFileSync(abs, 'utf8'));
        // Deep-copy so test mutations don't corrupt fixture state.
        items.push(JSON.parse(JSON.stringify(raw)));
      } catch {
        // Silently skip malformed fixture items (test will catch the count mismatch).
      }
    }
  }

  return items.slice(0, maxItems);
}

/**
 * Return own-corpus items for the given brand from the fixture corpora directory.
 * @param {object} opts
 * @param {string} opts.brand - Brand id.
 * @param {number} [opts.maxItems=200] - Max items to return.
 * @returns {Promise<object[]>} Own corpus items as plain objects.
 */
async function fetchOwnCorpus({ brand, maxItems = 200 }) {
  const ownDir = path.join(FIXTURE_CORPORA, brand, 'own');
  let files;
  try {
    files = fs.readdirSync(ownDir).filter((f) => f.endsWith('.json')).sort();
  } catch {
    return [];
  }
  const items = [];
  for (const file of files) {
    const abs = path.join(ownDir, file);
    try {
      items.push(JSON.parse(fs.readFileSync(abs, 'utf8')));
    } catch {
      // skip
    }
  }
  return items.slice(0, maxItems);
}

module.exports = { fetchCorpus, fetchOwnCorpus };
