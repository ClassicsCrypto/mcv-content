<!--
  templates/grok-prompts/keywords.md — the FREE manual-Grok prompt for suggesting keywords/hashtags to
  TRACK on each trend pass (release-spec §8.8). Run on your own Grok/X account, then:
  engine suggest apply --file <paste.txt>   (adds to config/system.json → trends.keywords)
  Fill every <PLACEHOLDER> before running. Synthetic example only.
-->

# Grok prompt — suggest keywords / hashtags to track

Copy the box, fill the `<PLACEHOLDERS>`, run it on **grok.com** or **X with Grok**, then paste the
reply into `engine suggest apply`.

```text
You are a trend-monitoring strategist. Use your live access to current X/Twitter data.

MY BRAND: <BRAND NAME> (@<MY_HANDLE>)
WHAT WE DO: <ONE OR TWO SENTENCES>
INDUSTRY / CATEGORY: <e.g. web3 gaming, indie skincare, dev tools>

TASK: Recommend 8–15 keywords and hashtags worth tracking on X for my brand — the terms where the
conversations my audience cares about actually happen. Favor terms that are specific enough to be
signal (not generic noise) but active enough to surface fresh posts daily. Mix plain keywords and
hashtags.

HARD RULES:
- Terms that are actually in use on X right now. If a term is dead/noisy, OMIT it.
- Keep each term short (a phrase or a single hashtag), not a sentence.
- One short line on why it's worth tracking.

OUTPUT: Reply with ONLY a single fenced code block tagged `oce-suggestions`, this exact shape
(no prose outside the block):

```oce-suggestions
{
  "kind": "keywords",
  "items": [
    { "term": "#exampletag", "why": "where the core community discusses launches" },
    { "term": "example phrase", "why": "high-signal topic for our audience" }
  ]
}
```
```

After you paste it back, the engine shows the proposed terms and adds them to
`config/system.json → trends.keywords` **only when you confirm** with `--yes`. The Apify trend adapter
searches these each pass and groups matched posts into topics.
