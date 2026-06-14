---
id: rule.core.claims-safety
title: Claims safety — fact firewall, superlatives, causal advisory, tense
scope: global
category: safety
severity: hard
disposition: block
bars_recommended: false
codes: [FM.FABRICATION, FM.SUPERLATIVE_UNBACKED, FM.COMPARATOR_RESKIN, FM.UNVERIFIED_CAUSAL, LINT.TENSE_SLIP]
mutability: human-only
version: 1.0.0
provenance: shipped
tests: [gate-regression/claims-safety/*]
---

<!-- release-spec §10.1, §10.2, §10.3 (fabrication/claims-safety incl. unverified-causal advisory
     and unbacked-superlative classes), §14.4 (advisory handling). The deterministic tense check
     is engine/gate/pre-gate-lint.js (LINT.TENSE_SLIP); the fact-firewall codes are LLM-gate
     judgments. DD-9 ceiling: this file ships the CONTRACT — the classes of claim each code
     governs and the one operative test (the "screenshot" test). The calibrated firewall
     heuristics, the per-brand exemplar batteries, and the project-context receipt store that
     decide whether a specific claim is verified are maintainer-side / operator data and are NOT
     shipped. -->

# Claims safety (the fact firewall)

Guards FALSIFIABLE FACTS. It does not guard argument or atmosphere. The single operative test for
every line:

> **Could a hostile reader screenshot this and disprove it with a receipt?**

- **Yes** ⇒ it is a checkable factual claim; the firewall governs it.
- It is interpretation/argument (a causal link between facts that are each verified) ⇒ advisory,
  not fabrication.
- It is vivid/atmospheric tone with no falsifiable claim ⇒ not the firewall's business; the
  brand's drama posture (a per-brand config dial) governs it.

The CONTRACT below ships. The calibrated firewall judgment (how strictly to read a claim, the
worked exemplar set) and each brand's verified-fact source (its project-context receipts) are
maintainer-side / operator data, not shipped repo content (DD-9, §10.3).

## The claim classes and their codes

1. **Invented or inflated fact ⇒ `FM.FABRICATION` (HARD).** A new falsifiable
   fact/metric/event/quantity/date that does not trace to the brand's verified-fact source or a
   named source, OR an inflation of a real one (e.g. a small real figure described as
   "thousands"; a few months described as "for years"). The screenshot-disprovable core.
2. **Comparative / superlative / uniqueness claim ⇒ `FM.SUPERLATIVE_UNBACKED` (HARD)** unless a
   verified receipt backs the exact claim. A checkable ranking / first / only / biggest / best /
   most claim. Uniform-strict for ALL brands (fact integrity, not voice) — a high-drama brand
   still cannot claim a superlative without proof. A superlative is NOT "saved" by an adjacent
   verified number unless the receipt backs the superlative itself.
3. **Comparator reskin ⇒ `FM.COMPARATOR_RESKIN` (HARD).** A competitor/comparator's voice, claims,
   stats, campaign pressure, or proper nouns copied in as the brand's own.
4. **Causal / thesis inference ⇒ `FM.UNVERIFIED_CAUSAL` (ADVISORY, non-blocking).** The cited
   facts are EACH verified, but the line asserts a causal/interpretive LINK between them ("X is
   why Y") that is the brand's argument, not an audited statistic. See "Advisory" below.
5. **Historical-tense slip ⇒ `LINT.TENSE_SLIP` (HARD, deterministic).** An entity the brief marked
   [HISTORICAL] is framed in present-continuous tense (a finished event described as ongoing).

## Advisory (`FM.UNVERIFIED_CAUSAL`) — non-blocking

A causal inference between verified endpoints is a legitimate, often ideal, line. It is emitted as
an **advisory**: it does NOT change the verdict and does NOT bar the Recommended slot — the
variant stays `PASS` and Recommended-eligible. The advisory rides onto the approval card as a note
for the reviewer's approval decision (§14.4). Guardrail: the firewall still applies to the
endpoints — if either fact is unverified or inflated it is `FM.FABRICATION` (HARD) first and the
causal layer is never reached. (`FM.UNVERIFIED_CAUSAL` is registered tier `soft` for schema
purposes; the verdict mapping treats it as non-blocking per this rule.)

## Codes

- `FM.FABRICATION` (HARD, route **writer**), `FM.SUPERLATIVE_UNBACKED` (HARD, route **writer**),
  `FM.COMPARATOR_RESKIN` (HARD, route **writer**), `LINT.TENSE_SLIP` (HARD, route **writer**),
  `FM.UNVERIFIED_CAUSAL` (advisory, non-blocking, route **writer** if it ever escalates).

## Disposition

The four HARD codes ⇒ `block` (route back). The advisory is non-blocking. No `correct` disposition
applies — fabrication and superlatives are never auto-corrected (RD-21; §14.4).

## Anti-loophole

- An inflated number is fabrication, not drama: atmosphere never licenses a checkable
  exaggeration.
- A superlative is not saved by an adjacent verified number unless the receipt backs the
  superlative itself.
- If genuinely unsure whether a line is a checkable fact or interpretation, treat it as a fact
  (run the firewall). The uncharitable default is preserved for the HARD lane.

## Example (brand: Acme Cosmos)

- Fabrication (HARD): `Acme Cosmos drew 10,000 players in week one.` (no receipt)
- Superlative-unbacked (HARD): `the biggest launch in the category.` (no receipt backs "biggest")
- Advisory (non-blocking, PASS): `208 submissions became 18 builds; that co-creation is why the
  beta sold out.` (both numbers verified; "is why" is the argument)

## Mutability

`human-only`. The fact firewall is the top safety guardrail (DD-6). It is never weakened by the
machine-learning loop; brand verified-fact sources are operator-maintained.
