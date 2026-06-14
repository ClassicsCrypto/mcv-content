<!--
  rules/core/frameworks/ — per-length writing frameworks (release-spec §2.1, §9.3; model §10 #9).
  Shipped, REPLACEABLE assets boot-read by the writer seat's contract via repo-relative paths
  (closes the production dangling-dependency where the writer contract read untracked legacy
  files — gap §2.2 writing-frameworks row). Neutral defaults ship; operators override per brand
  in $CONTENT_HOME.

  Regenerated brand-neutral from the production writing-framework stack (§0.3 r6). DD-9 ceiling
  (§10.3): these ship the framework CONTRACT — bucket, length window, job, core shape, archetype
  fit, anti-patterns, and the writer checklist. The production stack's per-account brand
  templates and its calibrated evidence batteries ("best-performing X sits in Y char range",
  named-comparator/winner signals) are maintainer-side calibration and are NOT shipped — they
  would carry brand-private content and tuned thresholds.

  Examples use the synthetic brand "Acme Cosmos" only.
-->

# Writing frameworks

Per-length drafting frameworks the **writer** seat reads when producing the N=3 variants for a
slot. The brief names the target length bucket (and so the framework); the writer drafts to that
framework's core shape and self-checks against its checklist before saving variants.

These are **defaults**, not law. They state the contract (what each length bucket is for and how
it is shaped); they do not encode brand voice. Brand voice comes from the brand's DNA, archetypes,
and the rule stack (`rules/core/`). Operators replace or extend these per brand by dropping
override frameworks into `$CONTENT_HOME` (the §10.1 precedence rules apply: brand > platform >
global).

## The length buckets (Twitter/X reference set)

| Bucket | Length (chars, incl. spaces) | Primary job |
|--------|------------------------------|-------------|
| `one-liner` | under 100 | fast scroll-stop, quotability, visual captioning, live pings |
| `short-standard` | 101–280 | daily-driver engagement, one proof beat + one action |
| `medium-long-form` | 401–800 | one sharp argument, concise analysis, mini-guide |

The frameworks are platform-flavored to the Twitter/X flagship lane (RD-7) because that is the v1
flagship; the shapes generalize. Longer buckets (thread / article) follow the same contract
pattern and are an operator-extension point — add a framework file keyed to the bucket and point
the brief at it.

## What a framework file contains

Each framework states: **bucket + length window**, **primary job / when to choose it**, **core
shape** (a skeletal structure, brand-neutral), **archetype fit**, **anti-patterns** (fail
conditions), and a **writer checklist**. None of the shipped frameworks contain brand voice,
account templates, or calibrated evidence — those stay maintainer/operator-side (DD-9).

## Relationship to the rule stack

A framework shapes the draft; the rule stack (`rules/core/*`, `rules/platform/*`) gates it. A
draft can follow its framework perfectly and still fail the gate (e.g. a fabrication or a weak
hook). The framework is craft guidance for the writer; the codes in `rules/codes.md` are the
enforced contract.
