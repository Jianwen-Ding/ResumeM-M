/**
 * `bin/rmm.js`, the command people actually type, run as a process.
 *
 * It ran the CLI under `npx tsx` and passed nothing on: a SIGTERM sent to
 * `rmm serve` killed the launcher and left the server running on its port, and
 * a server killed out from under it was reported as a clean exit 0.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const freePort = () =>
  new Promise<number>((resolve) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });

const answers = (port: number) =>
  fetch(`http://127.0.0.1:${port}/health`).then(
    (r) => r.ok,
    () => false,
  );

async function until(check: () => Promise<boolean>, ms: number): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; ) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return check();
}

const exited = (child: ChildProcess) =>
  new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve({ code: child.exitCode, signal: child.signalCode });
    else child.once('exit', (code, signal) => resolve({ code, signal }));
  });

describe.skipIf(process.platform === 'win32')('the rmm launcher', () => {
  let scratch: string;
  let launcher: ChildProcess | undefined;

  beforeEach(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rmm-launcher-'));
    fs.mkdirSync(path.join(scratch, 'save'));
    fs.writeFileSync(path.join(scratch, 'save', 'profile.yaml'), 'name: Someone\n');
    fs.writeFileSync(path.join(scratch, 'save', 'config.yaml'), 'ai:\n  enabled: false\n');
  });

  afterEach(() => {
    // Everything it started, whatever the test left running.
    if (launcher?.pid) {
      try {
        process.kill(-launcher.pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
    launcher = undefined;
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  const serve = async () => {
    const port = await freePort();
    launcher = spawn(process.execPath, [path.join(root, 'bin', 'rmm.js'), 'serve', '--port', String(port), '--data', path.join(scratch, 'save')], {
      cwd: scratch,
      env: { ...process.env, HOME: scratch, RMM_PROJECTS_FILE: path.join(scratch, 'projects.json'), RMM_AUTOCOMMIT: '0' },
      stdio: 'ignore',
      // Its own group, so the cleanup above can reach a server it orphaned.
      detached: true,
    });
    expect(await until(() => answers(port), 60_000)).toBe(true);
    return { port, launcher };
  };

  it('stops the server when it is told to stop', { timeout: 90_000 }, async () => {
    const { port, launcher } = await serve();

    launcher.kill('SIGTERM');
    await exited(launcher);

    expect(await until(async () => !(await answers(port)), 5000)).toBe(true);
  });

  it('fails when the CLI under it is killed, rather than exiting 0', { timeout: 90_000 }, async () => {
    const { launcher } = await serve();
    const child = Number(execFileSync('pgrep', ['-P', String(launcher.pid)], { encoding: 'utf8' }).trim().split('\n')[0]);
    expect(child).toBeGreaterThan(0);

    process.kill(child, 'SIGKILL');
    const end = await exited(launcher);

    expect(end.code === 0).toBe(false);
    expect(end.signal ?? end.code).toBe(end.signal ? 'SIGKILL' : 137);
  });
});
