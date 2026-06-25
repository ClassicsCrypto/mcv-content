<!--
  docs/trends.md — the trend-automation pathway (release-spec §8.8 trend pathway scope; §2.7;
  §6.7 trend-report schema; §2.1 seeding; §2.4 the double gate; §12.1 #1 / §12.2 scraper-trend seam;
  §3.3 optional BYO trend provider; original-design-spec §2.7 trend catching, §1.4 reporting).
  Accuracy rule §17.6: this documents shipped behavior. The trend pathway ships CONFIG-GATED and OFF
  BY DEFAULT (RD-9 BYO; DD-16 reserved slots; RD-12 injectable seam). Regenerated clean (§13.3 r4):
  no instance constants, no production persona codenames (§0.3 r6).
-->

# Trend automation

The trend pathway is a **content source**: it watches for current trends, writes a **Trend Report**,
and that report becomes a **seed** that flows through the *same* chain as any calendar slot —
matcher → brief → writer → the hybrid gate → packager → queue → the **human approval card**. It does
**not** bypass the chain, and **nothing it produces auto-publishes.** SAFE is the default mode.

> **It ships OFF by default.** No provider is contacted and no credential is read until you opt in
> with a `trends` block in `config/system.json`. The whole pathway is an opt-in extension.

There are two ways trends become content, and both feed the same chain:

- **Manual submission (always available, no setup, no keys).** You hand-author a Trend Report file
  (or run a `RUN_TREND_MANUAL` command) and the chain produces a draft from it. This is contractually
  equal to the automated path, so a vendor outage never blocks you (RD-9; §12.2).
- **Automated polling (opt-in, BYO provider).** A trend-source **adapter** polls a provider you
  supply on a cadence, and the engine writes the reports for you. This is the part that needs config.

---

## 1. The shape of a Trend Report (what the chain consumes)

Both paths produce the same artifact: `schemas/inputs/trend-report.schema.json` (§6.7). It carries
**topics and suggested angles — never drafted reply or comment text** (spec §1.4, restated as a hard
principle). The report is the *idea*; the writer + the human turn it into a post.

```jsonc
{
  "period":   { "start": "<ISO>", "end": "<ISO>" },
  "platform": "twitter",
  "topics": [
    {
      "topic": "<the trending subject>",
      "source_links": ["<url>", "..."],     // where the trend was observed (Zone-U references)
      "suggested_angles": ["<an angle>", "..."]  // ANGLES ONLY — never drafted comment/reply text
    }
  ],
  "freshness_window": { "duration": "PT12H", "expires_at": "<ISO>" },  // feeds the trend-card TTL (DD-15)
  "provenance": { "trust_zone": "U", "method": "manual" | "adapter" }  // ALWAYS Zone U
}
```

**Trend reports are always Zone U (untrusted external input).** The engine *forces*
`provenance.trust_zone = "U"` on every report at write time — it never trusts an adapter to set it.
Zone-U text enters seat prompts only inside data fences and may never modify rules or config (model
§8). See [`architecture.md`](architecture.md#5-trust-boundaries-zones-u--o--s--a).

Reports are **instance data**: they are written under `$CONTENT_HOME/trends/` (per-brand:
`$CONTENT_HOME/trends/<brand>/`), redacted at write, and **never committed to the repo** (model
§13.2). The repo ships only the schema, the seam, and synthetic fixtures.

---

## 2. Reserved-slot behavior (DD-16 — trends never publish out-of-calendar)

A trend report does **not** create a new post out of nowhere. It fills a **reserved `trend` calendar
slot**:

- Your calendar (`templates/calendar.template.md`) declares slots with `slot_type: trend`. These are
  pre-allocated windows where timely content is *allowed*. The slot type is part of the calendar
  schema even when automated polling is off (§2.6, §6.5).
- When a trend slot comes due, the orchestrator picks up a fresh report and runs it through the
  chain into that slot. **No reserved slot, no trend post** — there is no out-of-calendar publishing
  (DD-16, consistent with the campaign rule §8.7).
- **Quote-retweet is a first-class `content_form`** on the resulting item (`standalone` is the
  default; `quote-retweet` is the other value — DD-16). It is fully gated like any other content;
  it is *not* a way around the gate or the approval card.
- **Freshness / TTL (DD-15):** the report's `freshness_window` is inherited as the item's trend-card
  TTL. A trend that goes stale before a reviewer acts **expires** rather than publishing late — stale
  trends are never drafted as fresh. If no fresh report is available when a trend slot fires, the
  slot **skips or falls back to evergreen** (§15.1); it never forces a stale post.

The framework the writer is pointed at for trend/quote-retweet content is
[`rules/frameworks/trend-quote-retweet.md`](../rules/frameworks/trend-quote-retweet.md).

---

## 3. Enabling automated polling (the `trends` config block)

Add a `trends` block to `config/system.json`. The block is read defensively and **fails closed** —
`enabled` must be **strictly `true`**; anything else (absent, `false`, `"true"`, `1`) leaves the
pathway OFF.

```jsonc
"trends": {
  "enabled": true,                 // the OFF-by-default gate — strictly true to opt in
  "adapter": "apify",              // a registered adapter name: "apify" | "reference" | "fixture" | your own
  "cadence": "1h",                 // "1h" | "2h" | "4h" | "8h" | "12h" | "24h" — 1h/2h hourly, 24h daily
  "tracked_accounts": ["@acompetitor", "@anindustrycreator"],  // CONFIRMED handles to watch each pass
  "keywords": ["ai agents", "#web3gaming"],  // CONFIRMED keywords/hashtags to search each pass
  "themes": ["space", "exploration"],  // optional extra topic hints (the apify adapter folds these in as keywords)
  "private_terms": ["<a confidential term>"],  // extra redaction deny-list terms (privacy, §13.3)
  "provider": {                    // adapter-specific provider config (BYO) — see §4
    "actor_id": "apidojo/tweet-scraper",  // the Apify "username/actor-name" to run
    "key_env": "APIFY_API_KEY",    // the .env variable NAME the credential lives under (never the value)
    "platform": "twitter",
    "max_items": 100,              // per-pass cap (a tracking poll is a small recent window, not an archive)
    "timeout_ms": 60000
  }
}
```

> `tracked_accounts` and `keywords` are **suggested by the manual-Grok kit and operator-CONFIRMED** —
> never auto-added. The `apify` adapter pulls recent posts for each, groups them into volume-labeled,
> source-linked topics, and **fabricates no angles** (the §1.4 no-drafted-text principle). Every pass
> is **verified**: a configured-but-empty poll is flagged (not a silent no-op), and every topic is
> checked to carry only the trend-report variables.

When `enabled` is not `true`, `engine` and the source refuse to run the pathway and raise
`TrendsDisabledError` — **no provider is contacted and no credential is read.**

### Cadences

A cadence is **how often your scheduler invokes the poll** — `1h`, `2h`, `4h`, `8h`, `12h`, or `24h`
(`1h`/`2h` for hourly tracking, `24h` for a daily pass). It is carried into the adapter so a provider
can window its query, and it sets the report's **default freshness window** when the adapter does not
supply one. An off-list cadence is rejected fail-closed.
Pick the **slowest cadence that meets your needs** — every poll is a metered provider call
([`cost.md`](cost.md)).

You install the poll on the cadence with a `templates/scheduler/` recipe, exactly like the daily
kickoff (every recipe sets `CONTENT_HOME` in the process environment). Polling is a separate trigger
from the kickoff; it writes reports, it does not dispatch slot runs.

---

## 4. The BYO trend adapter (RD-9 — metered, external, your responsibility)

**Scraping/trend fetching is bring-your-own.** The repo ships the adapter *interface* and a reference
adapter, but **no bundled scraping credentials and no hosted scraping service.** You are the data
controller; ToS compliance for any provider you point it at is your responsibility
([`data-policy.md`](data-policy.md)).

Two adapters ship, and you can register your own:

| Adapter (`trends.adapter`) | What it does | Keys |
|---|---|---|
| `reference` | Reads a configured trend/scraper provider over HTTP through an injectable fetch. Resolves the credential **by name** via `secrets.js` (one of `APIFY_API_KEY` / `XAI_API_KEY`, or your `provider.key_env`). | BYO provider key |
| `fixture` | Returns deterministic **synthetic** ("Acme Cosmos") reports. Zero network, zero credentials — for the zero-key fixture run and for trying the pathway end to end. | none |
| *(your own)* | Implements the one-method `poll(...)` contract and self-registers through the seam. | yours |

**Metered and external by nature.** The reference adapter degrades gracefully:

- If **no provider or key** is configured, `poll` returns **no reports** — it does not throw and it
  does not fabricate. The manual-submission path remains available, so a missing provider means "no
  automated reports", never a broken setup.
- A provider **error or rate-limit** surfaces as a failed pass; the engine records nothing for it and
  never invents a report. A trend slot then skips or falls back to evergreen (§15.1).
- Every provider payload is run through `redact.js` **before** it is mapped into report fields, so a
  token/secret-shaped value in a response can never survive into a written report.

### The adapter contract (`poll`)

A trend-source adapter implements a single method (it only *fetches* — it never publishes, verifies,
or reports metrics, so it is one method, unlike the four-method publisher seam):

```js
// poll({ cadence, themes, brand, provider, env, fetchImpl, signal }) -> Promise<TrendReport[]>
const { register } = require('./engine/sources/trends/source');
register('my-provider', {
  async poll({ cadence, themes, provider, env, fetchImpl /* injectable */ }) {
    // fetch from your provider; return zero or more §6.7 reports (or [] when nothing is actionable).
    // the engine forces provenance.trust_zone="U" and the freshness window on top of whatever you return.
    return [];
  },
});
```

**Testability (RD-12 — zero keys in CI):** the network call is **injectable**. `poll` takes a
`fetchImpl` (and reads an injectable `env`), exactly like the visual-model seam (§12.5). Tests drive
the pathway with the `fixture` adapter or a fake fetch and **carry no secrets**. See
[`extending.md`](extending.md#4-scraper--trend-adapters) for the full seam.

---

## 5. The readout channel

`#trend-readout` is the **optional** fifth Discord channel (alongside the four required roles).
Create it per [`setup/discord.md`](setup/discord.md) and bind it under `approval_surface.channels`.
It is where the trend pathway's notices land — what was polled, what was written, and **missed-pass /
fallback notices** when a provider was down or a trend went stale (§15.1). It is a readout surface
only; it is **not** an approval surface and nothing publishes from it. Approval still happens on the
**`content-review`** card like all other content (§2.4).

---

## 6. Manual submission (no keys, always available)

You never need an adapter to use trends. Two manual routes:

1. **Drop a report file.** Hand-author a `trend-report.schema.json` file (set
   `provenance.method: "manual"`, `provenance.trust_zone: "U"`) into `$CONTENT_HOME/trends/` (or
   `$CONTENT_HOME/trends/<brand>/`). Validate it with `scripts/validate-schemas.js`.
2. **Run a manual trend command.** Dispatch a `RUN_TREND_MANUAL` operator command
   (`schemas/inputs/operator-command.schema.json`, §6.1) referencing the report into a reserved
   trend slot.

Either way the report enters the same chain and the same approval card. The manual path is the
v1-supported baseline; automated polling is the opt-in convenience on top of it.

---

## 7. What this pathway will and will not do

- **Will:** watch for trends (when you wire a provider), write Zone-U Trend Reports, and seed them
  into reserved trend slots through the full chain to a human approval card.
- **Will not:** publish anything without your approval; draft reply/comment text for someone else's
  post (angles only — §1.4); publish out-of-calendar (DD-16); post a stale trend (DD-15); bundle a
  scraping provider or its credentials (RD-9); or read any provider while disabled.

## See also

- [`data-policy.md`](data-policy.md) — the BYO-scraping posture, Zone-U trust tagging, ToS responsibility.
- [`cost.md`](cost.md) — trend polling is **engine-metered** (every poll is a provider call).
- [`extending.md`](extending.md#4-scraper--trend-adapters) — the scraper/trend adapter seam in full.
- [`configuration.md`](configuration.md#3-configsystemjson-system-scope) — `card_ttl.trend`, `approval_surface.channels.trend-readout`.
- [`work-recap.md`](work-recap.md) — the sibling build-in-public source (the other opt-in content source).
- [`architecture.md`](architecture.md#5-trust-boundaries-zones-u--o--s--a) — zones U/O/S/A and data fences.
