'use strict';

/**
 * engine/shared/paths.js  [N net-new]
 *
 * The CONTENT_HOME resolver — the ONLY component that derives instance paths
 * (release-spec §1.2 instance layout, RD-3 single-checkout + external instance dir).
 * No other engine file may construct an instance path; everything that reads or
 * writes mutable state asks this module for the location.
 *
 * Contract (release-spec §4.1, §4.4):
 *   - The instance root is located by exactly one environment variable, CONTENT_HOME.
 *   - CONTENT_HOME MUST live in the process environment (shell profile, service
 *     definition, or scheduler recipe) — it cannot live in $CONTENT_HOME/.env,
 *     because this module is what locates that .env (§4.1 placement rule).
 *   - Resolution TERMINATES at CONTENT_HOME: there is no fallback into the code
 *     checkout, a legacy directory, or any unlisted path (§4.4; removes the
 *     production fallback-chain hazard, gap §2.5 secrets-fallback row, DD-8).
 *   - Pure: no hardcoded absolute paths, no I/O. Throws a clear, named error when
 *     CONTENT_HOME is unset or blank.
 *
 * The §1.2 layout this module is the single source of truth for:
 *   $CONTENT_HOME/.env            instance secrets (the only secrets location, §4)
 *   $CONTENT_HOME/config/         system.json (schema-validated)
 *   $CONTENT_HOME/brands/<id>/    brand.json + DNA + archetypes + learned voice
 *   $CONTENT_HOME/calendar/       calendar.md + calendar-state.json
 *   $CONTENT_HOME/campaigns/      campaign instance files
 *   $CONTENT_HOME/corpora/<id>/   ingested own/competitor corpora (trust-tagged)
 *   $CONTENT_HOME/queue/          publish-queue.md + queue.md view + locks/
 *   $CONTENT_HOME/workspaces/     per-stage run artifacts keyed by content-id
 *   $CONTENT_HOME/library/        media/, index.json, usage-log.jsonl
 *   $CONTENT_HOME/analytics/      engagement checkpoints, baselines, reports
 *   $CONTENT_HOME/learning/       learning records: proposed/, applied/
 *   $CONTENT_HOME/ledger/         workflow-ledger records + events.jsonl
 *   $CONTENT_HOME/ledger/tasks/   pending slot-run task records (run transport)
 *   $CONTENT_HOME/logs/           redacted-at-write logs
 *   $CONTENT_HOME/setup-state.json   setup checkpoints
 *   $CONTENT_HOME/PAUSED          kill-switch sentinel
 */

const path = require('path');

const ENV_VAR = 'CONTENT_HOME';

/**
 * Thrown when CONTENT_HOME is unset/blank. Distinct type so callers (e.g. bin/engine.js)
 * can present the setup remediation rather than a generic stack trace (§15.1 fail-fast,
 * name the variable, never the value).
 */
class ContentHomeUnsetError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ContentHomeUnsetError';
    this.variable = ENV_VAR;
  }
}

/**
 * Resolve the absolute instance root from the environment.
 * @param {object} [env]  environment object to read (default process.env) — injectable for tests.
 * @returns {string} absolute path to $CONTENT_HOME.
 * @throws {ContentHomeUnsetError} when CONTENT_HOME is missing or blank.
 */
function contentHome(env = process.env) {
  const raw = env[ENV_VAR];
  if (raw == null || String(raw).trim() === '') {
    throw new ContentHomeUnsetError(
      `${ENV_VAR} is not set. The engine locates all instance state (queue, brands, ` +
        `config, logs, the .env) under ${ENV_VAR}; it has no fallback path. Set ${ENV_VAR} ` +
        `in your process environment (shell profile, service definition, or scheduler recipe), ` +
        `or run "engine init --home <path>" to create an instance directory.`,
    );
  }
  // Normalize but do NOT resolve against cwd beyond what path.resolve does on an
  // already-absolute value; this keeps the function pure w.r.t. the filesystem.
  return path.resolve(String(raw).trim());
}

/** Join segments under the resolved instance root. */
function underHome(env, ...segments) {
  return path.join(contentHome(env), ...segments);
}

/**
 * The §1.2 layout, as a flat set of derivers. Each takes an optional `env` (default
 * process.env) so tests can inject. Directory-family helpers that take an id append it.
 */
const paths = {
  ENV_VAR,
  ContentHomeUnsetError,
  contentHome,

  // Secrets — the one and only .env location (§4, §4.4).
  envFile: (env = process.env) => underHome(env, '.env'),

  // Structured config (§11).
  configDir: (env = process.env) => underHome(env, 'config'),
  systemConfig: (env = process.env) => underHome(env, 'config', 'system.json'),

  // Brands (brand-keyed, DD-10).
  brandsDir: (env = process.env) => underHome(env, 'brands'),
  brandDir: (brandId, env = process.env) => underHome(env, 'brands', brandId),
  brandConfig: (brandId, env = process.env) =>
    underHome(env, 'brands', brandId, 'brand.json'),

  // Calendar (DD-22).
  calendarDir: (env = process.env) => underHome(env, 'calendar'),

  // Campaigns (§8.7).
  campaignsDir: (env = process.env) => underHome(env, 'campaigns'),

  // Corpora (trust-class-tagged, RD-8/RD-9).
  corporaDir: (env = process.env) => underHome(env, 'corpora'),
  brandCorpusDir: (brandId, env = process.env) =>
    underHome(env, 'corpora', brandId),

  // Queue (DD-4/DD-19) — the dir queue.js operates inside.
  queueDir: (env = process.env) => underHome(env, 'queue'),
  publishQueue: (env = process.env) =>
    underHome(env, 'queue', 'publish-queue.md'),
  queueView: (env = process.env) => underHome(env, 'queue', 'queue.md'),
  queueLocksDir: (env = process.env) => underHome(env, 'queue', 'locks'),

  // Per-stage run workspaces keyed by content-id (model §5.4).
  workspacesDir: (env = process.env) => underHome(env, 'workspaces'),
  stageDir: (stage, env = process.env) => underHome(env, 'workspaces', stage),

  // Library + cooldown ledger (DD-14, §8.6).
  libraryDir: (env = process.env) => underHome(env, 'library'),
  libraryMediaDir: (env = process.env) => underHome(env, 'library', 'media'),
  libraryIndex: (env = process.env) => underHome(env, 'library', 'index.json'),
  usageLog: (env = process.env) =>
    underHome(env, 'library', 'usage-log.jsonl'),

  // Analytics (§7.9).
  analyticsDir: (env = process.env) => underHome(env, 'analytics'),

  // Learning records (DD-6, §7.10).
  learningDir: (env = process.env) => underHome(env, 'learning'),
  learningProposedDir: (env = process.env) =>
    underHome(env, 'learning', 'proposed'),
  learningAppliedDir: (env = process.env) =>
    underHome(env, 'learning', 'applied'),

  // Ledger + events + run-dispatch task transport (§13, §8.4).
  ledgerDir: (env = process.env) => underHome(env, 'ledger'),
  events: (env = process.env) => underHome(env, 'ledger', 'events.jsonl'),
  tasksDir: (env = process.env) => underHome(env, 'ledger', 'tasks'),

  // Redacted-at-write logs (model §9 r3, §13.3).
  logsDir: (env = process.env) => underHome(env, 'logs'),

  // Setup checkpoints (§2.1).
  setupState: (env = process.env) => underHome(env, 'setup-state.json'),

  // Kill-switch sentinel (§15.4).
  pausedSentinel: (env = process.env) => underHome(env, 'PAUSED'),
};

module.exports = paths;
