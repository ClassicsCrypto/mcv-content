# Contributing to Open Content Engine

Thank you for your interest in contributing. This project is open source under
[Apache-2.0](LICENSE), and we welcome bug reports, fixes, rule contributions, adapter work, and
documentation. Please read this whole file before opening a pull request — a few rules here are
**hard requirements**, not preferences.

## Developer Certificate of Origin (DCO) — required

We use the [Developer Certificate of Origin](https://developercertificate.org/) instead of a CLA.
Every commit MUST carry a `Signed-off-by:` line certifying you wrote the contribution or have the right
to submit it under the project's license. Add it automatically with:

```
git commit -s -m "Your message"
```

This appends a line like:

```
Signed-off-by: Your Name <you@example.com>
```

CI checks for the sign-off; PRs without it cannot be merged. Use your real name and a reachable email.
If you forgot, amend (`git commit --amend -s`) or rebase to add sign-offs and force-push your branch.

## What is **never** accepted (this is the boundary, not a guideline)

This is a public, instance-free repository. The following MUST NOT appear in any contribution —
including code, fixtures, examples, docs, test data, screenshots, commit messages, or PR descriptions.
A PR containing any of it will be closed without merge regardless of its technical quality:

- **Secrets or secret-adjacent material** — credentials, API keys, tokens, bot tokens, session keys,
  webhook URLs, signed/expiring CDN URLs. The only secrets file anywhere is `$CONTENT_HOME/.env`, which
  lives outside the checkout and is git-ignored.
- **Instance data** — real channel/user/guild IDs, reviewer/approver identities, real handles, real
  calendar slot values, queue contents, run residue (briefs, drafts, gate reports, packages,
  previews), publish histories, engagement data, or learning-record instances. Ship **schemas and
  templates**, never instances.
- **Scraped third-party corpora and any derivative carrying them** — comparator banks, account
  scrapes, captions/transcripts, profiling data. This includes your own scraped corpus.
- **Brand intellectual property** — Brand DNA, brand context/lore, archetype catalogs with derived
  content, learned voice files, brand visual packs, character sheets, strategy/audit docs. The only
  brand permitted in fixtures and examples is the synthetic **Acme Cosmos** (or obvious placeholders
  like `<CHANNEL_ID>`, `$CONTENT_HOME`, `you@example.com`).
- **Personal data** — wallet↔identity joins, holder lists, member intelligence, named-individual
  profiling.
- **Tier-3 constants in engine code** — no IDs, handles, absolute paths, or canned brand strings in
  `engine/`. All instance constants live in config, env, or rule frontmatter. The CI hygiene scan
  enforces ID-shaped patterns, absolute paths, token-shaped strings, and writes outside `CONTENT_HOME`.
- **Third-party agent skill packs.** They are not redistributed here; reference them as optional
  installs with provenance, never bundle them.

Fixtures are **regenerated clean, never redacted copies** — every fixture file must have a provenance
statement in `fixtures/PROVENANCE.md` establishing synthetic or maintainer-authored origin. If you are
unsure whether something is instance data, assume it is and leave it out.

## How to contribute

### Bugs and features

1. Search existing issues first. If none matches, open one using the issue template.
2. For non-trivial changes, open an issue to discuss before writing code, so we agree on the approach.
3. Fork, branch from the default branch, make your change, and open a PR using the PR template.

### Code contributions

- **Match real behavior.** Docs and tests must match the engine as it actually behaves (the accuracy
  rule). If you change behavior, update the affected schema/docs/runbook in the same PR.
- **Run the suite locally:** `npm ci && npm run ci` (lint + tests). CI runs the unit/characterization
  suite, the zero-key fixture run, gate regression, JSON-schema validation, failure-code registry
  integrity, and the hygiene scan — all with **zero secrets and no live-API calls**. Do not add a
  test that requires a credential; that contradicts the zero-key bar and is a leak surface.
- Keep changes small and focused. Prefer the smallest change that solves the problem.

### Rule contributions (special requirement)

Rules live in `rules/` as markdown with machine-readable YAML frontmatter, anchored to the unified
failure-code registry (`rules/codes.md`). A rule contribution MUST:

- carry valid frontmatter (`id`, `scope`, `category`, `severity`, `disposition`, `codes`, `mutability`,
  `version`, `provenance`, `tests`);
- register every code it emits in `rules/codes.md`;
- ship **gate-regression fixtures** — for each rule, synthetic positive and negative examples with the
  expected codes, under `fixtures/gate-regression/`. Rule changes are tested against previously judged
  content before merge; a rule with no regression fixtures will not be accepted.
- respect mutability: guardrail/safety rules are `mutability: human-only`. v1 ships every soft code as
  `disposition: warn` (demotion is carried by `bars_recommended`); do not add a `correct` disposition
  without discussion — that application path is feature-gated.

Calibrated judgment heuristics, scoring weights, and exemplar batteries are **maintainer-side** and do
not belong in the public ruleset; contribute the *contract* (what is checked, the codes, tiers,
dispositions), not a tuned model.

### Documentation contributions

Normative-behavior docs (setup, configuration, schemas, workflow, validation, error handling) must not
contradict the code or each other — that is a release blocker. Cost bands and KPI reference ranges are
explicitly indicative and marked "measured as of `<date>`"; updating a stale band is welcome and is a
docs fix, not a behavior change.

## Improvement sharing (rule-diff PRs)

The v1 posture is **manual, opt-in, sanitized rule-diff PRs only**. If your install learned something
generally useful, you may contribute an abstract rule-diff — sanitized and operator-reviewed by you
before it leaves your install. There is **no** automated transmission of any kind; nothing leaves an
install without your explicit action.

## Issue / PR triage tiers

Triage follows the support tiers in the README:

- **Twitter/X and Giphy (supported):** maintainer-triaged.
- **Instagram / Facebook / YouTube (beta):** upstream(Postiz)-dependent; triaged best-effort.
- **Non-reference runtimes** (anything other than OpenClaw): community-supported, best-effort.
- **Security issues:** do **not** open a public issue — follow [`SECURITY.md`](SECURITY.md).

## Code of Conduct

By participating you agree to abide by the [Code of Conduct](CODE_OF_CONDUCT.md).
