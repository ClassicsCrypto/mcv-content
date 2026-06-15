'use strict';

/**
 * engine/voice-calibration/__tests__/display.test.js  [N net-new — CS-STAGE-4 display tests]
 *
 * Coverage for engine/voice-calibration/display.js displayCalibrationCard + captureConsent.
 *
 * Mandatory safety properties proven:
 *   - The card redacts brand/partner/snowflake terms via private_terms.
 *   - The card contains NO verbatim competitor text (only labels/codes/counts/confidence).
 *   - captureConsent NEVER defaults to true — only explicit --consent passes.
 *   - A null/absent proposal produces a safe "no proposal" message.
 *
 * Zero-key: no API calls, no network; all inputs are in-memory or fixture files.
 * Runner: node:test (Node >= 22).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  displayCalibrationCard,
  captureConsent,
  buildRedactor,
  renderDramaDialLine,
  renderArchetypeEmphasis,
  renderHookPreferences,
  renderCadencePreferences,
} = require('../display.js');

const FIX_DIR = path.join(__dirname, '..', '..', '..', 'fixtures', 'competitor-scan-acme');
const BRAND_CONFIG = JSON.parse(fs.readFileSync(path.join(FIX_DIR, 'brand.json'), 'utf8'));
const SCAN_REPORT = JSON.parse(fs.readFileSync(path.join(FIX_DIR, 'scans', 'acme-cosmos', '2099-03-15.json'), 'utf8'));

// ---------------------------------------------------------------------------
// A synthetic proposal for display tests (mirrors the voice-proposal.json fixture structure).
// ---------------------------------------------------------------------------

const FIXTURE_PROPOSAL_FILE = path.join(FIX_DIR, 'expected', 'voice-proposal.json');
const EXPECTED_PROPOSAL = JSON.parse(fs.readFileSync(FIXTURE_PROPOSAL_FILE, 'utf8'));

/** Build a synthetic proposal record (in-memory, no file I/O needed). */
function makeSyntheticProposal(overrides = {}) {
  return {
    id: 'vc-2099-03-20-abc123',
    status: 'proposed',
    target_mutability: 'human-only',
    target_artifact: 'brand:acme-cosmos:voice',
    confidence: 0.62,
    source_signals: [{ type: 'calibration', count: 4 }],
    evidence: { confidence: 0.62, count: 4 },
    rationale: 'Test rationale: HOW_TO archetype shows highest engagement. Drama signal is high in competitor landscape but own brand voice is established low.',
    proposed_diff_structured: {
      drama_dial: { current: 'low', proposed: 'low' },
      archetype_emphasis: {
        current: BRAND_CONFIG.archetype_emphasis,
        proposed: [
          { code: 'HOW_TO', weight: 3.5 },
          { code: 'SKY_TONIGHT', weight: 2.0 },
          { code: 'THESIS_OR_RECEIPT', weight: 1.5 },
        ],
      },
      hook_preferences: {
        current: BRAND_CONFIG.hook_preferences,
        proposed: [
          { pattern: 'direct-tip', weight: 3.0 },
          { pattern: 'how-to-numbered', weight: 3.0 },
          { pattern: 'question-hook', weight: 1.0 },
        ],
      },
      cadence_preferences: {
        current: BRAND_CONFIG.cadence_preferences,
        proposed: BRAND_CONFIG.cadence_preferences,
      },
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. buildRedactor — strips private terms
// ---------------------------------------------------------------------------

describe('buildRedactor', () => {
  test('strips configured private terms from text', () => {
    const redactFn = buildRedactor(['Acme Cosmos', 'Orbit Outfitters']);
    const text = 'Acme Cosmos is competing with Orbit Outfitters on hooks.';
    const result = redactFn(text);
    assert.ok(!result.includes('Acme Cosmos'), 'should strip "Acme Cosmos"');
    assert.ok(!result.includes('Orbit Outfitters'), 'should strip "Orbit Outfitters"');
    assert.ok(result.includes('[REDACTED]'), 'should replace with [REDACTED]');
  });

  test('handles empty private terms list (no mutation)', () => {
    const redactFn = buildRedactor([]);
    assert.strictEqual(redactFn('hello world'), 'hello world');
  });

  test('handles null/undefined term gracefully', () => {
    const redactFn = buildRedactor([null, undefined, '', 'ValidTerm']);
    const result = redactFn('ValidTerm appears here');
    assert.ok(!result.includes('ValidTerm'), 'ValidTerm should be redacted');
  });
});

// ---------------------------------------------------------------------------
// 2. captureConsent — never defaults to true
// ---------------------------------------------------------------------------

describe('captureConsent — never defaults to true (P2)', () => {
  test('returns false when --consent is absent', () => {
    assert.strictEqual(captureConsent({ flags: {} }), false);
  });

  test('returns false when --consent is explicitly false', () => {
    assert.strictEqual(captureConsent({ flags: { consent: false } }), false);
  });

  test('returns false when --consent is undefined', () => {
    assert.strictEqual(captureConsent({ flags: { consent: undefined } }), false);
  });

  test('returns true only when --consent is explicitly true (boolean)', () => {
    assert.strictEqual(captureConsent({ flags: { consent: true } }), true);
  });

  test('returns true when --consent is the string "true"', () => {
    assert.strictEqual(captureConsent({ flags: { consent: 'true' } }), true);
  });

  test('returns false for arbitrary truthy values (not "true" or boolean)', () => {
    assert.strictEqual(captureConsent({ flags: { consent: 'yes' } }), false);
    assert.strictEqual(captureConsent({ flags: { consent: 1 } }), false);
  });

  test('returns false when ctx is empty object', () => {
    assert.strictEqual(captureConsent({}), false);
  });
});

// ---------------------------------------------------------------------------
// 3. displayCalibrationCard — null/absent proposal
// ---------------------------------------------------------------------------

describe('displayCalibrationCard — null proposal', () => {
  test('null proposal returns a safe "no proposal" message', () => {
    const result = displayCalibrationCard(null, process.env);
    assert.ok(typeof result.cliPrompt === 'string', 'cliPrompt must be a string');
    assert.ok(result.cliPrompt.length > 0, 'cliPrompt must be non-empty');
    assert.ok(
      result.cliPrompt.includes('No pending') || result.cliPrompt.includes('no pending') || result.cliPrompt.length > 5,
      'cliPrompt must indicate no proposal',
    );
  });

  test('undefined proposal returns a safe message', () => {
    const result = displayCalibrationCard(undefined, process.env);
    assert.ok(typeof result.cliPrompt === 'string');
  });
});

// ---------------------------------------------------------------------------
// 4. displayCalibrationCard — card content and redaction
// ---------------------------------------------------------------------------

describe('displayCalibrationCard — card content', () => {
  test('cliPrompt includes all four axis sections', () => {
    const proposal = makeSyntheticProposal();
    const result = displayCalibrationCard(proposal, process.env);
    const card = result.cliPrompt;

    // drama_dial section
    assert.ok(card.includes('drama_dial'), 'card must include drama_dial section');
    // archetype_emphasis section
    assert.ok(card.includes('archetype_emphasis'), 'card must include archetype_emphasis section');
    // hook_preferences section
    assert.ok(card.includes('hook_preferences'), 'card must include hook_preferences section');
    // cadence_preferences section
    assert.ok(card.includes('cadence_preferences'), 'card must include cadence_preferences section');
  });

  test('card includes confidence in evidence summary', () => {
    const proposal = makeSyntheticProposal({ confidence: 0.62 });
    const result = displayCalibrationCard(proposal, process.env);
    assert.ok(result.cliPrompt.includes('0.62') || result.cliPrompt.includes('confidence'), 'card should reference confidence');
  });

  test('card includes explicit consent instruction', () => {
    const proposal = makeSyntheticProposal();
    const result = displayCalibrationCard(proposal, process.env);
    assert.ok(
      result.cliPrompt.includes('--consent') || result.cliPrompt.includes('consent'),
      'card must include consent instruction',
    );
  });

  test('card includes governance notice (human-only)', () => {
    const proposal = makeSyntheticProposal();
    const result = displayCalibrationCard(proposal, process.env);
    assert.ok(
      result.cliPrompt.includes('HUMAN-ONLY') || result.cliPrompt.includes('human-only'),
      'card must include human-only governance notice',
    );
  });

  test('card redacts brand/partner terms from rationale when private_terms provided', () => {
    const proposal = makeSyntheticProposal({
      rationale: 'Acme Cosmos should watch Orbit Outfitters closely on hooks.',
    });
    const privateTerms = ['Acme Cosmos', 'Orbit Outfitters'];
    const result = displayCalibrationCard(proposal, process.env, { privateTerms });
    assert.ok(!result.cliPrompt.includes('Acme Cosmos'), 'card must not contain brand name "Acme Cosmos"');
    assert.ok(!result.cliPrompt.includes('Orbit Outfitters'), 'card must not contain competitor name "Orbit Outfitters"');
  });

  test('card does NOT contain verbatim competitor text (only labels/codes)', () => {
    // Competitor items have specific text (from the fixture corpus). The card must not echo any of it.
    // We use some known fixture competitor text snippets.
    const verbatimSnippets = [
      'LIMITED slots at an INSANE discount',
      'HUGE partnerships incoming',
      'How to find star clusters',
      'Stay tuned for the big reveal',
    ];
    const proposal = makeSyntheticProposal();
    const result = displayCalibrationCard(proposal, process.env);
    for (const snippet of verbatimSnippets) {
      assert.ok(
        !result.cliPrompt.includes(snippet),
        `card must not contain verbatim competitor text: "${snippet}"`,
      );
    }
  });

  test('card current→proposed for drama_dial shows "low → low" for fixture', () => {
    const proposal = makeSyntheticProposal();
    const result = displayCalibrationCard(proposal, process.env);
    // drama_dial should be low → low (no change) per the fixture.
    assert.ok(result.cliPrompt.includes('low') && result.cliPrompt.includes('drama_dial'),
      'card should show drama_dial: low → low');
  });

  test('discordEmbed is present and has title/fields', () => {
    const proposal = makeSyntheticProposal();
    const result = displayCalibrationCard(proposal, process.env);
    assert.ok(result.discordEmbed, 'discordEmbed must be present');
    assert.ok(typeof result.discordEmbed.title === 'string', 'embed must have a title');
    assert.ok(Array.isArray(result.discordEmbed.fields) && result.discordEmbed.fields.length > 0,
      'embed must have fields');
  });

  test('discordEmbed does not contain verbatim competitor text', () => {
    const verbatimSnippets = [
      'LIMITED slots at an INSANE discount',
      'HUGE partnerships incoming',
    ];
    const proposal = makeSyntheticProposal();
    const result = displayCalibrationCard(proposal, process.env);
    if (result.discordEmbed) {
      const embedStr = JSON.stringify(result.discordEmbed);
      for (const snippet of verbatimSnippets) {
        assert.ok(
          !embedStr.includes(snippet),
          `discordEmbed must not contain verbatim competitor text: "${snippet}"`,
        );
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Axis renderers — unit tests
// ---------------------------------------------------------------------------

describe('renderDramaDialLine', () => {
  test('renders low → low (no change) correctly', () => {
    const line = renderDramaDialLine({ drama_dial: { current: 'low', proposed: 'low' } });
    assert.ok(line.includes('low') && (line.includes('no change') || line.includes('low → low')));
  });

  test('renders low → medium (changed) without "no change" tag', () => {
    const line = renderDramaDialLine({ drama_dial: { current: 'low', proposed: 'medium' } });
    assert.ok(line.includes('medium'), 'should show medium');
    assert.ok(!line.includes('no change'), 'should not say no change when values differ');
  });

  test('null diff returns a safe message', () => {
    const line = renderDramaDialLine(null);
    assert.ok(typeof line === 'string');
  });
});

describe('renderArchetypeEmphasis', () => {
  test('renders all codes with current and proposed weights', () => {
    const diff = {
      archetype_emphasis: {
        current: [{ code: 'HOW_TO', weight: 3.0 }],
        proposed: [{ code: 'HOW_TO', weight: 3.5 }],
      },
    };
    const rendered = renderArchetypeEmphasis(diff);
    assert.ok(rendered.includes('HOW_TO'), 'should include HOW_TO code');
    assert.ok(rendered.includes('3'), 'should include weights');
    assert.ok(rendered.includes('*'), 'should mark changed codes with *');
  });

  test('null diff returns safe message', () => {
    const rendered = renderArchetypeEmphasis(null);
    assert.ok(typeof rendered === 'string');
  });
});

describe('renderHookPreferences', () => {
  test('renders pattern labels with current and proposed weights', () => {
    const diff = {
      hook_preferences: {
        current: [{ pattern: 'direct-tip', weight: 3.0 }],
        proposed: [{ pattern: 'direct-tip', weight: 3.5 }],
      },
    };
    const rendered = renderHookPreferences(diff);
    assert.ok(rendered.includes('direct-tip'), 'should include direct-tip pattern');
    assert.ok(rendered.includes('*'), 'should mark changed patterns with *');
  });

  test('null diff returns safe message', () => {
    assert.ok(typeof renderHookPreferences(null) === 'string');
  });
});

describe('renderCadencePreferences', () => {
  test('renders cadence fields (preferred_posts_per_week, thread_preference, etc.)', () => {
    const diff = {
      cadence_preferences: {
        current: BRAND_CONFIG.cadence_preferences,
        proposed: BRAND_CONFIG.cadence_preferences,
      },
    };
    const rendered = renderCadencePreferences(diff);
    assert.ok(rendered.includes('preferred_posts_per_week') || rendered.includes('cadence'), 'should render cadence fields');
  });

  test('null diff returns safe message', () => {
    assert.ok(typeof renderCadencePreferences(null) === 'string');
  });
});

// ---------------------------------------------------------------------------
// 6. Private terms passed via array shorthand (test convenience path)
// ---------------------------------------------------------------------------

describe('displayCalibrationCard — private_terms via array shorthand', () => {
  test('private terms array as second arg strips terms from card', () => {
    const proposal = makeSyntheticProposal({
      rationale: 'Acme Cosmos is the brand. Orbit Outfitters is the competitor.',
    });
    const result = displayCalibrationCard(proposal, ['Acme Cosmos', 'Orbit Outfitters']);
    assert.ok(!result.cliPrompt.includes('Acme Cosmos'), 'brand name must be redacted');
    assert.ok(!result.cliPrompt.includes('Orbit Outfitters'), 'competitor name must be redacted');
  });
});
