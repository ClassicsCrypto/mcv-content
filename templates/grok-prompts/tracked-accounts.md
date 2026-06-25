<!--
  templates/grok-prompts/tracked-accounts.md — the FREE manual-Grok prompt for suggesting accounts to
  TRACK on each trend pass (release-spec §8.8 trend tracking). Run on your own Grok/X account, then:
  engine suggest apply --file <paste.txt>   (adds to config/system.json → trends.tracked_accounts)
  Fill every <PLACEHOLDER> before running. Synthetic example only.
-->

# Grok prompt — suggest accounts to track (daily/hourly)

Copy the box, fill the `<PLACEHOLDERS>`, run it on **grok.com** or **X with Grok**, then paste the
reply into `engine suggest apply`.

```text
You are a social-listening strategist. Use your live access to current X/Twitter data.

MY BRAND: <BRAND NAME> (@<MY_HANDLE>)
INDUSTRY / CATEGORY: <e.g. web3 gaming, indie skincare, dev tools>
WHY I'M TRACKING: I want to watch what the most relevant voices in my space post each day so my
content can respond to the conversation quickly.

TASK: Recommend 8–15 ACTIVE X accounts worth tracking daily for my brand. Include a mix of:
  - direct competitors / comparators,
  - the most influential CONTENT CREATORS in the industry,
  - key MEDIA / NEWS accounts and respected ANALYSTS in the space.
Prefer accounts that post frequently and drive the conversation.

HARD RULES:
- Real, currently-active X accounts ONLY. If unsure an account is real and active, OMIT it.
- Tag each with a category: "competitor", "creator", "media", or "analyst".
- One short line on why it's worth tracking.

OUTPUT: Reply with ONLY a single fenced code block tagged `oce-suggestions`, this exact shape
(no prose outside the block):

```oce-suggestions
{
  "kind": "tracked_accounts",
  "items": [
    { "handle": "@examplecreator", "name": "Example Creator", "category": "creator", "why": "sets the agenda in this niche; high engagement" }
  ]
}
```
```

After you paste it back, the engine shows the proposed handles and adds them to
`config/system.json → trends.tracked_accounts` **only when you confirm** with `--yes`. The Apify trend
adapter then pulls these accounts' recent posts on your cadence (`1h`/`2h` hourly, `24h` daily).
