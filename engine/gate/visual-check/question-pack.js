'use strict';

/**
 * engine/gate/visual-check/question-pack.js  [A adapted]
 *
 * Resolves the visual-check QUESTION PACK from the config seam (release-spec §1 tree:
 * "Visual gate engine (question packs live in rules/, not code — gap §2.5 brand-visual-rules
 * row)"; §10.3 "visual-check default question pack"; §12.5 provider seam).
 *
 * What this replaces (and why): the production visual-check baked four brand question packs
 * directly into the module — each carrying brand-private mascots, character names, lore, and
 * banned-subject lists. That is exactly the Tier-3/brand content §0.3 r6 forbids in engine
 * code. The public engine ships ZERO brand packs in code: it ships a brand-NEUTRAL default
 * pack as a replaceable asset under rules/visual/, and loads operator/brand packs from
 * $CONTENT_HOME at runtime. The engine authors no brand fidelity content (spec §10.3: shipped
 * rules state the CONTRACT — what is checked, the codes — not the calibrated brand specifics).
 *
 * A question pack is data, not code:
 *   {
 *     id: "default",
 *     questions: [ { key, prompt } ... ],   // the schema fields the vision model must answer
 *     pass: {                                // declarative pass logic (no eval, no code seam)
 *       all_false?:   [keys],   // every listed boolean answer MUST be false to pass
 *       all_true?:    [keys],   // every listed boolean answer MUST be true to pass
 *       no_embedded_text?: key, // a key whose textual answer must read as "none" to pass
 *       require_identity?: { key, when_required: bool }  // identity gate (§ pass logic)
 *     }
 *   }
 *
 * Resolution order (first found wins; unioned with the neutral default for missing fields):
 *   1. an explicit pack object passed by the caller (options.questionPack);
 *   2. $CONTENT_HOME/brands/<brand>/visual-pack.json (operator/brand pack), when CONTENT_HOME set;
 *   3. the shipped neutral default pack (rules/visual/default-pack.json).
 *
 * CONTENT_HOME-free safe: when CONTENT_HOME is unset (fixture-run, §5.4) only steps 1 and 3
 * are consulted; no instance I/O occurs.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_PACK_PATH = path.join(__dirname, '..', '..', '..', 'rules', 'visual', 'default-pack.json');

/** Read + parse a JSON pack file, returning null on any problem (never throws). */
function readPackFile(file) {
  try {
    if (!file || !fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/** Load the shipped neutral default pack. Falls back to a built-in minimal pack if missing. */
function defaultPack() {
  const p = readPackFile(DEFAULT_PACK_PATH);
  if (p) return p;
  // Built-in minimal fallback so the gate never crashes on a missing asset (defense in depth).
  return {
    id: 'default',
    questions: [
      { key: 'on_brand', prompt: 'boolean — true if the image matches the brand identity described in the brief' },
      { key: 'embedded_text_dates_logos', prompt: 'string — list any readable text/dates/logos in the frame, or "none"' },
      { key: 'main_subject_one_line', prompt: 'string — one-sentence neutral description of the main subject' },
    ],
    pass: { all_true: ['on_brand'], no_embedded_text: 'embedded_text_dates_logos' },
  };
}

/**
 * Resolve the active question pack for a brand. Never throws.
 * @param {object} [options]
 * @param {object} [options.questionPack]  explicit caller-supplied pack (highest precedence).
 * @param {string} [options.brand]         brand id for the $CONTENT_HOME/brands/<brand> lookup.
 * @param {object} [options.env]           env (default process.env) for the optional instance pack.
 * @returns {object} a question pack (always has id, questions[], pass{}).
 */
function resolveQuestionPack(options = {}) {
  if (options.questionPack && typeof options.questionPack === 'object') {
    return normalizePack(options.questionPack);
  }
  const env = options.env || process.env;

  // Optional brand/operator pack under $CONTENT_HOME (only when CONTENT_HOME is set).
  if (options.brand) {
    try {
      // eslint-disable-next-line global-require
      const paths = require('../../shared/paths');
      let home = null;
      try {
        home = paths.contentHome(env);
      } catch (err) {
        if (!(err instanceof paths.ContentHomeUnsetError)) throw err;
      }
      if (home) {
        const file = path.join(paths.brandDir(options.brand, env), 'visual-pack.json');
        const instancePack = readPackFile(file);
        if (instancePack) return normalizePack(instancePack);
      }
    } catch {
      // any instance I/O problem ⇒ fall through to the shipped default (never block the gate).
    }
  }

  return normalizePack(defaultPack());
}

/** Coerce a pack into the canonical shape with safe defaults. */
function normalizePack(pack) {
  const questions = Array.isArray(pack.questions)
    ? pack.questions.filter((q) => q && typeof q.key === 'string')
    : [];
  const pass = pack.pass && typeof pack.pass === 'object' ? pack.pass : {};
  return {
    id: typeof pack.id === 'string' && pack.id ? pack.id : 'default',
    questions,
    pass: {
      all_false: Array.isArray(pass.all_false) ? pass.all_false.map(String) : [],
      all_true: Array.isArray(pass.all_true) ? pass.all_true.map(String) : [],
      no_embedded_text: typeof pass.no_embedded_text === 'string' ? pass.no_embedded_text : null,
      require_identity: pass.require_identity && typeof pass.require_identity === 'object'
        ? {
            key: String(pass.require_identity.key || ''),
            when_required: pass.require_identity.when_required !== false,
          }
        : null,
    },
  };
}

/**
 * Does a "embedded text" answer read as an artifact (the production embedded-text-artifact
 * detector, generalized — brand-neutral). Returns true when the answer reports readable
 * text/dates/logos baked into the frame. Treats explicit "none"/negations as clean.
 */
function hasEmbeddedTextArtifact(value) {
  const v = String(value == null ? '' : value).trim().toLowerCase();
  if (!v) return false;
  if (['none', 'n/a', 'no', 'false', 'null'].includes(v)) return false;
  if (/^no\s+(readable|visible|embedded|in-?image)\s+(text|dates?|logos?)/u.test(v)) return false;
  if (/no\s+readable\s+text/u.test(v)) return false;
  return true;
}

/**
 * Evaluate a pack's declarative pass logic against a vision answer object.
 * @param {object} pack       a normalized pack.
 * @param {object} answer     the parsed vision-model answer (keys = pack question keys).
 * @param {object} [ctx]
 * @param {boolean} [ctx.identityRequired]  whether brand identity is required for this item.
 * @returns {{pass:boolean, reasons:string[], embeddedText:boolean, identityMissing:boolean}}
 */
function evaluatePack(pack, answer = {}, ctx = {}) {
  const reasons = [];
  let identityMissing = false;

  for (const key of pack.pass.all_false) {
    if (answer[key] === true) reasons.push(`${key} is true (must be false)`);
  }
  for (const key of pack.pass.all_true) {
    if (answer[key] !== true) reasons.push(`${key} is not true (must be true)`);
  }

  let embeddedText = false;
  if (pack.pass.no_embedded_text) {
    embeddedText = hasEmbeddedTextArtifact(answer[pack.pass.no_embedded_text]);
    if (embeddedText) reasons.push(`embedded text/dates/logos detected: ${pack.pass.no_embedded_text}`);
  }

  if (pack.pass.require_identity && pack.pass.require_identity.key) {
    const ri = pack.pass.require_identity;
    const required = ri.when_required ? !!ctx.identityRequired : true;
    if (required && answer[ri.key] !== true) {
      identityMissing = true;
      reasons.push(`required brand identity element absent: ${ri.key}`);
    }
  }

  return { pass: reasons.length === 0, reasons, embeddedText, identityMissing };
}

/** Build the one-line JSON-schema prompt fragment from the pack's questions. */
function packSchemaLines(pack) {
  return pack.questions.map((q) => `  "${q.key}": ${q.prompt}`).join(',\n');
}

module.exports = {
  DEFAULT_PACK_PATH,
  defaultPack,
  resolveQuestionPack,
  normalizePack,
  hasEmbeddedTextArtifact,
  evaluatePack,
  packSchemaLines,
};
