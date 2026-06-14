'use strict';

/**
 * engine/publishers/giphy.js  [A adapted]
 *
 * The platform-direct publisher adapter (release-spec §12.3; RD-7 second platform; RD-11
 * platform-direct credentials). Unlike Postiz (the multi-platform draft backend), Giphy has no
 * draft/second-gate concept — an upload goes live immediately — so its safety is a **fail-closed
 * dual env-gate** that this adapter PRESERVES exactly while normalizing the production CLI
 * uploader into the seam (gap §2.5 publisher-seam row: the production Giphy bypass is folded
 * into §12.3, not left as a side door).
 *
 * The two opt-ins, both required for a live upload (ported verbatim, §4.5 overrides):
 *   - GIPHY_UPLOAD_LIVE=1     (or options.live)          — "actually attempt the upload"
 *   - GIPHY_APPROVED_LIVE=1   (or options.confirmed_live) — "the reviewer approved this upload"
 * Absent the FIRST, handoff is a dry-run that validates and returns without any network call.
 * Absent the SECOND while the first is set, handoff is BLOCKED (fail-closed) — never silently
 * promoted to live. Only with BOTH set (and a resolvable GIPHY_API_KEY) does the adapter call
 * the Giphy upload endpoint.
 *
 * Behavior preserved from the production uploader (the CORRECT validation + fail-closed flow):
 *   - tag normalization (dedup, <=20, trim) and at-least-one-tag requirement; username @-strip;
 *     file-extension + MIME allow-list; the dry-run-then-block-then-upload ordering.
 * What was stripped/normalized for the public seam (Tier-3, §0.3 r6 / RD-3):
 *   - NO instance-directory config json, NO local upload-log markdown file, NO ffprobe shell-out
 *     (media probing/validation is the packager/visual-gate's job — §14.1; the publisher adapter
 *     publishes, it does not re-probe), NO operator-name strings, NO CLI arg/manifest parsing
 *     (the adapter takes a §7.4 package + options object — the executor drives it, not argv).
 *   - credentials resolve via engine/shared/secrets.js by NAME only (GIPHY_API_KEY — Tier 1;
 *     GIPHY_USERNAME — Tier 3 identifier, §4.2) and are read ONLY inside this adapter (RD-11).
 *   - the §18.2 fail-closed test guard keys off ENGINE_TEST_MODE (the §4.5 test toggle) + the
 *     `TEST-`-prefixed content_id rule: test content can never reach a real Giphy upload.
 *
 * Registers itself as "giphy" on require.
 */

const fs = require('fs');
const path = require('path');
const { Blob } = require('buffer');
const { getSecret } = require('../shared/secrets.js');
const { PUBLISH_STATE, METRIC_CHECKPOINTS, register } = require('./publisher.js');

const ADAPTER_NAME = 'giphy';
const CONSUMER = 'publisher adapter (giphy)';
const UPLOAD_ENDPOINT = 'https://upload.giphy.com/v1/gifs';
const GIF_ENDPOINT = 'https://api.giphy.com/v1/gifs';
const REQUEST_TIMEOUT_MS = 300_000; // GIF/MP4 uploads can be multi-MB on residential upstream.
const MAX_TAGS = 20;

const MIME_BY_EXT = {
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
};

/** Tag normalization (ported): trim, dedup case-insensitively, cap at 20. */
function normalizeTags(input, defaults) {
  const raw = Array.isArray(input) ? input : String(input || '').split(',');
  const combined = [...raw, ...(defaults || [])].map((t) => String(t).trim()).filter(Boolean);
  const seen = new Set();
  const tags = [];
  for (const tag of combined) {
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
  }
  return tags.slice(0, MAX_TAGS);
}

/** Strip leading @ from a username (ported). */
function normalizeUsername(input) {
  return String(input || '').trim().replace(/^@+/u, '');
}

/**
 * The §18.2 fail-closed test guard (renamed env). Test content may NEVER reach a real upload.
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
 * Read the upload request from a §7.4 package + options. Giphy lanes use GIPHY_USERNAME (§4.2)
 * rather than a Postiz integration_ref (§11.3).
 */
function readPackage(pkg, options, env) {
  const header = (pkg && pkg.audit_header) || pkg || {};
  const contentId = header.content_id;
  const brand = header.brand;
  // A local media file to upload, or a remotely-hosted source image url.
  const file = (options && options.file) || header.media_path || (header.media && header.media[0]) || null;
  const sourceImageUrl = (options && options.source_image_url) || header.source_image_url || null;
  const tags = normalizeTags(
    (options && options.tags) != null ? options.tags : header.tags,
    (options && options.default_tags) || [],
  );
  const sourcePostUrl = (options && options.source_post_url) || header.source_post_url || '';
  const username = normalizeUsername(
    (options && options.username) || header.username || getSecret('GIPHY_USERNAME', { env }) || '',
  );
  const countryCode = (options && options.country_code) || header.country_code || 'US';
  const region = (options && options.region) || header.region || '';
  return { contentId, brand, file, sourceImageUrl, tags, sourcePostUrl, username, countryCode, region };
}

/** Validate the request (ported, sans ffprobe — probing is the gate's job, §14.1). */
function validateRequest(req) {
  const errors = [];
  if (!req.file && !req.sourceImageUrl) errors.push('Either a media file or source_image_url is required.');
  if (req.file && !req.sourceImageUrl) {
    if (!fs.existsSync(req.file)) errors.push(`File not found: ${req.file}`);
    else {
      const ext = path.extname(req.file).toLowerCase();
      if (!MIME_BY_EXT[ext]) errors.push(`Unsupported file extension: ${ext}`);
    }
  }
  if (req.tags.length === 0) errors.push('At least one Giphy tag is required.');
  if (req.tags.length > MAX_TAGS) errors.push(`Giphy supports a maximum of ${MAX_TAGS} tags per upload.`);
  return errors;
}

/** Build and POST the multipart upload (ported network shape). */
async function upload(req, apiKey, fetchImpl = fetch) {
  const form = new FormData();
  form.append('api_key', apiKey);
  if (req.username) form.append('username', req.username);
  if (req.tags.length) form.append('tags', req.tags.join(', '));
  if (req.sourcePostUrl) form.append('source_post_url', req.sourcePostUrl);
  if (req.countryCode) form.append('country_code', req.countryCode);
  if (req.region) form.append('region', req.region);

  if (req.sourceImageUrl) {
    form.append('source_image_url', req.sourceImageUrl);
  } else {
    const ext = path.extname(req.file).toLowerCase();
    const blob = new Blob([fs.readFileSync(req.file)], { type: MIME_BY_EXT[ext] });
    form.append('file', blob, path.basename(req.file));
  }

  const res = await fetchImpl(UPLOAD_ENDPOINT, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }
  if (!res.ok) {
    const message = (body && body.meta && body.meta.msg) || (body && body.message) || res.statusText;
    const err = new Error(`Giphy upload failed HTTP ${res.status}: ${message}`);
    err.httpStatus = res.status;
    throw err;
  }
  return body;
}

/**
 * handoff(pkg, options) — Giphy is platform-direct (no draft gate), so its safety is the
 * fail-closed dual env-gate. Returns the seam contract { external_ref, state, ... }.
 *
 *   - neither gate set        -> dry-run: validate only, no network call, state HANDED_OFF
 *                                with handed_off=false flagged "dry_run" (nothing live).
 *   - UPLOAD_LIVE without APPROVED_LIVE -> BLOCKED: throws (fail-closed), never uploads.
 *   - both gates + valid key  -> live upload; on success state PUBLISHED (Giphy has no draft).
 *
 * @param {object} pkg      a §7.4 package (audit_header + variants) or a request-shaped object.
 * @param {object} [options]
 * @param {object}   [options.env]            env to read (default process.env).
 * @param {function} [options.fetchImpl]      injectable fetch (tests).
 * @param {boolean}  [options.live]           equivalent to GIPHY_UPLOAD_LIVE=1.
 * @param {boolean}  [options.confirmed_live] equivalent to GIPHY_APPROVED_LIVE=1.
 * @param {string}   [options.file]           local media file to upload.
 * @param {string}   [options.source_image_url] remote source image url instead of a file.
 * @param {string[]} [options.tags]           Giphy tags (>=1 required).
 * @returns {Promise<object>} seam contract result.
 */
async function handoff(pkg, options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || fetch;
  const req = readPackage(pkg, options, env);

  assertNotTestPublish(req.contentId, 'giphyUpload', env);

  const errors = validateRequest(req);
  if (errors.length) {
    const err = new Error(`Giphy upload validation failed: ${errors.join('; ')}`);
    err.code = 'PLAT.GIPHY_INVALID';
    err.errors = errors;
    throw err;
  }

  const liveRequested = env.GIPHY_UPLOAD_LIVE === '1' || options.live === true;
  const liveApproved = env.GIPHY_APPROVED_LIVE === '1' || options.confirmed_live === true;

  // Gate 1 absent: dry-run. Validated; nothing live. Not an error — the SAFE/preview path.
  if (!liveRequested) {
    return {
      external_ref: null,
      state: PUBLISH_STATE.HANDED_OFF,
      dry_run: true,
      handed_off: false,
      tags: req.tags,
      detail: 'validated; live upload requires GIPHY_UPLOAD_LIVE=1 plus GIPHY_APPROVED_LIVE=1.',
    };
  }

  // Gate 1 set, gate 2 absent: BLOCKED. Fail-closed — never silently promote to live.
  if (!liveApproved) {
    const err = new Error(
      'Live Giphy upload requested (GIPHY_UPLOAD_LIVE=1) without approval ' +
        '(GIPHY_APPROVED_LIVE=1 / options.confirmed_live). Refusing — fail-closed.',
    );
    err.code = 'PLAT.GIPHY_LIVE_UNAPPROVED';
    throw err;
  }

  // Both gates set. Resolve the key (required) only now, inside the adapter (RD-11).
  const apiKey = getSecret('GIPHY_API_KEY', { env, required: true, consumer: CONSUMER });

  const response = await upload(req, apiKey, fetchImpl);
  const gifId =
    (response && response.data && (response.data.id || response.data.gif_id)) || null;

  return {
    // Giphy is direct-publish: a successful upload is live immediately, so external_ref = gif id.
    external_ref: gifId || 'unknown',
    // No draft/second gate on Giphy — a confirmed upload is PUBLISHED.
    state: gifId ? PUBLISH_STATE.PUBLISHED : PUBLISH_STATE.UNVERIFIABLE,
    dry_run: false,
    handed_off: true,
    post_url: gifId ? `https://giphy.com/gifs/${gifId}` : null,
    published_at: gifId ? new Date().toISOString() : null,
    tags: req.tags,
    response,
  };
}

/**
 * verifyStatus(externalRef, options) — confirm a uploaded GIF exists at Giphy (honest, §12.3).
 * Giphy has no draft state, so a known gif id that resolves is PUBLISHED; an unknown one is
 * NOT_FOUND; an uninterpretable response is UNVERIFIABLE (never a fabricated published).
 */
async function verifyStatus(externalRef, options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || fetch;
  if (!externalRef || externalRef === 'unknown') {
    return { state: PUBLISH_STATE.UNVERIFIABLE, external_ref: externalRef || null, post_url: null };
  }
  const apiKey = getSecret('GIPHY_API_KEY', { env, required: true, consumer: CONSUMER });
  const url = `${GIF_ENDPOINT}/${encodeURIComponent(externalRef)}?api_key=${encodeURIComponent(apiKey)}`;
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }
  if (res.status === 404 || (body && body.meta && body.meta.status === 404)) {
    return { state: PUBLISH_STATE.NOT_FOUND, external_ref: externalRef, post_url: null };
  }
  if (!res.ok) {
    const err = new Error(`Giphy status check failed HTTP ${res.status}`);
    err.httpStatus = res.status;
    throw err;
  }
  const data = (body && body.data) || {};
  if (data.id) {
    return {
      state: PUBLISH_STATE.PUBLISHED,
      external_ref: externalRef,
      post_url: data.url || `https://giphy.com/gifs/${data.id}`,
    };
  }
  return { state: PUBLISH_STATE.UNVERIFIABLE, external_ref: externalRef, post_url: null };
}

/**
 * fetchMetrics — Giphy's public API exposes no per-asset engagement metrics in v1; declared
 * honestly as unsupported rather than returning fabricated numbers.
 */
async function fetchMetrics(externalRef, checkpoint, options = {}) {
  if (checkpoint && !METRIC_CHECKPOINTS.includes(checkpoint)) {
    throw new Error(`unknown analytics checkpoint "${checkpoint}"; expected one of ${METRIC_CHECKPOINTS.join(', ')}.`);
  }
  return {
    supported: false,
    external_ref: externalRef || null,
    checkpoint: checkpoint || null,
    metrics: {},
    note: 'Giphy does not expose per-asset engagement metrics through its public API in v1.',
  };
}

/** capabilities() — platform-direct, no draft gate, GIF/video media only (§12.3). */
function capabilities() {
  return {
    name: ADAPTER_NAME,
    draft_gate: false, // Giphy uploads go live immediately — safety is the dual env-gate.
    direct_publish: true,
    platforms: ['giphy'],
    media_types: Object.keys(MIME_BY_EXT),
    max_tags: MAX_TAGS,
    metrics: false,
    checkpoints: [],
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
  normalizeTags,
  normalizeUsername,
  validateRequest,
  upload,
  readPackage,
  assertNotTestPublish,
  MAX_TAGS,
};
