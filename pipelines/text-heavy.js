'use strict';

/**
 * pipelines/text-heavy.js  [N net-new — chain definition]
 *
 * The TEXT-HEAVY lifecycle (release-spec §8.1 "Text-heavy (Twitter/X-class — flagship,
 * RD-7)"). It is the executable chain DEFINITION: it sequences the SEAT ROLES (§9.1/§9.2,
 * by role+artifact contract) and threads each handoff artifact through the deterministic
 * engine modules already on disk (the gate, retrieval/usage-log, queue, components-v2 card).
 *
 * This module is NOT a host runtime and it does NOT call chain-seat LLMs (RD-2; §4.3 — the
 * engine never calls a seat). The LLM seats (matcher, optional enricher, writer, gate
 * voice/quality judge, media decision narration, packager) are the host runtime's job; this
 * pipeline names each seat's INPUT artifact and OUTPUT artifact contract, runs the
 * DETERMINISTIC work between seats (the pre-gate lint, retrieval scoring, package validation,
 * the visual seam, the queue write), and exposes a `seat` SEAM the host wires its sessions to
 * (pipeline.seats.<role>(input) -> Promise<artifact>). The default seat impl is a no-op stub
 * that throws "unwired seat" — a real host injects its own.
 *
 * Stage order (§8.1 text-heavy):
 *   orchestrator → matcher (slot→archetype/theme + deterministic idea/argument pre-seed)
 *     → [enricher, optional — RD-13] → writer (framework by length, 3 variants — DD-11)
 *     → pre-gate-lint (deterministic, layer 1) → LLM gate seam (voice+quality, union of codes)
 *     → media-match (retrieval) → media-decision (reuse/modify/generate per rules)
 *     → visual-check (when media; deterministic seam, layer "visual")
 *     → packager (platform-final) → validate-package + platform-gates + cooldown (layer 3)
 *     → package → queue (awaiting_approval).
 *
 * The GATE IS UNIVERSAL (§8.1 invariant; model §4): both lifecycles enter the SAME gate
 * composition (runGate below). text-heavy gates the draft BEFORE media (the argument is the
 * main artifact); video-heavy.js sources media first then gates the caption — but both call
 * runGate(), so the gate contract never forks.
 *
 * Trend variant (§8.8 v1 honest scope): a `trend` slot_type fills a RESERVED calendar slot
 * from a MANUALLY SUBMITTED trend report (schemas/inputs/trend-report.schema.json), and
 * quote-retweet is a first-class `content_form` on the queue entry / package (DD-16). The
 * trend variant is text-heavy with the trend report carried as pre-seed provenance (always
 * Zone U), the content_form propagated onto the package + queue entry, and a freshness-window
 * expiry basis set on the queue entry (DD-15 TTL). It is the SAME chain — no automated trend
 * polling ships in v1 (that is roadmap, Appendix B).
 *
 * Convergence (§8.2 vocabulary, state-worksheet.md): both lifecycles converge on the same
 * stage states `validating → packaged` and land the durable queue entry in `awaiting_approval`.
 * Pre-packaging stage states are tracked via the workflow ledger (recordEvent) keyed by
 * content-id; the durable queue entry is authoritative from packaging onward (§8.2). This
 * pipeline does NOT post the approval card or run the publish executor — the publisher-liaison
 * surface (reaction-listener) and the executor own those edges; the pipeline stops at
 * `awaiting_approval` (the reviewer's first, mandatory gate).
 *
 * Tier-3 cleanliness (§0.3 r6 / RD-3): no IDs/handles/absolute paths/brand strings; no
 * production persona codenames. All instance state resolves through engine/shared/paths.js;
 * all gate/retrieval/queue behavior is the shipped engine modules. Roles are named by the
 * neutral §9.1 role vocabulary.
 */

const preGateLint = require('../engine/gate/pre-gate-lint.js');
const validatePackage = require('../engine/gate/validate-package.js');
const visualCheckMod = require('../engine/gate/visual-check');
const library = require('../engine/library/check.js');
const card = require('../engine/shared/components-v2.js');

const shared = require('./shared.js');

const LIFECYCLE = 'text-heavy';

/**
 * Run the text-heavy lifecycle for one calendar slot, producing a queue entry in
 * `awaiting_approval` (or stopping earlier with an explicit gate-fail outcome that routes
 * back to the seat the gate names). The chain never publishes and never posts the card.
 *
 * @param {object} slot  the slot-run input. The orchestrator dispatches this (§8.4 run
 *   mechanics). Shape (a superset of the operator-command / calendar slot + trend extras):
 *     content_id   {string}  the item id keying every stage artifact (auto-derived if absent).
 *     brand        {string}  brand id.
 *     platform     {string}  platform descriptor id (twitter for the flagship).
 *     format       {string}  content format within the platform.
 *     mode         {string}  SAFE | LIVE_PREVIEW | LIVE (default SAFE — RD-16f).
 *     slot_ref     {string}  calendar slot id.
 *     slot_type    {string}  regular | trend | campaign (calendar.schema.json).
 *     archetype, theme, pillar, pre_seed  optional matcher pre-seed hints.
 *     content_form {string}  standalone | quote-retweet (DD-16; trend slots may set this).
 *     trend_report {object}  a trend-report.schema.json object (the trend variant; §8.8).
 *     trend_report_ref {string}  CONTENT_HOME-relative ref to the submitted trend report.
 * @param {object} [pipeline]  the wired pipeline (seats + engine deps + env). Default = the
 *   stub pipeline (seats throw "unwired"); a host injects real seats via createPipeline().
 * @returns {Promise<object>} the run OUTCOME (see shared.makeOutcome): { lifecycle, content_id,
 *   stage, state, ok, queue_entry?, gate?, media_decision?, routed_back_to?, reason }.
 */
async function runTextHeavy(slot, pipeline = createPipeline()) {
  const ctx = shared.makeRunCtx(slot, pipeline, LIFECYCLE);
  const { content_id, env } = ctx;

  shared.ledgerEvent(content_id, 'run_started', { status: 'planned', run: { lifecycle: LIFECYCLE, slot_ref: slot.slot_ref || null } }, env);

  // --- matcher: slot → archetype/theme + deterministic idea/argument pre-seed (§9.2) -------
  // For a TREND slot the matcher's pre-seed is sourced from the submitted trend report's
  // suggested angles (angles only — never drafted text, §8.8); the report rides as Zone-U
  // provenance and the content_form propagates to the package + queue entry (DD-16).
  const matcherInput = shared.matcherInput(ctx);
  const brief = await ctx.seats.matcher(matcherInput);
  shared.assertArtifact(brief, 'brief', ['content_id', 'pre_seed']);
  shared.ledgerEvent(content_id, 'matched', { status: 'seeded', run: { archetype: brief.archetype || null } }, env);

  // --- enricher (optional, RD-13): the matcher→writer contract works WITHOUT it -------------
  // If a host wired an enricher seat AND the slot opts in, the enrichment field-set is folded
  // onto the brief (brief.enrichment). Absence is the normal path; never required.
  let enrichedBrief = brief;
  if (ctx.seats.enricher && slot.enrich !== false && pipeline.enricherEnabled) {
    const packet = await ctx.seats.enricher({ ...matcherInput, brief });
    if (packet && typeof packet === 'object') {
      enrichedBrief = { ...brief, enrichment: packet.enrichment || packet };
      shared.ledgerEvent(content_id, 'enriched', { status: 'enriched' }, env);
    }
  }

  // --- writer: framework-by-length drafting, exactly 3 labeled variants (DD-11) -------------
  // The writer boot-reads the per-length framework named on the brief (brief.framework_ref,
  // §9.3). The pipeline supplies the framework ref; the writer seat produces the draft artifact.
  const draft = await ctx.seats.writer({ brief: enrichedBrief, framework_ref: shared.frameworkRefFor(enrichedBrief) });
  shared.assertArtifact(draft, 'draft', ['content_id', 'variants']);
  shared.ledgerEvent(content_id, 'drafted', { status: 'drafted' }, env);

  // --- gate (UNIVERSAL): deterministic pre-gate → LLM judge seam (voice+quality) ------------
  // text-heavy gates the draft BEFORE media (the argument is the main artifact). A HARD pre-gate
  // FAIL routes straight back to the writer with NO LLM spend (pre-gate-lint contract). The LLM
  // judge seam adds the voice+quality verdict; codes from both layers UNION (§14.1).
  const gate = await runGate(ctx, { draft: draft, brief: enrichedBrief, stageBeforeMedia: true });
  if (!gate.ok) {
    shared.ledgerEvent(content_id, 'gate_failed', { status: 'hard_failed' }, env);
    return shared.makeOutcome(ctx, { stage: 'gate', state: 'hard_failed', ok: false, gate, routed_back_to: gate.route || 'writer', reason: gate.reason });
  }
  shared.ledgerEvent(content_id, 'gate_passed', { status: 'validated_pass', gates: { llm: gate.llm || null } }, env);

  // --- media decision: retrieval → reuse/modify/generate (§8.1, §8.6 enforcement point 1) ---
  // Retrieval reads the canonical archive index + the ONE usage ledger (cooldown point 1).
  // The media seat owns the final action; the deterministic retrieval scorer produces the
  // candidate set + the brand-neutral default decision the seat may accept or override.
  const media = await runMediaDecision(ctx, { brief: enrichedBrief, draft });
  if (media.attached) shared.ledgerEvent(content_id, 'media_attached', { status: 'media_attached', media: { action: media.decision.action } }, env);

  // --- visual-check (when media; deterministic visual layer) --------------------------------
  // Image stills get the visual gate (a vision-model question pack via the §12.5 provider seam).
  // No provider configured ⇒ degrade-to-skip (a SOFT code that bars Recommended for visual
  // formats), never a crash. The visual result travels into package validation below.
  let visual = null;
  if (media.attached && media.imagePath) {
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

  // --- packager: platform-final packaging (§9.1 packager) -----------------------------------
  // The packager assembles the §7.4 package object (audit header + Recommended/A/B + scores +
  // source stack + media). It may only apply packaging transforms — any alteration of validated
  // text re-enters the deterministic gate (§9.1 packager "may not"); the host enforces that.
  const pkg = await ctx.seats.packager({
    brief: enrichedBrief,
    draft,
    gate,
    media_decision: media.decision,
    content_form: ctx.content_form,
    mode: ctx.mode,
  });
  shared.assertArtifact(pkg, 'package', ['audit_header']);
  shared.ledgerEvent(content_id, 'packaging', { status: 'validating' }, env);

  // --- deterministic package + platform gates + cooldown (layer 3, §14.1) -------------------
  // validate-package runs the structural pre-publish gate INCLUDING the platform-gate registry
  // and cooldown enforcement point 2 (DD-14), and honors the visual-check result we attach.
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
  // The queue write happens EXCLUSIVELY through the engine's locked writer (§8.4 — no seat
  // touches the queue). The pipeline enqueues; the publisher-liaison surface posts the card and
  // the executor handles handoff — neither is this pipeline's job.
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
// The UNIVERSAL gate composition (shared by both lifecycles, §8.1 invariant)
// ---------------------------------------------------------------------------

/**
 * Run the universal gate over a draft: deterministic pre-gate (layer 1) then the LLM judge
 * seam (voice + quality). Returns { ok, verdict, llm, lint, detected_codes, reason, route }.
 *
 * - The pre-gate (pre-gate-lint) runs first: a HARD FAIL short-circuits with NO LLM spend and
 *   routes back to the writer (the explicit cost-saving contract of layer 1).
 * - A clean (or soft-only) pre-gate advances to the LLM judge seat, which returns a §7.2
 *   validation-result (voice + quality verdict + codes). The pipeline UNIONS the pre-gate's
 *   soft codes with the LLM codes (§14.1 union-of-codes) and computes the combined verdict.
 * - The gate seat is a SEAM: a host wires its voice/quality judge sessions to ctx.seats.gate.
 *   When unwired (e.g. fixture/SAFE smoke), the LLM layer is skipped and the verdict rides the
 *   deterministic pre-gate alone (honest: the result marks llm:null so callers know the LLM
 *   layer did not run — never a fabricated LLM PASS).
 */
async function runGate(ctx, { draft, brief }) {
  const lint = preGateLint.lint(draft, shared.lintRules(ctx, brief));
  if (lint.verdict === 'FAIL') {
    return {
      ok: false,
      verdict: 'FAIL',
      lint,
      llm: null,
      detected_codes: lint.detected_codes,
      reason: 'deterministic pre-gate hard fail (no LLM spend)',
      route: shared.firstRoute(lint) || 'writer',
    };
  }

  let llm = null;
  if (ctx.seats.gate) {
    llm = await ctx.seats.gate({ draft, brief, pre_gate: lint });
  }

  const detected = [
    ...lint.detected_codes,
    ...((llm && Array.isArray(llm.detected_codes)) ? llm.detected_codes : []),
  ];
  const llmHardFail = Boolean(llm && llm.verdict === 'FAIL');
  const llmHardCode = detected.some((d) => d.source !== 'lint' && d.tier === 'hard');
  const ok = !llmHardFail && !llmHardCode;
  const barsRecommended = detected.some((d) => d.tier === 'soft' && d.bars_recommended);
  const verdict = ok ? (barsRecommended ? 'PASS_ALTERNATE_ONLY' : 'PASS') : 'FAIL';

  return {
    ok,
    verdict,
    lint,
    llm,
    detected_codes: detected,
    reason: ok ? 'gate clean (deterministic + LLM voice/quality)' : 'LLM gate hard fail',
    route: ok ? null : ((llm && llm.route) || shared.firstRoute({ detected_codes: detected }) || 'writer'),
  };
}

// ---------------------------------------------------------------------------
// Media decision (retrieval → reuse/modify/generate) — §8.6 point 1
// ---------------------------------------------------------------------------

/**
 * Produce the media decision for a text-heavy item. Text-heavy items MAY be text-only (no
 * media) — the media seat decides whether the format needs an asset. When media is required,
 * the deterministic retrieval scorer (library/check.js) produces the candidate set + the
 * brand-neutral default reuse/modify/generate decision (cooldown point 1, the one ledger), and
 * the media seat may accept or override it, then produces/attaches the asset.
 *
 * Returns { decision, attached, imagePath?, visual_class?, identity_required?, scene_hint? }.
 */
async function runMediaDecision(ctx, { brief, draft }) {
  // A text-only format (e.g. a single tweet) carries no media: the FORMAT drives this, so the
  // media stage is skipped entirely — a wired media seat is not invoked for a pure text format
  // (the seat governs media-bearing formats; it never injects media into a text-only item).
  if (!shared.formatNeedsMedia(ctx.format)) {
    return { decision: { action: 'generate', reason: 'text-only format; no media required' }, attached: false };
  }

  const query = shared.mediaQuery(ctx, brief, draft);
  const { result, mediaDecision } = library.decideMedia(query, { content_id: ctx.content_id, brand: ctx.brand, platform: ctx.platform }, {
    config: ctx.retrievalConfig,
    env: ctx.env,
    excludeContentId: ctx.content_id,
  });

  // The media seat owns the final asset: for reuse it binds the chosen asset; for modify/generate
  // it produces output and returns the produced ref. When unwired, the deterministic decision
  // stands and no asset is attached (a generate decision with no produced asset yet).
  let seatOut = null;
  if (ctx.seats.media) {
    seatOut = await ctx.seats.media({ retrieval: result, decision: mediaDecision, brief, draft });
  }

  const finalDecision = (seatOut && seatOut.decision) || mediaDecision;
  const producedRef = (seatOut && (seatOut.output_ref || seatOut.media_ref)) || finalDecision.output_ref || finalDecision.chosen_asset_ref || null;
  const attached = Boolean(producedRef);

  return {
    decision: finalDecision,
    attached,
    imagePath: attached && shared.isImageRef(producedRef) ? producedRef : null,
    visual_class: seatOut && seatOut.visual_class,
    identity_required: seatOut && seatOut.identity_required,
    scene_hint: seatOut && seatOut.scene_hint,
    media_refs: attached ? [producedRef] : [],
  };
}

// ---------------------------------------------------------------------------
// Pipeline construction (the seat seam)
// ---------------------------------------------------------------------------

/**
 * Build a pipeline object: the seat seam (host injects real LLM seats here), the engine deps,
 * config, and env. Defaults: seats are unwired stubs that throw, so a misconfigured host fails
 * loudly rather than fabricating artifacts. The card builder is exposed so a host's
 * publisher-liaison can render the approval surface from the queued package.
 *
 * @param {object} [opts]
 * @param {object} [opts.seats]  { matcher, enricher?, writer, gate?, media?, packager } — each
 *   an async fn returning the §9.2 artifact for that handoff.
 * @param {object} [opts.config]  decoded config/system.json (cooldown days, reviewers, …).
 * @param {object} [opts.retrievalConfig]  retrieval threshold overrides (library/check DEFAULTS).
 * @param {object} [opts.visualProvider]   the §12.5 vision provider block (absent ⇒ skip).
 * @param {boolean} [opts.enricherEnabled]  opt the optional enricher in (default false — RD-13).
 * @param {object} [opts.env]  environment (default process.env).
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
  runTextHeavy,
  runGate,
  runMediaDecision,
  createPipeline,
};
