'use strict';

/**
 * engine/cli/share.js  [N net-new]  — batch IS-CLI
 *
 * `engine share` — the thin CLI surface over the OUTBOUND improvement-sharing path (release-spec.md
 * roadmap #4 "Improvement-sharing automation — DD-7(b) outbound sanitize/consent tooling + maintainer
 * evaluation harness; v1 is manual PRs only"; original-design-spec §2.6 Improvement Sharing;
 * decisions.md DD-7 option (b); Appendix B non-goal "Opt-out telemetry or automatic upstream data
 * sharing of ANY kind — DD-7 rejected (c) PERMANENTLY"). Per DD-1(c) the CLI is the thin runner: this
 * file owns ONLY arg parsing + record resolution + wiring + the result envelope; every decision lives
 * in the already-on-disk improvement-sharing modules (it wires, never re-implements):
 *   - engine/improvement-sharing/sanitize.js (IS-SANITIZE) sanitizeForSharing → the abstract rule-diff,
 *   - engine/improvement-sharing/package.js (IS-CONSENT) prepareContribution → the consent gate + the
 *     LOCAL package write (the ONLY thing that ever touches disk on this path).
 *
 * WHAT `engine share` DOES (and the LAW it enforces structurally, not as prose):
 *   - DEFAULT = REVIEW. It sanitizes the selected promoted learning record into an ABSTRACT rule-diff
 *     and SHOWS the operator the EXACT sanitized payload that WOULD be shared. It APPLIES NOTHING,
 *     TRANSMITS NOTHING, and WRITES NOTHING (DD-7 (1) no auto-send; DD-7 (3) operator-reviewed consent).
 *   - --prepare (+ an explicit consent flag, --yes) WRITES a local contribution package file the
 *     operator opens a MANUAL upstream pull request with. There is NO push/post/transmit branch
 *     anywhere — prepareContribution can only write a local file (proven structurally by IS-CONSENT's
 *     assertNoAutoSendPath self-test, asserted in CI).
 *   - --record <id> selects which promoted learning record to derive the contribution from (resolved
 *     from $CONTENT_HOME/learning/applied/<id>.json, then /learning/proposed/<id>.json).
 *
 * OFF BY DEFAULT (the LAW): the whole path is gated on config.improvement_sharing.enabled === true
 * (DD-7 (1)). Disabled => a clean, honest no-op (exit 0) that prepares + transmits NOTHING. This verb
 * does not flip that gate; the operator declares it in config/system.json.
 *
 * HONEST EXIT CODES (mirrors bin/engine.js §): 0 for every CORRECT outcome — a disabled no-op, a
 * review preview, or a written package are all the system behaving correctly, surfaced honestly. 1
 * only for a genuine refusal (the payload was NOT shareable — it still carried instance specifics) or
 * an error (could not resolve/sanitize the record, could not write the package). 2 for a usage error
 * (a bad/missing flag). A refused-by-design outcome (disabled / unconfirmed / unshareable) is reported,
 * never bypassed.
 *
 * Tier-3 cleanliness (§0.3 r6 / RD-3): constructs no instance paths (paths.js derives them), hardcodes
 * no ids/handles/roots/codenames/brand strings; the only literals are public flag/field names and the
 * §4.5 governance vocabulary.
 */

const fs = require('fs');

const paths = require('../shared/paths');
const sanitizeMod = require('../improvement-sharing/sanitize');
const packageMod = require('../improvement-sharing/package');
const util = require('./util');

const SHARE_HELP = `engine share [options]

Prepare a sanitized, ABSTRACT improvement contribution from a promoted learning record for a MANUAL
upstream pull request (DD-7(b) / §2.6 Improvement Sharing). The whole path is OFF by default
(config.improvement_sharing.enabled) and there is NO automatic-send path of ANY kind — this verb only
ever WRITES a local file the operator PRs by hand (DD-7 (1)).

  --record <id>    the promoted learning record to derive the contribution from (resolved under
                   $CONTENT_HOME/learning/applied/<id>.json, then /learning/proposed/<id>.json).
  --prepare        WRITE the local contribution package (requires --yes). Without --prepare the verb
                   only SHOWS the review preview and writes nothing (THE DEFAULT).
  --yes            EXPLICIT operator consent to write the package (DD-7 (3)). --prepare without --yes
                   is refused — you must review the exact payload first, then confirm.
  --operator <ref> optional operator-chosen label attached to the PR provenance (itself sanitized).
  --refuse-residual  sanitize in 'refuse' mode: a residual specific is a HARD error rather than masked
                   (for operators who want the sanitize to fail loudly if the input was dirty).
  --json           emit the structured result (the sanitized payload + the prepare envelope).
  -h, --help       show this help.

Safety: DEFAULT is REVIEW — it sanitizes the record and shows you the EXACT abstract rule-diff that
WOULD be shared (no brand names, secrets, snowflakes, paths, handles, or configured private terms;
the sanitizer strips them and a structural guard REFUSES any payload that still carries one). Only
--prepare --yes writes the package, and even then NOTHING is transmitted — you open the upstream pull
request by hand. The maintainer runs "engine evaluate-contribution" on the RECEIVING side.`;

/**
 * @param {object} ctx  { flags, env, config?, record?, now?, sanitize?, prepare? }
 *   - config     injected system config (default loaded from $CONTENT_HOME via util).
 *   - record     injected learning record (zero-key tests pass one directly, bypassing disk).
 *   - now        injected clock (ms) for deterministic provenance timestamps / filenames.
 *   - sanitize   injectable IS-SANITIZE module seam (default the on-disk sibling) — tests.
 *   - prepare    injectable IS-CONSENT module seam (default the on-disk sibling) — tests.
 * @returns {{ ok, summary, detail?, data?, exitCode? }}
 */
function run(ctx = {}) {
  const flags = ctx.flags || {};
  if (util.flagOn(flags.help)) return { ok: true, summary: SHARE_HELP.split('\n')[0], detail: SHARE_HELP };

  const env = ctx.env || process.env;
  const config = ctx.config || util.loadSystemConfig(env);
  const now = typeof ctx.now === 'number' ? ctx.now : undefined;
  const sanitize = ctx.sanitize || sanitizeMod;
  const preparer = ctx.prepare || packageMod;

  // SAFE default: REVIEW only. --prepare must be explicit to WRITE; --yes must be explicit to consent.
  const doPrepare = util.flagOn(flags.prepare);
  const consented = util.flagOn(flags.yes);
  const operatorRef = typeof flags.operator === 'string' ? flags.operator : undefined;
  const onResidual = util.flagOn(flags['refuse-residual']) ? 'refuse' : 'strip';

  // GATE 0 — OFF BY DEFAULT (DD-7 (1)), surfaced honestly BEFORE any record I/O. Even reading the
  // record is unnecessary work when the feature is off, and a disabled no-op must never imply that a
  // record was inspected/prepared. We delegate to IS-CONSENT's authoritative gate (single source).
  if (!preparer.contributionEnabled(config)) {
    return {
      ok: true,
      exitCode: 0,
      summary:
        'share: improvement-sharing is OFF by default (config.improvement_sharing.enabled !== true) — '
        + 'nothing prepared, nothing shared',
      detail: [
        'The outbound improvement-sharing path ships OFF (DD-7 (1) opt-in, off by default). Set '
          + 'config/system.json improvement_sharing.enabled = true to allow PREPARING a sanitized, '
          + 'operator-reviewed contribution package for a MANUAL pull request.',
        'No automated transmission exists in any configuration (DD-7 permanently rejected opt-out/telemetry).',
      ],
      data: { ran: false, mode: 'disabled', enabled: false },
    };
  }

  // --prepare requires explicit consent (DD-7 (3)): you must review the exact payload, THEN confirm.
  // We surface this as a usage error (exit 2) rather than silently downgrading to review — the
  // operator asked to write but didn't consent; tell them, don't guess.
  if (doPrepare && !consented) {
    return {
      ok: false,
      exitCode: 2,
      summary: 'share: --prepare requires explicit consent (--yes) — refusing to write without review (DD-7 (3))',
      detail: [
        'Run "engine share --record <id>" (no flags) FIRST to review the EXACT sanitized payload that '
          + 'would be shared, then re-run with "--prepare --yes" to write the local package.',
        'Even after preparing, NOTHING is transmitted — you open the upstream pull request by hand (DD-7 (1)).',
      ],
    };
  }

  // Resolve the learning record (injected for tests, else from disk by --record id).
  let record = ctx.record;
  if (record === undefined) {
    const recordId = typeof flags.record === 'string' ? flags.record : null;
    if (!recordId) {
      return {
        ok: false,
        exitCode: 2,
        summary: 'share: --record <id> is required (the promoted learning record to share an abstract diff from)',
        detail: ['Usage: engine share --record <id>   (review); add --prepare --yes to write the package.'],
      };
    }
    const resolved = resolveRecord(recordId, env);
    if (!resolved.ok) {
      return {
        ok: false,
        exitCode: 1,
        summary: `share: could not resolve learning record "${recordId}"`,
        detail: resolved.detail,
      };
    }
    record = resolved.record;
  }

  // Step 1 — SANITIZE (IS-SANITIZE). Turn the brand-specific record into an ABSTRACT rule-diff. This
  // is pure + deterministic + zero-key (RD-2/RD-12): no LLM, no network, no disk. It fails CLOSED — the
  // returned payload is guaranteed to pass the structural guard, and a residual under --refuse-residual
  // is a hard EUNSHAREABLE error rather than a silent mask.
  let payload;
  try {
    payload = sanitize.sanitizeForSharing(record, { config, env, onResidual, operatorRef });
  } catch (err) {
    // EUNSHAREABLE (the sanitizer refused) is a by-design refusal surfaced honestly as a verb failure
    // (the record could not be abstracted cleanly) — exit 1, never a stack trace. .families names WHICH
    // specific classes leaked; we never echo the offending value (that would re-leak it).
    const families = Array.isArray(err && err.families) ? err.families.join(', ') : null;
    return {
      ok: false,
      exitCode: 1,
      summary: 'share: refused — the record could not be sanitized into a shareable abstract rule-diff',
      detail: [
        util.describeError(err),
        families ? `residual specific families: ${families}` : null,
        'An abstract rule-diff may carry NO brand name, secret, snowflake, path, handle, or configured '
          + 'private term (DD-7 (2)). Regenerate the rule-diff clean, or drop --refuse-residual to strip.',
      ].filter(Boolean),
      data: { ran: true, mode: 'refused', code: (err && err.code) || 'EUNSHAREABLE' },
    };
  }

  // Step 2 — CONSENT + (optional) PACKAGE (IS-CONSENT). In REVIEW mode (no --prepare/--yes) this
  // returns the EXACT sanitized payload + provenance and WRITES NOTHING. Only enabled + consented +
  // shareable writes a LOCAL package for a manual PR. There is no transmit branch anywhere.
  let prep;
  try {
    prep = preparer.prepareContribution(record, {
      payload,
      config,
      env,
      consent: consented,
      operatorRef,
      now,
    });
  } catch (err) {
    return {
      ok: false,
      exitCode: 1,
      summary: 'share: failed to prepare the contribution',
      detail: [util.describeError(err)],
    };
  }

  return summarize({ prep, doPrepare, consented, onResidual });
}

/**
 * Resolve a learning record by id from $CONTENT_HOME. Prefers the APPLIED record (a promoted change is
 * the canonical thing to share — §7.10/DD-6), then the PROPOSED record. Returns { ok, record? , detail }.
 */
function resolveRecord(recordId, env) {
  const safe = String(recordId).replace(/[^A-Za-z0-9_.-]+/gu, '-');
  let appliedDir;
  let proposedDir;
  try {
    appliedDir = paths.learningAppliedDir(env);
    proposedDir = paths.learningProposedDir(env);
  } catch (err) {
    // CONTENT_HOME unset — the named remediation line, not a stack trace (§15.1).
    return { ok: false, detail: [util.describeError(err)] };
  }
  const candidates = [
    `${appliedDir}/${safe}.json`,
    `${proposedDir}/${safe}.json`,
  ];
  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue;
      const record = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (record && typeof record === 'object') return { ok: true, record, detail: [`record: ${file}`] };
    } catch (err) {
      return { ok: false, detail: [`record file at ${file} is unreadable/unparseable: ${(err && err.message) || err}`] };
    }
  }
  return {
    ok: false,
    detail: [
      `no learning record found for id "${recordId}" under learning/applied/ or learning/proposed/.`,
      'Promote a learning record first (engine improve), or pass --record with an existing id.',
    ],
  };
}

/** Build the final result envelope from the IS-CONSENT prepare outcome. */
function summarize({ prep, doPrepare, consented, onResidual }) {
  // The IS-CONSENT mode is the authority: 'disabled' | 'review' | 'written' | 'refused'.
  const mode = prep.mode;
  const wrote = prep.written === true;

  // A refusal (payload not shareable) is the only non-ok outcome from prepare (belt-and-suspenders;
  // the sanitizer already guaranteed shareability, so this is the defense-in-depth re-check). Surface
  // it as a verb failure (exit 1) — by-design, but it means the share did NOT happen.
  if (prep.ok === false || mode === 'refused') {
    return {
      ok: false,
      exitCode: 1,
      summary: prep.summary || 'share: refused — payload is not shareable',
      detail: (prep.detail || []).concat(prep.findings && prep.findings.length ? ['(residual finding locations reported without their values)'] : []),
      data: { ran: true, mode, written: false, findings: prep.findings || [] },
    };
  }

  const detail = [];
  if (mode === 'review') {
    detail.push(
      'REVIEW ONLY — the payload below is the EXACT abstract rule-diff that WOULD be shared. Nothing '
        + 'was written, nothing was transmitted.',
      doPrepare
        ? null
        : 'Re-run with "--prepare --yes" to write the local contribution package (then open the PR by hand).',
    );
  } else if (mode === 'written') {
    detail.push(
      prep.path ? `package: ${prep.path}` : null,
      'Wrote a LOCAL contribution package. NOTHING was transmitted — open the upstream pull request by '
        + 'hand with the contents of this file (DD-7 (1) no auto-send). The maintainer runs '
        + '"engine evaluate-contribution <file>" on the receiving side before any assimilation.',
    );
  }
  if (onResidual === 'refuse') detail.push('sanitize mode: refuse (a residual specific would have hard-failed).');
  detail.push(...(prep.detail || []));

  return {
    ok: true,
    exitCode: 0,
    summary: prep.summary,
    detail: detail.filter(Boolean),
    data: {
      ran: true,
      mode,
      enabled: prep.enabled === true,
      consented: prep.consented === true || consented,
      written: wrote,
      path: prep.path || null,
      // The verbatim sanitized payload + provenance the operator reviews (review) or that was written
      // (written). The contract: this IS what the package file contains (IS-CONSENT preview).
      preview: prep.preview || null,
    },
  };
}

module.exports = {
  run,
  SHARE_HELP,
  // internals for the smoke test
  resolveRecord,
  summarize,
};
