<!--
Thanks for contributing! Please read CONTRIBUTING.md before opening this PR.
A few items below are HARD REQUIREMENTS (DCO sign-off, the never-accepted list), not preferences.
Keep this PR small and focused.
-->

## What & why

<!-- What does this change do, and why? Link the issue it closes, if any (e.g. "Closes #123"). -->

## Type of change

<!-- Tick all that apply. -->

- [ ] Bug fix
- [ ] New feature / behavior change
- [ ] Rule contribution (see the rule requirements in CONTRIBUTING.md)
- [ ] Adapter / publisher work
- [ ] Documentation
- [ ] Other (describe above)

## Tests

- [ ] I ran the full suite locally: `npm ci && npm run ci` (lint + tests + zero-key fixture run + gate regression + schema validation + hygiene scan).
- [ ] I added or updated tests covering this change.
- [ ] No new test requires a credential or a live-API call (the zero-key bar — a credentialed test is a leak surface and will be rejected).

<!-- For a rule change: confirm gate-regression fixtures (synthetic positive + negative with expected codes) ship under fixtures/gate-regression/, and every emitted code is registered in rules/codes.md. -->

## Docs

- [ ] Docs match the engine as it actually behaves (the accuracy rule). If this changes behavior, I updated the affected schema / docs / runbook in the same PR.
- [ ] N/A — this change has no documentation impact.

## Boundary confirmation — the never-accepted list (required)

I confirm this PR contains **none** of the following, anywhere (code, fixtures, examples, docs, test data, screenshots, commit messages, or this description):

- [ ] No **secrets or secret-adjacent material** (credentials, API keys, bot/session tokens, webhook URLs, signed/expiring CDN URLs).
- [ ] No **instance data** (real channel/user/guild IDs, reviewer/approver identities, real handles, real calendar values, queue contents, run residue, publish/engagement histories, learning-record instances). Schemas and templates only — never instances.
- [ ] No **scraped third-party corpora** or any derivative carrying them.
- [ ] No **brand intellectual property**. The only brand permitted in fixtures/examples is the synthetic **Acme Cosmos** (or placeholders like `<CHANNEL_ID>`, `$CONTENT_HOME`, `you@example.com`).
- [ ] No **personal data** (identity joins, holder lists, member intelligence, named-individual profiling).
- [ ] No **Tier-3 constants in engine code** (no IDs, handles, absolute paths, or canned brand strings in `engine/` — they belong in config, env, or rule frontmatter).

## DCO sign-off (required)

- [ ] Every commit in this PR carries a `Signed-off-by:` trailer (`git commit -s`). CI checks this; PRs without it cannot be merged. To add it after the fact: `git commit --amend -s` (single commit) or rebase to sign each commit, then force-push your branch.

---

By opening this PR I agree to the [Code of Conduct](../CODE_OF_CONDUCT.md) and have read [CONTRIBUTING.md](../CONTRIBUTING.md).
