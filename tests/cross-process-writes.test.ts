/**
 * The server and the `rmm` CLI writing one save at the same time.
 *
 * They are two processes, and nothing stood between them: the server's
 * commit queue and its handlers' check-then-write are promises inside one
 * process. Measured with the server saving one tracker row in a loop:
 *
 * - `rmm apply` filed a row and exited 0, and the server then wrote back the
 *   tracker it had read a moment before, without the row.
 * - `rmm config set ai.enabled` lost eight changes in sixteen to the Settings
 *   page saving the AI timeout.
 * - Both committing at once collided on git's `index.lock`, or one took the
 *   other's staged files and the other's commit then failed — and `rmm apply`
 *   exited 1 with the application filed.
 * - A file changed by the other process within one tick of a coarse clock,
 *   to the same size, was served from the read cache as it had been.
 *
 * The other process here is `cross-process-child.ts`: a `Store` of its own
 * in a process of its own, which is all the CLI is as far as the save can
 * tell. The server is `createApi`, in this process.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import express from 'express';
import request from 'supertest';
import YAML from 'yaml';
import { createApi } from '../src/server/api.js';
import { Repo } from '../src/git/repo.js';
import { Store, mergeById } from '../src/model/store.js';
import { SaveBusyError, SaveLock, holdSave, holdSaveSync } from '../src/model/save-lock.js';
import { makeTempStore, type TempStore } from './helpers.js';

const run = promisify(execFile);
const root = path.resolve(import.meta.dirname, '..');
const tsx = path.join(root, 'node_modules/.bin/tsx');
const childScript = path.join(root, 'tests/cross-process-child.ts');

/** The other process: started now, and its JSON line and exit code when it ends. */
function other(save: string, mode: string, n: number) {
  const child = spawn(process.execPath, [tsx, childScript, save, mode, String(n)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', (b) => (out += String(b)));
  child.stderr.on('data', (b) => (err += String(b)));
  let exited = false;
  const done = new Promise<{ code: number | null; result: Record<string, unknown> }>((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code) => {
      exited = true;
      const line = out.trim().split('\n').pop() ?? '';
      try {
        resolve({ code, result: JSON.parse(line) as Record<string, unknown> });
      } catch {
        reject(new Error(`the other process said: ${out}\n${err}`));
      }
    });
  });
  return { child, done, running: () => !exited };
}

let t: TempStore;
let app: express.Express;

const SEED = {
  id: 'seed',
  company: 'Seed',
  role: 'Dev',
  status: 'applied',
  appliedAt: '2026-10-01T00:00:00.000Z',
  history: [{ at: '2026-10-01T00:00:00.000Z', status: 'applied' }],
};

beforeEach(() => {
  t = makeTempStore();
  t.write('applications.yaml', [
    SEED,
    // Some bulk, so a read and a write take as long as on a real tracker.
    ...Array.from({ length: 40 }, (_, k) => ({ ...SEED, id: `filler-${k}`, company: `Filler${k}`, notes: 'x'.repeat(200) })),
  ]);
  app = express();
  app.use(express.json({ limit: '32mb' }));
  app.use('/api', createApi({ store: t.store, repo: Repo.forStore(t.store.root) }));
});
afterEach(() => {
  SaveLock.WAIT_MS = 5_000;
  SaveLock.STALE_MS = 10_000;
  t.cleanup();
});

describe('two processes writing one save', () => {
  it('loses none of the rows the other process files while the server saves a row in a loop', async () => {
    const N = 50;
    const cli = other(t.store.root, 'apps', N);
    let lastAcked = -1;
    for (let i = 0; cli.running(); i++) {
      const r = await request(app)
        .patch('/api/applications/seed')
        .send({ answers: [{ question: 'n', answer: String(i) }] });
      expect(r.status).toBe(200);
      lastAcked = i;
    }
    const { code } = await cli.done;
    expect(code).toBe(0);
    expect(lastAcked).toBeGreaterThan(0);

    const rows = t.read('applications.yaml') as { id: string; answers?: { answer: string }[] }[];
    const ids = new Set(rows.map((r) => r.id));
    const missing = Array.from({ length: N }, (_, i) => `cli-${i}`).filter((id) => !ids.has(id));
    expect(missing).toEqual([]);
    // And the server's own last answered save is what the file says.
    expect(rows.find((r) => r.id === 'seed')?.answers?.[0]?.answer).toBe(String(lastAcked));
    expect(rows.filter((r) => r.id.startsWith('filler-'))).toHaveLength(40);
  });

  it('loses none of the settings either process changes', async () => {
    const N = 50;
    const cli = other(t.store.root, 'config', N);
    let lastAcked = -1;
    for (let i = 0; cli.running(); i++) {
      const r = await request(app).put('/api/config').send({ ai: { timeoutMs: 100_000 + i } });
      expect(r.status).toBe(200);
      lastAcked = 100_000 + i;
    }
    const { code, result } = await cli.done;
    expect(code).toBe(0);
    expect(result.lost).toBe(0);
    const config = t.read('config.yaml') as { ai: { model?: string; timeoutMs?: number } };
    expect(config.ai.model).toBe(`m${N - 1}`);
    expect(config.ai.timeoutMs).toBe(lastAcked);
  });

  it('keeps the other process out while this one holds the lock, and lets it in after', async () => {
    let waited: { took: boolean; waited: number } | undefined;
    await holdSave(t.store.root, async () => {
      const cli = other(t.store.root, 'take', 300);
      waited = (await cli.done).result as typeof waited;
    });
    expect(waited?.took).toBe(false);
    expect(waited?.waited).toBeGreaterThanOrEqual(300);

    const again = await other(t.store.root, 'take', 300).done;
    expect(again.result.took).toBe(true);
  });

  it('waits for the other process, and then writes onto what it wrote', async () => {
    const holder = other(t.store.root, 'hold', 400);
    const { lock } = SaveLock.where(t.store.root);
    while (!fs.existsSync(lock)) {
      if (!holder.running()) throw new Error('the other process never took the lock');
      await new Promise((r) => setTimeout(r, 5));
    }
    const started = Date.now();
    t.store.upsertApplication({ ...SEED, id: 'mine', company: 'Mine' } as never);
    expect(Date.now() - started).toBeGreaterThan(100);
    await holder.done;
    expect((t.read('applications.yaml') as { id: string }[]).some((r) => r.id === 'mine')).toBe(true);
  });
});

describe('the lock', () => {
  it('takes over a lock whose holder has died, at once', async () => {
    // A pid that was real a moment ago and is not any more.
    const gone = spawn(process.execPath, ['-e', '0']);
    await new Promise((r) => gone.on('exit', r));
    const { lock } = SaveLock.where(t.store.root);
    fs.writeFileSync(lock, `${gone.pid} ${(await import('node:os')).hostname()} ${new Date().toISOString()} rmm apply\n`);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const started = Date.now();
    holdSaveSync(t.store.root, () => {
      expect(fs.readFileSync(lock, 'utf8')).toContain(`${process.pid} `);
    });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(fs.existsSync(lock)).toBe(false);
    expect(warn.mock.calls.flat().join(' ')).toContain('no longer running');
    warn.mockRestore();
  });

  it('takes over a lock nobody has touched in STALE_MS, whoever holds it', () => {
    const { lock } = SaveLock.where(t.store.root);
    // Held by this very test runner's parent, which is alive — but the lock is old.
    fs.writeFileSync(lock, `${process.ppid} ${'some-host'} 2026-01-01T00:00:00.000Z rmm serve\n`);
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, old, old);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let ran = false;
    holdSaveSync(t.store.root, () => (ran = true));
    expect(ran).toBe(true);
    warn.mockRestore();
  });

  it('says who holds it, rather than writing, when a live holder keeps it past WAIT_MS', () => {
    const { lock } = SaveLock.where(t.store.root);
    fs.writeFileSync(lock, `${process.ppid} ${'another-machine'} ${new Date().toISOString()} rmm serve\n`);
    SaveLock.WAIT_MS = 200;
    const before = fs.readFileSync(path.join(t.store.root, 'applications.yaml'), 'utf8');
    let thrown: unknown;
    try {
      t.store.upsertApplication({ ...SEED, id: 'blocked' } as never);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(SaveBusyError);
    expect(String((thrown as Error).message)).toContain(`process ${process.ppid} on another-machine`);
    expect(fs.readFileSync(path.join(t.store.root, 'applications.yaml'), 'utf8')).toBe(before);
    fs.rmSync(lock);
  });

  it('is re-entrant within a process, synchronously and across an await', async () => {
    const order: string[] = [];
    holdSaveSync(t.store.root, () => {
      holdSaveSync(t.store.root, () => {
        // A store write that nests three more holds of its own.
        t.store.upsertApplication({ ...SEED, id: 'nested' } as never);
        order.push('inner');
      });
      order.push('outer');
      expect(SaveLock.held(t.store.root)).toBe(true);
    });
    expect(SaveLock.held(t.store.root)).toBe(false);

    await holdSave(t.store.root, async () => {
      await new Promise((r) => setTimeout(r, 5));
      t.store.saveConfig({ ai: { timeoutMs: 1234 } as never });
      await holdSave(t.store.root, async () => order.push('async inner'));
      order.push('async outer');
    });
    expect(order).toEqual(['inner', 'outer', 'async inner', 'async outer']);
    expect(SaveLock.held(t.store.root)).toBe(false);
    expect(fs.existsSync(SaveLock.where(t.store.root).lock)).toBe(false);
  });

  it('lives in .git once the save is a repository, and nothing of it is left behind', async () => {
    expect(SaveLock.where(t.store.root).lock).toBe(path.join(t.store.root, '.rmm-write-lock.tmp'));
    await Repo.forStore(t.store.root).ensure();
    expect(SaveLock.where(t.store.root).lock).toBe(path.join(t.store.root, '.git', 'rmm-write.lock'));
    t.store.saveAnswers(t.store.loadAnswers());
    expect(fs.readdirSync(path.join(t.store.root, '.git')).filter((f) => f.startsWith('rmm-write'))).toEqual([]);
  });
});

describe('a write made onto a file another process changed since it was read', () => {
  it('keeps their rows and their edits, and makes this one', () => {
    const base = [{ id: 'a', v: 1 }, { id: 'b', v: 1 }, { id: 'gone', v: 1 }];
    const mine = [{ id: 'a', v: 2 }, { id: 'b', v: 1 }, { id: 'gone', v: 1 }, { id: 'new-here', v: 1 }];
    const theirs = [{ id: 'a', v: 1 }, { id: 'b', v: 3 }, { id: 'new-there', v: 1 }];
    expect(mergeById(base, mine, theirs, (r) => r.id)).toEqual([
      { id: 'a', v: 2 },
      { id: 'b', v: 3 },
      { id: 'new-there', v: 1 },
      { id: 'new-here', v: 1 },
    ]);
    // A row removed here stays removed; a row with no id gives up merging.
    expect(mergeById(base, [{ id: 'a', v: 1 }], base, (r) => r.id)).toEqual([{ id: 'a', v: 1 }]);
    expect(mergeById(base, [{ v: 1 } as never], theirs, (r: { id?: string }) => r.id)).toBeUndefined();
  });

  it('applies a server save to the tracker as the other process left it', () => {
    const store = t.store;
    const apps = store.load().applications;
    // The other process files a row after this one read the tracker.
    const outside = new Store(store.root);
    outside.upsertApplication({ ...SEED, id: 'theirs', company: 'Theirs' } as never);
    store.saveApplications(apps.map((a) => (a.id === 'seed' ? { ...a, company: 'Renamed' } : a)));
    const rows = t.read('applications.yaml') as { id: string; company: string }[];
    expect(rows.find((r) => r.id === 'theirs')?.company).toBe('Theirs');
    expect(rows.find((r) => r.id === 'seed')?.company).toBe('Renamed');
  });
});

/*
 * F4. The read cache was keyed on size and modification time. On a file
 * system whose clock ticks in seconds, a same-size change within the tick
 * left both alone: the server went on handing back the parse from before, and
 * the next whole-file write put it back on disk.
 */
describe('a same-size change within one tick of the clock', () => {
  // A clock that counts whole seconds, as HFS+, FAT and many SMB shares do.
  const tick = new Date(Math.floor(Date.now() / 1000) * 1000);
  const sameSizeChange = (file: string, from: string, to: string, inPlace: boolean) => {
    const stat = fs.statSync(file);
    const text = fs.readFileSync(file, 'utf8');
    const next = text.replace(from, to);
    expect(next.length).toBe(text.length);
    if (inPlace) fs.writeFileSync(file, next);
    else {
      fs.writeFileSync(`${file}.x`, next);
      fs.renameSync(`${file}.x`, file);
    }
    // The clock did not move: the modification time is put back as it was.
    fs.utimesSync(file, tick, tick);
    expect(fs.statSync(file).mtimeMs).toBe(stat.mtimeMs);
    expect(fs.statSync(file).size).toBe(stat.size);
  };

  for (const inPlace of [false, true]) {
    it(`is read again, not served from the cache (${inPlace ? 'written in place' : 'renamed into place'})`, async () => {
      const file = path.join(t.store.root, 'applications.yaml');
      await request(app).patch('/api/applications/filler-1').send({ company: 'AAAAAAA1' });
      fs.utimesSync(file, tick, tick);
      expect((await request(app).get('/api/store')).body.applications.find((a: { id: string }) => a.id === 'filler-1').company).toBe('AAAAAAA1');

      sameSizeChange(file, 'company: AAAAAAA1', 'company: BBBBBBB1', inPlace);

      const said = (await request(app).get('/api/store')).body.applications.find((a: { id: string }) => a.id === 'filler-1');
      expect(said.company).toBe('BBBBBBB1');
      // And an unrelated write by the server does not put the old one back.
      await request(app).patch('/api/applications/filler-2').send({ company: 'Other2' });
      expect(fs.readFileSync(file, 'utf8')).toContain('company: BBBBBBB1');
    });
  }

  it('is forgotten wholesale when a git outside this process moves the save', async () => {
    await Repo.forStore(t.store.root).ensure();
    const store = t.store;
    expect(store.forgetReadsIfGitMoved()).toBe(false); // the first look only notes where things are
    store.load();
    expect(store.forgetReadsIfGitMoved()).toBe(false);
    // A pull, a merge or a reset in a terminal writes ORIG_HEAD.
    const head = (await run('git', ['-C', store.root, 'rev-parse', 'HEAD'])).stdout.trim();
    fs.writeFileSync(path.join(store.root, '.git', 'ORIG_HEAD'), `${head}\n`);
    expect(store.forgetReadsIfGitMoved()).toBe(true);
    expect(store.forgetReadsIfGitMoved()).toBe(false);
  });
});

/*
 * F2. A commit is the other half of a write, and the two processes' commits
 * collided.
 */
describe('committing beside another process', () => {
  it('takes a commit that somebody else made of the same files as already made, not as a failure', async () => {
    const repo = Repo.forStore(t.store.root);
    await repo.ensure();
    t.store.upsertApplication({ ...SEED, id: 'swept' } as never);
    /*
     * The other process's commit, landing between this one's look at what is
     * staged and its `git commit`: the files this commit was for are in a
     * commit already, and git says there is nothing to commit.
     */
    const git = (repo as unknown as { git: (args: string[], env?: NodeJS.ProcessEnv) => Promise<string> }).git.bind(repo);
    const spy = vi.spyOn(repo as unknown as { git: typeof git }, 'git').mockImplementation(async (args, env) => {
      if (args.includes('commit') && args.includes('Apply: Swept — Dev')) {
        await git(['-c', 'user.name=other', '-c', 'user.email=o@o', 'commit', '-q', '-m', 'Set the answers on application "seed"']);
      }
      return git(args, env);
    });
    await expect(repo.commitAll('Apply: Swept — Dev')).resolves.toBeUndefined();
    spy.mockRestore();
    const log = (await run('git', ['-C', t.store.root, 'log', '--format=%s'])).stdout;
    expect(log).toContain('Set the answers on application "seed"');
  });

  it('has the CLI warn, and exit 0, when its commit fails after the write', async () => {
    const save = t.store.root;
    t.write('config.yaml', { ai: { enabled: false }, git: { autoCommit: true }, output: { dir: 'out' } });
    await Repo.forStore(save).ensure();
    // A hook that turns the commit down: the write has happened by then.
    fs.writeFileSync(path.join(save, '.git', 'hooks', 'commit-msg'), '#!/bin/sh\necho "refused by a hook" >&2\nexit 1\n', { mode: 0o755 });
    const letter = path.join(path.dirname(save), 'letter.txt');
    fs.writeFileSync(letter, 'Dear Hiring Manager,\n\nI am writing to apply for the role. I have built things.\n\nSincerely,\nTest Person\n');
    const said = await run(process.execPath, [tsx, path.join(root, 'src/cli.ts'), 'voice', 'add', letter, '--no-ai', '--data', save], {
      cwd: root,
      env: { ...process.env, RMM_AI: '0' },
    }).then(
      (r) => ({ code: 0, ...r }),
      (e: { code: number; stdout: string; stderr: string }) => e,
    );
    expect(said.stderr).toContain('not in the version history yet');
    expect(said.stderr).toContain('rmm save');
    expect(said.code).toBe(0);
    expect(fs.readdirSync(path.join(save, 'corpus')).length).toBeGreaterThan(0);
  });
});

/*
 * Round 24. The lock worked, and the waiting for it did not.
 *
 * The store's synchronous wait is `Atomics.wait` on the main thread. In the
 * server that is the event loop standing still: with `rmm apply` committing
 * through a hook that slept seven seconds, every GET waited five, and the
 * PATCH that was waiting then failed — with a sentence ending "remove
 * …/rmm-write.lock", about a lock whose holder was alive and busy. Now
 * `withCommit` takes the lock asynchronously, around the write and the
 * commit, and waits longer than a synchronous write does; the sentence says
 * who is writing and to wait when the holder is alive on this machine. And
 * a waiter's file is refreshed while it waits and judged by that, so one
 * left by a killed waiter whose pid lives on does not keep every writer out
 * for `STALE_MS` with no lock anywhere.
 */
describe('a slow commit in the other process', () => {
  it('keeps the server answering while a request waits for the lock, and the request then lands', async () => {
    SaveLock.WAIT_MS = 300; // A synchronous write would give up here; `withCommit` waits on.
    const holder = other(t.store.root, 'hold', 1500);
    const { lock } = SaveLock.where(t.store.root);
    while (!fs.existsSync(lock)) {
      if (!holder.running()) throw new Error('the other process never took the lock');
      await new Promise((r) => setTimeout(r, 5));
    }
    const started = Date.now();
    const patch = request(app)
      .patch('/api/applications/seed')
      .send({ answers: [{ question: 'n', answer: 'waited' }] });
    const patchDone = patch.then((r) => ({ status: r.status, after: Date.now() - started }));
    // Reads while the write waits: with the thread blocked, these took as long as the hold.
    await new Promise((r) => setTimeout(r, 100));
    const reads: number[] = [];
    for (let i = 0; i < 3; i++) {
      const t0 = Date.now();
      const r = await request(app).get('/api/applications');
      expect(r.status).toBe(200);
      reads.push(Date.now() - t0);
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(Math.max(...reads)).toBeLessThan(500);
    const landed = await patchDone;
    expect(landed.status).toBe(200);
    expect(landed.after).toBeGreaterThan(1000);
    await holder.done;
    expect((t.read('applications.yaml') as { id: string; answers?: { answer: string }[] }[]).find((r) => r.id === 'seed')?.answers?.[0]?.answer).toBe('waited');
  });

  it('says who is writing, and to wait, when the holder is alive on this machine', () => {
    const { lock } = SaveLock.where(t.store.root);
    fs.writeFileSync(lock, `${process.ppid} ${os.hostname()} ${new Date().toISOString()} rmm serve --port 4788\n`);
    SaveLock.WAIT_MS = 200;
    let thrown: Error | undefined;
    try {
      t.store.upsertApplication({ ...SEED, id: 'blocked' } as never);
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown).toBeInstanceOf(SaveBusyError);
    expect(thrown!.message).toContain(`pid ${process.ppid}`);
    expect(thrown!.message).toContain('`rmm serve --port 4788`');
    expect(thrown!.message).toMatch(/wait a moment/i);
    expect(thrown!.message).not.toContain('remove');
    fs.rmSync(lock);
  });
});

describe("a waiter's file", () => {
  const wantFile = (pid: number) => {
    const at = SaveLock.where(t.store.root);
    return path.join(at.dir, `${at.wantPrefix}${pid}${at.wantSuffix}`);
  };

  it('is refreshed while its process waits', async () => {
    const holder = other(t.store.root, 'hold', 1500);
    const { lock } = SaveLock.where(t.store.root);
    while (!fs.existsSync(lock)) {
      if (!holder.running()) throw new Error('the other process never took the lock');
      await new Promise((r) => setTimeout(r, 5));
    }
    const waiting = holdSave(t.store.root, async () => undefined);
    await new Promise((r) => setTimeout(r, 300));
    const first = fs.statSync(wantFile(process.pid)).mtimeMs;
    await new Promise((r) => setTimeout(r, 600));
    const later = fs.statSync(wantFile(process.pid)).mtimeMs;
    expect(later).toBeGreaterThan(first);
    await waiting;
    await holder.done;
    expect(fs.existsSync(wantFile(process.pid))).toBe(false);
  });

  it('whose process is alive but which nobody refreshes is out of the way once its wait would be over, and named until then', () => {
    // Left by a waiter killed mid-wait, whose pid has since gone to a program that lives on.
    const stale = wantFile(process.ppid);
    fs.writeFileSync(stale, `${process.ppid} ${os.hostname()} ${Date.now()}\n`);
    const then = new Date(Date.now() - SaveLock.WANT_STALE_MS - 500);
    fs.utimesSync(stale, then, then);
    const started = Date.now();
    t.store.upsertApplication({ ...SEED, id: 'through' } as never);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(fs.existsSync(stale)).toBe(false);

    // One still fresh keeps its place in line — and with no lock to name, the sentence names it.
    fs.writeFileSync(stale, `${process.ppid} ${os.hostname()} ${Date.now()}\n`);
    SaveLock.WAIT_MS = 200;
    let thrown: Error | undefined;
    try {
      t.store.upsertApplication({ ...SEED, id: 'behind' } as never);
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown).toBeInstanceOf(SaveBusyError);
    expect(thrown!.message).toContain(stale);
    expect(thrown!.message).not.toContain(SaveLock.where(t.store.root).lock);
    fs.rmSync(stale);
  });

  it('and a lock moved aside by a process that died are swept once they are old', () => {
    const { lock } = SaveLock.where(t.store.root);
    const old = `${lock}.99999.abc.stale`;
    const fresh = `${lock}.99998.def.stale`;
    fs.writeFileSync(old, 'x');
    fs.writeFileSync(fresh, 'x');
    const then = new Date(Date.now() - SaveLock.STALE_MS - 1_000);
    fs.utimesSync(old, then, then);
    t.store.upsertApplication({ ...SEED, id: 'sweeping' } as never);
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
    fs.rmSync(fresh);
  });
});

describe('writing without the lock', () => {
  it('says so, once, when the lock cannot be created for a reason other than another holder', () => {
    /*
     * A `.git` file pointing into a file: the lock's folder can neither be
     * found nor made. The ordinary case is a read-only `.git`, which a test
     * run as root cannot set up.
     */
    fs.writeFileSync(path.join(t.store.root, 'blocker'), '');
    fs.writeFileSync(path.join(t.store.root, '.git'), 'gitdir: ./blocker/git\n');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    t.store.upsertApplication({ ...SEED, id: 'unlocked-1' } as never);
    t.store.upsertApplication({ ...SEED, id: 'unlocked-2' } as never);
    const said = warn.mock.calls.flat().filter((line) => String(line).includes('write lock'));
    warn.mockRestore();
    expect(said).toHaveLength(1);
    expect(String(said[0])).toContain('writing without it');
    const ids = (t.read('applications.yaml') as { id: string }[]).map((r) => r.id);
    expect(ids).toContain('unlocked-1');
    expect(ids).toContain('unlocked-2');
    fs.rmSync(path.join(t.store.root, '.git'));
  });

  it('`rmm config set` says the history did not get it the way `apply` does, and exits 0', async () => {
    const save = t.store.root;
    t.write('config.yaml', { ai: { enabled: false }, git: { autoCommit: true }, output: { dir: 'out' } });
    await Repo.forStore(save).ensure();
    fs.writeFileSync(path.join(save, '.git', 'hooks', 'commit-msg'), '#!/bin/sh\necho "refused by a hook" >&2\nexit 1\n', { mode: 0o755 });
    const said = await run(process.execPath, [tsx, path.join(root, 'src/cli.ts'), 'config', 'set', 'ai.enabled', 'true', '--data', save], {
      cwd: root,
      env: { ...process.env, RMM_AI: '0' },
    }).then(
      (r) => ({ code: 0, ...r }),
      (e: { code: number; stdout: string; stderr: string }) => e,
    );
    expect(said.code).toBe(0);
    expect(said.stderr).toContain('not in the version history yet');
    expect(said.stderr).toContain('rmm save');
    expect((t.read('config.yaml') as { ai: { enabled: boolean } }).ai.enabled).toBe(true);
  });
});
