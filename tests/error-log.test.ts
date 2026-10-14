/**
 * The error log: its own git repository, one commit per entry, the logs from
 * the minutes before each entry, and nothing in them that should not leave
 * the machine.
 *
 * Measured against real git throughout — a bare remote standing for the
 * private repository it is pushed to, two clones for two machines — and
 * against a real server and the real CLI, since "the CLI and the server can
 * both write" is a claim about two processes and cannot be checked in one.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { LogBuffer, logServerEvent, serverLog, windowMinutes } from '../src/errorlog/buffer.js';
import { ErrorLog, ErrorLogInputError, errorLogDir, slugOf } from '../src/errorlog/log.js';
import { mergeEvents, scrubText, withoutSecrets } from '../src/errorlog/scrub.js';
import { startServer } from '../src/server/index.js';
import { tempDir } from './helpers.js';

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });

/*
 * Secrets built from parts at run time, so nothing in this file looks like a
 * real one to a scanner, and the scrub is tested on the shapes it has to catch.
 */
const GITHUB_TOKEN = ['gh', 'p_', 'Z9'.repeat(18)].join('');
const BEARER = ['ey', 'J', 'hbGciOiJIUzI1NiJ9', '.', 'eyJzdWIiOiIxMjM0In0', '.', 'c2lnbmF0dXJlLXBhcnQ'].join('');
const QUERY_TOKEN = ['s3', 'cr3t', 'Q', 'uery'].join('');
const EMAIL = ['someone', '@', 'example.com'].join('');
const PHONE = ['(617)', ' 555', '-0199'].join('');
const PAIR = ['pair', '-', 'f00d', 'cafe'].join('');

const PNG = `data:image/png;base64,${Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]).toString('base64')}`;
const JPEG = `data:image/jpeg;base64,${Buffer.from([255, 216, 255, 224, 0, 16]).toString('base64')}`;

const at = (minutesAgo: number, from = Date.now()) => new Date(from - minutesAgo * 60_000).toISOString();
const lines = (file: string) =>
  fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { at: string; source: string; kind: string; message: string });

afterEach(() => {
  serverLog.clear();
});

describe('the repository', () => {
  it('is made the first time something is logged, not when it is looked at', async () => {
    const dir = path.join(tempDir('rmm-el-'), 'error-log');
    const log = new ErrorLog(dir);
    const before = await log.status();
    expect(before).toMatchObject({ dir, isRepo: false, entries: 0, remote: null, lastPush: null });
    expect(await log.list()).toEqual([]);
    expect(fs.existsSync(dir)).toBe(false);

    await log.add({ description: 'First thing', source: 'CLI' });
    expect(await log.isRepo()).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'README.md'), 'utf8')).toMatch(/ResumeM-M's error log/);
    expect(fs.readFileSync(path.join(dir, '.gitattributes'), 'utf8')).toMatch(/^\*\.png binary$/m);
    const history = git(dir, 'log', '--format=%s').trim().split('\n');
    expect(history).toEqual(['Log: First thing', 'Start the error log']);
    expect(git(dir, 'show', '--name-only', '--format=', 'HEAD~1').trim().split('\n').sort()).toEqual(['.gitattributes', '.gitignore', 'README.md']);
    expect(git(dir, 'status', '--porcelain')).toBe('');
  });

  it('lives under the home folder by default, and where RMM_ERROR_LOG_DIR or error-log.json says', () => {
    const home = tempDir('rmm-el-home-');
    const saved = { HOME: process.env.HOME, DIR: process.env.RMM_ERROR_LOG_DIR, SETTINGS: process.env.RMM_ERROR_LOG_SETTINGS };
    try {
      process.env.HOME = home;
      delete process.env.RMM_ERROR_LOG_DIR;
      delete process.env.RMM_ERROR_LOG_SETTINGS;
      expect(errorLogDir()).toBe(path.join(home, '.resumem-m', 'error-log'));
      fs.mkdirSync(path.join(home, '.resumem-m'));
      fs.writeFileSync(path.join(home, '.resumem-m', 'error-log.json'), JSON.stringify({ dir: '~/Logs/rmm' }));
      expect(errorLogDir()).toBe(path.join(home, 'Logs', 'rmm'));
      process.env.RMM_ERROR_LOG_DIR = path.join(home, 'elsewhere');
      expect(errorLogDir()).toBe(path.join(home, 'elsewhere'));
    } finally {
      process.env.HOME = saved.HOME;
      if (saved.DIR === undefined) delete process.env.RMM_ERROR_LOG_DIR;
      else process.env.RMM_ERROR_LOG_DIR = saved.DIR;
      if (saved.SETTINGS !== undefined) process.env.RMM_ERROR_LOG_SETTINGS = saved.SETTINGS;
    }
  });
});

describe('an entry', () => {
  it('is one folder and one commit: entry.md, logs.jsonl and its screenshots', async () => {
    const dir = tempDir('rmm-el-');
    const log = new ErrorLog(dir);
    const when = new Date();
    const { entry, committed, commit } = await log.add({
      description: 'Save button did nothing\nPressed it twice; the status said nothing.',
      source: 'editor',
      at: when,
      minutes: 10,
      screenshots: [PNG, JPEG],
      logs: [{ events: [{ at: at(1, when.getTime()), source: 'editor', kind: 'api', level: 'error', message: 'PUT /api/resumes/x → 500: disk full' }] }],
      versions: { serverBuild: '1234', appVersion: '0.1.0' },
      save: '/saves/work',
      resumeId: 'intern',
    });
    expect(committed).toBe(true);
    expect(entry.id).toMatch(/^entries\/\d{4}-\d{2}-\d{2}\/\d{6}-save-button-did-nothing$/);
    const folder = path.join(dir, entry.id);
    expect(fs.readdirSync(folder).sort()).toEqual(['entry.md', 'logs.jsonl', 'screenshot-1.png', 'screenshot-2.jpg']);
    const md = fs.readFileSync(path.join(folder, 'entry.md'), 'utf8');
    expect(md).toMatch(/^# Save button did nothing$/m);
    expect(md).toMatch(/Pressed it twice/);
    expect(md).toMatch(/\*\*From:\*\* editor/);
    expect(md).toMatch(/\*\*Save open:\*\* \/saves\/work/);
    expect(md).toMatch(/\*\*Resume:\*\* intern/);
    expect(md).toMatch(/server build 1234 · ResumeM-M 0\.1\.0/);
    expect(md).toContain(when.toISOString());
    expect(lines(path.join(folder, 'logs.jsonl'))).toHaveLength(1);

    expect(git(dir, 'log', '-1', '--format=%s')).toBe('Log: Save button did nothing\n');
    expect(git(dir, 'rev-parse', 'HEAD').trim()).toBe(commit);
    expect(git(dir, 'show', '--name-only', '--format=', 'HEAD').trim().split('\n').sort()).toEqual(
      ['entry.md', 'logs.jsonl', 'screenshot-1.png', 'screenshot-2.jpg'].map((f) => `${entry.id}/${f}`),
    );
    // Binary, as .gitattributes says.
    expect(git(dir, 'check-attr', 'binary', '--', `${entry.id}/screenshot-1.png`)).toMatch(/binary: set/);

    const [listed] = await log.list();
    expect(listed).toMatchObject({ id: entry.id, source: 'editor', description: 'Save button did nothing', screenshots: 2, events: 1, pushed: false });
  });

  it('two in the same second with the same words are two folders', async () => {
    const log = new ErrorLog(tempDir('rmm-el-'));
    const when = new Date();
    const one = await log.add({ description: 'Same thing', source: 'CLI', at: when });
    const two = await log.add({ description: 'Same thing', source: 'CLI', at: when });
    expect(two.entry.id).toBe(`${one.entry.id}-2`);
    expect(slugOf('Ünïcödé — ça marche?')).toBe('unicode-ca-marche');
    expect(slugOf('日本語')).toBe('entry');
  });

  it('refuses a missing description, a screenshot that is not its type, and more than 8 MB of them', async () => {
    const dir = tempDir('rmm-el-');
    const log = new ErrorLog(dir);
    await expect(log.add({ description: '  ', source: 'CLI' })).rejects.toThrow(ErrorLogInputError);
    // PNG by its type, JPEG by its bytes.
    const lying = `data:image/png;base64,${Buffer.from([255, 216, 255, 224, 0, 16]).toString('base64')}`;
    await expect(log.add({ description: 'x', source: 'CLI', screenshots: [lying] })).rejects.toThrow(/be the image their type says/);
    await expect(log.add({ description: 'x', source: 'CLI', screenshots: ['data:image/gif;base64,R0lGODlh'] })).rejects.toThrow(ErrorLogInputError);
    const big = Buffer.alloc(4.5 * 1024 * 1024);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(big);
    const half = `data:image/png;base64,${big.toString('base64')}`;
    await expect(log.add({ description: 'x', source: 'CLI', screenshots: [half, half] })).rejects.toThrow(/keep them to 8 MB/);
    // Nothing was written for any of them.
    expect(fs.existsSync(path.join(dir, 'entries'))).toBe(false);
    // One of them alone is fine.
    expect((await log.add({ description: 'x', source: 'CLI', screenshots: [half] })).committed).toBe(true);
  });
});

describe('the logs from the time frame', () => {
  it('keeps the window asked for, merges every source, and puts them in the order they happened', () => {
    const now = Date.now();
    const merged = mergeEvents(
      [
        {
          events: [
            { at: at(12, now), source: 'server', kind: 'request', level: 'error', message: 'too old for 10 minutes' },
            { at: at(5, now), source: 'server', kind: 'request', level: 'error', message: 'server five' },
            { at: at(1, now), source: 'server', kind: 'console', level: 'warn', message: 'server one' },
          ],
        },
        {
          source: 'editor',
          events: [
            { at: at(3, now), kind: 'api', level: 'warn', message: 'editor three' },
            { at: at(-10, now), kind: 'api', level: 'warn', message: 'in the future' },
            { at: 'not a time', kind: 'api', message: 'no time' },
            { at: at(2, now), kind: 'api', message: '' },
          ],
        },
      ],
      { until: new Date(now), minutes: 10 },
    );
    expect(merged.map((e) => e.message)).toEqual(['server five', 'editor three', 'server one']);
    expect(merged.map((e) => e.source)).toEqual(['server', 'editor', 'server']);
    expect(mergeEvents([{ events: [{ at: at(5, now), message: 'x' }] }], { until: new Date(now), minutes: 2 })).toEqual([]);
    expect([windowMinutes(undefined), windowMinutes('2'), windowMinutes(30), windowMinutes(99), windowMinutes('abc')]).toEqual([10, 2, 30, 30, 10]);
  });

  it('holds fifteen minutes or two thousand events, whichever is less', () => {
    let clock = Date.now();
    const buffer = new LogBuffer(15 * 60_000, 2000, () => clock);
    for (let i = 0; i < 2500; i++) buffer.push({ source: 'server', kind: 'k', level: 'info', message: `n${i}` });
    expect(buffer.size).toBe(2000);
    expect(buffer.since(1)[0]!.message).toBe('n500');
    clock += 16 * 60_000;
    buffer.push({ source: 'server', kind: 'k', level: 'info', message: 'late' });
    expect(buffer.since(30).map((e) => e.message)).toEqual(['late']);
  });
});

describe('what never reaches logs.jsonl', () => {
  it('an email, a phone number, a token, an Authorization header, a pairing header and a ?token= query', async () => {
    const dir = tempDir('rmm-el-');
    const log = new ErrorLog(dir);
    const remote = `https://alice:${GITHUB_TOKEN}@github.com/alice/errors.git`;
    const { entry } = await log.add({
      description: 'Push failed',
      source: 'editor',
      logs: [
        {
          events: [
            { at: at(1), kind: 'push', level: 'error', message: `fatal: could not read from ${remote}` },
            { at: at(1), kind: 'request', level: 'error', message: `GET /api/auth/callback?code=abc123&token=${QUERY_TOKEN}&page=2 → 400` },
            { at: at(1), kind: 'console', level: 'warn', message: `Authorization: Bearer ${BEARER} was refused` },
            { at: at(1), kind: 'console', level: 'warn', message: `headers {"X-RMM-Pair":"${PAIR}"}` },
            { at: at(1), kind: 'console', level: 'warn', message: `could not mail ${EMAIL} or call ${PHONE}` },
            { at: at(1), kind: 'console', level: 'warn', message: `bare ${GITHUB_TOKEN} pasted`, detail: { url: `https://x.example/?api_key=${QUERY_TOKEN}` } },
            { at: at(1), kind: 'console', level: 'warn', message: `password=${QUERY_TOKEN}` },
          ],
        },
      ],
      page: { url: `https://jobs.example/apply?session=${QUERY_TOKEN}&id=4`, title: 'Apply' },
    });
    const written = fs.readFileSync(path.join(dir, entry.id, 'logs.jsonl'), 'utf8');
    const md = fs.readFileSync(path.join(dir, entry.id, 'entry.md'), 'utf8');
    for (const secret of [GITHUB_TOKEN, BEARER, QUERY_TOKEN, EMAIL, '555-0199', PAIR, 'abc123']) {
      expect(written).not.toContain(secret);
      expect(md).not.toContain(secret);
    }
    expect(written).toContain('https://alice:•••@github.com/alice/errors.git');
    expect(written).toContain('[email address]');
    expect(written).toContain('[phone number]');
    expect(written).toContain('token=[redacted]');
    expect(written).toContain('page=2');
    expect(md).toContain('id=4');
    // And the scrub leaves the ordinary parts of a line alone.
    expect(scrubText('PUT /api/resumes/intern → 409: written against another save (812 ms)')).toBe(
      'PUT /api/resumes/intern → 409: written against another save (812 ms)',
    );
    expect(withoutSecrets(`Authorization: Basic ${QUERY_TOKEN}`)).toBe('Authorization: Basic [redacted]');
  });
});

describe('push and pull', () => {
  it('pushes to a bare remote, and another machine pulls the entries in', async () => {
    const base = tempDir('rmm-el-sync-');
    const remote = path.join(base, 'errors.git');
    git(base, 'init', '-q', '--bare', remote);

    const a = new ErrorLog(path.join(base, 'a'));
    const nothing = await a.push();
    expect(nothing.ok).toBe(false);
    expect(nothing.output).toMatch(/no remote yet/);
    await a.add({ description: 'On machine A', source: 'CLI' });
    const status = await a.setRemote(remote);
    expect(status.remote?.url).toBe(remote);
    expect((await a.list())[0]!.pushed).toBe(false);
    const pushed = await a.push();
    expect(pushed.ok).toBe(true);
    expect(pushed.status.lastPush).toBeTruthy();
    expect(pushed.status.remote).toMatchObject({ ahead: 0, behind: 0, tracked: true });
    expect((await a.list())[0]!.pushed).toBe(true);

    // Machine B: its own error log, pointed at the same remote.
    const b = new ErrorLog(path.join(base, 'b'));
    git(base, 'clone', '-q', remote, 'b');
    await b.add({ description: 'On machine B', source: 'CLI' });
    expect((await b.push()).ok).toBe(true);

    const pulled = await a.pull();
    expect(pulled.ok).toBe(true);
    expect(pulled.pulled).toBe(1);
    expect((await a.list()).map((e) => e.description).sort()).toEqual(['On machine A', 'On machine B']);

    // Both moved on: A's push is refused, said in the error log's words, and a pull merges.
    await a.add({ description: 'A again', source: 'CLI' });
    await b.add({ description: 'B again', source: 'CLI' });
    expect((await b.push()).ok).toBe(true);
    const refused = await a.push();
    expect(refused.ok).toBe(false);
    expect(refused.output).toMatch(/rmm log pull/);
    expect(refused.output).not.toMatch(/\bsave\b/);
    const merged = await a.pull();
    expect(merged.ok).toBe(true);
    expect((await a.push()).ok).toBe(true);
    expect((await a.list()).length).toBe(4);
  });

  it('never shows the token in a remote address', async () => {
    const log = new ErrorLog(tempDir('rmm-el-'));
    const status = await log.setRemote(`https://alice:${GITHUB_TOKEN}@github.invalid/alice/errors.git`);
    expect(JSON.stringify(status)).not.toContain(GITHUB_TOKEN);
    expect(status.remote?.url).toBe('https://alice:•••@github.invalid/alice/errors.git');
    expect((await log.setRemote('')).remote).toBeNull();
  });
});

/** A server with no save open, writing to its own error log. */
async function aServer(errorLogDir: string) {
  const dir = tempDir('rmm-el-srv-');
  const server = await startServer({
    port: 0,
    dataDir: path.join(dir, 'no-save-here'),
    requireProjectSelection: true,
    preferencesFile: path.join(dir, 'projects.json'),
    errorLogDir,
  });
  return { ...server, base: `http://127.0.0.1:${server.port}` };
}

describe('the server', () => {
  it('takes an entry with no save open, with its own failures and the editor’s from the window', async () => {
    const dir = tempDir('rmm-el-');
    const server = await aServer(dir);
    try {
      // Something going wrong: no save is open, so the store answers 409.
      expect((await fetch(`${server.base}/api/store?token=${QUERY_TOKEN}`)).status).toBe(409);
      console.warn(`[rmm] something odd for ${EMAIL}`);
      logServerEvent('ai', 'AI run "tailor" failed: timed out');

      const recent = (await (await fetch(`${server.base}/api/error-log/recent?minutes=2`)).json()) as { dir: string; events: { message: string }[] };
      expect(recent.dir).toBe(dir);
      expect(recent.events.map((e) => e.message).join('\n')).toMatch(/GET \/api\/store → 409: No Save Open/);
      expect(JSON.stringify(recent)).not.toContain(QUERY_TOKEN);

      const res = await fetch(`${server.base}/api/error-log`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          description: 'Opening a save does nothing',
          minutes: 10,
          screenshots: [PNG],
          events: [
            { at: at(0.5), source: 'editor', kind: 'status', level: 'error', message: `Could not open — ${EMAIL}` },
            { at: at(20), source: 'editor', kind: 'status', level: 'error', message: 'outside the window' },
          ],
        }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { entry: { id: string }; committed: boolean; message: string };
      expect(body.committed).toBe(true);
      expect(body.message).toBe('Logged to the error log (not pushed yet).');
      const events = lines(path.join(dir, body.entry.id, 'logs.jsonl'));
      const said = events.map((e) => `${e.source}/${e.kind}: ${e.message}`).join('\n');
      expect(said).toMatch(/server\/request: GET \/api\/store → 409/);
      expect(said).toMatch(/server\/console: \[rmm\] something odd for \[email address\]/);
      expect(said).toMatch(/server\/ai: AI run "tailor" failed: timed out/);
      expect(said).toMatch(/editor\/status: Could not open — \[email address\]/);
      expect(said).not.toMatch(/outside the window/);
      expect(events.map((e) => e.at)).toEqual([...events.map((e) => e.at)].sort());
      const md = fs.readFileSync(path.join(dir, body.entry.id, 'entry.md'), 'utf8');
      expect(md).toMatch(/\*\*From:\*\* editor/);
      expect(md).toMatch(/\*\*Save open:\*\* none/);
      expect(md).toMatch(/server build \d+/);

      const listed = (await (await fetch(`${server.base}/api/error-log`)).json()) as { entries: { description: string; screenshots: number }[] };
      expect(listed.entries[0]).toMatchObject({ description: 'Opening a save does nothing', screenshots: 1 });
      const status = (await (await fetch(`${server.base}/api/error-log/status`)).json()) as { isRepo: boolean; entries: number };
      expect(status).toMatchObject({ isRepo: true, entries: 1 });

      // Refused: no description, a lying screenshot, too much body.
      const post = (body: unknown) =>
        fetch(`${server.base}/api/error-log`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      expect((await post({ description: '' })).status).toBe(400);
      expect((await post({ description: 'x', screenshots: [PNG.replace('png', 'webp')] })).status).toBe(400);
      const huge = await post({ description: 'x', screenshots: ['data:image/png;base64,' + 'A'.repeat(13 * 1024 * 1024)] });
      expect(huge.status).toBe(413);
      expect(((await huge.json()) as { error: string }).error).toMatch(/too large/);
    } finally {
      await server.close();
    }
  });

  it('answers an unpaired extension as every other route does', async () => {
    const server = await aServer(tempDir('rmm-el-'));
    try {
      const res = await fetch(`${server.base}/api/error-log`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: `chrome-extension://${'a'.repeat(32)}`, 'X-RMM-Pair': '' },
        body: JSON.stringify({ description: 'from an extension nobody paired' }),
      });
      expect(res.status).toBe(403);
      expect(((await res.json()) as { kind: string }).kind).toBe('not-paired');
    } finally {
      await server.close();
    }
  });

  it('sets a remote, pushes and pulls', async () => {
    const base = tempDir('rmm-el-');
    const dir = path.join(base, 'log');
    const remote = path.join(base, 'remote.git');
    git(base, 'init', '-q', '--bare', remote);
    const server = await aServer(dir);
    const call = async (method: string, route: string, body?: unknown) =>
      (await fetch(`${server.base}/api/error-log${route}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }).then((r) => r.json())) as Record<string, unknown> & { status: { remote: { ahead: number } | null; lastPush: string | null } };
    try {
      await call('POST', '', { description: 'One' });
      const set = await call('PUT', '/remote', { url: remote });
      expect((set as unknown as { remote: { url: string } }).remote.url).toBe(remote);
      const pushed = await call('POST', '/push');
      expect(pushed.ok).toBe(true);
      expect(pushed.status.lastPush).toBeTruthy();
      const pulled = await call('POST', '/pull');
      expect(pulled.ok).toBe(true);
      expect(pulled.message).toMatch(/Already up to date/);
      expect(git(remote, 'log', '--format=%s', '-1')).toBe('Log: One\n');
    } finally {
      await server.close();
    }
  });
});

/** `rmm log …`, as a person would type it. */
function rmm(args: string[], env: Record<string, string>) {
  return run(process.execPath, [path.join(root, 'node_modules/.bin/tsx'), path.join(root, 'src/cli.ts'), ...args], {
    cwd: root,
    timeout: 60_000,
    env: { ...process.env, ...env },
  });
}

describe('rmm log', () => {
  const cliEnv = (dir: string, home: string) => ({
    RMM_ERROR_LOG_DIR: dir,
    HOME: home,
    RMM_PROJECTS_FILE: path.join(home, 'projects.json'),
    RMM_DATA: path.join(home, 'no-save'),
  });

  it('with no server running: an entry, its screenshot, and a word that there were no logs to include', async () => {
    const home = tempDir('rmm-el-home-');
    const dir = path.join(home, 'log');
    const shot = path.join(home, 'shot.png');
    fs.writeFileSync(shot, Buffer.from(PNG.split(',')[1]!, 'base64'));
    const { stdout } = await rmm(['log', 'The build hung', '--minutes', '2', '--screenshot', shot, '--server', 'http://127.0.0.1:9'], cliEnv(dir, home));
    expect(stdout).toMatch(/Logged to .*entries\/.*-the-build-hung \(not pushed yet/);
    expect(stdout).toMatch(/No automatic logs: no server is running at http:\/\/127\.0\.0\.1:9/);
    const [entry] = await new ErrorLog(dir).list();
    expect(entry).toMatchObject({ description: 'The build hung', source: 'CLI', screenshots: 1, events: 0 });
    expect(fs.readFileSync(path.join(dir, entry!.id, 'entry.md'), 'utf8')).toMatch(/\*\*From:\*\* CLI/);
    // Nothing made where a save would go.
    expect(fs.existsSync(path.join(home, 'no-save'))).toBe(false);

    const status = await rmm(['log', 'status'], cliEnv(dir, home));
    expect(status.stdout).toMatch(/1 entry/);
    expect(status.stdout).toMatch(/The build hung \[1 screenshot\] \(not pushed\)/);
    await expect(rmm(['log', 'push'], cliEnv(dir, home))).rejects.toMatchObject({ stderr: expect.stringMatching(/no remote yet/) });
    await expect(rmm(['log', 'x', '--screenshot', path.join(home, 'projects.json')], cliEnv(dir, home))).rejects.toMatchObject({
      stderr: expect.stringMatching(/nothing at that path|not a PNG/),
    });
  });

  it('with a server running for the same error log: the server’s logs from the window', async () => {
    const home = tempDir('rmm-el-home-');
    const dir = path.join(home, 'log');
    const server = await aServer(dir);
    try {
      await fetch(`${server.base}/api/resumes`);
      const { stdout } = await rmm(['log', 'Resumes would not load', '--server', server.base], cliEnv(dir, home));
      expect(stdout).toMatch(/\d+ events? from the last 10 minutes, from the server at/);
      const [entry] = await new ErrorLog(dir).list();
      const events = lines(path.join(dir, entry!.id, 'logs.jsonl'));
      expect(events.some((e) => e.source === 'server' && /GET \/api\/resumes → 409/.test(e.message))).toBe(true);
      const md = fs.readFileSync(path.join(dir, entry!.id, 'entry.md'), 'utf8');
      expect(md).toMatch(/server build \d+/);

      // A server keeping another error log is not this one's to quote.
      const other = await rmm(['log', 'Elsewhere', '--server', server.base], cliEnv(path.join(home, 'other-log'), home));
      expect(other.stdout).toMatch(/No automatic logs: the server at .* keeps its error log in/);
    } finally {
      await server.close();
    }
  });

  it('the CLI and the server writing at once: every entry its own commit, none lost', async () => {
    const home = tempDir('rmm-el-home-');
    const dir = path.join(home, 'log');
    const server = await aServer(dir);
    try {
      // Made first, so the race is over entries rather than over who makes the repository.
      await new ErrorLog(dir).ensure();
      /*
       * The server logging one entry after another, for as long as the CLI
       * runs, so the CLI's writes and commits land among the server's rather
       * than before or after them all.
       */
      const cli = [1, 2, 3].map((n) => rmm(['log', `From the CLI ${n}`, '--server', 'http://127.0.0.1:9'], cliEnv(dir, home)));
      let cliDone = false;
      void Promise.allSettled(cli).then(() => (cliDone = true));
      const answers: { committed: boolean }[] = [];
      for (let n = 1; !cliDone || n <= 3; n++) {
        const res = await fetch(`${server.base}/api/error-log`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ description: `From the server ${n}` }),
        });
        answers.push((await res.json()) as { committed: boolean });
      }
      await Promise.all(cli);
      expect(answers.length).toBeGreaterThanOrEqual(3);
      expect(answers.every((a) => a.committed)).toBe(true);
      const subjects = git(dir, 'log', '--format=%s').trim().split('\n');
      expect(subjects.filter((s) => s.startsWith('Log: ')).sort()).toEqual(
        [1, 2, 3].map((n) => `Log: From the CLI ${n}`).concat(answers.map((_a, i) => `Log: From the server ${i + 1}`)).sort(),
      );
      // The CLI's landed among the server's, not after them all.
      const order = subjects.reverse().filter((s) => s.startsWith('Log: '));
      expect(order.findIndex((s) => s.includes('CLI'))).toBeLessThan(order.length - 3);
      const total = 3 + answers.length;
      // One entry per commit, nothing left uncommitted, and no lock left behind.
      for (const hash of git(dir, 'log', '--format=%H', `-${total}`).trim().split('\n')) {
        const folders = new Set(git(dir, 'show', '--name-only', '--format=', hash).trim().split('\n').map((f) => f.split('/').slice(0, 3).join('/')));
        expect(folders.size).toBe(1);
      }
      expect(git(dir, 'status', '--porcelain')).toBe('');
      expect(fs.existsSync(path.join(dir, '.git', 'rmm-write.lock'))).toBe(false);
      expect((await new ErrorLog(dir).list(200)).length).toBe(total);
    } finally {
      await server.close();
    }
  });
});

describe('the bug-report inbox', () => {
  it('copies each report into the error log too', async () => {
    const dir = tempDir('rmm-el-');
    const work = tempDir('rmm-el-srv-');
    const server = await startServer({
      port: 0,
      dataDir: path.join(work, 'none'),
      requireProjectSelection: true,
      preferencesFile: path.join(work, 'projects.json'),
      bugReportsDir: path.join(work, 'inbox'),
      errorLogDir: dir,
    });
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/bug-reports`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: '123e4567-e89b-12d3-a456-426614174000',
          text: 'The card vanished',
          createdAt: new Date().toISOString(),
          version: '0.1.1',
          extensionBuild: 'abcdef0123456789',
          screenshots: [PNG],
        }),
      });
      expect(res.status).toBe(201);
      await expect.poll(async () => (await new ErrorLog(dir).list())[0], { timeout: 15_000 }).toMatchObject({
        source: 'bug report',
        description: 'The card vanished',
        screenshots: 1,
      });
      expect(fs.existsSync(path.join(work, 'inbox', '123e4567-e89b-12d3-a456-426614174000', 'report.json'))).toBe(true);
    } finally {
      await server.close();
    }
  });
});
