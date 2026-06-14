'use strict';

/**
 * engine/setup/index.js  [N net-new]
 *
 * The setup module's public API surface — the importable functions the CLI's `init` / `verify`
 * verbs (bin/engine.js, a sibling batch) call (release-spec §2; §13 status surface; DD-5).
 * Re-exports the three load-bearing entry points named in the batch contract:
 *
 *   initHome(opts)            scaffold $CONTENT_HOME (idempotent) — init.js
 *   verifyCheckpoint(n, opts) run the C0–C4 verifier, structured pass/fail — checkpoints.js
 *   readSetupState(env)       read setup-state.json (which checkpoints passed) — setup-state.js
 *
 * plus the supporting helpers (setCheckpoint, firstIncompleteCheckpoint, LIFECYCLE, …) the CLI
 * uses to record verifier outcomes and drive the resumable flow (§2.1).
 */

const init = require('./init');
const checkpoints = require('./checkpoints');
const setupState = require('./setup-state');

module.exports = {
  // primary contract (batch-named)
  initHome: init.initHome,
  verifyCheckpoint: checkpoints.verifyCheckpoint,
  readSetupState: setupState.readSetupState,

  // init
  UnsafeContentHomeError: init.UnsafeContentHomeError,
  LAYOUT_DIRS: init.LAYOUT_DIRS,
  starterSystemConfig: init.starterSystemConfig,

  // checkpoints
  verifyC0: checkpoints.verifyC0,
  verifyC1: checkpoints.verifyC1,
  verifyC2: checkpoints.verifyC2,
  verifyC3: checkpoints.verifyC3,
  verifyC4: checkpoints.verifyC4,
  DEFAULT_CALIBRATION_CRITERIA: checkpoints.DEFAULT_CALIBRATION_CRITERIA,

  // setup-state
  CHECKPOINTS: setupState.CHECKPOINTS,
  LIFECYCLE: setupState.LIFECYCLE,
  setCheckpoint: setupState.setCheckpoint,
  writeSetupState: setupState.writeSetupState,
  firstIncompleteCheckpoint: setupState.firstIncompleteCheckpoint,
  deriveLifecycle: setupState.deriveLifecycle,
};
