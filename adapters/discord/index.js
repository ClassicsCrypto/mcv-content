'use strict';

/**
 * adapters/discord/index.js  [N net-new — reference adapter]
 *
 * The DEPENDENCY-FREE public surface of the reference Discord adapter: it turns the engine's setup
 * FRAME (the published contract emitted by `engine setup --json`) into a Discord message of buttons +
 * select menus (render.js) and routes a clicked component back into a `engine setup` instruction
 * (route.js). It imports NOTHING outside the standard library, so it is unit-testable in the engine's
 * zero-dep CI and adds no dependency to the engine.
 *
 * The runnable gateway bot (which connects to Discord, auto-detects the bot token, registers
 * `/startup`, and executes/relays the surfaced commands) lives in bot-example.js and lazily requires
 * discord.js — run-it-yourself, never imported here or by tests. See README.md.
 */

const render = require('./render');
const route = require('./route');

module.exports = {
  // frame → Discord message payload { embeds, components }
  frameToMessage: render.frameToMessage,
  buildEmbed: render.buildEmbed,
  // interaction routing (custom_id encode/decode + click → instruction)
  customIdForAction: route.customIdForAction,
  customIdForChoice: route.customIdForChoice,
  isOurs: route.isOurs,
  parseCustomId: route.parseCustomId,
  handleInteraction: route.handleInteraction,
};
