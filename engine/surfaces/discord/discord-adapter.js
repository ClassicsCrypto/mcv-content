'use strict';

/**
 * engine/surfaces/discord/discord-adapter.js  [E extracted]
 *
 * The DISCORD reference approval surface (release-spec §12.4 approval-surface abstraction, DD-10;
 * §7.5 card / §7.6 decision). This is the v1 reference implementation behind the surface-neutral
 * card + decision schemas — it owns ALL Discord-specific I/O (a discord.js client, button
 * interactions, emoji reactions, channel bindings, message snowflakes) and translates every
 * inbound control into the NORMALIZED interaction the surface-neutral core
 * (engine/orchestrator/reaction-listener.js) consumes. A future Slack-class surface implements
 * the same `normalize* → processInteraction` shape and reuses the core unchanged.
 *
 * What lives HERE (surface detail, never in the core):
 *   - the discord.js client + gateway intents + the daemon lifecycle (loud startup, fail-fast
 *     auth — the token-rotation crash-loop counter-example, §15.1/§15.2).
 *   - the canonical reaction-emoji ↔ action verb mapping (REFERENCE detail; the load-bearing
 *     contract is the action verb, not emoji order — §12.4). Reaction-only clients still get the
 *     full bounded action set this way.
 *   - the approval-control custom-id parse (`<NS>:<action>:<variant?>:<contentId>`, the shared
 *     components-v2 namespace) → action verb + variant + content id.
 *   - content-id recovery from a live Components-v2 card (components-v2 walkers), the channel-
 *     binding check (only the configured content-review channel), and surface acks/replies.
 *
 * What it does NOT do: authorize reviewers, build decisions, run the re-gate, or write the
 * queue — those are the core's job (semantics live in the schema + core, §12.4). The adapter
 * resolves the surface-specific `reviewer_id`/`content_id`/`card_ref` and hands a neutral object
 * to `processInteraction`.
 *
 * Token: DISCORD_BOT_TOKEN via engine/shared/secrets.js ONLY (the single $CONTENT_HOME/.env
 * resolver; never a hardcoded path or value — §4.4). Channel bindings: config/system.json
 * `approval_surface.channels` (Tier-3, operator-supplied — no hardcoded snowflake, §1 per-path
 * rule). discord.js is required LAZILY inside connect() so this module loads (and its
 * normalization is unit-testable) without the optional client dependency installed.
 *
 * Flags (documented diagnostic overrides, fail-closed defaults — §4.5):
 *   REACTION_LISTENER_DRY_RUN=1  the core records the decision but writes no queue + the adapter
 *                                sends no surface message.
 *   REACTION_LISTENER_DEBUG=1    verbose adapter logging.
 */

const core = require('../../orchestrator/reaction-listener.js');
const cv2 = require('../../shared/components-v2.js');
const paths = require('../../shared/paths.js');
const { requireSecret } = require('../../shared/secrets.js');

const fs = require('fs');

// ---------------------------------------------------------------------------
// Reaction-emoji ↔ action verb (REFERENCE detail — §12.4: not the load-bearing contract)
// ---------------------------------------------------------------------------

// Normalize a Discord emoji name for comparison: NFKC fold + strip the variation selector
// (U+FE0F) so '🅰️' and '🅰' compare equal (the production mojibake-resistance fix).
function normalizeEmoji(value) {
  return String(value || '').normalize('NFKC').replace(/️/gu, '');
}

// Build the emoji→action map from the shared, surface-neutral REACTION_EMOJI table so the
// adapter never re-declares the canonical set. approve_a/approve_b map their emoji to the
// variant-specific approve action.
const EMOJI_TO_ACTION = (() => {
  const map = new Map();
  for (const [action, emoji] of Object.entries(cv2.REACTION_EMOJI)) {
    map.set(normalizeEmoji(emoji), action);
  }
  return map;
})();

function actionForEmoji(emojiName) {
  return EMOJI_TO_ACTION.get(normalizeEmoji(emojiName)) || null;
}

// ---------------------------------------------------------------------------
// Approval-control custom-id parse (shared components-v2 namespace)
// ---------------------------------------------------------------------------

// `<NS>:<action>:<variant?>:<contentId>` (cv2.buttonCustomId). The variant segment is present
// only for approve; the trailing segment(s) are the content id (which may itself contain ':').
function parseApprovalCustomId(customId) {
  const parts = String(customId || '').split(':');
  if (parts[0] !== cv2.CUSTOM_ID_NS) return null;
  const verb = parts[1] || '';
  if (verb === 'approve') {
    const variant = parts[2] || 'recommended';
    const contentId = parts.slice(3).join(':') || null;
    const action = variant === 'a' ? 'approve_a' : variant === 'b' ? 'approve_b' : 'approve_recommended';
    return { action, selected_variant: variant, content_id: contentId };
  }
  // Non-approve verbs (edit / attach_media / reject) carry no variant segment.
  if (cv2.CARD_ACTIONS.includes(verb)) {
    const contentId = parts.slice(2).join(':') || null;
    return { action: verb, content_id: contentId };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Content-id recovery from a live Components-v2 card
// ---------------------------------------------------------------------------

// Prefer the card's components (the metadata "Content ID:" line cv2 writes), fall back to plain
// message content. Surface-specific recovery; the core only ever sees the resolved id.
function resolveContentIdFromMessage(message) {
  if (!message) return null;
  const fromComponents = cv2.findContentId(message.components || []);
  if (fromComponents) return fromComponents;
  const m = String(message.content || '').match(cv2.CONTENT_ID_RE);
  return m ? m[1].trim() : null;
}

// ---------------------------------------------------------------------------
// Normalizers — Discord control → neutral interaction
// ---------------------------------------------------------------------------

/**
 * Normalize a Discord reaction event into a neutral interaction (or null to ignore). Does NOT
 * authorize — the core does (DD-17). content_id is recovered from the reacted-to card.
 */
function normalizeReaction({ emojiName, userId, message, cardRef }) {
  const action = actionForEmoji(emojiName);
  if (!action) return null;
  const contentId = resolveContentIdFromMessage(message);
  const out = {
    surface: 'discord',
    reviewer_id: userId,
    action,
    content_id: contentId,
    card_ref: cardRef || (message && message.id ? String(message.id) : null),
  };
  if (action in core.APPROVE_VARIANT) out.selected_variant = core.APPROVE_VARIANT[action];
  return out;
}

/**
 * Normalize a Discord button interaction into a neutral interaction (or null to ignore). The
 * content id comes from the custom-id (authoritative), falling back to the card body.
 */
function normalizeButton({ customId, userId, message, cardRef }) {
  const parsed = parseApprovalCustomId(customId);
  if (!parsed) return null;
  const contentId = parsed.content_id || resolveContentIdFromMessage(message);
  const out = {
    surface: 'discord',
    reviewer_id: userId,
    action: parsed.action,
    content_id: contentId,
    card_ref: cardRef || (message && message.id ? String(message.id) : null),
  };
  if (parsed.selected_variant) out.selected_variant = parsed.selected_variant;
  return out;
}

// ---------------------------------------------------------------------------
// Config (channel bindings) + secrets (token)
// ---------------------------------------------------------------------------

function loadConfig(env = process.env) {
  try {
    return JSON.parse(fs.readFileSync(paths.systemConfig(env), 'utf8'));
  } catch {
    return {};
  }
}

/** The configured content-review channel id (the only channel the daemon acts in). */
function reviewChannelId(config) {
  const channels = (config && config.approval_surface && config.approval_surface.channels) || {};
  return channels['content-review'] || null;
}

// ---------------------------------------------------------------------------
// Daemon (the live Discord client) — lazily binds discord.js
// ---------------------------------------------------------------------------

function debugLog(enabled, msg) {
  if (enabled) process.stdout.write(`[discord-adapter] ${msg}\n`);
}

/**
 * Connect the live Discord approval surface. discord.js is required lazily here so the module
 * (and its normalizers) load with no client dependency installed. The token is resolved by NAME
 * via secrets.js; a missing token throws CredentialMissingError (fail-fast, permanent — no
 * retry loop; the token-rotation crash-loop counter-example, §15.1/§15.2). Channel bindings come
 * from config; the daemon ignores anything outside the configured content-review channel.
 *
 * @param {object} [opts]
 *   @param {object} [opts.env]      environment (default process.env).
 *   @param {object} [opts.config]   pre-loaded system config (default read from $CONTENT_HOME).
 *   @param {function}[opts.onResult] callback(result, interaction) after each core decision.
 * @returns {Promise<object>} the live discord.js client.
 */
async function connect(opts = {}) {
  const env = opts.env || process.env;
  const config = opts.config || loadConfig(env);
  const debug = env.REACTION_LISTENER_DEBUG === '1';
  const dryRun = env.REACTION_LISTENER_DRY_RUN === '1';

  // Fail fast + permanent on a missing token (NAMES the variable + consumer, never the value).
  const token = requireSecret('DISCORD_BOT_TOKEN', 'approval-surface adapter (discord)', env);

  const channelId = reviewChannelId(config);
  if (!channelId) {
    throw new Error(
      'approval_surface.channels."content-review" is not set in config/system.json; the Discord ' +
        'approval surface has no channel to watch. Bind it during setup (release-spec §11.2).',
    );
  }

  // Lazy require — keeps discord.js optional for everything except a live connection.
  // eslint-disable-next-line global-require
  const { Client, GatewayIntentBits, Partials, Events } = require('discord.js');

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Message, Partials.Reaction, Partials.User, Partials.Channel],
  });

  const dispatch = async (interaction, surfaceMessage) => {
    if (!interaction) return null;
    const result = core.processInteraction(interaction, { env, config });
    debugLog(debug, `${interaction.action} ${interaction.content_id || '?'} → ${result.outcome}`);
    if (typeof opts.onResult === 'function') {
      try { await opts.onResult(result, interaction, surfaceMessage); } catch (e) { debugLog(debug, `onResult error: ${e.message}`); }
    }
    return result;
  };

  client.once(Events.ClientReady, (c) => {
    process.stdout.write(
      `[discord-adapter] ONLINE as ${c.user.tag} (id ${c.user.id}); watching content-review channel ${channelId}; DRY_RUN=${dryRun}\n`,
    );
  });

  client.on(Events.MessageReactionAdd, async (reaction, user) => {
    try {
      if (reaction.partial) await reaction.fetch();
      if (reaction.message && reaction.message.partial) await reaction.message.fetch();
      if (user.partial) await user.fetch();
    } catch (e) { debugLog(debug, `reaction fetch error: ${e.message}`); return; }
    if (reaction.message.channelId !== channelId) return;
    const interaction = normalizeReaction({
      emojiName: reaction.emoji && reaction.emoji.name,
      userId: user.id,
      message: reaction.message,
    });
    await dispatch(interaction, reaction.message);
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isButton || !interaction.isButton()) return;
    if (interaction.channelId !== channelId) return;
    const neutral = normalizeButton({
      customId: interaction.customId,
      userId: interaction.user && interaction.user.id,
      message: interaction.message,
    });
    // Acknowledge ephemerally so the control doesn't time out; the core does the real work.
    try { if (!interaction.deferred && !interaction.replied) await interaction.deferReply({ ephemeral: true }); } catch {}
    const result = await dispatch(neutral, interaction.message);
    try {
      if (result && (interaction.deferred || interaction.replied)) {
        await interaction.editReply(`Captured ${neutral ? neutral.action : 'action'} → ${result.outcome}.`);
      }
    } catch (e) { debugLog(debug, `button ack error: ${e.message}`); }
  });

  client.on('error', (err) => debugLog(debug, `client error: ${err.message}`));
  client.on('shardError', (err) => debugLog(debug, `shard error: ${err.message}`));

  await client.login(token);
  return client;
}

module.exports = {
  // normalizers (surface → neutral) — the testable seam
  normalizeReaction,
  normalizeButton,
  parseApprovalCustomId,
  actionForEmoji,
  normalizeEmoji,
  resolveContentIdFromMessage,
  reviewChannelId,
  loadConfig,
  // live daemon
  connect,
  // constants
  EMOJI_TO_ACTION,
};
