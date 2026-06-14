#!/usr/bin/env node
'use strict';

/**
 * scripts/gate-regression.js  [N net-new]
 *
 * The Tier-2 GATE-REGRESSION check (release-spec §16.3, §16.5; DD-3 union contract; the synthetic
 * judged corpus of §5.5). For EVERY case in fixtures/gate-regression it asserts the gate emits its
 * EXPECTED codes — byte-stable code emission, so perturbing a rule constant flips a fixture red.
 * Runs offline, zero-key (RD-12).
 *
 * Two halves, exactly as the corpus README pins them:
 *
 *   DETERMINISTIC (executed_in_ci: true) — the LINT.* / PKG.* / PLAT.* families. The real gate is
 *     RUN and its detected_codes[] are diffed against expected_codes verbatim:
 *       gate "lint"     → engine/gate/pre-gate-lint.js  lint(draft, {env, ...case.rules})
 *       gate "package"  → engine/gate/validate-package.js validate(pkg, {platform, env, ...})
 *       gate "platform" → same module, via case.call.platform
 *     Threading conventions (corpus README): a case may carry `rules` (threaded into the lint
 *     call), `call` (e.g. {platform} into validate), `omit` (delete package fields before validate
 *     — mirroring the live validate-package field-deletion test, keeping the on-disk base
 *     schema-valid), and `usage_history` (relative used_days_ago entries seeded into a throwaway
 *     temp CONTENT_HOME usage-log so the cooldown verdict is byte-stable across CI runs).
 *
 *   STRUCTURAL (executed_in_ci: false) — the FM.* (LLM prose) / SYS.* (publish-edge) / VIS.*
 *     (visual) families. CI never runs the LLM judge or the vision model (RD-12 zero-key bar), so
 *     these are checked for CONTRACT consistency instead: every expected code is registered in
 *     rules/codes.md, and the registry is RD-21-consistent (every soft code disposition: warn; a
 *     case that bars the Recommended carries bars_recommended on a soft code). The live VIS.*
 *     declarative-pack execution and the executor crash-safety scenarios are owned by their own
 *     suites (engine/gate/visual-check/__tests__, the executor coverage suite) — this check pins
 *     the registry/contract side here so no SYS/VIS/FM code is ever orphaned.
 *
 * A per-CASE `executed_in_ci` flag overrides the manifest default (e.g. voice-register ships one
 * deterministic LINT.* case alongside structural FM.* cases in one manifest).
 *
 * Honest-failure posture (same principle as fixture-run): if a deterministic case cannot be driven
 * (missing input file, an unknown gate, a malformed manifest) the check FAILS LOUDLY rather than
 * skipping — a false green on the QA gate is the worst outcome.
 *
 * Usage: node scripts/gate-regression.js [--root <dir>] [--json] [--verbose]
 * Exit: 0 every case matches · 1 a mismatch / drive failure · 2 usage error.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');

const preGate = require('../engine/gate/pre-gate-lint.js');
const validatePackage = require('../engine/gate/validate-package.js');
const usageLog = require('../engine/library/usage-log.js');

// --- Registry (rules/codes.md) — parsed for the structural half + a cross-check ---------------

/**
 * Parse the YAML code blocks out of rules/codes.md into a map: code → {tier, disposition, …}.
 * The file is markdown with fenced ```yaml blocks of `- code: …` lists; we parse exactly that
 * shape (zero-dependency, no YAML lib). Keys we need: code, family, tier, disposition.
 */
function parseRegistry(root) {
  const md = fs.readFileSync(path.join(root, 'rules', 'codes.md'), 'utf8');
  const registry = new Map();
  const blocks = md.split(/```/);
  for (let i = 1; i < blocks.length; i += 2) {
    const block = blocks[i];
    if (!/^\s*yaml\b/.test(block)) continue;
    const body = block.replace(/^\s*yaml[^\n]*\n/, '');
    let current = null;
    for (const rawLine of body.split(/\r?\n/)) {
      const line = rawLine.replace(/\s+$/, '');
      const start = line.match(/^- code:\s*(.+)$/);
      if (start) {
        current = { code: start[1].trim() };
        registry.set(current.code, current);
        continue;
      }
      const kv = line.match(/^\s+([A-Za-z_]+):\s*(.+)$/);
      if (kv && current) current[kv[1]] = kv[2].trim();
    }
  }
  return registry;
}

// --- Case drivers -----------------------------------------------------------------------------

function readJson(absPath) {
  return JSON.parse(fs.readFileSync(absPath, 'utf8'));
}

/** Recursively deep-merge `src` onto `dst` in place (the corpus 'override' semantic). */
function deepMerge(dst, src) {
  for (const [k, v] of Object.entries(src)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && dst[k] && typeof dst[k] === 'object' && !Array.isArray(dst[k])) {
      deepMerge(dst[k], v);
    } else {
      dst[k] = v;
    }
  }
  return dst;
}

/** Delete a dotted-path field from an object in place ('recommended.scores', 'audit_header.media'). */
function deletePath(obj, dotted) {
  const parts = dotted.split('.');
  let node = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!node || typeof node !== 'object') return;
    node = node[parts[i]];
  }
  if (node && typeof node === 'object') delete node[parts[parts.length - 1]];
}

/** Run a deterministic case; returns { codes: [...], verdict }. Throws on a drive failure. */
function runDeterministicCase(caseDir, c, gate) {
  const inputPath = c.input ? path.join(caseDir, c.input) : null;
  if (gate === 'lint') {
    if (!inputPath || !fs.existsSync(inputPath)) throw new Error(`lint case "${c.name}" input missing: ${c.input}`);
    const draft = readJson(inputPath);
    const opts = { env: {}, ...(c.rules || {}) };
    const r = preGate.lint(draft, opts);
    return { codes: r.detected_codes.map((d) => d.code), verdict: r.verdict };
  }
  if (gate === 'package' || gate === 'platform') {
    if (!inputPath || !fs.existsSync(inputPath)) throw new Error(`${gate} case "${c.name}" input missing: ${c.input}`);
    const pkg = readJson(inputPath); // a fresh clone per case (parsed anew) — never mutate on-disk.

    // Mutators (corpus README): 'override' deep-merges onto the clone; 'omit' deletes dotted-path
    // fields. Both keep the on-disk base*.package.json schema-valid (the schema job validates the
    // base, this runner the mutated form) — mirroring the live validate-package field-deletion test.
    if (c.override && typeof c.override === 'object') deepMerge(pkg, c.override);
    if (Array.isArray(c.omit)) for (const token of c.omit) deletePath(pkg, token);

    const call = c.call || {};
    const opts = { recordLedger: false, ...call };
    if (c.visual_check) opts.visualCheck = c.visual_check; // threaded for image-package cases.

    // validate-package resolves the cooldown ledger through shared/paths.js, which requires a
    // CONTENT_HOME (even a text package may reach the visual branch for visual platforms). Run
    // every package/platform case inside a throwaway temp home with the ledger off, seeding the
    // usage-log from any relative used_days_ago history so the cooldown verdict stays byte-stable.
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'oce-greg-'));
    const seedEnv = { CONTENT_HOME: tmpHome, WORKFLOW_LEDGER_DISABLE: '1' };
    try {
      if (Array.isArray(c.usage_history)) {
        for (const u of c.usage_history) {
          const usedAt = new Date(Date.now() - Number(u.used_days_ago) * 86400000).toISOString();
          usageLog.recordUse(
            { asset_id: u.asset_id, content_id: u.content_id || `greg-${c.name}`, used_at: usedAt, base_asset_id: u.base_asset_id },
            { env: seedEnv },
          );
        }
      }
      const r = validatePackage.validate(pkg, { ...opts, env: seedEnv });
      return { codes: r.detected_codes.map((d) => d.code), verdict: r.verdict };
    } finally {
      try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  }
  throw new Error(`case "${c.name}": no deterministic driver for gate "${gate}"`);
}

/** Compare two ordered code lists. The corpus diffs verbatim; we sort for stability across the
 *  union order while still requiring exact multiset equality (a code emitted twice must appear
 *  twice in both). */
function codesMatch(actual, expected) {
  if (actual.length !== expected.length) return false;
  const a = [...actual].sort();
  const e = [...expected].sort();
  return a.every((c, i) => c === e[i]);
}

// --- The check --------------------------------------------------------------------------------

function listExpectedManifests(root) {
  const base = path.join(root, 'fixtures', 'gate-regression');
  const out = [];
  (function walk(d) {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const abs = path.join(d, e.name);
      if (e.isDirectory()) walk(abs);
      else if (e.isFile() && e.name === 'expected.json') out.push(abs);
    }
  })(base);
  return out.sort();
}

function run(argv = process.argv.slice(2)) {
  let root = REPO_ROOT;
  let json = false;
  let verbose = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root') root = path.resolve(argv[++i] || '.');
    else if (argv[i] === '--json') json = true;
    else if (argv[i] === '--verbose') verbose = true;
    else if (argv[i] === '-h' || argv[i] === '--help') {
      process.stdout.write('node scripts/gate-regression.js [--root <dir>] [--json] [--verbose]\n');
      return 0;
    } else { process.stderr.write(`gate-regression: unknown arg ${argv[i]}\n`); return 2; }
  }

  let registry;
  try { registry = parseRegistry(root); } catch (err) {
    process.stderr.write(`gate-regression: cannot parse rules/codes.md (${err.message})\n`);
    return 1;
  }

  const manifests = listExpectedManifests(root);
  const report = { executed: 0, structural: 0, passed: 0, failures: [], manifests: manifests.length };

  for (const manifestAbs of manifests) {
    const caseDir = path.dirname(manifestAbs);
    const relDir = path.relative(root, caseDir).replace(/\\/g, '/');
    let manifest;
    try { manifest = readJson(manifestAbs); } catch (err) {
      report.failures.push(`${relDir}/expected.json: malformed (${err.message})`);
      continue;
    }
    const cases = Array.isArray(manifest.cases) ? manifest.cases : [];
    if (!cases.length) {
      report.failures.push(`${relDir}/expected.json: no cases`);
      continue;
    }

    for (const c of cases) {
      const executed = c.executed_in_ci !== undefined ? c.executed_in_ci : manifest.executed_in_ci;
      const gate = c.gate || manifest.gate;
      const expectedCodes = Array.isArray(c.expected_codes) ? c.expected_codes : [];
      const label = `${relDir} :: ${c.name}`;

      if (executed) {
        report.executed++;
        let result;
        try {
          result = runDeterministicCase(caseDir, c, gate);
        } catch (err) {
          report.failures.push(`${label} [DRIVE]: ${err.message}`);
          continue;
        }
        if (!codesMatch(result.codes, expectedCodes)) {
          report.failures.push(
            `${label} [CODES]: expected [${expectedCodes.join(', ')}] got [${result.codes.join(', ')}]`,
          );
          continue;
        }
        if (c.expected_verdict && result.verdict !== c.expected_verdict) {
          report.failures.push(
            `${label} [VERDICT]: expected ${c.expected_verdict} got ${result.verdict}`,
          );
          continue;
        }
        report.passed++;
        if (verbose) process.stdout.write(`  OK  ${label} → [${result.codes.join(', ')}] / ${result.verdict}\n`);
      } else {
        // Structural: every expected code must be registered + RD-21-consistent.
        report.structural++;
        let caseOk = true;
        for (const code of expectedCodes) {
          const entry = registry.get(code);
          if (!entry) {
            report.failures.push(`${label} [REGISTRY]: expected code ${code} not in rules/codes.md`);
            caseOk = false;
            continue;
          }
          // RD-21: every soft code ships disposition: warn (no v1 `correct`).
          if (entry.tier === 'soft' && entry.disposition !== 'warn') {
            report.failures.push(`${label} [RD-21]: soft code ${code} disposition is "${entry.disposition}" (must be warn)`);
            caseOk = false;
          }
          // A case asserting it bars the Recommended must reference a soft code (the bars_recommended
          // demote semantic is a warn-disposition consequence, §14.4).
          if (c.bars_recommended === true && entry.tier !== 'soft') {
            report.failures.push(`${label} [RD-21]: bars_recommended set but ${code} is tier "${entry.tier}" (demotion is a soft-warn consequence)`);
            caseOk = false;
          }
        }
        if (caseOk) {
          report.passed++;
          if (verbose) process.stdout.write(`  OK  ${label} (structural) → [${expectedCodes.join(', ')}]\n`);
        }
      }
    }
  }

  const ok = report.failures.length === 0;

  if (json) {
    process.stdout.write(`${JSON.stringify({ ok, ...report }, null, 2)}\n`);
  } else {
    process.stdout.write(
      `gate-regression: ${report.manifests} manifests, ${report.executed} executed + ${report.structural} structural cases; `
      + `${report.passed} passed, ${report.failures.length} failed.\n`,
    );
    if (!ok) {
      process.stderr.write('\ngate-regression: FAILED\n');
      for (const f of report.failures) process.stderr.write(`  ${f}\n`);
    } else {
      process.stdout.write('gate-regression: OK — every fixture case emits its expected codes.\n');
    }
  }

  return ok ? 0 : 1;
}

if (require.main === module) {
  process.exitCode = run();
}

module.exports = { run, parseRegistry, runDeterministicCase, codesMatch, deepMerge, deletePath };
