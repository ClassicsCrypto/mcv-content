# Manual-Grok suggestion prompts (free — no API spend)

These prompts let you use **Grok's live X access for free** (on your own grok.com / X account) to do
the *suggestion / discovery* work — find competitors, accounts to track, keywords, and monthly
breakout shifts — instead of paying for an LLM suggestion API. You run the prompt, paste the result
back, and the engine turns it into **confirmed** config.

## The flow

1. **Get the prompt.** `engine suggest prompt <kind>` prints a ready-to-copy prompt. Kinds:
   - `competitors` — ≥8 comparator/competitor accounts (brand-scoped).
   - `tracked_accounts` — accounts to watch each trend pass (competitors + creators + media).
   - `keywords` — keywords/hashtags to track each trend pass.
   - `breakout` — **monthly**: new competitors + breakout keyword trends.
2. **Run it.** Fill the `<PLACEHOLDERS>`, paste it into **grok.com** or **X with Grok**, and let Grok
   answer using live X data. (Each prompt forbids inventing handles — "if unsure, omit.")
3. **Paste it back.** Save Grok's reply to a file (or pipe it), then:
   ```
   engine suggest apply --file grok-reply.txt              # dry-run: shows the proposal
   engine suggest apply --file grok-reply.txt --yes        # confirm: APPENDS to config (dedup)
   engine suggest apply --file grok-reply.txt --brand acme --yes   # competitors/breakout need --brand
   ```
   The engine parses the `oce-suggestions` block out of the reply, validates it, shows you exactly
   what would be added, and writes **only when you confirm** (`--yes`). Additions **append + dedup** —
   your existing entries are never removed. You can edit the config before or after.

## Where each kind lands

| kind | added to |
|---|---|
| `competitors` | `brands/<id>/brand.json → ingestion.competitors` (the Apify ingest competitor corpus) |
| `tracked_accounts` | `config/system.json → trends.tracked_accounts` (the Apify trend tracking) |
| `keywords` | `config/system.json → trends.keywords` |
| `breakout` | keyword terms → `trends.keywords`; new-competitor handles → `ingestion.competitors` |

## Optional: a Discord "data ingest" channel

Prefer to paste in Discord? Create a private channel and have your host runtime forward a pasted
message to `engine suggest apply` (the parser is surface-agnostic — it extracts the `oce-suggestions`
block from any text). The engine itself owns no Discord connection; this is a host-runtime convenience.

## Governance

Suggestions are **advisory and Zone-U** (a model produced them, treated as untrusted): they only ever
configure tracking/analysis **targets** (handles, keywords) — never rules, never spend. Nothing is
written without your `--yes`. This is the same **suggest → human confirms/edits** posture the engine
uses everywhere.
