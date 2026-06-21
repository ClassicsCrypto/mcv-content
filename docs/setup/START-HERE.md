# Start here 👋

New to this? You're in the right place. This page gets the engine **running on your computer** with
no setup pain, then points you to the easiest way to finish. **No experience needed — if you can copy
and paste, you can do this.**

**What is this, in one sentence?** It helps an AI assistant write social-media posts for a brand —
with one strict rule: **a human approves everything, and nothing ever posts or spends money on its
own.**

**How long?** About **10–15 minutes** to see it working. Finishing the full setup takes longer and is
easiest with an AI assistant (shown below).

---

## What you need first

Three things. The first two are free programs; the third is optional but makes setup much easier.

1. **Node.js, version 22 or newer** — the program that runs this engine.
   - Get it at <https://nodejs.org> → download the **LTS** version → run the installer → click *Next*
     until it finishes.
   - Check it worked: open a terminal (below) and type `node --version`. You should see `v22` or
     higher.
2. **Git** — the tool that downloads the code.
   - Get it at <https://git-scm.com/downloads> → install with the defaults.
   - Check: `git --version` should print a version number.
3. **(Optional, recommended) an AI coding assistant** — like Claude Code, Cursor, or OpenClaw. This is
   the "easy button" for finishing setup (see Step 3).

> **What's a terminal?** It's just a window where you type commands.
> On **Windows**: press Start, type **PowerShell**, press Enter.
> On **Mac**: press Cmd+Space, type **Terminal**, press Enter.

---

## Step 1 — download the code (about 2 minutes)

On this project's GitHub page, click the green **Code** button and copy the web address (URL). Then in
your terminal, paste this — swap `<repo-url>` for the address you copied:

```
git clone <repo-url>
```

Then go into the folder it created (it will tell you the name — something like `cd the-folder-name`):

```
cd <the-folder-it-created>
```

`git clone` just downloads a copy of the project. `cd` means "go into that folder."

---

## Step 2 — prove it works (about 2 minutes — no accounts, no cost) ✅

Type these two commands, one at a time:

```
npm ci
node bin/engine.js fixture-run
```

- `npm ci` installs the small set of helper packages the engine needs. (Lots of text will scroll by —
  that's normal.)
- `node bin/engine.js fixture-run` runs the **entire engine**, start to finish, on pretend data.

When it finishes you should see a line like this:

```
[OK] fixture-run PASSED — deterministic spine green end-to-end; mock approval card produced (zero keys)
```

🎉 **That's it — the engine works on your computer.** It just ran the whole pipeline on fake data with
**no internet, no accounts, and no money spent.** This is the single most important check, and you
just passed it.

*(No green `PASSED` line? Jump to [If something goes wrong](#if-something-goes-wrong) at the bottom —
it's almost always a missing or outdated Node install.)*

---

## Step 3 — finish setup (pick the easy way)

This engine is **designed to be set up and run by an AI assistant**, with you answering simple
questions. Two choices:

### 🟢 The easy way (recommended): let an AI assistant do it

1. Open this project folder in an AI coding assistant — **Claude Code**, **Cursor**, **OpenClaw**, or
   similar.
2. Copy the prompt below and paste it as your **first message**:

```
You are helping me set up the open-content-engine that's open in this folder.
This is MY own fresh copy; it isn't connected to anything yet.

Please get it running, then help me operate it — but never post anything, spend
any money, or take any outside action without asking me first.

Do this in order:
1. Read agent.md fully — it's the step-by-step guide written for you. Then skim
   README.md and docs/setup/quick-start.md.
2. Run the zero-key proof first: npm ci, then node bin/engine.js fixture-run.
   Do not go further until that passes.
3. Walk me through setup one checkpoint at a time (C0 to C4). Whenever you need a
   secret, an ID, a brand fact, or a decision, STOP and ask me in plain language —
   never guess or make anything up.
   If I do not have brand files ready but I have provided a downloaded corpus,
   offer to deduce provisional brand facts, voice rules, competitors, and
   per-brand content priorities from that corpus, then ask me to confirm or
   correct them before using them.
4. Keep it in SAFE mode (draft-only) the whole time. Before anything that costs
   money, show me the estimated cost and wait for me to say yes.

Start by reading agent.md, then tell me in simple terms what you'll do and what
you'll need from me.
```

3. The assistant reads the guide and walks you through, asking things like *"what's your brand?"*,
   *"where are your assets?"*, *"who approves posts?"* Answer in plain words. **It pauses and asks
   before anything risky.**

That's the whole easy path — you mostly just answer questions.

### 🔧 The do-it-yourself way

Prefer to do it by hand (or read along)? Follow the command-by-command guide:
**[`quick-start.md`](quick-start.md)**. For every detail and check, see
**[`full-setup.md`](full-setup.md)**.

---

## The safety promise (why you can relax)

This system is built so it **can't surprise you**:

- 🛑 **Nothing posts by itself.** Every post waits for a human to approve it — and even after you
  approve, it's saved as a **draft** that you publish yourself.
- 💵 **Nothing spends money without a "yes".** Anything that costs money shows you an estimate first
  and won't run until you confirm.
- 🔒 **Your secrets stay put.** Passwords and keys live in one file on your computer, never in the
  shared code.
- 🧪 **You start in "SAFE mode."** In SAFE mode it *cannot publish at all*. That's the default.

---

## Words you'll see (in plain English)

- **Engine** — the program in this folder that does the bookkeeping (scheduling, checking, saving). It
  does **not** write the posts itself.
- **Seat** — one role an AI plays on the assembly line (for example: the writer, the editor, the
  fact-checker). Your AI assistant fills these roles.
- **The chain** — the assembly line of seats that turns an idea into a finished draft.
- **Approval card** — a short summary of a finished post that shows up for a human to approve or
  reject (usually in Discord).
- **The gate** — the automatic quality and safety checks every draft must pass *before* a human even
  sees it.
- **The double gate** — the two human checkpoints: (1) a person approves, (2) a person publishes.
  "Approved" is **not** the same as "posted."
- **SAFE / LIVE_PREVIEW / LIVE** — the three modes. **SAFE** can't publish (the default).
  **LIVE_PREVIEW** makes real approval cards but still can't publish. **LIVE** can publish (drafts you
  push out).
- **CONTENT_HOME** — a folder **outside** the code where your settings, secrets, and saved work live.
  Keeping it separate means you can never accidentally upload your secrets.
- **Host runtime** — the AI tool you use to run the seats (Claude Code, OpenClaw, etc.). The engine
  borrows its AI; it has none of its own.
- **Brand DNA** — a short description of a brand's voice and facts, so the AI writes in the right
  style.
- **Calibration** — a quick first test run that proves the AI writes on-brand before you rely on it.
- **Postiz** — an optional tool for actually posting to social media. You don't need it until the very
  end.

---

## If something goes wrong

| You see… | What it means | What to do |
|---|---|---|
| `node: command not found` or `git: command not found` | Node or Git isn't installed (or the terminal needs reopening) | Install it from the links in **What you need first**, then **close and reopen** the terminal. |
| `npm ci` complains about a version | Your Node is older than v22 | Install the newest Node **LTS**, reopen the terminal, and try again. |
| `fixture-run` didn't say `PASSED` | Usually the install didn't finish | Run `npm ci` again, then `node bin/engine.js fixture-run` again. |
| "refuses a `CONTENT_HOME` inside the checkout" | You pointed your settings folder *inside* the code folder | Pick a folder **outside** the project for `CONTENT_HOME` (your home folder is fine). |
| `✗ discord_token` (later, during setup) | The engine can't reach Discord yet | Connect your AI tool's Discord, or add a `DISCORD_BOT_TOKEN` — your AI assistant will guide you. |

Still stuck? The complete guide is [`full-setup.md`](full-setup.md), and
[`../architecture.md`](../architecture.md) shows how the whole thing fits together.

---

## Where to go next

- **[`quick-start.md`](quick-start.md)** — the short command-by-command setup.
- **[`full-setup.md`](full-setup.md)** — every checkpoint and check, in full.
- **[`../../agent.md`](../../agent.md)** — the guide your AI assistant follows (point your assistant
  here).
- **[`../architecture.md`](../architecture.md)** — how the whole system fits together.

You've got this. 🚀
