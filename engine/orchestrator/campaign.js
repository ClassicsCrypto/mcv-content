'use strict';

/**
 * engine/orchestrator/campaign.js  [A adapted from the production campaign-claiming mechanics]
 *
 * Campaign slot-claiming (release-spec §8.7 campaign mechanics; §1.4; DD-16 no-out-of-calendar):
 * a campaign file declares a date window, brand(s), platform(s), and a `slot_pattern` glob; during
 * its window it CLAIMS matching calendar slots; on conflict the campaign with the EARLIEST start
 * date wins; a claimed slot routes campaign content with the campaign's messaging goals as pre-seed
 * into the brief. Campaigns are addable at any time; there is no out-of-calendar publishing — a
 * campaign only ever overlays slots that already exist in the calendar (DD-16).
 *
 * This is the canonized form of the production claiming logic (`_morning-preview-kickoff.js` /
 * `_calendar-tick.js` `loadCampaigns`/`matchCampaign`), de-localized per the rename map:
 *   - `account` → `brand` (DD-10);
 *   - campaign files read from `$CONTENT_HOME/campaigns/` via paths.js (RD-3) — never a hardcoded
 *     monorepo path;
 *   - production-only fields `claim_percentage`/`priority` are NOT v1 (documented, ignored — every
 *     match is claimed at 100%, earliest start wins on overlap; §8.7);
 *   - no brand strings, no production codenames (§0.3 r6).
 *
 * SHARED by kickoff AND tick (the bug P3-CLAIMS guards: divergence between claiming-at-kickoff and
 * claiming-at-tick). Both call `claimSlot` per candidate slot+date with the same loaded campaign
 * set, so a slot is claimed identically regardless of which trigger fires it.
 *
 * The campaign schema (schemas/inputs/campaign.schema.json, §6.5/§8.7) is authored by P1-SCH-INPUT;
 * this module parses the field set that schema documents (markdown frontmatter form) and stays
 * defensive about absent optional fields. Parsing is intentionally minimal/tolerant — the canonical
 * schema-validation runner (P1-SCH-NEW) is the strict gate; this is the runtime read.
 */

const fs = require('fs');
const path = require('path');

const paths = require('./../shared/paths');

/** Files in campaigns/ that are NOT campaigns (disabled with `_`, the README, examples skipped by `_`). */
function isCampaignFile(name) {
  return name.endsWith('.md') && !name.startsWith('_') && name.toLowerCase() !== 'readme.md';
}

/** First single-line `- key: value` frontmatter field, or null. */
function field(raw, key) {
  const m = raw.match(new RegExp(`^-\\s*${key}:\\s*(.+)$`, 'm'));
  return m ? m[1].trim() : null;
}

/**
 * Parse a campaign markdown file into a campaign object. Supports both the public field names
 * (`brand`/`brands`, `platforms`) and the de-localized read of the production `account` field, so
 * a migrated instance file still loads (account → brand). Per-day themes come from the
 * `## Day-by-day themes` section; messaging goals from the `## Goal` section (§8.7 pre-seed).
 */
function parseCampaign(raw, file) {
  const id = field(raw, 'campaign_id') || field(raw, 'name');
  const start = field(raw, 'start_date');
  const end = field(raw, 'end_date');
  if (!id || !start || !end) return null; // a campaign without an id + window is unusable (§8.7)

  // brand: prefer the public `brand`/`brands`; fall back to the production `account` (rename map).
  const brand = field(raw, 'brands') || field(raw, 'brand') || field(raw, 'account');
  const platform = field(raw, 'platforms') || field(raw, 'platform');
  const slotPattern = field(raw, 'slot_pattern');

  const themes = {};
  const themeBlock = raw.match(/## Day-by-day themes\s*\n([\s\S]*?)(?=\n## |$)/);
  if (themeBlock) {
    for (const line of themeBlock[1].split('\n')) {
      const tm = line.match(/^-\s*(\d{4}-\d{2}-\d{2}):\s*["']?(.+?)["']?\s*$/);
      if (tm) themes[tm[1]] = tm[2];
    }
  }

  let messagingGoals = null;
  const goalBlock = raw.match(/## (?:Goal|Messaging goals?)\s*\n([\s\S]*?)(?=\n## |$)/i);
  if (goalBlock) {
    const text = goalBlock[1].trim();
    if (text) messagingGoals = text;
  }

  const state = field(raw, 'state') || 'active';

  return {
    id,
    start,
    end,
    brand,
    platform,
    slot_pattern: slotPattern,
    themes,
    messaging_goals: messagingGoals,
    state,
    file,
  };
}

/**
 * Load every active campaign from $CONTENT_HOME/campaigns/, sorted EARLIEST start first (so the
 * first match wins on overlap — §8.7). An absent campaigns dir yields []. A `state` of anything but
 * `active` (or absent) is skipped.
 *
 * @param {object} [opts]  { env, dir }  — `dir` overrides the resolved campaigns dir (tests).
 */
function loadCampaigns(opts = {}) {
  const env = opts.env || process.env;
  let dir;
  try {
    dir = opts.dir || paths.campaignsDir(env);
  } catch {
    return [];
  }
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const campaigns = [];
  for (const name of names) {
    if (!isCampaignFile(name)) continue;
    let raw;
    try {
      raw = fs.readFileSync(path.join(dir, name), 'utf8');
    } catch {
      continue;
    }
    const c = parseCampaign(raw, name);
    if (!c) continue;
    if (c.state && String(c.state).toLowerCase() !== 'active') continue;
    campaigns.push(c);
  }
  // Earliest start_date wins on overlap (§8.7). Stable, lexical ISO-date compare.
  campaigns.sort((a, b) => String(a.start).localeCompare(String(b.start)));
  return campaigns;
}

/** Compile a `slot_pattern` glob (only `*` is supported, per §8.7) into an anchored RegExp. */
function globToRegExp(glob) {
  // Escape every regex metachar EXCEPT `*`, then turn `*` into `.*`. Anchored full-match.
  const escaped = String(glob).replace(/[.+?^${}()|[\]\\]/gu, '\\$&').replace(/\*/gu, '.*');
  return new RegExp(`^${escaped}$`, 'u');
}

/** True iff a campaign's date window contains the ISO date (inclusive both ends). */
function inWindow(campaign, dateISO) {
  return dateISO >= String(campaign.start) && dateISO <= String(campaign.end);
}

/**
 * Does this campaign claim this slot on this date? A claim requires: the date is inside the window;
 * brand matches (case-insensitive; absent campaign brand = any); platform matches (substring, like
 * the production rule — a campaign `platforms: Twitter/X` claims a `Twitter/X` slot; absent = any);
 * the slot_pattern glob matches the slot_id (absent = any). Note: unlike the production tick, a
 * claim does NOT require a per-day theme line — a claimed slot with no theme still routes campaign
 * messaging goals as pre-seed (§8.7); the theme, when present, overlays the slot's default theme.
 */
function campaignClaimsSlot(campaign, slot, dateISO) {
  if (!inWindow(campaign, dateISO)) return false;
  const cBrand = campaign.brand ? String(campaign.brand).trim().toLowerCase() : null;
  const sBrand = String(slot.brand || slot.account || '').trim().toLowerCase();
  if (cBrand && cBrand !== sBrand) return false;
  const cPlat = campaign.platform ? String(campaign.platform).trim().toLowerCase() : null;
  const sPlat = String(slot.platform || '').trim().toLowerCase();
  if (cPlat && sPlat && !cPlat.includes(sPlat) && !sPlat.includes(cPlat)) return false;
  if (campaign.slot_pattern) {
    if (!globToRegExp(campaign.slot_pattern).test(String(slot.slot_id))) return false;
  }
  return true;
}

/**
 * Resolve the claim for a slot on a date against the loaded campaign set: the FIRST campaign (the
 * earliest-start, since loadCampaigns sorts) that claims the slot wins (§8.7). Returns a claim
 * object the kickoff/tick dispatch threads onto the slot-run task record as pre-seed, or null when
 * no campaign claims it (the slot fires with its default pillar-driven theme — unchanged behavior).
 *
 * @returns {null | { campaign_id, theme:(string|null), messaging_goals:(string|null), file }}
 */
function claimSlot(slot, dateISO, campaigns) {
  if (!Array.isArray(campaigns) || campaigns.length === 0) return null;
  for (const c of campaigns) {
    if (!campaignClaimsSlot(c, slot, dateISO)) continue;
    return {
      campaign_id: c.id,
      theme: c.themes[dateISO] || null,
      messaging_goals: c.messaging_goals || null,
      file: c.file,
    };
  }
  return null;
}

/**
 * Resolve the currently-claimed slots for a named campaign on a date (the `RUN_CAMPAIGN` resolver,
 * §6.1). Returns the subset of `slots` the campaign claims today, each with its claim — the
 * dispatch layer turns these into one task record per claimed slot.
 */
function claimedSlotsFor(campaignId, slots, dateISO, campaigns) {
  const c = (campaigns || []).find((x) => x.id === campaignId);
  if (!c) return [];
  const out = [];
  for (const slot of slots || []) {
    if (campaignClaimsSlot(c, slot, dateISO)) {
      out.push({
        slot,
        claim: {
          campaign_id: c.id,
          theme: c.themes[dateISO] || null,
          messaging_goals: c.messaging_goals || null,
          file: c.file,
        },
      });
    }
  }
  return out;
}

module.exports = {
  isCampaignFile,
  parseCampaign,
  loadCampaigns,
  globToRegExp,
  inWindow,
  campaignClaimsSlot,
  claimSlot,
  claimedSlotsFor,
};
