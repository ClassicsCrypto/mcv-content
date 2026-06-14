'use strict';

/**
 * Pass-logic + provider-stub integration test for the visual gate (release-spec §14.1 visual
 * layer; §10.2 VIS.* family; §12.5 provider seam; §16.3 gate-regression). Runs the
 * gate-regression/visual-default-pack fixtures through the real pack + a stubbed vision
 * provider (injected spawnSync) so CI exercises the whole path with zero keys and zero images.
 *
 * Asserts:
 *   - the shipped brand-neutral default pack drives the right verdict for each fixture;
 *   - every emitted code is VIS.*-namespaced and carries the §7.2 detected_codes shape;
 *   - the provider invocation is shell:false and routes the prompt via stdin, not the cmdline
 *     (the image path is the only argv value) — the production hardening preserved;
 *   - JSON-line provider output is parsed (CLI providers stream events);
 *   - no brand-specific names appear in the engine module (config-seam contract).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { visualCheck, parseVisionAnswer } = require('../index');
const { resolveProvider, runVision } = require('../provider');
const questionPack = require('../question-pack');

const FIXTURES = path.join(__dirname, '..', '..', '..', '..', 'fixtures', 'gate-regression', 'visual-default-pack');

function loadFixture(name) {
  const answer = JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.answer.json`), 'utf8'));
  const expected = JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.expected.json`), 'utf8'));
  return { answer, expected };
}

/** A stub spawnSync that returns the fixture answer as a single JSON line on stdout. */
function stubProviderReturning(answerObj) {
  return (_cmd, _args, _opts) => ({ status: 0, stdout: `${JSON.stringify(answerObj)}\n`, stderr: '' });
}

function withImage(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-int-'));
  const img = path.join(tmp, 'img.png');
  fs.writeFileSync(img, 'fake-image-bytes');
  try {
    return fn(tmp, img);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

for (const name of ['clean', 'off-brand', 'embedded-text', 'identity-missing']) {
  test(`default pack: ${name} fixture ⇒ expected verdict + codes`, () => {
    const { answer, expected } = loadFixture(name);
    withImage((tmp, img) => {
      const result = visualCheck(
        {
          content_id: `test-vc-${name}`,
          media_path: img,
          brand: 'acme-cosmos',
          identity_required: !!expected.identity_required,
        },
        {
          provider: { kind: 'cli', model: 'demo', options: { command: 'true' } },
          spawnSync: stubProviderReturning(answer),
          outDir: tmp,
          env: {},
        },
      );
      assert.equal(result.stage, 'visual');
      assert.equal(result.verdict, expected.verdict, `${name} verdict`);
      assert.equal(result['x-visual'].vision_pass, expected.vision_pass, `${name} vision_pass`);
      assert.deepEqual(result.detected_codes.map((d) => d.code), expected.codes, `${name} codes`);
      for (const d of result.detected_codes) {
        assert.equal(d.family, 'VIS');
        assert.equal(d.source, 'visual');
        assert.ok(d.code.startsWith('VIS.'));
        assert.ok(['hard', 'soft'].includes(d.tier));
        assert.ok(['block', 'correct', 'warn'].includes(d.disposition));
      }
    });
  });
}

test('provider invocation is shell:false and sends the prompt via stdin (image path is the only argv)', () => {
  withImage((tmp, img) => {
    let captured = null;
    const spy = (cmd, args, opts) => {
      captured = { cmd, args, opts };
      return { status: 0, stdout: JSON.stringify(loadFixture('clean').answer), stderr: '' };
    };
    visualCheck(
      { content_id: 'test-vc-spy', media_path: img, brand: 'acme-cosmos' },
      { provider: { kind: 'cli', options: { command: 'demo-vision', args: ['exec'] } }, spawnSync: spy, outDir: tmp, env: {} },
    );
    assert.ok(captured, 'provider was invoked');
    assert.equal(captured.opts.shell, false, 'shell:false invariant');
    assert.equal(typeof captured.opts.input, 'string');
    assert.match(captured.opts.input, /Inspect the attached image/);
    // The prompt MUST NOT appear in the argv; the image path MUST.
    assert.ok(!captured.args.some((a) => /Inspect the attached image/.test(String(a))), 'prompt not on cmdline');
    assert.ok(captured.args.includes(img), 'image path is an argv value');
    assert.ok(Number.isFinite(captured.opts.timeout), 'a bounded timeout is set');
  });
});

test('parseVisionAnswer extracts JSON from a JSON-line event stream', () => {
  const stream = [
    JSON.stringify({ type: 'started' }),
    JSON.stringify({ item: { type: 'agent_message', text: '{"matches_brief_subject": true, "embedded_text_dates_logos": "none"}' } }),
    JSON.stringify({ type: 'done' }),
  ].join('\n');
  const parsed = parseVisionAnswer(stream);
  assert.equal(parsed.matches_brief_subject, true);
  assert.equal(parsed.embedded_text_dates_logos, 'none');
});

test('resolveProvider: absent/unknown kind ⇒ null (degrade-to-skip); cli/http ⇒ resolved with bounded timeout', () => {
  assert.equal(resolveProvider(null), null);
  assert.equal(resolveProvider({}), null);
  assert.equal(resolveProvider({ kind: 'mystery' }), null);
  const cli = resolveProvider({ kind: 'cli', model: 'm', timeout_ms: 5000, options: { command: 'x' } });
  assert.equal(cli.kind, 'cli');
  assert.equal(cli.timeoutMs, 5000);
  const def = resolveProvider({ kind: 'cli' });
  assert.ok(def.timeoutMs > 0, 'a default timeout is applied');
});

test('runVision throws VisionProviderError when a cli provider has no command (caller turns it into VIS.CHECK_ERROR)', () => {
  const p = resolveProvider({ kind: 'cli' });
  assert.throws(
    () => runVision(p, { prompt: 'x', imagePath: '/tmp/x.png', env: {}, spawnSync: () => ({ status: 0, stdout: '{}' }) }),
    /requires options\.command/,
  );
});

test('the engine module ships zero brand-specific names (config-seam contract, §0.3 r6)', () => {
  const moduleText = [
    fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8'),
    fs.readFileSync(path.join(__dirname, '..', 'provider.js'), 'utf8'),
    fs.readFileSync(path.join(__dirname, '..', 'question-pack.js'), 'utf8'),
    fs.readFileSync(path.join(__dirname, '..', 'codes.js'), 'utf8'),
  ].join('\n');
  // The authoritative brand/codename leak scan is the CI hygiene job (batch P4-CI-FULL),
  // which loads the operator's private deny-list from $ENGINE_BRAND_DENYLIST at scan time.
  // Real brand names and production codenames are NEVER committed to this public repo
  // (spec §0.3 r6, regenerate-never-redact) — so this test carries none: it honors the
  // injected deny-list when present and self-checks the detection mechanism with a synthetic term.
  const haystack = moduleText.toLowerCase();
  const denyList = (process.env.ENGINE_BRAND_DENYLIST || '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  for (const banned of denyList) {
    assert.ok(!haystack.includes(banned), `engine code must not contain deny-listed term "${banned}"`);
  }
  const SYNTHETIC = 'examplebrand-xyzzy';
  assert.ok(
    !haystack.includes(SYNTHETIC) && `${haystack} ${SYNTHETIC}`.includes(SYNTHETIC),
    'sanity: substring leak-detection mechanism works',
  );
});

test('default question pack loads from rules/visual and has the canonical shape', () => {
  const pack = questionPack.resolveQuestionPack({ env: {} });
  assert.equal(pack.id, 'default');
  assert.ok(Array.isArray(pack.questions) && pack.questions.length > 0);
  assert.ok(Array.isArray(pack.pass.all_true));
  assert.ok(Array.isArray(pack.pass.all_false));
});
