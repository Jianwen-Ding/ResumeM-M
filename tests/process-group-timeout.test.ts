/**
 * A timed-out command takes everything it started down with it.
 *
 * The timeouts on the AI CLI and on the LaTeX engines used to signal the
 * direct child only. That is enough for a binary, and not for the shape
 * these commands usually have on someone's machine: a wrapper script that
 * runs the real CLI without `exec` (so the shell stays its parent), or
 * `latexmk`, a Perl script that runs `pdflatex`. The wrapper died at the
 * timeout and the request answered 502 — and the real CLI carried on
 * thinking, unattached and unseen, until it finished on its own. Measured
 * with a wrapper around a sixty-second CLI and a four-second timeout: the
 * 502 came back at four seconds and the CLI was still alive at twenty.
 *
 * Each of these runs a bash wrapper — no `exec` — around a child that writes
 * its own PID to a file and sleeps, and asks afterwards whether that PID is
 * still alive.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApi } from '../src/server/api.js';
import { Repo } from '../src/git/repo.js';
import { runTimedForTest as compileRunTimed } from '../src/render/compile.js';
import { runTimedForTest as fastRunTimed } from '../src/render/fastCompile.js';
import { makeTempStore, type TempStore } from './helpers.js';

const unix = process.platform !== 'win32';

/*
 * A zombie counts as gone. A child killed with its wrapper is handed to PID 1,
 * and in a container PID 1 is not always something that reaps — the process
 * has stopped, and only its entry in the table is left.
 */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2)[0] !== 'Z';
  } catch {
    return true;
  }
}

/** A wrapper script, without `exec`, around a child that records its PID and then sleeps. */
function writeWrapper(dir: string): { wrapper: string; pidFile: string } {
  const pidFile = path.join(dir, 'child.pid');
  const child = path.join(dir, 'slow-cli');
  fs.writeFileSync(child, `#!/bin/bash\necho $$ > '${pidFile}'\necho thinking...\nsleep 60\necho done\n`, 'utf8');
  fs.chmodSync(child, 0o755);
  const wrapper = path.join(dir, 'wrapper');
  fs.writeFileSync(wrapper, `#!/bin/bash\n'${child}' "$@"\n`, 'utf8');
  fs.chmodSync(wrapper, 0o755);
  return { wrapper, pidFile };
}

async function childPid(pidFile: string): Promise<number> {
  for (let i = 0; i < 100 && !fs.existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 20));
  return Number(fs.readFileSync(pidFile, 'utf8').trim());
}

/** Reaping is not instant; give the kernel a moment before calling a PID alive. */
async function goneSoon(pid: number): Promise<boolean> {
  for (let i = 0; i < 50 && alive(pid); i++) await new Promise((r) => setTimeout(r, 20));
  return !alive(pid);
}

const pids: number[] = [];
afterEach(() => {
  // Whatever the result, nothing this file started outlives it.
  for (const pid of pids.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
});

describe.skipIf(!unix)('an AI CLI that times out behind a wrapper script', () => {
  let t: TempStore;
  let app: express.Express;
  beforeEach(() => {
    t = makeTempStore();
    app = express();
    app.use('/api', createApi({ store: t.store, repo: Repo.forStore(t.dir) }));
  });
  afterEach(() => t.cleanup());

  it('is answered 502, and the CLI under the wrapper is not left running', async () => {
    const { wrapper, pidFile } = writeWrapper(t.dir);
    const config = t.store.loadConfig();
    t.store.saveConfig({ ...config, ai: { ...config.ai, enabled: true, command: wrapper, args: ['{prompt}'], timeoutMs: 1500 } });

    const res = await request(app).post('/api/ai/feedback').send({ entryId: 'exp_acme', bulletId: 'b_pipeline' });
    const pid = await childPid(pidFile);
    pids.push(pid);
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/time|took/i);
    expect(await goneSoon(pid)).toBe(true);
  }, 30_000);
});

describe.skipIf(!unix)('a LaTeX run that times out behind a wrapper', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmm-group-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  for (const [name, runTimed] of [
    ['compile.ts', compileRunTimed],
    ['fastCompile.ts', fastRunTimed],
  ] as const) {
    it(`does not leave the engine under it running (${name})`, async () => {
      const { wrapper, pidFile } = writeWrapper(dir);
      await expect(runTimed(wrapper, [], { cwd: dir, timeout: 800 })).rejects.toThrow();
      const pid = await childPid(pidFile);
      pids.push(pid);
      expect(await goneSoon(pid)).toBe(true);
    }, 30_000);
  }
});
