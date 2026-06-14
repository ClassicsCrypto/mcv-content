'use strict';

/**
 * pipelines/video-heavy.js  [N net-new — chain definition]
 *
 * The VIDEO-HEAVY lifecycle (release-spec §8.1 "Video-heavy (Giphy/IG/Shorts/Reels-class)").
 * It is the executable chain DEFINITION for the lane where the ASSET is the main artifact and
 * the written caption is secondary — so the media decision PRECEDES drafting (§8.1: "identical
 * except the media decision precedes drafting").
 *
 * Stage order (§8.1 video-heavy):
 *   orchestrator → matcher (slot→archetype/theme + pre-seed) → media-FIRST sourcing
 *     (retrieval → reuse/modify/generate per rules, §8.6 enforcement point 1)
 *     → visual-check (when an image still; deterministic visual layer)
 *     → writer (MINIMAL caption — 3 labeled variants still, DD-11)
 *     → SAME universal gate (deterministic pre-gate → LLM voice+quality, union of codes)
 *     → packager (platform-final) → validate-package + platform-gates + cooldown (layer 3)
 *     → package → queue (awaiting_approval).
 *
 * GATE UNIVERSALITY (§8.1 invariant; model §4 run invariant): the video lane MUST pass the
 * SAME QA gate as text-heavy — verified real in production (gap §2.1 hybrid-gate row). This
 * module imports `runGate` from text-heavy.js so there is literally ONE gate composition; only
 * the ENTRY ORDER differs (media before caption here, draft before media there). Both lanes
 * converge on the same `validating → packaged → awaiting_approval` states and the same
 * `shared.enqueueAwaitingApproval` queue writer (§8.2 convergence; state-worksheet.md).
 *
 * The pipeline does NOT post the approval card or run the publish executor — the
 * publisher-liaison surface and the executor own those edges. It stops at `awaiting_approval`
 * (the reviewer's first, mandatory gate). The Giphy lane is a platform-direct publisher
 * (engine/publishers/giphy.js) the executor invokes later; this pipeline only produces the
 * package + queue entry that the executor will hand off.
 *
 * Tier-3 cleanliness (§0.3 r6 / RD-3): no IDs/handles/absolute paths/brand strings; no
 * production persona codenames. Engine seams are the shipped modules.
 */

const validatePackage = require('../engine/gate/validate-package.js');
const visualCheckMod = require('../engine/gate/visual-check');
const library = require('../engine/library/check.js');
const card = require('../engine/shared/components-v2.js');

const shared = require('./shared.js');
const { runGate } = require('./text-heavy.js'); // ONE universal gate composition (§8.1 invariant)

const LIFECYCLE = 'video-heavy';

/**
 * Run the video-heavy lifecycle for one calendar slot, producing a queue entry in
 * `awaiting_approval`. Media is sourced FIRST; the caption is drafted around the chosen asset;
 * the SAME gate composition runs over the caption draft; convergence is identical to text-heavy.
 *
 * @param {object} slot  the slot-run input (same shape as runTextHeavy's slot — see text-heavy.js).
 *   Video-heavy slots typically carry a visual format (reel/short/gif/clip) and a media_source
 *   hint, but the shape is shared so the orchestrator dispatches both lanes identically (§8.4).
 * @param {object} [pipeline]  the wired pipeline (createPipeline). Default = stub pipeline.
 * @returns {Promise<object>} the run OUTCOME (shared.makeOutcome).
 */
async function runVideoHeavy(slot, pipeline = createPipeline()) {
  const ctx = shared.makeRunCtx(slot, pipeline, LIFECYCLE);
  const { content_id, env } = ctx;

  shared.ledgerEvent(content_id, 'run_started', { status: 'planned', run: { lifecycle: LIFECYCLE, slot_ref: slot.slot_ref || null } }, env);

  // --- matcher: slot → archetype/theme + pre-seed (§9.2) ------------------------------------
  const matcherInput = shared.matcherInput(ctx);
  const brief = await ctx.seats.matcher(matcherInput);
  shared.assertArtifact(brief, 'brief', ['content_id', 'pre_seed']);
  shared.ledgerEvent(content_id, 'matched', { status: 'seeded', run: { archetype: brief.archetype || null } }, env);

  // --- MEDIA-FIRST sourcing (the lane inversion, §8.1): retrieval → reuse/modify/generate ----
  // The asset is the main artifact, so the media decision runs before any caption. Retrieval
  // reads the canonical index + the ONE usage ledger (cooldown enforcement point 1, §8.6/DD-14).
  // The media seat owns the produced asset; for this lane a produced asset is REQUIRED before the
  // caption is written (a video-heavy item with no asset has nothing to caption).
  const media = await runMediaFirst(ctx, { brief });
  if (!media.attached) {
    shared.ledgerEvent(content_id, 'media_unavailable', { status: 'hard_failed' }, env);
    return shared.makeOutcome(ctx, {
      stage: 'media', state: 'hard_failed', ok: false,
      media_decision: media.decision,
      routed_back_to: 'media',
      reason: `video-heavy lane needs a produced asset before captioning; media decision was "${media.decision.action}" with no output (${media.decision.reason || 'no asset'})`,
    });
  }
  shared.ledgerEvent(content_id, 'media_attached', { status: 'media_attached', media: { action: media.decision.action } }, env);

  // --- visual-check (when the produced asset is an image still; deterministic visual layer) --
  // Stills get the vision-model question pack (§12.5 provider seam). Time-based assets
  // (mp4/webm/gif video) are not still-image-checked here; the visual gate applies to images.
  let visual = null;
  if (media.imagePath) {
    visual = visualCheckMod.visualCheck(
      {
        content_id,
        brand: ctx.brand,
        platform: ctx.platform,
        media_path: media.imagePath,
        visual_class: media.visual_class || null,
        identity_required: Boolean(media.identity_required),
        scene_hint: media.scene_hint || '',
      },
      { provider: ctx.visualProvider, env },
    );
  }

  // --- writer: MINIMAL caption (still exactly 3 labeled variants, DD-11) --------------------
  // The writer drafts a minimal caption AROUND the chosen asset — the brief carries the media
  // decision so the caption references what the asset actually shows (the media-first ordering).
  const draft = await ctx.seats.writer({
    brief,
    framework_ref: shared.frameworkRefFor(brief),
    media_decision: media.decision,
    caption_mode: 'minimal', // video-heavy captions are minimal (§8.1)
  });
  shared.assertArtifact(draft, 'draft', ['content_id', 'variants']);
  shared.ledgerEvent(content_id, 'drafted', { status: 'drafted' }, env);

  // --- gate (UNIVERSAL — the SAME composition as text-heavy, §8.1 invariant) ----------------
  // Identical entry point: deterministic pre-gate (HARD fail routes back to writer, no LLM spend)
  // → LLM voice+quality judge seam → union of codes. The video lane does NOT get a weaker gate.
  const gate = await runGate(ctx, { draft, brief });
  if (!gate.ok) {
    shared.ledgerEvent(content_id, 'gate_failed', { status: 'hard_failed' }, env);
    return shared.makeOutcome(ctx, { stage: 'gate', state: 'hard_failed', ok: false, gate, routed_back_to: gate.route || 'writer', reason: gate.reason });
  }
  shared.ledgerEvent(content_id, 'gate_passed', { status: 'validated_pass', gates: { llm: gate.llm || null } }, env);

  // --- packager: platform-final packaging (§9.1 packager) -----------------------------------
  const pkg = await ctx.seats.packager({
    brief,
    draft,
    gate,
    media_decision: media.decision,
    content_form: ctx.content_form,
    mode: ctx.mode,
  });
  shared.assertArtifact(pkg, 'package', ['audit_header']);
  shared.ledgerEvent(content_id, 'packaging', { status: 'validating' }, env);

  // --- deterministic package + platform gates + cooldown (layer 3, §14.1) -------------------
  // SAME validate-package call as text-heavy, INCLUDING the visual-check result for an image
  // still and cooldown enforcement point 2 (DD-14). For a video-heavy item the media/visual
  // fields are populated, so the visual-format branch of validate-package gates them.
  const validation = validatePackage.validate(pkg, {
    platform: ctx.platform,
    contentId: content_id,
    config: ctx.config,
    env,
    visualCheck: visual ? shared.visualForPackage(visual) : undefined,
  });
  if (validation.verdict === 'FAIL') {
    shared.ledgerEvent(content_id, 'package_validation_fail', { status: 'hard_failed' }, env);
    return shared.makeOutcome(ctx, {
      stage: 'package', state: 'hard_failed', ok: false,
      gate: shared.gateSummary(gate, validation, visual),
      routed_back_to: shared.firstRoute(validation) || 'packager',
      reason: 'deterministic package/platform gate failed',
    });
  }
  shared.ledgerEvent(content_id, 'packaged', { status: 'packaged' }, env);

  // --- queue: write the durable entry in awaiting_approval (§8.2 convergence) ----------------
  // The SAME queue writer as text-heavy — both lanes land here identically.
  const queueEntry = await shared.enqueueAwaitingApproval(ctx, { package: pkg, media, gate, validation, visual });
  shared.ledgerEvent(content_id, 'queued_awaiting_approval', { status: 'awaiting_approval' }, env);

  return shared.makeOutcome(ctx, {
    stage: 'queue', state: 'awaiting_approval', ok: true,
    queue_entry: queueEntry,
    media_decision: media.decision,
    gate: shared.gateSummary(gate, validation, visual),
    reason: 'item queued for reviewer approval (first mandatory gate)',
  });
}

// ---------------------------------------------------------------------------
// Media-first sourcing (the lane inversion) — §8.6 point 1
// ---------------------------------------------------------------------------

/**
 * Source the media FIRST (before any caption). The deterministic retrieval scorer produces the
 * candidate set + the brand-neutral default reuse/modify/generate decision (the ONE usage
 * ledger, cooldown point 1); the media seat owns the final action and produces/attaches the
 * asset. Unlike text-heavy's optional media, the video-heavy lane REQUIRES a produced asset (the
 * asset is the main artifact) — an unattached decision routes back to the media seat.
 *
 * Returns { decision, attached, imagePath?, media_refs, visual_class?, identity_required?, scene_hint? }.
 */
async function runMediaFirst(ctx, { brief }) {
  // No draft yet (media-first), so the retrieval query is built from the matcher's angle/theme.
  const query = shared.mediaQuery(ctx, brief, null);
  const { result, mediaDecision } = library.decideMedia(query, { content_id: ctx.content_id, brand: ctx.brand, platform: ctx.platform }, {
    config: ctx.retrievalConfig,
    env: ctx.env,
    excludeContentId: ctx.content_id,
  });

  let seatOut = null;
  if (ctx.seats.media) {
    seatOut = await ctx.seats.media({ retrieval: result, decision: mediaDecision, brief, lane: LIFECYCLE });
  }

  const finalDecision = (seatOut && seatOut.decision) || mediaDecision;
  const producedRef = (seatOut && (seatOut.output_ref || seatOut.media_ref)) || finalDecision.output_ref || finalDecision.chosen_asset_ref || null;
  const attached = Boolean(producedRef);

  return {
    decision: finalDecision,
    attached,
    imagePath: attached && shared.isImageRef(producedRef) ? producedRef : null,
    media_refs: attached ? [producedRef] : [],
    visual_class: seatOut && seatOut.visual_class,
    identity_required: seatOut && seatOut.identity_required,
    scene_hint: seatOut && seatOut.scene_hint,
  };
}

// ---------------------------------------------------------------------------
// Pipeline construction (shares the text-heavy seat seam)
// ---------------------------------------------------------------------------

/**
 * Build a video-heavy pipeline. Identical seam to text-heavy's createPipeline (same seat roles,
 * same engine deps) — the difference is purely the stage ORDER inside runVideoHeavy. A host may
 * share ONE pipeline object across both runners.
 *
 * @param {object} [opts]  see text-heavy.createPipeline — { seats, config, retrievalConfig,
 *   visualProvider, enricherEnabled, env }.
 * @returns {object} pipeline
 */
function createPipeline(opts = {}) {
  return {
    seats: shared.resolveSeats(opts.seats),
    config: opts.config || {},
    retrievalConfig: opts.retrievalConfig || {},
    visualProvider: opts.visualProvider || null,
    enricherEnabled: Boolean(opts.enricherEnabled),
    env: opts.env || process.env,
    card,
  };
}

module.exports = {
  LIFECYCLE,
  runVideoHeavy,
  runMediaFirst,
  createPipeline,
};
