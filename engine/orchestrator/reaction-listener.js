'use strict';

/**
 * engine/orchestrator/reaction-listener.js  [E extracted]
 *
 * The approval-decision capture core (release-spec §7.6 approval decision; DD-17 named-reviewer
 * allowlist; §12.4 approval-surface abstraction; §14.5 DD-12 re-gate path; §8.2 queue states).
 *
 * This module is SURFACE-NEUTRAL. It does not import a chat SDK and knows nothing about
 * buttons, reactions, emoji, channels, or message snowflakes. It accepts a NORMALIZED inbound
 * interaction — `{ surface, reviewer_id, action, selected_variant?, content_id?, card_ref?,
 * edit_diff?, attached_media_ref?, rejection_reason?, decision_message_ref? }` — and turns it
 * into a recorded approval decision plus the corresponding durable queue transition. The
 * Discord reference surface (engine/surfaces/discord/discord-adapter.js) is the thing that
 * normalizes a button click or an emoji reaction into that shape and renders cards back out.
 * Approval SEMANTICS live in the schema and here, never in emoji order (§12.4); a future
 * Slack-class surface reuses this core unchanged.
 *
 * The decision contract (the production daemon's behavior, generalized):
 *   approve_{recommended,a,b}  → record a §7.6 decision, run the publish-edge re-gate subset
 *                                (formatting/limits/platform/cooldown — only the layers wired
 *                                today), then transition the queue entry to `approved`
 *                                (`approved_pending_media` when an attachment is still re-gating).
 *   edit                        → edit-counts-as-approval (§2.4): re-enter the deterministic
 *                                gate subset on the edited text (DD-12/§14.5); on PASS transition
 *                                to `edited_approved`; on FAIL return the card with the reason
 *                                (no silent publish, no silent block).
 *   attach_media                → reviewer-attached media re-enters the cooldown/limit subset
 *                                (DD-12/§14.5); on PASS proceeds as approve; on FAIL returns the card.
 *   reject                      → record a §7.6 decision, transition to `rejected` (audit trail).
 *
 * Authorization (DD-17): the reviewer must be a member of the config reviewer allowlist
 * (config/system.json `reviewers[]`) with the right the action needs — `approve` for any
 * approve/reject, `edit` for edit/attach_media (edits require the same rights as approvals,
 * §11.2). A non-allowlisted or under-privileged actor is REFUSED; nothing is recorded or queued.
 * No operator ID is hardcoded anywhere (the production hardcoded-approver-ID offender, gap §2.5).
 *
 * Crash-safety / ordering (preserved verbatim from production behavior):
 *   - the durable queue write goes through engine/shared/queue.js's locked, atomic writer; the
 *     listener acquires the ONE canonical queue lock so it mutually excludes with the executor
 *     and analytics writers — no lost update.
 *   - the lock is blocking with a bounded timeout; on ELOCKTIMEOUT (executor mid-run holds the
 *     heartbeated lock) the decision is NOT recorded and the caller is told to retry — it is
 *     never swallowed into an unhandled rejection (the production adversarial-review fix).
 *   - a duplicate guard refuses to re-queue an item already in a live post-approval state.
 *
 * Modes & flags: REACTION_LISTENER_DRY_RUN=1 records the ledger decision but performs no queue
 * write and asks the surface adapter to send nothing; REACTION_LISTENER_DEBUG=1 is verbose.
 * Both are documented diagnostic overrides with fail-closed defaults (§4.5).
 *
 * Tier-3 cleanliness (§1 per-path rule): no IDs/handles/absolute paths/brand strings; all
 * instance constants (reviewer ids, channel bindings, token) come from config/secrets; no
 * production persona codename appears (§0.3 rule 6). Every write is redacted at write time via
 * the ledger / redact.js (§13.3).
 */

const fs = require('fs');

const paths = require('../shared/paths.js');
const queue = require('../shared/queue.js');
const cv2 = require('../shared/components-v2.js');
const ledger = require('./workflow-ledger.js');
const { reGate } = require('../gate/re-gate.js');

// ---------------------------------------------------------------------------
// Constants — public state vocabulary + bounded action set
// ---------------------------------------------------------------------------

// Public §8.2 queue states this core writes (state-worksheet reconciliation). Production wrote
// `state: queued`/`state: rejected`; the public model names approved / edited_approved /
// approved_pending_media / rejected.
const QUEUE_STATE = Object.freeze({
  APPROVED: 'approved',
  EDITED_APPROVED: 'edited_approved',
  APPROVED_PENDING_MEDIA: 'approved_pending_media',
  REJECTED: 'rejected',
});

// Live post-approval states an entry may already hold; re-queuing one of these would create a
// duplicate publish path, so the decision is refused (the production duplicate guard, mapped to
// the public vocabulary).
const LIVE_POST_APPROVAL_STATES = Object.freeze([
  QUEUE_STATE.APPROVED,
  QUEUE_STATE.EDITED_APPROVED,
  QUEUE_STATE.APPROVED_PENDING_MEDIA,
  'publish_intent',
  'handed_off',
  'published',
]);

// The §7.5/§7.6 action verbs (mirrors components-v2 CARD_ACTIONS). The surface adapter MUST
// hand the core one of these — surface-specific tokens (emoji, custom-id prefixes) are
// translated away before they reach here.
const ACTIONS = cv2.CARD_ACTIONS;

// Map an approve action to its selected variant slot (the §7.6 `selected_variant` enum).
const APPROVE_VARIANT = Object.freeze({
  approve_recommended: 'recommended',
  approve_a: 'a',
  approve_b: 'b',
});

// Right required to take an action (DD-17 / §11.2: edits require the same right as approvals).
function rightForAction(action) {
  if (action === 'edit' || action === 'attach_media') return 'edit';
  return 'approve'; // approve_* and reject
}

// ---------------------------------------------------------------------------
// Config — reviewer allowlist + approval-surface bindings (DD-17, §11.2)
// ---------------------------------------------------------------------------

/** Read+parse config/system.json under $CONTENT_HOME. Returns {} when absent/unreadable. */
function loadSystemConfig(env = process.env) {
  try {
    const raw = fs.readFileSync(paths.systemConfig(env), 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/**
 * Authorize a reviewer for an action against the config allowlist (DD-17). Returns
 * { ok, reviewer?, reason? }. Fail-closed: an empty/missing allowlist authorizes no one.
 */
function authorizeReviewer(reviewerId, action, config) {
  const reviewers = Array.isArray(config && config.reviewers) ? config.reviewers : [];
  if (!reviewerId) return { ok: false, reason: 'no reviewer id on the interaction' };
  const reviewer = reviewers.find((r) => r && String(r.id) === String(reviewerId));
  if (!reviewer) {
    return { ok: false, reason: 'reviewer is not on the approval allowlist (DD-17)' };
  }
  const needed = rightForAction(action);
  const rights = Array.isArray(reviewer.rights) ? reviewer.rights : [];
  if (!rights.includes(needed)) {
    return { ok: false, reason: `reviewer lacks the '${needed}' right required for ${action}` };
  }
  return { ok: true, reviewer };
}

// ---------------------------------------------------------------------------
// Decision artifact (§7.6) — the durable, attributed capture
// ---------------------------------------------------------------------------

/**
 * Build a §7.6 approval-decision object from a normalized interaction. Conforms to
 * schemas/artifacts/approval-decision.schema.json: card_ref, content_id, reviewer_id,
 * timestamp, action are required; selected_variant for approve_* and edit; rejection_reason
 * for reject; attached_media_ref for attach_media. All refs are CONTENT_HOME-relative (the surface
 * adapter and ledger normalize before they reach here).
 */
function buildDecision(interaction, env = process.env) {
  const action = interaction.action;
  const decision = {
    card_ref: interaction.card_ref || interaction.preview_message_ref || null,
    content_id: interaction.content_id || null,
    reviewer_id: interaction.reviewer_id || null,
    timestamp: new Date().toISOString(),
    action,
  };
  if (action in APPROVE_VARIANT) decision.selected_variant = APPROVE_VARIANT[action];
  if (action === 'edit') {
    decision.selected_variant = interaction.selected_variant || 'recommended';
    if (interaction.edit_diff != null) decision.edit_diff = String(interaction.edit_diff);
  }
  if (action === 'attach_media' && interaction.attached_media_ref) {
    decision.attached_media_ref = ledger.relativeToHome(interaction.attached_media_ref, env);
  }
  if (action === 'reject') {
    decision.rejection_reason = interaction.rejection_reason || 'rejected at the approval surface';
  }
  return decision;
}

// ---------------------------------------------------------------------------
// Queue transition (durable, locked, atomic) — the production crash-safety contract
// ---------------------------------------------------------------------------

/** ELOCKTIMEOUT-typed error so callers can present "retry in a moment" rather than crashing. */
function isLockTimeout(err) {
  return Boolean(err && err.code === 'ELOCKTIMEOUT');
}

/**
 * Detect whether the queue already holds the item in a live post-approval state (duplicate
 * guard). Reads the queue fresh (no lock needed for a read); returns the offending state or null.
 */
function liveDuplicateState(queuePath, contentId) {
  let raw;
  try {
    raw = fs.readFileSync(queuePath, 'utf8');
  } catch {
    return null; // no queue yet ⇒ no duplicate
  }
  const entries = queue.parseQueue(raw);
  for (const e of entries) {
    const id = e.fields.content_id || e.header;
    if (id !== contentId) continue;
    const state = (e.fields.state || '').trim();
    if (LIVE_POST_APPROVAL_STATES.includes(state)) return state;
  }
  return null;
}

/**
 * Apply the approval/rejection decision to the durable queue under the ONE canonical lock.
 * If an entry for the content id already exists it is transitioned in place (setEntryState,
 * the per-entry write-ahead path); otherwise a fresh entry block is appended. Both paths are
 * atomic. The caller MUST have passed the duplicate guard first.
 *
 * @returns { ok, mode:'transition'|'append', state } on success;
 *          throws an ELOCKTIMEOUT-coded error when the lock is busy past the timeout.
 */
function applyQueueTransition({ contentId, state, fields, env, dryRun }) {
  if (dryRun) return { ok: true, mode: 'dry-run', state };
  const queuePath = queue.queueFilePath(env);
  const lockPath = queue.queueLockFilePath(env);
  // Ensure the queue + locks dirs exist (paths.js owns the layout; we never construct paths).
  fs.mkdirSync(paths.queueLocksDir(env), { recursive: true });

  queue.acquireLockBlocking(lockPath, { owner: 'reaction-listener', timeoutMs: 30000, register: false });
  try {
    const exists = fs.existsSync(queuePath);
    const entryFields = { content_id: contentId, state, state_updated_at: new Date().toISOString(), ...fields };
    if (exists) {
      const res = queue.setEntryState(queuePath, contentId, { to: state, fields: entryFields });
      if (res.ok) return { ok: true, mode: 'transition', state };
      // No existing entry for this id ⇒ fall through to append a new one.
    }
    const block = composeEntryBlock(entryFields);
    queue.appendEntryBlock(queuePath, block);
    return { ok: true, mode: 'append', state };
  } finally {
    queue.releaseLock(lockPath);
  }
}

/** Serialize a queue entry block via the canonical serializer (FIELD_ORDER, ASCII header). */
function composeEntryBlock(fields) {
  const contentId = fields.content_id;
  return queue.serializeEntry({ header: contentId, fields });
}

// ---------------------------------------------------------------------------
// The core: normalized interaction → decision → re-gate → queue transition
// ---------------------------------------------------------------------------

/**
 * Process one normalized approval interaction.
 *
 * @param {object} interaction
 *   @param {string}  .surface              surface id (e.g. 'discord') — recorded, not branched on.
 *   @param {string}  .reviewer_id          the deciding reviewer's surface id (Tier-3, from the surface).
 *   @param {string}  .action               a §7.5 action verb (ACTIONS).
 *   @param {string} [.content_id]          the item under decision.
 *   @param {string} [.selected_variant]    explicit variant for edit; approve_* derive it.
 *   @param {string} [.card_ref]            CONTENT_HOME-relative card reference.
 *   @param {string} [.preview_message_ref] alias the surface may supply for card_ref.
 *   @param {string} [.edit_diff]           edited text/diff (edit path; §2.4 calibration signal).
 *   @param {object} [.edited_draft]        a §7.11 draft of the edited text for the DD-12 re-gate.
 *   @param {string} [.attached_media_ref]  reviewer-attached media (attach path; DD-12 re-gate).
 *   @param {string} [.rejection_reason]    reviewer's reason (reject path).
 *   @param {string} [.platform]            platform id, forwarded to the re-gate platform layer.
 *   @param {string} [.package_ref]         package path, forwarded to the re-gate package layer.
 *   @param {object} [.rules]               rule config for the re-gate lint layer.
 *   @param {object} [.cooldown]            cooldown options for the re-gate cooldown layer.
 * @param {object} [opts]
 *   @param {object} [opts.env]    environment for paths/config (default process.env).
 *   @param {object} [opts.config] pre-loaded system config (default: read from $CONTENT_HOME).
 *   @param {boolean}[opts.dryRun] override the REACTION_LISTENER_DRY_RUN env flag.
 * @returns {object} a result envelope:
 *   { ok, outcome, content_id, decision?, queue?, reason?, retry? }
 *   outcome ∈ {approved, edited_approved, approved_pending_media, rejected,
 *              unauthorized, ignored, duplicate, re_gate_failed, lock_busy, invalid}.
 *   `ok` is true only when a decision was recorded (and queued, unless dry-run).
 */
function processInteraction(interaction = {}, opts = {}) {
  const env = opts.env || process.env;
  const dryRun = opts.dryRun != null ? opts.dryRun : env.REACTION_LISTENER_DRY_RUN === '1';
  const config = opts.config || loadSystemConfig(env);

  const action = interaction.action;
  if (!ACTIONS.includes(action)) {
    return { ok: false, outcome: 'ignored', content_id: interaction.content_id || null, reason: `unknown action: ${action}` };
  }

  const contentId = interaction.content_id || null;
  if (!contentId) {
    return { ok: false, outcome: 'invalid', content_id: null, reason: 'could not resolve content_id for the interaction' };
  }

  // ── Authorization (DD-17) ───────────────────────────────────────────────
  const auth = authorizeReviewer(interaction.reviewer_id, action, config);
  if (!auth.ok) {
    return { ok: false, outcome: 'unauthorized', content_id: contentId, reason: auth.reason };
  }

  const decision = buildDecision(interaction, env);

  // ── Reject path — record + audit-trail queue entry, no publish path ──────
  if (action === 'reject') {
    return finalizeRejection({ interaction, decision, contentId, env, dryRun });
  }

  // ── Approve / edit / attach paths ───────────────────────────────────────
  // Duplicate guard FIRST: refuse to re-queue an item already in a live post-approval state.
  if (!dryRun) {
    const dup = liveDuplicateState(queue.queueFilePath(env), contentId);
    if (dup) {
      return { ok: false, outcome: 'duplicate', content_id: contentId, reason: `entry already in state '${dup}'`, decision };
    }
  }

  // Edit-as-approval and reviewer-attached media re-enter the deterministic gate subset
  // (DD-12 / §14.5). approve_* with neither an edit nor an attachment skips the re-gate (the
  // text the reviewer saw is unchanged — post-review immutability, DD-20).
  const needsReGate = action === 'edit' || action === 'attach_media' || Boolean(interaction.edited_draft) || Boolean(interaction.attached_media_ref);
  if (needsReGate) {
    const rg = reGate({
      content_id: contentId,
      draft: interaction.edited_draft || null,
      attached_media_ref: interaction.attached_media_ref || null,
      platform: interaction.platform || null,
      package_ref: interaction.package_ref || null,
      rules: interaction.rules || {},
      cooldown: interaction.cooldown || {},
      env,
    });
    if (!rg.ok) {
      // Return the card with the reason — no silent publish, no silent block (DD-12).
      ledger.editRequested(
        { content_id: contentId, edit_type: `${action}_re_gate_failed`, feedback: rg.reasons.join('; '), user_id: interaction.reviewer_id },
        env,
      );
      return { ok: false, outcome: 're_gate_failed', content_id: contentId, reason: rg.reasons.join('; '), re_gate: rg, decision };
    }
  }

  // Decide the resulting public state.
  let targetState = QUEUE_STATE.APPROVED;
  if (action === 'edit') targetState = QUEUE_STATE.EDITED_APPROVED;
  if (action === 'attach_media') targetState = QUEUE_STATE.APPROVED_PENDING_MEDIA;

  const approvedVariant = decision.selected_variant || 'recommended';
  const queueFields = {
    approved_by: interaction.reviewer_id,
    approved_variant: approvedVariant,
    approved_at: decision.timestamp,
    decision_message_ref: decision.card_ref || null,
    package_ref: interaction.package_ref ? ledger.relativeToHome(interaction.package_ref, env) : null,
    media_refs: interaction.attached_media_ref ? ledger.relativeToHome(interaction.attached_media_ref, env) : null,
    preview_message_ref: decision.card_ref || null,
  };

  // ── Durable queue transition under the canonical lock ────────────────────
  let queueResult;
  try {
    queueResult = applyQueueTransition({ contentId, state: targetState, fields: prune(queueFields), env, dryRun });
  } catch (err) {
    if (isLockTimeout(err)) {
      // Executor holds the heartbeated lock mid-run. Do NOT record an approval we could not
      // queue; tell the caller to retry (the production adversarial-review fix — never a
      // swallowed approval, never a daemon crash).
      return { ok: false, outcome: 'lock_busy', content_id: contentId, retry: true, reason: 'queue lock busy (executor mid-run); retry shortly', decision };
    }
    throw err;
  }

  // ── Ledger (attributed, redacted at write — §13.3 / DD-17) ───────────────
  if (action === 'edit') {
    ledger.approvedQueued({ content_id: contentId, variant: approvedVariant, user_id: interaction.reviewer_id, preview_message_id: decision.card_ref, package_path: interaction.package_ref, queue_path: queue.queueFilePath(env) }, env);
    ledger.editRequested({ content_id: contentId, edit_type: 'edit_approved', feedback: decision.edit_diff || null, user_id: interaction.reviewer_id }, env);
  } else {
    ledger.approvedQueued({ content_id: contentId, variant: approvedVariant, user_id: interaction.reviewer_id, preview_message_id: decision.card_ref, package_path: interaction.package_ref, queue_path: queue.queueFilePath(env) }, env);
  }

  return { ok: true, outcome: targetState, content_id: contentId, decision, queue: queueResult };
}

/** Reject path: record the attributed decision + an audit-trail rejected queue entry. */
function finalizeRejection({ interaction, decision, contentId, env, dryRun }) {
  let queueResult;
  try {
    queueResult = applyQueueTransition({
      contentId,
      state: QUEUE_STATE.REJECTED,
      fields: prune({
        approved_by: null,
        decision_message_ref: decision.card_ref || null,
        package_ref: interaction.package_ref ? ledger.relativeToHome(interaction.package_ref, env) : null,
        error: decision.rejection_reason,
      }),
      env,
      dryRun,
    });
  } catch (err) {
    if (isLockTimeout(err)) {
      return { ok: false, outcome: 'lock_busy', content_id: contentId, retry: true, reason: 'queue lock busy (executor mid-run); retry shortly', decision };
    }
    throw err;
  }
  ledger.rejected({ content_id: contentId, user_id: interaction.reviewer_id, preview_message_id: decision.card_ref, package_path: interaction.package_ref, reason: decision.rejection_reason }, env);
  return { ok: true, outcome: QUEUE_STATE.REJECTED, content_id: contentId, decision, queue: queueResult };
}

/** Drop null/undefined fields so the queue serializer emits only present values. */
function prune(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== null && v !== undefined) out[k] = v;
  }
  return out;
}

module.exports = {
  // core entry point (surface-neutral)
  processInteraction,
  // decision + authorization building blocks (reused by the surface adapter + tests)
  buildDecision,
  authorizeReviewer,
  rightForAction,
  loadSystemConfig,
  liveDuplicateState,
  // constants
  ACTIONS,
  QUEUE_STATE,
  LIVE_POST_APPROVAL_STATES,
  APPROVE_VARIANT,
};
