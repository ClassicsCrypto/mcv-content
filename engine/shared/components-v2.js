'use strict';

/**
 * engine/shared/components-v2.js  [E — extracted: Discord card builder]
 *
 * The approval-surface REFERENCE IMPLEMENTATION behind the surface-neutral approval
 * card (release-spec §7.5 card schema; §12.4 approval-surface abstraction; DD-10).
 *
 * Two layers, deliberately separable (§12.4 — the interface is the schema, NOT the
 * component tree or the emoji order):
 *
 *   1. buildCard(neutral)  — SURFACE-NEUTRAL. Takes a card object shaped by
 *      schemas/artifacts/approval-card.schema.json (content_id, title, variants[],
 *      media[], warnings[], scheduled_time, provenance, ttl/expires_at, actions[],
 *      status, …) and returns a normalized, validated neutral card. No Discord in,
 *      no Discord out. This is what any approval surface (Discord, Slack-class,
 *      web) consumes. Additional surfaces are roadmap behind this exact shape.
 *
 *   2. renderDiscord(card) — the Discord Components-v2 (CV2) rendering of a neutral
 *      card: the container tree (type_17), pre-rendered text blocks (type_10), at
 *      most one media gallery (type_12), and the bounded approval action row mapped
 *      from card.actions[]. Reaction-emoji parity is reference-implementation detail
 *      only — the load-bearing decision contract lives in the card's actions[] and in
 *      the approval-decision schema (§7.6), never in emoji order.
 *
 * Also exports the CV2 element factories, the message-payload helper, and the
 * component-tree walkers (countTypes / findContentId / collectButtons /
 * collectMediaUrls / extractText / inferFormatFromCounts / walkComponents). These are
 * the single source of truth for hand-built CV2 payloads that were otherwise
 * duplicated across the poster, the readback validator, and the reaction listener;
 * the walkers recurse both `.components` (what the surface SDK emits) and `.children`
 * (defensive parity). The walkers are the executable spec the readback check gates on:
 * the renderer emits exactly the types that check asserts (one container, exactly one
 * media gallery for media cards, the full bounded action row, an extractable content
 * id from card text).
 *
 * Tier-3 hygiene: this module hardcodes NO channel/guild/message ids and NO surface
 * tokens. The custom-id namespace and action verbs are surface-neutral; channel-role
 * bindings and the bot credential are resolved by the caller from config/system.json
 * `approval_surface` + engine/shared/secrets.js — never from literals here.
 */

const { redact } = require('./redact.js');

// ---------------------------------------------------------------------------
// Surface-neutral contract constants
// ---------------------------------------------------------------------------

// The bounded action set from the approval-card schema (§7.5 actions[] enum). These
// are surface verbs; the adapter binds each to its own control (a button here).
const CARD_ACTIONS = Object.freeze([
  'approve_recommended',
  'approve_a',
  'approve_b',
  'edit',
  'attach_media',
  'reject',
]);

// Variant slot labels in ranked order, strongest first (§7.5 variants[].label enum).
const VARIANT_LABELS = Object.freeze(['recommended', 'a', 'b']);

// ---------------------------------------------------------------------------
// Discord Components-v2 (CV2) reference-implementation constants
// ---------------------------------------------------------------------------

// CV2 message flag (IsComponentsV2). The wire flag is a fixed protocol constant, so
// the module uses the raw literal rather than depending on a particular SDK build.
const FLAGS_IS_COMPONENTS_V2 = 1 << 15; // 32768

// One content-id regex, shared (no /g flag → no lastIndex state). Matches the
// "Content ID: <id>" line the renderer writes into the card's metadata block so the
// readback walker can recover the id from the live message text.
const CONTENT_ID_RE = /Content\s*ID[:\s]*\**\s*([A-Za-z0-9_\-]+)/iu;

// Custom-id namespace for the approval controls (surface-neutral; no production
// codename). Format: `<NS>:<action>:<variant?>:<contentId>`. The action token is the
// schema action verb (CARD_ACTIONS); variant is present only for the approve_* verbs.
const CUSTOM_ID_NS = 'oce-approval';

// Discord button styles (CV2 type_2 `style`): 1 primary · 2 secondary · 3 success ·
// 4 danger · 5 link. Approval-row style assignment is reference detail.
const BUTTON_STYLE = Object.freeze({
  PRIMARY: 1, SECONDARY: 2, SUCCESS: 3, DANGER: 4, LINK: 5,
});

// Per-action button presentation (label + style). Reference-implementation only — the
// reviewer-facing meaning is fixed by the action verb, not by color or wording.
const ACTION_PRESENTATION = Object.freeze({
  approve_recommended: { label: 'Approve Recommended', style: BUTTON_STYLE.SUCCESS },
  approve_a:           { label: 'Approve A',           style: BUTTON_STYLE.PRIMARY },
  approve_b:           { label: 'Approve B',           style: BUTTON_STYLE.PRIMARY },
  edit:                { label: 'Edit',                style: BUTTON_STYLE.SECONDARY },
  attach_media:        { label: 'Attach Media',        style: BUTTON_STYLE.SECONDARY },
  reject:              { label: 'Reject',              style: BUTTON_STYLE.DANGER },
});

// Canonical reaction-emoji set (legacy/alternate approval input). REFERENCE DETAIL —
// kept so an operator on a reaction-only client still has the full bounded action set,
// but the load-bearing contract is actions[]/buttons, never emoji order (§12.4).
const REACTION_EMOJI = Object.freeze({
  approve_recommended: '✅',          // ✅
  approve_a: '\u{1F170}️',           // 🅰️
  approve_b: '\u{1F171}️',           // 🅱️
  attach_media: '\u{1F4CE}',              // 📎
  edit: '✏️',                   // ✏️
  reject: '❌',                       // ❌
});

// ---------------------------------------------------------------------------
// Element builders (typed CV2 component factories)
// ---------------------------------------------------------------------------

function textDisplay(content) {
  return { type: 10, content };
}

function separator() {
  return { type: 14 };
}

function mediaGallery(urls) {
  // { type:12, items:[{ media:{ url } }] } — the shape collectMediaUrls + the media
  // gate (mediaGalleryCount === 1) expect.
  return { type: 12, items: (urls || []).map((url) => ({ media: { url } })) };
}

function thumbnail(url) {
  return { type: 11, media: { url } };
}

function section(components, accessory) {
  const s = { type: 9, components };
  if (accessory) s.accessory = accessory;
  return s;
}

function button({ style, label, customId, url, disabled } = {}) {
  const b = { type: 2 };
  if (style != null) b.style = style;
  if (label != null) b.label = label;
  if (customId != null) b.custom_id = customId;
  if (url != null) b.url = url;
  if (disabled) b.disabled = true;
  return b;
}

function linkButton(label, url) {
  return { type: 2, style: BUTTON_STYLE.LINK, label, url };
}

function actionRow(buttons) {
  return { type: 1, components: buttons };
}

function container(children) {
  return { type: 17, components: children };
}

// ---------------------------------------------------------------------------
// Approval controls (custom-id namespace + action row)
// ---------------------------------------------------------------------------

// `<NS>:<action>:<variant?>:<contentId>` — empty segments dropped via filter, so the
// non-variant verbs (edit/attach_media/reject) produce `<NS>:<action>:<contentId>`.
function buttonCustomId(contentId, action, variant = '') {
  return [CUSTOM_ID_NS, action, variant, contentId].filter(Boolean).join(':');
}

// Map a schema action verb to its control custom-id. approve_{recommended,a,b} carry
// the variant slot as a segment so the surface listener can attribute the selection.
function customIdForAction(contentId, action) {
  if (action === 'approve_recommended') return buttonCustomId(contentId, 'approve', 'recommended');
  if (action === 'approve_a') return buttonCustomId(contentId, 'approve', 'a');
  if (action === 'approve_b') return buttonCustomId(contentId, 'approve', 'b');
  return buttonCustomId(contentId, action);
}

// Build the approval action row from a bounded, ordered action list. Defaults to the
// full schema action set in canonical order when none is supplied.
function buildApprovalRow(contentId, actions = CARD_ACTIONS) {
  const ordered = CARD_ACTIONS.filter((a) => actions.includes(a));
  return {
    type: 1,
    components: ordered.map((action) => {
      const pres = ACTION_PRESENTATION[action];
      return { type: 2, style: pres.style, label: pres.label, custom_id: customIdForAction(contentId, action) };
    }),
  };
}

// ---------------------------------------------------------------------------
// Message payload helper
// ---------------------------------------------------------------------------

function v2Payload(components, extra = {}) {
  return { flags: FLAGS_IS_COMPONENTS_V2, components, allowed_mentions: { parse: [] }, ...extra };
}

// ---------------------------------------------------------------------------
// Tree walkers — the canonical copies (single source of truth). Each recurses into
// both `.components` (what the surface SDK emits) and `.children` (defensive parity).
// ---------------------------------------------------------------------------

// Generic DFS primitive. visit(component) is called for every node.
function walkComponents(components, visit) {
  if (!Array.isArray(components)) return;
  const stack = [...components];
  while (stack.length) {
    const c = stack.shift();
    if (!c) continue;
    visit(c);
    if (Array.isArray(c.components)) stack.push(...c.components);
    if (Array.isArray(c.children)) stack.push(...c.children);
  }
}

// content/text only (NOT label/description) — a content id inside a button label is
// intentionally NOT matched (avoids false positives from the action controls).
function findContentId(components) {
  if (!Array.isArray(components)) return null;
  const stack = [...components];
  while (stack.length) {
    const c = stack.shift();
    if (!c) continue;
    for (const k of ['content', 'text']) {
      if (typeof c[k] === 'string') {
        const m = c[k].match(CONTENT_ID_RE);
        if (m) return m[1].trim();
      }
    }
    if (Array.isArray(c.components)) stack.push(...c.components);
    if (Array.isArray(c.children)) stack.push(...c.children);
  }
  return null;
}

// Keys as `type_<n>` — the form the readback check gates on.
function countTypes(components) {
  const counts = {};
  if (!Array.isArray(components)) return counts;
  const stack = [...components];
  while (stack.length) {
    const c = stack.shift();
    if (!c) continue;
    if (typeof c.type === 'number') counts[`type_${c.type}`] = (counts[`type_${c.type}`] || 0) + 1;
    if (Array.isArray(c.components)) stack.push(...c.components);
    if (Array.isArray(c.children)) stack.push(...c.children);
  }
  return counts;
}

// type-12 items[].media.url + direct media.url, deduped.
function collectMediaUrls(components) {
  const urls = [];
  if (!Array.isArray(components)) return urls;
  const stack = [...components];
  while (stack.length) {
    const c = stack.shift();
    if (!c) continue;
    if (Array.isArray(c.items)) {
      for (const item of c.items) {
        const url = item?.media?.url || item?.url;
        if (typeof url === 'string') urls.push(url);
      }
    }
    const directUrl = c?.media?.url || c?.url;
    if (typeof directUrl === 'string') urls.push(directUrl);
    if (Array.isArray(c.components)) stack.push(...c.components);
    if (Array.isArray(c.children)) stack.push(...c.children);
  }
  return [...new Set(urls)];
}

// Includes `disabled` (superset of the older preview copy).
function collectButtons(components) {
  const buttons = [];
  if (!Array.isArray(components)) return buttons;
  const stack = [...components];
  while (stack.length) {
    const c = stack.shift();
    if (!c) continue;
    if (c.type === 2) {
      buttons.push({
        label: c.label || '',
        custom_id: c.custom_id || '',
        style: c.style || null,
        disabled: Boolean(c.disabled),
      });
    }
    if (Array.isArray(c.components)) stack.push(...c.components);
    if (Array.isArray(c.children)) stack.push(...c.children);
  }
  return buttons;
}

function inferFormatFromCounts(counts) {
  if (counts.type_12 > 0) return 'image_or_video';
  if (counts.type_13 > 0) return 'thread';
  return 'text';
}

// Broadest field set (content/text/label/description) — used for free-text scans of a
// live message, where a content id may legitimately appear anywhere.
function extractText(components) {
  if (!Array.isArray(components)) return '';
  const texts = [];
  const stack = [...components];
  while (stack.length) {
    const c = stack.shift();
    if (!c) continue;
    if (typeof c.content === 'string') texts.push(c.content);
    if (typeof c.text === 'string') texts.push(c.text);
    if (typeof c.label === 'string') texts.push(c.label);
    if (typeof c.description === 'string') texts.push(c.description);
    if (Array.isArray(c.components)) stack.push(...c.components);
    if (Array.isArray(c.children)) stack.push(...c.children);
  }
  return texts.join('\n');
}

// ---------------------------------------------------------------------------
// LAYER 1 — Surface-neutral card (buildCard)
// ---------------------------------------------------------------------------

// Default actions for a card given whether it carries media: attach_media is only
// offered to the reviewer when there is no media yet (DD-12 re-gate is for the attach
// path). Callers may override with an explicit actions[] on the neutral input.
function defaultActions(hasMedia) {
  return hasMedia
    ? ['approve_recommended', 'approve_a', 'approve_b', 'edit', 'reject']
    : ['approve_recommended', 'approve_a', 'approve_b', 'edit', 'attach_media', 'reject'];
}

/**
 * Normalize + validate a neutral approval card (release-spec §7.5).
 *
 * Input: a partial card object (the package/gate stages assemble it). Output: a frozen
 * card that conforms to approval-card.schema.json — variants ranked strongest-first
 * with the Recommended slot, warnings preserved, media references kept as
 * $CONTENT_HOME-relative strings (NEVER resolved to absolute paths or signed URLs
 * here), actions bounded to the schema set, and a `pending | decided | expired` status.
 *
 * This layer is Discord-free: it knows nothing about containers, emoji, channels, or
 * buttons. renderDiscord (or any other surface adapter) consumes its output.
 *
 * @param {object} neutral
 * @returns {object} frozen neutral card
 */
function buildCard(neutral = {}) {
  if (!neutral || typeof neutral !== 'object') {
    throw new TypeError('buildCard: neutral card object required');
  }
  const contentId = neutral.content_id;
  if (typeof contentId !== 'string' || !contentId.trim()) {
    throw new Error('buildCard: content_id is required');
  }

  // Variants: keep only the known slots, dedupe by label, rank strongest-first
  // (recommended → a → b) so the surface shows the Recommended candidate first.
  const seenLabels = new Set();
  const variants = (Array.isArray(neutral.variants) ? neutral.variants : [])
    .filter((v) => v && VARIANT_LABELS.includes(v.label) && !seenLabels.has(v.label) && seenLabels.add(v.label))
    .map((v) => {
      const out = { label: v.label, text: String(v.text ?? '') };
      if (typeof v.score === 'number') out.score = v.score;
      if (typeof v.delta === 'number') out.delta = v.delta;
      if (v.bars_recommended != null) out.bars_recommended = Boolean(v.bars_recommended);
      if (v.rationale != null) out.rationale = String(v.rationale);
      return out;
    })
    .sort((x, y) => VARIANT_LABELS.indexOf(x.label) - VARIANT_LABELS.indexOf(y.label));
  if (variants.length < 1) {
    throw new Error('buildCard: at least one variant is required (the Recommended slot)');
  }

  // Media references — kept verbatim as relative refs; absolute paths are forbidden by
  // the schema, so reject anything that looks absolute rather than silently shipping it.
  const media = (Array.isArray(neutral.media) ? neutral.media : [])
    .filter((m) => m && typeof m.ref === 'string' && m.ref.trim())
    .map((m) => {
      if (/^(?:[A-Za-z]:[\\/]|[\\/]|[A-Za-z]+:\/\/)/u.test(m.ref)) {
        throw new Error(`buildCard: media.ref must be $CONTENT_HOME-relative, got an absolute/URL ref`);
      }
      const out = { ref: m.ref };
      if (m.media_type != null) out.media_type = String(m.media_type);
      if (m.source_class != null) out.source_class = String(m.source_class);
      if (m.alt_text != null) out.alt_text = String(m.alt_text);
      return out;
    });

  // Warnings — soft codes traveling with the item to the reviewer (§7.5 warnings[]).
  const warnings = (Array.isArray(neutral.warnings) ? neutral.warnings : [])
    .filter((w) => w && typeof w.code === 'string' && w.code.trim())
    .map((w) => {
      const out = { code: w.code };
      if (w.family != null) out.family = String(w.family);
      if (w.explanation != null) out.explanation = String(w.explanation);
      if (w.bars_recommended != null) out.bars_recommended = Boolean(w.bars_recommended);
      return out;
    });

  // Actions — bounded to the schema set, deduped, in canonical order. Default depends
  // on whether media is already attached.
  const requested = Array.isArray(neutral.actions) && neutral.actions.length
    ? neutral.actions
    : defaultActions(media.length > 0);
  const actions = CARD_ACTIONS.filter((a) => requested.includes(a));
  if (actions.length < 1) {
    throw new Error('buildCard: at least one valid action is required');
  }

  const status = ['pending', 'decided', 'expired'].includes(neutral.status) ? neutral.status : 'pending';

  const card = {
    content_id: contentId,
    title: typeof neutral.title === 'string' && neutral.title.trim() ? neutral.title : 'Content preview',
    variants,
    media,
    warnings,
    actions,
    status,
  };
  // Optional, copied through only when present (additionalProperties:false in schema).
  if (neutral.brand != null) card.brand = String(neutral.brand);
  if (neutral.platform != null) card.platform = String(neutral.platform);
  if (neutral.format != null) card.format = String(neutral.format);
  if (neutral.content_form != null) card.content_form = String(neutral.content_form);
  if (neutral.scheduled_time != null) card.scheduled_time = String(neutral.scheduled_time);
  if (neutral.provenance != null) card.provenance = String(neutral.provenance);
  if (neutral.ttl != null) card.ttl = String(neutral.ttl);
  if (neutral.expires_at != null) card.expires_at = String(neutral.expires_at);
  if (neutral.package_ref != null) card.package_ref = String(neutral.package_ref);
  if (neutral.created_at != null) card.created_at = String(neutral.created_at);

  return Object.freeze(card);
}

// ---------------------------------------------------------------------------
// LAYER 2 — Discord rendering (renderDiscord) — reference implementation
// ---------------------------------------------------------------------------

const VARIANT_HEADING = Object.freeze({ recommended: 'Recommended', a: 'Variant A', b: 'Variant B' });

// Soft-fail warnings block: a short reviewer-facing list of the codes traveling with
// the item, so the reviewer sees them on the card itself (model §2 invariant).
function warningsBlock(warnings) {
  if (!warnings.length) return null;
  const lines = warnings.map((w) => {
    const tag = w.bars_recommended ? ' (bars Recommended)' : '';
    const why = w.explanation ? ` — ${w.explanation}` : '';
    return `- ${w.code}${tag}${why}`;
  });
  return ['**Warnings:**', ...lines].join('\n');
}

// Metadata / "why strong" block. Includes the "Content ID:" line so findContentId can
// recover the id from the live message text on readback.
function metaBlock(card) {
  const lines = [`**${card.title}**`, '------------------------', `**Content ID:** ${card.content_id}`];
  if (card.brand) lines.push(`**Brand:** ${card.brand}`);
  if (card.platform) lines.push(`**Platform:** ${card.platform}`);
  if (card.format) lines.push(`**Format:** ${card.format}`);
  if (card.content_form && card.content_form !== 'standalone') lines.push(`**Form:** ${card.content_form}`);
  if (card.scheduled_time) lines.push(`**Scheduled:** ${card.scheduled_time}`);
  if (card.media.length) lines.push(`**Media:** ${card.media.length} attached`);
  if (card.provenance) lines.push(`**Why strong:** ${card.provenance}`);
  return lines.join('\n');
}

// One text block per variant: heading + (optional score/delta) + text + (optional
// rationale / bars-Recommended note).
function variantBlock(v) {
  const head = VARIANT_HEADING[v.label] || v.label;
  const score = typeof v.score === 'number'
    ? ` (score ${v.score}${typeof v.delta === 'number' && v.delta !== 0 ? `, Δ${v.delta}` : ''})`
    : '';
  const bars = v.bars_recommended ? ' [bars Recommended]' : '';
  const lines = [`**${head}${score}${bars}:**`, v.text];
  if (v.rationale) lines.push(`_${v.rationale}_`);
  return lines.join('\n');
}

/**
 * Render a neutral card (output of buildCard) to a Discord Components-v2 component
 * tree: a single container (type_17) holding the metadata block, an optional warnings
 * block, at most one media gallery (type_12) when the card carries media, one text
 * block per variant (strongest first), and the bounded approval action row built from
 * card.actions[]. This is the v1 reference surface (§12.4); the neutral card shape is
 * the interface, this tree is implementation detail.
 *
 * @param {object} card  a card from buildCard() (or a schema-conformant card object)
 * @param {object} [opts]
 * @param {string[]} [opts.mediaUrls]  resolved displayable media URLs (the caller
 *        resolves $CONTENT_HOME-relative refs / uploads to surface URLs; the neutral
 *        card never holds surface URLs). When omitted, no gallery is rendered.
 * @returns {Array} a CV2 component array ([container]) ready for v2Payload().
 */
function renderDiscord(card, opts = {}) {
  if (!card || typeof card !== 'object' || !card.content_id) {
    throw new Error('renderDiscord: a built card with content_id is required');
  }
  const children = [];
  children.push(textDisplay(metaBlock(card)));

  const warnBlock = warningsBlock(card.warnings || []);
  if (warnBlock) children.push(textDisplay(warnBlock));

  const mediaUrls = Array.isArray(opts.mediaUrls) ? opts.mediaUrls.filter((u) => typeof u === 'string' && u) : [];
  if (mediaUrls.length) children.push(mediaGallery(mediaUrls));

  for (const v of card.variants || []) children.push(textDisplay(variantBlock(v)));

  children.push(buildApprovalRow(card.content_id, card.actions || CARD_ACTIONS));
  return [container(children)];
}

/**
 * Render the full Discord message payload (flags + components + allowed_mentions) for
 * a neutral card. Convenience wrapper around renderDiscord + v2Payload. No channel id
 * is embedded — the caller targets the channel from config `approval_surface.channels`.
 */
function renderDiscordPayload(card, opts = {}) {
  return v2Payload(renderDiscord(card, opts), opts.extra || {});
}

// ---------------------------------------------------------------------------
// Module exports
// ---------------------------------------------------------------------------

module.exports = {
  // surface-neutral contract
  CARD_ACTIONS,
  VARIANT_LABELS,
  buildCard,
  // Discord reference implementation
  renderDiscord,
  renderDiscordPayload,
  REACTION_EMOJI,
  CUSTOM_ID_NS,
  // CV2 constants
  FLAGS_IS_COMPONENTS_V2,
  CONTENT_ID_RE,
  BUTTON_STYLE,
  // element builders
  textDisplay,
  separator,
  mediaGallery,
  thumbnail,
  section,
  button,
  linkButton,
  actionRow,
  container,
  // approval controls
  buttonCustomId,
  customIdForAction,
  buildApprovalRow,
  // payload
  v2Payload,
  // walkers
  walkComponents,
  findContentId,
  countTypes,
  collectMediaUrls,
  collectButtons,
  inferFormatFromCounts,
  extractText,
  // redaction re-export so card surfaces can scrub before logging (§13.3)
  redact,
};
