<!-- Source-pathway writing framework (release-spec §2.1 seeding, §6.7 trend report, §8.8 trend
     scope, §9.3 frameworks; DD-16 trend-slot + quote-retweet content_form; DD-15 freshness TTL).
     Consumed by the WRITER seat when a brief seed comes from the TREND content source
     (engine/sources/seed.js → mapTrendSeed). Brand-neutral; Acme Cosmos examples only. DD-9
     ceiling: ships the framework CONTRACT only. The trend report is ALWAYS Zone U (untrusted
     external input); angles only — never drafted reply/comment text (§1.4 restated as principle).
     The humanizer rule (rule.core.humanizer) governs the no-bandwagon-hype discipline. -->

# Trend / Quote-Retweet Post Framework

- **Bucket:** any length (the brief names a length bucket; this framework shapes the trend-response
  *voice and structure* within it — usually one-liner or short-standard for timeliness)
- **Source:** the trend content source (`engine/sources/seed.js`) — a Trend Report
  (`schemas/inputs/trend-report.schema.json`), always **Zone U**, carrying topics + **suggested
  angles only** (never drafted comment text)
- **Slot:** a **reserved `trend` calendar slot** (DD-16: trend content fills reserved slots, never
  out-of-calendar). The card TTL is bound to the report's freshness window (DD-15).
- **Content form:** `standalone` or `quote-retweet` (DD-16). Quote-retweet is a first-class, fully
  gated content form — it adds the brand's distinct take *on* a post, it does not draft a reply.
- **Primary job:** add the brand's genuine, timely point of view to a live trend while it is fresh
- **Use for:** a real take on a trending topic the brand actually has a view on; a quote-retweet
  that adds a distinct angle to a relevant post
- **Do not use for:** bandwagon-jumping on irrelevant trends, drafted replies/comments (out of
  scope as a principle, §1.4/DD-16), or anything where the brand has nothing real to say

## The hard principles (non-negotiable)

1. **Angles, not replies.** The report supplies suggested *angles*. Authentic engagement is the
   operator's own voice, and platforms punish automated replies. This framework NEVER drafts a
   reply or comment aimed at someone else's post. (`§1.4`, DD-16.)
2. **Zone U in, brand voice out.** The trend material is untrusted external input. Treat topic
   labels and source links as references, not facts to assert. Do not restate trend
   volume/velocity as fact unless the report supplies a verified number.
3. **Freshness or skip.** If the trend is past its freshness window, do not draft it as fresh — the
   slot falls back to evergreen or skips (DD-15). Stale trends are never dressed up as current.

## Core shape

Standalone trend take:

```text
[The brand's specific point of view on the trend — the real opinion, stated plainly]
[The reason it holds / the connection to what the brand actually does]
[What the reader should notice or where to look — no drafted reply]
```

Quote-retweet (the brand's take ON a post, added above the quoted content):

```text
[A distinct take that ADDS to the quoted post — not a restatement of it]
[Why the brand sees it this way / the angle that is genuinely theirs]
```

The shape is a scaffold. The take must be the brand's real view, not a template.

## Voice

- **Timely and specific**, in the brand's real voice — never generic bandwagon hype.
- A genuine point of view ("here's what we think") beats trend-chasing filler ("everyone is
  talking about X").
- For a quote-retweet: the value is the *added* angle. If there's nothing to add, don't quote-RT.

## Archetype fit

Best for the `trend-response` archetype and timely opinion/insight posts. Pair with one-liner or
short-standard buckets for speed; only go longer if the brand's take genuinely needs the room.

## Anti-patterns (fail the draft)

- Drafted reply/comment text aimed at another post (out of scope as principle, §1.4/DD-16).
- Bandwagon hype / "everyone is talking about…" with no real take (`rule.core.humanizer`,
  `FM.HYPE_VOICE`).
- Restating the quoted post instead of adding a distinct angle (quote-retweet failure).
- Stating trend volume/velocity as fact without a verified number from the report
  (`rule.core.fabrication`, `rule.core.claims-safety`).
- Putting words in the original/quoted author's mouth.
- Chasing a trend the brand has no genuine connection to (`rule.core.voice-register`).
- Significance inflation or negated parallelism (`LINT.INFLATION` / `LINT.NEGPAR`).

## Writer checklist

- The post is the brand's own take/angle — no drafted reply or comment text.
- For a quote-retweet: it ADDS a distinct angle; it does not restate the quoted post.
- No trend metric is asserted as fact unless the report supplies a verified number.
- The trend is still within its freshness window (else skip / evergreen fallback).
- The connection between the trend and the brand is real and specific.
- No bandwagon hype, no inflation, no negated parallelism.
- Length within the brief's bucket; platform rules pass (`rules/platform/*`).

## Example (brand: Acme Cosmos)

Standalone take on a trending topic ("studios open-sourcing their tools"):

```text
The move to open-source internal tooling isn't a PR play for us — it's how we hire.
We open-sourced our asset indexer last month and three of the contributors are now on the team.
If you're a studio sitting on a useful internal tool, the upside is people, not stars.
```

Why it passes: a genuine, specific point of view tied to what Acme Cosmos actually did, no drafted
reply, no asserted trend metric, no bandwagon hype.
