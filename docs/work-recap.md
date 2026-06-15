<!--
  docs/work-recap.md — the work-recap / build-in-public pathway (release-spec §2.1 seeding;
  §3.3 operator/founder/team accounts with flexible voice; §2.4 the double gate; §8.8 a source feeds
  the EXISTING chain; §12 seams + RD-12 injectable; §13.3 redact-at-write; original-design-spec §1.4).
  Accuracy rule §17.6: this documents shipped behavior. The pathway ships CONFIG-GATED and OFF BY
  DEFAULT. PRIVACY IS LOAD-BEARING — the privacy model (§2 below) is the most important section.
  Regenerated clean (§13.3 r4): no instance constants, no production persona codenames (§0.3 r6).
-->

# Work-recap (build-in-public)

The work-recap pathway turns **your own project memory** — the running log of what you built, shipped,
fixed, and learned — into **build-in-public** content: authentic "here is what we actually shipped"
posts in a **founder / operator / team voice**. It is a **content source**: it produces a **seed**
that flows through the *same* chain as any other content — matcher → brief → writer → the hybrid gate
→ packager → queue → the **human approval card**. It does **not** bypass the chain, and **nothing it
produces auto-publishes.** SAFE is the default mode.

> **It ships OFF by default.** No memory is read until you opt in with a `work_recap` block in
> `config/system.json` that points at a memory path **you** configure. The repo ships the *mechanism*;
> **it never bundles, reads, or commits any real memory.**

It targets **operator/founder/team accounts**, not the brand's primary account (spec §3.3). The
operator account is registered as a brand entry with `account_class: operator` and gets a flexible,
plain-spoken founder voice — distinct from the brand's marketing voice.

---

## 2. The privacy model — read this first

**Project memory is sensitive.** It contains secrets, partner names, unreleased product details,
codenames, financial figures, and internal IDs. Turning it into *public* content is exactly the kind
of thing that leaks confidential material if done carelessly. This pathway is built so that **leaking
is hard by construction**, with four independent layers between your memory and a published post:

```
  your configured memory path
        │   (read-only; never copied into the repo, never committed)
        ▼
  1. REDACTION PRE-PASS  ── strips secret-shaped values + your private-term deny list,
        │                    BEFORE anything becomes a shareable seed
        ▼
  2. the seed carries SANITIZED summaries only (raw memory is dropped) + privacy_flags
        │
        ▼
  3. PRIVACY / LEAK CHECK in the gate ── re-verifies the draft; HARD-BLOCKS on residual leakage
        │                                  BEFORE the approval card is ever posted
        ▼
  4. MANDATORY HUMAN APPROVAL ── the reviewer sees the final text and is the last backstop
        │
        ▼
  nothing publishes until a named reviewer approves — and even then it lands as a draft (the second gate)
```

### Layer 1 — the redaction pre-pass (the mechanism)

Before any memory-derived text can become a seed it is run through a privacy pre-pass
(`engine/sources/work-recap/privacy-filter.js`) that masks:

- **Secret-shaped values** — reusing the same write-time redactor the logs use
  (`engine/shared/redact.js`): credential/token/key shapes and the §4 credential variable names.
- **Neutral structural shapes the repo can ship safely** — currency/financial amounts and
  internal-ID shapes (e.g. `PROJ-1234`). The repo ships **only** these neutral patterns — **never any
  real term.**
- **Your config-extendable private-term deny list** (`work_recap.private_terms`) — the
  instance-specific confidential material a generic shape-matcher *cannot* know: partner names,
  unreleased codenames, internal project names. This is the layer **you** extend per instance.

**Honest scope:** this is **pattern + known-name redaction, not semantic DLP.** It cannot infer that
an unflagged proper noun is a secret partner. That is precisely why the deny list is
operator-extendable **and** why layers 3 and 4 sit downstream. The pre-pass raises `privacy_flags`
recording *what family* was masked (a non-reversible fingerprint — never the sensitive term itself,
which would re-introduce the leak).

### Layer 2 — the seed carries sanitized summaries only

The seed handed to the chain contains **sanitized summaries** and a build-in-public **angle** — never
raw memory. The raw lines are dropped at the source boundary; only the masked summary travels. The
seed also carries the aggregate `privacy_flags` so the downstream gate has something to enforce
against, plus a `must_not_include` deny-set (the sensitive *terms* the writer must not surface — these
are public anti-targets, not the secret values, which were already stripped).

### Layer 3 — the privacy / leak check in the gate

The draft must pass a **privacy / leak check inside the hybrid gate** *before* the approval card is
constructed. The same `sanitizeText` / `sanitizeItems` functions are exposed so the gate can
re-verify residual leakage on the *generated draft* (not just the seed), and the deny-set rides on the
gate's claims-safety fact-safety input. Your configured `work_recap.private_terms` are also
**auto-armed into the deterministic pre-gate** (they ride into the lint deny-list and fire
`LINT.BANNED_PATTERN`), so a writer-reintroduced configured term is blocked on the **first** gate
with no LLM spend — you do not need to copy them into `banned_patterns` yourself. **Residual leakage
hard-blocks the draft** — it never reaches a reviewer.

### Layer 4 — mandatory human approval (the final backstop)

Like all content, a work-recap draft reaches a **named reviewer's approval card** in
`content-review`, and **nothing publishes without an attributed approval** (DD-17; model §2). Even
after approval it lands as a **draft** in the publisher (the second gate, §8.3) that the operator
publishes manually. The mechanism is automated; **the judgment is not.**

> **The repo ships the mechanism pointed at a configured path. It never bundles or commits memory.**
> Your memory lives at the path you configure (outside the checkout); the synthetic
> `fixtures/work-recap-acme/` material is the only "memory" in the repo, and it is entirely invented
> "Acme Cosmos" data (see its `PROVENANCE.md`).

---

## 3. The work-in-the-open intent

Build-in-public works when it is **specific and honest**, and fails when it is hype. The seed steers
the writer accordingly (`rules/frameworks/build-in-public.md`):

- **Proof, not promise.** Frame posts as proof-of-progress: a concrete thing that happened, a real
  detail — not "big things coming".
- **Specific beats grand.** One true detail outperforms ten adjectives. Only numbers actually present
  in the memory may appear — **no fabricated metrics.**
- **Founder/operator voice (§3.3).** Plain-spoken and authentic; it should read like a person who did
  the work, not a brand announcement.
- **The honest middle of building.** Real progress and real open problems, not a victory lap.

The memory format the source understands is the same lightweight daily-log convention the agent
already uses — `[HH:MM] ✅ <what was done>` lines in `MEMORY.md` and `memory/YYYY-MM-DD.md`. Work
signals (shipped / built / fixed / launched / merged …) flag a line as a shareable work item;
skip/deferred lines and headers are ignored.

---

## 4. Configuration (the `work_recap` block)

Add a `work_recap` block to `config/system.json`. It is read defensively and **fails closed** —
`enabled` must be **strictly `true`**; anything else leaves the pathway OFF.

```jsonc
"work_recap": {
  "enabled": true,                 // the OFF-by-default gate — strictly true to opt in
  "memory_path": "<absolute path to YOUR memory directory>",  // configured by you; never bundled
  "files": ["MEMORY.md", "memory/*.md"],   // default; an exact file and a single dir/*.md wildcard
  "lookback_days": 3,              // default 3 — only recent work qualifies
  "brand": "<operator-brand-id>",  // the account_class=operator brand this recap targets (§3.3)
  "account": "<founder/team account ref>",  // scoping for the founder/operator account
  "private_terms": ["Nebula Nine Optics", "Project Dark Comet"],  // YOUR deny list (see §2)
  "max_items": 40                  // cap on extracted work items, keeps a seed focused (default 40)
}
```

| Key | Default | What it does |
|---|---|---|
| `enabled` | `false` | the off-by-default gate; strictly `true` opts in |
| `memory_path` | — | the path to **your** memory (outside the checkout). Missing/empty/absent path = a clean no-op, never an error |
| `files` | `["MEMORY.md", "memory/*.md"]` | the file globs scanned under `memory_path` (an exact file, and a single `dir/*.md` wildcard — no glob dependency) |
| `lookback_days` | `3` | only work dated within this window qualifies (daily-log files get their date from the filename; undated curated `MEMORY.md` is kept) |
| `brand` | — | the operator/founder brand (registered `account_class: operator`) the recap targets |
| `account` | — | the specific operator/founder/team account scope |
| `private_terms` | `[]` | **your** config-extendable deny list — partner names, codenames, internal project names (the privacy layer you own, §2) |
| `max_items` | `40` | cap on extracted work items per seed |

> `private_terms` may also be a `{ "terms": [...], "secret_literals": [...], "case_insensitive": true }`
> object (the shape `fixtures/work-recap-acme/private-terms.json` uses): `terms` for confidential
> *names*, `secret_literals` for obviously-fake-but-still-sensitive exact strings that are not
> credential-shaped. Both are forbidden-to-print anti-targets the gate enforces.

**Privacy is load-bearing and these are pointers, not copies.** `memory_path` is *read*; nothing under
it is copied into the repo or committed. Keep your memory directory **outside** any repo with a remote
(the same rule as `$CONTENT_HOME`).

---

## 5. How a recap becomes a post

1. **Scan** (`scanMemory`): the source reads the configured `memory_path`, extracts recent raw work
   items within the lookback window. OFF-by-default; a missing/empty path is a clean no-op.
2. **Privacy pre-pass + seed** (`buildWorkRecapSeed`): the raw items go through layer 1 and become a
   sanitized **build-in-public seed** — summaries + an angle + `privacy_flags`. The seed is
   trust-zone `O` (operator-provided, post-redaction) but the forbidden set still travels so the gate
   enforces it.
3. **Into the chain:** matcher → brief → writer → the **hybrid gate (including the privacy/leak
   check, layer 3)** → packager → queue → the **human approval card (layer 4)**.
4. **Approve → second gate:** an approved card lands as a **draft** the operator publishes manually
   (§8.3). Nothing auto-publishes.

The fixture command `fixtures/work-recap-acme/commands/run-work-recap.json` shows a `RUN_SLOT`
targeting a founder-voice slot end to end (against the synthetic Acme Cosmos memory).

**Testability (RD-12 — zero keys in CI):** all file-system access is injectable (`opts.fs`), exactly
like the visual-model seam (§12.5). Tests drive the whole source with an in-memory fake reader and
**carry no secrets, no real paths, no network**. The leak-check ground truth lives at
`fixtures/work-recap-acme/expected/leak-check.json`.

---

## 6. What this pathway will and will not do

- **Will:** read **your** configured memory, sanitize it through the redaction pre-pass + your deny
  list, seed a build-in-public draft in a founder/operator voice, and run it through the full chain
  to a human approval card.
- **Will not:** read any memory while disabled; bundle, copy, or commit your memory into the repo;
  carry raw memory into the seed; publish anything without a named reviewer's approval; surface
  secrets, partner names, or codenames the deny list and gate catch; or substitute its redaction for
  your judgment — **the human reviewer is the final backstop.**

## See also

- [`data-policy.md`](data-policy.md#project-memory-as-a-sensitive-source) — memory as a sensitive source.
- [`configuration.md`](configuration.md#3-configsystemjson-system-scope) — the `work_recap` block alongside the rest of `system.json`.
- [`architecture.md`](architecture.md#5-trust-boundaries-zones-u--o--s--a) — trust zones and the gate.
- [`trends.md`](trends.md) — the sibling trend source (the other opt-in content source).
- `rules/frameworks/build-in-public.md` — the build-in-public writing framework the seed points at.
- [`SECURITY.md`](../SECURITY.md) — the leak-class posture and reporting.
