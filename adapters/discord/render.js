'use strict';

/**
 * adapters/discord/render.js  [N net-new — reference adapter]
 *
 * FRAME → DISCORD MESSAGE. Turns a setup frame (the engine's published contract,
 * schemas/artifacts/setup-frame.schema.json, emitted by `engine setup --json`) into a Discord
 * message payload — an embed plus rows of buttons and select menus — so the guided setup flow renders
 * as the "changing menu" of buttons an operator clicks through.
 *
 * DEPENDENCY-FREE BY DESIGN. This builds PLAIN JSON objects in Discord's component shape (type codes,
 * not discord.js classes), so it carries no dependency and is fully unit-testable in the engine's
 * zero-dep CI. The actual gateway connection lives in bot-example.js (which lazily requires
 * discord.js — run-it-yourself, never imported by tests). One brain (the engine frame), two surfaces
 * (the CLI renderer and this) — the engine never owns a Discord token; the host runtime does.
 *
 * Discord limits honored (so a real client never rejects the payload): ≤25 embed fields, field value
 * ≤1024, embed description ≤4096; ≤5 action rows total; ≤5 buttons/row; a select menu occupies its own
 * row with ≤25 options (label ≤100, description ≤100, value ≤100); custom_id ≤100; button label ≤80.
 */

const { customIdForAction, customIdForChoice } = require('./route');

// Discord component type codes + button styles (the API ints — no discord.js needed).
const TYPE = { ACTION_ROW: 1, BUTTON: 2, STRING_SELECT: 3 };
const BUTTON_STYLE = { PRIMARY: 1, SECONDARY: 2, SUCCESS: 3, DANGER: 4 };

const LIMIT = Object.freeze({
  EMBED_DESC: 4096,
  FIELD_VALUE: 1024,
  FIELDS: 25,
  ROWS: 5,
  BUTTONS_PER_ROW: 5,
  SELECT_OPTIONS: 25,
  LABEL: 80,
  SELECT_LABEL: 100,
  SELECT_DESC: 100,
});

/** Truncate a string to n chars with an ellipsis, tolerating null/undefined. */
function trunc(s, n) {
  const str = String(s == null ? '' : s);
  return str.length <= n ? str : `${str.slice(0, n - 1)}…`;
}

/** The progress strip as a compact one-liner (✓ done / ▶ active / · locked). */
function progressLine(progress) {
  const glyph = { done: '✓', active: '▶', locked: '·' };
  return (progress.checkpoints || []).map((c) => `${glyph[c.status] || '·'} ${c.id}`).join('   ');
}

/** Build the embed from the frame (title, headline+body, progress, what's left, media models). */
function buildEmbed(frame) {
  const descParts = [];
  if (frame.headline) descParts.push(`**${trunc(frame.headline, 300)}**`);
  if (Array.isArray(frame.body) && frame.body.length) descParts.push(frame.body.join('\n'));
  const description = trunc(descParts.join('\n\n'), LIMIT.EMBED_DESC);

  const fields = [];
  fields.push({ name: 'Progress', value: trunc(progressLine(frame.progress), LIMIT.FIELD_VALUE) });

  if (Array.isArray(frame.todo) && frame.todo.length) {
    const v = frame.todo.map((t) => `✗ ${t.name}${t.detail ? ` — ${t.detail}` : ''}`).join('\n');
    fields.push({ name: 'Still needed', value: trunc(v, LIMIT.FIELD_VALUE) });
  }
  if (frame.media_models) {
    const mm = frame.media_models;
    const row = (label, p) => `${p.configured ? '✓' : '·'} ${label}: ${p.configured ? `${p.kind}${p.model ? ` (${p.model})` : ''}` : 'not set'}`;
    const v = [row('vision', mm.visual), row('image-gen', mm.image_gen), row('video', mm.video)].join('\n');
    fields.push({ name: 'Media models (optional)', value: trunc(v, LIMIT.FIELD_VALUE) });
  }

  return {
    title: trunc(`open-content-engine setup — ${frame.done ? 'complete' : frame.generated_for}`, 256),
    description,
    fields: fields.slice(0, LIMIT.FIELDS),
    footer: { text: frame.done ? 'Setup complete' : 'Click an action, run it, then press Re-check' },
  };
}

/** A button style by action type (verify/finish = success; metered = danger; else primary/secondary). */
function styleForAction(action) {
  if (action.type === 'verify' || action.type === 'finish') return BUTTON_STYLE.SUCCESS;
  if (action.spends) return BUTTON_STYLE.DANGER; // metered → visually distinct (operator confirms cost)
  if (action.type === 'run') return BUTTON_STYLE.PRIMARY;
  return BUTTON_STYLE.SECONDARY;
}

/** Map ONE action to a component: a select menu (choice) or a button (everything else). */
function actionToComponent(frame, action) {
  if (action.type === 'choice' && Array.isArray(action.options) && action.options.length) {
    return {
      type: TYPE.STRING_SELECT,
      custom_id: trunc(customIdForChoice(frame.generated_for, action.id), 100),
      placeholder: trunc(action.label, LIMIT.SELECT_LABEL),
      min_values: 0,
      max_values: 1,
      options: action.options.slice(0, LIMIT.SELECT_OPTIONS).map((o) => ({
        label: trunc(`${o.label}${o.spends ? ' ($)' : ''}`, LIMIT.SELECT_LABEL),
        value: trunc(o.id, 100),
        description: o.help ? trunc(o.help, LIMIT.SELECT_DESC) : undefined,
      })),
    };
  }
  return {
    type: TYPE.BUTTON,
    style: styleForAction(action),
    label: trunc(action.label, LIMIT.LABEL),
    custom_id: trunc(customIdForAction(frame.generated_for, action.id), 100),
  };
}

/**
 * Pack components into Discord action rows: each string-select gets its OWN row; buttons fill rows of
 * up to 5. The whole message is capped at 5 rows (Discord's max) — extra components are dropped from
 * the buttons (a frame never realistically exceeds this, but the cap keeps the payload always-valid).
 */
function packRows(components) {
  const rows = [];
  let buttonRow = null;
  const pushButtonRow = () => { if (buttonRow && buttonRow.components.length) { rows.push(buttonRow); buttonRow = null; } };

  for (const c of components) {
    if (rows.length >= LIMIT.ROWS) break;
    if (c.type === TYPE.STRING_SELECT) {
      pushButtonRow();
      if (rows.length >= LIMIT.ROWS) break;
      rows.push({ type: TYPE.ACTION_ROW, components: [c] });
    } else {
      if (!buttonRow) buttonRow = { type: TYPE.ACTION_ROW, components: [] };
      buttonRow.components.push(c);
      if (buttonRow.components.length >= LIMIT.BUTTONS_PER_ROW) pushButtonRow();
    }
  }
  pushButtonRow();
  return rows.slice(0, LIMIT.ROWS);
}

/**
 * Render a frame into a Discord message payload: `{ embeds:[embed], components:[...rows] }`.
 * Selects (choices) are placed first so they each claim a full row, then buttons; capped at 5 rows.
 * @param {object} frame  a frame conforming to schemas/artifacts/setup-frame.schema.json.
 * @returns {{ embeds: object[], components: object[] }}
 */
function frameToMessage(frame) {
  const actions = Array.isArray(frame.actions) ? frame.actions : [];
  // Selects first (each needs its own row), then buttons — so choices are never crowded out.
  const choices = actions.filter((a) => a.type === 'choice');
  const buttons = actions.filter((a) => a.type !== 'choice');
  const components = packRows([
    ...choices.map((a) => actionToComponent(frame, a)),
    ...buttons.map((a) => actionToComponent(frame, a)),
  ]);
  return { embeds: [buildEmbed(frame)], components };
}

module.exports = { frameToMessage, buildEmbed, TYPE, BUTTON_STYLE, LIMIT };
