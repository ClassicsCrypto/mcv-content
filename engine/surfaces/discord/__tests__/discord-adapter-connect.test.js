'use strict';

/**
 * engine/surfaces/discord/__tests__/discord-adapter-connect.test.js  [N — daemon coverage]
 *
 * The discord-adapter normalizers are covered elsewhere; this file pins the live-daemon seam
 * (loadConfig + connect()). discord.js is an OPTIONAL, uninstalled dependency, required lazily
 * inside connect() — so a fake module is injected via a Module._load shim to drive the client
 * lifecycle and every event handler ZERO-KEY, with no real gateway connection.
 *
 * The bar (§15.1/§15.2 fail-fast): connect() fails fast + permanent on a missing token and on an
 * unbound content-review channel; once wired, reactions/buttons normalize → dispatch → core, the
 * channel binding is enforced, partial fetches are resolved, and callback/handler errors never
 * propagate out of the daemon.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const adapter = require('../discord-adapter.js');
const cv2 = require('../../../shared/components-v2.js');
const { CredentialMissingError } = require('../../../shared/secrets.js');

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oce-disc-'));
  return home;
}

/** A minimal fake discord.js whose Client records handlers + login calls for the test to drive. */
function makeFakeDiscord() {
  const Events = { ClientReady: 'ClientReady', MessageReactionAdd: 'MessageReactionAdd', InteractionCreate: 'InteractionCreate' };
  const GatewayIntentBits = { Guilds: 1, GuildMessages: 2, GuildMessageReactions: 4, MessageContent: 8 };
  const Partials = { Message: 'm', Reaction: 'r', User: 'u', Channel: 'c' };
  class Client {
    constructor(opts) { this.opts = opts; this.handlers = {}; this.loginCalls = []; }
    once(ev, cb) { this.handlers[ev] = cb; }
    on(ev, cb) { this.handlers[ev] = cb; }
    async login(token) { this.loginCalls.push(token); return token; }
  }
  return { Client, GatewayIntentBits, Partials, Events };
}

/** Run fn with `require('discord.js')` resolving to the fake module, then restore. */
async function withMockDiscord(fake, fn) {
  const orig = Module._load;
  Module._load = function patched(request, ...rest) {
    if (request === 'discord.js') return fake;
    return orig.call(this, request, ...rest);
  };
  try { return await fn(); } finally { Module._load = orig; }
}

/** Swallow stdout while driving the daemon (the daemon prints an online line + debug logs). */
async function quiet(fn) {
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = () => true;
  try { return await fn(); } finally { process.stdout.write = orig; }
}

// --- loadConfig ----------------------------------------------------------------------------

test('loadConfig reads the instance system.json, and falls back to {} when absent', () => {
  const home = tmpHome();
  fs.mkdirSync(path.join(home, 'config'), { recursive: true });
  fs.writeFileSync(path.join(home, 'config', 'system.json'), JSON.stringify({ mode: 'SAFE' }));
  assert.deepEqual(adapter.loadConfig({ CONTENT_HOME: home }), { mode: 'SAFE' });
  assert.deepEqual(adapter.loadConfig({ CONTENT_HOME: tmpHome() }), {});
});

// --- connect() fail-fast (these run BEFORE discord.js is required) --------------------------

test('connect() fails fast + permanent on a missing DISCORD_BOT_TOKEN', async () => {
  await assert.rejects(
    () => adapter.connect({ env: {}, config: { approval_surface: { channels: { 'content-review': 'CHAN1' } } } }),
    CredentialMissingError,
  );
});

test('connect() refuses when no content-review channel is bound', async () => {
  await assert.rejects(
    () => adapter.connect({ env: { DISCORD_BOT_TOKEN: 'tok' }, config: {} }),
    /content-review.*not set/s,
  );
});

// --- connect() live daemon (discord.js mocked) ---------------------------------------------

test('connect() wires the client and every handler dispatches through the core', async () => {
  const channelId = 'CHAN1';
  const env = { DISCORD_BOT_TOKEN: 'tok', CONTENT_HOME: tmpHome(), REACTION_LISTENER_DEBUG: '1', REACTION_LISTENER_DRY_RUN: '1' };
  const config = { approval_surface: { channels: { 'content-review': channelId } } };
  const fake = makeFakeDiscord();
  const emoji = Object.values(cv2.REACTION_EMOJI)[0];
  const verb = (cv2.CARD_ACTIONS || []).find((a) => a !== 'approve') || 'reject';

  const results = [];
  const onResult = (result, interaction) => { results.push({ outcome: result.outcome, action: interaction.action }); };

  await withMockDiscord(fake, async () => {
    const client = await adapter.connect({ env, config, onResult });
    assert.ok(client.loginCalls.includes('tok'), 'login called with the resolved token');

    await quiet(async () => {
      // ClientReady prints the online line.
      await client.handlers.ClientReady({ user: { tag: 'bot#9', id: '9' } });

      // Unrecognized emoji => normalizeReaction null => dispatch no-ops (no core call).
      await client.handlers.MessageReactionAdd(
        { partial: false, emoji: { name: '🤷' }, message: { partial: false, channelId, components: [], content: '' } },
        { partial: false, id: 'u1' },
      );

      // A reaction in another channel is ignored (binding enforced).
      await client.handlers.MessageReactionAdd(
        { partial: false, emoji: { name: emoji }, message: { partial: false, channelId: 'OTHER', components: [], content: '' } },
        { partial: false, id: 'u1' },
      );

      // A recognized emoji on the bound channel with partials => fetches resolve, core dispatches.
      let fetched = 0;
      await client.handlers.MessageReactionAdd(
        { partial: true, fetch: async () => { fetched++; }, emoji: { name: emoji }, message: { partial: true, fetch: async () => { fetched++; }, channelId, components: [], content: '' } },
        { partial: true, fetch: async () => { fetched++; }, id: 'u1' },
      );
      assert.equal(fetched, 3, 'partial reaction/message/user were all fetched');

      // A failed fetch is swallowed (the daemon never crashes the gateway loop).
      await client.handlers.MessageReactionAdd(
        { partial: true, fetch: async () => { throw new Error('net'); }, emoji: { name: emoji }, message: { channelId } },
        { partial: false, id: 'u1' },
      );

      // Non-button interactions are ignored.
      await client.handlers.InteractionCreate({ isButton: () => false });
      // A button outside the bound channel is ignored.
      await client.handlers.InteractionCreate({ isButton: () => true, channelId: 'OTHER' });

      // A button on the bound channel acks ephemerally and edits the reply with the outcome.
      const it = {
        isButton: () => true,
        channelId,
        customId: `${cv2.CUSTOM_ID_NS}:${verb}:c123`,
        user: { id: 'u1' },
        message: { components: [], content: '', id: 'm1' },
        deferred: false,
        replied: false,
      };
      it.deferReply = async () => { it.deferred = true; };
      let edited = null;
      it.editReply = async (msg) => { edited = msg; };
      await client.handlers.InteractionCreate(it);
      assert.ok(edited && /Captured/.test(edited), 'the button interaction was acknowledged with an outcome');

      // Transport error handlers are wired and swallow their errors.
      client.handlers.error(new Error('boom'));
      client.handlers.shardError(new Error('shard'));
    });

    // The recognized reaction + the button each dispatched a result through the core.
    assert.ok(results.length >= 2, 'core dispatched for the recognized reaction and the button');
    assert.ok(results.some((r) => r.action === verb), 'the button action reached the core');
  });
});

test('connect() dispatch swallows an onResult callback error', async () => {
  const channelId = 'CHAN1';
  const env = { DISCORD_BOT_TOKEN: 'tok', CONTENT_HOME: tmpHome() };
  const config = { approval_surface: { channels: { 'content-review': channelId } } };
  const fake = makeFakeDiscord();
  const emoji = Object.values(cv2.REACTION_EMOJI)[0];

  await withMockDiscord(fake, async () => {
    const client = await adapter.connect({ env, config, onResult: () => { throw new Error('callback blew up'); } });
    // The thrown callback must NOT propagate out of the handler.
    await quiet(() => client.handlers.MessageReactionAdd(
      { partial: false, emoji: { name: emoji }, message: { partial: false, channelId, components: [], content: '' } },
      { partial: false, id: 'u1' },
    ));
  });
});
