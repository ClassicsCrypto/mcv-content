<!--
  templates/grok-prompts/competitors.md — the FREE manual-Grok prompt for suggesting comparator /
  competitor accounts (release-spec §1.2 competitor identification). Run it on your own Grok/X account
  (no API spend), then paste the result into: engine suggest apply --file <paste.txt> --brand <id>
  Fill every <PLACEHOLDER> before running. Synthetic example only — no real handles shipped.
-->

# Grok prompt — suggest competitor / comparator accounts

Copy everything in the box below, replace the `<PLACEHOLDERS>`, and run it on **grok.com** or in
**X with Grok**. Then copy Grok's reply and run `engine suggest apply` on it.

```text
You are a competitive-research analyst. Use your live access to current X/Twitter data.

MY BRAND: <BRAND NAME> (@<MY_HANDLE>)
WHAT WE DO: <ONE OR TWO SENTENCES — product, audience, niche>
INDUSTRY / CATEGORY: <e.g. web3 gaming, indie skincare, dev tools>

TASK: Identify at least 8 ACTIVE accounts on X that are the closest comparators or direct
competitors to my brand — same industry, similar audience, overlapping content. Prefer accounts
that post regularly (active in the last 30 days) and that a content strategist would benchmark
against. Include a mix of direct competitors and aspirational comparators.

HARD RULES:
- Real, currently-active X accounts ONLY. If you are not confident an account is real and active,
  OMIT it — never invent or guess a handle.
- Exclude my own account (@<MY_HANDLE>) and obvious parody/inactive/suspended accounts.
- One line of reasoning per account (why it is a comparator).

OUTPUT: Reply with ONLY a single fenced code block tagged `oce-suggestions` containing JSON in
exactly this shape (no prose before or after the block):

```oce-suggestions
{
  "kind": "competitors",
  "brand": "<MY_BRAND_ID>",
  "items": [
    { "handle": "@examplerival", "name": "Example Rival", "category": "competitor", "why": "direct competitor in the same niche; similar audience and cadence" }
  ]
}
```
```

After you paste Grok's reply back, the engine will show you the proposed competitors and add them to
`brands/<id>/brand.json → ingestion.competitors` **only when you confirm** with `--yes`. You can edit
the list before or after. These handles become the competitor corpus the Apify ingest pulls.
