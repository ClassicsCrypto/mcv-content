#!/usr/bin/env node
'use strict';

/**
 * scripts/validate-schemas.js  [N net-new]
 *
 * The JSON-schema-validation CI gate (release-spec §16.5: "JSON-schema validation of all shipped
 * schemas/templates/fixtures"). Two assertions, both offline and zero-key (RD-12):
 *
 *   1. EVERY schema file under schemas/ PARSES as JSON, declares the draft-2020-12 `$schema`, a
 *      versioned `$id` on the reserved .example domain, and an `x-stability` tag — and is itself
 *      a structurally sound schema (its keyword values have the right shapes).
 *   2. EVERY bound fixture VALIDATES against its schema. Bindings are explicit (the BINDINGS table
 *      below), tied to the stable file-naming conventions the fixtures batch established
 *      (*.draft.json → draft, *.package.json → package, *.entry.json → queue-entry, the brand-acme
 *      instance files → their config/input schemas, the corpus JSONL lines → corpus-item, the
 *      media index entries → archive-index-entry). A fixture with no stable single-schema binding
 *      (the calibration sample envelope, the recorded gate-verdicts replay envelope) is reported
 *      as an explicit SKIP, never silently dropped and never validated against a wrong shape.
 *
 * Self-contained validator: there are NO dependencies in this repo (package.json deps == {}), so
 * this ships a small, honest JSON-Schema validator covering exactly the keyword subset the shipped
 * schemas use (enumerated from schemas/** at authoring time): type, properties, additionalProperties,
 * required, enum, const, items, $ref (local #/$defs only), $defs, pattern, minLength/maxLength,
 * minimum/maximum/exclusiveMinimum, minItems/maxItems, uniqueItems, minProperties, allOf, anyOf,
 * oneOf, not, if/then/else. `format` is treated as an ANNOTATION (draft-2020-12 default) — never a
 * hard failure — so a fixture is never rejected for a debatable format interpretation. If a schema
 * ever uses a keyword this validator does not implement, validation FAILS LOUDLY with
 * "unsupported keyword" rather than silently passing (a false green on the leak/QA gate is the
 * worst outcome — same principle as fixture-run).
 *
 * Usage: node scripts/validate-schemas.js [--root <dir>] [--json]
 * Exit: 0 all parse + all bound fixtures valid · 1 a parse/validation failure · 2 usage error.
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');

// --- The mini JSON-Schema validator (draft-2020-12 subset used by schemas/**) ---------------

// Keywords this validator understands. Any OTHER assertion keyword in a schema is an explicit
// failure (see KNOWN_NONASSERTION for the annotation/metadata keywords that are safely ignored).
const SUPPORTED = new Set([
  'type', 'properties', 'additionalProperties', 'patternProperties', 'propertyNames', 'required',
  'enum', 'const', 'items', 'prefixItems', 'contains', 'minItems', 'maxItems', 'uniqueItems',
  'minLength', 'maxLength', 'pattern', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum',
  'multipleOf', 'minProperties', 'maxProperties', 'dependentRequired',
  'allOf', 'anyOf', 'oneOf', 'not', 'if', 'then', 'else', '$ref',
]);
// Annotation / metadata / structural keywords that carry no assertion — safely ignored.
const KNOWN_NONASSERTION = new Set([
  '$schema', '$id', '$defs', '$comment', '$anchor', 'title', 'description', 'default', 'examples',
  'format', 'deprecated', 'readOnly', 'writeOnly', 'definitions',
]);

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (Number.isInteger(v)) return 'integer';
  return typeof v; // 'number' | 'string' | 'boolean' | 'object'
}

/** Does `value` satisfy a JSON-Schema `type` token? (integer is a subset of number.) */
function matchesType(value, t) {
  const actual = typeOf(value);
  if (t === 'number') return actual === 'number' || actual === 'integer';
  if (t === 'integer') return actual === 'integer';
  return actual === t;
}

/** Resolve a local "#/$defs/<name>" reference against the root schema. Throws on a bad ref. */
function resolveRef(ref, root) {
  if (!ref.startsWith('#/')) throw new Error(`unsupported non-local $ref: ${ref}`);
  const parts = ref.slice(2).split('/').map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'));
  let node = root;
  for (const p of parts) {
    if (node && typeof node === 'object' && p in node) node = node[p];
    else throw new Error(`$ref ${ref} does not resolve`);
  }
  return node;
}

/**
 * Validate `value` against `schema`. Pushes "instancePath: message" strings onto `errors`.
 * `root` is the top schema (for $ref/$defs resolution). Returns true when valid.
 */
function validateNode(value, schema, root, instancePath, errors) {
  if (schema === true) return true;
  if (schema === false) { errors.push(`${instancePath}: schema is false (nothing valid)`); return false; }
  if (typeof schema !== 'object' || schema === null) {
    throw new Error(`malformed schema node at ${instancePath}: not an object`);
  }

  // Guard: refuse to silently pass an unknown ASSERTION keyword. Vendor-extension keywords
  // (the spec's `x-stability` / `x-schema-version` and any `$`-prefixed metadata) are annotations
  // by JSON-Schema rule and carry no assertion, so they are always safe to ignore.
  for (const k of Object.keys(schema)) {
    if (SUPPORTED.has(k) || KNOWN_NONASSERTION.has(k)) continue;
    if (k.startsWith('x-') || k.startsWith('$')) continue;
    throw new Error(`unsupported schema keyword "${k}" at ${instancePath} — validator must be extended`);
  }

  let ok = true;
  const fail = (msg) => { errors.push(`${instancePath || '(root)'}: ${msg}`); ok = false; };

  // $ref — validate against the referenced subschema (the schemas use only local refs; refs in
  // these schemas never combine with sibling assertions in a way that changes the outcome, so a
  // straightforward "validate against the target too" is correct for this subset).
  if ('$ref' in schema) {
    const target = resolveRef(schema.$ref, root);
    if (!validateNode(value, target, root, instancePath, errors)) ok = false;
  }

  // type
  if ('type' in schema) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => matchesType(value, t))) {
      fail(`expected type ${types.join('|')}, got ${typeOf(value)}`);
    }
  }

  // const / enum
  if ('const' in schema && !deepEqual(value, schema.const)) {
    fail(`must equal const ${JSON.stringify(schema.const)}`);
  }
  if ('enum' in schema && !schema.enum.some((e) => deepEqual(value, e))) {
    fail(`must be one of enum ${JSON.stringify(schema.enum)} (got ${JSON.stringify(value)})`);
  }

  // string assertions
  if (typeof value === 'string') {
    if ('minLength' in schema && value.length < schema.minLength) fail(`string shorter than minLength ${schema.minLength}`);
    if ('maxLength' in schema && value.length > schema.maxLength) fail(`string longer than maxLength ${schema.maxLength}`);
    if ('pattern' in schema) {
      let re;
      try { re = new RegExp(schema.pattern, 'u'); } catch { re = new RegExp(schema.pattern); }
      if (!re.test(value)) fail(`string does not match pattern ${schema.pattern}`);
    }
  }

  // number assertions
  if (typeof value === 'number') {
    if ('minimum' in schema && value < schema.minimum) fail(`number below minimum ${schema.minimum}`);
    if ('maximum' in schema && value > schema.maximum) fail(`number above maximum ${schema.maximum}`);
    if ('exclusiveMinimum' in schema && value <= schema.exclusiveMinimum) fail(`number not > exclusiveMinimum ${schema.exclusiveMinimum}`);
    if ('exclusiveMaximum' in schema && value >= schema.exclusiveMaximum) fail(`number not < exclusiveMaximum ${schema.exclusiveMaximum}`);
    if ('multipleOf' in schema && schema.multipleOf > 0 && Math.abs(value / schema.multipleOf - Math.round(value / schema.multipleOf)) > 1e-9) {
      fail(`number not a multiple of ${schema.multipleOf}`);
    }
  }

  // array assertions
  if (Array.isArray(value)) {
    if ('minItems' in schema && value.length < schema.minItems) fail(`array shorter than minItems ${schema.minItems}`);
    if ('maxItems' in schema && value.length > schema.maxItems) fail(`array longer than maxItems ${schema.maxItems}`);
    if (schema.uniqueItems === true) {
      const seen = [];
      for (const item of value) {
        if (seen.some((s) => deepEqual(s, item))) { fail('array items not unique'); break; }
        seen.push(item);
      }
    }
    if ('prefixItems' in schema) {
      schema.prefixItems.forEach((sub, i) => {
        if (i < value.length) validateNode(value[i], sub, root, `${instancePath}[${i}]`, errors) || (ok = false);
      });
    }
    if ('items' in schema && typeof schema.items === 'object') {
      const start = Array.isArray(schema.prefixItems) ? schema.prefixItems.length : 0;
      for (let i = start; i < value.length; i++) {
        if (!validateNode(value[i], schema.items, root, `${instancePath}[${i}]`, errors)) ok = false;
      }
    }
    if ('contains' in schema) {
      const any = value.some((item) => validateNode(item, schema.contains, root, `${instancePath}[contains]`, []));
      if (!any) fail('no array item matches "contains" schema');
    }
  }

  // object assertions
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const keys = Object.keys(value);
    if (Array.isArray(schema.required)) {
      for (const r of schema.required) {
        if (!(r in value)) fail(`missing required property "${r}"`);
      }
    }
    if ('minProperties' in schema && keys.length < schema.minProperties) fail(`fewer than minProperties ${schema.minProperties}`);
    if ('maxProperties' in schema && keys.length > schema.maxProperties) fail(`more than maxProperties ${schema.maxProperties}`);
    if (schema.dependentRequired) {
      for (const [trigger, deps] of Object.entries(schema.dependentRequired)) {
        if (trigger in value) for (const d of deps) if (!(d in value)) fail(`property "${trigger}" requires "${d}"`);
      }
    }
    if (schema.propertyNames && typeof schema.propertyNames === 'object') {
      for (const key of keys) {
        if (!validateNode(key, schema.propertyNames, root, `${instancePath}/${key} (name)`, errors)) ok = false;
      }
    }
    const props = schema.properties || {};
    const patternProps = schema.patternProperties
      ? Object.entries(schema.patternProperties).map(([p, s]) => ({ re: new RegExp(p, 'u'), s }))
      : [];
    for (const key of keys) {
      const childPath = `${instancePath}/${key}`;
      let covered = false;
      if (key in props) {
        covered = true;
        if (!validateNode(value[key], props[key], root, childPath, errors)) ok = false;
      }
      for (const { re, s } of patternProps) {
        if (re.test(key)) {
          covered = true;
          if (!validateNode(value[key], s, root, childPath, errors)) ok = false;
        }
      }
      if (!covered && schema.additionalProperties === false) {
        fail(`additional property "${key}" not allowed`);
      } else if (!covered && typeof schema.additionalProperties === 'object') {
        if (!validateNode(value[key], schema.additionalProperties, root, childPath, errors)) ok = false;
      }
    }
  }

  // applicators
  if (Array.isArray(schema.allOf)) {
    for (const sub of schema.allOf) if (!validateNode(value, sub, root, instancePath, errors)) ok = false;
  }
  if (Array.isArray(schema.anyOf)) {
    const any = schema.anyOf.some((sub) => validateNode(value, sub, root, instancePath, []));
    if (!any) fail('value matches none of anyOf');
  }
  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.filter((sub) => validateNode(value, sub, root, instancePath, [])).length;
    if (matches !== 1) fail(`value matches ${matches} of oneOf (must match exactly 1)`);
  }
  if (schema.not && validateNode(value, schema.not, root, instancePath, [])) {
    fail('value matches "not" schema (must NOT)');
  }
  // if / then / else
  if ('if' in schema) {
    const condOk = validateNode(value, schema.if, root, instancePath, []);
    if (condOk && 'then' in schema) {
      if (!validateNode(value, schema.then, root, instancePath, errors)) ok = false;
    } else if (!condOk && 'else' in schema) {
      if (!validateNode(value, schema.else, root, instancePath, errors)) ok = false;
    }
  }

  return ok;
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeOf(a) !== typeOf(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    return a.every((x, i) => deepEqual(x, b[i]));
  }
  if (a && typeof a === 'object') {
    const ak = Object.keys(a);
    const bk = Object.keys(b);
    if (ak.length !== bk.length) return false;
    return ak.every((k) => k in b && deepEqual(a[k], b[k]));
  }
  return false;
}

/** Validate one instance against a loaded schema object. Returns { ok, errors }. */
function validate(instance, schema) {
  const errors = [];
  let ok;
  try {
    ok = validateNode(instance, schema, schema, '', errors);
  } catch (err) {
    return { ok: false, errors: [`validator error: ${err.message}`] };
  }
  return { ok: ok && errors.length === 0, errors };
}

// --- Schema discovery + structural self-check -----------------------------------------------

function findSchemas(root) {
  const dir = path.join(root, 'schemas');
  const out = [];
  (function walk(d) {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const abs = path.join(d, e.name);
      if (e.isDirectory()) walk(abs);
      else if (e.isFile() && e.name.endsWith('.schema.json')) out.push(abs);
    }
  })(dir);
  return out.sort();
}

/** Load + structurally check one schema file. Returns { ok, schema, errors }. */
function loadSchema(absPath) {
  const errors = [];
  let schema;
  try {
    schema = JSON.parse(fs.readFileSync(absPath, 'utf8'));
  } catch (err) {
    return { ok: false, errors: [`does not parse as JSON: ${err.message}`] };
  }
  if (typeof schema !== 'object' || schema === null) return { ok: false, errors: ['top-level is not an object'] };
  if (schema.$schema !== 'https://json-schema.org/draft/2020-12/schema') {
    errors.push(`$schema must be draft-2020-12 (got ${JSON.stringify(schema.$schema)})`);
  }
  if (typeof schema.$id !== 'string' || !/^https:\/\/open-content-engine\.example\/schemas\//.test(schema.$id)) {
    errors.push(`$id must be a versioned id on the reserved .example domain (got ${JSON.stringify(schema.$id)})`);
  }
  if (!('x-stability' in schema) || !['stable', 'experimental'].includes(schema['x-stability'])) {
    errors.push(`x-stability must be "stable" or "experimental" (got ${JSON.stringify(schema['x-stability'])})`);
  }
  // Structural soundness: every keyword the validator will encounter must be supported. We probe
  // by validating a trivial empty object against it inside a try — a structural defect (unsupported
  // keyword, bad $ref, malformed node) throws and is reported here, not at fixture time.
  try {
    validateNode({}, schema, schema, '', []);
    validateNode([], schema, schema, '', []);
    validateNode('', schema, schema, '', []);
  } catch (err) {
    errors.push(`structural defect: ${err.message}`);
  }
  return { ok: errors.length === 0, schema, errors };
}

// --- Fixture → schema bindings --------------------------------------------------------------
// Explicit, convention-driven bindings (release-spec §16.5 "every fixture validates against its
// schema"). Each binding names a matcher over the repo-relative path and the schema it asserts.
// `mode`: 'single' validate the whole file; 'jsonl' validate each line; 'array-prop:<key>'
// validate each element of value[<key>]. `skip: true` documents a fixture we intentionally do not
// schema-bind (no stable single-schema target) — surfaced as a SKIP, never silently dropped.

function buildBindings() {
  const S = (rel) => path.join('schemas', rel);
  return [
    // brand-acme instance fixtures → config/input schemas.
    { test: (p) => p === 'fixtures/brand-acme/brand.json', schema: S('config/brand.schema.json'), mode: 'single' },
    { test: (p) => p === 'fixtures/brand-acme/calendar.json', schema: S('config/calendar.schema.json'), mode: 'single' },
    { test: (p) => p === 'fixtures/brand-acme/campaign.json', schema: S('config/campaign.schema.json'), mode: 'single' },
    { test: (p) => /^fixtures\/brand-acme\/commands\/.+\.json$/.test(p), schema: S('inputs/operator-command.schema.json'), mode: 'single' },
    { test: (p) => p === 'fixtures/brand-acme/corpus/own-corpus.jsonl', schema: S('inputs/corpus-item.schema.json'), mode: 'jsonl' },
    { test: (p) => p === 'fixtures/brand-acme/media/index.json', schema: S('artifacts/archive-index-entry.schema.json'), mode: 'array-prop:assets' },

    // library-acme media-indexer fixtures (LIB-FIXTURES). The golden post-sort index entries bind
    // to archive-index-entry (each element of .assets). The recorded vision answers, the per-asset
    // sidecar metadata marker, and the existing-character-sheet marker are indexer INPUT/CONTROL
    // files (keyed-by-filename answer map / sidecar merges / character marker), not shipped artifact
    // shapes — documented skips, never silently dropped.
    { test: (p) => p === 'fixtures/library-acme/expected/index-entries.json', schema: S('artifacts/archive-index-entry.schema.json'), mode: 'array-prop:assets' },
    { test: (p) => p === 'fixtures/library-acme/expected/vision-responses.json', skip: true, reason: 'recorded vision answers keyed by filename (fake-visionFn input map, not a shipped artifact shape)' },
    { test: (p) => /^fixtures\/library-acme\/.+\.meta\.json$/.test(p), skip: true, reason: 'per-asset sidecar metadata marker (indexer merge input, not a shipped artifact shape)' },
    { test: (p) => /^fixtures\/library-acme\/character-markers\/.+\.character\.json$/.test(p), skip: true, reason: 'existing-character-sheet marker (indexer control input, not a shipped artifact shape)' },

    // recorded stage outputs (the fixture-run replay set).
    { test: (p) => p === 'fixtures/stage-outputs/brief.json', schema: S('inputs/brief.schema.json'), mode: 'single' },
    { test: (p) => p === 'fixtures/stage-outputs/draft.json', schema: S('inputs/draft.schema.json'), mode: 'single' },
    { test: (p) => p === 'fixtures/stage-outputs/media-decision.json', schema: S('artifacts/media-decision.schema.json'), mode: 'single' },
    // gate-verdicts.json is a recorded-replay ENVELOPE (recorded_fixture/stages/final_verdict),
    // not a single shipped artifact shape — no stable single-schema binding.
    { test: (p) => p === 'fixtures/stage-outputs/gate-verdicts.json', skip: true, reason: 'recorded-replay envelope (not a single shipped artifact shape)' },

    // gate-regression deterministic inputs (suffix-driven; the README pins these conventions).
    { test: (p) => /^fixtures\/gate-regression\/.+\.draft\.json$/.test(p), schema: S('inputs/draft.schema.json'), mode: 'single' },
    { test: (p) => /^fixtures\/gate-regression\/.+\.package\.json$/.test(p), schema: S('artifacts/package.schema.json'), mode: 'single' },
    { test: (p) => /^fixtures\/gate-regression\/.+\.entry\.json$/.test(p), schema: S('artifacts/queue-entry.schema.json'), mode: 'single' },

    // gate-regression manifests / answers / expecteds are the runner's control files, not engine
    // artifacts — no shipped schema. Documented skip.
    { test: (p) => /^fixtures\/gate-regression\/.+\/(expected|.*\.expected|.*\.answer)\.json$/.test(p), skip: true, reason: 'gate-regression manifest/answer control file (not a shipped artifact shape)' },
    { test: (p) => /^fixtures\/gate-regression\/.+\.copy\.md$/.test(p), skip: true, reason: 'prose copy fixture (markdown, not JSON-schema-bound)' },
    // usage-log seeds (the cooldown ledger replay) are runner-internal jsonl, not a shipped
    // artifact shape — anywhere under fixtures/ (gate-regression cooldown + stage-outputs).
    { test: (p) => /^fixtures\/.+\/usage-log\.jsonl$/.test(p), skip: true, reason: 'usage-log seed (jsonl, runner-internal)' },

    // calibration samples are a harness-control envelope (sample_id/exercises/reviewer_note), not
    // a shipped artifact — documented skip.
    { test: (p) => /^calibration\/samples\/.+\.json$/.test(p), skip: true, reason: 'calibration harness control envelope (not a shipped artifact shape)' },

    // synthetic NFT metadata is collection metadata, not an engine artifact — documented skip.
    { test: (p) => /^fixtures\/nft-acme\/.+\.json$/.test(p), skip: true, reason: 'synthetic NFT token metadata (collection data, not an engine artifact)' },

    // trends-acme trend-pathway fixtures (SRC-FIXTURES). Each standalone report binds to the trend
    // report schema. The recorded poll-responses file is a keyed-by-query REPLAY envelope (a map of
    // query-key → TrendReport[]), not a single shipped artifact shape — documented skip (the
    // embedded reports mirror ../reports/*.json which ARE bound and validated).
    { test: (p) => /^fixtures\/trends-acme\/reports\/.+\.json$/.test(p), schema: S('inputs/trend-report.schema.json'), mode: 'single' },
    { test: (p) => p === 'fixtures/trends-acme/recorded/trend-poll-responses.json', skip: true, reason: 'recorded trend-poll replay envelope keyed by query (fake-adapter input map, not a single shipped artifact shape)' },

    // work-recap-acme fixtures (SRC-FIXTURES). The sample command binds to the operator-command
    // schema. The private-term deny list and the expected leak-check ground truth are privacy-test
    // CONTROL files, not shipped artifact shapes — documented skips.
    { test: (p) => /^fixtures\/work-recap-acme\/commands\/.+\.json$/.test(p), schema: S('inputs/operator-command.schema.json'), mode: 'single' },
    { test: (p) => p === 'fixtures/work-recap-acme/private-terms.json', skip: true, reason: 'config-extendable private-term deny list (privacy-pre-pass control input, not a shipped artifact shape)' },
    { test: (p) => p === 'fixtures/work-recap-acme/expected/leak-check.json', skip: true, reason: 'privacy/leak-check ground truth (test control file, not a shipped artifact shape)' },

    // brand-dna-acme data-ingestion / brand-identity fixtures (BD-FIXTURES). The brand.json binds to
    // the brand config schema (exercising the new ingestion block); every ingested own + competitor
    // corpus item binds to corpus-item (Zone-U, exercising the new optional metrics field). The
    // recorded scrape/synthesis files are keyed REPLAY envelopes (fake-adapter/seat input maps), the
    // system fragment is a partial config slice (not a full system.json), and the expected/* files
    // are analyzer/check GROUND-TRUTH control shapes — all documented skips, never silently dropped.
    { test: (p) => p === 'fixtures/brand-dna-acme/brand.json', schema: S('config/brand.schema.json'), mode: 'single' },
    { test: (p) => /^fixtures\/brand-dna-acme\/corpora\/.+\.json$/.test(p), schema: S('inputs/corpus-item.schema.json'), mode: 'single' },
    { test: (p) => p === 'fixtures/brand-dna-acme/system.brand-dna.json', skip: true, reason: 'partial system.json fragment (brand_dna + retention slice; not a complete system config — merged/sub-validated in tests)' },
    { test: (p) => p === 'fixtures/brand-dna-acme/recorded/scrape-responses.json', skip: true, reason: 'recorded scrape replay envelope keyed by platform:handle (fake-scraper input map; embedded items mirror corpora/* which ARE bound and validated)' },
    { test: (p) => p === 'fixtures/brand-dna-acme/recorded/dna-synthesis.json', skip: true, reason: 'recorded DNA-synthesis replay envelope keyed by brand (fake-seat output map, not a shipped artifact shape)' },
    { test: (p) => /^fixtures\/brand-dna-acme\/expected\/.+\.json$/.test(p), skip: true, reason: 'brand-DNA analyzer/check ground-truth control shapes (analysis, archetype catalog, cost-estimate, cold-start, no-verbatim — asserted in tests, not shipped artifact shapes)' },
    // self-improve-acme governed-loop fixtures (SI-FIXTURES). Learning records bind to the
    // learning-record schema (they conform). The raw analytics checkpoints, the partial system
    // fragment (its self_improve block is sub-validated against system.schema #/properties/self_improve
    // in tests/self-improve-schema.test.js), and the applier/analyst control maps are documented skips.
    { test: (p) => /^fixtures\/self-improve-acme\/learning-records\/.+\.json$/.test(p), schema: S('artifacts/learning-record.schema.json'), mode: 'single' },
    { test: (p) => /^fixtures\/self-improve-acme\/analytics\/raw-.+\.json$/.test(p), skip: true, reason: 'raw engagement checkpoint inputs to the analyzer (per-content sample data, not a shipped artifact shape)' },
    { test: (p) => p === 'fixtures/self-improve-acme/system.self-improve.json', skip: true, reason: 'partial system.json fragment (self_improve slice; its self_improve block is sub-validated against system.schema #/properties/self_improve in tests/self-improve-schema.test.js)' },
    { test: (p) => p === 'fixtures/self-improve-acme/expected/applier-outcomes.json', skip: true, reason: 'governed-applier ground-truth control shape (asserted in tests, not a shipped artifact shape)' },
    { test: (p) => p === 'fixtures/self-improve-acme/recorded/analyst-refinements.json', skip: true, reason: 'recorded analyst-seat refinement replay map (fake-seat input, not a shipped artifact shape)' },

    // improvement-sharing-acme OUTBOUND/INBOUND fixtures (IS-FIXTURES; release-spec roadmap #4; DD-7).
    // The OUTBOUND learning records are based on learning-record but carry an extra $comment and (for
    // the dirty one) a planted_specifics manifest, so they are sharing-test INPUTS, not strict shipped
    // learning-record artifacts — documented skips (the canonical learning-record shape is validated by
    // the self-improve-acme records). The INBOUND contributions are a NEW inbound-contribution/v1
    // wire shape consumed by the maintainer evaluation harness (mutability.js assert*), not a shipped
    // artifact schema. The partial system fragment's improvement_sharing block is sub-validated against
    // system.schema #/properties/improvement_sharing in tests; the expected/* files are ground-truth
    // control shapes. All documented skips, never silently dropped.
    { test: (p) => /^fixtures\/improvement-sharing-acme\/outbound\/.+\.json$/.test(p), skip: true, reason: 'OUTBOUND improvement-sharing learning record carrying a sharing-test $comment + planted_specifics manifest (DD-7 sanitizer/assertShareable input, not a strict shipped learning-record artifact — the canonical shape is validated by self-improve-acme records)' },
    { test: (p) => /^fixtures\/improvement-sharing-acme\/inbound\/.+\.json$/.test(p), skip: true, reason: 'INBOUND contribution (inbound-contribution/v1 maintainer-harness wire shape consumed by mutability.js assertMachineChangeAllowed/assertNotGateLoosening, not a shipped artifact shape)' },
    { test: (p) => p === 'fixtures/improvement-sharing-acme/system.improvement-sharing.json', skip: true, reason: 'partial system.json fragment (improvement_sharing slice; its improvement_sharing block is sub-validated against system.schema #/properties/improvement_sharing in tests)' },
    { test: (p) => /^fixtures\/improvement-sharing-acme\/expected\/.+\.json$/.test(p), skip: true, reason: 'improvement-sharing ground-truth control shapes (sanitize/assertShareable + maintainer-evaluate outcomes asserted in tests, not shipped artifact shapes)' },
  ];
}

function findFixtureFiles(root) {
  const out = [];
  for (const base of ['fixtures', 'calibration']) {
    const dir = path.join(root, base);
    (function walk(d) {
      let entries;
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const abs = path.join(d, e.name);
        if (e.isDirectory()) walk(abs);
        else if (e.isFile() && (e.name.endsWith('.json') || e.name.endsWith('.jsonl'))) {
          out.push(path.relative(root, abs).replace(/\\/g, '/'));
        }
      }
    })(dir);
  }
  return out.sort();
}

// --- Main -----------------------------------------------------------------------------------

function run(argv = process.argv.slice(2)) {
  let root = REPO_ROOT;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root') root = path.resolve(argv[++i] || '.');
    else if (argv[i] === '--json') json = true;
    else if (argv[i] === '-h' || argv[i] === '--help') {
      process.stdout.write('node scripts/validate-schemas.js [--root <dir>] [--json]\n');
      return 0;
    } else { process.stderr.write(`validate-schemas: unknown arg ${argv[i]}\n`); return 2; }
  }

  const report = { schemas: [], fixtures: [], skipped: [], errors: [] };
  const schemaCache = new Map(); // relSchemaPath → loaded schema object

  // 1. Schemas parse + structural self-check.
  const schemaFiles = findSchemas(root);
  for (const abs of schemaFiles) {
    const rel = path.relative(root, abs).replace(/\\/g, '/');
    const res = loadSchema(abs);
    report.schemas.push({ file: rel, ok: res.ok });
    if (res.ok) schemaCache.set(rel, res.schema);
    else for (const e of res.errors) report.errors.push(`SCHEMA ${rel}: ${e}`);
  }

  // 2. Fixtures validate against bound schemas.
  const bindings = buildBindings();
  const fixtureFiles = findFixtureFiles(root);
  for (const rel of fixtureFiles) {
    const binding = bindings.find((b) => b.test(rel));
    if (!binding) {
      // Unbound JSON fixture: surface it so a new fixture type is never silently unchecked.
      report.skipped.push({ file: rel, reason: 'no binding (new fixture type — add a binding in scripts/validate-schemas.js)' });
      continue;
    }
    if (binding.skip) {
      report.skipped.push({ file: rel, reason: binding.reason });
      continue;
    }
    const schema = schemaCache.get(binding.schema.replace(/\\/g, '/'));
    if (!schema) {
      report.errors.push(`FIXTURE ${rel}: bound schema ${binding.schema} did not load`);
      report.fixtures.push({ file: rel, schema: binding.schema, ok: false });
      continue;
    }
    let raw;
    try { raw = fs.readFileSync(path.join(root, rel), 'utf8'); } catch (err) {
      report.errors.push(`FIXTURE ${rel}: unreadable (${err.message})`);
      continue;
    }
    const instances = [];
    try {
      if (binding.mode === 'jsonl') {
        raw.split(/\r?\n/).forEach((line, i) => {
          if (line.trim()) instances.push({ label: `line ${i + 1}`, value: JSON.parse(line) });
        });
      } else if (binding.mode && binding.mode.startsWith('array-prop:')) {
        const key = binding.mode.slice('array-prop:'.length);
        const parsed = JSON.parse(raw);
        const arr = parsed && parsed[key];
        if (!Array.isArray(arr)) throw new Error(`expected array property "${key}"`);
        arr.forEach((v, i) => instances.push({ label: `${key}[${i}]`, value: v }));
      } else {
        instances.push({ label: '', value: JSON.parse(raw) });
      }
    } catch (err) {
      report.errors.push(`FIXTURE ${rel}: does not parse (${err.message})`);
      report.fixtures.push({ file: rel, schema: binding.schema, ok: false });
      continue;
    }

    let allOk = true;
    for (const { label, value } of instances) {
      const res = validate(value, schema);
      if (!res.ok) {
        allOk = false;
        for (const e of res.errors) report.errors.push(`FIXTURE ${rel}${label ? ` (${label})` : ''} vs ${binding.schema}: ${e}`);
      }
    }
    report.fixtures.push({ file: rel, schema: binding.schema, instances: instances.length, ok: allOk });
  }

  const ok = report.errors.length === 0;

  if (json) {
    process.stdout.write(`${JSON.stringify({ ok, ...report }, null, 2)}\n`);
  } else {
    const schemaFail = report.schemas.filter((s) => !s.ok).length;
    const fixtureFail = report.fixtures.filter((f) => !f.ok).length;
    process.stdout.write(
      `validate-schemas: ${report.schemas.length} schemas (${schemaFail} failing), `
      + `${report.fixtures.length} bound fixtures (${fixtureFail} failing), `
      + `${report.skipped.length} skipped.\n`,
    );
    if (!ok) {
      process.stderr.write('\nvalidate-schemas: FAILED\n');
      for (const e of report.errors) process.stderr.write(`  ${e}\n`);
    } else {
      process.stdout.write('validate-schemas: OK — all schemas parse and every bound fixture validates.\n');
    }
  }

  return ok ? 0 : 1;
}

if (require.main === module) {
  process.exitCode = run();
}

module.exports = { run, validate, validateNode, loadSchema, buildBindings, findSchemas, findFixtureFiles };
