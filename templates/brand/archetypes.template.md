# Archetype template

An archetype is a reusable CONTENT PATTERN the matcher selects for a slot. Each archetype
is ONE file in your brand's archetype catalog directory
(`$CONTENT_HOME/brands/<your-brand-id>/archetypes/`). The matcher picks an archetype id
for a slot and uses it to seed the brief's angle, hook, and must-include elements
(release-spec §9.2; brief schema `archetype` + `pre_seed`).

How to use:
1. Create the catalog directory: `brands/<your-brand-id>/archetypes/`.
2. Copy this template to one file PER archetype, e.g. `archetypes/announcement.md`,
   `archetypes/teaching-thread.md`, `archetypes/reaction-gif.md`. The FILENAME (minus
   extension) is a convenient archetype id.
3. Fill in the fields. Add as many archetypes as you have recurring content patterns.

Cold start (DD-21): you do NOT need archetypes to begin. An empty catalog is fully
supported — add archetypes later as you learn what works. The setup checkpoint that
verifies the catalog honors a `cold_start: true` marker on the brand to treat an empty
catalog as an intentional cold start rather than a misconfiguration. (Note: in v1 the
`brand.json` schema does not yet declare `cold_start`, so adding it there will not pass
`engine verify`; track the marker outside the validated config, or simply add a first
archetype from this template.)

---

## Archetype: `<archetype-id>`

- **Id:** `<archetype-id>`  (stable; matches the brief `archetype` field)
- **Display name:** `<human-readable name>`
- **When the matcher should pick this:** `<the slot/theme situation this fits>`
- **Platforms / formats:** `<twitter single tweet | thread | giphy reaction gif | ...>`

### Angle (seeds `pre_seed.angle`)
`<the core argument or point this archetype makes>`

### Hook direction (seeds `pre_seed.hook_direction`)
`<how the opening should grab attention>`

### Must include (seeds `pre_seed.must_include`)
- `<element 1 every draft of this archetype must contain>`
- `<element 2>`

### Structure / pacing
`<the shape — e.g. "hook -> one concrete example -> takeaway" or thread beat list>`

### Voice notes for this archetype
`<any tone adjustment specific to this pattern; defaults to the Brand DNA voice>`

### Example (optional)
`<one short example in your brand voice — a seed, not a literal template>`

<!--
Tips:
- Keep archetype ids stable; the matcher and your calendar/campaign theming refer to them.
- Start with 3-5 patterns you actually post (e.g. announcement, teaching thread,
  community shout-out, reaction). You can grow the catalog as calibration and analytics
  tell you what lands.
-->
