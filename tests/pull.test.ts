/**
 * The app's own Pull, measured against real git: a bare remote, and two
 * clones of it standing for two machines.
 *
 * Before it, a second machine caught up with `git pull` in a terminal while
 * the server ran, and the server's writes and auto-commits could land in the
 * middle of that merge. The guards against a terminal pull (see
 * git-sync.test.ts) narrowed the window to milliseconds and still lost a
 * tracker row or two per run. Pulling inside the server's own commit queue,
 * with writes held off, closes it — and these are the ways it could go wrong.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import YAML from 'yaml';
import { Repo, cloneRepo, withCommit } from '../src/git/repo.js';
import { cloneProject } from '../src/model/projects.js';
import { saveStore } from '../src/git/save.js';
import { Store, aiSwitchedOff } from '../src/model/store.js';
import { createApi } from '../src/server/api.js';
import { makeTempStore, tempDir, type TempStore } from './helpers.js';

const git = (args: string[], cwd: string) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
const commitAs = (cwd: string, message: string) =>
  git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', message], cwd);
const head = (cwd: string) => git(['rev-parse', 'HEAD'], cwd).trim();
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

interface Row {
  id: string;
  company: string;
  role: string;
  status: string;
}
const rows = (dir: string): Row[] => YAML.parse(fs.readFileSync(path.join(dir, 'applications.yaml'), 'utf8')) ?? [];

/** Three applications, so an edit to the first and an addition after the last are apart enough for git to merge. */
const SEED: Row[] = [
  { id: '2026-10-01-zeta-dev', company: 'Zeta', role: 'Dev', status: 'applied' },
  { id: '2026-10-02-acme-sre', company: 'Acme', role: 'SRE', status: 'applied' },
  { id: '2026-10-03-lyra-data', company: 'Lyra', role: 'Data', status: 'applied' },
];

let t: TempStore;
let remote: string;
/** Machine A: the one that pushes. */
let a: string;
let repoA: Repo;
/** Machine B: the one that pulls, through the app. */
let b: string;
let storeB: Store;
let repoB: Repo;
let app: express.Express;

beforeEach(async () => {
  t = makeTempStore({ config: { ai: { enabled: false }, git: { autoCommit: true }, output: { dir: 'out' } } });
  t.write('applications.yaml', SEED);
  a = t.dir;
  repoA = Repo.forStore(a);
  await repoA.ensure();
  const base = tempDir('rmm-pull-');
  remote = path.join(base, 'remote.git');
  git(['init', '-q', '--bare', remote], base);
  await repoA.setRemote(remote);
  expect((await repoA.push()).ok).toBe(true);

  b = path.join(base, 'B');
  git(['clone', '-q', remote, b], base);
  storeB = new Store(b);
  repoB = Repo.forStore(b);
  app = express();
  app.use(express.json());
  app.use('/api', createApi({ store: storeB, repo: repoB }));
});
afterEach(() => t.cleanup());

/** A changes the first application's status and pushes it. */
async function aMarksZetaInterview(): Promise<void> {
  const changed = rows(a);
  changed[0]!.status = 'interview';
  fs.writeFileSync(path.join(a, 'applications.yaml'), YAML.stringify(changed, { lineWidth: 0 }));
  await repoA.commitAll('A: Zeta is an interview');
  expect((await repoA.push()).ok).toBe(true);
}

describe('pulling', () => {
  it('fast-forwards, and says what came in', async () => {
    await aMarksZetaInterview();
    fs.writeFileSync(path.join(a, 'voice.md'), 'from A\n');
    await repoA.commitAll('A: voice');
    expect((await repoA.push()).ok).toBe(true);

    const res = await request(app).post('/api/config/store/pull').expect(200);

    expect(res.body.ok).toBe(true);
    expect(res.body.pulled).toBe(2);
    expect(res.body.files.sort()).toEqual(['applications.yaml', 'voice.md']);
    expect(res.body.conflict).toBeUndefined();
    expect(res.body.message).toMatch(/Pulled 2 commits/);
    expect(head(b)).toBe(head(a));
    expect(res.body.remote.behind).toBe(0);
  });

  it('merges when both machines have moved, keeping both', async () => {
    await aMarksZetaInterview();
    // B adds one after the last, through the app.
    const added = await request(app).post('/api/applications').send({ company: 'Nova', role: 'Platform' }).expect(200);

    const res = await request(app).post('/api/config/store/pull').expect(200);

    expect(res.body.ok).toBe(true);
    expect(res.body.pulled).toBe(1);
    expect(res.body.files).toEqual(['applications.yaml']);
    expect(res.body.message).toMatch(/merged it with the 1 made here.*Push sends the merge back/s);
    const now = rows(b);
    expect(now.find((r) => r.company === 'Zeta')?.status).toBe('interview');
    expect(now.some((r) => r.id === added.body.id)).toBe(true);
    expect(git(['log', '-1', '--format=%P'], b).trim().split(' ')).toHaveLength(2);
    // Named for the tracking branch, never for the address it came from.
    expect(git(['log', '-1', '--format=%s'], b)).toMatch(/^Merge remote-tracking branch 'origin\//);
    expect(git(['status', '--porcelain'], b)).toBe('');
  });

  it('commits what is on disk first, so a hand edit is neither lost nor in the way', async () => {
    await aMarksZetaInterview();
    fs.writeFileSync(path.join(b, 'voice.md'), 'edited by hand on B\n');

    const result = await repoB.pull();

    expect(result.ok).toBe(true);
    expect(fs.readFileSync(path.join(b, 'voice.md'), 'utf8')).toBe('edited by hand on B\n');
    expect(git(['log', '--format=%s', '-3'], b)).toMatch(/Save before pulling/);
    expect(rows(b)[0]!.status).toBe('interview');
  });

  /*
   * The default on a conflict is not to merge. A save left with the markers
   * in it cannot even be read by the app (see `parseStoreYaml`), and the next
   * auto-commit would have taken them as a finished merge.
   */
  it('stops at a conflict without merging, leaves the save exactly as it was, and names the files', async () => {
    await aMarksZetaInterview();
    const mine = rows(b);
    mine[0]!.status = 'rejected';
    fs.writeFileSync(path.join(b, 'applications.yaml'), YAML.stringify(mine, { lineWidth: 0 }));
    commitAs(b, 'B: Zeta rejected');
    const before = head(b);
    const text = fs.readFileSync(path.join(b, 'applications.yaml'), 'utf8');

    const res = await request(app).post('/api/config/store/pull').expect(200);

    expect(res.body.ok).toBe(false);
    expect(res.body.pulled).toBe(0);
    expect(res.body.conflict).toEqual(['applications.yaml']);
    expect(res.body.message).toMatch(/applications\.yaml.*Nothing was merged.*exactly as it was.*git pull.*git commit/s);
    // Worked out without a merge at all, so not even for a moment did the
    // files hold conflict markers for a read to trip over.
    expect(fs.existsSync(path.join(b, '.git', 'ORIG_HEAD'))).toBe(false);
    expect(head(b)).toBe(before);
    expect(fs.existsSync(path.join(b, '.git', 'MERGE_HEAD'))).toBe(false);
    expect(fs.readFileSync(path.join(b, 'applications.yaml'), 'utf8')).toBe(text);
    expect(git(['status', '--porcelain'], b)).toBe('');
    // And the app goes on working: a write is not refused as mid-merge.
    await request(app).post('/api/applications').send({ company: 'After', role: 'Conflict' }).expect(200);
  });

  it('merges and undoes it, with a git too old to work the merge out first', async () => {
    await aMarksZetaInterview();
    const mine = rows(b);
    mine[0]!.status = 'rejected';
    fs.writeFileSync(path.join(b, 'applications.yaml'), YAML.stringify(mine, { lineWidth: 0 }));
    commitAs(b, 'B: Zeta rejected');
    const before = head(b);
    const text = fs.readFileSync(path.join(b, 'applications.yaml'), 'utf8');
    const was = Repo.mergeTreeWorks;
    Repo.mergeTreeWorks = false;
    try {
      const result = await repoB.pull();
      expect(result.ok).toBe(false);
      expect(result.conflict).toEqual(['applications.yaml']);
      expect(result.message).toMatch(/The merge was undone, so the save is exactly as it was/);
    } finally {
      Repo.mergeTreeWorks = was;
    }
    expect(head(b)).toBe(before);
    expect(fs.existsSync(path.join(b, '.git', 'MERGE_HEAD'))).toBe(false);
    expect(fs.readFileSync(path.join(b, 'applications.yaml'), 'utf8')).toBe(text);
    expect(git(['status', '--porcelain'], b)).toBe('');
    // Its own merge's ORIG_HEAD is not somebody else's pull starting.
    expect(repoB.outsideGit()).toBeUndefined();
  });

  it('says there is nowhere to pull from, with no remote', async () => {
    git(['remote', 'remove', 'origin'], b);
    const res = await request(app).post('/api/config/store/pull').expect(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.message).toMatch(/No remote is configured/);
  });

  it('says the remote has nothing to pull yet, rather than failing', async () => {
    const empty = path.join(path.dirname(remote), 'empty.git');
    git(['init', '-q', '--bare', empty], path.dirname(remote));
    git(['remote', 'set-url', 'origin', empty], b);
    const result = await repoB.pull();
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/has no branch called .* yet.*Push sends this save there/);
  });

  it('is up to date when there is nothing new', async () => {
    const result = await repoB.pull();
    expect(result).toMatchObject({ ok: true, pulled: 0, files: [] });
    expect(result.message).toMatch(/Already up to date/);
  });

  it('never shows a token from the address, when the remote will not answer', async () => {
    const held: net.Socket[] = [];
    const server = net.createServer((socket) => held.push(socket));
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const port = (server.address() as net.AddressInfo).port;
    try {
      await repoB.setRemote(`http://alice:ghp_TOKEN123@127.0.0.1:${port}/me/save.git`);
      const before = head(b);
      const started = Date.now();
      const result = await repoB.pull(1500);
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/took longer than 2 seconds.*Nothing in the save was changed/s);
      expect(result.message).toContain('alice:•••@');
      expect(JSON.stringify(result)).not.toContain('ghp_TOKEN123');
      expect(head(b)).toBe(before);
    } finally {
      for (const socket of held) socket.destroy();
      server.close();
    }

    // And refused outright, through the API, still without it.
    await repoB.setRemote(`http://alice:ghp_TOKEN123@127.0.0.1:9/me/save.git`);
    const res = await request(app).post('/api/config/store/pull').expect(200);
    expect(res.body.ok).toBe(false);
    expect(JSON.stringify(res.body)).not.toContain('ghp_TOKEN123');
  }, 20_000);

  it('does not hold the next write afterwards, taking its own merge for somebody else’s pull', async () => {
    await aMarksZetaInterview();
    expect((await repoB.pull()).ok).toBe(true);
    expect(repoB.outsideGit()).toBeUndefined();
    const started = Date.now();
    await withCommit(repoB, true, 'right after', () => fs.writeFileSync(path.join(b, 'kept.txt'), 'kept'));
    expect(Date.now() - started).toBeLessThan(500);
    expect(repoB.lastCommitError).toBeUndefined();
  });

  it('is part of rmm save --pull, before the push', async () => {
    await aMarksZetaInterview();
    fs.writeFileSync(path.join(b, 'voice.md'), 'from B\n');
    const result = await saveStore(repoB, { pull: true, push: true });
    expect(result.saved).toBe(true);
    expect(result.pulled?.ok).toBe(true);
    expect(result.pushed?.ok).toBe(true);
    expect(git(['rev-parse', 'HEAD'], remote).trim()).toBe(head(b));
  });
});

describe('writes while a pull is merging', () => {
  /*
   * A write that passed its check just before the pull began, and has an
   * `await` before it lands — as `/api/apply` typesets between the two.
   * Without the pull waiting for it, the merge ran under it and the write,
   * made from what it had read before, put A's change back the way it was.
   */
  it('waits for a write already under way, so neither it nor the pulled change is lost', async () => {
    await aMarksZetaInterview();
    const writing = withCommit(repoB, true, 'Track application to Nova', async () => {
      const seen = rows(b);
      await sleep(400);
      seen.push({ id: '2026-10-04-nova-platform', company: 'Nova', role: 'Platform', status: 'applied' });
      fs.writeFileSync(path.join(b, 'applications.yaml'), YAML.stringify(seen, { lineWidth: 0 }));
    });
    await sleep(30);

    const result = await repoB.pull();
    await writing;

    expect(result.ok).toBe(true);
    const now = rows(b);
    expect(now.find((r) => r.company === 'Zeta')?.status).toBe('interview');
    expect(now.some((r) => r.company === 'Nova')).toBe(true);
  });

  /*
   * The race the feature is for, through the API: many applications filed
   * while Pull is pressed. A post-merge hook that takes a second keeps the
   * merge open long enough for writes to arrive in the middle of it. Every
   * one the server answered 200 has to be in the file afterwards, and so does
   * what the pull brought in; the ones that came in mid-merge are turned away
   * with a sentence, not taken and lost.
   */
  it('refuses the ones that arrive mid-merge, and loses none it answered 200', async () => {
    await aMarksZetaInterview();
    fs.writeFileSync(path.join(b, '.git', 'hooks', 'post-merge'), '#!/bin/sh\nsleep 1\n', { mode: 0o755 });

    const answers: Promise<{ company: string; status: number; body: { id?: string; error?: string } }>[] = [];
    let pulling = true;
    const pull = request(app)
      .post('/api/config/store/pull')
      .then((r) => {
        pulling = false;
        return r;
      });
    for (let i = 0; pulling && i < 200; i++) {
      const company = `Race${i}`;
      answers.push(
        request(app)
          .post('/api/applications')
          .send({ company, role: 'R' })
          .then((r) => ({ company, status: r.status, body: r.body })),
      );
      await sleep(15);
    }
    const pulled = (await pull).body;
    const results = await Promise.all(answers);

    expect(pulled.ok).toBe(true);
    const ok = results.filter((r) => r.status === 200);
    const refused = results.filter((r) => r.status !== 200);
    expect(refused.length, 'some arrived while the merge was open').toBeGreaterThan(0);
    for (const r of refused) expect(r.body.error).toMatch(/^Not saved: the save is being brought up to date.*once the pull has finished/);
    const now = rows(b);
    for (const r of ok) expect(now.some((row) => row.company === r.company), r.company).toBe(true);
    expect(now.find((r) => r.company === 'Zeta')?.status).toBe('interview');
    // And in the history, once the commits queued behind the pull are made.
    await repoB.commitAll('settle');
    const committed = git(['show', 'HEAD:applications.yaml'], b);
    for (const r of ok) expect(committed).toContain(`company: ${r.company}\n`);
  }, 30_000);
});

describe('what the server holds after a pull', () => {
  /*
   * The store's read cache is keyed on a file's size and time. A pulled
   * file the same size as the one here, given the same time — which a
   * coarse file-system clock does, and which the hook below stands in for —
   * was handed back as the old parse. The pull forgets every parse.
   */
  it('shows what came in at once, even when the file looks unchanged from outside', async () => {
    const warm = await request(app).get('/api/store').expect(200);
    expect(warm.body.applications[0].company).toBe('Zeta');

    const changed = rows(a);
    changed[0]!.company = 'Yeta'; // Same length: same size on disk.
    fs.writeFileSync(path.join(a, 'applications.yaml'), YAML.stringify(changed, { lineWidth: 0 }));
    await repoA.commitAll('A: rename');
    expect((await repoA.push()).ok).toBe(true);

    // `cp -p`, which keeps the time to the nanosecond, as `touch -r` copies it.
    const reference = path.join(path.dirname(b), 'as-it-was');
    execFileSync('cp', ['-p', path.join(b, 'applications.yaml'), reference]);
    const was = fs.statSync(path.join(b, 'applications.yaml'));
    fs.writeFileSync(
      path.join(b, '.git', 'hooks', 'post-merge'),
      `#!/bin/sh\ntouch -r '${reference}' applications.yaml\n`,
      { mode: 0o755 },
    );

    expect((await request(app).post('/api/config/store/pull').expect(200)).body.ok).toBe(true);
    expect(fs.statSync(path.join(b, 'applications.yaml')).mtimeMs).toBe(was.mtimeMs);

    const after = await request(app).get('/api/store').expect(200);
    expect(after.body.applications[0].company).toBe('Yeta');
  });

  it('runs the housekeeping a save gets when it is opened, after something came in', async () => {
    let ran = 0;
    const withHousekeeping = express();
    withHousekeeping.use(express.json());
    withHousekeeping.use('/api', createApi({ store: storeB, repo: repoB, afterPull: async () => void ran++ }));

    await request(withHousekeeping).post('/api/config/store/pull').expect(200);
    expect(ran, 'nothing came in').toBe(0);
    await aMarksZetaInterview();
    await request(withHousekeeping).post('/api/config/store/pull').expect(200);
    expect(ran).toBe(1);
  });
});

describe('rmm pull', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const rmm = (args: string[]) =>
    promisify(execFile)(process.execPath, ['node_modules/.bin/tsx', 'src/cli.ts', ...args], {
      cwd: root,
      env: { ...process.env, HOME: tempDir('rmm-pull-home-') },
      timeout: 60_000,
    }).then(
      (r) => ({ code: 0, stdout: r.stdout, stderr: r.stderr }),
      (e: { code?: number; stdout?: string; stderr?: string }) => ({ code: e.code ?? -1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }),
    );

  it('exits 0 having pulled, and 1 on a conflict or with no remote', async () => {
    await aMarksZetaInterview();
    const pulled = await rmm(['pull', '--data', b]);
    expect(pulled.code).toBe(0);
    expect(pulled.stdout).toMatch(/Pulled 1 commit/);
    expect(rows(b)[0]!.status).toBe('interview');

    // Both sides change the same line.
    const mine = rows(b);
    mine[0]!.status = 'rejected';
    fs.writeFileSync(path.join(b, 'applications.yaml'), YAML.stringify(mine, { lineWidth: 0 }));
    commitAs(b, 'B: rejected');
    const theirs = rows(a);
    theirs[0]!.status = 'offer';
    fs.writeFileSync(path.join(a, 'applications.yaml'), YAML.stringify(theirs, { lineWidth: 0 }));
    await repoA.commitAll('A: offer');
    expect((await repoA.push()).ok).toBe(true);

    const conflict = await rmm(['pull', '--data', b]);
    expect(conflict.code).toBe(1);
    expect(conflict.stderr).toMatch(/conflict: applications\.yaml/);
    expect(rows(b)[0]!.status).toBe('rejected');

    const saved = await rmm(['save', '--pull', '--data', b]);
    expect(saved.code).toBe(1);
    expect(saved.stderr).toMatch(/Pull failed/);

    git(['remote', 'remove', 'origin'], b);
    const nowhere = await rmm(['pull', '--data', b]);
    expect(nowhere.code).toBe(1);
    expect(nowhere.stderr).toMatch(/No remote is configured/);
  }, 120_000);
});

/*
 * What a pull brings in is looked at before the save has it: a merge git
 * calls clean can still leave a file the save will not read, a remote can
 * plant a link out of the save, and config.yaml names the program the AI
 * actions run.
 */
describe('what a pull would bring in, looked at first', () => {
  const profileText = () => fs.readFileSync(path.join(b, 'profile.yaml'), 'utf8');
  /** The same key, added on each machine in a place apart enough for git to merge them. */
  async function bothAddWebsite(): Promise<void> {
    fs.writeFileSync(path.join(a, 'profile.yaml'), `website: a.example\n${fs.readFileSync(path.join(a, 'profile.yaml'), 'utf8')}`);
    await repoA.commitAll('A: website');
    expect((await repoA.push()).ok).toBe(true);
    fs.writeFileSync(path.join(b, 'profile.yaml'), `${profileText()}website: b.example\n`);
    commitAs(b, 'B: website');
  }

  it('refuses a clean merge that would leave a file the save cannot read, and changes nothing', async () => {
    await bothAddWebsite();
    const before = head(b);
    const text = profileText();

    const res = await request(app).post('/api/config/store/pull').expect(200);

    expect(res.body.ok).toBe(false);
    expect(res.body.pulled).toBe(0);
    expect(res.body.unreadable).toEqual(['profile.yaml']);
    expect(res.body.message).toMatch(/profile\.yaml unreadable.*not valid YAML.*Nothing was merged.*exactly as it was/s);
    expect(head(b)).toBe(before);
    expect(profileText()).toBe(text);
    expect(git(['status', '--porcelain'], b)).toBe('');
    expect(fs.existsSync(path.join(b, '.git', 'ORIG_HEAD'))).toBe(false);
    // The save still opens.
    await request(app).get('/api/store').expect(200);
  });

  it('refuses it and puts the save back, with a git too old to work the merge out first', async () => {
    await bothAddWebsite();
    const before = head(b);
    const text = profileText();
    const was = Repo.mergeTreeWorks;
    Repo.mergeTreeWorks = false;
    try {
      const result = await repoB.pull();
      expect(result.ok).toBe(false);
      expect(result.unreadable).toEqual(['profile.yaml']);
    } finally {
      Repo.mergeTreeWorks = was;
    }
    expect(head(b)).toBe(before);
    expect(profileText()).toBe(text);
    expect(git(['status', '--porcelain'], b)).toBe('');
  });

  it('refuses a fast-forward to a file that will not parse', async () => {
    fs.writeFileSync(path.join(a, 'skills.yaml'), 'id: not-a-list\n');
    await repoA.commitAll('A: break skills');
    expect((await repoA.push()).ok).toBe(true);
    const before = head(b);

    const result = await repoB.pull();

    expect(result.ok).toBe(false);
    expect(result.unreadable).toEqual(['skills.yaml']);
    expect(result.message).toMatch(/skills\.yaml should be a list/);
    expect(head(b)).toBe(before);
  });

  it('says the pull is not ok when the save will not open after it', async () => {
    await aMarksZetaInterview();
    const failing = express();
    failing.use(express.json());
    failing.use('/api', createApi({ store: storeB, repo: repoB, afterPull: async () => { throw new Error('migration broke'); } }));

    const res = await request(failing).post('/api/config/store/pull').expect(200);

    expect(res.body.ok).toBe(false);
    expect(res.body.pulled).toBe(1);
    expect(res.body.message).toMatch(/Pulled 1 commit.*will not open as it now is: migration broke/s);
  });

  it('merges the branch, not a tag that happens to be called origin/<branch>', async () => {
    const old = head(b);
    await aMarksZetaInterview();
    git(['tag', 'origin/main', old], b);
    git(['tag', 'origin/master', old], b);

    const result = await repoB.pull();

    expect(result.ok).toBe(true);
    expect(head(b)).toBe(head(a));
    expect(rows(b)[0]!.status).toBe('interview');
    const status = await repoB.remoteStatus();
    expect(status.behind).toBe(0);
    expect(status.ahead).toBe(0);
  });

  it('refuses a tree with a symbolic link in it, and the save is as it was', async () => {
    const outside = tempDir('rmm-outside-');
    fs.writeFileSync(path.join(outside, 'credentials'), 'secret\n');
    fs.rmSync(path.join(a, 'voice.md'));
    fs.symlinkSync(path.relative(a, path.join(outside, 'credentials')), path.join(a, 'voice.md'));
    fs.rmSync(path.join(a, 'letters'), { recursive: true });
    fs.symlinkSync(outside, path.join(a, 'letters'));
    git(['add', '-A'], a);
    commitAs(a, 'A: links');
    expect((await repoA.push()).ok).toBe(true);
    const before = head(b);

    const res = await request(app).post('/api/config/store/pull').expect(200);

    expect(res.body.ok).toBe(false);
    expect(res.body.message).toMatch(/letters, voice\.md .*are symbolic links.*Nothing was merged/s);
    expect(head(b)).toBe(before);
    expect(fs.lstatSync(path.join(b, 'voice.md')).isSymbolicLink()).toBe(false);
    expect(fs.lstatSync(path.join(b, 'letters')).isDirectory()).toBe(true);
  });

  it('turns the AI off here when a pull changes its command, and says so', async () => {
    const config = YAML.parse(fs.readFileSync(path.join(a, 'config.yaml'), 'utf8'));
    config.ai = { ...config.ai, enabled: true, command: '/tmp/somebody-else.sh', args: ['{prompt}'] };
    fs.writeFileSync(path.join(a, 'config.yaml'), YAML.stringify(config));
    await repoA.commitAll('A: new AI');
    expect((await repoA.push()).ok).toBe(true);

    const res = await request(app).post('/api/config/store/pull').expect(200);

    expect(res.body.ok).toBe(true);
    expect(res.body.aiSwitchedOff).toBe(true);
    expect(res.body.message).toMatch(
      /The AI command changed in what was pulled: the command went from "claude" to "\/tmp\/somebody-else\.sh".*AI is switched off until you turn it on again in Settings\./s,
    );
    // The pulled file is as it came; the switch-off is this machine's own, and is never committed.
    expect(YAML.parse(fs.readFileSync(path.join(b, 'config.yaml'), 'utf8')).ai.enabled).toBe(true);
    expect(git(['status', '--porcelain'], b)).toBe('');
    expect(storeB.loadConfig().ai.enabled).toBe(false);
    expect((await request(app).get('/api/store').expect(200)).body.config.ai.enabled).toBe(false);
    expect((await request(app).get('/api/config').expect(200)).body.overrides.aiSwitchedOff).toMatch(/somebody-else/);

    // Turned on again in Settings, it is on.
    await request(app).put('/api/config').send({ ai: { enabled: true } }).expect(200);
    expect(storeB.loadConfig().ai.enabled).toBe(true);

    // And a pull that leaves the command alone leaves it on.
    await aMarksZetaInterview();
    const quiet = await request(app).post('/api/config/store/pull').expect(200);
    expect(quiet.body.ok).toBe(true);
    expect(quiet.body.aiSwitchedOff).toBeUndefined();
    expect(storeB.loadConfig().ai.enabled).toBe(true);
  });

  it('does not switch the AI off for a pull that is refused', async () => {
    const config = YAML.parse(fs.readFileSync(path.join(a, 'config.yaml'), 'utf8'));
    config.ai = { ...config.ai, enabled: true, command: '/tmp/somebody-else.sh' };
    fs.writeFileSync(path.join(a, 'config.yaml'), YAML.stringify(config));
    fs.writeFileSync(path.join(a, 'skills.yaml'), 'id: not-a-list\n');
    await repoA.commitAll('A: new AI, broken skills');
    expect((await repoA.push()).ok).toBe(true);
    await request(app).put('/api/config').send({ ai: { enabled: true } }).expect(200);

    expect((await repoB.pull()).ok).toBe(false);
    expect(storeB.loadConfig().ai.enabled).toBe(true);
  });
});

describe('a symbolic link already in the save', () => {
  it('is not read or written through', async () => {
    const outside = tempDir('rmm-outside-');
    const credentials = path.join(outside, 'credentials');
    fs.writeFileSync(credentials, 'secret\n');
    fs.rmSync(path.join(b, 'voice.md'));
    fs.symlinkSync(credentials, path.join(b, 'voice.md'));

    const read = await request(app).get('/api/store');
    expect(read.status).toBe(400);
    expect(read.body.error).toMatch(/"voice\.md" in the save is a symbolic link/);
    expect(() => storeB.saveVoice('overwritten')).toThrow(/symbolic link/);
    expect(fs.readFileSync(credentials, 'utf8')).toBe('secret\n');
  });

  it('is not listed, or written into, as a folder of the save', async () => {
    const outside = tempDir('rmm-outside-');
    fs.writeFileSync(path.join(outside, 'planted.md'), '---\ntitle: planted\n---\nnot a letter\n');
    fs.rmSync(path.join(b, 'letters'), { recursive: true, force: true });
    fs.symlinkSync(outside, path.join(b, 'letters'));

    expect(() => storeB.loadCoverLetters()).toThrow(/"letters" in the save is a symbolic link/);
    expect(() => storeB.saveCoverLetter({ id: 'x', title: 'x', createdAt: '', body: 'x' })).toThrow(/symbolic link/);
    expect(fs.readdirSync(outside)).toEqual(['planted.md']);
  });

  it('is not listed as a file inside a folder of the save either', async () => {
    const outside = tempDir('rmm-outside-');
    fs.writeFileSync(path.join(outside, 'planted.md'), '---\ntitle: planted\n---\nnot a letter\n');
    fs.mkdirSync(path.join(b, 'letters'), { recursive: true });
    fs.symlinkSync(path.join(outside, 'planted.md'), path.join(b, 'letters', 'planted.md'));

    expect(() => storeB.loadCoverLetters()).toThrow(/"letters\/planted\.md" in the save is a symbolic link/);
  });
});

describe('cloning a save', () => {
  it('refuses one with a symbolic link in it, and leaves nothing behind', async () => {
    fs.symlinkSync('/etc/passwd', path.join(a, 'voice-link.md'));
    git(['add', '-A'], a);
    commitAs(a, 'A: link');
    expect((await repoA.push()).ok).toBe(true);
    const into = path.join(tempDir('rmm-clone-into-'), 'save');

    await expect(cloneProject(remote, into, cloneRepo)).rejects.toThrow(/voice-link\.md .*is a symbolic link.*clone was removed/s);
    expect(fs.existsSync(into)).toBe(false);
  });

  it('switches off an AI that arrives switched on, until it is turned on here', async () => {
    const config = YAML.parse(fs.readFileSync(path.join(a, 'config.yaml'), 'utf8'));
    config.ai = { ...config.ai, enabled: true, command: '/tmp/somebody-else.sh' };
    fs.writeFileSync(path.join(a, 'config.yaml'), YAML.stringify(config));
    await repoA.commitAll('A: AI on');
    expect((await repoA.push()).ok).toBe(true);
    const into = path.join(tempDir('rmm-clone-into-'), 'save');

    const cloned = await cloneProject(remote, into, cloneRepo);

    expect(cloned.loadConfig().ai.enabled).toBe(false);
    expect(aiSwitchedOff(cloned.root)).toMatch(/cloned with the AI is switched on, running "\/tmp\/somebody-else\.sh"/);
    cloned.saveConfig({ ai: { enabled: true } as never });
    expect(cloned.loadConfig().ai.enabled).toBe(true);
  });
});

/*
 * The whole-object writes, given the version protection an entry's has: a
 * copy read before a pull is not written back over what the pull brought.
 */
describe('whole-object writes from a stale copy', () => {
  it('refuses a profile, skills or answers write based on a version that has moved on, with what is there now', async () => {
    const seen = (await request(app).get('/api/store').expect(200)).body;
    expect(seen.profileVersion).toMatch(/^[0-9a-f]{20}$/);

    // A changes all three and pushes; B pulls.
    const profile = YAML.parse(fs.readFileSync(path.join(a, 'profile.yaml'), 'utf8'));
    fs.writeFileSync(path.join(a, 'profile.yaml'), YAML.stringify({ ...profile, phone: '555-0199' }));
    fs.writeFileSync(path.join(a, 'skills.yaml'), YAML.stringify([...seen.skillGroups, { id: 'g_new', name: 'New', items: [] }]));
    fs.writeFileSync(path.join(a, 'answers.yaml'), YAML.stringify([]));
    await repoA.commitAll('A: three things');
    expect((await repoA.push()).ok).toBe(true);
    expect((await request(app).post('/api/config/store/pull').expect(200)).body.ok).toBe(true);

    const staleProfile = await request(app)
      .put(`/api/profile?basedOn=${seen.profileVersion}`)
      .send({ ...seen.profile, email: 'new@example.com' })
      .expect(409);
    expect(staleProfile.body.kind).toBe('conflict');
    expect(staleProfile.body.current.phone).toBe('555-0199');
    expect(YAML.parse(fs.readFileSync(path.join(b, 'profile.yaml'), 'utf8')).phone).toBe('555-0199');

    const staleSkills = await request(app).put(`/api/skills?basedOn=${seen.skillsVersion}`).send(seen.skillGroups).expect(409);
    expect(staleSkills.body.current.some((g: { id: string }) => g.id === 'g_new')).toBe(true);
    const staleAnswers = await request(app).put(`/api/answers?basedOn=${seen.answersVersion}`).send(seen.answers).expect(409);
    expect(staleAnswers.body.current).toEqual([]);

    // Made again on what the 409 handed back, it is written, and says the version it made.
    const again = await request(app)
      .put(`/api/profile?basedOn=${staleProfile.body.version}`)
      .send({ ...staleProfile.body.current, email: 'new@example.com' })
      .expect(200);
    const now = (await request(app).get('/api/store').expect(200)).body;
    expect(now.profile.phone).toBe('555-0199');
    expect(now.profile.email).toBe('new@example.com');
    expect(again.headers.etag).toBe(`"${now.profileVersion}"`);
    await request(app).put(`/api/skills?basedOn=${now.skillsVersion}`).send(now.skillGroups).expect(200);
    await request(app).put(`/api/answers?basedOn=${now.answersVersion}`).send(now.answers).expect(200);
  });

  it('still writes for a caller that sends no basedOn', async () => {
    const seen = (await request(app).get('/api/store').expect(200)).body;
    await request(app).put('/api/profile').send({ ...seen.profile, email: 'plain@example.com' }).expect(200);
    await request(app).put('/api/skills').send(seen.skillGroups).expect(200);
    await request(app).put('/api/answers').send(seen.answers).expect(200);
    expect(storeB.load().profile.email).toBe('plain@example.com');
  });
});

/*
 * The holds a request takes for a pull to wait on.
 */
describe('a request part-way through when a pull begins', () => {
  const drain = Repo.PULL_DRAIN_MS;
  afterEach(() => {
    Repo.PULL_DRAIN_MS = drain;
  });

  it('is let finish its second write, which the pull waits for, rather than refused part-way', async () => {
    await aMarksZetaInterview();
    let second: unknown = 'not run';
    let release!: () => void;
    let pulling!: Promise<unknown>;
    const done = new Promise<void>((finished) => {
      release = Repo.writesOfRequest(() => {
        void (async () => {
          await withCommit(repoB, true, 'first', () => fs.writeFileSync(path.join(b, 'first.txt'), '1'));
          pulling = repoB.pull();
          // Long enough for the pull to have fetched and be holding writes off.
          for (let i = 0; i < 200 && repoB.outsideGit()?.kind !== 'app'; i++) await sleep(10);
          expect(repoB.outsideGit()?.kind).toBe('app');
          try {
            await withCommit(repoB, true, 'second', () => fs.writeFileSync(path.join(b, 'second.txt'), '2'));
            second = 'written';
          } catch (err) {
            second = err;
          }
          finished();
        })();
      });
    });
    await done;
    release();
    const result = (await pulling) as { ok: boolean };

    expect(second).toBe('written');
    expect(result.ok).toBe(true);
    expect(rows(b)[0]!.status).toBe('interview');
    expect(fs.readFileSync(path.join(b, 'second.txt'), 'utf8')).toBe('2');
  });

  it('does not leave a hold behind for work a request left running after it was answered', async () => {
    Repo.PULL_DRAIN_MS = 500;
    await aMarksZetaInterview();
    let late!: Promise<void>;
    const release = Repo.writesOfRequest(() => {
      late = (async () => {
        await sleep(30);
        await withCommit(repoB, true, 'late', () => fs.writeFileSync(path.join(b, 'late.txt'), 'late'));
        repoB.assertNoOutsideGit();
      })();
    });
    release();
    await late;

    const result = await repoB.pull();
    expect(result.message).not.toMatch(/still being saved/);
    expect(result.ok).toBe(true);
  });
});
