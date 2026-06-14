---
id: rule.platform.youtube
title: YouTube packaging rules
scope: platform
platforms: [youtube]
category: packaging
severity: hard
disposition: block
bars_recommended: false
codes: [PLAT.YOUTUBE_SOURCE_SENSE_MISSING]
mutability: human-only
version: 1.0.0
provenance: shipped
tests: [gate-regression/platform-youtube/*]
---

<!-- release-spec §10.1, §10.2 (PLAT.* family), §14.1 layer 3, RD-7 (YouTube = beta via Postiz).
     Deterministic enforcement: engine/gate/platform-gates.js (youtube module). -->

# YouTube packaging rules

Per-platform deterministic gate for the YouTube beta lane (RD-7). A YouTube package must carry a
source-sense note tying its title/description to the actual footage, so the copy cannot claim
things the video does not support.

## What is checked

- **Source-sense note.** A YouTube package must carry a source-sense note that names the actual
  media and confirms the title/description/caption claims are supported by it; absent ⇒
  `PLAT.YOUTUBE_SOURCE_SENSE_MISSING` (HARD).

## Code

- `PLAT.YOUTUBE_SOURCE_SENSE_MISSING` (HARD, route **packager**).

## Disposition

HARD ⇒ `block`. The packager attaches the source-sense note.

## Example (brand: Acme Cosmos)

- An Acme Cosmos YouTube package whose title claims a reveal the footage does not show, with no
  source-sense note, fires `PLAT.YOUTUBE_SOURCE_SENSE_MISSING`.

## Mutability

`human-only`. Platform packaging rules are descriptor-bound guardrails (§12.6); not tunable by the
machine-learning loop.
