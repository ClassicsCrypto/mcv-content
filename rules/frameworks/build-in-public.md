<!-- Source-pathway writing framework (release-spec §2.1 seeding, §3.3 operator/founder/team
     accounts + flexible voice, §9.3 frameworks). Consumed by the WRITER seat when a brief seed
     comes from the WORK-RECAP content source (engine/sources/seed.js → mapWorkRecapSeed). Brand-
     neutral; Acme Cosmos examples only. DD-9 ceiling: ships the framework CONTRACT; per-account
     voice templates and calibrated thresholds stay maintainer/operator-side. The humanizer rule
     (rule.core.humanizer) governs the no-hype-inflation discipline; the claims-safety rule
     (rule.core.claims-safety) governs the privacy/leak + fabrication checks the gate enforces. -->

# Build-in-Public Post Framework

- **Bucket:** any length (the brief still names a length bucket; this framework shapes the *voice
  and structure* of work-in-the-open content within that bucket)
- **Source:** the work-recap content source (`engine/sources/seed.js`) — a redacted recap of what
  shipped, what was learned, and what is next
- **Account class:** **operator / founder / team** (§3.3). NOT a brand account. The voice is a real
  person sharing the work, with **flexible voice** — first person, plain-spoken, opinionated. It
  does not need to feature brand IP and is not bound to brand-account media strictness.
- **Primary job:** share the honest middle of building — real progress and real open problems — so
  the audience trusts the builder and follows the journey
- **Use for:** ship updates from a founder, lessons learned, "what I changed my mind about", a hard
  problem and how it was solved, a week-in-review from the team's POV, a candid roadmap-thinking post
- **Do not use for:** brand-IP showcases, polished campaign announcements, anything that needs the
  brand's strict media rules (use the brand-account lanes for those)

## When to choose this framework

Choose build-in-public when the seed carries **concrete, specific work** distilled from project
memory and the target account is an operator/founder/team account. The strength of the post is the
detail: one true, specific thing about the work beats ten adjectives about how exciting it is.

## Core shape

Use one of these skeletal shapes (brand-neutral; pick by what the recap actually contains):

```text
[The one specific thing that happened — a real detail, named plainly]
[The honest context — why it was hard, what it took, or what it means]
[What is next, or the open question — an invitation to follow, not a sell]
```

Lessons variant:

```text
[What I believed / how we did it before]
[What changed it — the specific moment or result]
[What we do now, and what it cost to learn]
```

The shape is a scaffold, not a script. The voice is the builder's own.

## Voice (the flexible-voice contract, §3.3)

- **First person, real.** "I", "we", "the team" — a person talking, not a brand broadcasting.
- **Specific over grand.** Name the actual thing. "We cut the index rebuild from 40 minutes to 90
  seconds" lands; "huge performance wins" does not.
- **Honest about the middle.** Open problems and trade-offs are allowed and welcome — they are the
  whole point of building in public.
- **No hype-inflation.** This is the hard line (`rule.core.humanizer`): no significance inflation,
  no "not just X, it's Y", no "exciting times ahead", no follow-traps. Authentic and specific.

## Privacy (load-bearing — enforced before the approval card)

Work-recaps are distilled from **sensitive project memory** (secrets, partner names, unreleased
details, codenames). Two guardrails apply, both already on the brief seed:

- **`pre_seed.must_not_include`** — the privacy deny-set (config + recap private terms) plus the
  generic "no secrets / no unreleased detail" rules. The writer must not surface any of these.
- **`enrichment.proof_stack.fact_safety`** — the same forbidden set, which the gate's privacy/leak
  check (`rule.core.claims-safety` FM privacy/fabrication codes) enforces **before** the human
  approval card. Human approval is the final backstop.

If a true, specific detail cannot be told without revealing a forbidden term, tell a *different*
true detail. Never publish around the privacy rule by being vague-but-leaky.

## Archetype fit

Best for ship-update (operator POV), lessons-learned, decision/change-of-mind, problem→solution,
team week-in-review, and candid roadmap-thinking. Not for brand-IP showcase or scarcity/campaign
pushes.

## Anti-patterns (fail the draft)

- Hype-inflation or vague "big things coming" filler (`rule.core.humanizer`, `FM.HYPE_VOICE`).
- Negated parallelism ("not just a refactor, a rethink") — `LINT.NEGPAR` / `FM.HUMANIZER`.
- Any sensitive term from the deny-set, any unreleased partner/codename/roadmap specific, any
  secret/credential/internal-id/path (`rule.core.claims-safety` privacy codes).
- Fabricated or unbacked metrics — only numbers present in the recap (`rule.core.claims-safety`,
  `rule.core.fabrication`).
- Reads like a brand announcement instead of a person (`rule.core.voice-register`).
- A generic positive closer or a follow-trap ask (`rule.core.humanizer`).

## Writer checklist

- The post opens on one concrete, specific detail from the recap.
- The voice is first-person operator/founder/team, not a brand.
- Zero terms from the privacy deny-set; zero unreleased specifics; zero secrets/paths.
- Every number/claim is present in the recap (nothing invented).
- No hype-inflation, no negated parallelism, no generic closer.
- Length is within the brief's named bucket; platform rules pass (`rules/platform/*`).

## Example (operator account; brand context: Acme Cosmos)

```text
We rewrote the asset indexer this week. The old one re-scanned the whole library on every run.
The new one only touches what changed, so a re-index dropped from ~40 minutes to about 90 seconds.
Next up: making it resumable so a crash mid-run doesn't cost us the batch. Following along?
```

Why it passes: one specific detail (the indexer), an honest before/after with a real number from
the recap, a concrete "next" that is an open problem, first-person operator voice, no hype, no
sensitive terms.
