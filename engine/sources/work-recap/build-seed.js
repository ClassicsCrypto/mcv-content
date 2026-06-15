'use strict';

/**
 * engine/sources/work-recap/build-seed.js  [N net-new]
 *
 * Builds the WORK-RECAP SEED for the build-in-public pathway (release-spec §2.1 seeding;
 * §3.3 operator/founder/team accounts with flexible voice; §2.4 the double gate; §8.8 the source
 * produces a SEED that enters the EXISTING chain, never bypasses it; original-design-spec §1.4).
 *
 * THE SEED is a SANITIZED summary of recent shareable work + the build-in-public ANGLE. It is a
 * PRE-SEED (an idea/argument, §2.1) — the unit the matcher consumes to produce a brief, NOT
 * drafted final copy. Exactly like the trend pathway hands the matcher angles (never drafted
 * text), the work-recap source hands the matcher a build-in-public angle plus the work items.
 * Downstream: seed -> matcher -> brief -> writer -> hybrid gate (incl. the privacy/leak check on
 * privacy_flags) -> package -> queue -> the HUMAN approval card. NOTHING auto-publishes.
 *
 * PRIVACY (load-bearing): every seed is built ONLY from privacy-pre-passed work items
 * (privacy-filter.js, which reuses shared/redact.js + the operator deny list). The seed carries a
 * top-level `privacy_flags` record so the gate can HARD-BLOCK on residual leakage before the card.
 * The seed text exposed to the chain contains ONLY sanitized summaries; raw memory is never
 * carried. The repo ships the MECHANISM pointed at a configured path; it never bundles real memory.
 *
 * TESTABILITY: scanMemory's fs is injectable (opts.fs); buildWorkRecapSeed threads it through, so
 * the whole source runs zero-key with an in-memory fake (RD-12). With the feature disabled / no
 * path / no items it returns a clean disabled/empty seed — never throws.
 *
 * Tier-3 cleanliness (§0.3 r6): no IDs/handles/absolute paths/brand strings/codenames.
 */

const { scanMemory } = require('./scan-memory.js');
const { sanitizeItems } = require('./privacy-filter.js');

/** Source identifier carried on the seed so the matcher/observability can attribute it. */
const SEED_SOURCE = 'work-recap';

/** The seed's slot_type maps to the build-in-public lane (an operator/founder-account form). */
const SEED_SLOT_TYPE = 'work_recap';

/**
 * Compose the build-in-public ANGLE line from the sanitized work items. This is direction for the
 * matcher/writer — an angle, NOT drafted copy (§2.1 / §8.8 angles-only principle). Brand-neutral.
 */
function buildAngle(items, cfg) {
  const who = cfg.account || cfg.brand || 'the team';
  if (!items.length) {
    return `Recent build-in-public update: ${who} has shipped work worth sharing. ` +
      `Frame it as proof-of-progress, not hype.`;
  }
  const n = items.length;
  return (
    `Build-in-public recap: ${who} shipped ${n} ${n === 1 ? 'thing' : 'things'} recently. ` +
    `Angle the post as authentic proof-of-progress (what was built and why it matters), ` +
    `in the operator/founder voice (§3.3 flexible voice). Proof, not promise; no hype, no metrics ` +
    `that are not in the work items.`
  );
}

/**
 * Build the work-recap SEED.
 *
 * @param {object} [opts]
 * @param {object} [opts.config]      parsed system config carrying the `work_recap` block.
 * @param {object} [opts.work_recap]  explicit work_recap settings (overrides config.work_recap).
 * @param {object} [opts.fs]          injectable fs facade (default node:fs) — RD-12 zero-key.
 * @param {Date}   [opts.now]         reference now for lookback (default new Date()).
 * @returns {object} the work-recap seed (see shape below). Disabled/empty cases return a seed with
 *                   enabled/scanned flags and an empty work_items list; the seed is ALWAYS safe to
 *                   hand the matcher — an empty seed simply produces no brief.
 */
function buildWorkRecapSeed(opts = {}) {
  const scan = scanMemory(opts);

  const privateTerms = scan.private_terms || [];
  const { items: sanitizedItems, privacy_flags } = sanitizeItems(scan.items, { privateTerms });

  const cfg = { account: scan.account, brand: scan.brand };

  const seed = {
    // Identity / attribution (§2.1 pre-seed; the matcher consumes this).
    source: SEED_SOURCE,
    slot_type: SEED_SLOT_TYPE,
    trust_zone: 'O', // operator-provided trusted input (§8 Zone O): the operator's own memory,
    //                  post-sanitization. Distinct from trend reports (Zone U). Still gated.
    enabled: scan.enabled,
    scanned: scan.scanned,
    reason: scan.reason,

    // Scoping (§3.3): the operator/founder/team account this recap targets.
    brand: scan.brand,
    account: scan.account,

    // The build-in-public angle (direction, not drafted copy — §2.1 / §8.8).
    angle: buildAngle(sanitizedItems, cfg),

    // The sanitized shareable work — summaries only; raw memory never travels.
    work_items: sanitizedItems.map((it) => ({
      summary: it.summary,
      date: it.date,
      source_rel: it.source_rel,
      redacted: it.redacted,
      privacy_flags: it.privacy_flags,
    })),

    // The aggregate privacy record the DOWNSTREAM GATE hard-blocks on (residual leakage).
    // any_redacted=true means the pre-pass masked sensitive spans; the gate + human card are the
    // backstops that must confirm nothing sensitive survived into the draft (§2.4).
    privacy_flags,

    // Provenance for observability / the approval card ("how it was created", §2.4 / §7.5).
    provenance: {
      method: 'memory-scan',
      memory_path_configured: scan.memory_path != null,
      files_scanned: scan.files_scanned || [],
      lookback_days: scan.lookback_days,
      private_terms_count: privateTerms.length,
      generated_at: (opts.now instanceof Date ? opts.now : new Date()).toISOString(),
    },
  };

  return seed;
}

module.exports = {
  SEED_SOURCE,
  SEED_SLOT_TYPE,
  buildAngle,
  buildWorkRecapSeed,
};
