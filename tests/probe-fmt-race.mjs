/**
 * Several processes doing a cold first compile at once.
 *
 * The precompiled format is a 7MB file on a path shared by every process on
 * the machine — the server, the CLI, the MCP binary, each vitest worker — and
 * it is published with a plain copy straight onto that path. A reader arriving
 * mid-copy sees a truncated format. The only validity check is that the file
 * exists, so once a bad one lands nothing ever rebuilds it.
 *
 *   node tests/probe-fmt-race.mjs           # one round
 *   node tests/probe-fmt-race.mjs worker    # internal
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const here = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(here), '..');

if (process.argv[2] === 'worker') {
  const { compileFastBody } = await import('../src/render/fastCompile.ts');
  const { DEFAULT_LAYOUT } = await import('../src/model/types.ts');
  try {
    await compileFastBody('\\begin{document}\nhello\n\\end{document}\n', 'letter', DEFAULT_LAYOUT);
    console.log('ok');
  } catch (e) {
    console.log(`FAIL ${String(e.message).slice(0, 110).replace(/\s+/g, ' ')}`);
  }
  process.exit(0);
}

const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'rmm-fmtrace-'));
const HOW_MANY = 8;

const once = (label) =>
  Promise.all(
    Array.from({ length: HOW_MANY }, (_, i) =>
      run('npx', ['tsx', here, 'worker'], {
        cwd: root,
        env: { ...process.env, RMM_FMT_CACHE: cache },
        timeout: 180_000,
      })
        .then((r) => `${label}${i}: ${r.stdout.trim()}`)
        .catch((e) => `${label}${i}: threw ${String(e.message).slice(0, 80).replace(/\s+/g, ' ')}`),
    ),
  );

try {
  console.log(`${HOW_MANY} processes, one cold cache at ${cache}\n`);
  for (const line of await once('p')) console.log(' ', line);

  const left = fs.readdirSync(cache).filter((f) => f.endsWith('.fmt'));
  console.log(`\nformat files left behind: ${JSON.stringify(left)}`);
  for (const f of left) console.log(`  ${f}  ${fs.statSync(path.join(cache, f)).size} bytes`);

  // The half that matters: is what was left behind usable from now on?
  console.log('\nA second round against the cache the first one left:\n');
  for (const line of await once('again')) console.log(' ', line);

  /*
   * And a format that is already bad — left by an older build, or by anything
   * that died mid-write. The cache is only checked for existing, so without
   * self-healing this is permanent: every run short-circuits to it, fails, and
   * silently drops back to the slow engine for ever.
   */
  const fmt = path.join(cache, fs.readdirSync(cache).find((f) => f.endsWith('.fmt')));
  fs.writeFileSync(fmt, fs.readFileSync(fmt).subarray(0, 4096));
  console.log(`\nTruncated the cached format to ${fs.statSync(fmt).size} bytes, as a dead process would.\n`);
  for (const line of await once('broken')) console.log(' ', line);
  console.log(`\nformat now: ${fs.existsSync(fmt) ? `${fs.statSync(fmt).size} bytes` : 'rebuilt from scratch next time'}`);
  console.log('\nAnd once more, to show it recovered:\n');
  for (const line of await once('healed')) console.log(' ', line);
} finally {
  fs.rmSync(cache, { recursive: true, force: true });
}
