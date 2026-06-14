# FM.BANNED_CONSTRUCTION — positive (LLM-judged, not executed in CI)

Brand: Acme Cosmos. The shipped contract names the banned construction CLASSES; specific banned
phrases are operator config. This example uses a banned opener/closer CLASS the rule recognizes.

In a world where most projects overpromise, Acme Cosmos delivers. So without further ado, let's
dive in. Buckle up, because what happened this weekend will blow your mind.

---

Why a calibrated judge fires `FM.BANNED_CONSTRUCTION`: banned opener/closer construction classes
appear ("In a world where...", "So without further ado, let's dive in", "Buckle up, because..."),
per the brand's banned-construction rule. HARD (`block`), routes back to the writer. Distinct from
the deterministic operator-phrase check (LINT.BANNED_PATTERN), which matches literal phrases.
