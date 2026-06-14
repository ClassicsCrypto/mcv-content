# Campaign template

A campaign is a named, time-bounded content sequence that CLAIMS matching calendar
slots during its window and overrides their default theme (release-spec §8.7). It
publishes ONLY through the calendar — it never adds out-of-calendar posts.

How to use:
1. Copy the JSON block below into `$CONTENT_HOME/campaigns/<your-campaign>.json`.
2. Fill in the placeholders. The shape is validated by
   `schemas/config/campaign.schema.json`. Validate your edit against that schema
   (the `engine verify` setup gate checks instance config against the schemas).
3. Make sure the calendar (templates/calendar.template.md) has slots whose `slot_id`
   matches `slot_pattern` for the brand/platform you target.

Claim rule (§8.7): a campaign claims a slot when today is within `[start_date,
end_date]`, the slot's `brand` and `platform` are in this campaign's lists, AND the
slot's `slot_id` matches `slot_pattern`. On conflict, the campaign with the EARLIEST
`start_date` wins.

```json
{
  "schema_version": "1.0.0",
  "name": "acme-launch-week-1",
  "start_date": "2099-01-01",
  "end_date": "2099-01-07",
  "brands": ["acme-cosmos"],
  "platforms": ["twitter"],
  "slot_pattern": "acme-*",
  "messaging_goals": {
    "2099-01-01": "Launch announcement: name the offer in plain language; no hype.",
    "2099-01-03": "Show one concrete capability with a real example.",
    "2099-01-05": "Recap the week; invite questions."
  },
  "voice_notes": null,
  "assets": [],
  "success_signals": null,
  "state": "draft",
  "claim_percentage": null,
  "priority": null
}
```

## Field reference

- `schema_version` — campaign shape version (currently `1.0.0`).
- `name` — unique campaign id / human-readable name.
- `start_date` / `end_date` — ISO `YYYY-MM-DD`, inclusive; `end_date` >= `start_date`.
- `brands` — brand ids the campaign applies to (>= 1).
- `platforms` — platform descriptor ids the campaign applies to (>= 1).
- `slot_pattern` — glob (`*` supported) matched against `slot_id`. Examples:
  `acme-*` (all of a brand's slots), `acme-tue-*` (Tuesdays), `acme-tue-01` (exact).
- `messaging_goals` — per-day theme text, keyed by ISO date. The value replaces the
  slot's default pillar theme for that date (pre-seed input to the brief).
- `voice_notes` — optional campaign-specific voice/tone notes (or `null`).
- `assets` — optional CONTENT_HOME-relative library references to reuse (no absolute
  paths, no drive letters, no `..`).
- `success_signals` — optional free text on what to watch for in post-campaign analytics.
- `state` — `draft` (parked) or `active` (claims slots during its window).
- `claim_percentage` — DOCUMENTED, not enforced in v1 (every match is claimed).
- `priority` — DOCUMENTED, not enforced in v1 (earliest `start_date` still wins).
