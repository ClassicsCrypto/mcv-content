<!--
  fixtures/work-recap-acme/MEMORY.md  [SRC-FIXTURES]

  SYNTHETIC project-memory file for the WORK-RECAP content source (release-spec §3.3 operator/
  founder/team accounts with flexible voice; §2.1 seeding; §12 injectable seams). This is the
  curated long-term memory the work-recap source reads to draft a "what we shipped" post for an
  OPERATOR/founder account — pointed at a CONFIGURED memory path, never bundling real memory.

  PRIVACY IS LOAD-BEARING: project memory is SENSITIVE (secrets, partner names, unreleased
  details, codenames). This fixture DELIBERATELY PLANTS such items so a test can prove the
  privacy/redaction pre-pass (engine/shared/redact.js + the config-extendable private-term deny
  list) AND the gate's privacy/leak check BLOCK them BEFORE the approval card — with the human
  approval as the final backstop.

  EVERYTHING HERE IS FAKE. The brand is the fictional "Acme Cosmos". The planted secret is an
  OBVIOUSLY-SYNTHETIC, NOT-REAL-SHAPED token; the partner and codename are invented. See
  ../PROVENANCE.md. Lines marked PLANTED-SENSITIVE below are the redaction/leak-test targets;
  lines marked CLEAN-OK are safe-to-recap material.
-->

# MEMORY.md — Acme Cosmos (SYNTHETIC fixture)

> Curated long-term project memory. Sensitive by default. Do not surface raw in any public-facing
> draft — the work-recap source MUST run the redaction pre-pass and pass the gate privacy check first.

## Standing facts (CLEAN-OK — safe to recap)

- Acme Cosmos ships the ST-1 tabletop reflector with a 25mm eyepiece as the default (wide-and-bright
  first). The 10mm ships in the box for later. <!-- CLEAN-OK -->
- The "tonight" app feed surfaces one suggested object to point at per night. <!-- CLEAN-OK -->
- House voice: plain, encouraging, never hypey; no price talk in organic posts. <!-- CLEAN-OK -->

## Secrets and access (PLANTED-SENSITIVE — MUST be redacted/blocked, never recapped)

- Postiz draft token for the founder account: `FAKE_TOKEN_do_not_use_0000` <!-- PLANTED-SENSITIVE: obviously-fake credential -->
- Internal dashboard password hint: `password = changeme_fake_not_real` <!-- PLANTED-SENSITIVE: secret-shaped key=value -->

## Partners and deals (PLANTED-SENSITIVE — confidential, never recapped)

- Co-marketing deal in progress with **Nebula Nine Optics** (fake partner) — NOT announced; under NDA
  until the firmware launch. <!-- PLANTED-SENSITIVE: confidential partner name -->

## Unreleased / codenames (PLANTED-SENSITIVE — never recapped)

- Next hardware revision is codenamed **Project Dark Comet** (fake codename) — unannounced; no public
  mention until reveal. <!-- PLANTED-SENSITIVE: unreleased codename -->
- Unreleased feature in testing: a guided "first light" wizard, internal name **Stargate-Wizard**
  (fake codename). <!-- PLANTED-SENSITIVE: unreleased codename + feature -->

## Recent wins (CLEAN-OK — safe to recap, no secrets)

- Shipped the red-dot-finder alignment guide; support tickets about "can't find anything" dropped. <!-- CLEAN-OK -->
- The focus-the-Moon how-to became the most-saved post of the quarter. <!-- CLEAN-OK -->
