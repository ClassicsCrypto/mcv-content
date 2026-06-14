'use strict';

/**
 * tests/analytics-engagement.test.js  [A — ported + extended]
 *
 * Covers ANALYTICS & LEARNING v1 (engine/analytics/engagement/*; release-spec §7.9, §7.10,
 * §8.9, §15.1). Ported from the production analytics-runner split test (the module-export shape
 * + the "analytics can NEVER write the queue" invariant) and extended for the public behavior:
 * publisher-seam metrics (§12.3, no direct client), due-checkpoint computation + dedup, the
 * ANALYTICS_DRY_RUN synthetic path (§4.5 rename), partial-pull flagging + auth-halt vs outage
 * (§15.1), the PAUSED kill-switch (§15.4), rolling baselines + outlier bands (§7.9), the REQUIRED
 * weekly report's schema shape (§7.9), and proposed-only Learning Record creation with the DD-6
 * mutability + n=1 flags (§7.10 / §8.9).
 *
 * Zero-dependency: Node's built-in test runner + a tiny structural schema check (no ajv in v1).
 * Full CI wiring is P4; this file is the co-located characterization suite.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const collector = require('../engine/analytics/engagement/collector.js');
const baselines = require('../engine/analytics/engagement/baselines.js');
const report = require('../engine/analytics/engagement/performance-report.js');
const learning = require('../engine/analytics/engagement/learning.js');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function tempHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oce-analytics-'));
  return { CONTENT_HOME: dir };
}

/** A minimal published queue entry block (queue.js grammar). */
function queueBlock({ id, brand = 'acme-cosmos', platform = 'twitter', format = 'text', ref = 'p-1', publishedAt }) {
  return [
    `## Entry - ${id}`,
    `- content_id: ${id}`,
    `- brand: ${brand}`,
    `- platform: ${platform}`,
    `- format: ${format}`,
    `- mode: LIVE`,
    `- created_at: ${new Date(Date.parse(publishedAt) - DAY).toISOString()}`,
    `- state: published`,
    `- state_updated_at: ${publishedAt}`,
    `- external_post_ref: ${ref}`,
    `- published_at: ${publishedAt}`,
    '',
  ].join('\n');
}

/** Load a shipped JSON schema. */
function loadSchema(rel) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'schemas', rel), 'utf8'));
}

/**
 * Tiny structural validator: enough to assert required/enum/additionalProperties on the parts
 * the analytics artifacts must satisfy. Not a full JSON-Schema engine (P4 wires that).
 */
function structurallyValid(obj, schema, errs = [], where = '$') {
  if (schema.type === 'object' && schema.properties) {
    if (obj == null || typeof obj !== 'object' || Array.isArray(obj)) {
      errs.push(`${where}: expected object`); return errs;
    }
    for (const req of schema.required || []) {
      if (!(req in obj)) errs.push(`${where}.${req}: required and missing`);
    }
    if (schema.additionalProperties === false) {
      for (const k of Object.keys(obj)) {
        if (!schema.properties[k]) errs.push(`${where}.${k}: additionalProperty not allowed`);
      }
    }
    for (const [k, sub] of Object.entries(schema.properties)) {
      if (k in obj) structurallyValid(obj[k], sub, errs, `${where}.${k}`);
    }
  } else if (schema.type === 'array' && schema.items) {
    if (!Array.isArray(obj)) { errs.push(`${where}: expected array`); return errs; }
    obj.forEach((it, i) => structurallyValid(it, schema.items, errs, `${where}[${i}]`));
  } else if (schema.enum) {
    if (!schema.enum.includes(obj)) errs.push(`${where}: "${obj}" not in enum`);
  }
  return errs;
}

// ---------------------------------------------------------------------------
// Module shape + the queue-isolation invariant (ported from the production test)
// ---------------------------------------------------------------------------

test('collector exports the public collectEngagement plus checkpoint cadence', () => {
  assert.equal(typeof collector.collectEngagement, 'function');
  assert.deepEqual(collector.CHECKPOINTS.map((c) => c.name), ['1h', '24h', '7d']);
  assert.equal(collector.CHECKPOINTS[0].offsetMs, HOUR);
  assert.equal(collector.CHECKPOINTS[1].offsetMs, 24 * HOUR);
  assert.equal(collector.CHECKPOINTS[2].offsetMs, 7 * DAY);
});

test('analytics modules can NEVER write publish-queue.md (no queue-write helper in their code)', () => {
  // The production invariant: the analytics path is physically incapable of mutating the queue.
  // collector.js imports queue.js for READ-ONLY parse/queueFilePath, so we assert it never
  // references a WRITE helper or the lock; baselines/report/learning don't import queue.js at all.
  const collectorSrc = fs.readFileSync(
    path.join(__dirname, '..', 'engine', 'analytics', 'engagement', 'collector.js'), 'utf8',
  );
  assert.doesNotMatch(collectorSrc, /acquireLock|releaseLock|writeFileAtomic|setEntryState|appendEntryBlock|serializeQueue/);
  for (const mod of ['baselines.js', 'performance-report.js', 'learning.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'engine', 'analytics', 'engagement', mod), 'utf8');
    assert.doesNotMatch(src, /publish-queue|shared\/queue|acquireLock|writeFileAtomic/);
  }
});

test('collector carries no production codename or direct publisher client', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'engine', 'analytics', 'engagement', 'collector.js'), 'utf8',
  );
  // §0.3 r6 — the retired production analytics subsystem codename must not appear in public
  // code. Built from fragments so the deny-scanner doesn't flag this guard as a leak itself.
  const retiredCodename = new RegExp(['s', 'i', 'g', 'm', 'a'].join(''), 'i');
  assert.doesNotMatch(src, retiredCodename);
  assert.doesNotMatch(src, /spawnSync|child_process|shell:\s*true/); // no shell spawn of a CLI
  assert.match(src, /fetchMetrics/); // metrics flow through the publisher seam (§12.3)
});

// ---------------------------------------------------------------------------
// Due-checkpoint computation + dedup
// ---------------------------------------------------------------------------

test('pendingCheckpoints returns only due-and-uncollected checkpoints', () => {
  const env = tempHome();
  const publishedAt = new Date(Date.now() - 25 * HOUR).toISOString(); // 1h + 24h due, 7d not
  const entry = { header: 'c-1', fields: { content_id: 'c-1', published_at: publishedAt } };
  const due = collector.pendingCheckpoints(entry, { env });
  assert.deepEqual(due.map((d) => d.checkpoint), ['1h', '24h']);

  // Write the 1h record; it should now be deduped out.
  fs.mkdirSync(path.dirname(due[0].rawPath), { recursive: true });
  fs.writeFileSync(due[0].rawPath, '{}');
  const due2 = collector.pendingCheckpoints(entry, { env });
  assert.deepEqual(due2.map((d) => d.checkpoint), ['24h']);
});

test('a never-published / unparseable entry yields no checkpoints', () => {
  const env = tempHome();
  assert.deepEqual(collector.pendingCheckpoints({ header: 'x', fields: {} }, { env }), []);
  assert.deepEqual(
    collector.pendingCheckpoints({ header: 'x', fields: { published_at: 'not-a-date' } }, { env }),
    [],
  );
});

// ---------------------------------------------------------------------------
// collectEngagement — dry-run, seam, partial, auth-halt, pause
// ---------------------------------------------------------------------------

test('ANALYTICS_DRY_RUN collects synthetic metrics with no adapter call', async () => {
  const env = { ...tempHome(), ANALYTICS_DRY_RUN: '1' };
  const now = Date.now();
  const queueRaw = queueBlock({ id: 'c-1', publishedAt: new Date(now - 2 * HOUR).toISOString() });
  let adapterCalled = false;
  const res = await collector.collectEngagement({
    env, now, queueRaw, getAdapter: () => { adapterCalled = true; throw new Error('should not call'); },
  });
  assert.equal(adapterCalled, false);
  assert.equal(res.dryRun, true);
  assert.equal(res.collected.length, 1);
  assert.equal(res.collected[0].checkpoint, '1h');
  assert.equal(typeof res.collected[0].metrics.likes, 'number');
  // The raw record landed on disk and is deduped on a second run.
  const res2 = await collector.collectEngagement({ env, now, queueRaw, getAdapter: () => { throw new Error('x'); } });
  assert.equal(res2.collected.length, 0);
});

test('collectEngagement fetches metrics through the publisher seam (live path)', async () => {
  const env = tempHome();
  const now = Date.now();
  const queueRaw = queueBlock({ id: 'c-9', ref: 'POST-9', publishedAt: new Date(now - 2 * HOUR).toISOString() });
  const seen = [];
  const stubAdapter = {
    async fetchMetrics(ref, checkpoint) {
      seen.push({ ref, checkpoint });
      return { supported: true, metrics: { likes: 100, impressions: '4200' } };
    },
  };
  const res = await collector.collectEngagement({ env, now, queueRaw, getAdapter: () => stubAdapter });
  assert.deepEqual(seen, [{ ref: 'POST-9', checkpoint: '1h' }]);
  assert.equal(res.collected[0].external_post_ref, 'POST-9');
  // String "4200" coerced to a number; non-finite values dropped (schema: metrics are numbers).
  assert.equal(res.collected[0].metrics.impressions, 4200);
  assert.equal(res.collected[0].partial, undefined);
});

test('an empty/unsupported pull is FLAGGED partial, never silently consumed (§15.1)', async () => {
  const env = tempHome();
  const now = Date.now();
  const queueRaw = queueBlock({ id: 'c-p', publishedAt: new Date(now - 2 * HOUR).toISOString() });
  const stub = { async fetchMetrics() { return { supported: false, metrics: {} }; } };
  const res = await collector.collectEngagement({ env, now, queueRaw, getAdapter: () => stub });
  assert.equal(res.collected[0].partial, true);
});

test('a 401/403 auth failure HALTS collection (permanent); an outage is skip-and-retry', async () => {
  const env = tempHome();
  const now = Date.now();
  const queueRaw =
    queueBlock({ id: 'c-a', publishedAt: new Date(now - 2 * HOUR).toISOString() })
    + queueBlock({ id: 'c-b', publishedAt: new Date(now - 2 * HOUR).toISOString() });

  // Auth failure on the first checkpoint halts the whole run.
  const authStub = { async fetchMetrics() { const e = new Error('unauthorized'); e.httpStatus = 401; throw e; } };
  const authRes = await collector.collectEngagement({ env, now, queueRaw, getAdapter: () => authStub });
  assert.equal(authRes.authHalted, true);
  assert.equal(authRes.collected.length, 0);
  assert.equal(authRes.failures[0].auth, true);

  // An outage (no httpStatus / 5xx) is recorded as a failure but does not halt; other entries proceed.
  let calls = 0;
  const flakyStub = {
    async fetchMetrics() {
      calls += 1;
      if (calls === 1) { const e = new Error('timeout'); throw e; }
      return { supported: true, metrics: { likes: 5 } };
    },
  };
  const env2 = tempHome();
  const outRes = await collector.collectEngagement({ env: env2, now, queueRaw, getAdapter: () => flakyStub });
  assert.equal(outRes.authHalted, false);
  assert.equal(outRes.failures.length, 1);
  assert.equal(outRes.collected.length, 1);
});

test('a PAUSED instance collects nothing (§15.4 kill-switch)', async () => {
  const env = tempHome();
  fs.writeFileSync(path.join(env.CONTENT_HOME, 'PAUSED'), 'maintenance');
  const queueRaw = queueBlock({ id: 'c-1', publishedAt: new Date(Date.now() - 2 * HOUR).toISOString() });
  const res = await collector.collectEngagement({
    env, queueRaw, getAdapter: () => { throw new Error('should not run'); },
  });
  assert.equal(res.paused, true);
  assert.equal(res.collected.length, 0);
});

// ---------------------------------------------------------------------------
// Baselines + outliers
// ---------------------------------------------------------------------------

function rawRec(over = {}) {
  return {
    content_id: 'c', brand: 'acme-cosmos', platform: 'twitter', checkpoint: '1h',
    captured_at: new Date().toISOString(), metrics: { likes: 50 }, ...over,
  };
}

test('computeBaselines is deterministic and groups by brand×platform×checkpoint', () => {
  const records = [
    rawRec({ content_id: 'a', metrics: { likes: 10 } }),
    rawRec({ content_id: 'b', metrics: { likes: 20 } }),
    rawRec({ content_id: 'c', metrics: { likes: 30 } }),
  ];
  const b1 = baselines.computeBaselines({ env: tempHome(), records });
  const b2 = baselines.computeBaselines({ env: tempHome(), records });
  const key = 'acme-cosmos|twitter|1h';
  assert.equal(b1.groups[key].sample_size, 3);
  assert.equal(b1.groups[key].metrics.likes_mean, 20);
  assert.equal(b1.groups[key].metrics.likes_median, 20);
  // Determinism (timestamps aside): the baseline metric block matches across runs.
  assert.deepEqual(b1.groups[key].metrics, b2.groups[key].metrics);
  // §7.9 baselines[] shape.
  assert.equal(b1.baselines[0].dimension, 'overall');
  assert.equal(b1.baselines[0].key, key);
});

test('outliers flag >=2x HIGH and <=0.5x LOW once a group has enough history', () => {
  const history = [
    rawRec({ content_id: 'h1', metrics: { likes: 10 } }),
    rawRec({ content_id: 'h2', metrics: { likes: 10 } }),
    rawRec({ content_id: 'h3', metrics: { likes: 10 } }),
  ];
  const high = rawRec({ content_id: 'big', metrics: { likes: 30 } }); // 3x median(10)
  const low = rawRec({ content_id: 'small', metrics: { likes: 4 } });  // 0.4x median(10)
  const out = baselines.computeBaselines({
    env: tempHome(), records: [...history, high, low], newRecords: [high, low],
  });
  const kinds = Object.fromEntries(out.outliers.map((o) => [o.content_id, o.outlier]));
  assert.equal(kinds.big, 'HIGH_PERFORMER');
  assert.equal(kinds.small, 'UNDERPERFORMER');
});

test('a group with fewer than the minimum sample flags no outliers', () => {
  const out = baselines.computeBaselines({
    env: tempHome(),
    records: [rawRec({ metrics: { likes: 10 } }), rawRec({ metrics: { likes: 1000 } })],
    newRecords: [rawRec({ content_id: 'z', metrics: { likes: 1000 } })],
  });
  assert.equal(out.outliers.length, 0);
});

// ---------------------------------------------------------------------------
// Weekly performance report (REQUIRED; §7.9)
// ---------------------------------------------------------------------------

test('buildWeeklyReport emits a schema-conformant report and writes it', () => {
  const env = tempHome();
  const now = Date.now();
  const records = [
    rawRec({ content_id: 'a', checkpoint: '24h', format: 'text', captured_at: new Date(now - 1 * DAY).toISOString(), metrics: { likes: 200 } }),
    rawRec({ content_id: 'b', checkpoint: '24h', format: 'thread', captured_at: new Date(now - 2 * DAY).toISOString(), metrics: { likes: 50 } }),
    rawRec({ content_id: 'old', checkpoint: '24h', captured_at: new Date(now - 20 * DAY).toISOString(), metrics: { likes: 9999 } }),
  ];
  const { report: rep, written } = report.buildWeeklyReport({ env, now, records });

  // The 20-day-old record is outside the week window.
  assert.equal(rep.checkpoints.length, 2);
  assert.ok(rep.weekly_summary.period.start < rep.weekly_summary.period.end);
  assert.ok(Array.isArray(rep.weekly_summary.recommendations));
  assert.ok(rep.weekly_summary.recommendations.length >= 1);

  // Structural schema conformance (checkpoints + baselines + weekly_summary).
  const schema = loadSchema('artifacts/performance-report.schema.json');
  const errs = structurallyValid(rep, schema);
  assert.deepEqual(errs, [], `schema errors: ${errs.join('; ')}`);

  // It was written under $CONTENT_HOME/analytics/.
  assert.ok(written && written.startsWith(env.CONTENT_HOME));
  assert.ok(fs.existsSync(written));
});

test('buildWeeklyReport aggregates by format and respects write:false', () => {
  const env = tempHome();
  const now = Date.now();
  const records = [
    rawRec({ content_id: 'a', format: 'text', captured_at: new Date(now - 1 * DAY).toISOString(), metrics: { likes: 100 } }),
    rawRec({ content_id: 'b', format: 'text', captured_at: new Date(now - 1 * DAY).toISOString(), metrics: { likes: 200 } }),
  ];
  const { report: rep, written } = report.buildWeeklyReport({ env, now, records, write: false });
  assert.equal(written, null);
  const formatAgg = rep.weekly_summary.aggregates.find((a) => a.dimension === 'format' && a.key === 'text');
  assert.equal(formatAgg.sample_size, 2);
  assert.equal(formatAgg.metrics.likes_mean, 150);
});

// ---------------------------------------------------------------------------
// Learning Record creation — proposed-only, DD-6 mutability (§7.10 / §8.9)
// ---------------------------------------------------------------------------

test('proposeLearningRecord creates a proposed, schema-valid record and writes it', () => {
  const env = tempHome();
  const { record, written, flags } = learning.proposeLearningRecord({
    source_signals: [
      { type: 'rejection', count: 3, refs: ['ledger/records/c-1.json'] },
      { type: 'analytics', count: 2 },
    ],
    target_artifact: 'rules/core/voice-register',
    target_mutability: 'learnable',
    proposed_diff: '- old line\n+ new line',
  }, { env });

  assert.equal(record.status, 'proposed');
  assert.equal(record.shareability, 'private');
  assert.equal(flags.single_signal, false);
  assert.equal(flags.human_only, false);

  const schema = loadSchema('artifacts/learning-record.schema.json');
  const errs = structurallyValid(record, schema);
  assert.deepEqual(errs, [], `schema errors: ${errs.join('; ')}`);

  assert.ok(written.startsWith(path.join(env.CONTENT_HOME, 'learning', 'proposed')));
  assert.ok(fs.existsSync(written));
});

test('a human-only target is creatable but FLAGGED (DD-6 — apply tool refuses later)', () => {
  const env = tempHome();
  const { record, flags } = learning.proposeLearningRecord({
    source_signals: [{ type: 'edit', count: 1 }],
    target_artifact: 'rules/core/fabrication-safety',
    target_mutability: 'human-only',
    proposed_diff: '+ tighten threshold',
  }, { env, write: false });
  assert.equal(record.status, 'proposed');
  assert.equal(record.target_mutability, 'human-only');
  assert.equal(flags.human_only, true);
  // n=1 minimum-signal flag (DR W#21).
  assert.equal(flags.single_signal, true);
});

test('creation NEVER applies a change — status is forced to proposed and only learning/proposed is written', () => {
  const env = tempHome();
  // Even if a caller passes status:applied + applied_by, v1 creation forces proposed.
  const { record } = learning.proposeLearningRecord({
    source_signals: [{ type: 'analytics', count: 5 }],
    target_artifact: 'rules/core/structure',
    target_mutability: 'learnable',
    proposed_diff: '+ x',
    status: 'applied',
    applied_by: 'someone',
  }, { env });
  assert.equal(record.status, 'proposed');
  assert.equal(record.applied_by, undefined);
  // Nothing was written outside learning/proposed/ (no rules/ or config/ mutation — DD-6).
  assert.ok(!fs.existsSync(path.join(env.CONTENT_HOME, 'rules')));
  assert.ok(!fs.existsSync(path.join(env.CONTENT_HOME, 'config')));
  const proposed = fs.readdirSync(path.join(env.CONTENT_HOME, 'learning', 'proposed'));
  assert.equal(proposed.length, 1);
});

test('malformed learning input is rejected with a typed error', () => {
  const env = tempHome();
  assert.throws(() => learning.proposeLearningRecord({ source_signals: [] }, { env, write: false }), /at least one signal/);
  assert.throws(() => learning.proposeLearningRecord({
    source_signals: [{ type: 'bogus', count: 1 }], target_artifact: 't', target_mutability: 'learnable', proposed_diff: 'd',
  }, { env, write: false }), /invalid/);
  assert.throws(() => learning.proposeLearningRecord({
    source_signals: [{ type: 'edit', count: 1, refs: [path.resolve('/abs/path.json')] }],
    target_artifact: 't', target_mutability: 'learnable', proposed_diff: 'd',
  }, { env, write: false }), /absolute/);
});

test('proposeFromRecommendations turns weekly recommendations into proposed learnable records', () => {
  const env = tempHome();
  const out = learning.proposeFromRecommendations({
    recommendations: ['Top performer: c-1 reached 200 — reinforce.', 'UNDERPERFORMER: c-2.'],
    decisionSignals: [{ type: 'rejection', count: 2 }],
    targetArtifact: 'rules/core/voice-register',
  }, { env });
  assert.equal(out.length, 2);
  for (const r of out) {
    assert.equal(r.record.status, 'proposed');
    assert.equal(r.record.target_mutability, 'learnable');
  }
});
