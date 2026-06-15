'use strict';

/**
 * Tests for the work-recap memory source (engine/sources/work-recap/*).
 * release-spec §2.1 seeding · §2.4 double gate · §3.3 accounts · §13.3 redact-at-write · RD-12.
 *
 * Zero-key by construction: an in-memory fs fake is injected via opts.fs (the §12.5 vision-seam
 * pattern), so no real file system, no secrets, no network. All fixture content is SYNTHETIC and
 * brand-neutral ("Acme Cosmos") per §0.3 r6 / §16.1 — no instance data, no production codenames.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { scanMemory } = require('../scan-memory.js');
const { buildWorkRecapSeed } = require('../build-seed.js');
const { sanitizeText, sanitizeItems } = require('../privacy-filter.js');
const { MASK } = require('../../../shared/redact.js');

/**
 * Build an in-memory fs fake from a { relPath: contents } map rooted at `root`. Directories are
 * inferred from the file paths. Implements only the four methods the scanner uses.
 */
function makeFakeFs(root, files) {
  const norm = (p) => path.normalize(p);
  const fileMap = new Map();
  const dirSet = new Set([norm(root)]);
  for (const [rel, contents] of Object.entries(files)) {
    const full = norm(path.join(root, rel));
    fileMap.set(full, contents);
    let dir = path.dirname(full);
    while (dir && dir.length >= norm(root).length) {
      dirSet.add(dir);
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return {
    existsSync: (p) => {
      const n = norm(p);
      return fileMap.has(n) || dirSet.has(n);
    },
    statSync: (p) => {
      const n = norm(p);
      const isDir = dirSet.has(n) && !fileMap.has(n);
      return { isDirectory: () => isDir, mtime: new Date('2026-06-14T12:00:00Z') };
    },
    readdirSync: (p) => {
      const n = norm(p);
      const out = new Set();
      for (const f of fileMap.keys()) {
        if (path.dirname(f) === n) out.add(path.basename(f));
      }
      for (const d of dirSet) {
        if (d !== n && path.dirname(d) === n) out.add(path.basename(d));
      }
      return Array.from(out);
    },
    readFileSync: (p) => {
      const n = norm(p);
      if (!fileMap.has(n)) throw new Error(`ENOENT: ${p}`);
      return fileMap.get(n);
    },
  };
}

const ROOT = '/fake/instance/memory-root';
const NOW = new Date('2026-06-14T18:00:00Z');

// ---------------------------------------------------------------------------
// scanMemory — gating + no-op contract
// ---------------------------------------------------------------------------

test('scanMemory is OFF BY DEFAULT (no config → disabled no-op)', () => {
  const r = scanMemory({});
  assert.equal(r.enabled, false);
  assert.equal(r.scanned, false);
  assert.equal(r.reason, 'disabled');
  assert.deepEqual(r.items, []);
});

test('scanMemory enabled but no memory_path → clean no-op', () => {
  const r = scanMemory({ work_recap: { enabled: true } });
  assert.equal(r.enabled, true);
  assert.equal(r.reason, 'no_memory_path');
  assert.deepEqual(r.items, []);
});

test('scanMemory enabled with a missing path → clean no-op, never throws', () => {
  const fs = makeFakeFs('/some/other/root', {});
  const r = scanMemory({
    work_recap: { enabled: true, memory_path: ROOT },
    fs,
    now: NOW,
  });
  assert.equal(r.reason, 'memory_path_missing');
  assert.deepEqual(r.items, []);
});

// ---------------------------------------------------------------------------
// scanMemory — extraction
// ---------------------------------------------------------------------------

test('scanMemory extracts work items from MEMORY.md and memory/*.md', () => {
  const fs = makeFakeFs(ROOT, {
    'MEMORY.md': [
      '# Curated memory',
      '- [09:15] Shipped the new onboarding flow for Acme Cosmos',
      '- This is just a note with no work signal',
      '- [10:00] ⏭️ skipped the analytics rework because it was deprioritized',
    ].join('\n'),
    'memory/2026-06-14.md': [
      '## 2026-06-14',
      '[11:30] ✅ Built the queue retry path and merged it',
      '[12:00] ✅ Fixed the lock heartbeat bug',
    ].join('\n'),
  });

  const r = scanMemory({
    work_recap: { enabled: true, memory_path: ROOT },
    fs,
    now: NOW,
  });

  assert.equal(r.enabled, true);
  assert.equal(r.scanned, true);
  const summaries = r.items.map((i) => i.summary);
  assert.ok(summaries.some((s) => s.includes('onboarding flow')), 'ship line captured');
  assert.ok(summaries.some((s) => s.includes('queue retry path')), 'built line captured');
  assert.ok(summaries.some((s) => s.includes('lock heartbeat')), 'fixed line captured');
  // Non-work note and the ⏭️ skip line must NOT be captured.
  assert.ok(!summaries.some((s) => s.includes('just a note')), 'non-work note skipped');
  assert.ok(!summaries.some((s) => s.includes('deprioritized')), 'skip line skipped');
  // Markers are stripped from the summary.
  assert.ok(!summaries.some((s) => /^\[\d/.test(s)), 'time markers stripped');
  assert.ok(!summaries.some((s) => s.startsWith('✅')), 'status emoji stripped');
});

test('scanMemory honors lookback_days against daily-log file dates', () => {
  const fs = makeFakeFs(ROOT, {
    'memory/2026-06-14.md': '[09:00] ✅ Built today thing',
    'memory/2026-06-13.md': '[09:00] ✅ Built yesterday thing',
    'memory/2026-06-01.md': '[09:00] ✅ Built two weeks ago thing',
  });
  const r = scanMemory({
    work_recap: { enabled: true, memory_path: ROOT, lookback_days: 2 },
    fs,
    now: NOW,
  });
  const summaries = r.items.map((i) => i.summary).join(' | ');
  assert.ok(summaries.includes('today thing'));
  assert.ok(summaries.includes('yesterday thing'));
  assert.ok(!summaries.includes('two weeks ago'), 'out-of-lookback file excluded');
});

test('scanMemory orders items newest-first', () => {
  const fs = makeFakeFs(ROOT, {
    'memory/2026-06-13.md': '[09:00] ✅ Built older',
    'memory/2026-06-14.md': '[09:00] ✅ Built newer',
  });
  const r = scanMemory({
    work_recap: { enabled: true, memory_path: ROOT, lookback_days: 3 },
    fs,
    now: NOW,
  });
  assert.equal(r.items[0].summary.includes('newer'), true);
});

// ---------------------------------------------------------------------------
// privacy-filter — the load-bearing pre-pass
// ---------------------------------------------------------------------------

test('sanitizeText masks credential/secret shapes via redact.js', () => {
  const longToken = 'abcDEF123456ghiJKL789012mnoPQR345678stuVWX'; // 40+ opaque chars
  const { text, flags, redacted } = sanitizeText(`Shipped deploy with token ${longToken}`);
  assert.ok(text.includes(MASK), 'secret-shaped span masked');
  assert.ok(!text.includes(longToken), 'raw token not present');
  assert.equal(redacted, true);
  assert.ok(flags.some((f) => f.family === 'secret_shape'));
});

test('sanitizeText masks financial amounts (structural pattern)', () => {
  const { text, flags } = sanitizeText('Closed a $250,000 partner deal and a £50k grant');
  assert.ok(!text.includes('250,000'), 'dollar amount masked');
  assert.ok(!text.includes('50k'), 'magnitude amount masked');
  assert.ok(flags.some((f) => f.family === 'financial'));
});

test('sanitizeText masks internal-id shapes (structural pattern)', () => {
  const { text, flags } = sanitizeText('Resolved PROJ-1234 and TICKET_88 internally');
  assert.ok(!text.includes('PROJ-1234'), 'internal id masked');
  assert.ok(!text.includes('TICKET_88'), 'internal id masked');
  assert.ok(flags.some((f) => f.family === 'internal_id'));
});

test('sanitizeText applies the config-extendable private-term deny list', () => {
  const { text, flags } = sanitizeText(
    'Met with Stardust Partners about the Nebula codename launch',
    { privateTerms: ['Stardust Partners', 'Nebula'] },
  );
  assert.ok(!text.includes('Stardust Partners'), 'partner name masked');
  assert.ok(!text.includes('Nebula'), 'codename masked');
  assert.ok(flags.some((f) => f.family === 'private_term'));
  // PRIVACY: the flag must NOT echo the matched term back (it would re-leak it into the seed).
  assert.ok(!flags.some((f) => f.term === 'Stardust Partners' || f.term === 'Nebula'));
  assert.ok(flags.every((f) => f.family !== 'private_term' || typeof f.term_fp === 'string'));
});

test('sanitizeText leaves clean text untouched and flags nothing', () => {
  const clean = 'Shipped the public docs refresh and fixed a typo';
  const { text, flags, redacted } = sanitizeText(clean);
  assert.equal(text, clean);
  assert.equal(redacted, false);
  assert.deepEqual(flags, []);
});

test('sanitizeText deny list is regex-safe (special chars treated literally)', () => {
  const { text } = sanitizeText('feature a.b launched', { privateTerms: ['a.b'] });
  // 'a.b' literal masked; 'axb' would NOT be (proves no unescaped regex dot).
  assert.ok(text.includes(MASK));
  const { text: t2 } = sanitizeText('axb launched fine', { privateTerms: ['a.b'] });
  assert.ok(!t2.includes(MASK), 'literal-only match, no regex dot');
});

test('sanitizeItems drops raw and aggregates privacy_flags', () => {
  const items = [
    { summary: 'Shipped the $1,000,000 deal', raw: 'raw with $1,000,000 and more', date: '2026-06-14' },
    { summary: 'Fixed a public bug', raw: 'raw', date: '2026-06-14' },
  ];
  const out = sanitizeItems(items);
  assert.ok(!('raw' in out.items[0]), 'raw field dropped');
  assert.equal(out.privacy_flags.any_redacted, true);
  assert.ok(out.privacy_flags.families.includes('financial'));
  assert.equal(out.privacy_flags.per_item, 1, 'only the financial item was redacted');
});

// ---------------------------------------------------------------------------
// buildWorkRecapSeed — the seed contract
// ---------------------------------------------------------------------------

test('buildWorkRecapSeed disabled → safe empty seed (no throw)', () => {
  const seed = buildWorkRecapSeed({});
  assert.equal(seed.source, 'work-recap');
  assert.equal(seed.enabled, false);
  assert.deepEqual(seed.work_items, []);
  assert.equal(seed.privacy_flags.any_redacted, false);
  assert.ok(typeof seed.angle === 'string' && seed.angle.length > 0);
});

test('buildWorkRecapSeed produces a sanitized seed with build-in-public angle', () => {
  const fs = makeFakeFs(ROOT, {
    'memory/2026-06-14.md': [
      '[09:00] ✅ Shipped the new dashboard for the founder account',
      '[10:00] ✅ Closed a $500,000 round with Stardust Partners',
    ].join('\n'),
  });
  const seed = buildWorkRecapSeed({
    work_recap: {
      enabled: true,
      memory_path: ROOT,
      account: 'founder',
      private_terms: ['Stardust Partners'],
    },
    fs,
    now: NOW,
  });

  assert.equal(seed.enabled, true);
  assert.equal(seed.slot_type, 'work_recap');
  assert.equal(seed.trust_zone, 'O');
  assert.equal(seed.account, 'founder');
  assert.ok(/build-in-public/i.test(seed.angle));

  // The sensitive line is sanitized: no financial figure, no partner name survives.
  const blob = JSON.stringify(seed.work_items);
  assert.ok(!blob.includes('500,000'), 'financial figure stripped from seed');
  assert.ok(!blob.includes('Stardust Partners'), 'partner name stripped from seed');

  // The clean line survives.
  assert.ok(blob.includes('new dashboard'), 'shareable work survives');

  // privacy_flags must signal that masking happened so the gate can hard-block on residual leak.
  assert.equal(seed.privacy_flags.any_redacted, true);
  assert.ok(seed.privacy_flags.families.length > 0);

  // provenance reflects the configured (not bundled) memory path.
  assert.equal(seed.provenance.memory_path_configured, true);
  assert.equal(seed.provenance.method, 'memory-scan');
  assert.ok(seed.provenance.files_scanned.includes(path.join('memory', '2026-06-14.md')));
});

test('buildWorkRecapSeed never carries raw memory into the seed', () => {
  const fs = makeFakeFs(ROOT, {
    'MEMORY.md': '[09:00] ✅ Built feature; internal note SECRET-CONTEXT-001 here',
  });
  const seed = buildWorkRecapSeed({
    work_recap: { enabled: true, memory_path: ROOT },
    fs,
    now: NOW,
  });
  for (const item of seed.work_items) {
    assert.ok(!('raw' in item), 'no raw field on any seed work item');
  }
  // The internal-id shape is masked.
  const blob = JSON.stringify(seed.work_items);
  assert.ok(!blob.includes('SECRET-CONTEXT-001'));
});
