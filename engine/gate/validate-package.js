'use strict';

/**
 * engine/gate/validate-package.js  [A adapted]
 *
 * The deterministic PRE-PUBLISH gate — layer 3 of the hybrid gate (release-spec §14.1 layer 3;
 * DD-3 deterministic backstop). It runs over the platform-final package AFTER the LLM gate and
 * BEFORE the approval card is rendered, verifying the structural integrity a regex can enforce
 * for free: audit-header completeness, a passing gate verdict on LIVE packages, the presence of
 * Recommended + Variant A + Variant B (DD-11), a scores block, a source stack when a cited
 * source was used, and — for visual/video formats — a visual state, bound media, the media
 * cooldown (enforcement point 2 of the three §8.6 points, DD-14), and a passing visual check.
 * It then runs the per-platform gate registry (platform-gates.js). Any hard code FAILs the
 * package and blocks it from the approval queue (spec §2.3); the verdict travels every code
 * (union-of-codes contract, §14.1).
 *
 * Input is the schema'd package OBJECT (schemas/artifacts/package.schema.json), not a markdown
 * scrape: public packages are validated artifacts. For robustness the CLI also accepts a raw
 * markdown package file, which is parsed into the same section/field view the gate consumes —
 * but the programmatic API takes the object.
 *
 * Codes are PKG.* (this module) and PLAT.* (platform-gates), per the §10.2 registry. Every code
 * emitted MUST exist in rules/codes.md; the CODES table below is the engine's emit-side mirror.
 * Code names are brand-neutral by construction: the verdict-presence code names the gate
 * verdict (not any persona), the leak code names the enrichment stage, and the source-stack
 * code is generalized to "a cited source was used" (spec §0.3 r6).
 *
 * Cooldown rebind (DD-14, DR W#48): the production module parsed a private usage history (the
 * live queue + Discord preview residue) here. This port reads the SINGLE canonical cooldown
 * ledger via engine/library/usage-log.js — the same ledger the retrieval filter and the publish
 * executor read — WITHOUT weakening the 14/30-day family/descendant semantics. The hard-floor
 * day count comes from config (config/system.json `cooldown.hard_days`, per-brand
 * `cooldown_overrides`); the 14 fallback only guards a missing config so cooldown never silently
 * disables.
 *
 * Paths/credentials/IDs: this module constructs no instance path itself (paths.js does, via the
 * usage-log + ledger modules), hardcodes no IDs/handles/absolute roots, and carries no
 * production persona codename. The ledger write is best-effort and itself redacts at write time.
 *
 * Programmatic API (the gate pipeline calls this):
 *   const { validate } = require('./validate-package');
 *   const result = validate(pkg, { platform, env, config });
 *   // result is a validation-result (spec §7.2): { content_id, stage:'package', verdict,
 *   //   detected_codes[] (PKG.* with source 'package' + PLAT.* with source 'platform'), ... }
 *
 * CLI (operator/debug):
 *   node engine/gate/validate-package.js --package <package.(json|md)>
 *                                        [--platform twitter] [--content-id <id>] [--json]
 * Exit: 0 PASS · 1 FAIL · 2 usage error.
 */

const STAGE = 'package';
const SOURCE = 'package';
const FAMILY = 'PKG';

const usageLog = require('../library/usage-log.js');
const platformGates = require('./platform-gates.js');

// Loaded lazily inside validate() so the engine has no hard CONTENT_HOME / ledger dependency at
// require time (fixture-run + unit tests run CONTENT_HOME-free).
let workflowLedger = null;
function ledger() {
  if (workflowLedger === null) {
    try {
      // eslint-disable-next-line global-require
      workflowLedger = require('../orchestrator/workflow-ledger.js');
    } catch {
      workflowLedger = false; // sentinel: tried, unavailable.
    }
  }
  return workflowLedger || null;
}

/** Shipped cooldown hard-floor fallback (release-spec §8.6) — only used when config omits it. */
const DEFAULT_COOLDOWN_DAYS = usageLog.DEFAULT_HARD_DAYS; // 14
const MEDIA_EXT_RE = /\.(png|jpe?g|webp|gif|mp4|mov|m4v|webm)$/iu;
const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif)$/iu;

// PKG.* code metadata (code / tier / disposition / route / rule_ref) — emit-side mirror of
// rules/codes.md (spec §7.3/§10.2). All PKG codes are HARD (a structural defect blocks the
// publish edge); a soft pre-publish class does not exist in v1.
const CODES = {
  PACKAGE_INVALID:        { code: 'PKG.PACKAGE_INVALID',        tier: 'hard', disposition: 'block', route: 'packager', rule_ref: 'rule.core.packaging' },
  AUDIT_HEADER_MISSING:   { code: 'PKG.AUDIT_HEADER_MISSING',   tier: 'hard', disposition: 'block', route: 'packager', rule_ref: 'rule.core.packaging' },
  GATE_VERDICT_MISSING_FOR_LIVE:    { code: 'PKG.GATE_VERDICT_MISSING_FOR_LIVE',     tier: 'hard', disposition: 'block', route: 'gate',     rule_ref: 'rule.core.packaging' },
  GATE_VERDICT_NOT_PASSING_FOR_LIVE:{ code: 'PKG.GATE_VERDICT_NOT_PASSING_FOR_LIVE', tier: 'hard', disposition: 'block', route: 'gate',     rule_ref: 'rule.core.packaging' },
  PACKAGE_STATUS_NOT_READY:{ code: 'PKG.PACKAGE_STATUS_NOT_READY', tier: 'hard', disposition: 'block', route: 'packager', rule_ref: 'rule.core.packaging' },
  PUBLISH_STATE_NOT_READY: { code: 'PKG.PUBLISH_STATE_NOT_READY',  tier: 'hard', disposition: 'block', route: 'packager', rule_ref: 'rule.core.packaging' },
  READY_FOR_PREVIEW_NOT_READY: { code: 'PKG.READY_FOR_PREVIEW_NOT_READY', tier: 'hard', disposition: 'block', route: 'packager', rule_ref: 'rule.core.packaging' },
  READY_FOR_PUBLISH_NOT_READY: { code: 'PKG.READY_FOR_PUBLISH_NOT_READY', tier: 'hard', disposition: 'block', route: 'packager', rule_ref: 'rule.core.packaging' },
  RECOMMENDED_MISSING:    { code: 'PKG.RECOMMENDED_MISSING',     tier: 'hard', disposition: 'block', route: 'packager', rule_ref: 'rule.core.variant' },
  VARIANT_A_MISSING:      { code: 'PKG.VARIANT_A_MISSING',       tier: 'hard', disposition: 'block', route: 'packager', rule_ref: 'rule.core.variant' },
  VARIANT_B_MISSING:      { code: 'PKG.VARIANT_B_MISSING',       tier: 'hard', disposition: 'block', route: 'packager', rule_ref: 'rule.core.variant' },
  ENRICHMENT_PACKET_LEAK: { code: 'PKG.ENRICHMENT_PACKET_LEAK',  tier: 'hard', disposition: 'block', route: 'packager', rule_ref: 'rule.core.packaging' },
  SCORES_MISSING:         { code: 'PKG.SCORES_MISSING',          tier: 'hard', disposition: 'block', route: 'packager', rule_ref: 'rule.core.packaging' },
  SOURCE_STACK_MISSING:   { code: 'PKG.SOURCE_STACK_MISSING',    tier: 'hard', disposition: 'block', route: 'packager', rule_ref: 'rule.core.claims-safety' },
  VISUAL_STATE_MISSING:   { code: 'PKG.VISUAL_STATE_MISSING',    tier: 'hard', disposition: 'block', route: 'media',    rule_ref: 'rule.core.media' },
  MEDIA_MISSING:          { code: 'PKG.MEDIA_MISSING',           tier: 'hard', disposition: 'block', route: 'media',    rule_ref: 'rule.core.media' },
  MEDIA_COOLDOWN_BLOCKED: { code: 'PKG.MEDIA_COOLDOWN_BLOCKED',  tier: 'hard', disposition: 'block', route: 'media',    rule_ref: 'rule.core.cooldown' },
  VISUAL_CHECK_MISSING:   { code: 'PKG.VISUAL_CHECK_MISSING',    tier: 'hard', disposition: 'block', route: 'media',    rule_ref: 'rule.core.media' },
  VISUAL_CHECK_NOT_PASSING:{ code: 'PKG.VISUAL_CHECK_NOT_PASSING', tier: 'hard', disposition: 'block', route: 'media',  rule_ref: 'rule.core.media' },
};

/** Build a §7.2 detected_codes entry from a CODES row + explanation. */
function makeCode(meta, explanation) {
  return {
    code: meta.code,
    family: FAMILY,
    tier: meta.tier,
    source: SOURCE,
    disposition: meta.disposition,
    rule_ref: meta.rule_ref,
    explanation,
  };
}

// --- Package normalization ------------------------------------------------------------------
// Accept either the schema'd object (schemas/artifacts/package.schema.json) or a raw markdown
// string, and present a uniform view: section bodies, flat fields, and a serialized `raw` text
// the platform-gate registry + lexical checks scan.

function isString(v) {
  return typeof v === 'string';
}

/** Regex-escape a key/section name for dynamic patterns. */
function esc(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/** Build a markdown-string view's section/field readers (production-equivalent parsing). */
function rawView(raw) {
  const text = String(raw || '');
  return {
    raw: text,
    hasSection(name) {
      const re = new RegExp(`(?:^|\\n)##\\s+${esc(name)}\\b`, 'iu');
      return re.test(text);
    },
    sectionBody(name) {
      const re = new RegExp(`(?:^|\\n)##\\s+${esc(name)}\\s*\\r?\\n([\\s\\S]*?)(?=\\n##\\s+|$)`, 'iu');
      const m = text.match(re);
      return m ? m[1].trim() : '';
    },
    hasField(key) {
      const re = new RegExp(`(?:^|\\n)\\s*-?\\s*\\**\\s*${esc(key)}\\s*\\**\\s*[:=]`, 'iu');
      return re.test(text);
    },
    flatFieldValue(key) {
      const re = new RegExp(`(?:^|\\n)\\s*(?:[-*]\\s*)?(?:\\*\\*)?${esc(key)}(?:\\*\\*)?\\s*[:=]\\s*([^\\n\\r]+)`, 'iu');
      const m = text.match(re);
      return m ? m[1].trim() : null;
    },
    fieldValues(keys) {
      const out = [];
      for (const line of text.split(/\r?\n/u)) {
        for (const key of keys) {
          const re = new RegExp(`^\\s*(?:[-*]\\s*)?(?:\\*\\*)?${esc(key)}(?:\\*\\*)?\\s*:\\s*(.+)$`, 'iu');
          const m = line.match(re);
          if (m) out.push(m[1].trim());
        }
      }
      return out;
    },
  };
}

/**
 * Build the gate's package view from a structured package object (package.schema.json). It
 * synthesizes the same section/field/raw readers the platform-gate ctx + lexical checks expect,
 * sourcing them from the typed fields rather than markdown headings.
 */
function objectView(pkg) {
  const header = (pkg && pkg.audit_header) || {};
  const variants = {
    Recommended: pkg && pkg.recommended,
    'Variant A': pkg && pkg.variant_a,
    'Variant B': pkg && pkg.variant_b,
  };
  const variantText = (slot) => {
    const v = variants[slot];
    return v && isString(v.text) ? v.text : '';
  };
  // Fields the gate's hasField()/fieldValues() consult, lifted from the typed header + variants.
  const fields = { ...header };
  // A serialized text body for the lexical scans (hashtags, source-sense mention, leak scan).
  const raw = [
    ...Object.entries(header).map(([k, val]) => `${k}: ${typeof val === 'object' ? JSON.stringify(val) : val}`),
    variantText('Recommended'),
    variantText('Variant A'),
    variantText('Variant B'),
    ...(Array.isArray(pkg && pkg.source_stack) ? pkg.source_stack : []),
  ].filter(Boolean).join('\n');

  const mediaFromHeader = Array.isArray(header.media) ? header.media.map(String) : [];

  return {
    raw,
    isObject: true,
    pkg,
    header,
    hasSection(name) {
      if (name === 'Recommended') return Boolean(pkg && pkg.recommended);
      if (name === 'Variant A') return Boolean(pkg && pkg.variant_a);
      if (name === 'Variant B') return Boolean(pkg && pkg.variant_b);
      if (name === 'Source Stack') return Array.isArray(pkg && pkg.source_stack) && pkg.source_stack.length > 0;
      if (name === 'Audit Header') return Boolean(pkg && pkg.audit_header);
      if (name === 'Scores') {
        return Object.values(variants).some((v) => v && v.scores && Object.keys(v.scores).length > 0);
      }
      return false;
    },
    sectionBody(name) {
      if (name in variants) return variantText(name);
      if (name === 'Source Stack') return Array.isArray(pkg && pkg.source_stack) ? pkg.source_stack.join('\n') : '';
      return '';
    },
    hasField(key) {
      // Direct header keys, plus the explicit media/visual_state/gate_verdict header fields.
      return Object.prototype.hasOwnProperty.call(fields, key)
        && fields[key] != null
        && !(Array.isArray(fields[key]) && fields[key].length === 0);
    },
    flatFieldValue(key) {
      const v = fields[key];
      if (v == null) return null;
      return isString(v) ? v : (typeof v === 'object' ? null : String(v));
    },
    fieldValues() {
      // Media references come from the typed audit_header.media array on the object path.
      return mediaFromHeader;
    },
    mediaRefs: mediaFromHeader,
  };
}

/** Canonical mode label (SAFE / LIVE_PREVIEW / LIVE), tolerant of free-text prefixes. */
function canonicalMode(value) {
  const v = String(value || '').trim().toUpperCase();
  if (v.startsWith('LIVE_PREVIEW')) return 'LIVE_PREVIEW';
  if (v.startsWith('LIVE')) return 'LIVE';
  if (v.startsWith('SAFE')) return 'SAFE';
  return v || null;
}

/** A package's gate verdict counts as passing when it begins with one of the PASS vocabulary. */
function isPassVerdict(value) {
  const v = String(value || '').trim().toUpperCase();
  return v.startsWith('PASS');
}

/** A readiness field signals "not ready" when it names a blocked/failed/rejected/revision state. */
function fieldIndicatesNotReady(value) {
  const v = String(value || '').trim().toLowerCase();
  if (!v || v.includes('no_revision_requested')) return false;
  return /(revision_requested|blocked|fail|rejected)/u.test(v);
}

/**
 * Does a public-copy body leak an upstream enrichment packet (the matcher/enricher's internal
 * thesis/proof/angle scaffold)? Brand-neutral structural markers only (spec §0.3 r6).
 */
function containsEnrichmentPacketLeak(text) {
  return /(?:^|\n)\s*(?:thesis|one-sentence thesis|approved proof snippets|source anchors|reader promise|strategic angle|opening options|conclusion)\s*[:=]/iu.test(text || '');
}

/** Extract media-asset references from a free-text value (paths + bare media filenames). */
function candidateAssetRefs(value) {
  const text = String(value || '');
  const found = new Set();
  const add = (candidate) => {
    const normalized = usageLog.normalizeAssetId(candidate);
    if (!normalized || normalized === 'null') return;
    if (/^https?:/iu.test(normalized)) return;
    if (MEDIA_EXT_RE.test(normalized)) found.add(normalized);
  };
  add(text);
  const pathPattern = /(?:[A-Za-z]:[\\/][^\s`"'<>|]+|(?:library\/)?(?:media|images|videos|events|training|image-gen|video-gen)\/[^\s`"'<>|]+)/giu;
  for (const match of text.replace(/\\/gu, '/').matchAll(pathPattern)) {
    add(match[0].replace(/[),.;:]+$/u, ''));
  }
  return [...found];
}

/** The selected media refs to cooldown-check, from the typed media[] or the markdown fields. */
function selectedMediaRefs(view) {
  const values = view.isObject
    ? view.mediaRefs
    : view.fieldValues([
        'media_path', 'Media', 'Media Path', 'source_media', 'library_source', 'output_asset',
        'Source Media', 'Library Source', 'Output Asset', 'asset_path', 'base_asset_path',
      ]);
  return [...new Set(values.flatMap(candidateAssetRefs))];
}

/** Is a media ref an image (visual-check applies to stills; video uses other gates)? */
function isImageRef(value) {
  return IMAGE_EXT_RE.test(String(value || ''));
}

/** Read the cooldown hard-floor day count from config (system + per-brand), with a 14 fallback. */
function cooldownDays(config, brand) {
  const sys = config && config.cooldown ? config.cooldown : {};
  const brands = config && config.brands ? config.brands : {};
  const override = brand && brands[brand] && brands[brand].cooldown_overrides
    ? brands[brand].cooldown_overrides
    : {};
  const days = override.hard_days ?? sys.hard_days ?? DEFAULT_COOLDOWN_DAYS;
  const n = Number(days);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_COOLDOWN_DAYS;
}

/**
 * Cooldown status for one media ref, shaped for both the detected_codes explanation AND the
 * workflow-ledger.packageValidation() detail consumer (which reads asset_path /
 * asset_family_key / cooldown_blocked / days_since_last_use / last_use).
 */
function mediaCooldownStatus(assetRef, { days, excludeContentId, env }) {
  const cs = usageLog.cooldownStatus(assetRef, {
    hardDays: days,
    excludeContentId,
    env,
  });
  return {
    asset_path: cs.asset_id,
    asset_family_key: cs.asset_family_key,
    cooldown_days: cs.cooldown_days,
    cooldown_blocked: cs.cooldown_blocked,
    days_since_last_use: cs.days_since_last_use,
    last_use: cs.last_use,
  };
}

/**
 * Validate a platform-final package (release-spec §14.1 layer 3). Returns a validation-result
 * (spec §7.2). The `detected_codes` union carries PKG.* codes (source 'package') and PLAT.*
 * codes (source 'platform'); any hard code ⇒ FAIL (blocked from the approval queue, §2.3).
 *
 * @param {object|string} pkg  a package object (schemas/artifacts/package.schema.json) or a raw
 *   markdown package body (CLI back-compat).
 * @param {object} [options]
 * @param {string} [options.platform]   platform id (defaults to the package's audit_header.platform).
 * @param {string} [options.contentId]  content id (defaults to audit_header.content_id).
 * @param {object} [options.config]     decoded config/system.json (cooldown days, brand overrides).
 * @param {boolean} [options.recordLedger]  write the validation event to the workflow ledger
 *   (default true; the gate pipeline wants the audit trail). Tests pass false.
 * @param {object} [options.env]        environment for paths resolution (default process.env).
 * @returns {object} validation-result (spec §7.2).
 */
function validate(pkg, options = {}) {
  const env = options.env || process.env;
  const config = options.config || {};
  const view = isString(pkg) ? rawView(pkg) : objectView(pkg || {});
  const header = view.isObject ? view.header : {};

  const contentId = options.contentId
    || header.content_id
    || view.flatFieldValue('content_id')
    || view.flatFieldValue('Content ID')
    || null;
  const platform = options.platform
    || header.platform
    || view.flatFieldValue('platform')
    || view.flatFieldValue('Platform')
    || null;

  const detected = [];
  const details = {};

  // 1. Audit header (## Audit Header section OR a flat block of the five identity fields).
  const hasAuditHeader = view.hasSection('Audit Header')
    || (view.hasField('content_id') && view.hasField('platform') && view.hasField('format')
        && (view.hasField('brand') || view.hasField('account')) && view.hasField('mode'));
  details.has_audit_header = hasAuditHeader;
  if (!hasAuditHeader) detected.push(makeCode(CODES.AUDIT_HEADER_MISSING, 'audit header / identity block missing'));

  const packageMode = canonicalMode(view.flatFieldValue('mode') || view.flatFieldValue('Mode'));
  const brand = header.brand || view.flatFieldValue('brand') || view.flatFieldValue('account') || null;
  const packageStatus = view.flatFieldValue('package_status') || view.flatFieldValue('Package Status') || '';
  const publishState = view.flatFieldValue('publish_state') || view.flatFieldValue('Publish State') || '';
  const readyForPreview = view.flatFieldValue('ready_for_preview') || view.flatFieldValue('Ready for Preview') || '';
  const readyForPublish = view.flatFieldValue('ready_for_publish') || view.flatFieldValue('Ready for Publish') || '';
  const gateVerdict = view.flatFieldValue('gate_verdict') || view.flatFieldValue('Gate Verdict')
    || view.flatFieldValue('quality_gate_verdict') || view.flatFieldValue('Quality Gate Verdict') || null;
  details.mode = packageMode || null;
  details.package_status = packageStatus || null;
  details.publish_state = publishState || null;
  details.ready_for_preview = readyForPreview || null;
  details.ready_for_publish = readyForPublish || null;
  details.gate_verdict = gateVerdict || null;

  if (packageMode === 'LIVE') {
    if (!gateVerdict) detected.push(makeCode(CODES.GATE_VERDICT_MISSING_FOR_LIVE, 'LIVE package has no explicit gate verdict'));
    else if (!isPassVerdict(gateVerdict)) {
      detected.push(makeCode(CODES.GATE_VERDICT_NOT_PASSING_FOR_LIVE, `LIVE package gate verdict not passing (${gateVerdict})`));
    }
  }
  if (fieldIndicatesNotReady(packageStatus)) detected.push(makeCode(CODES.PACKAGE_STATUS_NOT_READY, `package_status not ready (${packageStatus})`));
  if (fieldIndicatesNotReady(publishState)) detected.push(makeCode(CODES.PUBLISH_STATE_NOT_READY, `publish_state not ready (${publishState})`));
  if (fieldIndicatesNotReady(readyForPreview)) detected.push(makeCode(CODES.READY_FOR_PREVIEW_NOT_READY, `ready_for_preview not ready (${readyForPreview})`));
  if (fieldIndicatesNotReady(readyForPublish)) detected.push(makeCode(CODES.READY_FOR_PUBLISH_NOT_READY, `ready_for_publish not ready (${readyForPublish})`));

  // 2. Recommended + Variant A + Variant B (DD-11).
  const hasRecommended = view.hasSection('Recommended') || /\*\*Recommended[:\s]/i.test(view.raw);
  const hasVariantA = view.hasSection('Variant A') || /\*\*Variant A[:\s]/i.test(view.raw);
  const hasVariantB = view.hasSection('Variant B') || /\*\*Variant B[:\s]/i.test(view.raw);
  details.has_recommended = hasRecommended;
  details.has_variant_a = hasVariantA;
  details.has_variant_b = hasVariantB;
  if (!hasRecommended) detected.push(makeCode(CODES.RECOMMENDED_MISSING, 'Recommended variant missing'));
  if (!hasVariantA) detected.push(makeCode(CODES.VARIANT_A_MISSING, 'Variant A missing'));
  if (!hasVariantB) detected.push(makeCode(CODES.VARIANT_B_MISSING, 'Variant B missing'));

  const publicCopy = [view.sectionBody('Recommended'), view.sectionBody('Variant A'), view.sectionBody('Variant B')].join('\n');
  details.enrichment_packet_leak_detected = containsEnrichmentPacketLeak(publicCopy);
  if (details.enrichment_packet_leak_detected) {
    detected.push(makeCode(CODES.ENRICHMENT_PACKET_LEAK, 'upstream enrichment packet leaked into public copy'));
  }

  // 3. Scores block (per-variant scores on the object path, or a Scores section/line on markdown).
  const hasScores = view.hasSection('Scores')
    || /(brand|voice).{0,20}\d{2,3}.{0,40}stepps.{0,20}\d{1,3}/i.test(view.raw)
    || /\*\*Scores[:\s]/i.test(view.raw);
  details.has_scores = hasScores;
  if (!hasScores) detected.push(makeCode(CODES.SCORES_MISSING, 'scores block missing'));

  // 4. Source stack — required when the copy cites a source (brand-neutral: any source-stack
  //    reference or per-item citation marker present in the body implies a stack must exist).
  const hasSourceStack = view.hasSection('Source Stack');
  details.has_source_stack = hasSourceStack;
  const citesASource = /source.stack|source.anchors?|item_id\s*[:=]|cite[ds]?\b|citation/i.test(view.raw);
  if (citesASource && !hasSourceStack) {
    detected.push(makeCode(CODES.SOURCE_STACK_MISSING, 'copy cites a source but no Source Stack is present'));
  }

  // 5. Visual fields for visual/video formats: visual state, bound media, cooldown, visual check.
  const formatLowered = view.raw.toLowerCase();
  const isVisualFormat = /(image|video|reel|short|carousel|gif|gallery|tweet \+ image|tweet \+ video)/i.test(formatLowered)
    && !(/text-only|single tweet$|tweet text$/.test(formatLowered) && !/\+ image|\+ video/.test(formatLowered));
  details.is_visual_format_inferred = isVisualFormat;

  if (isVisualFormat) {
    const hasVisualState = view.hasField('visual_state') || view.hasField('Visual state') || view.hasField('Visual Decision');
    const hasMedia = view.isObject
      ? view.mediaRefs.length > 0
      : (view.hasField('media_path') || view.hasField('Media Path') || view.hasField('Output Asset')
         || view.hasField('asset_path') || view.hasField('Library Source') || /\*\*Media[:\s]/i.test(view.raw));
    details.has_visual_state = hasVisualState;
    details.has_media = hasMedia;
    if (!hasVisualState) detected.push(makeCode(CODES.VISUAL_STATE_MISSING, 'visual format has no visual_state'));
    if (!hasMedia) detected.push(makeCode(CODES.MEDIA_MISSING, 'visual format has no bound media'));

    // Cooldown enforcement point 2 (DD-14): read the canonical usage-log ledger.
    const days = cooldownDays(config, brand);
    const refs = selectedMediaRefs(view);
    const cooldownStatuses = refs.map((ref) => mediaCooldownStatus(ref, { days, excludeContentId: contentId, env }));
    details.media_cooldown = cooldownStatuses;
    for (const status of cooldownStatuses) {
      if (status.cooldown_blocked) {
        const last = status.last_use;
        detected.push(makeCode(
          CODES.MEDIA_COOLDOWN_BLOCKED,
          `media in cooldown (${status.asset_path}; family=${status.asset_family_key || 'none'}; `
            + `last_use=${last ? last.content_id : 'unknown'}; days=${status.days_since_last_use ?? 'unknown'}; `
            + `reason=${last ? last.match_reason : 'unknown'})`,
        ));
      }
    }

    // Image stills additionally require a passing visual check (config-supplied result; the
    // visual-check engine is P2-VISUAL — here we honor a result the caller attaches via options).
    const imageRefs = refs.filter(isImageRef);
    if (imageRefs.length > 0 && options.visualCheck) {
      const vc = options.visualCheck;
      details.visual_check = { exists: Boolean(vc.exists), pass: Boolean(vc.pass), rejection_code: vc.rejection_code || null };
      if (!vc.exists) detected.push(makeCode(CODES.VISUAL_CHECK_MISSING, 'visual check result missing for an image package'));
      else if (!vc.pass) detected.push(makeCode(CODES.VISUAL_CHECK_NOT_PASSING, `visual check not passing (${vc.rejection_code || 'verdict_not_pass'})`));
    }
  }

  // 6. Per-platform gates (PLAT.* — push onto the same union with source 'platform').
  platformGates.runPlatformGates({
    platform,
    raw: view.raw,
    sectionBody: (name) => view.sectionBody(name),
    hasField: (key) => view.hasField(key),
    detected,
    details,
  });

  const hasHard = detected.some((d) => d.tier === 'hard');
  const verdict = hasHard ? 'FAIL' : 'PASS';

  const result = {
    content_id: contentId,
    stage: STAGE,
    verdict,
    detected_codes: detected,
    rationale: verdict === 'FAIL'
      ? 'Deterministic pre-publish gate found a hard violation; blocked from the approval queue.'
      : 'Deterministic pre-publish gate clean; package may render an approval card.',
    'x-pre-publish': {
      platform: platform || 'auto',
      mode: packageMode || null,
      details,
    },
  };

  // Best-effort audit trail (redacted at write time inside the ledger). The ledger consumer
  // reads the production-shaped {content_id, pass, platform, package_path, failures[], details}.
  if (options.recordLedger !== false) {
    const lg = ledger();
    if (lg && typeof lg.packageValidation === 'function') {
      try {
        lg.packageValidation({
          content_id: contentId,
          platform: platform || 'auto',
          package_path: options.packagePath || null,
          pass: verdict !== 'FAIL',
          failures: detected.map((d) => d.code),
          details,
        }, env);
      } catch {
        // Ledger is observability, never a gate dependency — a write failure never changes the verdict.
      }
    }
  }

  return result;
}

module.exports = {
  validate,
  CODES,
  STAGE,
  // Helpers exposed for tests / the cooldown round-trip.
  mediaCooldownStatus,
  cooldownDays,
  selectedMediaRefs,
  candidateAssetRefs,
  canonicalMode,
  isPassVerdict,
  fieldIndicatesNotReady,
  containsEnrichmentPacketLeak,
  // Re-export the platform-gate registry so callers have one import for the layer-3 codes.
  PLATFORM_GATES: platformGates.PLATFORM_GATES,
  PLAT_CODES: platformGates.CODES,
};

// --- CLI ------------------------------------------------------------------------------------
// Only runs when invoked directly. The gate pipeline imports validate() and never shells out.

if (require.main === module) {
  // eslint-disable-next-line global-require
  const fs = require('fs');
  const arg = (n) => {
    const i = process.argv.indexOf(`--${n}`);
    return i >= 0 ? process.argv[i + 1] : null;
  };
  const asJson = process.argv.includes('--json');
  const pkgPath = arg('package');
  if (!pkgPath || !fs.existsSync(pkgPath)) {
    process.stderr.write('--package <package.(json|md)> required\n');
    process.exit(2);
  }
  const body = fs.readFileSync(pkgPath, 'utf8');
  let pkg;
  if (/\.json$/i.test(pkgPath)) {
    try {
      pkg = JSON.parse(body);
    } catch (e) {
      process.stderr.write(`--package is not valid JSON: ${e.message}\n`);
      process.exit(2);
    }
  } else {
    pkg = body; // markdown body
  }

  const result = validate(pkg, {
    platform: arg('platform') || undefined,
    contentId: arg('content-id') || undefined,
    packagePath: pkgPath,
  });
  const pass = result.verdict !== 'FAIL';
  if (asJson) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`validate-package: ${pass ? 'PASS' : 'FAIL'}\n`);
    for (const d of result.detected_codes) {
      process.stdout.write(`  - ${d.tier}: ${d.code} ${d.explanation}\n`);
    }
  }
  process.exit(pass ? 0 : 1);
}
