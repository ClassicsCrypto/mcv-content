'use strict';

/**
 * engine/setup/init.js  [N net-new]
 *
 * `engine init --home <path>` — scaffold the $CONTENT_HOME instance directory (release-spec
 * §1.2 instance layout; §2.3 C1 step 1; DD-5 setup order; DD-21 cold-start). One of the two
 * commands that run WITHOUT CONTENT_HOME already set — it is what creates it (§4.1; the other
 * is `engine fixture-run`).
 *
 * What initHome does (idempotent + resumable — §2.1):
 *   1. Resolve the target instance root and REFUSE if it sits inside the code checkout (the
 *      DD-8 hygiene invariant — the engine must never write instance state into a repo with a
 *      remote; §1.2 last paragraph). `git add -A` safe by construction (§0.3 r2).
 *   2. Create every §1.2 directory (queue, queue/locks, archive→library, ledger, ledger/tasks,
 *      brands, config, calendar, campaigns, corpora, workspaces, library, analytics, learning/
 *      {proposed,applied}, logs). Existing dirs are left untouched (mkdir recursive).
 *   3. Seed config/system.json from templates/system.json.template if the repo ships it, else a
 *      minimal SAFE-mode starter that schema-validates against schemas/config/system.schema.json
 *      — but NEVER overwrite an existing system.json (the operator's edits are authoritative).
 *   4. Copy the repo's .env.example → $CONTENT_HOME/.env for the operator to fill as later C1
 *      steps produce credentials (§2.3 step 1), without overwriting an existing .env. If the
 *      repo has no .env.example yet (authored by a sibling batch), write a minimal starter .env
 *      naming the two core variables (§4.1) so the operator is never blocked.
 *   5. Initialize $CONTENT_HOME as a LOCAL-ONLY git repo with no remote (SHOULD — §1.2): this
 *      gives DD-6 versioned learning records + one-step rollback. Best-effort: a missing git
 *      binary downgrades to a notice, never a hard failure.
 *   6. Write the initial setup-state.json with C0 unknown and the rest pending (the checkpoint
 *      verifiers in checkpoints.js advance it). Never clobbers a richer existing state.
 *
 * Re-running initHome on an already-initialized home is a safe no-op-plus-fill: it creates any
 * missing dirs, fills missing seed files, and leaves all existing operator content intact
 * (§2.1 "MUST NOT duplicate channels, re-bill scrapes/indexing, or silently overwrite Brand DNA").
 *
 * Tier-3 cleanliness (§1 per-path rule): the only absolute path this module handles is the
 * operator-supplied --home target; it hardcodes no IDs/handles/roots and carries no production
 * persona codenames (§0.3 r6).
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const paths = require('../shared/paths');
const setupState = require('./setup-state');

/** The repo root (two levels up from engine/setup/). Used to read shipped templates/.env.example. */
const REPO_ROOT = path.resolve(__dirname, '..', '..');

/**
 * Thrown when --home would place the instance directory inside the code checkout (DD-8 / §1.2).
 * Typed so the CLI presents the hygiene remediation rather than a raw stack trace.
 */
class UnsafeContentHomeError extends Error {
  constructor(home, checkout) {
    super(
      `Refusing to initialize CONTENT_HOME at "${home}" because it is inside the code checkout ` +
        `"${checkout}". Instance state (queue, brands, secrets, logs) MUST live OUTSIDE the repo ` +
        `so "git add -A" can never capture it (DD-8). Choose a path outside the checkout, e.g. a ` +
        `sibling directory or a dedicated data location.`,
    );
    this.name = 'UnsafeContentHomeError';
    this.home = home;
    this.checkout = checkout;
  }
}

/** True when `child` is the same as, or nested under, `parent` (path-segment aware). */
function isInside(child, parent) {
  const rel = path.relative(parent, child);
  // Empty => same dir; non-'..'-leading and non-absolute => nested under parent.
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** The §1.2 directory layout, as CONTENT_HOME-relative segments. */
const LAYOUT_DIRS = Object.freeze([
  'config',
  'brands',
  'calendar',
  'campaigns',
  'corpora',
  'queue',
  ['queue', 'locks'],
  'workspaces',
  'library',
  ['library', 'media'],
  'analytics',
  'learning',
  ['learning', 'proposed'],
  ['learning', 'applied'],
  'ledger',
  ['ledger', 'tasks'],
  'logs',
]);

/**
 * A minimal, schema-valid starter system.json (used only when the repo ships no
 * templates/system.json.template yet). SAFE mode, one placeholder reviewer, required budget
 * caps, draft-only publish, Discord surface with placeholder channel ids, a daily kickoff time.
 * Conforms to schemas/config/system.schema.json §11.2; the operator fills real values at C1 step 5.
 */
function starterSystemConfig() {
  return {
    schema_version: '1.0.0',
    mode: 'SAFE',
    reviewers: [{ id: '<REVIEWER_ID>', name: 'Lead Reviewer', rights: ['approve', 'edit'] }],
    budget: {
      currency: 'USD',
      monthly_cap: 50,
      daily_cap: 5,
      per_item_generation_limit: 1,
      indexing_requires_estimate: true,
    },
    publish: { draft_only: true, auto_publish_allowed: false },
    approval_surface: {
      adapter: 'discord',
      channels: {
        'content-review': '<CHANNEL_ID>',
        'content-published': '<CHANNEL_ID>',
        'content-ops': '<CHANNEL_ID>',
        'media-bank': '<CHANNEL_ID>',
      },
    },
    scheduler: {
      kickoff_time: '09:00',
      executor_interval_minutes: 5,
      analytics_interval_minutes: 240,
      ttl_sweep_interval_minutes: 60,
      tick_enabled: false,
    },
    cooldown: { hard_days: 14, target_days: 30 },
    paused: false,
  };
}

/**
 * The minimal starter .env body, written only when the repo ships no .env.example yet. Names
 * the two core §4.1 variables; CONTENT_HOME itself is intentionally NOT settable here (it lives
 * in the process environment — §4.1 placement rule — and is documented as such).
 */
function starterEnvBody() {
  return [
    '# $CONTENT_HOME/.env — the ONLY secrets location for this instance (release-spec §4, RD-5a).',
    '# Fill these as the C1 setup steps produce them. Values here are read by engine/shared/secrets.js',
    '# (process.env first, then this file). NEVER commit this file.',
    '#',
    '# NOTE: CONTENT_HOME is NOT set here — it must live in your process environment (shell',
    '# profile, service definition, or scheduler recipe), because it is what locates this file (§4.1).',
    '',
    '# Tier 1 secret — the Discord approval-surface bot token (required for the v1 approval surface).',
    '# Consumer: approval-surface adapter only (listener, card poster). Created at C1 step 2.',
    'DISCORD_BOT_TOKEN=',
    '',
    '# Tier 1 secret + config — Postiz publisher backend (required before the flagship lane publishes;',
    '# deferrable until LIVE — C1 step 4 / quick-start step 8).',
    'POSTIZ_API_KEY=',
    'POSTIZ_API_URL=',
    '',
  ].join('\n');
}

/** Read a shipped repo file, or null when absent. */
function readRepoFileIfExists(relPath) {
  const file = path.join(REPO_ROOT, relPath);
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** Write `body` to `file` only if it does not already exist. Returns 'created' | 'kept'. */
function writeIfAbsent(file, body) {
  if (fs.existsSync(file)) return 'kept';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, 'utf8');
  return 'created';
}

/**
 * Best-effort local-only git init (SHOULD, §1.2). Skips silently when git is unavailable or the
 * dir is already a repo. Never adds a remote.
 * @returns {'initialized' | 'already' | 'skipped'}
 */
function initLocalGit(home) {
  if (fs.existsSync(path.join(home, '.git'))) return 'already';
  try {
    execFileSync('git', ['init', '--quiet'], { cwd: home, stdio: 'ignore' });
    return 'initialized';
  } catch {
    return 'skipped';
  }
}

/**
 * Scaffold (or fill in) the $CONTENT_HOME instance directory. Idempotent and resumable.
 *
 * @param {object} [opts]
 * @param {string}  [opts.home]  the instance root. When given, it is set into the working env as
 *                               CONTENT_HOME so paths.js resolves it; equivalent to `--home <path>`.
 *                               When omitted, CONTENT_HOME must already be set in opts.env/process.env.
 * @param {boolean} [opts.git=true]  initialize a local-only git repo (SHOULD — §1.2).
 * @param {object}  [opts.env]   base environment (default process.env); not mutated — a derived
 *                               env carrying CONTENT_HOME is used and returned in the result.
 * @returns {{ home: string, env: object, created: object, results: object }}
 * @throws {UnsafeContentHomeError} when the resolved home is inside the code checkout (DD-8).
 * @throws {paths.ContentHomeUnsetError} when no home is given and CONTENT_HOME is unset.
 */
function initHome(opts = {}) {
  const baseEnv = opts.env || process.env;
  // Derive an env that carries the requested home so paths.js resolves it (and so callers/tests
  // get an env they can hand to the verifiers). process.env is never mutated.
  const env = { ...baseEnv };
  if (opts.home != null && String(opts.home).trim() !== '') {
    env[paths.ENV_VAR] = String(opts.home).trim();
  }

  const home = paths.contentHome(env); // throws ContentHomeUnsetError if neither home nor env set

  // (1) Hygiene invariant: never inside the code checkout (DD-8 / §1.2).
  if (isInside(home, REPO_ROOT)) {
    throw new UnsafeContentHomeError(home, REPO_ROOT);
  }

  const results = { dirs: [], files: {}, git: null };

  // (2) Create the §1.2 directory layout.
  fs.mkdirSync(home, { recursive: true });
  for (const entry of LAYOUT_DIRS) {
    const segs = Array.isArray(entry) ? entry : [entry];
    const dir = path.join(home, ...segs);
    fs.mkdirSync(dir, { recursive: true });
    results.dirs.push(segs.join('/'));
  }

  // (3) Seed config/system.json (template if shipped, else minimal starter) — never overwrite.
  const systemFile = paths.systemConfig(env);
  const shippedTemplate = readRepoFileIfExists(path.join('templates', 'system.json.template'));
  const systemBody = shippedTemplate != null
    ? shippedTemplate
    : `${JSON.stringify(starterSystemConfig(), null, 2)}\n`;
  results.files['config/system.json'] = writeIfAbsent(systemFile, systemBody);

  // (4) Seed .env (repo .env.example if shipped, else minimal starter) — never overwrite.
  const envFile = paths.envFile(env);
  const shippedEnvExample = readRepoFileIfExists('.env.example');
  const envBody = shippedEnvExample != null ? shippedEnvExample : starterEnvBody();
  results.files['.env'] = writeIfAbsent(envFile, envBody);

  // (5) Local-only git repo (SHOULD — §1.2).
  results.git = opts.git === false ? 'skipped' : initLocalGit(home);

  // (6) Initial setup-state.json — never clobber a richer existing record.
  if (!fs.existsSync(paths.setupState(env))) {
    setupState.writeSetupState(setupState.emptyState(), env);
    results.files['setup-state.json'] = 'created';
  } else {
    results.files['setup-state.json'] = 'kept';
  }

  return {
    home,
    env,
    created: results.files,
    results,
  };
}

module.exports = {
  UnsafeContentHomeError,
  LAYOUT_DIRS,
  REPO_ROOT,
  starterSystemConfig,
  isInside,
  initHome,
};
