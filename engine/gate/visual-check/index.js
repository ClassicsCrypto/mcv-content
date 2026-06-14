#!/usr/bin/env node
'use strict';

/**
 * engine/gate/visual-check/index.js  [A adapted]
 *
 * The VISUAL GATE engine — the visual layer of the hybrid gate (release-spec §14.1 visual
 * layer; §12.5 vision provider seam; §10.2 VIS.* family). It asks a configured vision model a
 * tight pack of yes/no questions about a rendered image and turns the answers into a §7.2
 * validation-result, so a downstream LLM gate that never sees the image bytes cannot
 * confabulate a visual PASS (the gap the production module was built to close).
 *
 * Hardened behaviors PRESERVED from the production version (the always-write + shell:false
 * build), with all instance/brand specifics stripped:
 *   - ALWAYS-WRITE: a durable verdict JSON is written whenever a content-id is known — even on
 *     a tool/provider error — so consumers (the executor / package gate / the gate seat) get an
 *     explicit NOT-pass instead of a missing file. A provider error writes vision_pass:null +
 *     VIS.CHECK_ERROR; consumers treat null as NOT-pass and NEVER auto-pass.
 *   - shell:false provider invocation (the image path is the only attacker-influenced argv
 *     value; the prompt travels via stdin) — see provider.js.
 *   - DEGRADE-TO-SKIP: when no vision provider is configured (§12.5 block absent/unknown), the
 *     gate does NOT crash — it returns a clean "visual gate skipped — no provider configured"
 *     path: verdict PASS_PENDING_MEDIA + a SOFT VIS.SKIPPED_NO_PROVIDER code that bars the
 *     Recommended slot for visual formats (§3.1, §15.2). Vision-capable LLM access is optional.
 *
 * What was REMOVED for the public engine (§0.3 r6, gap §2.5):
 *   - the four hard-coded brand question packs (mascots, character names, lore, banned subjects)
 *     → packs now load from rules/visual/ + $CONTENT_HOME (question-pack.js); the engine ships a
 *       brand-NEUTRAL default and authors no brand fidelity content;
 *   - the single vendor image-CLI coupling (operator-OAuth) → the §12.5 provider block
 *     (provider.js); model/timeout selection is config, not vendor-named env vars (§4.5/§4.6);
 *   - the production media-feedback ledger append with a brand-keyed path → a redacted event
 *     emitted through the workflow ledger's events stream conventions (the engine never writes a
 *     brand-keyed instance path here; it writes under $CONTENT_HOME via shared/paths.js).
 *
 * Programmatic API (the gate pipeline calls this):
 *   const { visualCheck } = require('./engine/gate/visual-check');
 *   const result = visualCheck({ content_id, brand, platform, media_path, visual_class,
 *                               identity_required, scene_hint }, { provider, questionPack, env });
 *   // result is a validation-result (§7.2): { content_id, stage:'visual', verdict,
 *   //   detected_codes[], rationale, x-visual:{ vision_pass, provider_kind, out_path } }
 *
 * CLI (operator/debug):
 *   node engine/gate/visual-check --content-id <id> --media-path <path> --brand <id>
 *        [--platform <p>] [--visual-class <c>] [--identity-required] [--scene-hint "..."]
 *        [--out-dir <dir>]
 * Exit: 0 vision_pass · 1 vision NOT-pass (incl. skip) · 2 tool/usage error.
 */

const fs = require('fs');
const path = require('path');

const { CODES, makeCode, SOURCE } = require('./codes');
const provider = require('./provider');
const questionPack = require('./question-pack');
const { redact } = require('../../shared/redact');

const STAGE = 'visual';

/**
 * Resolve the output directory for the durable verdict JSON. Honors the VISUAL_CHECK_OUT_DIR
 * diagnostic override (§4.5), else writes under $CONTENT_HOME/workspaces/visual/ via paths.js.
 * Returns null when no out dir can be derived (CONTENT_HOME-free and no override) — the caller
 * then skips the always-write step but still returns the in-memory verdict.
 */
function resolveOutDir(env, outDirOverride) {
  const override = outDirOverride || (env && env.VISUAL_CHECK_OUT_DIR) || null;
  if (override) return path.isAbsolute(override) ? override : path.resolve(override);
  try {
    // eslint-disable-next-line global-require
    const paths = require('../../shared/paths');
    return paths.stageDir('visual', env);
  } catch {
    return null; // CONTENT_HOME unset and no override — in-memory only.
  }
}

/** Write the durable verdict JSON (always-write contract). Best-effort; never throws. */
function writeVerdict(outDir, contentId, verdictDoc) {
  if (!outDir || !contentId) return null;
  try {
    fs.mkdirSync(outDir, { recursive: true });
    const file = path.join(outDir, `visual-check-${contentId}.json`);
    // The verdict doc carries only neutral fields, but route through redact at write time
    // anyway (§13.3 redact-at-write) so any scene-hint/answer text is scrubbed of secrets.
    fs.writeFileSync(file, `${JSON.stringify(redact(verdictDoc), null, 2)}\n`, { encoding: 'utf8' });
    return file;
  } catch {
    return null; // best-effort: never mask the original verdict.
  }
}

/** Build the one-line JSON-answer prompt for the vision model from the pack. */
function buildPrompt(pack, input) {
  const sceneLine = input.scene_hint
    ? `\nIntended scene (per the brief, for context only — verify against the ACTUAL image, do not assume): "${input.scene_hint}"`
    : '';
  const classLine = `\nVisual class: ${input.visual_class || 'unspecified'}\nBrand identity required: ${input.identity_required ? 'true' : 'false'}`;
  const schemaLines = questionPack.packSchemaLines(pack);
  return `Inspect the attached image and answer ONLY with a single JSON object on one line.${sceneLine}${classLine}

Schema (every field is required):
{
${schemaLines}
}

Rules:
- Look at the IMAGE, not at any external assumptions. If the brief expected something the image does not show, answer about the image, not the brief.
- Output JSON only. No prose, no markdown, no preamble.`;
}

/** Extract the JSON object from a provider's raw text answer. Throws on no/invalid JSON. */
function parseVisionAnswer(rawText) {
  const text = String(rawText || '');
  // Many CLI providers stream JSON-line events; scan for an agent/message text field first,
  // else fall back to the first {...} block in the whole output.
  let candidate = null;
  for (const line of text.split(/\r?\n/u).filter(Boolean)) {
    try {
      const ev = JSON.parse(line);
      const msg = ev && (ev.text || (ev.item && ev.item.text) || (ev.message && ev.message.text));
      if (typeof msg === 'string') candidate = msg;
    } catch {
      /* not a JSON-line event — ignore */
    }
  }
  const haystack = candidate || text;
  const m = haystack.match(/\{[\s\S]*\}/u);
  if (!m) throw new Error(`vision model did not return JSON: ${haystack.slice(0, 200)}`);
  return JSON.parse(m[0]);
}

/**
 * Run the visual gate over one media item.
 *
 * @param {object} input
 * @param {string} input.content_id        REQUIRED to name the durable verdict file.
 * @param {string} [input.brand]           brand id (selects the optional instance question pack).
 * @param {string} [input.platform]
 * @param {string} input.media_path        path to the rendered image (absolute or env-relative).
 * @param {string} [input.visual_class]
 * @param {boolean}[input.identity_required] whether brand identity is mandatory for this item.
 * @param {string} [input.scene_hint]
 * @param {object} [options]
 * @param {object} [options.provider]      the §12.5 provider config block (absent ⇒ skip).
 * @param {object} [options.questionPack]  an explicit pack (overrides rules/instance lookup).
 * @param {string} [options.outDir]        out-dir override (else VISUAL_CHECK_OUT_DIR / paths.js).
 * @param {object} [options.env]           env (default process.env).
 * @param {function} [options.spawnSync]   injectable spawnSync (tests).
 * @param {function} [options.httpPost]    injectable HTTP poster (tests / http kind).
 * @returns {object} a §7.2 validation-result with an x-visual routing block.
 */
function visualCheck(input = {}, options = {}) {
  const env = options.env || process.env;
  const contentId = input.content_id || null;
  const outDir = resolveOutDir(env, options.outDir);

  const baseDoc = {
    content_id: contentId,
    brand: input.brand || null,
    platform: input.platform || null,
    visual_class: input.visual_class || null,
    identity_required: !!input.identity_required,
    media_path: input.media_path || null,
    scene_hint: input.scene_hint || null,
    checked_at: new Date().toISOString(),
  };

  // --- DEGRADE-TO-SKIP: no vision provider configured (§12.5; §3.1; §15.2) ------------------
  const resolved = provider.resolveProvider(options.provider);
  if (!resolved) {
    const code = makeCode(
      CODES.SKIPPED_NO_PROVIDER,
      'visual gate skipped — no vision provider configured (§12.5); set a provider block to enable the visual gate',
    );
    const verdictDoc = {
      ...baseDoc,
      vision_pass: null,
      skipped: true,
      skip_reason: 'no_vision_provider',
      detected_codes: [code],
    };
    const written = writeVerdict(outDir, contentId, verdictDoc);
    return finalize('PASS_PENDING_MEDIA', [code], {
      content_id: contentId,
      rationale: 'Visual gate skipped: no vision provider configured. Soft warning bars the Recommended slot for visual formats; configure a §12.5 provider to enable the gate.',
      xVisual: { vision_pass: null, skipped: true, provider_kind: null, out_path: written },
    });
  }

  // --- Resolve image path -------------------------------------------------------------------
  const mediaPath = input.media_path;
  if (!mediaPath) {
    return toolError(baseDoc, outDir, contentId, 'media_path is required', resolved.kind);
  }
  let mediaAbs = mediaPath;
  if (!path.isAbsolute(mediaPath)) {
    try {
      // eslint-disable-next-line global-require
      const paths = require('../../shared/paths');
      mediaAbs = path.join(paths.contentHome(env), mediaPath);
    } catch {
      mediaAbs = path.resolve(mediaPath); // CONTENT_HOME-free fallback (e.g. fixture-run).
    }
  }
  if (!fs.existsSync(mediaAbs)) {
    return toolError(baseDoc, outDir, contentId, `media not found: ${mediaAbs}`, resolved.kind);
  }

  // --- Resolve the question pack (config seam — never brand code) ----------------------------
  const pack = questionPack.resolveQuestionPack({
    questionPack: options.questionPack,
    brand: input.brand,
    env,
  });

  // --- Invoke the vision provider -----------------------------------------------------------
  let answer;
  try {
    const prompt = buildPrompt(pack, input);
    const raw = provider.runVision(resolved, {
      prompt,
      imagePath: mediaAbs,
      env,
      spawnSync: options.spawnSync,
      httpPost: options.httpPost,
    });
    answer = parseVisionAnswer(raw);
  } catch (e) {
    return toolError(baseDoc, outDir, contentId, e.message, resolved.kind);
  }

  // --- Evaluate the pack's declarative pass logic -------------------------------------------
  const evalResult = questionPack.evaluatePack(pack, answer, {
    identityRequired: !!input.identity_required,
  });

  const detected = [];
  if (evalResult.identityMissing) {
    detected.push(makeCode(CODES.IDENTITY_MISSING, evalResult.reasons.find((r) => /identity/.test(r)) || 'required brand identity element absent'));
  }
  if (evalResult.embeddedText) {
    detected.push(makeCode(CODES.EMBEDDED_TEXT, `readable text/dates/logos detected: ${answer[pack.pass.no_embedded_text]}`));
  }
  // Any other off-brand failure (a pack boolean failing) ⇒ one OFF_BRAND code carrying the
  // human-readable reasons not already covered by a more-specific code.
  const otherReasons = evalResult.reasons.filter((r) => !/identity/.test(r) && !/embedded text/.test(r));
  if (!evalResult.pass && otherReasons.length) {
    detected.push(makeCode(CODES.OFF_BRAND, `off-brand: ${otherReasons.join('; ')}`));
  }
  // Edge case: pass logic failed but produced no categorized reason — emit a generic OFF_BRAND
  // so a NOT-pass always carries a code (never a silent fail).
  if (!evalResult.pass && detected.length === 0) {
    detected.push(makeCode(CODES.OFF_BRAND, 'image did not satisfy the brand-fidelity question pack'));
  }

  const visionPass = evalResult.pass;
  const verdict = visionPass ? 'PASS' : 'FAIL';
  const oneLine = answer.main_subject_one_line || '(no description)';

  const verdictDoc = {
    ...baseDoc,
    pack_id: pack.id,
    vision_pass: visionPass,
    detected_codes: detected,
    answer, // the raw model answer, for auditability
    main_subject_one_line: oneLine,
  };
  const written = writeVerdict(outDir, contentId, verdictDoc);

  return finalize(verdict, detected, {
    content_id: contentId,
    rationale: visionPass
      ? 'Visual gate PASS: image satisfies the brand-fidelity question pack.'
      : `Visual gate FAIL: ${detected.map((d) => d.code).join(', ')} — route back to the media seat.`,
    xVisual: {
      vision_pass: visionPass,
      skipped: false,
      provider_kind: resolved.kind,
      pack_id: pack.id,
      one_line: oneLine,
      out_path: written,
    },
  });
}

/**
 * Build the tool-error result: always-write a vision_pass:null verdict + VIS.CHECK_ERROR and
 * return a FAIL validation-result. Consumers treat null as NOT-pass and never auto-pass.
 */
function toolError(baseDoc, outDir, contentId, reason, providerKind) {
  const code = makeCode(CODES.CHECK_ERROR, `visual gate tool error: ${reason}`);
  const verdictDoc = {
    ...baseDoc,
    vision_pass: null,
    error: reason,
    detected_codes: [code],
  };
  const written = writeVerdict(outDir, contentId, verdictDoc);
  return finalize('FAIL', [code], {
    content_id: contentId,
    rationale: `Visual gate tool error (treated as NOT-pass): ${reason}`,
    xVisual: { vision_pass: null, skipped: false, provider_kind: providerKind || null, error: reason, out_path: written },
  });
}

/** Assemble the §7.2 validation-result. */
function finalize(verdict, detectedCodes, extra) {
  return {
    content_id: extra.content_id || null,
    stage: STAGE,
    verdict,
    detected_codes: detectedCodes,
    rationale: extra.rationale,
    'x-visual': extra.xVisual,
  };
}

module.exports = {
  STAGE,
  SOURCE,
  CODES,
  visualCheck,
  // Exposed for the registry-integrity check + tests.
  buildPrompt,
  parseVisionAnswer,
  resolveOutDir,
  writeVerdict,
};

// --- CLI ------------------------------------------------------------------------------------
// Only runs when invoked directly. The gate pipeline imports visualCheck() and never shells out.

if (require.main === module) {
  const argv = process.argv.slice(2);
  const arg = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : null;
  };
  const has = (name) => argv.includes(`--${name}`);

  const contentId = arg('content-id');
  const mediaPath = arg('media-path');
  const brand = arg('brand');
  if (!contentId || !mediaPath) {
    process.stderr.write(
      'usage: --content-id <id> --media-path <path> [--brand <id>] [--platform <p>] ' +
        '[--visual-class <c>] [--identity-required] [--scene-hint "..."] [--out-dir <dir>]\n',
    );
    process.exit(2);
  }

  // The CLI reads the §12.5 provider block from config/system.json when CONTENT_HOME is set;
  // absent ⇒ degrade-to-skip. No operator-OAuth tooling is assumed.
  let providerBlock = null;
  try {
    // eslint-disable-next-line global-require
    const paths = require('../../shared/paths');
    const sys = JSON.parse(fs.readFileSync(paths.systemConfig(process.env), 'utf8'));
    providerBlock = (sys && sys.visual_provider) || (sys && sys.providers && sys.providers.visual) || null;
  } catch {
    providerBlock = null; // no config / CONTENT_HOME-free ⇒ skip path.
  }

  const result = visualCheck(
    {
      content_id: contentId,
      media_path: mediaPath,
      brand,
      platform: arg('platform'),
      visual_class: arg('visual-class'),
      identity_required: has('identity-required'),
      scene_hint: arg('scene-hint') || '',
    },
    { provider: providerBlock, outDir: arg('out-dir') },
  );

  const x = result['x-visual'] || {};
  if (x.skipped) {
    process.stdout.write('visual gate SKIPPED — no vision provider configured (§12.5)\n');
    process.exit(1);
  }
  process.stdout.write(`vision_pass=${x.vision_pass}  verdict=${result.verdict}  codes=${result.detected_codes.map((d) => d.code).join(',') || 'none'}\n`);
  if (x.out_path) process.stdout.write(`written to ${x.out_path}\n`);
  process.exit(x.vision_pass === true ? 0 : x.vision_pass === null ? 2 : 1);
}
