# Calibration judging rubric (public)

> The **public judging rubric** for the calibration harness (release-spec §2.5, §16.4; DD-9). It
> defines the **dimensions** a calibration sample is judged on — the quality *contract* the
> shipped ruleset is held to — so an operator can judge a sample the same way every time.

## What this rubric is — and what it is not

This is **the contract, not the calculator.** It tells you *what* to look at when you judge a
sample on-voice (the human leg of the C3 pass bar in `pass-criteria.md`). It is deliberately a
**simple, qualitative rubric**:

- It ships the **dimensions** and a plain-language description of each — what "good" looks like
  and what trips it.
- It does **not** ship calibrated weights, numeric scoring thresholds, an exemplar/gold-set
  battery, or a multi-judge methodology. Those are the maintainer's calibrated instance and stay
  maintainer-side by decision (DD-9). The public quality contract is *the shipped ruleset + this
  lightweight harness* — honestly, not a clone of the maintainer's tuned judge.
- A sample is judged **on-voice** or **not** per the operator's read of the dimensions below —
  a single human call, not a weighted sum. The pass bar counts how many of N samples cleared.

If you want the deterministic, code-enforced side of quality, that is the **gate**, defined in
`rules/codes.md` and the rule files under `rules/`. This rubric is the *human* side: voice and
fit that no lint can decide. The two are complementary — the gate decides "may it publish",
the operator decides "is it us".

## The judging dimensions

Judge each sample on these. They mirror the gate's own concerns (so a rubric judgment and a gate
verdict point the same way) without re-importing the gate's calibrated firing thresholds.

### 1. On-voice (brand fit)
Does this read like **this brand** — or could an unrelated brand post it verbatim? A sample is
on-voice when it carries a brand-specific anchor (a concrete detail, stance, or framing only this
brand would write) and matches the brand's declared tone and `drama_dial`. It is **off-voice**
when it is generic category copy, drifts off the brand's theme lane, or reads in a register the
Brand DNA rules out (hype/poster maxims for a plainspoken brand, financial talk for a non-financial
voice). *(Gate cousins: `FM.SUBSTITUTABLE`, `FM.LANE_DRIFT`, `FM.POSTER_REGISTER`,
`FM.HYPE_VOICE` — soft/voice codes.)*

### 2. Fact-safety (does every claim trace?)
Does every **falsifiable** claim — a metric, event, quantity, date, comparative, or
first/only/biggest assertion — trace to the brand's project context or a named source? A sample
is fact-safe when every checkable fact has a receipt and interpretation is clearly interpretation.
It **fails** fact-safety when it invents or inflates a fact, makes an unbacked superlative or
comparative claim, or reskins a competitor's claims as the brand's own. This dimension has **zero
tolerance** — it is the one that drives the `max_fabrication = 0` criterion. *(Gate cousins:
`FM.FABRICATION`, `FM.SUPERLATIVE_UNBACKED`, `FM.COMPARATOR_RESKIN` — hard codes.)*

### 3. Structure & argument (does the piece do its job?)
Does the piece lead with the thesis its content actually supports, carry a complete argument or a
concrete actionable anchor, and respect the brief? A sample is strong here when an announcement
names a concrete spec/date/CTA, an opinion piece has a real argument spine (claim → mechanism →
anchor → stake), and the lead is the point — not a status dump or a credential wrapper. It is
**weak** when it teases with no anchor, stacks assertions instead of arguing, or buries the thesis
under a recap. *(Gate cousins: `FM.WEAK_HOOK`, `FM.WEAK_ARG`, `FM.STATUS_RECAP`,
`FM.BRIEF_VIOLATION` — soft/quality, except brief violation which is hard.)*

### 4. Legibility & humanizer (does it read human?)
Can an informed outsider parse it, and is it free of machine-writing tells? A sample reads human
when insider shorthand is translated and the prose avoids the known tells (forced rule-of-three,
negated parallelism, stat-stacking, tutorial signposting, generic positive closers, em dashes in
the machine register). It **fails** when it is opaque jargon (IYKYK with no translation) or
carries residual machine-writing tics. *(Gate cousins: `FM.ESOTERIC`, `FM.HUMANIZER`,
`LINT.EM_DASH`, `LINT.NEGPAR`, `LINT.INFLATION`.)*

### 5. Visual fit (visual-format samples only)
For samples with media: does the asset match the brand and carry no unsolicited baked-in text? A
visual sample passes when it is on-brand and clean; it **fails** when the image is off-brand,
missing a required identity element, or has readable text/logos baked into the frame. Skip this
dimension for text-only samples. *(Gate cousins: `VIS.OFF_BRAND`, `VIS.IDENTITY_MISSING`,
`VIS.EMBEDDED_TEXT`.)*

## How to use it

For each sample in `samples/`:

1. Read the sample's **expected posture** (in `samples/samples.json` and the per-sample file) —
   what the sample is designed to exercise and whether it is meant to be a clean on-voice piece or
   to surface a specific weakness.
2. Look at the generated draft and its **gate verdict** (the deterministic + LLM codes).
3. Judge **on-voice / not** across dimensions 1–4 (and 5 if visual). It is a holistic human call:
   a sample with one minor soft warning can still be on-voice; a sample that reads generic or
   off-brand is not, even if the gate passed it.
4. Tally `gate_clear`, `on_voice`, and `fabrication_codes` across the battery and grade against
   `pass-criteria.md`.

There is **no weighted score to compute.** The dimensions are a checklist for a human judgment,
and the pass bar is a count of how many samples cleared. Keep it simple — that simplicity is the
DD-9 ceiling, on purpose.
