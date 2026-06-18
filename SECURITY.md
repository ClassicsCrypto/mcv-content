# Security Policy

## Reporting a vulnerability

**Please do not open a public issue for a security vulnerability.** Public disclosure before a fix
exists puts every operator at risk.

Report privately using GitHub's
[private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
("Report a vulnerability" under the repository's **Security** tab), or email the maintainers at
**jayb@marscatsvoyage.com**. Include:

- a description of the issue and its impact;
- the affected component(s) and version/commit;
- reproduction steps or a proof of concept, if you have one;
- any suggested remediation.

We aim to acknowledge a report within a few business days and to keep you updated as we investigate.
Please give us a reasonable window to ship a fix before any public disclosure; we will credit reporters
who wish to be named once a fix is released.

### What is in scope

- The engine code in this repository (`engine/`, `bin/`, `pipelines/`), shipped schemas, rules, and CI.
- Hygiene failures that could leak secrets or instance data through the repository or its CI.

### What is out of scope

- Vulnerabilities in your **host runtime**, your **LLM provider**, **Postiz**, **Discord**, or other
  third-party services — report those to the respective project. We will, however, want to know if the
  engine misuses one of them in a way that creates a vulnerability on your install.
- Issues that require an already-compromised host (an attacker with shell access to the box running the
  engine and read access to `$CONTENT_HOME/.env`).

## Security model (stated honestly)

This is a defense-in-depth design, not a sandbox. Understand the boundaries before you operate it:

- **Trust zones.** Untrusted/scraped input (Zone U) reaches drafting seats only inside **data fences**;
  pipeline seats (Zone S) hold **no tool or config-write authority** during operation; approval and
  publish rights are the human's alone (Zone A). Operator-provided trusted input is Zone O.
- **The LLM evaluation layer is injection-exposed by nature.** Any system that puts external text in
  front of a language model can be prompt-injected. That is precisely why hard-category enforcement
  **never relies on the LLM gate alone**: a deterministic pre-gate runs before it and a deterministic
  pre-publish gate runs after it, and the final verdict carries the union of every layer's codes — an
  LLM layer can add codes but can never drop a deterministic detection.
- **The double gate is the trust signal.** Nothing publishes without an **attributed** human approval
  from the reviewer allowlist, and by default the publisher handoff creates a **draft** the operator
  publishes manually. Auto-publish exists only under mechanical trust criteria with automatic
  revocation; it is a risk-posture change, not a convenience toggle.
- **Secrets.** The only secrets location is `$CONTENT_HOME/.env` (or the process environment), resolved
  by a single resolver that terminates there — no fallback into the checkout or any unlisted path.
  Secrets never appear in config files, generated artifacts, schemas, or logs. Logs are **redacted at
  write time** (the values of every documented variable plus token-shaped patterns are masked); note
  v1 redaction is pattern/known-name masking, not semantic DLP.
- **Credential failure is fail-fast, not retry.** A `401/403`-class credential rejection halts the
  consuming component and alerts, naming the variable (never the value) — it is never put on a retry
  loop (an auth failure is permanent until the operator acts). Outages get bounded retry; misclassifying
  an auth failure as an outage is a known crash-loop failure mode we deliberately avoid.
- **No silent self-update.** Upstream changes reach an install only as versioned releases the operator
  explicitly adopts; no component fetches upstream content at runtime.
- **Hygiene is structural.** All mutable instance state lives outside the checkout (located by
  `CONTENT_HOME`); the engine refuses a `CONTENT_HOME` inside the checkout; `.gitignore` is
  deny-by-default; CI runs a hygiene scan on every PR.

## Operator responsibilities

- Keep `$CONTENT_HOME/.env` off version control and off shared storage (the shipped `.gitignore` and
  the instance-directory design make this the default — keep it that way).
- Use the **minimum** Discord channel permissions for your host runtime (no admin, no manage-guild).
- Rotate credentials when they may be exposed; see the rotate-credentials runbook
  ([`docs/runbooks/rotate-credentials.md`](docs/runbooks/rotate-credentials.md)).
- You are the data controller for any corpus you ingest; see
  [`docs/data-policy.md`](docs/data-policy.md).
