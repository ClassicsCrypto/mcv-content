'use strict';

/**
 * engine/setup/checkpoints.js  [N net-new]
 *
 * The C0–C4 deterministic checkpoint verifiers (release-spec §2.2–§2.6; DD-5 setup order;
 * model §5.4 "setup row"; §12 setup error row "halt with named failed step + remediation").
 * `agent.md` instructs the host agent to run the verifier after each setup step and report the
 * result; `engine verify --setup c<n>` and the resumable setup flow call verifyCheckpoint(n).
 *
 * Each verifier returns a STRUCTURED result — never throws for a normal failed check — so the
 * CLI/agent can present a named pass/fail with remediation (model §12; §2.1):
 *
 *   {
 *     checkpoint: 'C1',
 *     passed: boolean,            // hard requirements all satisfied
 *     checks: [                   // every individual check, in order
 *       { name, status: 'pass'|'fail'|'skip', detail, remediation? }
 *     ],
 *     remediation: string|null,   // the first actionable failure's fix (named step — §12)
 *     project_state: string,      // the model §5.2 lifecycle state implied AFTER this checkpoint
 *   }
 *
 * `skip` is a non-failing status for deferrable-until-LIVE checks (e.g. Postiz publisher
 * reachability while credentials are deferred — §2.3 step 7 "skipped-with-notice"). A skip never
 * fails the checkpoint; a `fail` always does.
 *
 * Fail-fast on credentials (§15.1): a missing/blank required credential is a permanent fail with
 * the variable NAMED (never its value) and NO retry — exactly the production token-rotation
 * crash-loop counter-example. Credential resolution goes through engine/shared/secrets.js only.
 *
 * Scope honesty: these verifiers are DETERMINISTIC and do not place live API calls in v1 (CI
 * runs zero-key — §16.5; live integration tests are out of scope, RD-12). Publisher
 * reachability is verified at the configuration + credential-presence layer: credentials
 * are present and well-formed, the channel bindings are set, the lock dir is writable. Actual
 * round-trip reachability (posting/reacting in a channel) is the operator's runtime concern; a
 * future live-probe is roadmap. Each check states which layer it asserts so the contract is honest.
 *
 * Tier-3 cleanliness (§1 per-path rule): no IDs/handles/absolute roots, no production persona
 * codenames (§0.3 r6). Channel ids and reviewer ids are read from operator config, never hardcoded.
 */

const fs = require('fs');
const path = require('path');

const paths = require('../shared/paths');
const secrets = require('../shared/secrets');
const setupState = require('./setup-state');

const { LIFECYCLE } = setupState;

const NODE_MAJOR_MIN = 22; // §3.1 runtime dependency

/** Placeholder tokens shipped in starter config (init.js) that the operator must replace. */
const PLACEHOLDER_PATTERN = /^<[A-Z_]+>$/u;

// ---------------------------------------------------------------------------
// Result builders
// ---------------------------------------------------------------------------

function check(name, status, detail, remediation) {
  const c = { name, status, detail: detail ?? null };
  if (remediation) c.remediation = remediation;
  return c;
}
const pass = (name, detail) => check(name, 'pass', detail);
const fail = (name, detail, remediation) => check(name, 'fail', detail, remediation);
const skip = (name, detail, remediation) => check(name, 'skip', detail, remediation);

/** Assemble the checkpoint result from its checks; `passed` iff no check failed. */
function result(checkpoint, checks, projectState) {
  const firstFail = checks.find((c) => c.status === 'fail');
  return {
    checkpoint,
    passed: !firstFail,
    checks,
    remediation: firstFail ? (firstFail.remediation || firstFail.detail) : null,
    project_state: projectState,
  };
}

// ---------------------------------------------------------------------------
// Small filesystem / config helpers (no external deps — matches the codebase)
// ---------------------------------------------------------------------------

function readJsonIfExists(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Can we create + remove a file under `dir`? (lock-dir writability — §2.3 step 7). */
function dirWritable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.write-probe.${process.pid}.${Date.now()}`);
    fs.writeFileSync(probe, '');
    fs.rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

function isPlaceholder(value) {
  return typeof value === 'string' && PLACEHOLDER_PATTERN.test(value.trim());
}

/** Structural reviewer-allowlist validation against the §11.2 / DD-17 contract. */
function reviewersOk(reviewers) {
  if (!Array.isArray(reviewers) || reviewers.length === 0) {
    return { ok: false, why: 'reviewers[] is missing or empty' };
  }
  const anyApprove = reviewers.some(
    (r) => r && Array.isArray(r.rights) && r.rights.includes('approve') &&
      typeof r.id === 'string' && r.id.trim() !== '' && !isPlaceholder(r.id),
  );
  if (!anyApprove) {
    return { ok: false, why: 'no reviewer with a real id and approve rights (DD-17)' };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// C0 — Prerequisites and zero-key proof (§2.2) — CONTENT_HOME-free
// ---------------------------------------------------------------------------

/**
 * C0 verifies the prerequisites for the zero-key proof: a supported Node, the repo manifest
 * present, the §1 hygiene files present (so `git add -A` is safe by construction), and that
 * reaching this point required NO credentials and NO CONTENT_HOME (the "is this for me / does it
 * work" proof, §2.2; model §13.1 zero-key bar). It does NOT run the fixture itself (that is
 * `engine fixture-run`, wired by the fixtures/CI batch) — it asserts the install can host it.
 */
function verifyC0(opts = {}) {
  const env = opts.env || process.env;
  const repoRoot = path.resolve(__dirname, '..', '..');
  const checks = [];

  // Node major version (§3.1).
  const major = Number(process.versions.node.split('.')[0]);
  checks.push(
    major >= NODE_MAJOR_MIN
      ? pass('node_version', `Node ${process.versions.node} (>= ${NODE_MAJOR_MIN})`)
      : fail(
          'node_version',
          `Node ${process.versions.node} is below the required ${NODE_MAJOR_MIN}`,
          `Install Node.js >= ${NODE_MAJOR_MIN} (§3.1) and re-run.`,
        ),
  );

  // Repo manifest present (proxy for "cloned + npm ci-able"). §2.2 step 1.
  const pkgFile = path.join(repoRoot, 'package.json');
  checks.push(
    fs.existsSync(pkgFile)
      ? pass('repo_manifest', 'package.json present')
      : fail(
          'repo_manifest',
          'package.json not found at the repo root',
          'Run from a clean clone of the repository, then `npm ci` (§2.2 step 1).',
        ),
  );

  // Hygiene file present so `git add -A` stays safe by construction (DD-8 / §0.3 r2).
  const gitignore = path.join(repoRoot, '.gitignore');
  checks.push(
    fs.existsSync(gitignore)
      ? pass('hygiene_gitignore', '.gitignore present (deny-by-default hygiene layer, DD-8)')
      : fail(
          'hygiene_gitignore',
          '.gitignore not found',
          'A deny-by-default .gitignore is required so instance data can never be committed (§18.3).',
        ),
  );

  // Zero-key proof: this checkpoint requires no credentials and no CONTENT_HOME.
  checks.push(
    pass(
      'zero_key',
      'C0 requires no credentials and no CONTENT_HOME — the zero-key proof precondition (§2.2).' +
        (env[paths.ENV_VAR] ? ' (CONTENT_HOME is set, which is fine but not required here.)' : ''),
    ),
  );

  // C0 never advances the lifecycle past uninitialized (no instance yet).
  return result('C0', checks, LIFECYCLE.UNINITIALIZED);
}

// ---------------------------------------------------------------------------
// C1 — Integration and agents (§2.3, DD-5 step 1)
// ---------------------------------------------------------------------------

/**
 * C1 verifies the integration layer: the instance dir exists, config/system.json is present and
 * structurally valid (mode, reviewers allowlist with approve rights, budget caps, publish posture,
 * Discord channel bindings), the lock dir is writable, and publisher reachability when Postiz credentials are present (skipped-with-
 * notice while deferred — §2.3 step 7).
 */
function verifyC1(opts = {}) {
  const env = opts.env || process.env;
  const checks = [];

  // CONTENT_HOME resolvable + instance dir present (init must have run — §2.3 step 1).
  let home;
  try {
    home = paths.contentHome(env);
  } catch (err) {
    checks.push(
      fail(
        'content_home',
        err.message,
        'Run `engine init --home <path>` first (§2.3 step 1), and set CONTENT_HOME in your environment.',
      ),
    );
    return result('C1', checks, LIFECYCLE.UNINITIALIZED);
  }
  if (!fs.existsSync(home)) {
    checks.push(
      fail(
        'content_home',
        `CONTENT_HOME "${home}" does not exist`,
        'Run `engine init --home <path>` to scaffold the instance directory (§2.3 step 1).',
      ),
    );
    return result('C1', checks, LIFECYCLE.UNINITIALIZED);
  }
  checks.push(pass('content_home', `instance directory present at the resolved CONTENT_HOME`));

  // config/system.json present + structurally valid (§11.2).
  const sys = readJsonIfExists(paths.systemConfig(env));
  if (!sys) {
    checks.push(
      fail(
        'system_config',
        'config/system.json missing or not valid JSON',
        'Write config/system.json from templates/system.json.template binding your channel ids (§2.3 step 5).',
      ),
    );
    return result('C1', checks, LIFECYCLE.UNINITIALIZED);
  }

  // mode (§8.3 ladder; default SAFE).
  if (['SAFE', 'LIVE_PREVIEW', 'LIVE'].includes(sys.mode)) {
    checks.push(pass('mode', `mode = ${sys.mode}`));
  } else {
    checks.push(
      fail('mode', `invalid or missing mode "${sys.mode}"`, 'Set mode to SAFE | LIVE_PREVIEW | LIVE (default SAFE, §8.3).'),
    );
  }

  // reviewers allowlist (DD-17) — C1 MUST NOT pass without at least one real approver (§2.3 step 5).
  const rev = reviewersOk(sys.reviewers);
  checks.push(
    rev.ok
      ? pass('reviewers', 'reviewer allowlist has >=1 entry with a real id and approve rights (DD-17)')
      : fail(
          'reviewers',
          rev.why,
          'Add at least one reviewer with a real id and "approve" rights to system.json reviewers[] (DD-17, §2.3 step 5).',
        ),
  );

  // budget with hard caps (DD-18) — required to proceed past C1 (§2.3 step 5).
  const b = sys.budget;
  const budgetOk = b && typeof b === 'object' &&
    Number(b.monthly_cap) > 0 && Number(b.daily_cap) > 0 &&
    Number(b.per_item_generation_limit) > 0 && b.indexing_requires_estimate === true;
  checks.push(
    budgetOk
      ? pass('budget', 'budget caps present (monthly/daily/per-item, indexing requires estimate) — DD-18')
      : fail(
          'budget',
          'budget configuration missing required hard caps',
          'Set budget.{monthly_cap,daily_cap,per_item_generation_limit} > 0 and indexing_requires_estimate=true (DD-18, §11.2).',
        ),
  );

  // publish posture present (default draft-only, §11.2).
  const pub = sys.publish;
  checks.push(
    pub && typeof pub.draft_only === 'boolean' && typeof pub.auto_publish_allowed === 'boolean'
      ? pass('publish_posture', `draft_only=${pub.draft_only}, auto_publish_allowed=${pub.auto_publish_allowed}`)
      : fail('publish_posture', 'publish posture missing', 'Set publish.{draft_only,auto_publish_allowed} in system.json (§11.2).'),
  );

  // Discord channel-role bindings, with no leftover placeholders (§2.3 steps 3/5).
  const required = ['content-review', 'content-published', 'content-ops', 'media-bank'];
  const channels = (sys.approval_surface && sys.approval_surface.channels) || {};
  const missing = required.filter((role) => {
    const v = channels[role];
    return typeof v !== 'string' || v.trim() === '' || isPlaceholder(v);
  });
  checks.push(
    missing.length === 0
      ? pass('channel_bindings', `all four channel roles bound: ${required.join(', ')}`)
      : fail(
          'channel_bindings',
          `unbound or placeholder channel roles: ${missing.join(', ')}`,
          'Create the channels per templates/channels.md and bind their ids in approval_surface.channels (§2.3 steps 3/5).',
        ),
  );

  // Lock dir writable (single-runner lock discipline, DD-19; §2.3 step 7).
  checks.push(
    dirWritable(paths.queueLocksDir(env))
      ? pass('lock_dir_writable', 'queue/locks is writable (DD-19 single-runner lock)')
      : fail('lock_dir_writable', 'queue/locks is not writable', 'Ensure CONTENT_HOME/queue/locks exists and is writable (re-run `engine init`).'),
  );

  checks.push(pass('approval_surface_permissions', 'approval delivery is host-managed; ensure the runtime can post/read/react in the bound channels'));

  // Publisher reachability — skipped-with-notice while Postiz creds are deferred (§2.3 step 7).
  const postizKey = secrets.getSecret('POSTIZ_API_KEY', { env });
  const postizUrl = secrets.getSecret('POSTIZ_API_URL', { env });
  if (postizKey && postizUrl) {
    checks.push(pass('publisher', 'Postiz credentials present (POSTIZ_API_KEY + POSTIZ_API_URL) — publisher integration configured'));
  } else if (postizKey || postizUrl) {
    checks.push(
      fail(
        'publisher',
        'Postiz partially configured — one of POSTIZ_API_KEY / POSTIZ_API_URL is set without the other',
        'Set BOTH POSTIZ_API_KEY and POSTIZ_API_URL, or neither (defer publisher integration until LIVE — §2.3 step 4).',
      ),
    );
  } else {
    checks.push(
      skip(
        'publisher',
        'Postiz credentials absent — publisher integration deferred until LIVE (§2.3 step 4; quick-start step 8). Not required for SAFE/LIVE_PREVIEW.',
      ),
    );
  }

  // C1 is integration-readiness; the project is not yet ingested.
  return result('C1', checks, LIFECYCLE.UNINITIALIZED);
}

// ---------------------------------------------------------------------------
// C2 — Ingestion and brand identity (§2.4, DD-5 step 2)
// ---------------------------------------------------------------------------

/**
 * C2 verifies brand identity + ingestion: at least one brands/<id>/brand.json that is structurally
 * valid (id, display_name, account_class, platforms[]), a Brand DNA file present (the DD-21
 * authoring template output — cold-start path), an archetype catalog that is non-empty OR a
 * cold-start flag set (DD-21 empty-library is fully supported), and any ingested corpora carry a
 * trust_class tag (RD-8 — scraped material is untrusted-scraped by default). Project state →
 * ingested on pass.
 */
function verifyC2(opts = {}) {
  const env = opts.env || process.env;
  const checks = [];

  let home;
  try {
    home = paths.contentHome(env);
  } catch (err) {
    checks.push(fail('content_home', err.message, 'Complete C1 first (`engine init`, set CONTENT_HOME).'));
    return result('C2', checks, LIFECYCLE.UNINITIALIZED);
  }

  // At least one brand registered (§2.4 step 1; brand-keyed from day one, DD-10).
  const brandsDir = paths.brandsDir(env);
  let brandIds = [];
  try {
    brandIds = fs.readdirSync(brandsDir).filter((name) => {
      const dir = path.join(brandsDir, name);
      return fs.existsSync(path.join(dir, 'brand.json'));
    });
  } catch {
    brandIds = [];
  }
  if (brandIds.length === 0) {
    checks.push(
      fail(
        'brand_registered',
        'no brands/<id>/brand.json found',
        'Register at least one brand: write brands/<id>/brand.json from the template (§2.4 step 1, DD-10).',
      ),
    );
    return result('C2', checks, LIFECYCLE.UNINITIALIZED);
  }
  checks.push(pass('brand_registered', `${brandIds.length} brand(s) registered: ${brandIds.join(', ')}`));

  // Validate each brand: brand.json shape + DNA presence + archetypes-or-cold-start.
  let allBrandsOk = true;
  for (const id of brandIds) {
    const brand = readJsonIfExists(paths.brandConfig(id, env));
    const shapeOk = brand && typeof brand.id === 'string' && brand.id.trim() !== '' &&
      typeof brand.display_name === 'string' && brand.display_name.trim() !== '' &&
      ['operator', 'brand'].includes(brand.account_class) &&
      Array.isArray(brand.platforms) && brand.platforms.length >= 1 &&
      brand.platforms.every((p) => p && typeof p.platform === 'string' && ['postiz', 'giphy', 'manual'].includes(p.publisher));
    if (!shapeOk) {
      allBrandsOk = false;
      checks.push(
        fail(
          `brand:${id}:config`,
          'brand.json is missing required fields or has an invalid platform binding',
          'Fix brand.json: id, display_name, account_class (operator|brand), and platforms[] with platform + publisher (postiz|giphy|manual) (§11.3).',
        ),
      );
      continue;
    }
    checks.push(pass(`brand:${id}:config`, 'brand.json structurally valid (§11.3)'));

    // Brand DNA file present (DD-21 authoring template output, §2.4 step 3). Two supported routes,
    // either of which satisfies this check:
    //   (1) ONE-COMMAND (release-spec §1.1/§1.2; roadmap #2): `engine ingest-brand --brand <id>`
    //       ingests the corpus -> deterministic analysis -> generates brand-dna.md + the archetype
    //       catalog (DNA synthesis via the host seat when wired; DD-18 estimate-and-confirm). The
    //       generate-only verb `engine generate-dna --brand <id>` runs the analysis+generate half
    //       over an already-ingested corpus.
    //   (2) MANUAL / COLD-START (DD-21 — the no-op-safe DEFAULT that always works): fill
    //       templates/brand/brand-dna-authoring.md by hand into brands/<id>/brand-dna.md. No corpus,
    //       no seat, and no spend are required — onboarding is never blocked.
    const brandDir = paths.brandDir(id, env);
    const dnaCandidates = ['brand-dna.md', 'brand-dna-authoring.md', 'dna.md'];
    const dnaRel = (brand.paths && brand.paths.dna) ? path.join(brandDir, brand.paths.dna) : null;
    const dnaFound = (dnaRel && fs.existsSync(dnaRel)) ||
      dnaCandidates.some((f) => fs.existsSync(path.join(brandDir, f)));
    if (dnaFound) {
      checks.push(pass(`brand:${id}:dna`, 'Brand DNA file present (one-command `engine ingest-brand`/`generate-dna` output OR the DD-21 manual authoring path)'));
    } else {
      allBrandsOk = false;
      checks.push(
        fail(
          `brand:${id}:dna`,
          'no Brand DNA file found for this brand',
          'One-command: `engine ingest-brand --brand <id>` (ingest → analyze → generate, DD-18 estimate-and-confirm; §1.1/§1.2). ' +
            'Or the manual/cold-start DEFAULT (always works, no spend): fill templates/brand/brand-dna-authoring.md → brands/<id>/brand-dna.md (DD-21, §2.4 step 3).',
        ),
      );
    }

    // Archetype catalog non-empty OR cold-start flag (DD-21 empty-library fully supported).
    const archDir = (brand.paths && brand.paths.archetypes)
      ? path.join(brandDir, brand.paths.archetypes)
      : path.join(brandDir, 'archetypes');
    let archCount = 0;
    try {
      archCount = fs.readdirSync(archDir).filter((f) => !f.startsWith('.')).length;
    } catch {
      archCount = 0;
    }
    const coldStart = brand.cold_start === true;
    if (archCount > 0) {
      checks.push(pass(`brand:${id}:archetypes`, `${archCount} archetype(s) in the catalog`));
    } else if (coldStart) {
      checks.push(
        skip(`brand:${id}:archetypes`, 'empty archetype catalog with cold_start=true — DD-21 cold-start is fully supported (calibration quality improves with corpus data later).'),
      );
    } else {
      allBrandsOk = false;
      checks.push(
        fail(
          `brand:${id}:archetypes`,
          'empty archetype catalog and cold_start not set',
          'Add archetypes from templates/brand/archetypes.template.md, or set cold_start=true in brand.json for the DD-21 cold-start path (§2.4 step 3, §2.9).',
        ),
      );
    }
  }

  // Corpora trust-tagging (RD-8): every ingested corpus item carries a trust_class (§2.4 step 2).
  // Empty corpora (cold-start) is fine; only PRESENT items must be tagged.
  const corpusCheck = verifyCorporaTrustTagged(env, brandIds);
  checks.push(corpusCheck);
  if (corpusCheck.status === 'fail') allBrandsOk = false;

  return result('C2', checks, allBrandsOk ? LIFECYCLE.INGESTED : LIFECYCLE.UNINITIALIZED);
}

/** Walk each brand's corpora dir; fail if any *.json corpus item lacks a trust_class (RD-8). */
function verifyCorporaTrustTagged(env, brandIds) {
  const untagged = [];
  let scanned = 0;
  for (const id of brandIds) {
    const dir = paths.brandCorpusDir(id, env);
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    } catch {
      files = [];
    }
    for (const f of files) {
      scanned += 1;
      const item = readJsonIfExists(path.join(dir, f));
      const tag = item && item.trust_class;
      if (!['untrusted-scraped', 'operator-curated'].includes(tag)) {
        untagged.push(`${id}/${f}`);
      }
    }
  }
  if (scanned === 0) {
    return skip('corpora_trust_tagged', 'no ingested corpus items — cold-start / empty corpus is supported (DD-21).');
  }
  if (untagged.length > 0) {
    return fail(
      'corpora_trust_tagged',
      `${untagged.length} corpus item(s) missing a trust_class: ${untagged.slice(0, 5).join(', ')}${untagged.length > 5 ? ' …' : ''}`,
      'Every ingested corpus item MUST carry trust_class (untrusted-scraped | operator-curated) at write time (RD-8, §6.2).',
    );
  }
  return pass('corpora_trust_tagged', `${scanned} corpus item(s) all trust-class-tagged (RD-8)`);
}

// ---------------------------------------------------------------------------
// C3 — Calibration gate (§2.5, DD-5 step 3, DD-9)
// ---------------------------------------------------------------------------

/**
 * Default pass criteria (§2.5, defined-not-vibes; config-tunable). Read from system.json
 * calibration block when present, else these defaults.
 */
const DEFAULT_CALIBRATION_CRITERIA = Object.freeze({
  sample_count: 10,
  min_gate_clear: 8,      // >= 8 of 10 clear the gate with zero hard fails
  min_on_voice: 6,        // operator judges >= 6 of 10 on-voice per the rubric
  max_fabrication: 0,     // zero fabrication-class codes
});

/**
 * C3 is the calibration GATE — the project MUST NOT reach operational without it (model §5.2;
 * §2.4 invariant). The verifier checks the RECORDED calibration result against the defined pass
 * criteria (§2.5). The result is produced by `engine calibrate` (the calibration runner, a
 * sibling batch) and recorded into setup-state.json's C3 detail; this verifier evaluates it. It
 * does NOT itself generate samples (that spends — and is the runner's job).
 *
 * Pass criteria (defaults, §2.5): >= 8/10 samples clear the gate with zero hard fails; operator
 * judges >= 6/10 on-voice; zero fabrication-class codes. Criteria are config-tunable.
 *
 * The result may also be supplied directly via opts.calibration for the runner to evaluate before
 * recording (so the runner and the verifier share one criterion definition).
 */
function verifyC3(opts = {}) {
  const env = opts.env || process.env;
  const checks = [];

  const criteria = { ...DEFAULT_CALIBRATION_CRITERIA, ...(loadCalibrationCriteria(env) || {}) };

  // Source the calibration result: explicit opts.calibration, else the recorded C3 record. Prefer
  // the dedicated, durable `calibration` field; fall back to legacy `detail` for instances
  // calibrated before that field existed. (The durable field is preserved across later detail-only
  // writes, so re-running `verify --setup c3` no longer wipes the scores — see setup-state.js.)
  let cal = opts.calibration;
  if (!cal) {
    const state = setupState.readSetupState(env);
    const c3 = state.checkpoints.C3;
    cal = (c3 && c3.calibration) || (c3 && c3.detail);
  }

  if (!cal || typeof cal !== 'object') {
    checks.push(
      fail(
        'calibration_run',
        'no calibration result recorded',
        'Run `engine calibrate --brand <id>` (confirm the pre-run cost estimate) before C3 (§2.5). The project cannot go operational without a calibration pass (model §5.2).',
      ),
    );
    return result('C3', checks, LIFECYCLE.INGESTED);
  }

  const sampleCount = Number(cal.sample_count ?? cal.samples ?? 0);
  const gateClear = Number(cal.gate_clear ?? cal.cleared ?? 0);
  const onVoice = Number(cal.on_voice ?? 0);
  const fabrication = Number(cal.fabrication_codes ?? cal.fabrication ?? 0);

  checks.push(
    sampleCount >= criteria.sample_count
      ? pass('sample_count', `${sampleCount} samples (>= ${criteria.sample_count})`)
      : fail('sample_count', `only ${sampleCount} samples (< ${criteria.sample_count})`, `Re-run calibration with at least ${criteria.sample_count} samples (§2.5).`),
  );
  checks.push(
    gateClear >= criteria.min_gate_clear
      ? pass('gate_clear', `${gateClear} samples cleared the gate with zero hard fails (>= ${criteria.min_gate_clear})`)
      : fail('gate_clear', `${gateClear} cleared the gate (< ${criteria.min_gate_clear})`, 'Remediation loop: adjust DNA/rules and re-run `engine calibrate` (§2.5).'),
  );
  checks.push(
    onVoice >= criteria.min_on_voice
      ? pass('on_voice', `operator judged ${onVoice} samples on-voice (>= ${criteria.min_on_voice})`)
      : fail('on_voice', `${onVoice} judged on-voice (< ${criteria.min_on_voice})`, 'Tune the Brand DNA / voice rules and re-run calibration (§2.5).'),
  );
  checks.push(
    fabrication <= criteria.max_fabrication
      ? pass('fabrication', `${fabrication} fabrication-class codes (<= ${criteria.max_fabrication})`)
      : fail('fabrication', `${fabrication} fabrication-class codes (> ${criteria.max_fabrication})`, 'Fabrication-class codes are a hard block — tighten claims-safety rules and re-run (§2.5, §10.3).'),
  );

  const passed = checks.every((c) => c.status !== 'fail');
  return result('C3', checks, passed ? LIFECYCLE.CALIBRATED : LIFECYCLE.INGESTED);
}

/** Optional config-tunable calibration criteria from system.json `calibration` block (§2.5). */
function loadCalibrationCriteria(env) {
  const sys = readJsonIfExists(paths.systemConfig(env));
  return sys && typeof sys.calibration === 'object' ? sys.calibration : null;
}

// ---------------------------------------------------------------------------
// C4 — Calendar and library (§2.6, DD-5 step 4)
// ---------------------------------------------------------------------------

/**
 * C4 verifies the calendar (a calendar file with at least one slot) and that the optional library
 * is either configured + indexed OR explicitly in empty-library mode (DD-21 — nothing in the chain
 * hard-depends on a populated index). The media indexer is available (`engine index-library`, the
 * estimate-and-confirm metered verb — §1.5, DD-18), so a library that is enabled-but-unindexed has
 * a concrete remediation; empty-library mode remains the no-op-pass default (DD-21). Campaigns and
 * character sheets are optional and not gated (run `engine index-library --character-sheets` to
 * audit/generate sheets, also estimate-and-confirm). Project state → operational on pass (and only
 * with C3 already passed — enforced by the lifecycle derivation, §2.4 invariant).
 */
function verifyC4(opts = {}) {
  const env = opts.env || process.env;
  const checks = [];

  let home;
  try {
    home = paths.contentHome(env);
  } catch (err) {
    checks.push(fail('content_home', err.message, 'Complete earlier checkpoints first.'));
    return result('C4', checks, LIFECYCLE.CALIBRATED);
  }

  // Calendar present with >=1 slot (§2.6 step 1; DD-22 calendar owns clock times).
  const calDir = paths.calendarDir(env);
  let calFiles = [];
  try {
    calFiles = fs.readdirSync(calDir).filter((f) => f.endsWith('.md') || f.endsWith('.json'));
  } catch {
    calFiles = [];
  }
  const calContent = calFiles
    .map((f) => {
      try {
        return fs.readFileSync(path.join(calDir, f), 'utf8');
      } catch {
        return '';
      }
    })
    .join('\n');
  // A slot is any line that looks like a slot row/entry: contains a slot id token or a markdown
  // table row with a time. Lightweight (no full calendar parser here — that is the calendar batch).
  const hasSlot = calFiles.length > 0 &&
    (/\bslot[_-]?id\b/iu.test(calContent) || /\|\s*[A-Za-z0-9_-]+\s*\|.*\b([01]\d|2[0-3]):[0-5]\d\b/u.test(calContent));
  checks.push(
    hasSlot
      ? pass('calendar', `calendar present with at least one slot (${calFiles.join(', ')})`)
      : fail(
          'calendar',
          calFiles.length === 0 ? 'no calendar file found' : 'calendar file present but no slots detected',
          'Generate a calendar from templates/calendar.template.md with at least one slot and clock time (C4). Base the suggested cadence on account class, own-account content downloads, comparator/competitor patterns, proof/media supply, platform availability, and approval capacity. Use dormant slots when proof/media is missing.',
        ),
  );

  // Library: configured + indexed, OR empty-library mode (DD-21). Either is a pass.
  const indexFile = paths.libraryIndex(env);
  const index = readJsonIfExists(indexFile);
  const sys = readJsonIfExists(paths.systemConfig(env)) || {};
  const libConfigured = Boolean(sys.library && sys.library.enabled === true);
  if (libConfigured && index && Array.isArray(index.entries) && index.entries.length > 0) {
    checks.push(pass('library', `library configured and indexed (${index.entries.length} entries)`));
  } else if (libConfigured) {
    checks.push(
      fail(
        'library',
        'library is enabled in config but no index.json entries found',
        'Indexing is available: run `engine index-library` to see the cost estimate, then `engine index-library --yes` to confirm and build the index (idempotent — already-indexed assets are never re-billed). Or disable the library (library.enabled=false) for empty-library mode (§2.6 step 3, §1.5, DD-18/DD-21).',
      ),
    );
  } else {
    checks.push(
      skip('library', 'empty-library mode — retrieval returns generate-only decisions; nothing in the chain hard-depends on a populated index (DD-21, §2.6 step 3). When a library is added, `engine index-library` builds the index (estimate-and-confirm, DD-18).'),
    );
  }

  const passed = checks.every((c) => c.status !== 'fail');
  // operational only when C3 (calibration) has also passed — enforced by deriveLifecycle, but we
  // report the implied state honestly: a C4 pass without a prior C3 stays non-operational.
  let projectState = LIFECYCLE.CALIBRATED;
  if (passed) {
    const c3 = setupState.readSetupState(env).checkpoints.C3;
    projectState = c3 && c3.passed ? LIFECYCLE.OPERATIONAL : LIFECYCLE.CALIBRATED;
  }
  return result('C4', checks, projectState);
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

const VERIFIERS = Object.freeze({
  C0: verifyC0,
  C1: verifyC1,
  C2: verifyC2,
  C3: verifyC3,
  C4: verifyC4,
});

/**
 * Run one checkpoint verifier. Accepts a numeric (0..4), 'C0'..'C4', or 'c0'..'c4'.
 * @param {number|string} n
 * @param {object} [opts]  { env, calibration } passed through to the verifier.
 * @returns {object} the structured checkpoint result.
 * @throws {Error} when `n` is not a known checkpoint.
 */
function verifyCheckpoint(n, opts = {}) {
  const id = normalizeCheckpointId(n);
  const fn = VERIFIERS[id];
  if (!fn) {
    throw new Error(`Unknown checkpoint "${n}". Valid: ${setupState.CHECKPOINTS.join(', ')} (or 0..4).`);
  }
  return fn(opts);
}

function normalizeCheckpointId(n) {
  if (typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 4) return `C${n}`;
  const s = String(n).trim().toUpperCase();
  if (/^C[0-4]$/u.test(s)) return s;
  if (/^[0-4]$/u.test(s)) return `C${s}`;
  return s; // returned as-is; dispatch throws on miss
}

module.exports = {
  DEFAULT_CALIBRATION_CRITERIA,
  verifyC0,
  verifyC1,
  verifyC2,
  verifyC3,
  verifyC4,
  verifyCheckpoint,
  normalizeCheckpointId,
};
