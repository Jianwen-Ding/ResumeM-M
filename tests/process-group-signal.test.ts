/**
 * Ctrl-C on the server takes the commands it started down with it.
 *
 * `runInGroup` starts an AI CLI or a LaTeX run in a process group of its own,
 * so a timeout can reach everything under it — and a group of its own is one
 * the terminal's Ctrl-C does not reach. `rmm serve` died at SIGINT and the run
 * it had started carried on, reparented to init, until it finished on its
 * own. Measured with a `sleep 300` under `sh`: still there after the server
 * had gone.
 *
 * Each case starts a small script in a process of its own, which starts a
 * bash wrapper (no `exec`) around a child that records its PID and sleeps,
 * and then ends that script — by signal, or by exiting — and asks whether the
 * child is still alive.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const unix = process.platform !== 'win32';
const groupModule = path.resolve(__dirname, '../src/process-group.ts');

/* A zombie counts as gone: see process-group-timeout.test.ts. */
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

async function goneSoon(pid: number): Promise<boolean> {
  for (let i = 0; i < 100 && alive(pid); i++) await new Promise((r) => setTimeout(r, 20));
  return !alive(pid);
}

let dir: string;
const pids: number[] = [];
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmm-group-signal-'));
});
afterEach(() => {
  for (const pid of pids.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * The script: start the wrapper in a group, wait until the child under it has
 * written its PID, say so on stdout, and then either wait to be signalled or
 * exit on its own.
 */
function writeScript(mode: 'wait' | 'exit'): { script: string; pidFile: string } {
  const pidFile = path.join(dir, 'child.pid');
  const child = path.join(dir, 'slow-cli');
  // `exec`, so the PID written is the sleep's own and nothing outlives a kill of it.
  fs.writeFileSync(child, `#!/bin/bash\necho $$ > '${pidFile}'\nexec sleep 60\n`, 'utf8');
  fs.chmodSync(child, 0o755);
  const wrapper = path.join(dir, 'wrapper');
  fs.writeFileSync(wrapper, `#!/bin/bash\n'${child}'\n`, 'utf8');
  fs.chmodSync(wrapper, 0o755);
  const script = path.join(dir, 'server.ts');
  fs.writeFileSync(
    script,
    [
      `import fs from 'node:fs';`,
      `import { runInGroup } from ${JSON.stringify(groupModule)};`,
      `runInGroup(${JSON.stringify(wrapper)}, [], { timeout: 600000, graceMs: 1000 }).catch(() => {});`,
      `const ready = setInterval(() => {`,
      `  if (!fs.existsSync(${JSON.stringify(pidFile)}) || !fs.readFileSync(${JSON.stringify(pidFile)}, 'utf8').trim()) return;`,
      `  clearInterval(ready);`,
      `  console.log('ready');`,
      mode === 'exit' ? `  process.exit(3);` : `  setInterval(() => {}, 1000);`,
      `}, 20);`,
    ].join('\n'),
    'utf8',
  );
  return { script, pidFile };
}

function start(script: string) {
  const proc = spawn(process.execPath, ['--import', 'tsx', script], {
    cwd: path.resolve(__dirname, '..'),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (proc.pid) pids.push(proc.pid);
  const ready = new Promise<void>((resolve, reject) => {
    let out = '';
    proc.stdout!.on('data', (d) => {
      out += String(d);
      if (out.includes('ready')) resolve();
    });
    proc.once('exit', () => reject(new Error(`exited before it was ready: ${out}`)));
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    proc.once('exit', (code, signal) => resolve({ code, signal })),
  );
  return { proc, ready, exited };
}

describe.skipIf(!unix)('a server stopped while a command it started is running', () => {
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    it(`takes the command down on ${sig}, and still dies of ${sig}`, async () => {
      const { script, pidFile } = writeScript('wait');
      const { proc, ready, exited } = start(script);
      await ready;
      const child = Number(fs.readFileSync(pidFile, 'utf8').trim());
      pids.push(child);
      expect(alive(child)).toBe(true);

      proc.kill(sig);
      // The same end as before: killed by the signal, not an exit code.
      expect(await exited).toEqual({ code: null, signal: sig });
      expect(await goneSoon(child)).toBe(true);
    }, 30_000);
  }

  it('takes the command down when the server exits on its own', async () => {
    const { script, pidFile } = writeScript('exit');
    const { ready, exited } = start(script);
    await ready;
    const child = Number(fs.readFileSync(pidFile, 'utf8').trim());
    pids.push(child);
    expect(await exited).toEqual({ code: 3, signal: null });
    expect(await goneSoon(child)).toBe(true);
  }, 30_000);
});
