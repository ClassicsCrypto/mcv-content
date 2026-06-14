# YouTube (beta)

> **Beta lane.** YouTube publishes **via Postiz**, sharing the Twitter/X publish machinery. Its
> reliability is **upstream-dependent** on the Postiz YouTube integration; issues are triaged
> **best-effort** (support amendment A2). For the fully-supported, fully-narrated path, see the
> flagship [`twitter.md`](twitter.md).

- **Publisher:** Postiz, draft-by-default (the second gate — same machinery as Twitter/X).
- **Support status:** **beta** — upstream-(Postiz)-dependent, best-effort triage.

## What this lane supports in v1

- The full chain → gate stack → Postiz handoff path, with the YouTube packaging rule
  (`PLAT.YOUTUBE_SOURCE_SENSE_MISSING`, HARD): a YouTube package must carry a source-sense note tying
  the title/description to the actual footage. See
  [`../../rules/platform/youtube.md`](../../rules/platform/youtube.md).
- The same **second gate** as Twitter/X: approval creates a Postiz **draft** you publish by hand.

Anything the upstream Postiz YouTube integration does not support is a best-effort limitation, not an
engine defect.

## Required credentials

Set in `$CONTENT_HOME/.env` (names only — same Postiz credentials as Twitter/X):

| Variable | Required | Notes |
|---|---|---|
| `POSTIZ_API_KEY` | for publishing | Tier-1 secret; set both or neither. |
| `POSTIZ_API_URL` | with the key | |

Per brand, connect the YouTube account in Postiz and record its integration id as
`platforms[].integration_ref` in `brands/<id>/brand.json` (the C2 step). Deferrable until LIVE.

## Packager behavior

The packager produces the final YouTube post and enforces the source-sense note before handoff
(absent ⇒ `PLAT.YOUTUBE_SOURCE_SENSE_MISSING`, routed back to the packager). Media routing follows
the shared Postiz adapter behavior.

## Publish flow

Identical to the [Twitter/X flow](twitter.md#publish-flow): `approved → publish_intent →
handed_off` (Postiz draft) `→ published` once you publish the draft in Postiz and the next
`verifyStatus` poll confirms it is live. "Approved but nothing posted yet" (`handed_off`) is the
expected LIVE state.

## See also

- [`twitter.md`](twitter.md) — the flagship lane with the full first-publish walkthrough.
- [`../setup/platforms.md`](../setup/platforms.md) — connecting Postiz + recording `integration_ref`.
- [`../troubleshooting.md`](../troubleshooting.md) — stuck `handed_off`, publisher-down.
