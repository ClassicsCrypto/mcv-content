#!/usr/bin/env node
'use strict';

/**
 * scripts/hygiene-scan.js  [N net-new]
 *
 * THE leak-guard for the public tree (release-spec §16.5 hygiene scan; §18.3; DD-8). It is the
 * home of the leak-guard the visual-check meta-test was wrongly carrying: a single, real,
 * zero-dependency scanner that CI runs on every push/PR (RD-12: no secrets, fully offline) so a
 * commit can never carry an instance constant, a credential, or an operator-supplied brand term
 * into the public repo.
 *
 * It is deny-by-evidence: it walks the working tree and FAILS the build (exit 1) when any scanned
 * file contains —
 *
 *   1. SNOWFLAKE IDs        — \b\d{17,20}\b   (Discord/Tier-3 channel/user/guild ids; §18.2(7))
 *   2. USER / HOME PATHS    — C:\Users | /Users/ | /home/   (operator absolute paths; §1 r3, §18.2(10))
 *   3. CREDENTIAL PATTERNS  — sk-… / xai-… / ghp_… / AIza… / -----BEGIN … PRIVATE KEY----- /
 *                             Discord bot-token shapes (§18.2(1); §13.3 leak class)
 *   4. BRAND DENYLIST       — any term in the operator-supplied $ENGINE_BRAND_DENYLIST
 *                             (comma-separated; injected at scan time, NEVER committed — the real
 *                             brand deny-list lives only in the scan environment, §0.3 r6/§16.5)
 *
 * Scope (release-spec §0.3 r6, §18): the public tree may carry ONLY the synthetic "Acme Cosmos"
 * brand and obvious placeholders (<CHANNEL_ID>, $CONTENT_HOME, you@example.com, the .example
 * schema $id domain, the all-zero/placeholder example ids). So that the scan is honest rather than
 * noisy, a small ALLOWLIST exempts those documented placeholders from the snowflake/path checks —
 * every exemption is a placeholder this spec explicitly blesses, never a real value.
 *
 * Self-containment: no dependencies (Node core only); it never reads $CONTENT_HOME and resolves no
 * instance path. The brand deny-list is the ONE operator input and arrives by env var, so the
 * committed script carries zero brand terms itself (this is the whole point — the guard is public,
 * the secret it guards against is not).
 *
 * Usage:
 *   node scripts/hygiene-scan.js [--root <dir>] [--json] [--verbose]
 *   ENGINE_BRAND_DENYLIST="Real Brand,Other Codename,realhandle" node scripts/hygiene-scan.js
 * Exit: 0 clean · 1 leak(s) found · 2 usage error.
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');

// --- What to scan ---------------------------------------------------------------------------
// Directories never walked (build output, VCS, dependency trees). The repo ships no node_modules,
// but a contributor's working tree will have one — never scan it.
const SKIP_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'build', 'coverage', '.nyc_output', 'tmp', '.idea', '.vscode',
]);

// Binary / media extensions: these are provenance-checked fixture/doc assets (§5; .gitignore
// re-allows them). A byte scan of a PNG produces only false positives, so skip by extension.
const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.mp4', '.mov', '.avi', '.mkv', '.webm',
  '.mp3', '.wav', '.m4a', '.pdf', '.zip', '.gz', '.tgz', '.ico', '.woff', '.woff2', '.ttf',
]);

// This scanner contains, by necessity, the very patterns it hunts for (in regex/string form).
// Exempt it from the credential/snowflake/path checks so the guard never flags its own source.
// Scoped to this one file (the brand-denylist check still applies — it carries zero brand terms).
function isSelfExempt(relPath) {
  return relPath.replace(/\\/g, '/') === 'scripts/hygiene-scan.js';
}

// A NUL byte ⇒ treat the file as binary and skip it. Expressed via charCodeAt so THIS source file
// never itself contains a literal NUL (which would make the file unreadable / break tooling).
function containsNul(text) {
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 0) return true;
  }
  return false;
}

// --- The leak patterns ----------------------------------------------------------------------

// 1. Snowflake-shaped ids: a run of 17-20 digits as a whole token. Discord ids are 17-19 today;
//    the 17-20 band is the spec's stated shape (§16.5). Whole-token (\b) so it does not match
//    inside a longer digit string.
const SNOWFLAKE = /\b\d{17,20}\b/g;

// 2. Operator home / user paths. Windows C:\Users\… and POSIX /Users/… and /home/… .
const USER_PATH = /(?:[A-Za-z]:\\Users\\|\/Users\/|\/home\/)[^\s"'`<>]*/gi;

// 3. Credential shapes. Each is a named pattern so a hit reports WHICH credential class leaked.
const CREDENTIAL_PATTERNS = [
  { name: 'OpenAI-style key (sk-)', re: /\bsk-[A-Za-z0-9_-]{16,}\b/g },
  { name: 'xAI key (xai-)', re: /\bxai-[A-Za-z0-9_-]{16,}\b/g },
  { name: 'GitHub PAT (ghp_)', re: /\bghp_[A-Za-z0-9]{20,}\b/g },
  { name: 'GitHub token (gho_/ghu_/ghs_/ghr_)', re: /\bgh[ousr]_[A-Za-z0-9]{20,}\b/g },
  { name: 'Google API key (AIza)', re: /\bAIza[A-Za-z0-9_-]{20,}\b/g },
  { name: 'PEM private key block', re: /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----/g },
  // Discord bot-token shape: <b64url(snowflake)>.<b64url(timestamp)>.<b64url(hmac)>. The first
  // segment is the base64url encoding of the bot's numeric snowflake id, so it ALWAYS begins with
  // an uppercase M/N/O/Q (base64 of a 17-20-digit decimal string) and is 24-26 chars. Anchoring on
  // that prefix is how real secret-scanners detect Discord tokens, and it avoids matching ordinary
  // dotted identifiers / synthetic fixtures that merely have a base64-ish A.B.C shape.
  { name: 'Discord bot-token shape', re: /\b[MNOQ][A-Za-z0-9_-]{23,25}\.[A-Za-z0-9_-]{6,7}\.[A-Za-z0-9_-]{27,40}\b/g },
  // Bearer-prefixed secret on the same line (a credential-bearing header literal).
  { name: 'Bearer credential literal', re: /\bBearer\s+[A-Za-z0-9_.~+/=-]{20,}\b/g },
];

// --- Documented placeholder allowlist (§0.3 r6) ---------------------------------------------
// The ONLY non-real long-digit / path-shaped strings the public tree is allowed to carry.
const PLACEHOLDER_ALLOW = [
  /<[A-Z_]+_ID>/,   // <CHANNEL_ID>, <REVIEWER_ID>, <GUILD_ID>, …
  /\$CONTENT_HOME/, // the instance-dir env placeholder
];

/** A snowflake hit is exempt only if the matched token is an obvious placeholder. */
function snowflakeIsPlaceholder(token) {
  if (/^0+$/.test(token)) return true;          // all-zero placeholder id
  if (/^0{6,}\d{1,11}$/.test(token)) return true; // 000000000000000001-style zero-padded example id
  return false;
}

/** A user-path hit is exempt only if the line is a bracket / $CONTENT_HOME placeholder. */
function pathLineIsPlaceholder(line) {
  return PLACEHOLDER_ALLOW.some((re) => re.test(line));
}

// --- Brand deny-list (operator-supplied, env-only) ------------------------------------------

/**
 * Parse $ENGINE_BRAND_DENYLIST into a list of {term, re}. Comma-separated; each term matched
 * case-insensitively at a word boundary. Empty/whitespace terms dropped. Never read from disk.
 */
function parseDenylist(raw) {
  if (!raw || typeof raw !== 'string') return [];
  return raw
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
    .map((term) => {
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return { term, re: new RegExp(`(?<![\\w@])${escaped}(?![\\w])`, 'gi') };
    });
}

// --- Walk + scan ----------------------------------------------------------------------------

function listFiles(dir, root, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(ent.name)) continue;
      listFiles(abs, root, out);
    } else if (ent.isFile()) {
      out.push(path.relative(root, abs));
    }
  }
  return out;
}

function scanFile(relPath, root, denylist) {
  const findings = [];
  const ext = path.extname(relPath).toLowerCase();
  if (BINARY_EXT.has(ext)) return findings;
  const selfExempt = isSelfExempt(relPath);

  let text;
  try {
    text = fs.readFileSync(path.join(root, relPath), 'utf8');
  } catch {
    return findings; // unreadable (deleted mid-walk, etc.) — nothing to scan.
  }
  if (containsNul(text)) return findings; // apparent binary content.

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;

    // Credentials — never exempt (except this scanner's own source).
    if (!selfExempt) {
      for (const { name, re } of CREDENTIAL_PATTERNS) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(line)) !== null) {
          findings.push({ class: 'credential', detail: name, line: lineNo, match: redactMatch(m[0]) });
          if (m.index === re.lastIndex) re.lastIndex++;
        }
      }
    }

    // Snowflake ids.
    if (!selfExempt) {
      SNOWFLAKE.lastIndex = 0;
      let m;
      while ((m = SNOWFLAKE.exec(line)) !== null) {
        if (!snowflakeIsPlaceholder(m[0])) {
          findings.push({ class: 'snowflake-id', detail: '17-20 digit id', line: lineNo, match: m[0] });
        }
        if (m.index === SNOWFLAKE.lastIndex) SNOWFLAKE.lastIndex++;
      }
    }

    // User / home paths.
    if (!selfExempt && !pathLineIsPlaceholder(line)) {
      USER_PATH.lastIndex = 0;
      let m;
      while ((m = USER_PATH.exec(line)) !== null) {
        findings.push({ class: 'user-path', detail: 'operator/home path', line: lineNo, match: m[0] });
        if (m.index === USER_PATH.lastIndex) USER_PATH.lastIndex++;
      }
    }

    // Brand deny-list — applies even to this script (it carries zero brand terms, so any hit is
    // a genuine leak even in scripts/).
    for (const { term, re } of denylist) {
      re.lastIndex = 0;
      if (re.test(line)) {
        findings.push({ class: 'brand-denylist', detail: `denylisted term "${term}"`, line: lineNo, match: term });
      }
    }
  }
  return findings;
}

/** Mask the middle of a matched credential so the failure log never reprints the secret in full. */
function redactMatch(s) {
  if (s.length <= 8) return '********';
  return `${s.slice(0, 4)}…${s.slice(-2)} (${s.length} chars)`;
}

// --- Main -----------------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { root: REPO_ROOT, json: false, verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') args.root = path.resolve(argv[++i] || '.');
    else if (a === '--json') args.json = true;
    else if (a === '--verbose') args.verbose = true;
    else if (a === '-h' || a === '--help') args.help = true;
    else { args.error = `unknown argument: ${a}`; }
  }
  return args;
}

const HELP = [
  'hygiene-scan — the public-tree leak guard (release-spec §16.5; DD-8).',
  '',
  'Usage: node scripts/hygiene-scan.js [--root <dir>] [--json] [--verbose]',
  '',
  'Fails the build when the tree carries snowflake ids (17-20 digits), operator/home paths',
  '(C:\\Users | /Users/ | /home/), credential shapes (sk-/xai-/ghp_/AIza/PEM/bot-token), or any',
  'term in $ENGINE_BRAND_DENYLIST (comma-separated; injected at scan time, never committed).',
  'Exit: 0 clean · 1 leak(s) found · 2 usage error.',
].join('\n');

function run(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  if (args.error) {
    process.stderr.write(`hygiene-scan: ${args.error}\n`);
    return 2;
  }

  const denylist = parseDenylist(process.env.ENGINE_BRAND_DENYLIST);
  const files = listFiles(args.root, args.root, []);
  const allFindings = [];
  for (const rel of files) {
    const findings = scanFile(rel, args.root, denylist);
    for (const f of findings) allFindings.push({ file: rel.replace(/\\/g, '/'), ...f });
  }

  if (args.json) {
    process.stdout.write(`${JSON.stringify({
      ok: allFindings.length === 0,
      files_scanned: files.length,
      denylist_terms: denylist.length,
      findings: allFindings,
    }, null, 2)}\n`);
  } else {
    process.stdout.write(`hygiene-scan: scanned ${files.length} files`);
    process.stdout.write(denylist.length
      ? ` with ${denylist.length} brand-denylist term(s).\n`
      : ' (no ENGINE_BRAND_DENYLIST supplied — brand-leak check inactive this run).\n');
    if (allFindings.length === 0) {
      process.stdout.write('hygiene-scan: CLEAN — no snowflake ids, user paths, credentials, or denylisted terms found.\n');
    } else {
      process.stderr.write(`\nhygiene-scan: FAILED — ${allFindings.length} potential leak(s):\n`);
      for (const f of allFindings) {
        process.stderr.write(`  [${f.class}] ${f.file}:${f.line} — ${f.detail} (${f.match})\n`);
      }
      process.stderr.write('\nRegenerate-never-redact (release-spec §0.3): the public tree carries only synthetic\n');
      process.stderr.write('content + documented placeholders. Replace the offending value with a placeholder\n');
      process.stderr.write('(<CHANNEL_ID>, $CONTENT_HOME, the Acme Cosmos fixture brand) — do not merely mask it.\n');
    }
  }

  return allFindings.length === 0 ? 0 : 1;
}

if (require.main === module) {
  process.exitCode = run();
}

module.exports = {
  run,
  parseDenylist,
  scanFile,
  snowflakeIsPlaceholder,
  pathLineIsPlaceholder,
  containsNul,
  redactMatch,
  SNOWFLAKE,
  USER_PATH,
  CREDENTIAL_PATTERNS,
};
