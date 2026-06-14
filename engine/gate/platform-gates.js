'use strict';

/**
 * engine/gate/platform-gates.js  [A adapted]
 *
 * The per-platform deterministic gate registry — layer 3 of the hybrid gate, platform half
 * (release-spec §14.1 layer 3; §10.2 PLAT.* family; §12.6 platform descriptor). Each entry
 * owns one platform's structural checks (hashtag policy, required platform fields). The driver
 * iterates the registry in array order, so a package produces a deterministic, order-stable
 * `detected_codes[]` — the union-of-codes contract (§14.1) requires that every emitted code
 * carry forward unchanged.
 *
 * There are exactly FIVE platform gates (twitter, instagram, tiktok, youtube, facebook). The
 * giphy lane is routable but has NO gate block — that asymmetry is intentional (the platform-
 * direct giphy adapter, §12.3, owns its own constraints; do not add a giphy gate without a
 * separate behavior change). Matching is by platform-id substring/alias, brand-neutral; the
 * descriptor registry (§12.6) supplies the canonical id + aliases, but the registry stays
 * self-contained so it functions before any descriptor is configured.
 *
 * Codes are PLAT.*-namespaced (§10.2). Every code emitted here MUST exist in rules/codes.md;
 * the CODES table below is the engine's emit-side view of that registry.
 *
 * ctx contract (supplied by validate-package.js):
 *   { platform, raw, sectionBody(name), hasField(key), detected, details }
 * Gates push §7.2 detected_codes entries onto ctx.detected and may set ctx.details in place.
 */

const FAMILY = 'PLAT';
const SOURCE = 'platform';

// PLAT.* code metadata (code / tier / disposition / route / rule_ref) — the registry contract
// this engine emits against (spec §7.3/§10.2). rules/codes.md is the source of truth; this is
// the engine's emit-side mirror, kept consistent with it.
const CODES = {
  TWITTER_HASHTAG_PRESENT: {
    code: 'PLAT.TWITTER_HASHTAG_PRESENT', tier: 'hard', disposition: 'block', route: 'packager', rule_ref: 'rule.platform.twitter',
  },
  INSTAGRAM_HASHTAG_OVER_LIMIT: {
    code: 'PLAT.INSTAGRAM_HASHTAG_OVER_LIMIT', tier: 'hard', disposition: 'block', route: 'packager', rule_ref: 'rule.platform.instagram',
  },
  TIKTOK_HOOK_3S_MISSING: {
    code: 'PLAT.TIKTOK_HOOK_3S_MISSING', tier: 'hard', disposition: 'block', route: 'packager', rule_ref: 'rule.platform.tiktok',
  },
  TIKTOK_COVER_FRAME_MISSING: {
    code: 'PLAT.TIKTOK_COVER_FRAME_MISSING', tier: 'hard', disposition: 'block', route: 'packager', rule_ref: 'rule.platform.tiktok',
  },
  YOUTUBE_SOURCE_SENSE_MISSING: {
    code: 'PLAT.YOUTUBE_SOURCE_SENSE_MISSING', tier: 'hard', disposition: 'block', route: 'packager', rule_ref: 'rule.platform.youtube',
  },
  FACEBOOK_COMMUNITY_BRIDGE_MISSING: {
    code: 'PLAT.FACEBOOK_COMMUNITY_BRIDGE_MISSING', tier: 'hard', disposition: 'block', route: 'packager', rule_ref: 'rule.platform.facebook',
  },
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

const PLATFORM_GATES = [
  {
    id: 'twitter',
    match: (lc) => lc.includes('twitter') || lc === 'x',
    run: (ctx) => {
      // Hashtag policy: zero hashtags in any variant body. Scan Recommended/Variant blocks.
      const variantBodies = [
        ctx.sectionBody('Recommended'),
        ctx.sectionBody('Variant A'),
        ctx.sectionBody('Variant B'),
      ].join('\n');
      if (variantBodies && /(?:^|\s)#\w/m.test(variantBodies)) {
        ctx.detected.push(makeCode(CODES.TWITTER_HASHTAG_PRESENT, 'a variant body contains a hashtag (zero allowed)'));
      }
    },
  },
  {
    id: 'instagram',
    match: (lc) => lc.includes('instagram') || lc === 'ig',
    run: (ctx) => {
      const variantBodies = [ctx.sectionBody('Recommended'), ctx.sectionBody('Variant A'), ctx.sectionBody('Variant B')].join('\n');
      const hashtagCount = (variantBodies.match(/#\w+/g) || []).length;
      ctx.details.instagram_hashtag_count = hashtagCount;
      if (hashtagCount > 30) {
        ctx.detected.push(makeCode(CODES.INSTAGRAM_HASHTAG_OVER_LIMIT, `${hashtagCount} hashtags across variant bodies (max 30)`));
      }
    },
  },
  {
    id: 'tiktok',
    match: (lc) => lc.includes('tiktok'),
    run: (ctx) => {
      if (!ctx.hasField('first_3s_hook_pass') && !ctx.hasField('hook_3s')) {
        ctx.detected.push(makeCode(CODES.TIKTOK_HOOK_3S_MISSING, 'no first-3s hook field (first_3s_hook_pass / hook_3s)'));
      }
      if (!ctx.hasField('cover_frame_timestamp') && !ctx.hasField('cover_frame')) {
        ctx.detected.push(makeCode(CODES.TIKTOK_COVER_FRAME_MISSING, 'no cover-frame field (cover_frame_timestamp / cover_frame)'));
      }
    },
  },
  {
    id: 'youtube',
    match: (lc) => lc.includes('youtube') || lc === 'yt',
    run: (ctx) => {
      if (!ctx.hasField('source_sense_check') && !/source.sense.check/i.test(ctx.raw)) {
        ctx.detected.push(makeCode(CODES.YOUTUBE_SOURCE_SENSE_MISSING, 'no source-sense-check field or mention'));
      }
    },
  },
  {
    id: 'facebook',
    match: (lc) => lc.includes('facebook') || lc === 'fb',
    run: (ctx) => {
      if (!ctx.hasField('community_bridge')) {
        ctx.detected.push(makeCode(CODES.FACEBOOK_COMMUNITY_BRIDGE_MISSING, 'no community_bridge field'));
      }
    },
  },
];

/**
 * Run all matching platform gates in registry order, mutating ctx.detected / ctx.details in
 * place. Iterating the array in order reproduces a stable, order-deterministic detected_codes[]
 * (union-of-codes contract, §14.1). Giphy/unknown/empty platforms match no gate.
 * @param {object} ctx  { platform, raw, sectionBody, hasField, detected, details }
 */
function runPlatformGates(ctx) {
  const platformLc = String(ctx.platform || '').toLowerCase();
  for (const gate of PLATFORM_GATES) {
    if (gate.match(platformLc)) gate.run(ctx);
  }
}

module.exports = { PLATFORM_GATES, runPlatformGates, CODES, makeCode, FAMILY, SOURCE };
