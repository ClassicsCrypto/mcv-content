# Giphy (direct publisher)

Giphy is the v1 **second platform** and the engine's one **platform-direct** publisher (RD-7): it
does *not* go through Postiz. An upload to Giphy goes live immediately — there is no draft / second
gate to publish from. So Giphy's safety is a **fail-closed dual env-gate** (RD-11), preserved
exactly inside the adapter.

- **Workflow class:** visual-heavy (GIF/video first).
- **Publisher:** `giphy` (platform-direct, registered through the §12.3 seam).
- **Support status:** **supported** — gets maintainer triage.

## What this lane supports in v1

- Uploading a **GIF or short video** (`.gif`, `.mp4`, `.mov`, `.webm`) to your Giphy channel, either
  from a local media file or a remote `source_image_url`.
- **Tags** (at least one required; deduped case-insensitively, trimmed, capped at **20**).
- Optional `source_post_url`, `country_code` (default `US`), and `region`.

Giphy's public API exposes **no per-asset engagement metrics** in v1, so `fetchMetrics` honestly
returns `{ supported: false }` rather than fabricated numbers.

## Required credentials

Set in `$CONTENT_HOME/.env` (names only):

| Variable | Required | Notes |
|---|---|---|
| `GIPHY_API_KEY` | Giphy lane only | Tier-1 secret. Read **only** inside the Giphy adapter (RD-11). |
| `GIPHY_USERNAME` | Giphy lane only | Tier-3 identifier. The leading `@` is stripped automatically. |

In `brand.json`, the Giphy lane uses `publisher: "giphy"` and leaves `integration_ref` null (it is a
Postiz concept). The key is resolved lazily — only at the moment of a confirmed-live upload, inside
the adapter.

## The dual env-gate (RD-11)

A live upload requires **both** opt-ins; absent either, nothing goes live:

| `GIPHY_UPLOAD_LIVE` | `GIPHY_APPROVED_LIVE` | Outcome |
|---|---|---|
| unset | (any) | **Dry-run.** Validates the request (tags, file, MIME) and returns without any network call. The SAFE/preview path — not an error. |
| `1` | unset | **Blocked, fail-closed.** Throws `PLAT.GIPHY_LIVE_UNAPPROVED`; never silently promoted to live. |
| `1` | `1` | **Live upload** (also needs a resolvable `GIPHY_API_KEY`). |

The adapter also honors per-call equivalents (`options.live`, `options.confirmed_live`) the executor
sets, but the env gates are the operator-facing controls. As with every adapter, a `TEST-`-prefixed
`content_id` or `ENGINE_TEST_MODE=1` can **never** reach a real upload — there is no bypass.

## Packager behavior

The visual-heavy lane sources/validates the media; the Giphy adapter then:

- **Normalizes tags** — splits a comma string or array, trims, dedupes case-insensitively, caps at 20,
  and requires at least one. An empty tag set fails validation (`PLAT.GIPHY_INVALID`).
- **Strips the `@`** from the username.
- **Validates the media** — the file must exist and carry a supported extension (or a
  `source_image_url` must be supplied instead). The adapter does **not** re-probe media (no ffprobe);
  duration/dimension validation is the packager / visual gate's job.

## Publish flow

```
approved
  → publish_intent     (write-ahead intent — DD-4)
  → handoff:
       no gate         → dry-run (validated, nothing live)        → held
       gate1 only      → BLOCKED (fail-closed)                     → error
       both gates      → upload → PUBLISHED immediately            → published
```

Because Giphy is direct-publish, a successful upload is **live at once** — `handoff` returns
`published` (with the gif id as `external_ref` and a `https://giphy.com/gifs/<id>` URL), not
`handed_off`. There is no draft to publish by hand. `verifyStatus` simply confirms the gif still
resolves at Giphy: a resolving id is `published`, a 404 is `not_found`, and an uninterpretable
response is `unverifiable` (never a fabricated published).

## See also

- [`../setup/platforms.md`](../setup/platforms.md) — Giphy credential setup.
- [`twitter.md`](twitter.md) — the flagship draft-gate lane (contrast: Giphy has no second gate).
- [`../extending.md`](../extending.md#publisher-adapters) — the §12.3 seam the direct path routes through.
- [`../../rules/platform/limits.md`](../../rules/platform/limits.md) — media/tag limits.
