---
id: rule.core.banned-patterns
title: Banned patterns — operator-supplied phrase and construction blocks
scope: brand
category: safety
severity: hard
disposition: block
bars_recommended: false
codes: [LINT.BANNED_PATTERN, FM.BANNED_CONSTRUCTION]
mutability: human-only
version: 1.0.0
provenance: shipped
tests: [gate-regression/banned-patterns/*]
---

<!-- release-spec §10.1, §10.2, §0.3 r6 + §10.3 (engine ships ZERO banned phrases; brand-private
     terms are operator config). Deterministic phrase check: engine/gate/pre-gate-lint.js
     (LINT.BANNED_PATTERN) reads phrases from the config seam. The construction-class check is an
     LLM-gate judgment (FM.BANNED_CONSTRUCTION). DD-9 ceiling: the engine and this rule ship the
     CONTRACT and an EMPTY default list — the brand-private banned terms (which embed brand lore)
     are NEVER shipped; they live in the operator's $CONTENT_HOME. -->

# Banned patterns

Two brand-private blocklists with a brand-neutral default of **empty**: a literal-phrase list
(deterministic) and a construction-class set (LLM-judged). The engine authors zero banned phrases
(§0.3 r6) — the production stack's banned terms embed brand-private lore and are deliberately not
shipped (§10.3). Operators supply their own.

## What is checked

- **Banned phrase (deterministic).** A phrase from the operator-supplied list appears in copy.
  Fires `LINT.BANNED_PATTERN` (HARD). The list is supplied two ways, unioned:
  1. `rules.banned_patterns` passed by the gate pipeline / config (`string[]` literals or
     `/regex/flags`).
  2. `$CONTENT_HOME/config/banned-patterns.txt` (one pattern per line; `#` comments skipped),
     loaded only when `CONTENT_HOME` is set. A literal phrase matches case-insensitively and is
     whitespace-tolerant.
- **Banned construction (LLM-judged).** A banned opener/closer/construction CLASS (per the brand's
  banned-construction config) appears. Fires `FM.BANNED_CONSTRUCTION` (HARD). The shipped contract
  names that construction classes exist and are enforced; the specific banned phrases/openers are
  operator config.

## Codes

- `LINT.BANNED_PATTERN` (HARD, route **writer**)
- `FM.BANNED_CONSTRUCTION` (HARD, route **writer**)

## Disposition

Both HARD ⇒ `block`. A banned phrase or construction never ships; it routes back to the writer.

## Configuring the list (operator)

The repo ships no phrases. To block brand-private terms, add them to
`$CONTENT_HOME/config/banned-patterns.txt` or pass them through the gate config. A malformed
operator pattern is skipped, never crashing the gate, and an absent list never blocks anything.

## Example (brand: Acme Cosmos)

- An operator who never wants the literal phrase `to the moon` in Acme Cosmos copy adds
  `to the moon` to `banned-patterns.txt`; the pre-gate then fires `LINT.BANNED_PATTERN` on any
  variant containing it.

## Mutability

`human-only`. Blocklists are a guardrail (DD-6); only the operator edits them. The
machine-learning loop cannot remove entries.
