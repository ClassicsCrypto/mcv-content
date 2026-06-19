#!/usr/bin/env node
'use strict';

/**
 * adapters/discord/bot-example.js  [N net-new — reference adapter RUNNER, run-it-yourself]
 *
 * A minimal, runnable reference that puts `engine setup` behind a Discord `/startup` command as the
 * "changing menu" of buttons. It is the ONLY file here that talks to Discord, and it LAZILY requires
 * discord.js so the engine stays zero-dependency: nothing in the engine's CI imports this file.
 *
 *   1) Auto-detects the bot token from the environment (DISCORD_BOT_TOKEN). If the host runtime
 *      already owns the Discord connector (e.g. OpenClaw), wire `/startup` into THAT bot instead and
 *      reuse render.js + route.js directly — you do not need this runner.
 *   2) Reads the current setup FRAME by shelling `node <engine>/bin/engine.js setup --json`
 *      (the engine is the source of truth; this adapter renders, it never re-implements setup).
 *   3) Renders the frame as an embed + buttons/select (render.frameToMessage) and, on a click, routes
 *      it (route.handleInteraction) into: re-render, or show the exact command to run (the operator/
 *      agent runs it — the engine is host-runtime-owned for execution), or finish.
 *
 * Run it yourself (NOT part of the engine):
 *     cd adapters/discord && npm init -y && npm i discord.js
 *     DISCORD_BOT_TOKEN=... DISCORD_APP_ID=... CONTENT_HOME=/path/to/instance \
 *       node bot-example.js
 *
 * This file is intentionally dependency-tolerant: if discord.js is absent it prints install guidance
 * and exits 0, so importing/checking it never crashes a zero-dep environment.
 */

const path = require('path');
const { spawnSync } = require('child_process');

const render = require('./render');
const route = require('./route');

const ENGINE_BIN = path.resolve(__dirname, '..', '..', 'bin', 'engine.js');

/** Auto-detect the bot token (the host's). Returns null when not present. */
function detectToken(env = process.env) {
  return env.DISCORD_BOT_TOKEN || env.BOT_TOKEN || null;
}

/** Run `engine setup --json` and return the parsed frame (the engine is the source of truth). */
function currentFrame(env = process.env) {
  const res = spawnSync(process.execPath, [ENGINE_BIN, 'setup', '--json'], { encoding: 'utf8', env });
  if (res.status !== 0 && !res.stdout) {
    throw new Error(`engine setup failed: ${(res.stderr || '').trim() || `exit ${res.status}`}`);
  }
  return JSON.parse(res.stdout);
}

/** Build the ephemeral reply text for a show-command instruction. */
function commandReply(instruction) {
  const lines = [];
  if (instruction.spends) lines.push('⚠️ **This step costs money (metered).** You confirm the estimate yourself before any spend.');
  if (instruction.note) lines.push(instruction.note);
  lines.push('Run this, then press a button again to refresh the menu:');
  lines.push('```\n' + (instruction.command || '(no command)') + '\n```');
  return lines.join('\n');
}

async function main() {
  const token = detectToken();
  if (!token) {
    process.stdout.write(
      'No bot token found. Set DISCORD_BOT_TOKEN (the host runtime owns the Discord connector).\n'
      + 'If you use OpenClaw or another bot, wire /startup into it and reuse render.js + route.js directly.\n',
    );
    return 0;
  }

  let Discord;
  try {
    // Lazy: keeps the engine zero-dep. `npm i discord.js` in this folder to enable the runner.
    // eslint-disable-next-line global-require, import/no-unresolved
    Discord = require('discord.js');
  } catch {
    process.stdout.write('discord.js is not installed. Run: cd adapters/discord && npm i discord.js\n');
    return 0;
  }

  const { Client, GatewayIntentBits, REST, Routes } = Discord;
  const appId = process.env.DISCORD_APP_ID;
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  // Register the /startup command (global; for fast iteration register per-guild with DISCORD_GUILD_ID).
  if (appId) {
    const rest = new REST({ version: '10' }).setToken(token);
    const body = [{ name: 'startup', description: 'Guided setup for the open-content-engine' }];
    const routeId = process.env.DISCORD_GUILD_ID
      ? Routes.applicationGuildCommands(appId, process.env.DISCORD_GUILD_ID)
      : Routes.applicationCommands(appId);
    await rest.put(routeId, { body });
  }

  client.on('interactionCreate', async (interaction) => {
    try {
      if (interaction.isChatInputCommand && interaction.isChatInputCommand() && interaction.commandName === 'startup') {
        const frame = currentFrame();
        await interaction.reply({ ...render.frameToMessage(frame), ephemeral: true });
        return;
      }
      if ((interaction.isButton && interaction.isButton()) || (interaction.isStringSelectMenu && interaction.isStringSelectMenu())) {
        if (!route.isOurs(interaction.customId)) return;
        const frame = currentFrame(); // engine is the source of truth; route against the live frame
        const values = interaction.isStringSelectMenu && interaction.isStringSelectMenu() ? interaction.values : undefined;
        const instr = route.handleInteraction(frame, { customId: interaction.customId, values });
        if (instr.kind === 'recompute') {
          await interaction.update(render.frameToMessage(currentFrame()));
        } else if (instr.kind === 'finish') {
          await interaction.reply({ content: '🎉 Setup is complete — your engine is operational.', ephemeral: true });
        } else if (instr.kind === 'show-command') {
          await interaction.reply({ content: commandReply(instr), ephemeral: true });
        } else {
          await interaction.reply({ content: instr.note || 'Nothing to do.', ephemeral: true });
        }
      }
    } catch (err) {
      try { await interaction.reply({ content: `Setup error: ${err.message}`, ephemeral: true }); } catch { /* already replied */ }
    }
  });

  client.once('ready', () => process.stdout.write(`setup adapter ready as ${client.user.tag}\n`));
  await client.login(token);
  return 0;
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code || 0; }).catch((err) => {
    process.stderr.write(`${err && err.message ? err.message : err}\n`);
    process.exitCode = 1;
  });
}

module.exports = { detectToken, currentFrame, commandReply };
