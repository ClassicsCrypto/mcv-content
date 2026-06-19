'use strict';

/**
 * adapters/discord/route.js  [N net-new — reference adapter]
 *
 * INTERACTION ROUTING for the Discord adapter — the dependency-free glue between a clicked Discord
 * component and the engine's `engine setup` contract. It encodes a stable `custom_id` onto each
 * component (so Discord echoes it back on click) and decodes an incoming interaction into an
 * INSTRUCTION the bot runner acts on. No discord.js, no network — pure functions, fully testable.
 *
 * custom_id grammar (≤100 chars, Discord's limit — render.js truncates):
 *   "ocesetup|a|<frame>|<action-id>"   a button (action)
 *   "ocesetup|c|<frame>|<action-id>"   a string-select (choice); the chosen option arrives in values[]
 * The "ocesetup" prefix namespaces our components so the bot can ignore unrelated interactions.
 *
 * The instruction the bot acts on (so the bot stays a thin switch — the engine owns the meaning):
 *   { kind: 'recompute' }                          re-run `engine setup --json` and re-render the menu
 *   { kind: 'show-command', command, note, spends } reply (ephemerally) with the exact command to run;
 *                                                    the operator/agent runs it, then presses Re-check
 *   { kind: 'finish' }                             setup is complete — acknowledge and stop
 *   { kind: 'noop', note }                         nothing actionable (e.g. an option with no command)
 *
 * The engine is host-runtime-owned for execution (RD-2): this adapter never runs a command itself. In
 * an agent host (e.g. OpenClaw) the agent can execute the surfaced command; a plain bot shows it for
 * the operator to run. Either way, "advance" happens when the step verifies and a recompute re-renders.
 */

const PREFIX = 'ocesetup';
const SEP = '|';

/** Encode a button (action) custom_id. */
function customIdForAction(frame, actionId) {
  return [PREFIX, 'a', frame, actionId].join(SEP);
}

/** Encode a select (choice) custom_id. */
function customIdForChoice(frame, actionId) {
  return [PREFIX, 'c', frame, actionId].join(SEP);
}

/** Is this custom_id one of ours? (so the bot ignores unrelated interactions). */
function isOurs(customId) {
  return typeof customId === 'string' && customId.startsWith(`${PREFIX}${SEP}`);
}

/** Parse a custom_id into { kind:'action'|'choice', frame, actionId } or null if not ours/malformed. */
function parseCustomId(customId) {
  if (!isOurs(customId)) return null;
  const parts = String(customId).split(SEP);
  if (parts.length < 4) return null;
  const [, k, frame, ...rest] = parts;
  const actionId = rest.join(SEP); // action ids never contain SEP, but be tolerant
  if (k === 'a') return { kind: 'action', frame, actionId };
  if (k === 'c') return { kind: 'choice', frame, actionId };
  return null;
}

/** Find an action by id within a frame (tolerant). */
function findAction(frame, actionId) {
  return (frame && Array.isArray(frame.actions) ? frame.actions : []).find((a) => a.id === actionId) || null;
}

/**
 * Map an incoming interaction to an instruction. `frame` is the CURRENT frame the menu was rendered
 * from (the bot keeps it per-message or re-derives it); `interaction` is `{ customId, values? }`
 * (values = the selected option ids for a string-select).
 *
 * @param {object} frame        the frame the clicked menu was rendered from.
 * @param {object} interaction  { customId:string, values?:string[] }.
 * @returns {{kind:string, command?:string, note?:string, spends?:boolean, action?:object, option?:object}}
 */
function handleInteraction(frame, interaction = {}) {
  const parsed = parseCustomId(interaction.customId);
  if (!parsed) return { kind: 'noop', note: 'not a setup component' };

  const action = findAction(frame, parsed.actionId);
  if (!action) return { kind: 'recompute', note: 'stale menu — recomputing' };

  // A button.
  if (parsed.kind === 'action') {
    if (action.type === 'finish') return { kind: 'finish' };
    // verify re-checks the step; an explicit recompute-style action re-renders.
    if (action.type === 'verify') return { kind: 'show-command', command: action.command, note: 'Run this to re-check, then press the menu again.', action };
    if (action.command) return { kind: 'show-command', command: action.command, note: action.help || null, spends: Boolean(action.spends), action };
    return { kind: 'noop', note: action.help || 'nothing to run for this action' };
  }

  // A select (choice): the chosen option's command is what to run.
  const chosenId = Array.isArray(interaction.values) ? interaction.values[0] : undefined;
  if (!chosenId) return { kind: 'noop', note: 'no option chosen' };
  const option = (action.options || []).find((o) => o.id === chosenId) || null;
  if (!option) return { kind: 'recompute', note: 'unknown option — recomputing' };
  if (option.command) return { kind: 'show-command', command: option.command, note: option.help || null, spends: Boolean(option.spends), action, option };
  return { kind: 'noop', note: option.help || 'nothing to run for this option', action, option };
}

module.exports = {
  PREFIX,
  customIdForAction,
  customIdForChoice,
  isOurs,
  parseCustomId,
  handleInteraction,
};
