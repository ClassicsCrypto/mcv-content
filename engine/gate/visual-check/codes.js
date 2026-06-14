'use strict';

/**
 * engine/gate/visual-check/codes.js  [A adapted]
 *
 * The VIS.* emit-side code table for the visual gate (release-spec §10.2 VIS.* family;
 * §14.1 visual layer). The registry file (rules/codes.md) is the source of truth; this
 * table is the engine's emit-side view, kept consistent with it — the same pattern
 * engine/gate/pre-gate-lint.js uses for LINT.*.
 *
 * Production ancestor: the IMG_* image-workflow taxonomy and the visual-check VISUAL-*
 * rejection codes, unified into the VIS.* namespace (spec §10.2 table row; the production
 * raw tokens carried brand-private banned names — regenerated clean here, never copied).
 *
 * Tiering / disposition (spec §14.4, RD-21):
 *   - VIS.OFF_BRAND / VIS.IDENTITY_MISSING / VIS.EMBEDDED_TEXT are HARD when the pack marks
 *     a visual-fidelity failure; they block the affected variant and FAIL the visual stage,
 *     routing back to the media seat (the production VISUAL-* route-back contract).
 *   - VIS.SKIPPED_NO_PROVIDER is SOFT and bars the Recommended slot for visual formats
 *     (degrade-to-skip when no vision provider is configured — §3.1 "degrades to skip-with-
 *     warning", §15.2 "visual gate emits a skip-with-warning code (soft, bars recommended
 *     for visual formats)").
 *   - VIS.CHECK_ERROR is HARD-equivalent NOT-pass: the provider invocation failed, so the
 *     engine cannot honestly assert the image is on-brand. Consumers treat vision_pass:null
 *     as NOT-pass and never auto-pass (the production always-write tool-error contract).
 */

const FAMILY = 'VIS';
const SOURCE = 'visual';

const CODES = {
  // The image does not satisfy the brand-fidelity question pack.
  OFF_BRAND: {
    code: 'VIS.OFF_BRAND',
    tier: 'hard',
    disposition: 'block',
    route: 'media',
    rule_ref: 'rule.visual.brand-fidelity',
  },
  // A required brand identity element is absent and the pack marks it required.
  IDENTITY_MISSING: {
    code: 'VIS.IDENTITY_MISSING',
    tier: 'hard',
    disposition: 'block',
    route: 'media',
    rule_ref: 'rule.visual.identity',
  },
  // Readable unsolicited text / dates / logos baked into the frame (the production
  // embedded-text-artifact class).
  EMBEDDED_TEXT: {
    code: 'VIS.EMBEDDED_TEXT',
    tier: 'hard',
    disposition: 'block',
    route: 'media',
    rule_ref: 'rule.visual.embedded-text',
  },
  // Degrade-to-skip: no vision provider configured (§12.5). SOFT; bars Recommended for
  // visual formats. Never a crash, never an auto-pass.
  SKIPPED_NO_PROVIDER: {
    code: 'VIS.SKIPPED_NO_PROVIDER',
    tier: 'soft',
    disposition: 'warn',
    route: 'media',
    rule_ref: 'rule.visual.brand-fidelity',
    bars_recommended: true,
  },
  // The provider invocation itself failed (timeout, unreadable image, bad config). The
  // verdict is still written (always-write contract) with vision_pass:null.
  CHECK_ERROR: {
    code: 'VIS.CHECK_ERROR',
    tier: 'hard',
    disposition: 'block',
    route: 'media',
    rule_ref: 'rule.visual.brand-fidelity',
  },
};

/** Build a §7.2 detected_codes entry from a CODES table row. */
function makeCode(meta, explanation, variantLabel) {
  const entry = {
    code: meta.code,
    family: FAMILY,
    tier: meta.tier,
    source: SOURCE,
    disposition: meta.disposition,
    rule_ref: meta.rule_ref,
    explanation,
  };
  if (meta.bars_recommended) entry.bars_recommended = true;
  if (variantLabel) entry.variant_label = variantLabel;
  return entry;
}

module.exports = { FAMILY, SOURCE, CODES, makeCode };
