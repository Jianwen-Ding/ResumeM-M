/**
 * The error log, round 27: the order entries list in, what the scrub takes
 * out of a log line and what it leaves, how large an entry may be, `rmm log
 * remote <word>`, and an error log that cannot be made.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { serverLog } from '../src/errorlog/buffer.js';
import { ErrorLog } from '../src/errorlog/log.js';
import { scrubText } from '../src/errorlog/scrub.js';
import { startServer } from '../src/server/index.js';
import { tempDir } from './helpers.js';

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

afterEach(() => {
  serverLog.clear();
});

/** Every entry folder renamed as they were named before milliseconds: `HHMMSS-slug`. */
function asOldFolders(dir: string): void {
  const entries = path.join(dir, 'entries');
  for (const day of fs.readdirSync(entries)) {
    for (const name of fs.readdirSync(path.join(entries, day))) {
      const old = name.replace(/^(\d{6})-\d{3}-/, '$1-');
      if (old !== name) fs.renameSync(path.join(entries, day, name), path.join(entries, day, old));
    }
  }
}

describe('the order entries list in', () => {
  it('is the order they were logged in, within one second too, and pages in the same order', async () => {
    const log = new ErrorLog(tempDir('rmm-el27-'));
    const second = new Date(2026, 9, 14, 12, 0, 0, 0);
    await log.add({ description: 'zzz first', source: 'CLI', at: new Date(second.getTime() + 100) });
    await log.add({ description: 'mmm second', source: 'CLI', at: new Date(second.getTime() + 500) });
    await log.add({ description: 'aaa third', source: 'CLI', at: new Date(second.getTime() + 900) });
    expect((await log.list()).map((e) => e.description)).toEqual(['aaa third', 'mmm second', 'zzz first']);
    expect((await log.list(1, 1)).map((e) => e.description)).toEqual(['mmm second']);
    expect((await log.list(5, 2)).map((e) => e.description)).toEqual(['zzz first']);
    // Its folder says the millisecond.
    expect((await log.list(1))[0]!.id).toMatch(/^entries\/2026-10-14\/120000-900-aaa-third$/);
  });

  it('lists folders named before milliseconds by their time, and "-11" after "-9"', async () => {
    const dir = tempDir('rmm-el27-');
    const log = new ErrorLog(dir);
    const second = new Date(2026, 9, 14, 9, 30, 0, 0);
    // Eleven in one millisecond with the same words: `x`, `x-2` … `x-11`, each made after the last.
    for (let n = 1; n <= 11; n++) await log.add({ description: `Same thing`, source: 'CLI', at: second });
    // And two more in the same second whose words sort the other way round from when they were logged.
    await log.add({ description: 'zzz later', source: 'CLI', at: new Date(second.getTime() + 400) });
    await log.add({ description: 'aaa latest', source: 'CLI', at: new Date(second.getTime() + 800) });
    asOldFolders(dir);
    const names = (await log.list()).map((e) => e.id.split('/').pop());
    expect(names).toEqual([
      '093000-aaa-latest',
      '093000-zzz-later',
      ...[11, 10, 9, 8, 7, 6, 5, 4, 3, 2].map((n) => `093000-same-thing-${n}`),
      '093000-same-thing',
    ]);
    expect((await log.list(3, 2)).map((e) => e.id.split('/').pop())).toEqual(['093000-same-thing-11', '093000-same-thing-10', '093000-same-thing-9']);
    expect(log.count()).toBe(13);
  });
});

describe('what the scrub leaves in a log line', () => {
  it('a date and time, a time in milliseconds, and a number named as a machine’s', () => {
    for (const line of [
      '2024-10-14 12:00',
      'started 2024-10-14 12:00:05 took 1234 ms',
      'commit 1574fe3a9 at 2026-10-14 08:15:30',
      'Error on 14.10.2026 12:00',
      'timestamp 1728907200000',
      'job 4012345678 failed',
      'node v22.22.0 pid 4123456789',
      'commit 0123456789 failed',
      'Compile took 12345 ms (pages 2, overflow 1234567890 pt)',
    ]) {
      expect(scrubText(line), line).toBe(line);
    }
  });

  it('still takes out a phone, after such a word or not', () => {
    expect(scrubText('job (617) 555-0134 called')).toBe('job [phone number] called');
    expect(scrubText('id 617-555-0134')).toBe('id [phone number]');
    expect(scrubText('pid +1 617 555 0134')).toBe('pid [phone number]');
    expect(scrubText('job 617 555 0134')).toBe('job [phone number]');
    expect(scrubText('call me on 4155551234')).toBe('call me on [phone number]');
    expect(scrubText('call me at 415 555 1234 on 2024-10-14 12:00')).toBe('call me at [phone number] on 2024-10-14 12:00');
  });
});

describe('the scrub and tokens', () => {
  // Built from parts, so nothing here looks like a real key to a scanner.
  const STRIPE = ['sk', '_', 'live', '_', 'x'.repeat(24)].join('');
  const STRIPE_TEST = ['rk', '_', 'test', '_', 'Ab3'.repeat(8)].join('');
  const GOOGLE = ['AI', 'za', 'Q'.repeat(35)].join('');
  const NPM = ['npm', '_', 'n'.repeat(36)].join('');
  const GHS = ['gh', 's_', 'Z9'.repeat(18)].join('');
  const PEM = ['-----BEGIN ', 'RSA PRIVATE', ' KEY-----\n', 'QUJD'.repeat(16), '\n-----END ', 'RSA PRIVATE', ' KEY-----'].join('');

  it('takes out Stripe, Google and npm keys, and a private key', () => {
    for (const secret of [STRIPE, STRIPE_TEST, GOOGLE, NPM]) {
      expect(scrubText(`the key ${secret} was refused`), secret.slice(0, 4)).toBe('the key [redacted] was refused');
    }
    expect(scrubText(`key: ${PEM} (loaded)`)).toBe('key: [redacted] (loaded)');
    // Cut off before its END line by the log: the rest of the line goes.
    expect(scrubText(`loading ${PEM.split('\n').slice(0, 2).join(' ')}`)).toBe('loading [redacted]');
  });

  it('keeps the host and repository of an address whose token it masks', () => {
    const out = scrubText(`git push https://x-access-token:${GHS}@github.com/o/r.git failed`);
    expect(out).not.toContain(GHS);
    expect(out).toBe('git push https://x-access-token:•••@github.com/o/r.git failed');
    expect(scrubText(`token=${'t'.repeat(12)}@github.com/o/r`)).toBe('token=[redacted]@github.com/o/r');
  });
});

describe('how large an entry may be', () => {
  it('takes 8 MB of screenshots with two thousand long events, and says what is too large past that', async () => {
    const dir = tempDir('rmm-el27-');
    const srv = tempDir('rmm-el27-srv-');
    const server = await startServer({
      port: 0,
      dataDir: path.join(srv, 'no-save-here'),
      requireProjectSelection: true,
      preferencesFile: path.join(srv, 'projects.json'),
      errorLogDir: dir,
    });
    const base = `http://127.0.0.1:${server.port}`;
    try {
      const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), crypto.randomBytes(8 * 1024 * 1024 - 8)]);
      const shot = `data:image/png;base64,${png.toString('base64')}`;
      const now = Date.now();
      const events = Array.from({ length: 2000 }, (_, i) => ({
        at: new Date(now - (2000 - i) * 200).toISOString(),
        source: 'editor',
        kind: 'console',
        level: 'error',
        message: 'TypeError: cannot read properties of undefined at render (app.js:123:45) '.repeat(30).slice(0, 2000),
      }));
      const body = JSON.stringify({ description: 'Busy and with a screenshot', screenshots: [shot], events });
      expect(body.length).toBeGreaterThan(14 * 1024 * 1024);
      const res = await fetch(`${base}/api/error-log`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
      const said = (await res.json()) as { error?: string; entry?: { events: number; screenshots: number } };
      expect(res.status, said.error).toBe(201);
      expect(said.entry).toMatchObject({ screenshots: 1, events: 2000 });

      const huge = await fetch(`${base}/api/error-log`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: 'x', screenshots: [shot], events, more: 'x'.repeat(4 * 1024 * 1024) }),
      });
      expect(huge.status).toBe(413);
      const error = ((await huge.json()) as { error: string }).error;
      expect(error).toMatch(/too large to log \(\d+\.\d MB\)/);
      expect(error).toMatch(/automatic logs/);
      expect(error).not.toMatch(/Keep the screenshots to 8 MB together/);
    } finally {
      await server.close();
    }
  }, 60_000);
});

/** `rmm log …`, as a person would type it, with only the environment given. */
function rmm(args: string[], env: Record<string, string>) {
  const base = { ...process.env };
  delete base.RMM_ERROR_LOG_DIR;
  delete base.RMM_ERROR_LOG_SETTINGS;
  return run(process.execPath, [path.join(root, 'node_modules/.bin/tsx'), path.join(root, 'src/cli.ts'), ...args], {
    cwd: root,
    timeout: 60_000,
    env: { ...base, ...env },
  });
}

describe('rmm log, round 27', () => {
  const cliEnv = (dir: string, home: string) => ({
    RMM_ERROR_LOG_DIR: dir,
    HOME: home,
    RMM_PROJECTS_FILE: path.join(home, 'projects.json'),
    RMM_DATA: path.join(home, 'no-save'),
  });

  it('"remote" and a word that is no address is a description, and leaves the remote as it was', async () => {
    const home = tempDir('rmm-el27-home-');
    const dir = path.join(home, 'log');
    const remote = 'https://example.invalid/me/error-log.git';
    await rmm(['log', 'remote', remote], cliEnv(dir, home));
    const { stdout, stderr } = await rmm(['log', 'remote', 'unreachable', '--server', 'http://127.0.0.1:9'], cliEnv(dir, home));
    expect(stdout).toMatch(/Logged to .*-remote-unreachable/);
    expect(stderr).toMatch(/"unreachable" is not an address/);
    expect((await rmm(['log', 'remote'], cliEnv(dir, home))).stdout.trim()).toBe(remote);
    const [entry] = await new ErrorLog(dir).list();
    expect(entry!.description).toBe('remote unreachable');
    // An address still sets it: a folder, and user@host:path.
    await rmm(['log', 'remote', home], cliEnv(dir, home));
    expect((await rmm(['log', 'remote'], cliEnv(dir, home))).stdout.trim()).toBe(home);
    await rmm(['log', 'remote', 'git@example.invalid:me/log.git'], cliEnv(dir, home));
    expect((await rmm(['log', 'remote'], cliEnv(dir, home))).stdout.trim()).toBe('git@example.invalid:me/log.git');
  }, 60_000);

  it('says where the error log could not be made, and how to put it elsewhere', async () => {
    const home = tempDir('rmm-el27-home-');
    const file = path.join(home, 'not-a-folder');
    fs.writeFileSync(file, '');
    const failed = await rmm(['log', 'x', '--server', 'http://127.0.0.1:9'], {
      HOME: file,
      RMM_PROJECTS_FILE: path.join(home, 'projects.json'),
      RMM_DATA: path.join(home, 'no-save'),
    }).then(
      () => null,
      (err: { stderr: string; code: number }) => err,
    );
    expect(failed).not.toBeNull();
    expect(failed!.stderr).toMatch(/The error log cannot be kept in .*not-a-folder/);
    expect(failed!.stderr).toMatch(/RMM_ERROR_LOG_DIR/);
    expect(failed!.stderr).not.toMatch(/ENOTDIR/);
  }, 60_000);
});
