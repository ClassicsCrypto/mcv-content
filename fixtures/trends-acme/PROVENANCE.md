# `fixtures/trends-acme/` — Provenance

**Every file here is synthetic / maintainer-authored, created for this repository.** None is, derives
from, or resembles any real brand, trend, account, scraped corpus, or operator instance. The only
brand is the fictional **"Acme Cosmos"** (an invented backyard-astronomy / consumer-telescope brand);
trend topics reference only public, free-to-mention sky events (clear-sky windows, a Jupiter
apparition, a generic meteor shower). This satisfies the release contract that datasets without
demonstrated synthetic/operator-owned provenance never ship (release-spec §5 preamble; model §13.3
rules 1 & 3 — regenerate-never-redact, §0.3 r6).

## What this fixture is for

The **zero-key test fixtures + fake trend adapter** for the trend-pathway content source (release-spec
§8.8 trend pathway; §6.7 trend report schema; §2.1 seeding; §3.3 trend/scraping provider is BYO per
RD-9). It lets the trend source run in CI with **no keys and no network**: a fake `poll(query)` returns
the recorded reports in `recorded/trend-poll-responses.json` instead of calling a real trend/scraping
provider (RD-12 — the external call is dependency-injectable so CI holds no secrets).

The trend pathway is a **content source, not a publish bypass**: a poll (or a manual submission) yields
Zone-U `TrendReport`s that become pre-seeds (§2.1) feeding the EXISTING chain — matcher → brief →
writer → the hybrid gate → package → queue → the **human approval card** (the double gate, §2.4).
Nothing here auto-publishes; SAFE is the default mode, and trend passes fill **reserved calendar
slots only** (DD-16), never out-of-calendar. Topics carry suggested **angles only** — never drafted
comment/reply text (spec §1.4 principle).

## Files

| File / dir | What it is | Provenance |
|---|---|---|
| `reports/2099-04-08-clear-sky-window.json` | A `manual`-method Trend Report (the canonical report `fixtures/brand-acme/commands/run-trend-manual.json` references via `trend_report_ref`). Validates against `schemas/inputs/trend-report.schema.json`. | Authored-synthetic |
| `reports/2099-04-09-meteor-shower-peak.json` | An `adapter`-method Trend Report (the shape a BYO adapter returns when polled). Validates against the same schema. | Authored-synthetic |
| `recorded/trend-poll-responses.json` | Recorded `poll(query)` responses keyed by `${platform}:${window}` — the canned report arrays the fake adapter replays zero-key (the trend counterpart of `fixtures/library-acme/expected/vision-responses.json`). | Authored-synthetic |

The consumer helper that replays these recordings is `tests/helpers/fake-trend-adapter.js`.

## Notes

- **Future-dated (2099-…):** all timestamps sit far in the future so a fixture report is never mistaken
  for a real observation and so freshness/TTL math (DD-15) is deterministic in tests.
- **Source links** are all `https://example.test/...` reserved-domain placeholders — they resolve to
  nothing and reference no real source.
- **`submitted_by`** uses the synthetic `00000000000000001` placeholder reviewer id (never a real
  Discord snowflake), matching the convention in `fixtures/run.js`.
- **Zone U always:** every report sets `provenance.trust_zone = "U"`. The trend source feeds the chain
  through the same data-fence treatment as any untrusted external input (RD-8); the human approval card
  remains the final backstop.
- **`twitter:empty`** is a recorded EMPTY poll so a test can exercise the no-trends / degrade path.
