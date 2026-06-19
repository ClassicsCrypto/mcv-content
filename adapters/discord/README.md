# Discord setup adapter (reference)

Put **`engine setup`** behind a Discord **`/startup`** command — the same guided, strict, resumable
flow as the CLI, rendered as a **changing menu of buttons** an operator clicks through.

This is a **reference adapter**. It exists so any host runtime can render the setup flow as Discord
components without the engine ever owning a Discord connection or bot token. The engine emits a
**frame** (`engine setup --json`, the published contract at
`../../schemas/artifacts/setup-frame.schema.json`); this adapter renders that frame and routes clicks
back to the engine. One brain, two surfaces.

## What's here

| File | Dependency-free? | Role |
|---|---|---|
| `render.js` | ✅ yes | frame → Discord message (`{ embeds, components }`) — buttons + select menus, Discord limits honored |
| `route.js` | ✅ yes | encode/decode component `custom_id`; map a click → a `engine setup` instruction |
| `index.js` | ✅ yes | the public surface (re-exports render + route) — **import this** to build your own bot |
| `bot-example.js` | ⚠️ lazily needs `discord.js` | a runnable reference bot: `/startup`, auto-detects the token, shells the engine, wires clicks |

`render.js` / `route.js` / `index.js` import **nothing outside the standard library**, so they add no
dependency to the engine and are covered by the engine's zero-dep CI
(`tests/discord-adapter.test.js`). Only `bot-example.js` touches `discord.js`, and it requires it
**lazily** — nothing in CI imports it.

## Use it in your own bot (recommended)

If your host runtime already owns the Discord connector (e.g. **OpenClaw**), don't run a second bot —
wire `/startup` into the bot you already have and reuse the dependency-free core:

```js
const setupAdapter = require('open-content-engine/adapters/discord'); // render + route
const { execFileSync } = require('child_process');

function frame() {
  return JSON.parse(execFileSync('node', ['bin/engine.js', 'setup', '--json'], { encoding: 'utf8' }));
}

// on /startup:
const msg = setupAdapter.frameToMessage(frame());           // { embeds, components }
// reply with msg (ephemeral is nice)

// on a button / select interaction:
const instr = setupAdapter.handleInteraction(frame(), { customId, values });
// instr.kind ∈ 'recompute' | 'show-command' | 'finish' | 'noop'
//  recompute    → re-render setupAdapter.frameToMessage(frame())
//  show-command → reply with instr.command (the operator/agent runs it; instr.spends flags a metered step)
//  finish       → setup is complete
```

**Token auto-detection.** `route.isOurs(customId)` lets you ignore unrelated interactions, and
`bot-example.detectToken()` reads `DISCORD_BOT_TOKEN`. The engine never reads or stores the token —
your bot does.

## Run the example bot standalone

```
cd adapters/discord
npm init -y && npm i discord.js
DISCORD_BOT_TOKEN=... DISCORD_APP_ID=... CONTENT_HOME=/path/to/instance node bot-example.js
```

(Optional `DISCORD_GUILD_ID` registers `/startup` to one guild for fast iteration.)

## How the menu behaves

- **Buttons** = run / verify / finish actions; **select menus** = the choices (content source, store
  mode, library, media models). Metered actions/options are flagged (`$`, danger-styled) — the engine
  **never auto-spends behind a button**; clicking surfaces the command and the estimate-and-confirm gate.
- Clicking an action **shows the exact command** to run. In an agent host (OpenClaw), the agent can run
  it; in a plain bot, the operator runs it. Either way the step **advances when it verifies** — press a
  button again (or `/startup`) and the menu **recomputes** to the next step.
- The flow is **strict and resumable**: it never surfaces a later step until the current one verifies,
  and it picks up exactly where you left off.

## Security

The engine stays host-runtime-owned for the Discord connection and for command execution (RD-2): this
adapter **renders and routes only**, and never runs a command itself. The frame carries **no secrets**
(media-model detection surfaces an env-var *name*, never a value). Keep the bot's permissions minimal.
