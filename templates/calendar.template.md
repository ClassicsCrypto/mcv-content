# Calendar — <YOUR BRAND>

Copy this file to `$CONTENT_HOME/calendar/calendar.md` and edit the rows. The kickoff
batch and the optional tick read the `## Slots` table below to decide what to produce
each day (release-spec §6.5, DD-22). Everything here is a PLACEHOLDER — replace it.

The calendar OWNS the clock time assigned to each slot. Times are interpreted in the
timezone configured in `config/system.json` `scheduler.timezone` (default UTC). Rows
that do not parse are skipped, never fatal — but a well-formed table avoids surprises.

## Timezone

- Slot times below are 24-hour `HH:MM` in your `scheduler.timezone`.
- Set that timezone in `config/system.json` (e.g. `"timezone": "America/New_York"`).

## Slots

Column contract (order matters — the parser reads positionally):

| Column            | Meaning                                                                                  |
|-------------------|------------------------------------------------------------------------------------------|
| `slot_id`         | Unique, stable id. Convention `<brand>-<day>-<pos>`. Used for weekly dedup.              |
| `brand`           | Brand id (matches a `brands/<id>/` directory).                                           |
| `platform`        | Platform descriptor id (`twitter`, `instagram`, `giphy`, `facebook`, `youtube`, ...).    |
| `day`             | Day of week: `mon` `tue` `wed` `thu` `fri` `sat` `sun`.                                   |
| `time`            | Clock time `HH:MM` (24h) in the calendar timezone.                                       |
| `pillar`          | Content pillar / theme lane label (your taxonomy). Optional — leave blank if unused.     |
| `content_type`    | Content-type label (`tweet-text`, `thread`, `feed-single`, `reel`, `reaction-gif`, ...). |
| `command_family`  | One of `RUN_SLOT` `RUN_BATCH` `RUN_CAMPAIGN` `RUN_TREND_MANUAL`.                          |
| `format`          | Format passed to the command (`single tweet`, `thread`, `feed single`, `reaction gif`).  |
| `slot_type`       | `regular` (default), `trend`, or `campaign` (claimable by a campaign's slot_pattern).    |
| `state`           | `active` (the scheduler fires it) or `dormant` (skipped; put the reason in notes).       |
| `notes`           | Free text: theme hint, constraint, or why it is dormant.                                 |

| slot_id            | brand        | platform  | day | time  | pillar     | content_type | command_family | format        | slot_type | state   | notes                                  |
|--------------------|--------------|-----------|-----|-------|------------|--------------|----------------|---------------|-----------|---------|----------------------------------------|
| acme-mon-01        | acme-cosmos  | twitter   | mon | 09:00 | product    | tweet-text   | RUN_SLOT       | single tweet  | regular   | active  | Monday flagship post                   |
| acme-wed-01        | acme-cosmos  | twitter   | wed | 14:00 | community  | thread       | RUN_SLOT       | thread        | regular   | active  | Midweek thread                         |
| acme-fri-01        | acme-cosmos  | instagram | fri | 12:00 | product    | feed-single  | RUN_SLOT       | feed single   | regular   | active  | Friday visual                          |
| acme-fri-02        | acme-cosmos  | giphy     | fri | 15:00 | community  | reaction-gif | RUN_SLOT       | reaction gif  | regular   | dormant | enable once a Giphy lane is configured |
| acme-tue-trend-01  | acme-cosmos  | twitter   | tue | 11:00 |            | tweet-text   | RUN_TREND_MANUAL | single tweet | trend     | dormant | reserve for a manual trend pass        |

<!--
Authoring tips:
- Keep slot_id stable: changing it makes the weekly dedup treat it as a new slot.
- Set a slot dormant (and note why) instead of deleting it, so its id stays reserved.
- A `campaign` slot_type lets a campaign (see templates/campaign.template.md) claim and
  re-theme the slot during its window via slot_pattern matching.
- Add as many rows as you need; one row = one recurring weekly cadence entry.
-->
