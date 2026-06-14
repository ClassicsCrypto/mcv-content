'use strict';

/**
 * engine/cli/pause.js  [N net-new]
 *
 * `engine pause` / `engine resume` — the kill switch (release-spec §15.4 "engine pause writes the
 * PAUSED sentinel + flips config; pauses every autonomous loop — triggers, task dispatch,
 * executor, analytics, ttl-sweep — in one action; engine resume reverses it"; model §5.2 Paused
 * state; DD-18). Scheduled entry points MUST check the sentinel first (§15.4) — dispatch.js,
 * kickoff.js, the analytics collector, and the executor all gate on it.
 *
 * The pause state is expressed TWO ways, both updated here so they never disagree:
 *   1. the PAUSED sentinel file at $CONTENT_HOME/PAUSED (the fast, dependency-free check every
 *      loop performs — fs.existsSync, no config parse);
 *   2. config/system.json `paused: true|false` (the declared posture — §11.2; safety lives in
 *      declared configuration, not in scheduler wrappers — §4.5/§15.4).
 * The sentinel is authoritative for the loops; the config flag is the durable, human-readable
 * record `engine status` reads. resume removes the sentinel and clears the flag.
 *
 * Both verbs are idempotent: pausing an already-paused project (or resuming an already-running
 * one) is a safe no-op-plus-report. They are CONTENT_HOME-dependent (the sentinel lives there);
 * an unset CONTENT_HOME surfaces the named remediation (§15.1).
 *
 * Tier-3 cleanliness (§0.3 r6): no hardcoded paths (paths.js derives the sentinel + config); no
 * IDs/codenames.
 */

const fs = require('fs');

const paths = require('../shared/paths');
const util = require('./util');

const PAUSE_HELP = `engine pause [--reason "<text>"]

Engage the kill switch (§15.4): write the PAUSED sentinel and set config paused=true. Every
autonomous loop — triggers, task dispatch, executor, analytics, ttl-sweep — halts. Idempotent.

  --reason <text>  optional reason recorded in the sentinel + config.
  --json           emit the structured result.
  -h, --help       show this help.`;

const RESUME_HELP = `engine resume

Reverse the kill switch (§15.4): remove the PAUSED sentinel and clear config paused. Idempotent.

  --json           emit the structured result.
  -h, --help       show this help.`;

/** Write config/system.json's paused flag, preserving the rest. Best-effort — never throws. */
function setConfigPaused(env, paused, reason) {
  let file;
  try {
    file = paths.systemConfig(env);
  } catch {
    return false;
  }
  let config = {};
  try {
    config = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    config = {};
  }
  config.paused = paused;
  if (paused && reason) config.paused_reason = reason;
  else delete config.paused_reason;
  try {
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

function pauseRun(ctx = {}) {
  const flags = ctx.flags || {};
  if (util.flagOn(flags.help)) return { ok: true, summary: PAUSE_HELP.split('\n')[0], detail: PAUSE_HELP };

  const env = ctx.env || process.env;
  let sentinel;
  try {
    sentinel = paths.pausedSentinel(env);
  } catch (err) {
    return { ok: false, exitCode: 1, summary: 'pause failed', detail: util.describeError(err) };
  }

  const reason = typeof flags.reason === 'string' ? flags.reason : null;
  const already = fs.existsSync(sentinel);
  try {
    fs.mkdirSync(require('path').dirname(sentinel), { recursive: true });
    fs.writeFileSync(sentinel, `${JSON.stringify({ paused_at: new Date().toISOString(), reason }, null, 2)}\n`, 'utf8');
  } catch (err) {
    return { ok: false, exitCode: 1, summary: 'pause failed writing sentinel', detail: util.describeError(err) };
  }
  const configFlipped = setConfigPaused(env, true, reason);

  return {
    ok: true,
    summary: already ? 'already paused (kill switch engaged) — sentinel refreshed' : 'PAUSED — kill switch engaged (§15.4); all autonomous loops halt',
    detail: [
      `sentinel: ${sentinel}`,
      `config paused flag: ${configFlipped ? 'set' : 'not updated (config missing — sentinel still authoritative)'}`,
      reason ? `reason: ${reason}` : null,
      'Run "engine resume" to reverse.',
    ].filter(Boolean),
    data: { ok: true, paused: true, sentinel, config_updated: configFlipped, reason },
  };
}

function resumeRun(ctx = {}) {
  const flags = ctx.flags || {};
  if (util.flagOn(flags.help)) return { ok: true, summary: RESUME_HELP.split('\n')[0], detail: RESUME_HELP };

  const env = ctx.env || process.env;
  let sentinel;
  try {
    sentinel = paths.pausedSentinel(env);
  } catch (err) {
    return { ok: false, exitCode: 1, summary: 'resume failed', detail: util.describeError(err) };
  }

  const wasPaused = fs.existsSync(sentinel);
  try {
    if (wasPaused) fs.rmSync(sentinel, { force: true });
  } catch (err) {
    return { ok: false, exitCode: 1, summary: 'resume failed removing sentinel', detail: util.describeError(err) };
  }
  const configFlipped = setConfigPaused(env, false);

  return {
    ok: true,
    summary: wasPaused ? 'RESUMED — kill switch cleared; autonomous loops may run again' : 'already running (no PAUSED sentinel present)',
    detail: [
      `sentinel: removed${wasPaused ? '' : ' (was not present)'}`,
      `config paused flag: ${configFlipped ? 'cleared' : 'not updated (config missing)'}`,
    ],
    data: { ok: true, paused: false, config_updated: configFlipped },
  };
}

module.exports = { pauseRun, resumeRun, PAUSE_HELP, RESUME_HELP };
