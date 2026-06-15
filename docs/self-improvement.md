<!--
  docs/self-improvement.md — the GOVERNED self-improvement loop (release-spec §8.9; roadmap #3;
  original-design-spec §2.6 self-improvement; §3.1 never-loosen; DD-6 the governance trust boundary;
  §15.4 kill switch; RD-2/RD-12 deterministic zero-key). Documents the loop AND — prominently — its
  governance, accurate to engine/self-improve/{mutability,evaluate,_governance,apply,canary,rollback}.js
  and schemas/config/system.schema.json#/properties/self_improve. Written agent-first (RD-6); no
  instance constants, no production codenames (§0.3 r6).
-->

# The governed self-improvement loop

The engine learns from performance data. **v1 ships analytics + learning-record *creation*** — the
system measures what worked and writes **proposed** Learning Records that a **human applies by hand**
(the behavior documented in [`runbooks/weekly-analytics.md`](runbooks/weekly-analytics.md)). This
document describes the next step on the roadmap (#3): the **governed machine-application loop** —
deterministic engine machinery that can *apply* a narrow class of improvements on its own, **but only
inside a governance cage that ships with it and is the whole point of the feature.**

> **The governance is the feature.** The application machinery never ships without its governance, and
> the governance is built *first* and enforced *structurally* — as deterministic engine code that
> **refuses and throws**, not as an instruction to an LLM. If you read nothing else, read
> [§2 The governance (DD-6)](#2-the-governance-dd-6).

> **OFF by default (the LAW).** The whole loop is config-gated and disabled unless you set
> `self_improve.enabled: true` (and even then the `PAUSED` kill switch overrides it). A fresh install
> never machine-applies anything; learning records stay proposed and human-applied.

---

## 1. What the loop is — and is not

**It is** a deterministic pipeline that turns the *existing* engagement analytics
(`engine/analytics/engagement/`: collector → baselines/outliers → performance report) into bounded,
auto-applicable proposals for a **small, closed set of content-preference knobs**, applies an
auto-applicable one in a **limited canary scope**, observes it against the pre-change baseline, then
**promotes or auto-rolls-back** — every step a versioned commit to the instance repo, logged to the
event ledger.

**It is not** an open-ended "the AI rewrites itself" loop. It can never touch a guardrail, a gate, a
hard-fail threshold, or any human-only artifact (see §2). It **never calls a chain LLM**: the
governance and the application are deterministic engine code (RD-2 / RD-12 — testable with zero keys).
An optional host **analyst seat** may *refine the prose* of a proposal (rationale only); it can never
change a target, a knob value, the evidence math, or a classification, and the loop degrades to
identical behavior when no seat is wired.

### The two halves, and where they live

| Half | Module(s) | What it does |
|---|---|---|
| **Evidence / proposal** | `engine/self-improve/evaluate.js` | Derives deterministic proposals from analytics; classifies each as **auto-applicable** vs **proposed-only**; writes proposed records. **Never applies anything.** |
| **Governance substrate** | `engine/self-improve/_governance.js` | The machine-allowed-knob registry, the config gate, the kill-switch check, the evidence-bar evaluator, the instance-repo git substrate, the governance sidecar. |
| **The two structural refusals** | `engine/self-improve/mutability.js` | `assertMachineChangeAllowed` (throws `EHUMANONLY`) and `assertNotGateLoosening` (throws `ENEVERLOOSEN`). The safety core. |
| **Application** | `engine/self-improve/apply.js` | The *only* place a change is applied; runs every gate in order, applies in canary scope, versions + ledgers. |
| **Canary → promote/rollback** | `engine/self-improve/canary.js` | Observes a canaried change for N cycles; promotes on clean, **auto-rolls-back on regression**. |
| **Rollback** | `engine/self-improve/rollback.js` | One-step revert to the pinned baseline (by record, last change, or pinned ref). |

> **Scope.** v1 ships this as **engine code (the governed-loop machinery)** plus the deterministic
> analytics that feed it, driven by the **wired, live** `engine improve` / `engine rollback` verbs
> (§4) — or, equivalently, by invoking the governed-loop module functions (`applyGovernedChange`,
> `runCanaryCycle`, `rollbackLastChange`, …) directly from a scheduler hook. The governance guarantees
> below hold regardless of how the loop is triggered — the refusals are structural, not CLI-gated.

---

## 2. The governance (DD-6)

Six invariants. Each is enforced **structurally** — the design makes the unsafe action *impossible to
express*, rather than asking a model not to take it. They are checked **in order, fail-closed**: any
single failure means **no change**.

### (1) The HUMAN-ONLY boundary — guardrails, the gate, and thresholds are never machine-changed

The machine may touch **only** an explicit allowlist of content-preference knobs:

- **calendar weightings** — how much of each slot/content type to schedule;
- **archetype / content-type prioritization** — the order/preference of generation inputs;
- **explicitly machine-tunable dials within human-set bounds** (e.g. a per-account drama dial).

**Everything else is human-only, always:** any `rules/*.md` carrying frontmatter
`mutability: human-only`, all guardrail/safety-category rules, the gate, hard-fail and pass
thresholds, the firewall, budget caps, the reviewer allowlist, publish posture, the mode ladder, and
the kill switch. The classifier **fails closed**: anything it cannot *positively* prove is a
machine-changeable knob defaults to human-only.

This is two independent checks, by design (defence in depth):

- `_governance.js` keeps a **closed registry** (`MACHINE_ALLOWED_TARGETS`) — a learning record whose
  `target_artifact` is not a registered knob is refused before any write (`TARGET_NOT_MACHINE_ALLOWED`).
- `mutability.js` is the **canonical classifier**: `assertMachineChangeAllowed(target, change)`
  classifies the target and **throws `HumanOnlyViolation` (code `EHUMANONLY`)** for any human-only
  surface. There is no flag to bypass it — refusing is the function's only behavior on a human-only
  target. The applier calls it *before* touching disk.

> A `learnable` rule (per [`rule-authoring.md`](rule-authoring.md#5-mutability-and-learning-records))
> means a learning record may be *created* for it — it does **not** put rule-body editing on the
> machine-application allowlist in v1. Machine application is confined to the three knob classes above.

### (2) NEVER-LOOSEN (original-design-spec §3.1) — a machine change can never make a gate more permissive

Even on a machine-changeable target, `assertNotGateLoosening(target, change)` inspects the change's
**effect** along the gate-strictness axes the gate contract defines and **throws `NeverLoosenViolation`
(code `ENEVERLOOSEN`)** on any loosening:

- severity / tier `hard → soft`;
- disposition `block → correct → warn`;
- `bars_recommended` `true → false`;
- a numeric gate threshold moved in the permissive direction (direction must be *declared*, else it is
  treated as a possible loosening — fail-closed);
- **widening a human-set bounds envelope** (the machine may only tune *within* human bounds, never
  widen them).

A content-preference reweighting carries **no gate axis**, so it passes; a malformed proposal that
smuggled in a gate-axis transition is refused. This is belt-and-braces with (1): even a mis-scoped
allowlist entry still cannot loosen a gate. The applier also re-clamps every proposed value to the
human-set `weight_range` and structurally asserts the canary touched **only** scoped keys and removed
no human-set key.

### (3) The EVIDENCE THRESHOLD — never act on thin evidence

A record is auto-applicable **only** when its supporting analytics clear **every** configured bar
(`self_improve.evidence`):

- `min_sample_size` (default **12**, floored at the analytics outlier-sample floor of **3**);
- `min_confidence` (default **0.8**) — a deterministic confidence proxy monotonic in both sample size
  and effect magnitude (n=1 never earns confidence);
- `min_effect_size` (default **0.2** — a 20% lift over baseline).

Below the bar the record **stays `proposed`** (human-applied — the v1 behavior). The evidence math is
deterministic and is read from the *same* place by both the evaluator and the applier, so their
decisions always agree (`evaluate.isAutoApplicable` ↔ `_governance.evaluateEvidence`).

### (4) CANARY → OBSERVE → PROMOTE / ROLLBACK

An auto-applicable change is never applied broadly. `apply.js` lands it in a **limited canary scope**
first (`governance_state: canary`) — a deterministic slice (`scope_fraction`, default **0.25**) of the
proposed knob keys, the rest of the human config untouched. `canary.js` then observes it for
`observe_cycles` (default **2**) against the pre-change baseline median from the same analytics:

- **clean for the required cycles** → **PROMOTED** (`governance_state: promoted`, kept);
- **regression at any cycle** (primary metric drops ≥ `rollback_on_regression_pct`, default **0.1**,
  below baseline) → **AUTO-ROLLED-BACK** (reverted via `rollback.js`).

Fail-closed throughout: an unobservable or erroring canary is left in place and re-observed next
cycle — it is **never** auto-promoted on missing data.

### (5) VERSIONED, with one-step rollback

Every machine change is a **versioned commit to the `$CONTENT_HOME` instance git repo** that
`engine init` created (the local-only, no-remote repo). The applier commits the mutated
`config/system.json`, the schema-conformant applied learning record (`status: applied`, with a
`rollback_ref` pinned to the pre-change `HEAD`), and a governance sidecar **as one change**. If the
instance is *not* a git repo, the applier **refuses** (`NO_INSTANCE_REPO`) — no versioning ⇒ no change
(we never apply an unrevertable change). Rollback is one step (§4): `rollback.js` reverts the touched
config to the pinned baseline ref and flips `governance_state: rolled_back`, itself a versioned,
auditable commit.

### (6) OFF by default, kill switch, and a full audit trail

- **OFF by default:** the loop does nothing unless `self_improve.enabled` is **strictly `true`**.
- **Kill switch (§15.4):** the `PAUSED` sentinel (`engine pause`) halts the entire loop — application,
  canary observation, everything — **regardless of `enabled`**. `_governance.isPaused` fails closed
  (if it cannot even resolve the sentinel path, the loop is treated as halted).
- **Auditable + reversible:** every action — applied, refused, observed, promoted, rolled-back — is
  appended to the event ledger (`$CONTENT_HOME/ledger/events.jsonl`) under a `self-improve` bucket and
  surfaced by `engine status`. Refusals are logged too, so a structural `EHUMANONLY` / `ENEVERLOOSEN`
  refusal is visible, not silent.

### The governance state machine

```
                          self_improve.enabled === true  AND  not PAUSED
                                          │
   proposed ──(evidence below bar)──────▶ stays proposed (HUMAN-APPLIED — the v1 behavior)
      │
      │ auto-applicable: machine-knob target + learnable + not gate-loosening + evidence clears bar
      ▼
   apply.js  ──guards in order──▶  [0] kill switch  [1] enabled  [2] human-only + never-loosen
      │                            [3] evidence bar  [4] instance-repo present   (any fail ⇒ REFUSED)
      ▼
   governance_state: CANARY  (limited scope, versioned commit, ledgered)
      │
      ├── clean for observe_cycles ──────────────▶ PROMOTED  (kept; versioned + ledgered)
      └── regression (≥ rollback_on_regression_pct) ▶ ROLLED_BACK  (one-step revert; versioned + ledgered)
```

---

## 3. The deterministic flow (no chain LLM)

1. **Derive proposals** — `evaluate.evaluateForImprovement` reads a performance report and/or explicit
   calendar slot signals and proposes a **bounded reweighting** for the machine knobs only. Effect size
   = relative lift of the row's primary metric vs the overall baseline; the delta is capped to
   `max_weight_delta` and the resulting weight clamped into `weight_range`. Same inputs ⇒ same proposals.
2. **(Optional) analyst refinement** — if a host analyst seat is wired, it may return a **rationale
   string** only. The proposal is deep-cloned before it is handed over, so the seat cannot mutate the
   deterministic change; a throwing or absent seat degrades to identical behavior.
3. **Classify** — each proposal is stamped `auto_applicable` (clears every governance check) or left
   `proposed-only`, and written as a proposed learning record (`status: proposed`,
   `governance_state: proposed`) via the v1 writer (redacted, atomic). This module **never** advances
   `governance_state` past `proposed`.
4. **Apply (governed)** — `apply.applyGovernedChange` runs gates 0–4 in order, applies in canary scope,
   versions all three artifacts as one instance commit, and ledgers `self_improve_applied_canary`.
5. **Observe** — `canary.runCanaryCycle` advances one observation cycle per call (per-record or a sweep
   of all in-flight canaries); promotes or auto-rolls-back per (4).
6. **Roll back** — `rollback.*` reverts to the pinned baseline on demand or on regression.

---

## 4. Operator surface — the verbs and the autonomy boundary

The loop is driven by two wired, live verbs plus the existing kill switch:

| Verb / action | What it does |
|---|---|
| `engine improve` | Evaluate analytics → derive governed proposals → apply auto-applicable ones in canary, observe, and promote/rollback. Honors the config gate + kill switch; refuses any human-only / gate-loosening / below-threshold / unversioned change. |
| `engine rollback` | **One-step revert** of the most recent machine change to its pinned baseline (or a record / pinned ref). Always available while the instance is a git repo. |
| `engine pause` / `engine resume` | The kill switch (§15.4) — `pause` halts the loop in one action regardless of `self_improve.enabled`. |
| `engine status` | Surfaces every loop action: the last `self-improve` event, in-flight canaries, promotions, rollbacks, and refusals (auditable, never silent). |

**The autonomy boundary, in one line:** the machine may re-weight *what to make more of* (calendar
weightings, archetype/content-type prioritization, bounded dials) — it may **never** change *what gets
through the gate* (guardrails, the gate, hard-fail thresholds, publish posture). Two authorities
never move to the machine and are unaffected by this loop: **approving content for publication** and
**publishing a draft** (see [`agent.md`](../agent.md)).

See [`agent.md` §11](../agent.md) for the verb table and the privilege model.

---

## 5. Configuration — the `self_improve` block

In `config/system.json`, validated by `schemas/config/system.schema.json#/properties/self_improve`
(`additionalProperties: false`; only `enabled` is required). Full key reference in
[`configuration.md`](configuration.md#the-self_improve-block-governed-self-improvement). Minimal
enable:

```jsonc
"self_improve": {
  "enabled": true,                       // THE LAW: strictly true to enable; default false
  "evidence": {                          // DD-6 (3): every bar must clear, else stays proposed
    "min_sample_size": 12,               // floored at 3 (the analytics outlier-sample floor)
    "min_confidence": 0.8,
    "min_effect_size": 0.2               // 0.2 = a 20% lift over baseline
  },
  "canary": {                            // DD-6 (4)
    "observe_cycles": 2,                 // cycles observed before promote/rollback (>= 1)
    "scope_fraction": 0.25,              // the limited canary slice
    "rollback_on_regression_pct": 0.1    // auto-rollback if the metric drops this far below baseline
  },
  "allowlist": {                         // DD-6 (1)+(2): the ONLY machine-changeable targets + bounds
    "targets": ["calendar_weighting", "archetype_priority", "content_type_priority"],
    "bounds": {
      "max_weight_delta": 0.15,          // max move per machine step
      "weight_range": { "min": 0, "max": 1 },
      "dials": [{ "name": "<dial-id>", "min": 0, "max": 1 }]  // explicitly machine-tunable dials
    }
  },
  "analyst_seat": {                      // OPTIONAL host seat — refines PROSE only; degrades when absent
    "seat": "fixture"
  }
}
```

The `targets` enum is **closed** to the four DD-6-allowed classes (`calendar_weighting`,
`archetype_priority`, `content_type_priority`, `tunable_dial`). **No entry here can be a guardrail, the
gate, or a hard-fail threshold** — that is the human-only boundary the applier never crosses, enforced
structurally regardless of what the allowlist says.

---

## 6. Cost

The loop's machinery is **deterministic engine code and free to run** — it derives proposals from
analytics already on disk, calls no provider, and never invokes a chain LLM (RD-2). The only metered
element is the **optional** analyst seat: if you wire one, it is a host-runtime seat that spends your
own provider tokens (host-runtime-owned spend, like the chain seats), and the loop runs identically —
deterministic proposals only — when it is absent. See [`cost.md`](cost.md) for the spend-regime split.

---

## See also

- [`runbooks/weekly-analytics.md`](runbooks/weekly-analytics.md) — the v1 (human-applied) learning-record
  review loop this feature builds on.
- [`rule-authoring.md`](rule-authoring.md#5-mutability-and-learning-records) — the `mutability`
  frontmatter (`human-only` / `learnable`) the classifier reads.
- [`configuration.md`](configuration.md#the-self_improve-block-governed-self-improvement) — the
  `self_improve` config block, and the provenance classes (`machine-learned`).
- [`observability.md`](observability.md) — `engine status` and the event ledger that audit every loop action.
- [`architecture.md`](architecture.md) — the engine/agent split and the instance directory.
