'use strict';

/**
 * tests/discord-adapter.test.js  [N — new tests, SETUP-DISCORD-ADAPTER]
 *
 * Covers the dependency-free reference Discord adapter (adapters/discord/render.js + route.js): the
 * frame → Discord message rendering and the click → engine-instruction routing. Zero-dep: it drives
 * the COMMITTED setup-frame fixtures (the published contract) and asserts plain Discord component JSON
 * + the routing contract — no discord.js, no network. (The runnable bot-example.js is not imported.)
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const adapter = require('../adapters/discord');
const render = require('../adapters/discord/render.js');
const route = require('../adapters/discord/route.js');

const C2 = require('../fixtures/setup-frame/c2.frame.json');
const DONE = require('../fixtures/setup-frame/done.frame.json');

const TYPE = render.TYPE;

function allComponents(msg) {
  return msg.components.flatMap((row) => row.components);
}

// ---------------------------------------------------------------------------
// render: frame → Discord message
// ---------------------------------------------------------------------------

test('frameToMessage builds an embed + rows; choices become selects, other actions become buttons', () => {
  const msg = adapter.frameToMessage(C2);
  assert.equal(msg.embeds.length, 1);
  assert.ok(msg.embeds[0].title.includes('C2'));
  assert.ok(msg.embeds[0].fields.some((f) => f.name === 'Progress'));

  const comps = allComponents(msg);
  // C2 has two choices (content-source, store-mode) → two selects; register-brand + verify → buttons.
  const selects = comps.filter((c) => c.type === TYPE.STRING_SELECT);
  const buttons = comps.filter((c) => c.type === TYPE.BUTTON);
  assert.equal(selects.length, 2, 'both C2 choices render as select menus');
  assert.ok(buttons.length >= 2, 'register-brand + verify render as buttons');

  // The content-source select carries its options as values.
  const contentSelect = selects.find((s) => s.custom_id.includes('content-source'));
  assert.ok(contentSelect);
  assert.ok(contentSelect.options.some((o) => o.value === 'apify'));
});

test('every action is reachable via a single select-per-row + button packing (≤5 rows)', () => {
  const msg = adapter.frameToMessage(C2);
  assert.ok(msg.components.length <= 5);
  // Each select occupies its own row.
  for (const row of msg.components) {
    const hasSelect = row.components.some((c) => c.type === TYPE.STRING_SELECT);
    if (hasSelect) assert.equal(row.components.length, 1, 'a select claims a whole row');
    else assert.ok(row.components.length <= 5, 'a button row holds ≤5 buttons');
  }
});

test('Discord field limits are honored (custom_id ≤100, button label ≤80, select labels ≤100)', () => {
  for (const fixture of [C2, DONE]) {
    const comps = allComponents(adapter.frameToMessage(fixture));
    for (const c of comps) {
      assert.ok(c.custom_id.length <= 100, `custom_id ≤100 (${c.custom_id})`);
      if (c.type === TYPE.BUTTON) assert.ok(c.label.length <= 80);
      if (c.type === TYPE.STRING_SELECT) {
        assert.ok(c.options.length <= 25);
        for (const o of c.options) {
          assert.ok(o.label.length <= 100);
          if (o.description != null) assert.ok(o.description.length <= 100);
        }
      }
    }
  }
});

test('the done frame renders the media-models field + a finish button', () => {
  const msg = adapter.frameToMessage(DONE);
  assert.ok(msg.embeds[0].fields.some((f) => f.name.startsWith('Media models')));
  const buttons = allComponents(msg).filter((c) => c.type === TYPE.BUTTON);
  assert.ok(buttons.some((b) => b.custom_id.includes('finish')));
});

// ---------------------------------------------------------------------------
// route: custom_id round-trip + interaction → instruction
// ---------------------------------------------------------------------------

test('custom_id round-trips for actions and choices; foreign ids are ignored', () => {
  const a = route.customIdForAction('C1', 'init');
  const c = route.customIdForChoice('C2', 'content-source');
  assert.deepEqual(route.parseCustomId(a), { kind: 'action', frame: 'C1', actionId: 'init' });
  assert.deepEqual(route.parseCustomId(c), { kind: 'choice', frame: 'C2', actionId: 'content-source' });
  assert.equal(route.isOurs('some-other-button'), false);
  assert.equal(route.parseCustomId('some-other-button'), null);
});

test('clicking a run/verify button surfaces its command; a metered option flags spends', () => {
  // register-brand (run) → show-command.
  const reg = route.handleInteraction(C2, { customId: route.customIdForAction('C2', 'register-brand') });
  assert.equal(reg.kind, 'show-command');
  assert.match(reg.command, /ingest-brand|brand\.json/);

  // selecting content-source = apify → show-command, spends true (the metered scrape).
  const apify = route.handleInteraction(C2, { customId: route.customIdForChoice('C2', 'content-source'), values: ['apify'] });
  assert.equal(apify.kind, 'show-command');
  assert.equal(apify.spends, true);
  assert.match(apify.command, /ingest-brand/);
});

test('finish → finish; a stale/unknown action → recompute; non-ours → noop', () => {
  const fin = route.handleInteraction(DONE, { customId: route.customIdForAction('done', 'finish') });
  assert.equal(fin.kind, 'finish');

  const stale = route.handleInteraction(C2, { customId: route.customIdForAction('C2', 'does-not-exist') });
  assert.equal(stale.kind, 'recompute');

  const foreign = route.handleInteraction(C2, { customId: 'totally-unrelated' });
  assert.equal(foreign.kind, 'noop');
});

test('selecting a choice with no chosen value is a no-op (defensive)', () => {
  const r = route.handleInteraction(C2, { customId: route.customIdForChoice('C2', 'content-source'), values: [] });
  assert.equal(r.kind, 'noop');
});
