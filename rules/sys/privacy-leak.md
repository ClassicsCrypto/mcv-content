---
id: rule.sys.privacy-leak
title: Privacy / leak backstop for source-derived content
scope: global
category: safety
severity: hard
disposition: block
bars_recommended: false
codes: [SYS.PRIVATE_LEAK]
mutability: human-only
version: 1.0.0
provenance: shipped
tests: [gate-regression/privacy-leak/*]
---

<!-- release-spec §2.4 (the double gate), §3.3 (operator/founder/team accounts), §8.8 (a source
     feeds the EXISTING chain), §13.3 (redact-at-write), §10.1/§10.2 (SYS.* family). The prompt's
     MEMORY-SOURCE law: project memory is SENSITIVE; the memory source runs a redaction/privacy
     PRE-PASS AND the draft MUST pass a privacy/leak check in the gate BEFORE the approval card.
     Enforcement: engine/gate/privacy-leak.js (deterministic), reusing engine/shared/redact.js +
     engine/sources/work-recap/privacy-filter.js so detection matches what the pre-pass masks.
     Registered source: package (the publish-edge layer; the registry schema source enum has no
     privacy/system value), but unlike the other SYS.* codes it fires in the CONTENT path and
     routes back to the writer, not the publisher-liaison. -->

# Privacy / leak backstop (source-derived content)

The work-recap memory source distils SENSITIVE project memory (secrets, partner names, unreleased
codenames, financials, internal ids) into shareable seeds. The source runs a privacy PRE-PASS that
masks sensitive spans before the seed enters the chain. But the writer rewrites the seed into fresh
copy and could re-introduce a sensitive term it saw in the angle/proof-stack, or carry forward a
residual leak the pre-pass missed. This rule is the deterministic BACKSTOP that re-verifies the
final draft/package copy so **no human ever sees a leaked draft on an approval card** — defense in
depth, even though the human is the final backstop (§2.4).

## Where it sits in the chain

A source produces a SEED → matcher → brief → writer → the hybrid gate (pre-gate-lint + the LLM
voice/quality firewall + **this privacy/leak check**) → packager → validate-package → queue → the
HUMAN approval card (the double gate). This check runs after the writer and before the card; it also
re-runs on the edit/re-gate path (DD-12, §14.5), so a reviewer edit cannot slip a leak past the card.

## What is checked (any one ⇒ `SYS.PRIVATE_LEAK`, HARD)

- **Unresolved privacy flags from the memory source.** The source's `privacy_flags.any_redacted`
  marks that the pre-pass masked sensitive material. The gate corroborates that signal against the
  FINAL copy: if the source flagged sensitive content and the copy still trips a detector, that is a
  re-introduced leak (the worst case). A source that flagged-and-masked with CLEAN final copy is
  correctly NOT blocked — the pre-pass did its job.
- **Secret / credential shapes** in the copy — reusing the `engine/shared/redact.js` value-shape
  patterns (tokens, bearer creds, signed-URL params, long opaque blobs, prefixed-key families). The
  same engine the log redactor and the source pre-pass use, so a secret is detected identically
  everywhere. This applies to ANY draft (a credential pasted into ordinary brand copy is still a leak).
- **Sensitive structural shapes** — financial amounts and internal-id shapes, reusing the source
  privacy-filter's neutral structural patterns.
- **A configured `work_recap.private_term`** — a partner name, codename, or unreleased feature name
  the operator listed, matched verbatim with the source's regex-safe deny-list matcher. The deny set
  unions `config.work_recap.private_terms` with the originating seed's `private_terms`/`privacy_flags`.

## Honest scope

Pattern + known-name detection, NOT semantic DLP (same bar as `redact.js` / the source pre-pass,
§13.3). It cannot infer that an unflagged proper noun is a secret partner — which is exactly why the
operator extends the deny list, the source pre-pass runs first, and the human card is the final
backstop. The engine ships NO real private terms or values; the deny set is operator config.

## Codes

`SYS.PRIVATE_LEAK` — HARD, `disposition: block`, route **writer** (the seat that produced the copy;
the writer regenerates clean copy). One code is emitted per leaking variant, carrying the
variant_label and the family names that fired. The explanation NEVER echoes the matched
secret/term back — echoing it would re-leak it into the result/ledger, the exact thing this gate
prevents; the family names tell the writer which class to remove.

## Disposition

HARD ⇒ `block` (route back to the writer). It is NEVER auto-corrected: a privacy leak is never
silently masked into published copy (that would risk an awkward `[REDACTED]` in a public post and
hide a real upstream problem). It blocks and routes back so the writer regenerates. Fail-closed.

## Config gate

The work-recap source pathway is OFF BY DEFAULT (`work_recap.enabled`); the operator opts in and
supplies `work_recap.private_terms`. This check is universal for the secret-shape + structural scan
(it runs on any draft), and the configured-private-term scan is a no-op when no deny set is present —
so ordinary brand content is never penalized, and source-derived content gets the full deny-set scan.

## Example (brand: Acme Cosmos)

- A work-recap memory line `Closed a $500,000 round with Stardust Partners` is masked by the source
  pre-pass to `Closed a [REDACTED] round with [REDACTED]`. The writer, seeing `Stardust Partners` in
  the proof-stack anti-target, accidentally writes `Big news with Stardust Partners` (a configured
  private_term) ⇒ `SYS.PRIVATE_LEAK` (private_term), route back to the writer. No human sees it.
- A clean recap line `Shipped the new onboarding flow` produces clean copy ⇒ PASS; the source's
  upstream `any_redacted` flag (it masked a different line) does not block clean final copy.

## Mutability

`human-only`. A privacy/leak backstop is a top safety guardrail (alongside the fact firewall, DD-6).
It is never weakened by the machine-learning loop; the operator-maintained deny list is the only
tunable surface.
