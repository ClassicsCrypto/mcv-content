# Brand DNA — authoring template (DD-21 cold-start)

This is the interview-driven Brand DNA template for a history-less brand (release-spec
DD-21 cold-start path). You do NOT need any past content to start: answer the questions
below in plain language, and the result becomes your brand's voice contract.

How to use:
1. Copy this file to `$CONTENT_HOME/brands/<your-brand-id>/brand-dna.md`.
2. Replace every `<...>` placeholder and answer each prompt. Delete the guidance
   comments if you like — keep the section headings.
3. Make sure `brands/<your-brand-id>/brand.json` exists (see the JSON block at the end
   of this file) and that its `paths.dna` points at this file.
4. Setup checkpoint C2 checks that a Brand DNA file is present; calibration (C3) reads
   your voice answers. Tune this file and re-run calibration if voice is off (§2.5).

Keep `drama_dial` here consistent with the `drama_dial` field in `brand.json`
(`low` | `medium` | `high`) — the voice/style rules consume both.

---

## 1. Identity

- **Brand id:** `<your-brand-id>`  (lowercase, matches the `brands/<id>/` directory)
- **Display name:** `<Your Brand Name>`
- **Account class:** `<operator | brand>`
  - `operator` = a founder/operator-owned personal account (looser media strictness).
  - `brand` = a brand/project account.
- **One-sentence description:** `<what this brand/account is, in plain language>`
- **What it is NOT:** `<the easy misread you want to avoid>`

## 2. Audience

- **Who you are talking to:** `<the primary audience>`
- **What they already believe / care about:** `<context the audience brings>`
- **What you want them to do or feel:** `<the intended response>`

## 3. Voice and tone

- **Three adjectives for the voice:** `<e.g. plain, confident, useful>`
- **Drama dial:** `<low | medium | high>`  (matches brand.json `drama_dial`)
  - `low` = understated, fact-first, no hype.
  - `medium` = some energy, still grounded.
  - `high` = bold and expressive (still inside the fact firewall).
- **Person / point of view:** `<e.g. "we" community voice, or first-person operator>`
- **How formal:** `<conversational ... formal>`

## 4. Do / Don't

- **Always do:** `<concrete habits — e.g. name the thing in plain words; show one example>`
- **Never do:** `<concrete bans — e.g. manufactured urgency; empty FOMO; emoji stacks>`
- **Words/phrases to avoid:** `<list any banned vocabulary>`
- **Words/phrases that are on-brand:** `<list signature phrasing, if any>`

## 5. Fact discipline

- **Claims that MUST be backed by a fact:** `<e.g. numbers, dates, capability claims>`
- **What is fair game as atmosphere/opinion vs. a falsifiable fact:** `<your line>`
- **Sources of truth the agent may cite:** `<links/docs the brand controls>`

## 6. Formats and platforms

- **Primary platform(s):** `<twitter, instagram, giphy, ...>`
- **Default formats:** `<single tweet, thread, feed single, reaction gif, ...>`
- **Per-platform notes:** `<anything platform-specific>`

## 7. Examples (optional but recommended)

Write 2-3 short examples IN YOUR VOICE so the agent has something concrete to match.
These are seeds, not templates to copy literally.

- `<example post 1>`
- `<example post 2>`
- `<example post 3>`

## 8. Cooldown / repetition stance (optional)

- How long before a theme/asset may be reused: `<hard_days>` / `<target_days>`.
  (Set these in `brand.json` `cooldown_overrides` to override the system default.)

---

### Companion `brand.json` (write to `brands/<your-brand-id>/brand.json`)

Validated by `schemas/config/brand.schema.json`. Replace placeholders; keep
`integration_ref` null and `auto_publish.enabled` false until you connect accounts and
go LIVE. See `templates/brand/archetypes.template.md` for the archetype catalog.

```json
{
  "schema_version": "1.0.0",
  "id": "your-brand-id",
  "display_name": "Your Brand Name",
  "account_class": "brand",
  "drama_dial": "medium",
  "cooldown_overrides": {
    "hard_days": 14,
    "target_days": 30
  },
  "paths": {
    "dna": "brands/your-brand-id/brand-dna.md",
    "archetypes": "brands/your-brand-id/archetypes",
    "corpora": "corpora/your-brand-id"
  },
  "platforms": [
    {
      "platform": "twitter",
      "publisher": "postiz",
      "integration_ref": null,
      "handle_placeholder": "@yourbrand",
      "rate_limit_per_day": 4,
      "publish_windows": [
        { "days": ["mon", "tue", "wed", "thu", "fri"], "start": "09:00", "end": "21:00" }
      ],
      "auto_publish": {
        "enabled": false,
        "qualifying_streak": 0,
        "last_revocation": null,
        "revocation_reason": null
      }
    }
  ]
}
```
