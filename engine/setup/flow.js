'use strict';

/**
 * engine/setup/flow.js  [N net-new]
 *
 * The GUIDED-SETUP DRIVER — the single "where am I, what is the ONE next thing, I won't let you
 * skip ahead" brain that turns the C0–C4 checkpoint ladder into a strict, resumable, surface-
 * agnostic flow (release-spec §2.1 resumable setup; §2.2–§2.6 checkpoints; model §12 "halt with
 * named failed step + remediation"). It is the engine half of the kit-plus-thin-runner product:
 * this module emits a structured FRAME describing the current step; a surface RENDERS it.
 *
 * Why a frame instead of printing? The frame is the PUBLISHED CONTRACT
 * (schemas/artifacts/setup-frame.schema.json) that BOTH the `engine setup` CLI AND a host-runtime
 * adapter (e.g. a Discord component renderer) consume. The engine never owns a Discord connection
 * or a bot token (PR: host-runtime owns the connector); it computes the frame, and the CLI renders
 * it as text while an adapter renders it as buttons/menus. One brain, many surfaces.
 *
 * The strict guarantees (all inherited from the verifiers + setup-state, never re-implemented here):
 *   - STRICT: the current step is the FIRST checkpoint whose deterministic verifier does not pass.
 *     A later step is never surfaced as actionable until the earlier one verifies (the ladder is the
 *     gate — engine/setup/checkpoints.js).
 *   - SELF-ADVANCING + RESUMABLE: computeFrame re-runs the verifier from the resume point
 *     (firstIncompleteCheckpoint) forward, RECORDING each pass into setup-state.json, so re-invoking
 *     `engine setup` after you fix a step moves you on with zero extra ceremony (§2.1).
 *   - HONEST: the outstanding work shown is exactly the verifier's failing checks + their named
 *     remediation; the satisfied list is its passing checks. No second source of truth to drift.
 *
 * CONTENT_HOME-free safe (§2.2): before `engine init` runs there is no instance dir, so reading the
 * resume point throws ContentHomeUnsetError. computeFrame catches that and begins at C0 (the zero-key
 * proof needs no CONTENT_HOME), recording nothing until an instance exists — onboarding is never
 * blocked by a missing CONTENT_HOME.
 *
 * Tier-3 cleanliness (§0.3 r6): no hardcoded ids/handles/absolute roots, no production persona
 * codenames. Every operator-specific value is a <PLACEHOLDER> the surface fills; instance paths are
 * resolved by the verifiers via shared/paths.js, never constructed here.
 */

const checkpoints = require('./checkpoints');
const setupState = require('./setup-state');

const { CHECKPOINTS, LIFECYCLE } = setupState;

/**
 * The frame contract version. Bump on a breaking change to the frame SHAPE (a new optional field is
 * not breaking). Surfaces (the CLI renderer, the Discord adapter) pin to this so an old adapter can
 * detect a frame it does not understand rather than mis-render it.
 */
const FRAME_SCHEMA_VERSION = 1;

/**
 * The curated, plain-language layer over each checkpoint — the "what is this step and why, in words
 * an 8th-grader gets" intro plus the canonical actions a surface offers. The LIVE pass/fail detail
 * comes from the verifier (the single source of truth); this is only the human framing + the literal
 * commands. Kept deliberately jargon-light (the START-HERE.md voice).
 *
 * Action shape (the frame contract — see the schema):
 *   { id, type, label, help?, command?, inputs?, options?, spends?, doc? }
 *     type:    'run'   a literal command to run (command set)
 *              'input' a step that needs operator-provided values before a command (inputs set)
 *              'choice' a branch the operator picks (options set); each option may carry its own command
 *              'verify' the checkpoint re-check (command = `engine verify --setup c<n>`)
 *              'finish' the terminal "you're done" action (done frame only)
 *     spends:  true when the action costs engine-metered money — the surface MUST surface the
 *              estimate-and-confirm gate (DD-18); the engine never auto-spends behind a button.
 */
const STEP_GUIDE = Object.freeze({
  C0: {
    title: 'Prove the engine runs on your machine',
    headline: 'First win: run the whole engine against built-in sample data — no keys, no accounts, no risk.',
    body: [
      'Before anything touches a real account or spends a cent, you prove the engine works on your box.',
      '`fixture-run` runs the entire content pipeline end-to-end against shipped sample data. It needs',
      'no credentials and no setup folder, and it cannot post anywhere. A green run is your proof that',
      'the engine is healthy before you wire in anything real.',
    ],
    actions: [
      {
        id: 'install',
        type: 'run',
        label: 'Install dependencies (one time)',
        help: 'Downloads what the engine needs. Run once per clone.',
        command: 'npm ci',
      },
      {
        id: 'fixture-run',
        type: 'run',
        label: 'Run the zero-key proof',
        help: 'Runs the full engine on sample data. Spends nothing, posts nothing. Look for the green [OK] line.',
        command: 'node bin/engine.js fixture-run',
      },
    ],
    doc: 'docs/setup/START-HERE.md',
  },
  C1: {
    title: 'Create your private folder and approval surface',
    headline: 'Make the folder that holds your data (outside the code), then say who approves and where cards land.',
    body: [
      'Now you make your own private instance folder — your queue, settings, logs, and secrets live',
      'here, deliberately OUTSIDE the code checkout so nothing private can ever be committed.',
      '`engine init` creates it; then you point your shell at it with CONTENT_HOME.',
      '',
      'Then you fill in config/system.json with the essentials the engine refuses to run without:',
      'at least one reviewer who can approve, your spending caps, and the four Discord channels where',
      'approval cards, published notices, ops alerts, and media live. The checklist below shows exactly',
      'which of those are still missing.',
      '',
      'You do NOT need a publisher (Postiz) yet — that is deferred until you go LIVE.',
    ],
    actions: [
      {
        id: 'init',
        type: 'run',
        label: 'Create my private instance folder',
        help: 'Makes the folder that holds your data. Pick a path OUTSIDE this code checkout.',
        command: 'node bin/engine.js init --home <CONTENT_HOME_PATH>',
        inputs: [{ name: 'home', label: 'A folder path OUTSIDE this code checkout', kind: 'path', required: true }],
      },
      {
        id: 'set-content-home',
        type: 'input',
        label: 'Point my shell at that folder',
        help: 'So every later command knows where your instance lives.',
        command: 'export CONTENT_HOME=<CONTENT_HOME_PATH>   # PowerShell: $env:CONTENT_HOME = "<CONTENT_HOME_PATH>"',
        inputs: [{ name: 'home', label: 'The same folder path you just created', kind: 'path', required: true }],
      },
      {
        id: 'edit-config',
        type: 'input',
        label: 'Fill in config/system.json',
        help: 'Bind your 4 channel ids + 1 approver id + budget caps. The checklist above lists what is still missing by name.',
        command: 'edit $CONTENT_HOME/config/system.json   (see docs/setup/discord.md for the channel ids)',
        doc: 'docs/setup/quick-start.md',
      },
    ],
    doc: 'docs/setup/quick-start.md',
  },
  C2: {
    title: 'Register a brand and give it a voice',
    headline: 'Tell the engine who it is writing as — then either feed it your content or start cold.',
    body: [
      'A "brand" is the account the engine writes for. Register at least one, then give it a Brand DNA:',
      'the voice, the rules, the facts it must never get wrong.',
      '',
      'Two honest paths, both fully supported:',
      '  • Have existing content? Point the engine at your files/exports, or auto-fetch from your public',
      '    account, and it will analyze your real voice and draft the DNA for you.',
      '  • Starting fresh? Use the cold-start path — fill the authoring template by hand. No content, no',
      '    scraping, no spend required. Onboarding is never blocked by a lack of history.',
    ],
    actions: [
      {
        id: 'register-brand',
        type: 'input',
        label: 'Register a brand',
        help: 'Create brands/<id>/brand.json from the template: an id, a display name, account class, and one platform.',
        command: 'cp templates/brand/brand.json.template $CONTENT_HOME/brands/<BRAND_ID>/brand.json   # then edit it',
        inputs: [{ name: 'brand', label: 'A short id for this brand (e.g. my-brand)', kind: 'id', required: true }],
      },
      {
        id: 'content-source',
        type: 'choice',
        label: 'Where does this brand’s existing content come from?',
        help: 'Pick how the engine learns the voice. Each option is a command today; in Discord these are buttons.',
        options: [
          {
            id: 'files',
            label: 'I have files / official exports — point to them',
            help: 'Import an export or a folder of posts, then build the DNA from it (free; no scraping).',
            command: 'node bin/engine.js ingest-brand --brand <BRAND_ID> --manual',
          },
          {
            id: 'apify',
            label: 'Auto-fetch from my public account (Apify)',
            help: 'Bring-your-own scraper adapter pulls recent posts, then builds the DNA. Metered — shows a cost estimate first.',
            command: 'node bin/engine.js ingest-brand --brand <BRAND_ID>   # then confirm with --yes',
            spends: true,
          },
          {
            id: 'cold-start',
            label: 'Start cold — no content yet',
            help: 'Author the Brand DNA by hand from the template and set cold_start:true. Always works, zero spend.',
            command: 'cp templates/brand/brand-dna-authoring.md $CONTENT_HOME/brands/<BRAND_ID>/brand-dna.md   # then fill it in; set cold_start:true in brand.json',
          },
        ],
      },
      {
        id: 'store-mode',
        type: 'choice',
        label: 'How should the imported text be kept?',
        help: 'Applies to the files/Apify paths. The DNA-synthesis step summarizes your voice from the corpus either way.',
        options: [
          {
            id: 'raw',
            label: 'Raw — keep posts verbatim (default)',
            help: 'The fullest signal for voice analysis. Use unless storage size matters.',
            command: 'node bin/engine.js ingest-brand --brand <BRAND_ID> --store raw',
          },
          {
            id: 'stripped',
            label: 'Stripped — cleaned for size',
            help: 'Deterministically removes URLs and collapses whitespace. Smaller corpus; voice/word-choice unchanged. No summarizing.',
            command: 'node bin/engine.js ingest-brand --brand <BRAND_ID> --store stripped',
          },
          {
            id: 'summarize',
            label: 'Summarize — DNA only, keep little',
            help: 'DNA synthesis distills your voice into brand-dna.md; pair with a short retention so the raw corpus ages out fast.',
            command: 'node bin/engine.js ingest-brand --brand <BRAND_ID> --store stripped   # then set ingestion.retention_class: transient',
          },
        ],
      },
    ],
    doc: 'docs/setup/cold-start.md',
  },
  C3: {
    title: 'Calibrate — the quality gate (your first real spend)',
    headline: 'Generate a small sample batch, judge it, and prove the voice is good enough to go live.',
    body: [
      'Calibration is the one mandatory gate. The engine generates a small batch of sample posts in your',
      'brand voice; you judge them against the rubric. The project cannot become operational until enough',
      'samples clear the gate, enough read as on-voice, and zero contain fabricated facts.',
      '',
      'This is your first real engine-metered spend, so it is estimate-and-confirm: you always see the',
      'cost band first and nothing spends without your explicit --yes. If the batch falls short, tune the',
      'DNA and re-run — that loop is the point of the gate.',
    ],
    actions: [
      {
        id: 'estimate',
        type: 'run',
        label: 'See the cost first (no spend)',
        help: 'Prints the cost band for the calibration batch and exits. Spends nothing.',
        command: 'node bin/engine.js calibrate --brand <BRAND_ID> --estimate-only',
        inputs: [{ name: 'brand', label: 'The brand id to calibrate', kind: 'id', required: true }],
      },
      {
        id: 'calibrate',
        type: 'run',
        label: 'Run calibration (spends)',
        help: 'Confirms the estimate and generates the sample batch. This is metered — it costs money.',
        command: 'node bin/engine.js calibrate --brand <BRAND_ID> --yes',
        inputs: [{ name: 'brand', label: 'The brand id to calibrate', kind: 'id', required: true }],
        spends: true,
      },
      {
        id: 'record-result',
        type: 'input',
        label: 'Record how the samples judged',
        help: 'After you judge the batch, record the counts so the gate can grade them.',
        command: 'node bin/engine.js calibrate --brand <BRAND_ID> --result \'{"sample_count":10,"gate_clear":9,"on_voice":7,"fabrication_codes":0}\'',
        inputs: [{ name: 'brand', label: 'The brand id', kind: 'id', required: true }],
      },
    ],
    doc: 'docs/setup/brand.md',
  },
  C4: {
    title: 'Add a small calendar (and a library, if you have one)',
    headline: 'Give the engine a posting schedule. A media library is optional — empty is fine.',
    body: [
      'Last step: a small calendar so the engine knows when to post — even a few slots a week is enough,',
      'as long as one slot has a clock time.',
      '',
      'A media library is optional. If you have one, the engine can organize and index it so posts can',
      'reuse your assets. If you do not, empty-library mode is the default and nothing breaks — the engine',
      'just generates without reusing media.',
    ],
    actions: [
      {
        id: 'calendar',
        type: 'input',
        label: 'Make a small calendar',
        help: 'Create a calendar with at least one slot that has a clock time.',
        command: 'cp templates/calendar.template.md $CONTENT_HOME/calendar/calendar.md   # then add at least one timed slot',
        doc: 'docs/setup/quick-start.md',
      },
      {
        id: 'library',
        type: 'choice',
        label: 'Do you have a media library?',
        help: 'Optional. Each option is a command today; in Discord these are buttons.',
        options: [
          {
            id: 'organize',
            label: 'Help me organize + index a folder',
            help: 'Sort a messy media folder into Images/Videos/AI-generated, then index it for reuse. Indexing is metered.',
            command: 'node bin/engine.js index-library --organize --apply   # then: index-library --yes',
            spends: true,
          },
          {
            id: 'have',
            label: 'I have one — scan it first, then index',
            help: 'Read-only scan (no spend): checks the library is in the right shape and flags empty folders, stray files, and index health. Fix anything flagged, then index.',
            command: 'node bin/engine.js index-library --check   # read-only; then index-library --yes to index',
          },
          {
            id: 'none',
            label: 'No library yet (empty-library mode)',
            help: 'Skip it. Retrieval returns generate-only decisions; nothing in the chain needs a populated library.',
            command: 'node bin/engine.js verify --setup c4   # empty-library is a clean pass',
          },
        ],
      },
    ],
    doc: 'docs/setup/quick-start.md',
  },
});

/** Human-readable short labels for the progress strip, per checkpoint. */
const CHECKPOINT_LABELS = Object.freeze({
  C0: 'prove the engine runs',
  C1: 'private folder + approval surface',
  C2: 'brand + voice',
  C3: 'calibrate (quality gate)',
  C4: 'calendar + library',
});

/** A tiny, instance-data-free summary of the verifier checks for the setup-state record (§5.4). */
function summarizeChecks(result) {
  return {
    passed: result.passed,
    checks: (result.checks || []).map((c) => ({ name: c.name, status: c.status })),
  };
}

/**
 * Build the whole-ladder progress strip: each checkpoint with done|active|locked status. A
 * checkpoint is `done` when it is recorded-passed OR it just passed in this compute walk (the
 * latter matters when CONTENT_HOME is unset and the pass could not be recorded). Exactly one
 * checkpoint is `active` (the current step); everything after it is `locked`.
 *
 * @param {object} env
 * @param {string|null} activeCheckpoint  the current step (null on the done frame).
 * @param {string[]} [justPassed]         checkpoints confirmed-passing in this walk.
 */
function buildProgress(env, activeCheckpoint, justPassed = []) {
  let state;
  try {
    state = setupState.readSetupState(env);
  } catch {
    state = setupState.emptyState();
  }
  const passedThisWalk = new Set(justPassed);
  let done = 0;
  const list = CHECKPOINTS.map((id) => {
    const passed = passedThisWalk.has(id) || Boolean(state.checkpoints[id] && state.checkpoints[id].passed);
    let status;
    if (passed) { status = 'done'; done += 1; }
    else if (id === activeCheckpoint) status = 'active';
    else status = 'locked';
    return { id, label: CHECKPOINT_LABELS[id], status };
  });
  return {
    project_state: state.project_state || LIFECYCLE.UNINITIALIZED,
    done,
    total: CHECKPOINTS.length,
    checkpoints: list,
  };
}

/** The single most useful command for this frame (the first runnable action, else the verify re-check). */
function pickNextCommand(actions) {
  const runnable = actions.find((a) => (a.type === 'run' || a.type === 'input') && a.command);
  if (runnable) return runnable.command;
  const verify = actions.find((a) => a.type === 'verify' && a.command);
  return verify ? verify.command : null;
}

/** Assemble the guided frame for a checkpoint that has not yet passed. */
function guidedFrame(checkpoint, result, env, justPassed, stateReadable) {
  const guide = STEP_GUIDE[checkpoint];
  const failing = (result.checks || []).filter((c) => c.status === 'fail');
  const satisfied = (result.checks || []).filter((c) => c.status === 'pass');
  const skipped = (result.checks || []).filter((c) => c.status === 'skip');

  // The verify re-check action is ALWAYS the last action: it is how the operator (or the surface)
  // advances. Strictness lives here — the next step is not surfaced until this verify passes.
  const verifyAction = {
    id: 'verify',
    type: 'verify',
    label: 'Check this step',
    help: 'Re-runs the checker for this step. When it passes, re-run `engine setup` to move on.',
    command: `node bin/engine.js verify --setup ${checkpoint.toLowerCase()}`,
  };
  const actions = [...(guide.actions || []).map((a) => ({ ...a })), verifyAction];

  return {
    schema_version: FRAME_SCHEMA_VERSION,
    generated_for: checkpoint,
    done: false,
    title: guide.title,
    headline: guide.headline,
    progress: buildProgress(env, checkpoint, justPassed),
    body: guide.body.slice(),
    todo: failing.map((c) => ({ name: c.name, detail: c.detail, remediation: c.remediation || null })),
    satisfied: satisfied.map((c) => ({ name: c.name, detail: c.detail })),
    skipped: skipped.map((c) => ({ name: c.name, detail: c.detail })),
    actions,
    next_command: pickNextCommand(actions),
    just_passed: justPassed.slice(),
    doc: guide.doc || null,
    note: stateReadable
      ? null
      : 'CONTENT_HOME is not set yet, so progress is not being saved between runs. That is expected before `engine init` — set CONTENT_HOME after init and progress will persist.',
  };
}

/** Assemble the terminal "you're set up" frame. */
function doneFrame(env, justPassed) {
  const progress = buildProgress(env, null, justPassed);
  return {
    schema_version: FRAME_SCHEMA_VERSION,
    generated_for: 'done',
    done: true,
    title: 'You’re set up — the engine is operational',
    headline: 'All five checkpoints pass. Next: produce your first approval card in LIVE_PREVIEW, then go LIVE when ready.',
    progress,
    body: [
      'Every checkpoint passes and your project is operational. Here is the safe on-ramp from here:',
      '',
      '  1. Set mode to LIVE_PREVIEW and run a slot — this produces a REAL approval card in your',
      '     content-review channel, but never publishes. It is the first-approval-card milestone.',
      '  2. When you are happy, stand up the publisher (Postiz), set mode LIVE, and approve a card —',
      '     the engine hands off a DRAFT you publish yourself. Nothing auto-publishes by default.',
      '',
      'Use `engine status` any time to see mode, queue, what ran today, failures, and spend.',
    ],
    todo: [],
    satisfied: [],
    skipped: [],
    actions: [
      {
        id: 'status',
        type: 'run',
        label: 'See the operational dashboard',
        help: 'Mode, queue, today’s produced/published/failed, and spend — one command.',
        command: 'node bin/engine.js status',
      },
      {
        id: 'live-preview',
        type: 'input',
        label: 'Produce your first card (LIVE_PREVIEW)',
        help: 'Set mode LIVE_PREVIEW in config/system.json, then run a slot. Produces a real card; never publishes.',
        command: 'node bin/engine.js run-slot <SLOT_ID> --mode LIVE_PREVIEW',
      },
      {
        id: 'finish',
        type: 'finish',
        label: 'Done',
        help: 'Setup is complete.',
      },
    ],
    next_command: 'node bin/engine.js status',
    just_passed: (justPassed || []).slice(),
    doc: 'docs/setup/quick-start.md',
    note: null,
  };
}

/**
 * Compute the current guided-setup frame for this instance — the one function the CLI verb and any
 * host-runtime adapter call. Walks the ladder from the resume point, re-verifying (and, when an
 * instance exists, RECORDING) each checkpoint, and returns the frame for the first step that does
 * not yet pass (or the terminal done frame when the whole ladder passes).
 *
 * @param {object}  [opts]
 * @param {object}  [opts.env]     environment for path/secret resolution (default process.env).
 * @param {boolean} [opts.record]  record each verifier outcome into setup-state.json (default true);
 *                                 pass false for a pure read-only preview (no state mutation).
 * @returns {object} a frame conforming to schemas/artifacts/setup-frame.schema.json.
 */
function computeFrame(opts = {}) {
  const env = opts.env || process.env;
  const record = opts.record !== false;

  // Resume point. CONTENT_HOME-unset throws (no instance yet) → begin at C0, record nothing.
  let start;
  let stateReadable = true;
  try {
    start = setupState.firstIncompleteCheckpoint(env);
  } catch {
    start = CHECKPOINTS[0];
    stateReadable = false;
  }
  if (start === null) return doneFrame(env, []);

  const order = CHECKPOINTS;
  const justPassed = [];
  for (let i = order.indexOf(start); i < order.length; i++) {
    const id = order[i];
    const result = checkpoints.verifyCheckpoint(id, { env });
    if (record && stateReadable) {
      try {
        setupState.setCheckpoint(result.checkpoint, result.passed, { detail: summarizeChecks(result), env });
      } catch { /* CONTENT_HOME unset mid-walk — recompute will re-verify; do not block the frame */ }
    }
    if (!result.passed) return guidedFrame(id, result, env, justPassed, stateReadable);
    justPassed.push(id);
  }
  return doneFrame(env, justPassed);
}

module.exports = {
  FRAME_SCHEMA_VERSION,
  STEP_GUIDE,
  CHECKPOINT_LABELS,
  computeFrame,
  // exported for the renderer + tests
  buildProgress,
  summarizeChecks,
};
