# Open Content Engine

**A multi-agent brand content production system you run with an AI agent.** Clone the repo, point
your agent at [`agent.md`](agent.md), and it drives setup and operation: producing platform-ready
social posts through a fixed agent chain, gating every draft, and requiring a human approval before
anything publishes.

It is shipped as a **kit plus a thin runner**: markdown agent contracts, rules, schemas, and templates
that an operator-supplied AI runtime executes, plus deterministic Node.js engine code at the edges
(scheduling, queue persistence, validation, approval capture, and publishing). It gates every draft
through a hybrid validation step with a deterministic backstop, requires an **attributed human
approval** before anything publishes, and learns from reviewer feedback through governed, reviewable
learning records.

## Who it is for

The primary user is an **operator running an agent-capable AI runtime**. The mental model is simple:
**clone the repo, feed it to an AI agent, and run.** All operational documentation is written
agent-first — an agent executes it; a human reads it.

- **Agent path (default):** point your host agent at [`agent.md`](agent.md); it drives setup and
  operation end-to-end.
- **Human path:** every step in `agent.md` and `docs/` also documents a manual procedure.

## What it is — and what it isn't

**It is:**

- a kit of agent contracts + rules + schemas + templates, plus a deterministic engine CLI at the edges;
- a **double-gated** publishing pipeline: a mandatory human approval, then a publisher draft the
  operator publishes manually;
- brand-keyed and multi-brand from day one, with a shipped, editable default ruleset and a unified
  failure-code registry;
- runtime-neutral, with **OpenClaw** as the reference runtime.

**It isn't:**

- a hosted SaaS — you run it on your own host with your own accounts and keys;
- a scraper or a bundled scraping service — manual submission and official exports are first-class;
  scraping is a bring-your-own adapter you are responsible for;
- a fully autonomous poster — the human is in the publish path by default;
- free to run (see *What it costs*).

## Mental model

```
   calendar slot                                              the two gates
        │                                                  ┌───────────────────┐
        ▼                                                  │ 1. human approval │  (mandatory)
  engine dispatches a TASK RECORD ──▶ your host runtime    │ 2. publisher draft│  (operator publishes)
        │   ($CONTENT_HOME/ledger/tasks/)   runs the chain: └───────────────────┘
        │                                                            ▲
        ▼     matcher → [enricher] → writer → GATE → media → packager → approval CARD
  the engine (deterministic) ◀──────────────────────────────────────────┘
        │   queue · validation · approval capture · publish handoff
        ▼
  all mutable state lives OUTSIDE the checkout, in the instance directory ($CONTENT_HOME)
```

The deterministic **engine** (the `engine` CLI) owns scheduling, the queue, validation backstops,
approval capture, and the publish handoff. The **agent chain** — the LLM seats — is run by your host
runtime; the engine never calls a chain-seat LLM. They meet at file-based **task records**. All
instance state lives in an external **instance directory** located by one environment variable
(`CONTENT_HOME`), so `git add -A` inside the checkout is safe by construction.

Full diagram and state machine: [`docs/architecture.md`](docs/architecture.md).

## What it costs to run

Open source does **not** mean free to run. The chain and several optional features call metered
third-party services. There are two spend regimes, and the docs always say which one you are in:

- **Engine-metered spend** — the visual gate, media generation, scraping, publisher calls, and
  **library indexing** (`engine index-library`, now shipped — it visual-tags assets through the same
  metered provider seam). The engine meters these and enforces your budget caps against them.
- **Host-runtime-owned chain spend** — the writer/gate/matcher LLM tokens. These belong to your host
  runtime's own LLM configuration; the engine is blind to them unless your runtime reports per-run
  cost. Your `monthly_cap` bounds engine-metered actions and run dispatch — **not** whole-system spend.

Cost bands are **indicative** and marked "measured as of `<date>`"; for current numbers use the
pre-run estimators `engine calibrate --estimate-only` and `engine index-library --estimate-only`
(both reflect your configured chain and providers). Full disclosure, including how to cap chain spend
at your runtime: [`docs/cost.md`](docs/cost.md).

## Quick start

The smallest path to a first approval card. Full narration:
[`docs/setup/quick-start.md`](docs/setup/quick-start.md).

1. **C0:** `git clone …` → `npm ci` → `node bin/engine.js fixture-run` (zero keys — the proof).
2. **C1 minimal:** `engine init --home <path>`; create the Discord bot application + token + invite;
   one server, four channels; `config/system.json` with one reviewer, budget caps, SAFE mode;
   instantiate six seats (orchestrator, matcher, writer, gate, packager, publisher-liaison). **Postiz
   is not needed yet.**
3. **C2 minimal:** one brand; **cold-start Brand DNA** via the authoring template — no scraping, no
   corpus, no account connection yet. (To automate it, `engine ingest-brand --brand <id>` ingests the
   operator + competitor corpus and generates the DNA + archetypes in one command; with a corpus
   already on disk, `engine generate-dna --brand <id>` runs just the generation step — see
   [`docs/brand-dna.md`](docs/brand-dna.md).)
4. **C3:** `engine calibrate --brand <id>` (mandatory; confirm the cost estimate with `--yes`).
5. **C4 minimal:** a 3-slot/week Twitter calendar; empty-library mode; no campaigns.
6. **Install the daily trigger** from `templates/scheduler/`, or skip it and use step 7's command.
7. **First run (LIVE_PREVIEW):** set mode `LIVE_PREVIEW`; run `engine run-slot <slot-id>`. Your host
   runtime picks up the dispatched task and produces a real card in `content-review` — no publish.
8. **Going LIVE:** stand up Postiz + key, connect the account (`integration_ref`); set mode `LIVE`.
   Approve a card → the executor hands off **draft-only** → the queue entry shows `handed_off` → you
   publish the draft in Postiz → it advances to `published`.

> **`handed_off` means "approved, awaiting your publish in Postiz."** That is the expected LIVE-mode
> state, not a failure (see [`agent.md` §8](agent.md)).

**Explicitly deferrable:** competitor ingestion, the media library (empty-library mode by default;
`engine index-library` visual-tags assets when you opt in, with manual `index.json` population also
available) + character sheets, additional brands/platforms, additional platform account connections,
campaigns, the media and analyst seats, the analytics loop, trend slots, Giphy. Each deferred step is
a labeled later checkpoint, resumable any time. Library indexing, folder auto-sort, and character
sheets are documented in [`docs/library.md`](docs/library.md).

## Platform scope (v1)

| Platform        | Lane                                                          | Status     |
|-----------------|--------------------------------------------------------------|------------|
| Twitter/X       | flagship text-heavy chain (Postiz handoff, draft-by-default) | supported  |
| Giphy           | direct publisher adapter                                     | supported  |
| Instagram       | via Postiz                                                   | beta       |
| Facebook        | via Postiz                                                   | beta       |
| YouTube         | via Postiz                                                   | beta       |
| TikTok          | documented manual path only                                  | out of v1  |

## Support and stability

This statement defines what "supported" means and is the basis for issue/PR triage (see
[`CONTRIBUTING.md`](CONTRIBUTING.md)):

- **Twitter/X and Giphy: supported.** Issues are triaged by maintainers.
- **Instagram, Facebook, and YouTube: beta.** These lanes depend on the upstream Postiz publisher;
  issues are upstream-dependent and triaged best-effort.
- **OpenClaw: reference runtime.** Other agent runtimes are community-supported on a best-effort basis
  against the documented host-capability contract ([`docs/runtimes/generic.md`](docs/runtimes/generic.md)).
- **Stability:** the engine code is the canonical lineage. Schemas carry a stability tag
  (`stable` / `experimental`); changes to `stable` schemas and the instance-directory layout ship with
  **migration notes** in [`CHANGELOG.md`](CHANGELOG.md). Instances adopt upgrades explicitly — nothing
  self-updates.
- The **roadmap is aspirational**, not a commitment.

## Security and trust posture

- **Double gate:** a mandatory, attributed human approval (the reviewer allowlist), then a
  publisher-side **draft** the operator publishes manually. Auto-publish exists only under mechanical
  trust criteria, never as a convenience toggle.
- **Reviewer allowlist:** only named reviewers with `approve` rights can approve; every decision is
  attributed; edits require the same rights as approvals.
- **Kill switch:** `engine pause` halts every autonomous loop in one action; budget caps hard-stop
  engine-metered spend and new-run dispatch.
- **Secrets** live only in `$CONTENT_HOME/.env`; logs are redacted at write; no instance data is ever
  committed (the instance directory lives outside the checkout).
- The LLM evaluation layer is injection-exposed by nature, which is exactly why the deterministic
  pre-gate and pre-publish layers exist and why hard-category enforcement never relies on the LLM
  alone. See [`SECURITY.md`](SECURITY.md).

## Documentation

- [`agent.md`](agent.md) — the Repo Agent Guide (start here; point your agent at it).
- [`docs/architecture.md`](docs/architecture.md), [`docs/configuration.md`](docs/configuration.md),
  [`docs/rule-authoring.md`](docs/rule-authoring.md), [`docs/extending.md`](docs/extending.md),
  [`docs/cost.md`](docs/cost.md), [`docs/library.md`](docs/library.md),
  [`docs/data-policy.md`](docs/data-policy.md),
  [`docs/observability.md`](docs/observability.md), [`docs/troubleshooting.md`](docs/troubleshooting.md).
- [`docs/trends.md`](docs/trends.md), [`docs/work-recap.md`](docs/work-recap.md) — the two opt-in
  content sources (trend automation; build-in-public from project memory).
- [`docs/self-improvement.md`](docs/self-improvement.md) — the governed self-improvement loop and its
  DD-6 governance (OFF by default; the machine touches only weightings/prioritization, never the gates).
- [`docs/setup/`](docs/setup/) — quick-start, full-setup, cold-start.
- [`docs/runtimes/`](docs/runtimes/) — OpenClaw fast path + the generic capability contract.
- [`docs/platforms/`](docs/platforms/) — per-platform setup, incl. the TikTok manual path.
- [`docs/runbooks/`](docs/runbooks/) — recurring operations (daily kickoff, approval/publish, weekly
  analytics, rotate-credentials, recover-from-stall).
- [`pipelines/`](pipelines/) — per-lane runbook contracts.

## Roadmap and non-goals

> The following section ships verbatim from the release specification's non-goals/roadmap appendix and
> is maintained in-repo. The roadmap is aspirational, not a commitment.

### Non-goals (deliberate, with rationale)

- **Generated reply/comment text.** Trend readouts suggest engagement angles only — authentic
  engagement is the operator's voice, and platforms punish automated replies.
- **Removing the human from the publish path by default.** The double gate is the product's trust
  signal; auto-publish exists only under mechanical trust criteria.
- **Opt-out telemetry or automatic upstream data sharing of any kind.** Nothing leaves an install
  without explicit operator action.
- **Bundled scraping credentials or a hosted scraping service.** Bring-your-own adapter + manual paths
  only.
- **Multi-box / distributed deployment.** One instance = one host (single-runner); HA is not a v1
  concern.
- **Redistributing third-party agent skill packs.**

### Maintainer-side by design (never shipping, by decision not omission)

The heavy evaluation system (multi-judge methodology, heavy calibration corpora and gold sets,
retrieval-accuracy ground truth, media-optimization machinery, and the optimization flywheel) stays in
the maintainers' private environment. The public quality contract is the **shipped ruleset + the
lightweight calibration harness**; user installs never execute or feed the private loop. There is no
pretense that the public gates equal the maintainers' calibrated instance.

### Shipped extensions (config-gated, OFF by default)

Two optional **content sources** ship in v1 as opt-in extensions. Both produce a *seed* that flows
through the same chain to the **human approval card** — neither bypasses the chain, and **nothing
auto-publishes**. Both are disabled until you add their config block.

A third opt-in pathway, **brand-DNA generation + competitor ingestion** (`config/system.json`
`brand_dna` block), upgrades C2 onboarding into a one-command flow (`engine ingest-brand`): ingest the operator + competitor
corpus, run a **deterministic analysis (no LLM)**, and — when a host synthesis seat is wired —
generate `brand-dna.md` + an archetype catalog. DNA synthesis is a host-runtime seat (the engine
never calls a chain/analysis LLM, RD-2) and is **metered**; it **degrades gracefully** to the manual
authoring template when no seat or corpus is present (onboarding is never blocked). Scraping is BYO
(no bundled credentials; you are the data controller), and competitor content is analyzed for
**patterns only — never republished verbatim** (enforced). See
[`docs/brand-dna.md`](docs/brand-dna.md).

- **Automated trend pathway** — `config/system.json` `trends` block. A bring-your-own trend adapter
  polls a provider you supply on a 2/4/8/12 h cadence and writes Zone-U **Trend Reports** that seed
  **reserved trend calendar slots** (never out-of-calendar); a manual-submission path needs no keys.
  Metered and external; ships with a reference adapter (BYO key) and a zero-key fixture adapter. See
  [`docs/trends.md`](docs/trends.md).
- **Work-recap / build-in-public** — `config/system.json` `work_recap` block. Turns **your own
  project memory** into founder/operator-voice build-in-public posts. **Privacy is load-bearing:**
  memory is sensitive, so a redaction pre-pass + a gate privacy/leak check sit in front of the
  mandatory human approval, the mechanism reads a configured memory path and **never bundles or
  commits memory**, and nothing auto-publishes. See [`docs/work-recap.md`](docs/work-recap.md).

### Roadmap (in intended order; each lands only with its governance)

1. **Trend-pathway depth** — readout automation polish, additional providers, monthly competitor scan
   (the trend source itself is shipped above).
2. **Automated Brand DNA generation + competitor ingestion flows** — *shipped* as the
   config-gated brand-DNA pathway above (the one-command `engine ingest-brand` flow: ingest → analyze
   → generate; `engine generate-dna` runs the generation step alone over an already-ingested corpus;
   remaining roadmap depth: richer scraper adapters and tuning).
3. **Governed self-improvement loop** — *shipped* (governance-first): machine-applied learning records
   land **only** inside their DD-6 governance — a structural human-only boundary (guardrails/gate/
   hard-fail thresholds are never machine-changed), the never-loosen invariant, an evidence threshold,
   canary → observe → promote/auto-rollback, versioned one-step rollback via the instance repo, and
   **OFF by default** behind the kill switch. The machine touches only calendar weightings and
   archetype/content-type prioritization — never the gates. Deterministic engine code (no chain LLM);
   an optional host analyst seat refines proposal prose only. See
   [`docs/self-improvement.md`](docs/self-improvement.md).
4. **Improvement-sharing automation** — outbound sanitize/consent tooling + a maintainer evaluation
   harness; v1 is manual, opt-in, sanitized rule-diff PRs only.
5. **Monthly competitor scan + consent-gated voice calibration.**
6. **Additional approval surfaces** (Slack-class) behind the card schema; additional publisher
   adapters; per-seat LLM-provider routing.
7. **TikTok publishing** — when the upstream publisher path verifies truthfully.
8. **Discord channel auto-creation** — safe, idempotent, minimal-permission (replacing v1's manual
   checklist).
9. **Operator notification extensions.**
10. **Instagram/Facebook/YouTube graduation from beta** as the Postiz paths prove out.

## License and contributing

Licensed under the [Apache License 2.0](LICENSE). See [`NOTICE`](NOTICE) for attributions. Optional
third-party agent skill packs are **not** redistributed here — they are installed separately by the
operator.

Contributions require a [Developer Certificate of Origin](https://developercertificate.org/) sign-off
(`Signed-off-by:` on every commit) — see [`CONTRIBUTING.md`](CONTRIBUTING.md) for the contribution
scope, what is **never** accepted (instance data, scraped material, brand IP, secrets), and the triage
tiers. To report a vulnerability, see [`SECURITY.md`](SECURITY.md). All participation is governed by the
[Code of Conduct](CODE_OF_CONDUCT.md).
