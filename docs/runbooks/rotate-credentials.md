# Runbook: rotating credentials

All credentials live in **`$CONTENT_HOME/.env`** (env-only — DD-8). There are **no secrets in the
repo** and no other resolution path. Rotation is therefore always the same shape: edit one variable in
`$CONTENT_HOME/.env`, restart the consuming component, confirm with `engine status`.

> **Resolution order (the only path):** a credential resolves from `process.env` **first**, then from
> `$CONTENT_HOME/.env`, and stops — there is no third source (§4.4). A blank value counts as absent. A
> missing or **invalid** credential is **permanent**: the engine does *not* retry credential
> resolution (that would crash-loop a bad token), so a stale secret fails fast and named, never hangs.

## Where `.env` lives

`$CONTENT_HOME/.env`, the per-instance secrets file. `CONTENT_HOME` itself is **not** in this file —
it locates the file, so it is set in the process environment (the scheduler entry, the service unit,
the shell). See [`../configuration.md`](../configuration.md#5-secrets-env). The repo ships
`.env.example` as the documented template; copy keys from it, never commit a filled-in `.env`
(`.gitignore` excludes it — see [`../data-policy.md`](../data-policy.md#never-committed-never-shared)).

## The general rotation procedure

1. Generate the new secret at the provider (rotate / re-issue the key or token there first).
2. Edit `$CONTENT_HOME/.env` and replace the value of the named variable. Keep the variable name
   exactly; only the value changes.
3. **Restart the consuming component** so it re-reads `.env` (the engine does not hot-reload a
   credential — it resolves once at start and never retries on a bad value).
4. Confirm: `engine status` — the wiring self-check names each credential (present / missing), never
   the value (§15.1).

```
engine status
```

The self-check line shows e.g. `✓ discord_token`, `✓ publisher`, or the matching `✗` with a named
remediation. The exit is non-zero only when a wiring check fails.

## By credential

### Discord bot token — `DISCORD_BOT_TOKEN`

The approval surface (the reviewer-decision listener) reads this. Rotate the token at the Discord
developer portal, update `DISCORD_BOT_TOKEN` in `$CONTENT_HOME/.env`, then **restart the listener**.
A stale token produces an immediate, named "missing or invalid" failure — not a silent hang. Confirm
`engine status` shows `✓ discord_token` and that a fresh approval card still posts.

> If you run more than one process that needs the token (a listener **and** a separate daemon), update
> the **one** `$CONTENT_HOME/.env` they both read and restart **both** — a rotation that reaches one
> process but not the other crash-loops the one left on the old value.

### Publisher (Postiz) — `POSTIZ_API_KEY` + `POSTIZ_API_URL`

The publisher adapter and the analytics collector read these. Both are required for a configured
publisher; one-of-two set is reported as *partially configured*. Update both in `$CONTENT_HOME/.env`
and restart the executor (and any analytics task). A 401/403 from the publisher is an **auth failure**
— permanent, it halts publish/collection rather than retrying (§15.2). After fixing the credential,
approved-unpublished items persist and resume on the next executor tick. Postiz is **deferred** (not
required) for SAFE / LIVE_PREVIEW (§2.3), so a blank publisher there is reported as deferred, not a
failure.

### Other provider keys

Provider keys consumed by adapters and host-runtime seats follow the same env-only pattern (e.g. the
Giphy publisher reads `GIPHY_API_KEY` / `GIPHY_USERNAME`; scraping reads `APIFY_API_KEY`; host-runtime
chain-seat model keys such as `OPENAI_API_KEY` / `OPENROUTER_API_KEY` are read by the runtime, not the
engine — RD-2). The variable names are the canonical ones in `.env.example`. For every one: rotate at
the provider, replace the value in `$CONTENT_HOME/.env`, restart the consumer. Do not invent
alternate variable names — the resolver looks up the exact `.env.example` name.

## Safety notes

- **Never** put a credential in `config/system.json`, a rule file, or any repo-tracked file — config
  references behavior, `.env` holds secrets (DD-8). Every ledger/artifact write is redacted, so a
  token-shaped value cannot leak into the ledger (§13.3), but the source of truth is still env-only.
- Rotating a credential does **not** require any other engine command — no rebuild, no re-verify. Edit
  `.env`, restart the consumer, check `engine status`.

## See also

- [`../configuration.md`](../configuration.md#5-secrets-env) — the secrets section and the full
  resolution rule.
- [`../data-policy.md`](../data-policy.md#never-committed-never-shared) — what is never committed or
  shared.
- [`../troubleshooting.md`](../troubleshooting.md#missing-or-invalid-credential-fail-fast-no-retry) —
  the fail-fast credential symptom and fix.
- [`recover-from-stall.md`](recover-from-stall.md) — a publisher-down / auth-halt diagnosis.
