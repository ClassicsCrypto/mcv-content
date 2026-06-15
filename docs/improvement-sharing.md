<!--
  docs/improvement-sharing.md — OUTBOUND improvement sharing (release-spec §17.6 doc-accuracy;
  roadmap #4; original-design-spec §2.6 Improvement Sharing; decisions.md DD-7 = option (b); DD-6
  reuse; Appendix B non-goal "opt-out telemetry ... rejected permanently"; design-review risk #7
  exfiltration + upstream supply-chain poisoning). The governance IS the feature. Documents the loop
  AND — prominently — the DD-7(b) posture, accurate to engine/improvement-sharing/{sanitize,package,
  evaluate}.js and schemas/config/system.schema.json#/properties/improvement_sharing. Written
  agent-first (RD-6); no instance constants, no production codenames (§0.3 r6) — only synthetic
  "Acme Cosmos" appears in fixtures/examples.
-->

# Improvement sharing (outbound) — opt-in, sanitized, manual-PR-only

This is the one place data flows **outbound** from your install, so it is governed harder than
anything else in the engine. The design review flagged it as the single biggest risk —
**exfiltration** of your instance data, and **upstream supply-chain poisoning** of the shipped rule
set. The whole feature is its governance, enforced **structurally** as deterministic engine code that
**refuses and throws**, not as an instruction an LLM is asked to follow.

> ## Read this first — the DD-7(b) posture (the law)
>
> 1. **OPT-IN ONLY, OFF BY DEFAULT.** Nothing in this pathway runs unless you set
>    `improvement_sharing.enabled: true`. A fresh install shares nothing and prepares nothing.
>    DD-7 **permanently rejected** opt-out/telemetry (option (c)): there is **no automatic-send path of
>    any kind**, no "default on", no env override that turns it on. (README *Non-goals*.)
> 2. **ABSTRACT RULE-DIFFS ONLY.** The only thing that can ever be shared is the **generalizable**
>    change — the abstract rule-diff structure + a rationale. **Never** instance/brand data, content
>    corpora, brand-tied performance numbers, secrets, or your configured private terms. A deterministic
>    **sanitizer** strips every specific, and a structural **guard refuses** to produce a payload that
>    still carries a brand name, a secret shape, a snowflake id, a filesystem path, a handle, or a
>    configured private term.
> 3. **SANITIZED + OPERATOR-REVIEWED BEFORE ANYTHING IS WRITTEN.** You see **exactly** the sanitized
>    payload that would be shared and must explicitly confirm. Fail-closed: disabled or unconfirmed ⇒
>    **nothing is produced** — not even a local file.
> 4. **IT NEVER AUTO-SENDS.** v1 is **manual**. The tooling only **writes a local contribution package**
>    for you to open a pull request **by hand**. **You** transmit, by hand; the engine never pushes,
>    posts, or opens a socket. This is a checked invariant, not a promise (see [§5](#5-the-no-auto-send-law-is-tested-not-promised)).
> 5. **MAINTAINER EVALUATION HARNESS ON THE RECEIVING SIDE.** An inbound contribution is **never
>    auto-merged**. A deterministic harness gates it first — it must parse as an abstract rule-diff,
>    carry no instance specifics, apply cleanly, pass gate-regression, and **not loosen any gate or
>    target a human-only surface**. A passing verdict means "a maintainer may now review it", never "it
>    was merged".

**Honest scope.** v1 is **manual and deterministic**. There is no transmission, no telemetry, no
network, no chain-LLM call anywhere in this pathway (RD-2). Sanitization, packaging, and evaluation are
plain engine code you can run and test with **zero keys** (RD-12). "Sanitized" means
**pattern + known-name redaction + a no-instance-specifics structural scan** — the same honest hygiene
the logs and the work-recap source use, **not** semantic DLP (see [§6](#6-honest-scope-what-this-is-not)).

---

## 1. Where a shared improvement comes from

Improvement sharing is the outbound continuation of the **governed self-improvement loop**
([`self-improvement.md`](self-improvement.md), roadmap #3). That loop turns reviewer/analytics signals
into governed, versioned **learning records**. A record that the operator has **promoted** — a
generalizable, machine-changeable rule-diff that proved itself locally — is the *only* admissible input
to sharing. The improvement that helped your install might help the next operator's, so the engine lets
you offer it **upstream** — but only the abstract *shape* of the change, never your brand's data.

```
   #3 self-improvement loop                    #4 improvement sharing (this doc)
   ─────────────────────────                   ────────────────────────────────────────────────
   analytics → governed proposal               sanitizeForSharing(record)   ← strip every specific
        │  (deterministic)                            │   → abstract-rule-diff payload
        ▼                                             ▼
   promoted learning record  ──────────────▶   prepareContribution(record,{payload,…})
   (machine-changeable, gate-neutral)                │   GATE 1 enabled?  GATE 2 shareable?
                                                      │   GATE 3 operator consent?
                                                      ▼
                                          $CONTENT_HOME/contributions/contribution-*.json
                                                      │   (a LOCAL file — nothing is transmitted)
                                                      ▼
                                          YOU open a pull request BY HAND
                                                      │
                                                      ▼
   maintainer side ◀────────────────────────  evaluateContribution(contribution)
                                                  shape+no-specifics · applies · gate-regression ·
                                                  never-loosen + machine-allowed   ⇒ accept/REJECT
                                                  (auto_merge: false — ALWAYS)
```

---

## 2. The outbound flow — sanitize → review → (consent) → local package

The outbound tooling is two deterministic modules. Neither one transmits.

### 2.1 `sanitizeForSharing(record, opts)` — extract-then-strip (`engine/improvement-sharing/sanitize.js`)

It keeps **only** the generalizable shape of the change and **drops** everything instance-specific by
not carrying it:

- **`target: { kind, path_shape? }`** — *which* rule/knob class the diff touches. A dotted config path
  keeps only its leading **class** segments (the knob family — `calendar.*`, `archetype.*`,
  `content_type.*`); any instance-looking leaf segment is masked. The instance artifact id is **never**
  carried.
- **`structural_diff: { structural_changes[], knob_deltas[] }`** — the gate-strictness transitions
  (`severity` / `tier` / `disposition` / `bars_recommended` — these are *vocabulary*, not brand values)
  and the **abstract knob delta** as a `direction` (`increase` / `decrease` / `set` / `no-change`) —
  **never** your brand's tuned number.
- **`rationale`** — the one surviving free-text field (the generalizable "why"), run through **three
  strip passes** (the outbound mirror of the inbound work-recap privacy pre-pass): (1) `redact.js`
  secret shapes + named credential keys, (2) the configured **private-term deny list**, (3) a
  **no-instance-specifics** pass (brand names, 17–20-digit snowflakes, operator home/user paths,
  `@handles`, brand-tied performance numbers). It never carries the raw `proposed_diff` body.
- **`provenance`** — abstract only: `derived_from: 'learning-record'`, `target_mutability`, and the
  source-signal **kinds + count** — **never** the signal refs (they are `$CONTENT_HOME`-relative
  instance paths) and never brand-tied numbers.
- **`x-sharing: { stripped, families[], flag_count }`** — an audit summary of what was stripped (the
  flag **families**, never the offending values).

**Strip-or-refuse.** Default `onResidual:'strip'` cleans residuals; `onResidual:'refuse'` makes a
residual a hard error at sanitize time for operators who want a loud failure if the input was dirtier
than expected. **Either way**, `sanitizeForSharing` ends by calling `assertShareable` on its own output —
so a payload that still trips the guard is **never returned** (fail-closed even in strip mode).

### 2.2 `assertShareable(payload, opts)` — the structural guard (the refusal)

Deep-walks **every string** (values *and* keys) of the final payload and **throws `UnshareableError`
(code `EUNSHAREABLE`)** on the first residual specific anywhere — naming the **family** and the
json-path of the offender, **never** echoing the matched value (echoing it would re-leak it). An
abstract rule-diff may carry **no** brand name, secret shape, snowflake, path, handle, or configured
private term. This is the outbound mirror of the gate's privacy/leak hard block, and it is fail-closed
by construction (a missing or non-object payload refuses).

### 2.3 `prepareContribution(record, opts)` — the consent gate + packager (`engine/improvement-sharing/package.js`)

The single export. It runs three gates **in order, fail-closed**, and returns an honest envelope
`{ ok, mode, written, enabled, consented, summary, detail[], preview?, path?, findings? }`:

| `mode` | When | What it does |
|---|---|---|
| `disabled` | `improvement_sharing.enabled !== true` | **GATE 1.** A by-design no-op. Writes nothing; `ok:true`. The feature is OFF by default. |
| `review` | enabled, **no** consent (default) | **GATE 3 not yet given.** Returns the **exact** sanitized payload + provenance in `preview` so you can inspect the verbatim bytes. **Writes nothing.** This is the default behavior. |
| `refused` | payload fails `assertShareable` | **GATE 2.** Re-checks shareability at write time (belt-and-suspenders — it never packages an un-vetted payload). `ok:false`; `findings` are redacted before they reach any caller/log. |
| `written` | enabled **and** consented **and** shareable | Writes **one local JSON file** to `$CONTENT_HOME/contributions/`. Nothing is transmitted. |

- **GATE 1 — off by default** (`contributionEnabled(config)`): `true` **only** when
  `improvement_sharing.enabled === true` (strict — never coerced).
- **GATE 2 — shareable** (`checkShareable`): runs IS-SANITIZE's `assertShareable`. The guard is
  **injectable** via `opts.assertShareable`; explicit `null` means *no guard available* and
  **fails closed** (a missing guard is never an open door).
- **GATE 3 — operator-reviewed consent**: `opts.consent === true` (strict). Absent/false ⇒ `review`
  (preview only). The provenance the package carries is instance-free —
  `operator_reviewed: true`, `transport: 'manual-pr-only'`, and source-signal **types + counts only**
  (refs and the target_artifact id are dropped).

The written package is the abstract rule-diff + rationale + the optional regression fixture +
provenance — **and nothing else**.

---

## 3. The maintainer evaluation harness (the receiving side)

`evaluateContribution(contribution, opts)` (`engine/improvement-sharing/evaluate.js`) is the inbound
defense against supply-chain poisoning. Given an inbound abstract rule-diff, it produces an
**ACCEPT/REJECT verdict before a human ever considers assimilating it**. It runs **all four** checks
(never short-circuits, so the verdict lists *every* failure a maintainer needs to triage) and returns
`{ accepted, auto_merge: false, reasons[], checks{…}, rationale }`:

| Check | What it proves | Reuses |
|---|---|---|
| **(a) shape + no instance specifics** | parses as an abstract rule-diff **and** carries no brand name / secret / snowflake / path / private term | IS-SANITIZE `assertShareable` when present (byte-identical bar), else a self-contained fallback on the same `redact.js` + privacy-filter primitives |
| **(b) applies cleanly** | the change resolves against a target without contradiction (a no-op or one-sided diff is rejected) | a dry structural check — writes nothing |
| **(c) gate-regression** | does **not** break shipped rule behavior | the canonical `scripts/gate-regression.js` over `fixtures/gate-regression` (zero-key, deterministic; injectable via `opts.gateRegression` for tests) |
| **(d) never-loosen + machine-allowed target** | does **not** target a human-only surface, and its effect does **not** make any gate more permissive | DD-6 refusals `assertMachineChangeAllowed` (→ `EHUMANONLY`) and `assertNotGateLoosening` (→ `ENEVERLOOSEN`) from `engine/self-improve/mutability.js` |

**`auto_merge` is `false` by construction** — there is no apply/merge/git/network path in this module
(DD-7 (4)). A `accepted:true` verdict means *"this passed the mechanical safety bar; a maintainer may
now review it for merit"*. Assimilation is a separate, human, out-of-band act.

The fixture ground truth (`fixtures/improvement-sharing-acme/`) shows each branch: a contribution that
**loosens 3 gate axes** ⇒ `ENEVERLOOSEN`; one that **targets a human-only/safety rule** (even while
*tightening*) ⇒ `EHUMANONLY` (human-only refusal is independent of never-loosen); one that is
gate-neutral and allowlisted ⇒ **accepted** (admissible for manual review, `auto_merge:false`).

---

## 4. Configuration — the `improvement_sharing` block

In `config/system.json`, validated by
`schemas/config/system.schema.json#/properties/improvement_sharing` (`additionalProperties: false`;
only `enabled` is required). **The whole block is absent on a fresh install — that is the OFF default.**

```jsonc
"improvement_sharing": {
  "enabled": true,                       // THE LAW: strictly true to enable; default false (off)
  "share": {
    "payload_kind": "abstract_rule_diff",// const — the ONLY shareable form (no instance/brand data)
    "include_rationale": true            // the rationale is itself sanitized; when in doubt, stripped
  },
  "private_terms": {                     // the OUTBOUND deny list (mirror of work_recap.private_terms)
    "case_insensitive": true,
    "terms": ["<partner-name>", "<codename>", "<unreleased-feature>"],
    "secret_literals": ["<an-obviously-fake-but-still-secret literal>"]
  },
  "extra_secret_keys": [],               // extra secret-bearing KEY NAMES (names only, never values)
  "require_operator_confirmation": true, // const true — DD-7(3) consent; CANNOT be set false to bypass
  "package_output_path": "improvement-sharing/outbox"  // LOCAL sink only — there is NO transmit target
}
```

Two values are **`const`** in the schema and cannot be weakened: `share.payload_kind` (only
`abstract_rule_diff`) and `require_operator_confirmation` (only `true`). There is **no** transmit
target, URL, or token field anywhere in the block — `package_output_path` is a **local directory**, the
only output sink. The deny list reuses the shared `private_terms` shape (a flat array **or**
`{ terms, secret_literals }`); the sanitizer unions it with `work_recap` / `trends` / `brand_dna`
private terms so a term you declared anywhere is an anti-target everywhere.

---

## 5. The no-auto-send law is *tested*, not promised

`assertNoAutoSendPath(filePath?)` reads the packager's **own source** and proves it requires **none** of
the forbidden transports — `http`, `https`, `http2`, `net`, `tls`, `dgram`, `dns`, `child_process`
(both bare and `node:`-prefixed), plus a bare global `fetch(` call (`FORBIDDEN_TRANSPORT_MODULES`). The
test suite asserts it against the real module, so **any future edit that adds a send path FAILS CI**.
"No automatic transmission exists" is therefore a checked invariant, not a code-review hope. If the
check ever fires it throws `AutoSendPathError` (code `EAUTOSEND`).

---

## 6. Honest scope (what this is *not*)

- **Not automatic.** v1 prepares a **local file**; **you** open the PR by hand. There is no scheduler
  hook, no "share on promote" toggle, no background sender.
- **Not telemetry / not opt-out.** DD-7 rejected opt-out/telemetry permanently. The feature is opt-in,
  off by default, and gated on explicit per-contribution consent.
- **Not semantic DLP.** Sanitization is **pattern + known-name redaction + a structural
  no-instance-specifics scan**. It cannot infer that an unflagged proper noun is confidential — that is
  exactly why the `private_terms` deny list is yours to extend, why the structural guard refuses
  fail-closed, and why **you review the exact payload** before anything is written.
- **Not auto-merge (receiving side).** The harness produces a verdict; a human merges (or not). It
  never writes, never runs git, never opens a socket.
- **Not a chain-LLM feature.** Sanitization, packaging, and evaluation are deterministic engine code,
  runnable and testable with zero keys (RD-2 / RD-12).

---

## See also

- [`self-improvement.md`](self-improvement.md) — roadmap #3, the governed loop that produces the
  promoted learning records this feature shares; the DD-6 `assertMachineChangeAllowed` /
  `assertNotGateLoosening` refusals reused by the inbound harness.
- [`data-policy.md`](data-policy.md#improvement-sharing-the-only-outbound-flow) — what may and may not
  leave the install; the *never committed, never shared* list this tooling enforces in the outbound
  direction.
- [`work-recap.md`](work-recap.md#2-the-privacy-model--read-this-first) — the inbound privacy gate this
  pathway mirrors outbound (the same `redact.js` + deny-list primitives).
- [`agent.md`](../agent.md) — the operator verbs and the no-auto-send guarantee.
- `CONTRIBUTING.md` — the contribution scope, the never-accepted list, the gate-regression-fixture
  requirement, and the DCO sign-off a manual PR carries.
