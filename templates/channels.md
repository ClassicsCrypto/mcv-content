# Discord setup checklist (host permissions + channels)

A copy-down checklist for the C1 Discord integration step. It covers host-runtime permissions and
creating the channel roles. All ids below are synthetic placeholders — replace them with your own. For
the narrated version and approval semantics, see
[`../docs/setup/discord.md`](../docs/setup/discord.md).

> Channel auto-creation is runtime-owned. If your host runtime can create channels, use that live
> connector. Otherwise use this manual checklist + `engine verify --setup c1`.

## A. Host Discord permissions

Confirm the host runtime/connector can perform these actions in the bound channels:

- [ ] View Channels / Read Messages
- [ ] Send Messages
- [ ] Embed Links
- [ ] Attach Files
- [ ] Add Reactions
- [ ] Read Message History
- [ ] Use Threads (only where you use threads)

**Never grant:** Administrator, Manage Server / Manage Guild, or any role-management permission. The
runtime only needs to read, post, react, and attach in its bound channels.

## B. Channels (create + record ids)

Create these channels (names are yours; the **role** is what config binds). Enable Developer Mode in
Discord, right-click each channel → **Copy Channel ID**, and record below.

| Role (config key)   | Purpose                                              | Required | Your channel id      |
|---------------------|------------------------------------------------------|----------|----------------------|
| `content-review`    | approval cards posted here; reviewers react          | yes      | `000000000000000001` |
| `content-published` | published-confirmation log                           | yes      | `000000000000000002` |
| `content-ops`       | daily digest + heartbeat/stall alerts                | yes      | `000000000000000003` |
| `media-bank`        | reviewer-attached / operator-staged media            | yes      | `000000000000000004` |
| `trend-readout`     | trend readouts (only if you use the trend pathway)   | optional | `000000000000000005` |

- [ ] Confirm the host runtime can see and post in each channel (channel permissions, not just server-wide).

## C. Bind the ids in config/system.json

```jsonc
"approval_surface": {
  "adapter": "discord",
  "channels": {
    "content-review":    "000000000000000001",
    "content-published": "000000000000000002",
    "content-ops":       "000000000000000003",
    "media-bank":        "000000000000000004"
    // "trend-readout":  "000000000000000005"   // optional
  }
}
```

## D. Verify

- [ ] Run `engine verify --setup c1`.
- [ ] `channel_bindings` passes (all four required roles bound to non-placeholder ids).
- [ ] `approval_surface_permissions` passes (host-managed permission expectation recorded).

If `channel_bindings` reports placeholder/unbound roles, you left a `<CHANNEL_ID>` or
`0000…` value in `system.json`. Replace it with the real id and re-run.
