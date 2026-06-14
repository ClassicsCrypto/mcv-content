'use strict';

/**
 * engine/publishers/publisher.js  [N net-new]
 *
 * The publisher adapter SEAM (release-spec §12.3 publisher adapter interface; DD-10 minimal
 * adapter interfaces; model §10 #3). This is the single contract the executor publishes
 * through — no engine component may call a publisher API except inside an adapter registered
 * here (RD-11: platform-direct credentials are permitted ONLY inside a registered adapter).
 *
 * The four-method contract every adapter MUST satisfy (§12.3):
 *
 *   handoff(pkg, options) -> { external_ref, state, ... }
 *     Hand a packaged item to the publisher. **Idempotent by content_id**: handing off the
 *     same content_id twice MUST NOT create a second post (DR W#35). The reference Postiz
 *     adapter creates a DRAFT by default (the "second gate", §2.4/§8.3) and advances the queue
 *     to `handed_off`; publishing the draft is the operator's manual action.
 *
 *   verifyStatus(external_ref, options) -> { state, ... }
 *     The truth-check that advances `handed_off -> published` and prevents mis-reported
 *     publishes. This is the contract TikTok's v1 exclusion hinges on (RD-7): an adapter whose
 *     backend cannot honestly report whether a post actually published MUST NOT claim it did —
 *     it returns an UNVERIFIABLE state, never a fabricated `published`. The cautionary contract
 *     test asserts exactly this (publisher-contract.test.js).
 *
 *   fetchMetrics(external_ref, checkpoint, options) -> { metrics, ... }
 *     Engagement metrics for an analytics checkpoint (1h|24h|7d, §7.9). Adapters whose backend
 *     exposes no metrics return { supported: false }.
 *
 *   capabilities() -> { draft_gate, media_types, limits, ... }
 *     Static declaration of what the adapter supports (draft-gate support, media types, limits)
 *     so the executor and packager can route without probing.
 *
 * Public publish-lifecycle states this module names (the public §8.2 vocabulary subset the
 * adapter layer produces — NOT raw backend strings):
 *   - HANDED_OFF   : a draft/scheduled post exists at the publisher; awaiting operator publish.
 *   - PUBLISHED    : the post is live and verified.
 *   - FAILED_HANDOFF : the handoff failed and is retryable (outage class).
 *   - UNVERIFIABLE : the backend cannot confirm publish state (the RD-7 / TikTok contract case).
 *   - NOT_FOUND    : the external_ref is unknown to the backend.
 *
 * Credentials: adapters resolve their own credentials via engine/shared/secrets.js by the §4.2
 * variable NAMES only (POSTIZ_API_KEY / POSTIZ_API_URL / GIPHY_API_KEY / GIPHY_USERNAME). This
 * module hardcodes none and reads none — it only declares the contract and the registry.
 */

/**
 * Public adapter-layer lifecycle states (§8.2 subset). Adapters MUST return one of these from
 * handoff/verifyStatus — never a raw publisher-backend status string.
 */
const PUBLISH_STATE = Object.freeze({
  HANDED_OFF: 'handed_off',
  PUBLISHED: 'published',
  FAILED_HANDOFF: 'failed_handoff',
  UNVERIFIABLE: 'unverifiable',
  NOT_FOUND: 'not_found',
});

/** Analytics checkpoints an adapter's fetchMetrics may be asked for (§7.9). */
const METRIC_CHECKPOINTS = Object.freeze(['1h', '24h', '7d']);

/** The four methods every adapter MUST implement (§12.3). */
const REQUIRED_METHODS = Object.freeze([
  'handoff',
  'verifyStatus',
  'fetchMetrics',
  'capabilities',
]);

/**
 * Thrown when a name is asked of the registry that no adapter is registered under, or when a
 * registration is malformed. Typed so the executor surfaces a precise wiring error (§15.1) and
 * `engine status` can name the missing adapter.
 */
class PublisherNotRegisteredError extends Error {
  constructor(name, available) {
    const list = (available || []).join(', ') || '(none)';
    super(
      `No publisher adapter registered as "${name}". Registered adapters: ${list}. ` +
        `Register one via engine/publishers/publisher.js#register, or bind the brand's ` +
        `platform to a shipped adapter (postiz | giphy) in brand.json (§11.3).`,
    );
    this.name = 'PublisherNotRegisteredError';
    this.adapter = name;
    this.available = available || [];
  }
}

/**
 * Structural validation: an adapter is any object exposing the four §12.3 methods as functions.
 * Duck-typed (DD-1(c) runtime-neutrality — adapters need not extend a base class), but the
 * shape is enforced at register time so a malformed adapter fails loudly, not at publish time.
 * @param {object} adapter
 * @returns {string[]} list of missing/invalid method names (empty when conformant).
 */
function missingMethods(adapter) {
  if (!adapter || typeof adapter !== 'object') return [...REQUIRED_METHODS];
  return REQUIRED_METHODS.filter((m) => typeof adapter[m] !== 'function');
}

/** @param {object} adapter @returns {boolean} */
function isAdapter(adapter) {
  return missingMethods(adapter).length === 0;
}

/**
 * The adapter registry. The executor imports this, looks up the adapter named by the brand's
 * platform binding (`publisher: postiz | giphy | manual`, §11.3), and publishes through it.
 * Adapters self-register on require (postiz.js / giphy.js call register at module load), so
 * importing this module after the adapter modules gives a populated registry; tests may also
 * register stubs.
 */
const _registry = new Map();

/**
 * Register an adapter under a name (the §11.3 `publisher` enum value, e.g. 'postiz').
 * @param {string} name
 * @param {object} adapter  must satisfy the four-method §12.3 contract.
 * @throws {Error} when the adapter is malformed (names the missing methods).
 */
function register(name, adapter) {
  if (!name || typeof name !== 'string') {
    throw new Error('register(name, adapter): name must be a non-empty string.');
  }
  const missing = missingMethods(adapter);
  if (missing.length) {
    throw new Error(
      `Adapter "${name}" does not satisfy the §12.3 publisher contract; ` +
        `missing or non-function: ${missing.join(', ')}.`,
    );
  }
  _registry.set(name, adapter);
  return adapter;
}

/**
 * The factory the executor uses: resolve a registered adapter by name.
 * @param {string} name
 * @returns {object} the adapter.
 * @throws {PublisherNotRegisteredError} when no adapter is registered under `name`.
 */
function get(name) {
  const adapter = _registry.get(name);
  if (!adapter) throw new PublisherNotRegisteredError(name, [..._registry.keys()]);
  return adapter;
}

/** @param {string} name @returns {boolean} */
function has(name) {
  return _registry.has(name);
}

/** @returns {string[]} the names of all registered adapters. */
function list() {
  return [..._registry.keys()];
}

/** Test/teardown helper: drop a registration (or all, with no arg). */
function unregister(name) {
  if (name == null) {
    _registry.clear();
    return;
  }
  _registry.delete(name);
}

module.exports = {
  PUBLISH_STATE,
  METRIC_CHECKPOINTS,
  REQUIRED_METHODS,
  PublisherNotRegisteredError,
  missingMethods,
  isAdapter,
  register,
  get,
  has,
  list,
  unregister,
};
