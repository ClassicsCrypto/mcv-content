'use strict';

/**
 * engine/cli/engagement-timeline.js  [N net-new]
 *
 * `engine engagement-timeline --brand <id>` — build the ENGAGEMENT TIMELINE + PROJECT-FACTS artifact
 * from a brand's OWN ingested history (release-spec §1.1/§1.2 — "timeline of highest-engagement info
 * and project summary/facts"). THIN wiring over engine/brand-dna/engagement-timeline.js (the
 * deterministic builder) + readCorpus (the corpus reader): it reads the own-account corpus, builds
 * the artifact, writes it (redacted at write) under $CONTENT_HOME/brands/<id>/ as both a
 * schema-validated JSON and a human-readable markdown, and prints a summary.
 *
 * FREE + deterministic + read-only-on-corpus: NO LLM, NO network, NO spend (RD-2). It only READS the
 * corpus and WRITES the analysis artifact (an output, not config). Empty corpus is a clean no-op
 * artifact with a note (DD-21 cold-start). `--no-write` previews without writing; `--json` emits the
 * artifact object.
 *
 * Tier-3 cleanliness (§0.3 r6): brand id is a passed value; all paths via paths.js; the artifact is
 * instance data written under $CONTENT_HOME, never the repo, and redacted at write (§13.3).
 */

const fs = require('fs');
const path = require('path');

const util = require('./util');
const paths = require('../shared/paths');
const { redact } = require('../shared/redact');
const { readCorpus } = require('../brand-dna/generate');
const { buildEngagementTimeline } = require('../brand-dna/engagement-timeline');

const HELP = `engine engagement-timeline --brand <id> [options]

Build the engagement-timeline + project-facts artifact from a brand's OWN ingested history (§1.1/§1.2):
a chronological timeline, the highest-engagement posts, and a project-facts summary (window, totals,
peak period, media lift, engagement rate). Deterministic (no LLM), free, read-only on the corpus.

  --brand <id>     the brand to analyze (required; reads corpora/<id>/, own slice).
  --top <n>        how many highest-engagement posts to list (default 10).
  --period <p>     month (default) | week — timeline bucket granularity.
  --no-write       preview only — compute + print, write nothing.
  --json           emit the structured artifact.
  -h, --help       show this help.

Writes brands/<id>/engagement-timeline.json (schema-validated) + engagement-timeline.md (human).
Empty corpus is a clean no-op with a note (ingest the brand history first — engine ingest-brand).`;

/** Atomic write (tmp + rename) so a crash never leaves a half-written artifact. */
function writeAtomic(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, contents, 'utf8');
  fs.renameSync(tmp, file);
}

/** Render the artifact as a human-readable markdown doc (the "project summary/facts" document). */
function renderMarkdown(a) {
  const L = [];
  L.push(`# Engagement timeline & project facts${a.brand ? ` — ${a.brand}` : ''}`);
  L.push('');
  L.push(`_Generated ${a.generated_at || '(unstamped)'} · deterministic (no LLM) · ${a.granularity}ly buckets_`);
  L.push('');

  L.push('## Project facts');
  const w = a.window;
  L.push(`- **Posts:** ${a.totals.posts} (${a.totals.posts_with_metrics} with engagement metrics, ${a.totals.with_media} with media)`);
  if (w.start) L.push(`- **History window:** ${w.start.slice(0, 10)} → ${w.end.slice(0, 10)}`);
  L.push(`- **Total engagement:** ${a.summary.total_engagement} · avg score ${a.summary.avg_score} · median ${a.summary.median_score}`);
  if (a.summary.peak_period) L.push(`- **Peak period:** ${a.summary.peak_period.period} — ${a.summary.peak_period.total_engagement} engagement across ${a.summary.peak_period.posts} posts (avg ${a.summary.peak_period.avg_score})`);
  if (a.summary.busiest_period) L.push(`- **Busiest period:** ${a.summary.busiest_period.period} — ${a.summary.busiest_period.posts} posts`);
  if (a.summary.media_lift) {
    const ml = a.summary.media_lift;
    L.push(`- **Media lift:** with-media avg ${ml.with_media_avg} vs without ${ml.without_media_avg}${ml.lift_ratio != null ? ` (×${ml.lift_ratio})` : ''}`);
  }
  if (a.summary.avg_engagement_rate != null) L.push(`- **Avg engagement rate:** ${a.summary.avg_engagement_rate} (engagement ÷ impressions)`);
  L.push('');
  L.push(`> Engagement score = ${a.engagement_basis.score_formula}`);
  L.push('');

  if (a.top_posts.length) {
    L.push('## Highest-engagement posts');
    for (const p of a.top_posts) {
      L.push(`${p.rank}. **${p.score}** — ${p.text_excerpt}${p.captured_at ? ` _(${p.captured_at.slice(0, 10)})_` : ''}${p.url ? ` <${p.url}>` : ''}`);
    }
    L.push('');
  }

  if (a.timeline.length) {
    L.push(`## Timeline (${a.granularity}ly)`);
    L.push('');
    L.push('| Period | Posts | Total eng | Avg | Top post |');
    L.push('|---|---|---|---|---|');
    for (const t of a.timeline) {
      const top = t.top_post ? `${t.top_post.score}: ${t.top_post.text_excerpt.slice(0, 60)}${t.top_post.text_excerpt.length > 60 ? '…' : ''}` : '—';
      L.push(`| ${t.period} | ${t.posts} | ${t.total_engagement} | ${t.avg_score} | ${top.replace(/\|/g, '\\|')} |`);
    }
    L.push('');
  }

  if (a.notes.length) {
    L.push('## Notes');
    for (const n of a.notes) L.push(`- ${n}`);
    L.push('');
  }
  return `${L.join('\n')}\n`;
}

/** A concise CLI detail block. */
function detailLines(a, wrote) {
  const lines = [];
  const w = a.window;
  lines.push(`posts: ${a.totals.posts} (${a.totals.posts_with_metrics} with metrics)${w.start ? ` · ${w.start.slice(0, 10)}→${w.end.slice(0, 10)}` : ''}`);
  lines.push(`total engagement ${a.summary.total_engagement} · avg ${a.summary.avg_score} · median ${a.summary.median_score}`);
  if (a.summary.peak_period) lines.push(`peak ${a.summary.peak_period.period} (${a.summary.peak_period.total_engagement} eng / ${a.summary.peak_period.posts} posts)`);
  if (a.summary.media_lift) lines.push(`media lift: ${a.summary.media_lift.with_media_avg} vs ${a.summary.media_lift.without_media_avg}${a.summary.media_lift.lift_ratio != null ? ` (×${a.summary.media_lift.lift_ratio})` : ''}`);
  for (const p of a.top_posts.slice(0, 5)) lines.push(`  #${p.rank} [${p.score}] ${p.text_excerpt.slice(0, 80)}${p.text_excerpt.length > 80 ? '…' : ''}`);
  for (const n of a.notes) lines.push(`  ~ ${n}`);
  if (wrote) lines.push(`wrote ${wrote.json} + ${wrote.md}`);
  else lines.push('(--no-write: nothing written)');
  return lines;
}

/**
 * @param {object} ctx  { flags, positionals, env }
 * @returns {{ ok, summary, detail?, data?, exitCode? }}
 */
function run(ctx = {}) {
  const flags = ctx.flags || {};
  if (util.flagOn(flags.help)) return { ok: true, summary: HELP.split('\n')[0], detail: HELP };

  const env = ctx.env || process.env;
  const brand = (typeof flags.brand === 'string' && flags.brand.trim())
    ? flags.brand.trim()
    : (ctx.positionals && ctx.positionals[0]);
  if (!brand) {
    return { ok: false, exitCode: 2, summary: 'engagement-timeline needs --brand <id>', detail: ['Usage: engine engagement-timeline --brand <id> (reads corpora/<id>/, own slice).'] };
  }

  const top = Number.isFinite(Number(flags.top)) && Number(flags.top) > 0 ? Math.floor(Number(flags.top)) : undefined;
  const granularity = flags.period === 'week' ? 'week' : 'month';
  const write = !util.flagOn(flags['no-write']);

  let corpus;
  try {
    corpus = readCorpus(brand, env);
  } catch (err) {
    return { ok: false, exitCode: 1, summary: 'could not read the corpus', detail: [util.describeError(err)] };
  }

  const artifact = buildEngagementTimeline(corpus.own, {
    brand,
    top,
    granularity,
    generatedAt: new Date().toISOString(),
  });

  let wrote = null;
  if (write) {
    try {
      const dir = paths.brandDir(brand, env);
      const jsonFile = path.join(dir, 'engagement-timeline.json');
      const mdFile = path.join(dir, 'engagement-timeline.md');
      // Redact at write (§13.3) — the artifact carries own post excerpts; mask any secret-shaped value.
      const safe = redact(artifact);
      writeAtomic(jsonFile, `${JSON.stringify(safe, null, 2)}\n`);
      writeAtomic(mdFile, renderMarkdown(artifact));
      wrote = { json: path.relative(dir, jsonFile) === 'engagement-timeline.json' ? `brands/${brand}/engagement-timeline.json` : jsonFile, md: `brands/${brand}/engagement-timeline.md` };
    } catch (err) {
      return { ok: false, exitCode: 1, summary: 'built the timeline but could not write it', detail: [util.describeError(err)], data: artifact };
    }
  }

  return {
    ok: true,
    exitCode: 0,
    summary: `engagement-timeline for ${brand}: ${artifact.totals.posts} post(s), ${artifact.totals.posts_with_metrics} with metrics${artifact.summary.peak_period ? `, peak ${artifact.summary.peak_period.period}` : ''}`,
    detail: detailLines(artifact, wrote),
    data: artifact,
  };
}

module.exports = { run, HELP, renderMarkdown };
