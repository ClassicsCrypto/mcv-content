<!--
  templates/grok-prompts/breakout-discovery.md — the FREE manual-Grok prompt for the MONTHLY breakout
  discovery pass (release-spec §1.2 / §8.8): find NEW competitors that have emerged and breakout
  long-term keyword trends. Run on your own Grok/X account, then:
  engine suggest apply --file <paste.txt> --brand <id>
  (keyword terms → trends.keywords; new-competitor handles → brand.json ingestion.competitors)
  Fill every <PLACEHOLDER> before running. Synthetic example only.
-->

# Grok prompt — monthly breakout discovery (new competitors + breakout trends)

Run this **monthly**. Copy the box, fill the `<PLACEHOLDERS>`, run it on **grok.com** or **X with
Grok**, then paste the reply into `engine suggest apply --brand <id>`.

```text
You are a strategic-foresight analyst. Use your live access to current X/Twitter data, with a focus
on the LAST 30–90 DAYS versus the prior period.

MY BRAND: <BRAND NAME> (@<MY_HANDLE>)
WHAT WE DO: <ONE OR TWO SENTENCES>
INDUSTRY / CATEGORY: <e.g. web3 gaming, indie skincare, dev tools>
ALREADY TRACKING: <comma-separated handles/keywords I already watch — so you suggest only NEW ones>

TASK: Surface what has CHANGED in my space over the last 30–90 days that I am probably not yet
tracking:
  1. NEW or fast-rising competitor/comparator accounts that have broken out recently.
  2. BREAKOUT keywords/hashtags/topics that are trending UP over the period (durable shifts, not
     one-day spikes).

HARD RULES:
- Real, currently-active accounts and real in-use terms ONLY. If unsure, OMIT it.
- Exclude anything in "ALREADY TRACKING".
- For each, give a one-line "signal" describing the breakout (e.g. "follower/engagement up sharply
  over 60 days", "mentions tripled this month").

OUTPUT: Reply with ONLY a single fenced code block tagged `oce-suggestions`, this exact shape
(handle-bearing items are new competitors; term-bearing items are breakout keywords):

```oce-suggestions
{
  "kind": "breakout",
  "brand": "<MY_BRAND_ID>",
  "items": [
    { "handle": "@newentrant", "name": "New Entrant", "category": "competitor", "signal": "broke out this quarter; engagement up sharply", "why": "emerging direct competitor" },
    { "term": "#emergingtopic", "signal": "mentions tripled over 60 days", "why": "durable upward trend in our category" }
  ]
}
```
```

After you paste it back, the engine shows the proposal and (on `--yes`) APPENDS breakout keywords to
`trends.keywords` and new-competitor handles to `brands/<id>/brand.json → ingestion.competitors` —
deduped against what you already track. You confirm before anything is written.
