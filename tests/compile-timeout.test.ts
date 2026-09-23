/**
 * A compile that will not stop when its own `timeout` says to.
 *
 * `execFile`'s `timeout` option sends `killSignal` — SIGTERM by default —
 * once, and then waits for the child's `exit` like any other call. It never
 * escalates. `ai/agent.ts` already carries a fix for exactly this against the
 * coding-agent CLIs it shells out to; `render/compile.ts` and
 * `render/fastCompile.ts` shell out just as directly, to `pdflatex`,
 * `latexmk`, `tectonic` and `pdftex`, and without the same fix a process that
 * traps SIGTERM — or a wrapper script around it that does — leaves the
 * `await` unsettled and the caller hung for the life of the process.
 *
 * `runTimedForTest` is the same low-level helper the real compiles run
 * through (`runTimed`), exposed so a test can use a `timeout` short enough to
 * wait out rather than the real 30–120 second ones.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runTimedForTest as compileRunTimed, RUN_TIMED_TEST_GRACE_MS as COMPILE_GRACE_MS } from '../src/render/compile.js';
import { runTimedForTest as fastRunTimed, RUN_TIMED_TEST_GRACE_MS as FAST_GRACE_MS } from '../src/render/fastCompile.js';

/** A script that ignores the signal `execFile`'s `timeout` sends and hangs forever, until SIGKILL. */
function writeStubbornScript(dir: string): string {
  const file = path.join(dir, 'stubborn.js');
  fs.writeFileSync(
    file,
    'process.on("SIGTERM", () => {}); process.on("SIGINT", () => {}); setInterval(() => {}, 1000);',
    'utf8',
  );
  return file;
}

describe('a compile process that will not stop when it is asked', () => {
  let dir: string;
  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('is killed outright rather than waited on for ever (compile.ts)', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmm-stubborn-'));
    const script = writeStubbornScript(dir);
    const started = Date.now();
    await expect(compileRunTimed(process.execPath, [script], { timeout: 500 })).rejects.toThrow();
    const took = Date.now() - started;
    // Past the polite signal at 500ms and the grace period after it, but
    // nowhere near "never" — this is the whole claim being tested.
    expect(took).toBeGreaterThanOrEqual(500);
    expect(took).toBeLessThan(500 + COMPILE_GRACE_MS + 10_000);
  }, 30_000);

  it('is killed outright rather than waited on for ever (fastCompile.ts)', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmm-stubborn-'));
    const script = writeStubbornScript(dir);
    const started = Date.now();
    await expect(fastRunTimed(process.execPath, [script], { timeout: 500 })).rejects.toThrow();
    const took = Date.now() - started;
    expect(took).toBeGreaterThanOrEqual(500);
    expect(took).toBeLessThan(500 + FAST_GRACE_MS + 10_000);
  }, 30_000);

  it('leaves no process still running once it has been killed', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmm-stubborn-'));
    const script = writeStubbornScript(dir);
    await expect(compileRunTimed(process.execPath, [script], { timeout: 500 })).rejects.toThrow();
    // Give the OS a moment to reap, then check nothing matching the script's
    // path is still alive.
    await new Promise((r) => setTimeout(r, 500));
    const ps = execFileSync('ps', ['ax', '-o', 'args']).toString();
    expect(ps).not.toContain(script);
  }, 30_000);

  // A well-behaved process is not affected by the grace period at all: it
  // exits on its own, long before the forced kill would ever fire.
  it('does not touch a process that exits normally', async () => {
    const { stdout } = await compileRunTimed(process.execPath, ['-e', 'process.stdout.write("ok")'], {
      timeout: 5_000,
    });
    expect(stdout).toBe('ok');
  });
});
