# `fixtures/work-recap-acme/` — Provenance

**Every file here is synthetic / maintainer-authored, created for this repository.** None is, derives
from, or resembles any real brand, person, account, secret, partner, product codename, or operator
instance. The only brand is the fictional **"Acme Cosmos"** (an invented backyard-astronomy /
consumer-telescope brand). Every "secret", partner, and codename below is **deliberately fake and
obviously synthetic** — planted so tests can prove the privacy gate blocks it. This satisfies the
release contract that datasets without demonstrated synthetic/operator-owned provenance never ship
(release-spec §5 preamble; model §13.3 rules 1 & 3 — regenerate-never-redact, §0.3 r6).

## What this fixture is for

The **zero-key test fixtures + injectable memory reader** for the WORK-RECAP content source
(release-spec §3.3 operator/founder/team accounts with flexible voice; §2.1 seeding; §12 injectable
seams; §13.3 redaction). It lets the work-recap source run in CI with **no keys and no network**: a
fake reader (`tests/helpers/fake-memory-reader.js`) reads this synthetic memory instead of an
operator's real, sensitive project memory (RD-12 — the memory read is dependency-injectable so CI
holds no secrets; the repo ships the MECHANISM pointed at a CONFIGURED memory path and never bundles
real memory).

**Privacy is load-bearing.** Project memory is SENSITIVE (secrets, partner names, unreleased details,
codenames). This fixture **PLANTS** such items so a test can prove two backstops fire BEFORE the
approval card: (1) the **redaction pre-pass** — `engine/shared/redact.js` (secret-SHAPED + known-name
masking) plus the **config-extendable private-term deny list** (`private-terms.json`, with `terms` for
confidential names and `secret_literals` for obviously-fake-but-still-secret strings a generic
shape-matcher can't catch); and (2) a **gate privacy/leak check** that BLOCKS any draft still carrying
a planted fragment. The **human approval card** is the final backstop.

The work-recap pathway is a **content source, not a publish bypass**: a memory read yields a pre-seed
(§2.1) that feeds the EXISTING chain — matcher → brief → writer → the hybrid gate (incl. the
privacy/leak check) → package → queue → the **human approval card** (the double gate, §2.4). Nothing
here auto-publishes; SAFE is the default.

## Files

| File / dir | What it is | Provenance |
|---|---|---|
| `MEMORY.md` | Synthetic curated long-term memory. Mixes CLEAN-OK standing facts/wins with PLANTED-SENSITIVE secrets, a partner, and codenames. | Authored-synthetic |
| `memory/2099-04-07.md` | Synthetic daily build-log MIXING clean shippable work with planted-sensitive lines (fake secret, fake partner, fake codename). | Authored-synthetic |
| `memory/2099-04-08.md` | Synthetic **CLEAN** daily build-log — every line is safe to recap; the pass case that seeds a valid recap. | Authored-synthetic |
| `private-terms.json` | The config-extendable private-term deny list the privacy pre-pass loads on top of `redact.js`: `terms` (fake partner + 2 fake codenames) and `secret_literals` (the 2 fake secret strings). | Authored-synthetic |
| `expected/leak-check.json` | Ground truth: the `must_block` fragments (with which mechanism catches each) + the `clean_day` pass assertion. | Authored-synthetic |

The consumer helper that reads these files is `tests/helpers/fake-memory-reader.js`.

## The planted sensitive items (all FAKE) and how each is caught

| Planted item | Class | Where | Caught by (free-text path) |
|---|---|---|---|
| `FAKE_TOKEN_do_not_use_0000` | secret (credential) | `MEMORY.md`, `memory/2099-04-07.md` | deny list `secret_literals` — deliberately fake/non-credential-SHAPED so `redact.js` shape patterns do NOT fire (that is what keeps it obviously synthetic); the gate blocks any draft still containing it |
| `password = changeme_fake_not_real` | secret (key=value) | `MEMORY.md` | deny list `secret_literals` (and `redact.js` sensitive-KEY masking if memory is parsed as structured key/value) |
| **Nebula Nine Optics** | confidential partner (NDA) | `MEMORY.md`, `memory/2099-04-07.md` | `private-terms.json` `terms` deny list (no secret SHAPE — deny list only) |
| **Project Dark Comet** | unreleased hardware codename | `MEMORY.md`, `memory/2099-04-07.md` | `private-terms.json` `terms` deny list |
| **Stargate-Wizard** | unreleased feature codename | `MEMORY.md` | `private-terms.json` `terms` deny list |

## Notes

- **The secret is OBVIOUSLY synthetic, not real-shaped:** `FAKE_TOKEN_do_not_use_0000` reads as a
  fake on sight and is not a valid-looking credential — it can never be mistaken for a live secret,
  yet it still triggers the redaction/leak path under test.
- **Future-dated (2099-…):** daily files sit far in the future so they're never mistaken for real logs.
- **Git-trackability:** these are `.md`/`.json` under `fixtures/` — not denied by `.gitignore` (only
  media binaries and `*.env*`/`*.token`/secret files are denied). No file here is named like a secrets
  file, so nothing is accidentally ignored; the planted "secret" is plain text content, never a `.env`.
- **No redaction baked in:** the files store the raw planted items on purpose — the WHOLE point is that
  the engine's redaction + gate must strip/block them. The expected ground truth lives in
  `expected/leak-check.json`.
