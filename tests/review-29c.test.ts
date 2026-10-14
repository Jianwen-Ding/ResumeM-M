/**
 * Round 29c: a body the API cannot read, a port already taken, a fit that
 * said it used more than there was, a log scrub that took ids for phone
 * numbers, and `rmm log remote` taking any word:rest for an address.
 */
import { describe, expect, it } from 'vitest';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { startServer } from '../src/server/index.js';
import { reportedUsedPt } from '../src/render/compile.js';
import { scrubText } from '../src/errorlog/scrub.js';
import { ErrorLog } from '../src/errorlog/log.js';
import { makeTempStore, tempDir } from './helpers.js';

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tsx = path.join(root, 'node_modules/.bin/tsx');
const cli = path.join(root, 'src/cli.ts');

describe('a request body the API cannot read', () => {
  it('is answered as JSON with its status, and no stack trace or path', async () => {
    const store = makeTempStore();
    const server = await startServer({ port: 0, dataDir: store.dir });
    const base = `http://127.0.0.1:${server.port}/api`;
    const send = (body: string) =>
      fetch(`${base}/resumes/intern`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body });
    try {
      for (const body of ['{"sections": [', '"just text"', '7']) {
        const res = await send(body);
        expect(res.status, body).toBe(400);
        expect(res.headers.get('content-type'), body).toMatch(/application\/json/);
        const text = await res.text();
        expect(text, body).not.toMatch(/node_modules|at \w+ \(|<pre>|\/src\//);
        expect(JSON.parse(text).error, body).toBeTruthy();
      }
      const big = await send(' '.repeat(33 * 1024 * 1024));
      expect(big.status).toBe(413);
      const said = (await big.json()) as { error: string };
      expect(said.error).toMatch(/too large/);
    } finally {
      await server.close();
      store.cleanup();
    }
  }, 30_000);
});

describe('rmm serve on a port that is taken', () => {
  it('says so and exits 1, before it opens the save or writes to it', async () => {
    const holder = net.createServer();
    await new Promise<void>((resolve) => holder.listen(0, '127.0.0.1', resolve));
    const port = (holder.address() as net.AddressInfo).port;
    const home = tempDir('rmm-r29c-home-');
    const save = makeTempStore();
    // A save with no repository yet: anything the serve wrote would make one.
    fs.rmSync(path.join(save.dir, '.git'), { recursive: true, force: true });
    try {
      const child = spawn(process.execPath, [tsx, cli, 'serve', '--port', String(port), '--data', save.dir], {
        cwd: root,
        env: { ...process.env, HOME: home, RMM_PROJECTS_FILE: path.join(home, 'projects.json') },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      child.stdout.on('data', (b) => (out += String(b)));
      child.stderr.on('data', (b) => (out += String(b)));
      const code = await new Promise<number | null>((resolve) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          resolve(null);
        }, 40_000);
        child.on('exit', (c) => {
          clearTimeout(timer);
          resolve(c);
        });
      });
      expect(code, out).toBe(1);
      expect(out).toContain(`Port ${port} is already in use — is ResumeM-M already running? Use --port to pick another.`);
      expect(out).not.toMatch(/EADDRINUSE|at Server\./);
      expect(fs.existsSync(path.join(save.dir, '.git')), 'nothing was committed').toBe(false);
    } finally {
      holder.close();
      save.cleanup();
    }
  }, 60_000);
});

describe('the height a fitted resume is said to use', () => {
  it('is never more than the room it has, when it fits', () => {
    expect(reportedUsedPt(725.53, 720, true)).toBe(720);
    expect(reportedUsedPt(600.04, 720, true)).toBe(600);
    // One that does not fit says how far over it is.
    expect(reportedUsedPt(812.26, 720, false)).toBe(812.3);
  });
});

describe('ids in a log line next to a word that is not about a phone', () => {
  // 555-01xx: numbers set aside for fiction.
  it('keeps them', () => {
    for (const line of [
      'API call failed for job 1234567890',
      'fetch call timed out, request 1697040000',
      'call stack: commit 4155550134',
      'Mobile build 2024061512',
      'tel: link handler pid 1234567890',
    ]) {
      expect(scrubText(line), line).toBe(line);
    }
    expect(scrubText('Phone (ID 6175550134) then job 1234567890')).toBe('Phone (ID [phone number]) then job 1234567890');
  });

  it('still takes out a number a phone word names', () => {
    for (const line of ['Phone (ID 6175550134)', 'Phone line 6175550134', 'Mobile: 6175550134', 'mobile number 6175550134', 'SMS 6175550134', 'call me on 6175550134']) {
      expect(scrubText(line), line).not.toContain('6175550134');
    }
  });
});

describe('rmm log remote <word>:<rest>', () => {
  it('logs a word with a colon in it as a description, not as the remote', async () => {
    const home = tempDir('rmm-r29c-log-');
    const dir = path.join(home, 'log');
    const base = { ...process.env };
    delete base.RMM_ERROR_LOG_DIR;
    delete base.RMM_ERROR_LOG_SETTINGS;
    const env = { ...base, RMM_ERROR_LOG_DIR: dir, HOME: home, RMM_PROJECTS_FILE: path.join(home, 'projects.json'), RMM_DATA: path.join(home, 'no-save') };
    const rmm = (args: string[]) => run(process.execPath, [tsx, cli, ...args], { cwd: root, timeout: 60_000, env });

    await rmm(['log', 'remote', 'me@myserver:/srv/log.git']);
    for (const word of ['unreachable:503', 'HTTP:502', 'timeout:30s']) {
      const { stdout } = await rmm(['log', 'remote', word, '--server', 'http://127.0.0.1:9']);
      expect(stdout, word).toMatch(/Logged to /);
      expect((await rmm(['log', 'remote'])).stdout.trim(), word).toBe('me@myserver:/srv/log.git');
    }
    expect((await new ErrorLog(dir).list()).length).toBe(3);
    // An address with no dot in its host still is one, with a path that looks like one.
    await rmm(['log', 'remote', 'myserver:log.git']);
    expect((await rmm(['log', 'remote'])).stdout.trim()).toBe('myserver:log.git');
  }, 120_000);
});
