'use strict';

/**
 * engine/improvement-sharing/package.js  [N net-new]  — batch IS-CONSENT
 *
 * THE CONSENT GATE + CONTRIBUTION PACKAGER for the outbound improvement-sharing path
 * (release-spec.md roadmap #4 "Improvement-sharing automation — DD-7(b) outbound sanitize/consent
 * tooling + maintainer evaluation harness; v1 is manual PRs only"; original-design-spec §2.6
 * Improvement Sharing; decisions.md DD-7 = option (b) "kept, strictly opt-in: abstract rule-diffs
 * only, sanitized + operator-reviewed before anything leaves the install"; Appendix B non-goal
 * "Opt-out telemetry or automatic upstream data sharing of ANY kind — DD-7 rejected (c) PERMANENTLY;
 * nothing leaves an install without explicit operator action").
 *
 * WHAT THIS MODULE IS (and is NOT)
 * --------------------------------
 * This is the OUTBOUND counterpart to the inbound work-recap privacy gate: it takes a SANITIZED
 * payload (an abstract rule-diff + rationale derived from a promoted learning record of the #3
 * self-improvement loop) and, ONLY when the operator has both ENABLED the feature AND explicitly
 * CONSENTED, WRITES a local contribution package file that the operator then PRs BY HAND.
 *
 * It is the single most safety-critical OUTBOUND surface in the whole engine (design-review risk #7:
 * exfiltration + upstream supply-chain poisoning), so the governance IS the feature and is enforced
 * STRUCTURALLY, not as a prompt:
 *
 *   DD-7 (1) OPT-IN, OFF BY DEFAULT (fail-closed). The whole path is gated on
 *            config.improvement_sharing.enabled === true. Absent / any non-true value => DISABLED
 *            no-op: prepareContribution returns a disabled envelope and WRITES NOTHING. There is no
 *            "default on", no env override that turns it on, no opt-out path. (§contributionEnabled.)
 *
 *   DD-7 (1) NO AUTO-SEND, EVER. DD-7 PERMANENTLY rejected option (c) opt-out/telemetry: there must
 *            be NO automatic-send path of ANY kind. This module imports NO network/transport/VCS
 *            client (no http/https/net/tls/child_process/dgram/fetch/git) — it can only WRITE a
 *            local file. assertNoAutoSendPath() is a structural self-test (a test hook, exported)
 *            that PROVES this module references none of those transports; the test suite asserts it,
 *            so a future edit that adds a send path FAILS CI. (§NO_AUTO_SEND_LAW / assertNoAutoSendPath.)
 *
 *   DD-7 (3) OPERATOR-REVIEWED CONSENT. The operator must see EXACTLY what would be shared (the
 *            sanitized payload) and explicitly confirm before the package is even written. Consent
 *            is an explicit `opts.consent === true` (the CLI passes it through from a `--yes`-style
 *            flag). Absent => prepareContribution PREPARES NOTHING and returns the REVIEW PREVIEW
 *            (mode 'review') so the human can inspect the exact bytes first. Fail-closed: disabled or
 *            unconfirmed => nothing produced.
 *
 *   DD-7 (2) ABSTRACT RULE-DIFFS ONLY. The payload MUST already be sanitized by IS-SANITIZE and MUST
 *            pass assertShareable — the OUTBOUND structural guard that REFUSES to emit a payload that
 *            still contains a brand name / secret shape / Discord snowflake / absolute path /
 *            configured private term, or any instance-specific data. This module re-checks
 *            assertShareable at write time (belt-and-suspenders: never write an un-vetted payload,
 *            even if a caller forgot the sanitize step). It reuses engine/shared/redact.js + the
 *            private-term deny-list via the IS-SANITIZE module; this file owns CONSENT + PACKAGING,
 *            never sanitization (single responsibility — the part that must never have a subtle bug).
 *
 * RD-2 / RD-12: deterministic, zero-key engine code. The engine NEVER calls chain LLMs; packaging is
 * pure JSON shaping + a single local atomic file write. Testable offline with no keys, no network.
 *
 * Tier-3 cleanliness (§0.3 r6 / RD-3): no real IDs/handles/absolute paths/codenames/brand strings;
 * the only literals are public knob/flag/field names and the §4.5 governance vocabulary. The
 * contribution path is derived via engine/shared/paths.js — this file constructs no instance path.
 */

const fs = require('fs');
const path = require('path');

const paths = require('../shared/paths');
const { redact } = require('../shared/redact');

/* ------------------------------------------------------------------------------------------------ *
 * NO-AUTO-SEND LAW (DD-7 (1)). This is the list of module specifiers that would constitute a
 * transmit/push/post path. This module MUST NOT require ANY of them. The list exists so the
 * structural self-test (assertNoAutoSendPath) can read THIS source file back and prove the absence.
 * Keeping the law as data (not just a comment) is what makes "no auto-send exists" testable rather
 * than merely asserted in prose. If a future edit adds a transport, the test that calls
 * assertNoAutoSendPath FAILS — the refusal is structural, not a code review hope.
 * ------------------------------------------------------------------------------------------------ */

const FORBIDDEN_TRANSPORT_MODULES = Object.freeze([
  'http', 'https', 'http2', 'net', 'tls', 'dgram', 'dns',
  'child_process', 'node:http', 'node:https', 'node:http2', 'node:net',
  'node:tls', 'node:dgram', 'node:dns', 'node:child_process',
]);

/* ------------------------------------------------------------------------------------------------ *
 * Error types — distinct, named, with stable `code` strings so callers branch on the code, never the
 * message. These are the structural refusals the consent gate raises (or surfaces in the envelope).
 * ------------------------------------------------------------------------------------------------ */

/** Thrown/surfaced when the outbound payload still contains instance-specific / unsafe data. */
class NotShareableError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'NotShareableError';
    this.code = 'ENOTSHAREABLE';
    Object.assign(this, details);
  }
}

/** Thrown if the module's own no-auto-send invariant is ever violated (a build-time safety net). */
class AutoSendPathError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'AutoSendPathError';
    this.code = 'EAUTOSEND';
    Object.assign(this, details);
  }
}

/* ------------------------------------------------------------------------------------------------ *
 * Config gate (DD-7 (1) OPT-IN, OFF BY DEFAULT). Mirrors evaluate.loopEnabled for the #3 loop: the
 * whole outbound path is OFF unless config.improvement_sharing.enabled === STRICTLY true. Any other
 * value (absent block, false, "true" string, 1, etc.) keeps it DISABLED — fail-closed, never coerce.
 * ------------------------------------------------------------------------------------------------ */

/** The canonical improvement_sharing config block, or {} when absent/not-an-object. */
function sharingBlock(config = {}) {
  if (!config || typeof config !== 'object') return {};
  const b = config.improvement_sharing;
  return b && typeof b === 'object' ? b : {};
}

/** OFF-by-default gate (the LAW): true ONLY when config.improvement_sharing.enabled === true. */
function contributionEnabled(config = {}) {
  return sharingBlock(config).enabled === true;
}

/* ------------------------------------------------------------------------------------------------ *
 * assertShareable wiring (DD-7 (2)). The OUTBOUND structural guard lives in the sibling IS-SANITIZE
 * module (engine/improvement-sharing/sanitize.js) so sanitization + the shareability assertion share
 * one source of truth (the redact deny-list + no-instance-specifics check). We require it LAZILY so
 * this module loads and its consent/packaging logic + no-auto-send self-test are testable even before
 * the sibling lands. If the guard is genuinely missing at call time we FAIL CLOSED (treat the payload
 * as not shareable) rather than writing an un-vetted package — never the other way around.
 *
 * The contract IS-SANITIZE must satisfy:
 *   assertShareable(payload, opts?) -> returns truthy / void when the payload is provably free of
 *   instance specifics (brand names, secret shapes, snowflakes, absolute paths, configured private
 *   terms); THROWS (code ENOTSHAREABLE / EUNSAFE-shaped, with .findings) otherwise.
 * ------------------------------------------------------------------------------------------------ */

let _sanitizeMod; // memoized; `null` once we've confirmed it is absent (so we don't re-require each call).
function loadSanitizeModule() {
  if (_sanitizeMod !== undefined) return _sanitizeMod;
  try {
    // eslint-disable-next-line global-require
    _sanitizeMod = require('./sanitize');
  } catch {
    _sanitizeMod = null;
  }
  return _sanitizeMod;
}

/**
 * Run the OUTBOUND shareability guard against the payload. Returns { ok, findings, reason }.
 * Fail-closed: if IS-SANITIZE's assertShareable is unavailable we DECLINE (ok:false) — a missing
 * guard must never become an open door. A caller may inject `opts.assertShareable` (tests / a host
 * wiring) which takes precedence over the on-disk sibling.
 */
function checkShareable(payload, opts = {}) {
  // opts.assertShareable: a FUNCTION overrides the sibling (tests / host wiring); the explicit value
  // `null` means "no guard available" (forces the fail-closed branch, exercised in tests); `undefined`
  // (absent) means "use the on-disk IS-SANITIZE sibling".
  let guard;
  if (typeof opts.assertShareable === 'function') {
    guard = opts.assertShareable;
  } else if (opts.assertShareable === null) {
    guard = null;
  } else {
    const mod = loadSanitizeModule();
    guard = mod && typeof mod.assertShareable === 'function' ? mod.assertShareable : null;
  }

  if (!guard) {
    return {
      ok: false,
      findings: [],
      reason:
        'shareability guard (IS-SANITIZE assertShareable) is unavailable — refusing to emit an ' +
        'un-vetted payload (fail-closed, DD-7 (2)). Provide opts.assertShareable or install the ' +
        'sanitize sibling.',
    };
  }
  try {
    guard(payload, { config: opts.config, env: opts.env, denyTerms: opts.denyTerms });
    return { ok: true, findings: [], reason: null };
  } catch (err) {
    // IS-SANITIZE's UnshareableError reports WHERE + WHICH family (`offenders` / `families`), never
    // the offending VALUE — echoing it would re-leak it. Surface those; never the raw value.
    const findings = Array.isArray(err && err.findings)
      ? err.findings
      : (Array.isArray(err && err.offenders) ? err.offenders : []);
    return {
      ok: false,
      findings,
      reason: (err && err.message) || 'payload failed the shareability guard',
    };
  }
}

/* ------------------------------------------------------------------------------------------------ *
 * Provenance — the abstract, instance-FREE proof that this contribution was operator-reviewed and
 * derived from a promoted learning record. It carries NO instance data: only the abstract target
 * KIND/classification, the source-signal TYPES + counts (never their refs/ids), and the consent
 * attestation. This is the audit trail a maintainer reads on the receiving side; it must itself be
 * Tier-3 clean.
 * ------------------------------------------------------------------------------------------------ */

const PROVENANCE_VERSION = '1';

/** Build the provenance block from a learning record + consent context. Instance-free by construction. */
function buildProvenance(record, { now, operatorRef } = {}) {
  const rec = record && typeof record === 'object' ? record : {};
  // source_signals: keep ONLY the abstract type+count; DROP refs (they are $CONTENT_HOME-relative
  // instance pointers — never shared). This is a structural strip, not a redaction.
  const signals = Array.isArray(rec.source_signals)
    ? rec.source_signals.map((s) => ({
        type: s && typeof s.type === 'string' ? s.type : 'unknown',
        count: s && Number.isInteger(s.count) ? s.count : null,
      }))
    : [];
  return {
    provenance_version: PROVENANCE_VERSION,
    // Abstract classification only — NOT the target_artifact id (that can be instance-specific).
    target_mutability: typeof rec.target_mutability === 'string' ? rec.target_mutability : null,
    shareability: typeof rec.shareability === 'string' ? rec.shareability : 'private',
    source_signal_types: signals,
    derived_from: 'promoted-learning-record',
    // The consent attestation: the operator reviewed the EXACT sanitized payload and confirmed.
    operator_reviewed: true,
    consent: {
      attested: true,
      // operatorRef is an OPTIONAL, operator-supplied label (e.g. a handle THEY choose to attach for
      // the PR). It is passed through assertShareable along with the payload, so a private term here
      // is caught by the same guard. Defaults to a neutral label — never an instance identity.
      operator: typeof operatorRef === 'string' && operatorRef.trim() ? operatorRef.trim() : 'operator',
      reviewed_at: new Date(typeof now === 'number' ? now : Date.now()).toISOString(),
    },
    // Honest statement of the transport posture baked into the package itself.
    transport: 'manual-pr-only',
    note:
      'Sanitized, abstract rule-diff prepared for a MANUAL upstream pull request. No automated ' +
      'transmission exists (DD-7 (1)). The operator must open the PR by hand.',
  };
}

/* ------------------------------------------------------------------------------------------------ *
 * The contribution PACKAGE — what gets written to disk for the operator to PR by hand. It is the
 * abstract rule-diff + rationale + provenance, and NOTHING else. No instance ids, no corpora, no
 * performance numbers tied to the brand, no secrets — assertShareable has already proven that.
 * ------------------------------------------------------------------------------------------------ */

const PACKAGE_VERSION = '1';

/** Assemble the package object from a sanitized payload + provenance. Pure JSON shaping. */
function buildPackage(payload, provenance) {
  const p = payload && typeof payload === 'object' ? payload : {};
  return {
    schema: 'improvement-contribution',
    package_version: PACKAGE_VERSION,
    // The GENERALIZABLE change — the abstract rule-diff structure + rationale (from IS-SANITIZE).
    rule_diff: p.rule_diff !== undefined ? p.rule_diff : (p.diff !== undefined ? p.diff : null),
    rationale: typeof p.rationale === 'string' ? p.rationale : (typeof p.reason === 'string' ? p.reason : null),
    // Optional abstract regression fixture the contribution carries (CONTRIBUTING.md requires rule
    // contributions ship regression fixtures). Pass-through only; assertShareable vetted it too.
    regression_fixture: p.regression_fixture !== undefined ? p.regression_fixture : null,
    provenance,
  };
}

/* ------------------------------------------------------------------------------------------------ *
 * Local write target (DD-7 (1) — WRITE ONLY, the operator PRs by hand). Derived via paths.js under
 * $CONTENT_HOME; this module constructs no absolute path of its own (RD-3 / Tier-3). The package is
 * a plain JSON file the operator copies into a manual PR. We NEVER push/post it.
 * ------------------------------------------------------------------------------------------------ */

/**
 * Directory the operator finds prepared contribution packages in. Defaults to
 * $CONTENT_HOME/contributions/, but an operator may override the location via
 * config.improvement_sharing.package_output_path — a path relative to CONTENT_HOME, or an
 * absolute path (honored as-is). This stays a LOCAL filesystem location only: it is where a
 * package file is WRITTEN for a manual PR (DD-7 (1) no auto-send); nothing is transmitted.
 */
function contributionsDir(env = process.env, config = {}) {
  const is = (config && config.improvement_sharing) || {};
  const configured = typeof is.package_output_path === 'string' ? is.package_output_path.trim() : '';
  const sub = configured || 'contributions';
  return path.isAbsolute(sub) ? sub : path.join(paths.contentHome(env), sub);
}

/** Deterministic, instance-free filename for a package. Slugged from the record id when present. */
function contributionFilename(record, now) {
  const rec = record && typeof record === 'object' ? record : {};
  const ts = new Date(typeof now === 'number' ? now : Date.now()).toISOString().replace(/[:.]/g, '-');
  const idSlug = typeof rec.id === 'string'
    ? rec.id.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48)
    : '';
  return `contribution-${ts}${idSlug ? `-${idSlug}` : ''}.json`;
}

/**
 * Atomic local write (tmp+rename) — the same write posture the queue writers use. This is the ONLY
 * I/O this module performs and it is a LOCAL file write; there is no network/VCS code path (see the
 * NO-AUTO-SEND LAW above). Creates $CONTENT_HOME/contributions/ if absent.
 */
function writePackageFile(filePath, pkg) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  const content = `${JSON.stringify(pkg, null, 2)}\n`;
  fs.writeFileSync(tmpPath, content, 'utf8');
  fs.renameSync(tmpPath, filePath);
  return filePath;
}

/* ------------------------------------------------------------------------------------------------ *
 * prepareContribution — THE EXPORT (DD-7 (1)+(2)+(3)).
 *
 * Default behavior is REVIEW: it returns the EXACT sanitized payload + provenance that WOULD be
 * shared, and writes nothing. The operator inspects it. Only when BOTH the feature is enabled AND
 * the operator has explicitly consented does it WRITE the local package for a MANUAL PR. There is no
 * branch that transmits.
 *
 * @param {object} record  the promoted learning record the contribution derives from (provenance source).
 * @param {object} [opts]
 *   @param {object}   [opts.payload]          the SANITIZED payload from IS-SANITIZE (abstract rule-diff
 *                                             + rationale [+ regression_fixture]). REQUIRED to do anything
 *                                             beyond reporting "nothing to share".
 *   @param {object}   [opts.config]           system config (reads config.improvement_sharing.enabled).
 *   @param {object}   [opts.env]              environment (CONTENT_HOME resolution; default process.env).
 *   @param {boolean}  [opts.consent]          EXPLICIT operator confirmation (the CLI `--yes` flag).
 *                                             FALSE/absent => review-only, writes nothing (fail-closed).
 *   @param {string}   [opts.operatorRef]      optional operator-chosen label for the PR provenance.
 *   @param {function} [opts.assertShareable]  injectable guard (tests / host wiring); else the sibling.
 *   @param {number}   [opts.now]              injected clock (ms) for deterministic timestamps/filenames.
 *   @param {string[]} [opts.denyTerms]        configured private-term deny-list, forwarded to the guard.
 * @returns {{
 *   ok:boolean, mode:'disabled'|'review'|'written'|'refused', written:boolean,
 *   enabled:boolean, consented:boolean, summary:string, detail:string[],
 *   preview?:object, path?:(string|null), findings?:Array
 * }}
 *   ok is true for every CORRECT outcome — including a by-design disabled/review no-op (the system
 *   behaving correctly). ok is false only for a genuine refusal (payload not shareable) or an error.
 *   The package is WRITTEN only when mode === 'written'.
 */
function prepareContribution(record, opts = {}) {
  const config = opts.config || {};
  const env = opts.env || process.env;
  const enabled = contributionEnabled(config);
  const consented = opts.consent === true; // STRICT true only — never coerce a flag value into consent.

  // (A) GATE 1 — OFF BY DEFAULT (DD-7 (1)). Surfaced honestly as a no-op, never an error.
  if (!enabled) {
    return {
      ok: true,
      mode: 'disabled',
      written: false,
      enabled: false,
      consented,
      summary:
        'improvement-sharing is OFF by default (config.improvement_sharing.enabled !== true) — ' +
        'nothing prepared, nothing shared',
      detail: [
        'The outbound improvement-sharing path ships OFF (DD-7 (1) opt-in, off by default). Set ' +
          'config/system.json improvement_sharing.enabled = true to allow PREPARING a sanitized, ' +
          'operator-reviewed contribution package for a MANUAL pull request.',
        'No automated transmission exists in any configuration (DD-7 permanently rejected ' +
          'opt-out/telemetry).',
      ],
    };
  }

  // (B) Nothing to share without a sanitized payload from IS-SANITIZE.
  if (!opts.payload || typeof opts.payload !== 'object') {
    return {
      ok: true,
      mode: 'review',
      written: false,
      enabled,
      consented,
      summary: 'improvement-sharing: no sanitized payload supplied — nothing to prepare',
      detail: [
        'Provide opts.payload (the SANITIZED abstract rule-diff from IS-SANITIZE). This packager ' +
          'never sanitizes; it only packages an already-vetted payload (single responsibility).',
      ],
    };
  }

  // (C) GATE 2 — OUTBOUND SHAREABILITY GUARD (DD-7 (2)). Re-checked at prepare time, belt-and-
  // suspenders: NEVER package an un-vetted payload, even if a caller skipped the sanitize step. The
  // operatorRef is included in what the guard inspects so a private term in the label is caught too.
  const guardInput = { ...opts.payload, _operatorRef: typeof opts.operatorRef === 'string' ? opts.operatorRef : undefined };
  const shareable = checkShareable(guardInput, {
    assertShareable: opts.assertShareable,
    config,
    env,
    denyTerms: opts.denyTerms,
  });
  if (!shareable.ok) {
    return {
      ok: false,
      mode: 'refused',
      written: false,
      enabled,
      consented,
      summary: 'improvement-sharing: payload is NOT shareable — refused (it still contains instance specifics)',
      detail: [
        shareable.reason,
        'The shared payload must be an ABSTRACT rule-diff with NO brand names, secrets, snowflakes, ' +
          'absolute paths, or configured private terms (DD-7 (2)). Re-run sanitization (IS-SANITIZE) ' +
          'and review the result.',
      ].filter(Boolean),
      // findings are redacted before they ever reach a caller/log (they describe WHAT was unsafe).
      findings: redact(shareable.findings || []),
    };
  }

  // Build the EXACT package that WOULD be shared. This is what the operator reviews verbatim.
  const provenance = buildProvenance(record, { now: opts.now, operatorRef: opts.operatorRef });
  const pkg = buildPackage(opts.payload, provenance);

  // (D) GATE 3 — OPERATOR-REVIEWED CONSENT (DD-7 (3)). Absent/false consent => REVIEW ONLY. The
  // operator sees the exact sanitized payload + provenance and writes NOTHING. Fail-closed.
  if (!consented) {
    return {
      ok: true,
      mode: 'review',
      written: false,
      enabled,
      consented: false,
      summary:
        'improvement-sharing: REVIEW ONLY — this is the EXACT sanitized payload that WOULD be ' +
        'shared. Nothing was written. Re-run with explicit consent to prepare the package.',
      detail: [
        'DD-7 (3): you must review the payload above and explicitly confirm before any package is ' +
          'written. Pass --yes (CLI) / opts.consent = true to prepare it.',
        'Even after preparing, NOTHING is transmitted — you open the upstream pull request by hand ' +
          '(DD-7 (1) no auto-send).',
      ],
      // The verbatim preview — the contract is that this object IS what the package file will contain.
      preview: pkg,
    };
  }

  // (E) ENABLED + CONSENTED => WRITE the local package for a MANUAL PR. This is the ONLY path that
  // produces a file, and it produces a LOCAL file ONLY — there is no transmit branch anywhere.
  let outPath;
  try {
    outPath = path.join(contributionsDir(env, config), contributionFilename(record, opts.now));
    writePackageFile(outPath, pkg);
  } catch (err) {
    return {
      ok: false,
      mode: 'refused',
      written: false,
      enabled,
      consented: true,
      summary: 'improvement-sharing: failed to write the local contribution package',
      detail: [(err && err.message) || String(err)],
    };
  }

  return {
    ok: true,
    mode: 'written',
    written: true,
    enabled,
    consented: true,
    summary:
      'improvement-sharing: wrote a sanitized, operator-reviewed contribution package for a MANUAL ' +
      'pull request. NOTHING was transmitted.',
    detail: [
      `package: ${outPath}`,
      'Open the upstream pull request by hand with the contents of this file (DD-7 (1) no auto-send). ' +
        'The maintainer evaluation harness runs on the RECEIVING side before any assimilation.',
    ],
    path: outPath,
    preview: pkg,
  };
}

/* ------------------------------------------------------------------------------------------------ *
 * assertNoAutoSendPath — THE STRUCTURAL TEST HOOK (DD-7 (1) "no automatic-send path of ANY kind").
 *
 * Proves, by reading THIS module's own source, that it requires NONE of the forbidden transport
 * modules — so "no auto-send exists" is a checked invariant, not a comment. The test suite calls
 * this and asserts it does not throw; a future edit that adds e.g. `require('https')` or a child-
 * process git push makes this THROW and FAILS CI. Pure + offline (RD-12); reads only this file.
 *
 * @param {string} [filePath]  source to scan (default: this module). Injectable for the test.
 * @returns {{ ok:true, scanned:string }} on success.
 * @throws {AutoSendPathError} (code EAUTOSEND) when a forbidden transport require is found.
 */
function assertNoAutoSendPath(filePath = __filename) {
  let src;
  try {
    src = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new AutoSendPathError(`cannot read module source to verify no-auto-send: ${err.message}`, { filePath });
  }
  // Strip block + line comments so the FORBIDDEN_TRANSPORT_MODULES list (a comment+data declaration)
  // and the doc-comment prose do not self-trigger; we only care about ACTUAL require/import calls.
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

  const offenders = [];
  for (const mod of FORBIDDEN_TRANSPORT_MODULES) {
    const esc = mod.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // require('mod') | require("mod") | import ... from 'mod' | import('mod')
    const re = new RegExp(`(?:require|import)\\s*(?:\\(\\s*)?['"]${esc}['"]`, 'g');
    if (re.test(code)) offenders.push(mod);
  }
  // Defense in depth: also forbid a bare global fetch CALL — there is no legitimate use here. The
  // token is assembled at runtime so this detector's OWN source contains no literal `fetch(` to
  // self-trigger (the no-auto-send check must not flag the no-auto-send check).
  const fetchToken = 'fet' + 'ch'; // assembled so neither the regex nor the label is a literal call.
  const fetchCall = new RegExp(`(^|[^.\\w])${fetchToken}\\s*\\(`);
  if (fetchCall.test(code)) offenders.push(`${fetchToken}()`);

  if (offenders.length) {
    throw new AutoSendPathError(
      `NO-AUTO-SEND violation: this module references transport(s) [${offenders.join(', ')}]. The ` +
        'improvement-sharing packager may ONLY write a local file; it must never transmit (DD-7 (1)).',
      { offenders, filePath },
    );
  }
  return { ok: true, scanned: filePath };
}

module.exports = {
  // the export (DD-7 (1)+(2)+(3))
  prepareContribution,
  // config gate (DD-7 (1) opt-in, off by default)
  contributionEnabled,
  sharingBlock,
  // the structural no-auto-send proof + its law (DD-7 (1))
  assertNoAutoSendPath,
  FORBIDDEN_TRANSPORT_MODULES,
  // error types (callers branch on .code: ENOTSHAREABLE / EAUTOSEND)
  NotShareableError,
  AutoSendPathError,
  // internals exposed for tests
  checkShareable,
  buildProvenance,
  buildPackage,
  contributionsDir,
  contributionFilename,
};
