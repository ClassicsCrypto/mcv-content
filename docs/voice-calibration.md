<!--
  docs/voice-calibration.md — the monthly competitor scan + consent-gated voice-DNA calibration
  pathway (roadmap #5). Cites: release-spec §8.8 trend pathway scope analogy; §3.1 never-loosen;
  DD-6 governance trust boundary; DD-15 freshness guard; DD-16 no-post (competitor_scan slot);
  DD-18 estimate-and-confirm; DD-21 cold-start / degrade; RD-2 no-chain-LLM; RD-9 BYO scraping;
  RD-12 injectable/zero-key; P1 patterns-only; P2 consent-gated/never-auto-apply; P3 never-loosen;
  P4 never-touch-human-only; P5 off-by-default+paused; P6 deterministic/zero-key; P7 analyst-seat
  prose-only; P8 versioned+reversible; P9 freshness; P10 not-shareable-upstream; P11 no-post-produced.
  Written agent-first (RD-6): an AI agent executes it; a human reads it. No instance constants, no
  production brand names, no production codenames (§0.3 r6) — only synthetic "Acme Cosmos" /
  "Orbit Outfitters" in examples.
-->

# Monthly competitor scan + consent-gated voice-DNA calibration (roadmap #5)

This is the **roadmap #5 extension**: the engine watches competitor patterns on a monthly cadence,
derives structured changes to the brand's **four voice-preference axes** in `brand.json`, and presents
them as a human-reviewed, consent-gated proposal. **Nothing is auto-applied.** The machine stops at
a proposal; the human decides, consents, and applies.

> **The governance is the feature.** The machine never touches the gate, the rules, or any guardrail.
> The four voice axes are generation-input preferences that the unchanged gate still vets afterward.
> The human's consent is structurally required — refusing to proceed without it is not a best-effort
> check but a code path that throws and writes nothing.

> **Both blocks ship OFF by default.** No scraping and no proposal generation happens until you
> explicitly set `competitor_scan.enabled: true` AND `competitor_scan.voice_calibration.enabled: true`
> in `config/system.json`.

---

## 1. What the pathway is — and is not

**It is:**

- A monthly (or quarterly) scan that ingests competitor content via a BYO adapter or manual export,
  runs a **deterministic, LLM-free** landscape analyzer, and writes a **patterns-only** Zone-U scan
  report under `$CONTENT_HOME/scans/<brand>/`.
- A proposal step that derives structured changes to the four voice axes from the report and the
  brand's current `brand.json` — target `drama_dial`, `archetype_emphasis`, `hook_preferences`, and
  `cadence_preferences`.
- A consent display that shows the current vs proposed values for each axis with a redacted evidence
  summary. **No competitor text is shown — only labels, counts, ratios, and codes.**
- A human-applied, one-step-reversible commit to `brand.json` that requires explicit `--consent` and
  a passing gate-regression run before it writes anything.

**It is not:**

- Auto-applied. `self-improve applyGovernedChange` **refuses** a voice-calibration record with
  `EHUMANONLY` — by design, not by configuration.
- A way to change the gate, the rules, the firewall, or pass/fail thresholds. Those surfaces are
  untouched; `assertNotGateLoosening` throws `ENEVERLOOSEN` if any proposal tries to carry a gate
  axis.
- A scraping service. Bring your own adapter. The repo ships the interface, a fixture adapter
  (zero-key), and a manual submission path. No bundled credentials.
- Free to run when a scraper adapter is configured. Scraping is metered; the DD-18 cost estimate is
  shown and confirmed before any scrape starts.

---

## 2. The four voice axes (what can be calibrated)

All four axes live in `brand.json` and are structurally separate from the gate, the rules, and any
pass/fail criteria. They are **generation inputs** — they steer the writer and the matcher without
moving any threshold or guardrail. After a calibration, the gate runs **unchanged** against the new
generation output; only human reviewers approve what publishes.

| Axis | Schema field | What it controls | Deterministic proof |
|---|---|---|---|
| `drama_dial` | `drama_dial` | Existing `low\|medium\|high` enum; the overall intensity register for the brand's voice | Gate-regression-provable: the calibration must pass a gate run before apply, so a drama-dial shift that would push output outside the gate is caught deterministically |
| `archetype_emphasis` | `archetype_emphasis` | Ranked list of archetype codes + weights; steers the matcher toward which content archetypes to favor | Generation-input preference, vetted by the unchanged gate + human consent — not deterministically gate-proven |
| `hook_preferences` | `hook_preferences` | Preferred opening-hook pattern labels + weights; steers the writer toward favored hook types | Same as above |
| `cadence_preferences` | `cadence_preferences` | Preferred posts-per-week, thread/media preference, top posting days | Same as above |

**Honest scope of the deterministic proof.** `drama_dial` is the one axis where a gate-regression
run gives you a strong deterministic signal: a drama shift toward `high` that causes the gate to fail
is caught and blocked before any write. The other three axes affect generation *inputs*, not the gate
directly — they are vetted by the standard gate (every draft still passes through the gate unchanged)
and by the mandatory human approval that follows. They are not individually gate-regression-proven;
the gate regression is an overall pass/fail on a sample of drafts with the proposed settings applied.

---

## 3. The pathway end to end

```
  monthly scheduler trigger  (engine competitor-scan)
            │
            ▼  [P5] OFF unless competitor_scan.enabled === true
  DD-18 estimate preface  ──  scraper adapter configured? show cost, require --yes
            │
            ├── adapter present + confirmed   ──▶  ingestCorpus(confirmed)
            └── no adapter / manual           ──▶  load on-disk corpus (DD-21 cold-start path)
            │
            ▼
  readCorpus     own items + competitor items for the brand
            │
            ▼  [RD-2] deterministic, no chain LLM
  analyzeCorpus + categorizeArchetypes   (engine/brand-dna/analyze.js + archetypes.js)
            │
            ▼
  analyzeCompetitorPatterns              (engine/brand-dna/competitor-landscape.js)
            │  [P1] PATTERNS ONLY: drama_markers, archetype_distribution, hook_signals,
            │       cadence_profile, engagement_profile, drama_signal, confidence
            │  NO verbatim competitor text — only counts/ratios/labels
            ▼
  enforceNotVerbatim + assertNoVerbatimCompetitorCopy  ──▶  EVERBATIMCOPY if any leak
            │
            ▼
  write Zone-U scan report to $CONTENT_HOME/scans/<brand>/<YYYY-MM-DD>.json
            │
            ▼  [P11 / DD-16]
  dispatch ONE reserved competitor_scan task record  (produces_content: false;
            │  no approval card, no publish, no post produced — informational only)
            │
            ▼  [P5 + P9] voice_calibration.enabled? scan fresh enough (< freshness_days old)?
  proposeVoiceCalibration    (engine/voice-calibration/propose.js)
            │  [P2] record: status:proposed, target_mutability:human-only,
            │       target_artifact:brand:<id>:voice, proposed_diff over all four axes
            │  [P7] optional analystSeat.refine returns rationale STRING only;
            │       a throwing/absent seat degrades to the deterministic rationale
            ▼
       ┌────┴─────────────────────────────────────────────────────────────────┐
       │  HUMAN DECISION POINT (the machine stops here)                       │
       │                                                                      │
       │  engine voice-calibrate --show        display card (current→proposed) │
       │  engine voice-calibrate --apply --consent   apply with consent       │
       └────┬─────────────────────────────────────────────────────────────────┘
            │  [P2] consent !== true  ──▶  ECONSENTREQUIRED, write nothing
            │  [P3] gate axis in proposed_diff  ──▶  ENEVERLOOSEN, write nothing
            │  [P8] not a git repo  ──▶  NO_INSTANCE_REPO, write nothing
            │
            ▼
  capture baseline_ref (HEAD)
            │
            ▼  [P4] gate-regression run (required unless skipGateRegression)
  gate-regression  ──▶  GATE_REGRESSION_FAILED if red; write nothing
            │
            ▼
  write brand.json voice fields (all four axes, atomic)
  write learning record status:applied + governance sidecar
  ONE atomic instance-repo commit   baseline_ref captured in record
  workflow-ledger.recordEvent
            │
            ▼
  engine voice-calibrate --rollback   (one step back via instance repo)
```

---

## 4. Enabling the pathway (the two config blocks)

Both blocks live in `config/system.json`, validated by `schemas/config/system.schema.json`. Both
default to `false` and are **independently gated** — you can enable the scan without enabling voice
calibration.

```jsonc
"competitor_scan": {
  "enabled": true,                    // THE LAW: strictly true to enable; default false
  "cadence": "month",                 // "month" | "quarter" — default "month"
  "adapter": "fixture",               // registered adapter name; "fixture" = zero-key (§5)
  "provider": {                       // adapter-specific config (BYO)
    "platform": "twitter"
  },
  "private_terms": ["<codename>"],    // extra redaction terms (brand names, partner names)
  "monthly_cap_usd": 5.00,            // hard spend cap for scraping (engine-metered)
  "voice_calibration": {
    "enabled": true,                  // enable proposal generation from scan results
    "freshness_days": 30              // DD-15: scans older than this never advance to proposal
  }
}
```

When `competitor_scan.enabled` is not **strictly `true`**, the pathway refuses: `ran: false,
disabled: true, exitCode: 0`. No corpus is read, no provider is contacted, and no credential is read.

---

## 5. BYO scraper adapter (RD-9 — metered, external, your responsibility)

Scraping is bring-your-own. The repo ships the adapter interface, a fixture adapter (`fixture` —
zero-key synthetic data), and a manual submission path. No bundled credentials, no hosted service.
You are the data controller; ToS compliance for any provider is your responsibility
([`data-policy.md`](data-policy.md)).

```js
// Implement the two-method contract and self-register:
const { register } = require('./engine/sources/scraper/source');
register('my-competitor-scraper', {
  async fetchCorpus({ brand, maxItems, provider, env, fetchImpl }) {
    // Fetch competitor items; return a CorpusItem[] (schemas/inputs/corpus-item.schema.json).
    // Return [] when nothing is actionable — never throw and never fabricate.
    return [];
  },
  async fetchOwnCorpus({ brand, maxItems, provider, env, fetchImpl }) {
    // Fetch own-brand items for the same period. Return [] if not applicable.
    return [];
  },
});
```

The fixture adapter exports the same contract and returns deterministic synthetic data for
Acme Cosmos — it is wired in CI for the zero-key test run. To try the full flow end to end
without keys, set `competitor_scan.adapter: "fixture"`.

**DD-18 (estimate-and-confirm).** When a scraper adapter is configured, the CLI shows a cost
estimate before any scrape starts:

```
engine competitor-scan --brand <id> --estimate-only   # show the estimate, do nothing
engine competitor-scan --brand <id> --yes             # confirm and run
```

Without `--yes` (or `confirmed: true` in the module call), the scan returns `{ ran: false,
needs_confirmation: true }` and exits 0. No spend occurs.

---

## 6. The scan report (Zone-U, patterns-only)

The scan report is written to `$CONTENT_HOME/scans/<brand>/<YYYY-MM-DD>.json` and validated
against `schemas/inputs/competitor-scan-report.schema.json`. It is **instance data** — never
committed to the repo, never shared upstream (P10 — improvement-sharing rejects any `brand:*:voice`
payload). The report carries only **counts, rates, labels, and codes**:

```jsonc
{
  "period": { "start": "<ISO>", "end": "<ISO>" },
  "brand": "<brand-id>",
  "platform": "twitter",
  "drama_markers": {
    "total_items": 8,
    "high_drama_count": 2, "medium_drama_count": 1, "low_drama_count": 1,
    "exclamation_rate": 0.5,                          // ratio 0..1, no text
    "hype_term_rate": 0.5                              // ratio 0..1, no text
  },
  "archetype_distribution": [
    { "code": "HOW_TO", "own_count": 2, "competitor_count": 2 }
  ],
  "hook_signals": {
    "total_items": 4,
    "top_patterns": [{ "pattern": "how-to-numbered", "count": 2 }]
  },
  "cadence_profile": {
    "total_items": 4, "avg_posts_per_week": 1.3,
    "thread_rate": 0.0, "media_rate": 0.0, "top_days": ["wed"]
  },
  "engagement_profile": {
    "metric": "bookmarks", "median_value": 249,
    "high_engagement_archetype_codes": ["HOW_TO"]
  },
  "drama_signal": "high",            // enum: low | medium | high
  "confidence": 0.62,                // 0..1
  "freshness_window": { "duration": "P30D", "expires_at": "<ISO>" },
  "provenance": { "trust_zone": "U", "method": "manual" | "adapter" }
}
```

**No field may carry verbatim competitor text.** `enforceNotVerbatim` inspects every competitor
corpus item and every output field for verbatim shingles of 40+ characters before writing
(`EVERBATIMCOPY` if found, write nothing). This check runs regardless of where the corpus came from.

---

## 7. The voice-calibration proposal

`proposeVoiceCalibration(scanReport, brandConfig, opts)` derives a structured proposal over all four
axes and writes a learning record (status: `proposed`) to
`$CONTENT_HOME/learning/<brand>/voice-calibration-<id>.json`. The record contract:

```jsonc
{
  "status": "proposed",
  "target_mutability": "human-only",         // ALWAYS — classifyTarget enforces this
  "target_artifact": "brand:<id>:voice",     // ALWAYS — voice is instance-specific
  "proposed_diff": {
    "drama_dial":           { "current": "low",  "proposed": "low"  },
    "archetype_emphasis":   { "current": [...],  "proposed": [...] },
    "hook_preferences":     { "current": [...],  "proposed": [...] },
    "cadence_preferences":  { "current": {...},  "proposed": {...}  }
  },
  "source_signals": [{ "type": "calibration", "count": 8 }],
  "rationale": "...",                        // deterministic; analyst seat may refine prose only
  "confidence": 0.62
}
```

**DD-15 freshness guard (P9).** A scan older than `voice_calibration.freshness_days` (default 30)
never advances to a proposal. `proposeVoiceCalibration` throws `ESTALEREPORT` on a stale scan; a
stale record also refuses to apply (`ESTALEREPORT` from `applyVoiceCalibration`).

**Analyst seat (P7 — prose only).** An optional host analyst seat may refine the `rationale` string.
The engine deep-clones all inputs before the seat call so mutation is impossible; after the call it
re-validates that the structured fields are unchanged. A seat that returns a non-string, throws, or
is absent degrades silently to the deterministic rationale. The seat cannot change a dial value, an
archetype weight, an evidence count, or the target classification.

---

## 8. The consent display (`engine voice-calibrate --show`)

```
engine voice-calibrate --brand <id> --show
```

Outputs a calibration card with the current → proposed values for each axis, a redacted evidence
summary (archetype codes by count, drama-signal label, confidence), the deterministic rationale, and
an explicit yes/no consent question. **No verbatim competitor text appears in the card** — only
labels, counts, and codes, stripped of any brand/partner/snowflake terms via `engine/shared/redact.js`
+ configured `private_terms`.

The card does not write anything; it only renders.

---

## 9. Applying the calibration (`engine voice-calibrate --apply --consent`)

```
engine voice-calibrate --brand <id> --apply --consent
```

`applyVoiceCalibration(record, { consent: true, ... })` is the **only** path that writes voice
fields. The machine-apply path (`self-improve applyGovernedChange`) is refused structurally:
`assertMachineChangeAllowed` sees `target_artifact: "brand:*:voice"`, classifies it `human-only`,
and throws `EHUMANONLY`. You cannot route around this with config.

**The apply pre-flight (every check must pass; any failure writes nothing):**

1. `consent !== true` → `ECONSENTREQUIRED`
2. Any gate-axis key in `proposed_diff` → `ENEVERLOOSEN`
3. `$CONTENT_HOME` is not a git repo → `NO_INSTANCE_REPO`
4. Gate-regression run fails → `GATE_REGRESSION_FAILED`

On pass: capture `baseline_ref` (HEAD), write `brand.json` voice fields atomically (all four axes),
write the applied learning record + governance sidecar, ONE atomic instance-repo commit, ledger via
`workflow-ledger.recordEvent`. The result carries `{ ok: true, commit, baseline_ref, ledger_id }`.

**What does and does not change (P4).** After a consented apply:

- `brand.json` voice fields (`drama_dial`, `archetype_emphasis`, `hook_preferences`,
  `cadence_preferences`, `voice_calibration` state) — updated.
- The applied learning record + governance sidecar — written.
- The instance-repo commit log — one new commit.
- **Everything else:** `config/system.json`, all `rules/*.md`, the gate, thresholds, the firewall,
  budget caps, reviewer allowlist, publish posture — **byte-identical**. A diff of the instance repo
  between commits will touch only `brand.json` and the learning-record/sidecar files.

---

## 10. Rollback (`engine voice-calibrate --rollback`)

```
engine voice-calibrate --rollback [--to-baseline <ref>]
```

`rollbackVoiceCalibration(ref, opts)` delegates to `engine/self-improve/rollback.js` targeting
`brand.json` (not `config/system.json` — that is the self-improvement rollback path, scoped to
different files). One step, one versioned commit to the instance repo, one ledger event.

If `--to-baseline` is omitted, the rollback reads `rollback_ref` from the most recently applied
voice sidecar. Rollback refuses if `$CONTENT_HOME` is not a git repo (`NO_INSTANCE_REPO`).

After rollback: the `brand.json` voice fields are restored to the pre-apply state. Prose DNA
(`brand-dna.md`) is not touched — if you regenerated prose after applying, regenerate it again after
rolling back.

---

## 11. Governance invariants (P1 – P11)

These are checked by the test suite (`engine/voice-calibration/__tests__/apply.test.js`,
`engine/voice-calibration/__tests__/propose.test.js`, `tests/competitor-scan-flow.test.js`) and
enforced structurally in code, not by convention:

| Invariant | Enforcement | What breaks it |
|---|---|---|
| P1 Patterns-only | `enforceNotVerbatim` + `assertNoVerbatimCompetitorCopy` | `EVERBATIMCOPY` thrown; nothing written |
| P2 Consent-gated / never-auto-apply | `assertMachineChangeAllowed` (`EHUMANONLY`); `consent!==true` check (`ECONSENTREQUIRED`) | Two independent code paths; neither is bypassable by config |
| P3 Never-loosen | `assertNotGateLoosening` on every proposed axis before write | `ENEVERLOOSEN`; nothing written |
| P4 Never-touch-human-only | apply writes only voice fields; system.json/rules are never in scope | Diff the instance repo — system.json is unchanged |
| P5 Off-by-default + paused | `enabled!==true` exits 0 disabled; dispatch preflight checks PAUSED sentinel | `ran:false disabled:true` or `EPAUSED` from dispatch |
| P6 Deterministic / zero-key | No `Date.now()` / `Math.random()` / I/O in proposer; time injected | Identical corpus → byte-identical report + proposal |
| P7 Analyst-seat prose-only | Deep-clone before seat call; re-validate structural fields after | Seat mutation has no effect; throwing seat degrades gracefully |
| P8 Versioned + reversible | `NO_INSTANCE_REPO` refusal; one atomic commit; `rollback_ref` in record | Rollback in one command |
| P9 Freshness (DD-15) | `ESTALEREPORT` when scan older than `freshness_days` | Propose and apply both refuse stale scans |
| P10 Not shareable upstream | `sanitizeForSharing` / `evaluate` throw `EUNSHAREABLE` / `EHUMANONLY` for `brand:*:voice` | Voice records never appear in improvement-sharing packages |
| P11 No-post-produced (DD-16) | `produces_content: false`, `slot_type: "competitor_scan"` on dispatched task | No approval card, no publish, no post |

---

## 12. No-prose-DNA auto-edit

**The proposer never edits `brand-dna.md` or the archetype catalog markdown files.** Those prose
files are the output of a host synthesis seat (the `engine generate-dna` flow). When drift is large
— especially a `drama_dial` shift — the proposal's `rationale` ends with a recommendation like:
> Regenerate brand-dna.md prose via `engine generate-dna` after applying.

Regenerating prose is an explicit operator step, after applying the structured calibration and
reviewing that the output is still on-voice. The calibration only moves the structured fields.

---

## 13. Not shareable upstream (P10)

Voice calibration is **instance-specific** — it reflects the brand's competitors and voice posture,
not a generalizable rule change. `improvement-sharing evaluate/sanitizeForSharing` rejects any
record whose `target_artifact` matches `brand:*:voice` (or `brand:*:drama_dial`, or kind `"voice"` /
`"brand-dna"` / `"voice-calibration"`) with `EUNSHAREABLE` / `EHUMANONLY`. This is a structural
check, not a convention.

Voice records must never appear in an `engine share` package or in an upstream pull request.

---

## 14. Scheduling the monthly scan (host scheduler recipe)

Install `engine competitor-scan` on a monthly or quarterly cron schedule. The run honors the
single-runner lock (DD-19: overlap fires skip), the PAUSED sentinel, and the budget cap. **Safety
posture comes from `config/system.json`, not the scheduler wrapper.**

See `templates/scheduler/` for the full recipe set. Quick reference for each scheduler type:

**Unix crontab (cron.example)** — run on the 1st of each month at 07:00 host-local time:

```
0 7 1 * *  CONTENT_HOME=<CONTENT_HOME> <NODE_BIN> <ENGINE_DIR>/bin/engine.js competitor-scan --brand <id> --yes >> <CONTENT_HOME>/logs/competitor-scan.cron.log 2>&1
```

**PM2 (pm2.example.json)** — monthly via `cron_restart`:

```json
{
  "name": "content-engine-competitor-scan",
  "script": "bin/engine.js",
  "args": "competitor-scan --brand <id> --yes",
  "cwd": "<ENGINE_DIR>",
  "interpreter": "node",
  "autorestart": false,
  "cron_restart": "0 7 1 * *",
  "env": { "CONTENT_HOME": "<CONTENT_HOME>" }
}
```

**OpenClaw (openclaw.example.md)** — a monthly job definition:

```json
{
  "id": "content-engine-competitor-scan",
  "schedule": "0 7 1 * *",
  "command": "node <ENGINE_DIR>/bin/engine.js competitor-scan --brand <id> --yes",
  "env": { "CONTENT_HOME": "<CONTENT_HOME>" },
  "description": "Open Content Engine monthly competitor scan (roadmap #5). OFF unless competitor_scan.enabled."
}
```

Validate before relying on the schedule:

```
engine competitor-scan --brand <id> --estimate-only   # see cost, write nothing
engine competitor-scan --brand <id> --dry-run         # run analysis, write nothing
engine competitor-scan --brand <id> --yes             # live run with confirmed scrape
```

---

## 15. Worked example — Acme Cosmos (fully synthetic)

The fixture suite uses **Acme Cosmos** (brand id: `acme-cosmos`) as the operator brand and
**Orbit Outfitters** (`@orbitoutfitters`) as the competitor. Both are fully synthetic — no real brand
or company names appear anywhere in the engine, tests, or fixtures.

### Starting state

`brand.json` voice fields before calibration:

```jsonc
{
  "drama_dial": "low",
  "archetype_emphasis": [
    { "code": "HOW_TO",           "weight": 3.0 },
    { "code": "SKY_TONIGHT",      "weight": 2.0 },
    { "code": "THESIS_OR_RECEIPT","weight": 1.5 }
  ],
  "hook_preferences": [
    { "pattern": "direct-tip",      "weight": 3.0 },
    { "pattern": "how-to-numbered", "weight": 2.5 },
    { "pattern": "question-hook",   "weight": 1.0 }
  ],
  "cadence_preferences": {
    "preferred_posts_per_week": 5,
    "thread_preference": "rarely",
    "media_preference": "sometimes",
    "top_days": ["mon", "wed", "fri"]
  }
}
```

### Running the scan

```
engine competitor-scan --brand acme-cosmos --estimate-only   # confirm expected cost
engine competitor-scan --brand acme-cosmos --yes
```

The scan ingests 4 competitor items (from the Orbit Outfitters fixture corpus). The landscape
analyzer observes:

- `drama_signal: "high"` in the competitor corpus — `exclamation_rate: 0.5`, `hype_term_rate: 0.5`.
- `archetype_distribution`: HOW_TO appears with `competitor_count: 2`; SCARCITY_FOMO and TEASER
  each with `competitor_count: 1`.
- `engagement_profile.median_value: 249 bookmarks`; high-engagement archetypes: HOW_TO.
- `hook_signals.top_patterns`: `how-to-numbered` count 2, `announcement-breaking` count 1,
  `direct-tip` count 1.
- `confidence: 0.62`.

The scan report is written to `$CONTENT_HOME/scans/acme-cosmos/<YYYY-MM-DD>.json`.

### The proposal

`proposeVoiceCalibration` derives:

```jsonc
{
  "proposed_diff": {
    "drama_dial": {
      "current": "low",
      "proposed": "low"
    },
    "archetype_emphasis": {
      "current": [{ "code": "HOW_TO", "weight": 3.0 }, ...],
      "proposed": [{ "code": "HOW_TO", "weight": 3.5 }, ...]
    },
    "hook_preferences": {
      "current": [{ "pattern": "how-to-numbered", "weight": 2.5 }, ...],
      "proposed": [{ "pattern": "how-to-numbered", "weight": 3.0 }, ...]
    },
    "cadence_preferences": {
      "current": { "preferred_posts_per_week": 5, ... },
      "proposed": { "preferred_posts_per_week": 5, ... }
    }
  }
}
```

**Drama dial stays low.** Even though the competitor landscape shows `drama_signal: "high"`, the
proposer recognizes this as an anti-pattern for the established Acme Cosmos voice and does not
recommend raising the dial. The rationale says so explicitly. This is deterministic behavior, not
random — the proposer applies an anti-pattern rule: when the brand's `drama_dial` is `low` and the
competitor drama is `high`, it recommends holding the brand's own dial.

**HOW_TO archetype emphasis raised from 3.0 to 3.5.** Competitor data shows HOW_TO is the top
archetype with `competitor_count: 2` and it correlates with the highest engagement in the combined
corpus.

**how-to-numbered hook weight raised from 2.5 to 3.0.** The hook-signals top pattern is
`how-to-numbered` (count 2 in the competitor corpus with high engagement), suggesting this hook
pattern is effective in the niche.

**Cadence preferences unchanged.** Insufficient signal to shift — the competitor posts 1.3 per week
vs Acme Cosmos's 5; the cadence difference reflects different account scale, not a direction to
follow.

### Reviewing the card

```
engine voice-calibrate --brand acme-cosmos --show
```

Output (CLI prompt):

```
Voice-DNA Calibration Proposal — acme-cosmos
Confidence: 0.62  |  Freshness: 30 days  |  Items: 4

axis: drama_dial
  current : low
  proposed: low  [no change]

axis: archetype_emphasis
  current : HOW_TO=3.0  SKY_TONIGHT=2.0  THESIS_OR_RECEIPT=1.5
  proposed: HOW_TO=3.5  SKY_TONIGHT=2.0  THESIS_OR_RECEIPT=1.5  [HOW_TO +0.5]

axis: hook_preferences
  current : direct-tip=3.0  how-to-numbered=2.5  question-hook=1.0
  proposed: direct-tip=3.0  how-to-numbered=3.0  question-hook=1.0  [how-to-numbered +0.5]

axis: cadence_preferences
  current : 5/wk  rarely threads  sometimes media  mon/wed/fri
  proposed: 5/wk  rarely threads  sometimes media  mon/wed/fri  [no change]

Evidence: HOW_TO competitor_count=2; how-to-numbered hook count=2;
          drama high in competitor corpus (ANTI-PATTERN for low-drama brand — hold);
          median engagement 249 bookmarks; confidence 0.62.

Rationale: HOW_TO archetype shows highest engagement lift in competitor corpus.
Drama high in competitor landscape but own brand voice is established low — do not raise
drama_dial. Numbered how-to hook observed 2/4 items with top engagement; recommend increasing
how-to-numbered weight. Cadence unchanged — insufficient signal. Regenerate brand-dna.md prose
via engine generate-dna after applying.

Do you consent to apply this calibration? [--consent to confirm, exit without --consent to cancel]
```

### Applying with consent

```
engine voice-calibrate --brand acme-cosmos --apply --consent
```

Pre-flight:

1. consent = true — pass
2. No gate-axis keys in proposed_diff — pass
3. $CONTENT_HOME is a git repo — pass
4. Gate-regression run on sample drafts with new voice settings — pass (HOW_TO weight +0.5 does
   not cause gate failures in the fixture calibration set)

Writes:
- `$CONTENT_HOME/brands/acme-cosmos/brand.json` — voice fields updated (HOW_TO weight 3.5,
  how-to-numbered weight 3.0; everything else unchanged)
- `$CONTENT_HOME/learning/acme-cosmos/voice-calibration-<id>.json` — status: applied, applied_by:
  human:operator, applied_at, baseline_ref, rollback_ref = same commit
- Governance sidecar
- ONE commit to the instance repo: `"voice-calibration: acme-cosmos <date> [human-applied]"`

Result: `{ ok: true, commit: "<sha>", baseline_ref: "<pre-apply-sha>", ledger_id: "<id>" }`.

### Rollback

```
engine voice-calibrate --brand acme-cosmos --rollback
```

Reverts `brand.json` voice fields to the pre-apply state via `engine/self-improve/rollback.js`
(targeting `brand.json`, not `config/system.json`). One versioned commit, one ledger event. If you
regenerated prose DNA after applying, you need to regenerate it again after rollback.

### What did not change

After applying and rolling back:

- `config/system.json` — byte-identical.
- `rules/*.md` — byte-identical.
- Gate thresholds and pass criteria — byte-identical.
- Firewall, budget caps, reviewer allowlist — byte-identical.
- `brand-dna.md` prose — unchanged by the calibration step itself (you regenerate it separately).

---

## 16. CLI verb reference

### `engine competitor-scan`

```
engine competitor-scan [options]

  --brand <id>         brand the scan is for.
  --adapter <name>     scraper adapter override (else config competitor_scan.adapter).
  --platform <p>       platform override (else config competitor_scan.provider.platform; default twitter).
  --estimate-only      show the DD-18 cost estimate; do nothing else.
  --yes                confirm the DD-18 metered-scrape gate (required for scraper adapters).
  --force              run even when competitor_scan.enabled is false (operator/test opt-in).
  --dry-run            analyze + build report, write/dispatch nothing.
  --json               emit the structured result.
  -h, --help           show this help.
```

Exit codes: `0` success/disabled/paused/overlap-skip/estimate-only; `1` run failure or
`EVERBATIMCOPY`; `2` bad args; `3` adapter configured but not registered.

### `engine voice-calibrate`

```
engine voice-calibrate [options]

  --brand <id>             brand to calibrate.
  --show                   display the pending calibration card (default).
  --apply --consent        apply the pending proposal (requires explicit --consent).
  --rollback               rollback the most recent voice calibration.
  --to-baseline <ref>      rollback to a specific instance-repo commit ref.
  --json                   emit the structured result.
  -h, --help               show this help.

Governance: HUMAN-ONLY (EHUMANONLY for machine-apply paths).
Explicit --consent required for --apply (ECONSENTREQUIRED without it).
Gate axes never touched (ENEVERLOOSEN on any smuggled gate transition).
```

Exit codes: `0` success/show/disabled; `1` `ECONSENTREQUIRED` / `ENEVERLOOSEN` / `GATE_REGRESSION_FAILED` / other failure; `2` bad args.

---

## See also

- [`agent.md`](../agent.md) — the Repo Agent Guide; §8.5 for the content-sources overview; §11 for
  the self-improvement autonomy boundary (voice calibration sits outside the machine-apply window).
- [`docs/brand-dna.md`](brand-dna.md) — the C2 Brand DNA pathway; `engine generate-dna` for prose
  regeneration after a voice calibration apply.
- [`docs/self-improvement.md`](self-improvement.md) — the DD-6 governed self-improvement loop
  (machine-apply path); voice targets are human-only and refused by `assertMachineChangeAllowed`.
- [`docs/improvement-sharing.md`](improvement-sharing.md) — the outbound sharing pathway; voice
  records are structurally refused by `sanitizeForSharing` / `evaluate`.
- [`docs/data-policy.md`](data-policy.md) — BYO-scraping posture, Zone-U trust tagging, ToS.
- [`docs/cost.md`](cost.md) — spend regimes; competitor scraping is engine-metered (DD-18).
- [`docs/trends.md`](trends.md) — sibling opt-in content source; shares the scheduler + adapter seam
  patterns.
- `templates/scheduler/` — monthly cron / PM2 / OpenClaw recipes.
- `fixtures/competitor-scan-acme/` — the zero-key synthetic fixture suite (Acme Cosmos /
  Orbit Outfitters): corpora, scan report, expected landscape analysis, expected proposal.
- `schemas/inputs/competitor-scan-report.schema.json` — the Zone-U scan report schema.
- `schemas/config/brand.schema.json` — the four new voice-calibration axis fields +
  `voice_calibration` state object.
