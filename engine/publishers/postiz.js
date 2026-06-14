'use strict';

/**
 * engine/publishers/postiz.js  [A adapted]
 *
 * The reference publisher adapter (release-spec §12.3; RD-7 flagship + beta backends — Twitter/X,
 * Instagram, Facebook, YouTube). Postiz is the carrier of the **draft-only second gate** (§2.4,
 * §8.3): after a reviewer approves on the first gate (Discord), handoff creates a *draft* in
 * Postiz and the queue advances to `handed_off`; the operator publishes that draft manually in
 * Postiz, and `verifyStatus` then advances `handed_off -> published`. "Approved but nothing
 * posted yet" is the expected LIVE-mode state, not a failure (§8.3).
 *
 * Behavior preserved verbatim from the production publish path (the CORRECT, crash-safe
 * semantics — §15.1, DR W#35):
 *   - draft-by-default: `POSTIZ_DRAFT_ONLY` true unless explicitly '0' AND
 *     `POSTIZ_AUTO_PUBLISH_ALLOWED=1' (the two-opt-in auto-publish gate, §4.5 overrides;
 *     canonical home is config/system.json publish block, §11.2 — env is a diagnostic override).
 *   - the `postiz()` HTTP helper: Authorization header = the raw API key, bounded request
 *     timeout so a hung call never holds the queue lock past its TTL, real-HTTP-error vs
 *     ambiguous-abort distinction via `httpStatus` on the thrown error (DEFINITE failure = no
 *     artifact; ambiguous = an artifact MAY exist, so the caller HOLDS rather than retries).
 *   - idempotent handoff: if the create response carries no id, look up the just-created draft
 *     in a +/- window so a retried/ambiguous handoff resolves to the SAME draft, never a second
 *     post (DR W#35). A `phase` tag on thrown errors lets the executor tell "definitely no
 *     draft" from "draft may/does exist".
 *   - media upload through Postiz's upload endpoint, returning the publisher-side path.
 *
 * What was stripped/normalized for the public seam (Tier-3 de-localization, §0.3 r6 / RD-3):
 *   - NO production instance-directory `postiz-integrations.json` registry, NO hardcoded queue
 *     path, NO Discord notification of a private channel id, NO operator-name strings. The
 *     integration id arrives on the package (`integration_ref`, recorded at C2 — §11.3); the
 *     adapter is pure w.r.t. instance layout.
 *   - the production `account` field is the public `brand` field (§7.4 package).
 *   - credentials resolve via engine/shared/secrets.js by NAME only (POSTIZ_API_KEY /
 *     POSTIZ_API_URL, §4.2) — no .env path lists, no fallback chain.
 *   - the fail-closed test guard keys off `ENGINE_TEST_MODE` (the §4.5 dry-run/test toggle)
 *     plus the `TEST-`-prefixed content_id rule — test content can NEVER reach a real Postiz
 *     publish path, with no bypass env.
 *
 * Registers itself as "postiz" on require.
 */

const fs = require('fs');
const path = require('path');
const { Blob } = require('buffer');
const { getSecret } = require('../shared/secrets.js');
const {
  PUBLISH_STATE,
  METRIC_CHECKPOINTS,
  register,
} = require('./publisher.js');

const ADAPTER_NAME = 'postiz';
const CONSUMER = 'publisher adapter (postiz)';
const DEFAULT_API_URL = 'https://api.postiz.com';

// Bounded timeouts: a hung publisher call must never hold the executor's queue lock past its
// TTL (the production audit fix). Media uploads legitimately exceed the JSON ceiling.
const REQUEST_TIMEOUT_MS = 60_000;
const UPLOAD_TIMEOUT_MS = 300_000;
// Idempotency lookup window: the just-created draft is matched within +/- this of its date.
const LOOKUP_WINDOW_MS = 15 * 60 * 1000;
const LOOKUP_MATCH_TOLERANCE_MS = 2 * 60 * 1000;

const MIME_BY_EXT = {
  '.gif': 'image/gif',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
};

/** Resolve POSTIZ_API_KEY (required) and POSTIZ_API_URL (optional) via secrets.js. */
function resolveApiKey(env = process.env) {
  return getSecret('POSTIZ_API_KEY', { env, required: true, consumer: CONSUMER });
}
function resolveApiUrl(env = process.env) {
  const url = getSecret('POSTIZ_API_URL', { env });
  return url || DEFAULT_API_URL;
}

/** Draft-only is the safe default; auto-publish needs BOTH explicit opt-ins (§4.5 / §11.2). */
function autoPublishAllowed(env = process.env) {
  const draftOnly = env.POSTIZ_DRAFT_ONLY !== '0';
  return env.POSTIZ_AUTO_PUBLISH_ALLOWED === '1' && !draftOnly;
}

/**
 * The §15.1 / §18.2 fail-closed test guard, ported verbatim in behavior with the renamed env.
 * Test content (a `TEST-`-prefixed content_id) or ENGINE_TEST_MODE=1 may NEVER create a real
 * Postiz post. There is no override env to bypass it.
 */
function assertNotTestPublish(contentId, context, env = process.env) {
  const cid = String(contentId || '').trim();
  const isTestId = /^test-/iu.test(cid);
  const testModeOn = env.ENGINE_TEST_MODE === '1';
  if (isTestId || testModeOn) {
    const reason = isTestId ? `content_id "${cid}" is a TEST- id` : 'ENGINE_TEST_MODE=1';
    const err = new Error(
      `[ENGINE_TEST_MODE GUARD] Refusing ${context} — ${reason}. ` +
        `Test content can never reach a real publish path.`,
    );
    err.code = 'SYS.TEST_PUBLISH_BLOCKED';
    throw err;
  }
}

/**
 * The Postiz HTTP helper (ported). Authorization is the raw API key. A real HTTP error carries
 * `httpStatus` so callers distinguish a DEFINITE server rejection (no artifact) from an
 * ambiguous abort (an artifact may exist).
 * @param {string} endpoint  path beginning with '/'.
 * @param {string} apiKey
 * @param {string} apiUrl
 * @param {object} [options]  fetch options; `signal`/`headers` are merged.
 */
async function postizFetch(endpoint, apiKey, apiUrl, options = {}) {
  const { fetchImpl = fetch, timeoutMs = REQUEST_TIMEOUT_MS, ...rest } = options;
  const res = await fetchImpl(`${apiUrl}${endpoint}`, {
    signal: AbortSignal.timeout(timeoutMs),
    ...rest,
    headers: {
      Authorization: apiKey,
      ...(rest.headers || {}),
    },
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const detail = typeof data === 'string' ? data : JSON.stringify(data);
    const err = new Error(`${rest.method || 'GET'} ${endpoint} failed ${res.status}: ${detail}`);
    err.httpStatus = res.status;
    throw err;
  }
  return data;
}

function mimeType(file) {
  return MIME_BY_EXT[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

/** Upload a local media file to Postiz; returns the publisher-side path. */
async function uploadMedia(file, apiKey, apiUrl, fetchImpl = fetch) {
  const buf = fs.readFileSync(file);
  const form = new FormData();
  form.append('file', new Blob([buf], { type: mimeType(file) }), path.basename(file));
  const data = await postizFetch('/public/v1/upload', apiKey, apiUrl, {
    method: 'POST',
    body: form,
    timeoutMs: UPLOAD_TIMEOUT_MS,
    fetchImpl,
  });
  return data && data.path;
}

/** Strip HTML to plain text for the idempotency body match (ported). */
function htmlToPlainText(value) {
  return String(value || '')
    .replace(/<br\s*\/?>/giu, '\n')
    .replace(/<\/p>/giu, '\n')
    .replace(/<[^>]+>/gu, '')
    .replace(/&nbsp;/gu, ' ')
    .replace(/&amp;/gu, '&')
    .trim();
}

/** A thread copy with N/M markers splits into segments; otherwise a single post (ported). */
function splitThreadCopy(copy) {
  const text = String(copy || '').trim();
  if (!text) return [];
  const marker = /^\s*\d+\/\d+\s*$/mu;
  if (!marker.test(text)) return [text];
  const lines = text.split(/\r?\n/u);
  const parts = [];
  let current = [];
  for (const line of lines) {
    if (/^\s*\d+\/\d+\s*$/u.test(line) && current.length) {
      parts.push(current.join('\n').trim());
      current = [line.trim()];
      continue;
    }
    current.push(line);
  }
  if (current.length) parts.push(current.join('\n').trim());
  return parts.filter(Boolean);
}

/** Build the per-segment `posts[].value` array (ported, brand-neutral). */
function valuesFor(pkg, content, mediaUrl) {
  const isThread = /thread/iu.test(pkg.format || '');
  const parts = isThread ? splitThreadCopy(content) : [content];
  return parts.map((part, index) => ({
    content: part,
    image: index === 0 && mediaUrl ? [{ id: `media-${pkg.content_id}`, path: mediaUrl }] : [],
    delay: 0,
  }));
}

/** The draft date: the slot's scheduled time if it is still in the future, else a near offset. */
function draftDateFor(pkg, offsetIndex = 0) {
  const scheduled = Date.parse(pkg.schedule_time || '');
  const now = Date.now();
  if (!Number.isNaN(scheduled) && scheduled > now) return new Date(scheduled).toISOString();
  return new Date(now + (offsetIndex + 1) * 5 * 60 * 1000).toISOString();
}

/**
 * Idempotency lookup: when the create response exposed no id, find the draft we just created in
 * a +/- window so a retried/ambiguous handoff resolves to the SAME draft (DR W#35).
 */
async function lookupDraftId(apiKey, apiUrl, integrationRef, draftDate, content, fetchImpl = fetch) {
  const target = Date.parse(draftDate);
  if (Number.isNaN(target)) return null;
  const params = new URLSearchParams({
    startDate: new Date(target - LOOKUP_WINDOW_MS).toISOString(),
    endDate: new Date(target + LOOKUP_WINDOW_MS).toISOString(),
  });
  const listed = await postizFetch(`/public/v1/posts?${params.toString()}`, apiKey, apiUrl, {
    fetchImpl,
  });
  const posts = Array.isArray(listed && listed.posts) ? listed.posts : [];
  const expected = String(content || '').trim().split(/\r?\n/u).find(Boolean) || '';
  const match = posts.find((post) => {
    const sameIntegration = post && post.integration && post.integration.id === integrationRef;
    const isDraft = String((post && post.state) || '').toUpperCase() === 'DRAFT';
    const sameWindow =
      Math.abs(Date.parse((post && post.publishDate) || '') - target) <= LOOKUP_MATCH_TOLERANCE_MS;
    const body = htmlToPlainText(post && post.content);
    return (
      sameIntegration &&
      isDraft &&
      sameWindow &&
      (!expected || body.includes(expected.slice(0, 80)))
    );
  });
  return (match && match.id) || null;
}

/**
 * Extract the publishable copy + binding fields from a §7.4 package. The executor passes the
 * already-approved variant; we accept either an explicit `options.content` or the Recommended
 * variant text as the default.
 */
function readPackage(pkg, options) {
  const header = (pkg && pkg.audit_header) || pkg || {};
  const contentId = header.content_id;
  const brand = header.brand;
  const platform = header.platform;
  const format = header.format;
  const scheduleTime = header.schedule_time;
  // integration_ref is the Postiz integration id for the brand's connected account (§11.3).
  const integrationRef =
    (options && options.integration_ref) ||
    header.integration_ref ||
    (pkg && pkg.integration_ref);
  // Approved copy: explicit override, else the Recommended variant (DD-11), else variant_a.
  const variant = (pkg && (pkg.recommended || pkg.variant_a)) || {};
  const content =
    (options && options.content) ||
    header.approved_copy ||
    variant.text ||
    '';
  // Optional local media path to upload (CONTENT_HOME-relative refs are resolved by the caller).
  const mediaPath = (options && options.media_path) || header.media_path || null;
  return { contentId, brand, platform, format, scheduleTime, integrationRef, content, mediaPath };
}

/**
 * handoff(pkg, options) — create a Postiz DRAFT by default (the second gate). Idempotent by
 * content_id via the post-create lookup. Returns the seam contract { external_ref, state, ... }.
 *
 * @param {object} pkg      a §7.4 package (audit_header + variants).
 * @param {object} [options]
 * @param {object}   [options.env]          env to read (default process.env).
 * @param {function} [options.fetchImpl]    injectable fetch (tests).
 * @param {string}   [options.content]      explicit approved copy (else Recommended variant).
 * @param {string}   [options.integration_ref] override the package's integration id.
 * @param {string}   [options.media_path]   local media file to upload.
 * @param {number}   [options.offsetIndex]  stagger index for the draft date.
 * @returns {Promise<{external_ref:string, state:string, type:string, draft_date:string,
 *                     integration_ref:string, auto_publish:boolean, response:object}>}
 */
async function handoff(pkg, options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || fetch;
  const { contentId, format, scheduleTime, integrationRef, content, mediaPath } = readPackage(
    pkg,
    options,
  );

  assertNotTestPublish(contentId, 'createPostizDraft', env);
  if (!integrationRef) {
    throw new Error(
      `no Postiz integration_ref for content_id "${contentId}". Record the integration id ` +
        `Postiz shows for the connected account as platforms[].integration_ref in brand.json ` +
        `(§11.3) before publishing.`,
    );
  }
  if (!content) throw new Error(`no approved content found for content_id "${contentId}".`);

  const apiKey = resolveApiKey(env);
  const apiUrl = resolveApiUrl(env);

  const mediaUrl = mediaPath ? await uploadMedia(mediaPath, apiKey, apiUrl, fetchImpl) : null;

  // Draft-only by default; auto-publish needs BOTH explicit opt-ins (§4.5/§11.2).
  const autoPublish = autoPublishAllowed(env);
  let postType = 'draft';
  let date;
  if (autoPublish) {
    const scheduledAt = Date.parse(scheduleTime || '');
    if (!Number.isFinite(scheduledAt)) {
      throw new Error(
        `auto-publish allowed but schedule_time is missing/invalid for "${contentId}"; ` +
          `refusing to create an open-ended scheduled post.`,
      );
    }
    // Postiz needs a future time; a past slot fires promptly at now+60s.
    date = new Date(Math.max(scheduledAt, Date.now() + 60 * 1000)).toISOString();
    postType = 'schedule';
  } else {
    date = draftDateFor({ schedule_time: scheduleTime, format }, options.offsetIndex || 0);
  }

  const postData = {
    type: postType,
    date,
    shortLink: true,
    tags: [],
    posts: [
      {
        integration: { id: integrationRef },
        value: valuesFor({ content_id: contentId, format }, content, mediaUrl),
      },
    ],
  };

  // `phase` distinguishes "definitely no draft" (post phase) from "draft may exist"
  // (post-succeeded phase) so a mid-flight error HOLDS rather than blindly retries.
  let created;
  try {
    created = await postizFetch('/public/v1/posts', apiKey, apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(postData),
      fetchImpl,
    });
  } catch (err) {
    err.phase = 'post';
    throw err;
  }

  const responseId =
    (created && created.id) ||
    (created && created.posts && created.posts[0] && created.posts[0].id) ||
    (created && created.post && created.post.id) ||
    null;
  let externalRef = responseId;
  if (!externalRef) {
    try {
      externalRef = await lookupDraftId(apiKey, apiUrl, integrationRef, date, content, fetchImpl);
    } catch (err) {
      err.phase = 'post-succeeded';
      throw err;
    }
  }

  return {
    external_ref: externalRef || 'unknown',
    // A draft existing = handed_off (the second gate); a scheduled auto-publish is still
    // handed_off until verifyStatus confirms it went live.
    state: PUBLISH_STATE.HANDED_OFF,
    type: postType,
    draft_date: date,
    integration_ref: integrationRef,
    media_url: mediaUrl || null,
    auto_publish: autoPublish,
    response: created,
  };
}

/**
 * verifyStatus(externalRef, options) — the truth-check. Polls Postiz for the post's real state
 * and maps it onto the public §8.2 vocabulary. Honest by construction: an unknown ref is
 * NOT_FOUND, a still-draft is HANDED_OFF, and only a backend-confirmed live post is PUBLISHED.
 * If the backend response cannot be interpreted it returns UNVERIFIABLE — never a fabricated
 * `published` (the RD-7 contract that excludes TikTok).
 *
 * @param {string} externalRef
 * @param {object} [options]  { env, fetchImpl }
 * @returns {Promise<{state:string, external_ref:string, post_url:(string|null),
 *                     published_at:(string|null), backend_state:(string|null)}>}
 */
async function verifyStatus(externalRef, options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || fetch;
  if (!externalRef || externalRef === 'unknown') {
    return { state: PUBLISH_STATE.UNVERIFIABLE, external_ref: externalRef || null, post_url: null, published_at: null, backend_state: null };
  }
  const apiKey = resolveApiKey(env);
  const apiUrl = resolveApiUrl(env);

  let data;
  try {
    data = await postizFetch(`/public/v1/posts/${encodeURIComponent(externalRef)}`, apiKey, apiUrl, {
      fetchImpl,
    });
  } catch (err) {
    if (err.httpStatus === 404) {
      return { state: PUBLISH_STATE.NOT_FOUND, external_ref: externalRef, post_url: null, published_at: null, backend_state: null };
    }
    // An outage/ambiguous error is NOT a publish confirmation — surface it as unverifiable so
    // the executor keeps the entry in handed_off and retries the check, never claims published.
    throw err;
  }

  const post = (data && data.post) || data || {};
  const backendState = String(post.state || '').toUpperCase();
  const postUrl = post.url || post.postUrl || post.releaseURL || null;

  if (backendState === 'PUBLISHED' || post.publishedAt || postUrl) {
    return {
      state: PUBLISH_STATE.PUBLISHED,
      external_ref: externalRef,
      post_url: postUrl,
      published_at: post.publishedAt || post.releaseDate || null,
      backend_state: backendState || null,
    };
  }
  if (backendState === 'DRAFT' || backendState === 'QUEUE' || backendState === 'SCHEDULE') {
    return { state: PUBLISH_STATE.HANDED_OFF, external_ref: externalRef, post_url: null, published_at: null, backend_state: backendState };
  }
  // Unknown/empty backend state: do not guess. Honest unverifiable.
  return { state: PUBLISH_STATE.UNVERIFIABLE, external_ref: externalRef, post_url: postUrl, published_at: null, backend_state: backendState || null };
}

/**
 * fetchMetrics(externalRef, checkpoint, options) — engagement metrics for an analytics
 * checkpoint (§7.9). Pulls the post's stats; returns a normalized metrics block. Backends that
 * expose no metrics for a post return { supported: true, metrics: {} } (empty, not an error).
 */
async function fetchMetrics(externalRef, checkpoint, options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || fetch;
  if (checkpoint && !METRIC_CHECKPOINTS.includes(checkpoint)) {
    throw new Error(`unknown analytics checkpoint "${checkpoint}"; expected one of ${METRIC_CHECKPOINTS.join(', ')}.`);
  }
  if (!externalRef || externalRef === 'unknown') {
    return { supported: false, external_ref: externalRef || null, checkpoint: checkpoint || null, metrics: {} };
  }
  const apiKey = resolveApiKey(env);
  const apiUrl = resolveApiUrl(env);
  const data = await postizFetch(
    `/public/v1/posts/${encodeURIComponent(externalRef)}/statistics`,
    apiKey,
    apiUrl,
    { fetchImpl },
  );
  const metrics = (data && (data.statistics || data.metrics || data)) || {};
  return { supported: true, external_ref: externalRef, checkpoint: checkpoint || null, metrics };
}

/**
 * capabilities() — static contract declaration (§12.3). Postiz supports the draft-gate (the
 * second gate is its whole point), multi-platform handoff, and the common media types.
 */
function capabilities() {
  return {
    name: ADAPTER_NAME,
    draft_gate: true, // the second gate (§8.3) — the reference draft-by-default backend.
    direct_publish: false, // publishing the draft is the operator's manual action by default.
    platforms: ['twitter', 'instagram', 'facebook', 'youtube'], // RD-7 set (Twitter flagship; IG/FB/YT beta).
    media_types: Object.keys(MIME_BY_EXT),
    metrics: true,
    checkpoints: [...METRIC_CHECKPOINTS],
  };
}

const adapter = {
  name: ADAPTER_NAME,
  handoff,
  verifyStatus,
  fetchMetrics,
  capabilities,
};

register(ADAPTER_NAME, adapter);

module.exports = adapter;
// Internals exported for the co-located tests (not part of the §12.3 public contract).
module.exports._internal = {
  postizFetch,
  uploadMedia,
  lookupDraftId,
  splitThreadCopy,
  valuesFor,
  draftDateFor,
  htmlToPlainText,
  autoPublishAllowed,
  assertNotTestPublish,
  resolveApiUrl,
  readPackage,
};
