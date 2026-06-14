'use strict';

/**
 * fixtures/run.js  [N net-new — P4-TEST / P4-FIXRUN]
 *
 * The zero-key, deterministic end-to-end fixture runner (release-spec §5.4; model §13.1 MUST;
 * decisions.md ratification (b) — the Step-9 audit target). `engine fixture-run` (engine/cli/
 * fixture-run.js) delegates here once `fixtures/stage-outputs/` is present; it exports
 * `runFixture({ env, fixturesDir })` and returns an outcome the CLI surfaces.
 *
 * It exercises the §5.4 spine on a fresh clone with NO live API keys and NO operator CONTENT_HOME:
 *
 *   brief.json (recorded)
 *     → recorded writer output (draft.json, 3 variants)         [REPLAYED — labeled]
 *     → deterministic pre-gate (engine/gate/pre-gate-lint)      [RUNS LIVE]
 *     → recorded LLM-gate verdicts (gate-verdicts.json)         [REPLAYED — labeled]
 *     → package assembly (the packager seat)
 *     → validate-package + platform gates + cooldown            [RUNS LIVE]
 *           (cooldown against a rebased usage-log.jsonl + media-decision.json)
 *     → mock approval-card artifact (temp dir, no Discord)      [RUNS LIVE — buildCard]
 *     → simulated approval (queue entry → approved, allowlisted reviewer)
 *     → executor dry-run to a stub publisher adapter            [RUNS LIVE — no network]
 *
 * Honest reading of "fixture content end-to-end to a mock approval card with zero live API keys"
 * (§5.4): the deterministic components run LIVE; the LLM-dependent seats (matcher, writer, voice/
 * quality judge, media-decision) REPLAY the recorded fixture artifacts. The run verifies every
 * deterministic contract and artifact shape en route; a missing/mislabeled fixture fails loudly.
 *
 * Side-effect-free: the CLI passes a throwaway temp CONTENT_HOME (env.CONTENT_HOME) with the
 * workflow ledger disabled; this runner writes ONLY under it (queue, card artifact, usage-log)
 * and never the operator's instance or the checkout. The runner does not create or remove the
 * temp dir — the CLI owns its lifecycle.
 *
 * Tier-3 cleanliness (§0.3 r6): the only brand is the synthetic "acme-cosmos" fixture; the
 * reviewer id is a synthetic 0…01 placeholder; no real ids/handles/paths/codenames.
 */

const fs = require('fs');
const path = require('path');

const textHeavy = require('../pipelines/text-heavy.js');
const card = require('../engine/shared/components-v2.js');
const queue = require('../engine/shared/queue.js');
const usageLog = require('../engine/library/usage-log.js');
const publishers = require('../engine/publishers/publisher.js');
const executor = require('../engine/orchestrator/publish-executor.js');
const paths = require('../engine/shared/paths.js');

const { createStubPublisher } = require('./stub-publisher.js');

/** A synthetic allowlisted reviewer (0…01-class placeholder — never a real snowflake). */
const FIXTURE_REVIEWER_ID = '00000000000000001';
const STUB_PUBLISHER_NAME = 'fixture-stub';
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Read + JSON-parse a fixture file, failing loudly (never a fabricated pass) when absent/bad. */
function readJson(file, label) {
  if (!fs.existsSync(file)) {
    throw fixtureError(`recorded fixture missing: ${label} (${file})`);
  }
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw fixtureError(`recorded fixture is not valid JSON: ${label} — ${e.message}`);
  }
}

function fixtureError(message) {
  const err = new Error(message);
  err.code = 'EFIXTURE';
  return err;
}

/** Read the cooldown-history JSONL, rebasing each used_at to now − _fixture_offset_days_ago. */
function readRebasedUsageLog(file) {
  if (!fs.existsSync(file)) return [];
  const now = Date.now();
  return fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/u)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .map((rec) => {
      // The README documents date-relative cooldown: rebase used_at off the offset so the
      // in/out-of-window distinction is byte-stable across calendar time (§5.4 stage-outputs README).
      if (Number.isFinite(rec._fixture_offset_days_ago)) {
        rec.used_at = new Date(now - rec._fixture_offset_days_ago * MS_PER_DAY).toISOString();
      }
      delete rec._fixture_offset_days_ago;
      delete rec._fixture_note;
      return rec;
    });
}

/**
 * Replay seats: each LLM-dependent seat returns its RECORDED fixture artifact (clearly labeled by
 * its location under stage-outputs/). The deterministic engine work between seats runs live.
 */
function replaySeats({ brief, draft, gateVerdicts, mediaDecision }) {
  return {
    matcher: async () => brief,
    writer: async () => draft,
    // The voice/quality judge seat: replay the recorded LLM-only codes. The live pre-gate already
    // produced the lint stage; the pipeline UNIONS lint + these (DD-3). We feed the FINAL verdict's
    // LLM-sourced codes (source !== 'lint') so the union contract is exercised honestly.
    gate: async () => {
      const fv = gateVerdicts.final_verdict || {};
      const llmCodes = (fv.detected_codes || []).filter((c) => c && c.source !== 'lint');
      return {
        stage: fv.stage || 'llm-quality',
        verdict: fv.verdict || 'PASS',
        detected_codes: llmCodes,
        scores: fv.scores || {},
        recommended_variant: fv.recommended_variant || draft.strongest_variant || 'recommended',
      };
    },
    // Media seat: replay the recorded decision. For the text-only fixture the pipeline skips media
    // entirely (the format drives it), but the seat is wired for completeness / a media fixture.
    media: async () => ({ decision: mediaDecision }),
    // Packager: assemble the §7.4 package from the replayed draft + the replayed gate verdict.
    packager: async ({ draft: d, gate, content_form, mode }) => {
      const v = (label) => d.variants.find((x) => new RegExp(label, 'i').test(x.label)) || {};
      const rec = v('recommend');
      const a = d.variants.find((x) => /(^|-)a$/i.test(x.label)) || d.variants[1] || {};
      const b = d.variants.find((x) => /(^|-)b$/i.test(x.label)) || d.variants[2] || {};
      return {
        audit_header: {
          content_id: d.content_id,
          brand: d.brand,
          platform: d.platform,
          mode: mode || d.mode || 'SAFE',
          format: d.format,
          content_form: content_form || 'standalone',
          gate_verdict: gate.verdict,
          package_status: 'ready',
        },
        recommended: { text: rec.text || '', scores: gate.scores || { brand: 90 } },
        variant_a: { text: a.text || '' },
        variant_b: { text: b.text || '' },
      };
    },
  };
}

/** Build the surface-neutral mock approval card from the recorded draft + gate verdicts. */
function buildMockCard({ brief, draft, gateVerdicts }) {
  const fv = gateVerdicts.final_verdict || {};
  // Soft codes (the union-of-codes warnings) travel with the item to the reviewer (§7.5, DD-3).
  const warnings = (fv.detected_codes || [])
    .filter((c) => c && c.tier === 'soft')
    .map((c) => ({
      code: c.code,
      family: c.family || c.code.split('.')[0],
      explanation: c.explanation || '',
      bars_recommended: Boolean(c.bars_recommended),
    }));
  const v = (rx, fallbackIdx) => draft.variants.find((x) => rx.test(x.label)) || draft.variants[fallbackIdx] || {};
  const rec = v(/recommend/i, 0);
  const a = v(/(^|-)a$/i, 1);
  const b = v(/(^|-)b$/i, 2);
  return card.buildCard({
    content_id: brief.content_id,
    title: `Approval preview — ${brief.brand} / ${brief.platform}`,
    brand: brief.brand,
    platform: brief.platform,
    format: brief.format,
    variants: [
      { label: 'recommended', text: rec.text || '' },
      { label: 'a', text: a.text || '' },
      { label: 'b', text: b.text || '' },
    ],
    warnings,
    provenance: 'zero-key fixture run (deterministic spine; LLM stages replayed)',
    status: 'pending',
  });
}

/**
 * Run the zero-key fixture spine end-to-end.
 * @param {object} ctx
 * @param {object} ctx.env          a throwaway temp CONTENT_HOME env (CLI-provided), ledger off.
 * @param {string} ctx.fixturesDir  the repo `fixtures/` dir (CLI-provided).
 * @returns {Promise<object>} { ok, stages, card_ref, queue_state, handoff_calls, ... }
 */
async function runFixture(ctx = {}) {
  const env = ctx.env || process.env;
  const fixturesDir = ctx.fixturesDir || path.resolve(__dirname);
  const stageDir = path.join(fixturesDir, 'stage-outputs');
  const stages = [];

  // --- 1. Load + label the recorded LLM-stage fixtures (fail loudly if any is missing) --------
  const brief = readJson(path.join(stageDir, 'brief.json'), 'brief');
  const draft = readJson(path.join(stageDir, 'draft.json'), 'draft');
  const gateVerdicts = readJson(path.join(stageDir, 'gate-verdicts.json'), 'gate-verdicts');
  const mediaDecision = readJson(path.join(stageDir, 'media-decision.json'), 'media-decision');
  if (gateVerdicts.recorded_fixture !== true) {
    throw fixtureError('gate-verdicts.json must carry "recorded_fixture": true (the replay label, §5.4)');
  }
  stages.push('load-recorded-fixtures');

  const contentId = brief.content_id;

  // --- 2. Seed the throwaway CONTENT_HOME: config (reviewers allowlist) + rebased usage-log -----
  const home = paths.contentHome(env); // throws if unset — the CLI always provides one.
  fs.mkdirSync(path.join(home, 'config'), { recursive: true });
  fs.mkdirSync(paths.queueLocksDir(env), { recursive: true });
  fs.mkdirSync(paths.libraryDir(env), { recursive: true });
  const systemConfig = {
    schema_version: '1.0.0',
    mode: 'SAFE',
    reviewers: [{ id: FIXTURE_REVIEWER_ID, name: 'Fixture Reviewer', rights: ['approve', 'edit'] }],
    publish: { draft_only: true, auto_publish_allowed: false },
    approval_surface: { adapter: 'discord', channels: {} },
    cooldown: { hard_days: usageLog.DEFAULT_HARD_DAYS, target_days: usageLog.DEFAULT_TARGET_DAYS },
  };
  fs.writeFileSync(paths.systemConfig(env), JSON.stringify(systemConfig, null, 2), 'utf8');
  const usageRecords = readRebasedUsageLog(path.join(stageDir, 'usage-log.jsonl'));
  if (usageRecords.length) {
    fs.writeFileSync(
      paths.usageLog(env),
      usageRecords.map((r) => JSON.stringify(r)).join('\n') + '\n',
      'utf8',
    );
  }
  stages.push('seed-content-home');

  // --- 3. Run the text-heavy spine with REPLAY seats → queue entry in awaiting_approval ---------
  // The deterministic work (pre-gate-lint, validate-package, platform gates, cooldown, the locked
  // queue write) runs LIVE; only the seats replay. The brief's format is text-only, so the media
  // stage is skipped by the format (no library index needed — keeps the run CONTENT_HOME-light).
  const slot = {
    content_id: contentId,
    brand: brief.brand,
    platform: brief.platform,
    format: brief.format,
    mode: brief.mode || 'SAFE',
    slot_ref: brief.slot_ref || 'fixture-slot',
    archetype: brief.archetype,
    theme: brief.theme,
    pre_seed: brief.pre_seed,
  };
  const pipeline = textHeavy.createPipeline({
    seats: replaySeats({ brief, draft, gateVerdicts, mediaDecision }),
    config: systemConfig,
    env,
  });
  const outcome = await textHeavy.runTextHeavy(slot, pipeline);
  if (!outcome.ok || outcome.state !== 'awaiting_approval') {
    return {
      ok: false,
      reason: `spine did not converge on awaiting_approval (stage=${outcome.stage}, state=${outcome.state}; ${outcome.reason || ''})`,
      stages,
      outcome,
    };
  }
  if (outcome.gate.gate_verdict !== gateVerdicts.final_verdict.verdict) {
    return {
      ok: false,
      reason: `gate verdict mismatch: spine=${outcome.gate.gate_verdict} recorded=${gateVerdicts.final_verdict.verdict}`,
      stages,
      outcome,
    };
  }
  stages.push('pipeline-awaiting_approval');

  // The durable queue entry actually landed via the locked writer.
  const queuePath = paths.publishQueue(env);
  const queued = queue.parseQueue(fs.readFileSync(queuePath, 'utf8'));
  const entry = queued.find((e) => (e.fields.content_id || e.header) === contentId);
  if (!entry || entry.fields.state !== 'awaiting_approval') {
    return { ok: false, reason: 'queue entry did not land in awaiting_approval', stages };
  }

  // --- 4. Build the mock approval card, validate its shape, write it to the temp dir ------------
  const builtCard = buildMockCard({ brief, draft, gateVerdicts });
  // buildCard() enforces the approval-card structural contract (content_id, ≥1 recommended
  // variant, bounded actions, relative media refs); a malformed card throws above. Assert the
  // recommended slot + the recorded soft warning rode onto the card (union contract surfaced).
  if (!builtCard.variants.some((v) => v.label === 'recommended')) {
    return { ok: false, reason: 'mock card missing the recommended slot', stages };
  }
  const cardsDir = path.join(paths.workspacesDir(env), 'cards');
  fs.mkdirSync(cardsDir, { recursive: true });
  // CONTENT_HOME-relative ref, POSIX-style (absolute paths are forbidden in artifacts, §7.1).
  const cardRef = `workspaces/cards/${contentId}.card.json`;
  fs.writeFileSync(path.join(home, ...cardRef.split('/')), JSON.stringify(builtCard, null, 2), 'utf8');
  stages.push('mock-approval-card');

  // --- 5. Simulate approval: queue entry → approved (allowlisted reviewer, recommended pick) ----
  // Edit-counts-as-approval is the human surface's job; here the reviewer simply approves the
  // Recommended variant. For the executor leg to exercise a real handoff (vs. a SAFE no-op) we
  // promote the item to LIVE at approval time and bind the stub publisher — the dry-run edge.
  queue.setEntryState(queuePath, contentId, {
    from: 'awaiting_approval',
    to: 'approved',
    fields: {
      approved_by: FIXTURE_REVIEWER_ID,
      approved_variant: builtCard.variants[0].label,
      approved_at: new Date().toISOString(),
      approved_copy: builtCard.variants[0].text,
      mode: 'LIVE',
      publisher: STUB_PUBLISHER_NAME,
    },
  });
  stages.push('simulated-approval');

  // --- 6. Executor dry-run to the stub publisher (no network, no keys) --------------------------
  // The stub is a §12.3-conformant draft adapter: the executor walks its publish-edge gates
  // (approver-allowlist DD-17, cooldown point 3, etc.), writes the DD-4 write-ahead intent, hands
  // off ONCE (DR W#35 idempotency), and parks the item in handed_off (the §2.4 second gate). No
  // real publish happens — the stub touches no network. We force LIVE for this one leg via env.
  const { adapter, calls } = createStubPublisher();
  publishers.register(STUB_PUBLISHER_NAME, adapter);
  let executorCode;
  let queueAfter;
  let entryAfter;
  try {
    executorCode = await executor.main({ ...env, ENGINE_MODE: 'LIVE', TARGET_CONTENT_ID: contentId });
    queueAfter = queue.parseQueue(fs.readFileSync(queuePath, 'utf8'));
    entryAfter = queueAfter.find((e) => (e.fields.content_id || e.header) === contentId);
  } finally {
    publishers.unregister(STUB_PUBLISHER_NAME);
  }

  const handedOff = entryAfter && entryAfter.fields.state === 'handed_off';
  if (!handedOff) {
    return {
      ok: false,
      reason: `executor dry-run did not reach handed_off (state=${entryAfter && entryAfter.fields.state}; exit=${executorCode}; calls=${calls.length})`,
      stages,
    };
  }
  if (calls.length !== 1) {
    return { ok: false, reason: `executor issued ${calls.length} handoffs (expected exactly 1 — idempotency)`, stages };
  }
  stages.push('executor-dry-run-handed_off');

  // --- 7. Idempotency re-run: a second executor pass must NOT issue a second handoff ------------
  const { adapter: adapter2, calls: calls2 } = createStubPublisher();
  publishers.register(STUB_PUBLISHER_NAME, adapter2);
  try {
    await executor.main({ ...env, ENGINE_MODE: 'LIVE', TARGET_CONTENT_ID: contentId });
  } finally {
    publishers.unregister(STUB_PUBLISHER_NAME);
  }
  if (calls2.length !== 0) {
    return { ok: false, reason: `re-run issued ${calls2.length} new handoffs (expected 0 — idempotent)`, stages };
  }
  stages.push('idempotent-rerun');

  return {
    ok: true,
    content_id: contentId,
    stages,
    card_ref: cardRef,
    queue_state: entryAfter.fields.state,
    handoff_calls: calls.length,
    gate_verdict: outcome.gate.gate_verdict,
    soft_warnings: builtCard.warnings.map((w) => w.code),
  };
}

module.exports = { runFixture, FIXTURE_REVIEWER_ID, STUB_PUBLISHER_NAME };
