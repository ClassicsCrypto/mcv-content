'use strict';

/**
 * Cross-process proof (spec §16.1 lock exclusion): the ONE canonical queue lock
 * serializes concurrent read-modify-write so no update is lost (DD-19).
 *
 * Spawns N real child processes that each repeatedly acquire the lock, read the
 * shared file, append a unique marker, and write it back atomically. With the
 * lock, every append survives. Without it, the read-modify-write windows overlap
 * and updates are clobbered.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

const QUEUE_MODULE = path.resolve(__dirname, '..', 'queue.js');

test('canonical lock serializes concurrent writers (no lost updates)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'q-conc-'));
  const file = path.join(dir, 'queue.txt');
  const lock = path.join(dir, '.publish-queue.lock');
  const worker = path.join(dir, 'worker.js');
  fs.writeFileSync(file, 'START\n');

  // Worker: acquire -> read -> (widened race window) -> append -> atomic write -> release, M times.
  fs.writeFileSync(worker, [
    `const q = require(${JSON.stringify(QUEUE_MODULE)});`,
    `const fs = require('fs');`,
    `const [file, lock, id, iters] = process.argv.slice(2);`,
    // Retry transient OS-level FS errors (Windows delete-pending / AV / EBUSY).
    // Safe because we hold the lock here: no other worker touches the file.
    `function retry(fn){for(let a=0;a<200;a++){try{return fn();}catch(e){`,
    `  if(['EPERM','EACCES','ENOENT','EBUSY'].includes(e.code)){const s=Date.now()+5;while(Date.now()<s){}continue;}throw e;}}return fn();}`,
    `for (let k = 0; k < Number(iters); k++) {`,
    `  q.acquireLockBlocking(lock, { owner: 'w' + id, timeoutMs: 20000, pollMs: 5, register: false });`,
    `  try {`,
    `    const cur = retry(() => fs.readFileSync(file, 'utf8'));`,
    `    const spin = Date.now() + 2; while (Date.now() < spin) {}`, // widen the read->write window
    `    const tmp = file + '.tmp.' + id;`,
    `    retry(() => { fs.writeFileSync(tmp, cur + 'w' + id + '-' + k + '\\n'); fs.renameSync(tmp, file); });`,
    `  } finally { q.releaseLock(lock); }`,
    `}`,
  ].join('\n'));

  const N = 4;
  const M = 25;
  try {
    // Wait for ALL workers to settle before reading/cleaning up, so one failure
    // can't delete the dir out from under its siblings (which would mask the cause).
    const results = await Promise.all(Array.from({ length: N }, (_, i) => new Promise((resolve) => {
      let err = '';
      const p = spawn(process.execPath, [worker, file, lock, String(i), String(M)], {
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      p.stderr.on('data', (d) => { err += d.toString(); });
      p.on('error', (e) => resolve({ i, code: -1, err: String(e) }));
      p.on('exit', (code) => resolve({ i, code, err }));
    })));

    const failed = results.filter((r) => r.code !== 0);
    assert.equal(failed.length, 0, `workers failed: ${failed.map((f) => `#${f.i} (${f.code}): ${f.err.trim().replace(/\s+/g, ' ').slice(0, 200)}`).join(' | ')}`);

    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    const appended = lines.slice(1); // drop START
    assert.equal(lines.length, 1 + N * M, `expected ${1 + N * M} lines, got ${lines.length} (lost updates)`);
    assert.equal(new Set(appended).size, N * M, 'duplicate or lost markers — lock did not serialize writes');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
