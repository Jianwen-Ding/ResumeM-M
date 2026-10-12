import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { Repo, commitQuietly, redactUrl, redactUrls, withCommit } from '../src/git/repo.js';
import { saveStore } from '../src/git/save.js';
import { normalizeApplications } from '../src/model/normalize.js';
import { parseStoreYaml } from '../src/model/store.js';
import { createApi } from '../src/server/api.js';
import { makeTempStore, type TempStore } from './helpers.js';

/*
 * The store is a repository people sync between machines with git itself: the
 * app pushes and clones, and a second machine catches up with `git pull` in a
 * terminal while the server runs. Each of these is something that went wrong
 * there, measured against real git.
 */

let root: string;
const git = (args: string[], cwd = root) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
const write = (rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text, 'utf8');
};
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');
const head = () => git(['rev-parse', 'HEAD']).trim();

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'rmm-sync-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** A store with a branch `other` that can be merged into it without conflict. */
async function withOtherBranch(): Promise<Repo> {
  const repo = new Repo(root);
  await repo.ensure();
  write('profile.yaml', 'name: First\n');
  await repo.commitAll('first');
  git(['checkout', '-q', '-b', 'other']);
  write('voice.md', 'from the other machine\n');
  await repo.commitAll('other machine');
  git(['checkout', '-q', '-']);
  return repo;
}

describe('an outside git in the middle of a pull', () => {
  it('refuses a write while a merge is open, and does not run it', async () => {
    const repo = await withOtherBranch();
    git(['merge', '--no-commit', '--no-ff', 'other']);
    const before = head();

    let ran = false;
    await expect(
      withCommit(repo, true, 'Track application to Zeta', () => {
        ran = true;
        write('applications.yaml', '- id: zeta\n');
      }),
    ).rejects.toThrow(/Not saved: a merge .* in progress.*Finish the pull in a terminal/s);

    expect(ran).toBe(false);
    expect(head()).toBe(before);
    expect(fs.existsSync(path.join(root, '.git', 'MERGE_HEAD'))).toBe(true);
  });

  it('refuses a write while a rebase is open', async () => {
    const repo = await withOtherBranch();
    // What `git pull --rebase` leaves for as long as it is unfinished.
    fs.mkdirSync(path.join(root, '.git', 'rebase-merge'));
    await expect(withCommit(repo, false, 'x', () => write('a.txt', 'a'))).rejects.toThrow(/rebase/);
    expect(fs.existsSync(path.join(root, 'a.txt'))).toBe(false);
  });

  /*
   * The race itself: the write passed before the pull began, and the pull
   * reached its merge before the commit behind the write. The commit used to
   * conclude git's merge under the app's message.
   */
  it('does not conclude a merge that began between the write and its commit, and keeps the write', async () => {
    const repo = await withOtherBranch();
    const before = head();
    const was = Repo.COMMIT_WAIT_MS;
    Repo.COMMIT_WAIT_MS = 200;
    try {
      await withCommit(repo, true, 'Track application to Zeta', () => {
        write('applications.yaml', '- id: zeta\n');
        git(['merge', '--no-commit', '--no-ff', 'other']);
      });
    } finally {
      Repo.COMMIT_WAIT_MS = was;
    }

    expect(head()).toBe(before);
    expect(fs.existsSync(path.join(root, '.git', 'MERGE_HEAD'))).toBe(true);
    expect(repo.lastCommitError?.message).toMatch(/Not added to the version history yet.*saved on disk.*Finish the pull/s);
    expect(read('applications.yaml')).toBe('- id: zeta\n');

    // The person finishes the pull; the edit goes in with the next commit.
    git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--no-edit']);
    expect(git(['log', '-1', '--format=%P']).trim().split(' ')).toHaveLength(2);
    await commitQuietly(repo, 'later');
    expect(repo.lastCommitError).toBeUndefined();
    expect(git(['show', 'HEAD:applications.yaml'])).toBe('- id: zeta\n');
  });

  it('waits for a moment for another git to let go of the index, then commits', async () => {
    const repo = await withOtherBranch();
    const lock = path.join(root, '.git', 'index.lock');
    fs.writeFileSync(lock, '');
    // Gone in a moment, as a running git's lock is — from another process,
    // because the wait holds this one.
    const remover = spawn('sh', ['-c', `sleep 0.3; rm -f '${lock}'`], { stdio: 'ignore' });
    const removed = new Promise((done) => remover.once('close', done));

    await withCommit(repo, true, 'during a lock', () => write('kept.txt', 'kept'));
    await removed;

    expect(repo.lastCommitError).toBeUndefined();
    expect(git(['log', '-1', '--format=%s']).trim()).toBe('during a lock');
  });

  it('does not wait on a lock a killed git left long ago, and says to delete it', async () => {
    const repo = await withOtherBranch();
    const lock = path.join(root, '.git', 'index.lock');
    fs.writeFileSync(lock, '');
    const old = new Date(Date.now() - 5 * 60_000);
    fs.utimesSync(lock, old, old);

    const started = Date.now();
    await withCommit(repo, true, 'msg', () => write('kept.txt', 'kept'));

    expect(Date.now() - started).toBeLessThan(Repo.WRITE_WAIT_MS);
    expect(read('kept.txt')).toBe('kept');
    expect(repo.lastCommitError?.message).toMatch(/minute\(s\) old.*delete .*index\.lock/s);
  });

  /*
   * A fetch is not a pull. `FETCH_HEAD` fresh on its own — the app's own
   * fetch after a refused push, an editor's autofetch — made every write
   * after it wait out `WRITE_WAIT_MS`, synchronously, with the server
   * answering nothing in the meantime.
   */
  it('does not hold a write for a fetch that no merge followed', async () => {
    const repo = await withOtherBranch();
    const remote = path.join(root, '..', `${path.basename(root)}-remote.git`);
    execFileSync('git', ['clone', '-q', '--bare', root, remote]);
    try {
      git(['remote', 'add', 'origin', remote]);
      git(['fetch', '-q', 'origin']);
      expect(repo.outsideGit()).toBeUndefined();
      const started = Date.now();
      await withCommit(repo, false, 'x', () => write('a.txt', 'a'));
      expect(Date.now() - started).toBeLessThan(500);

      // A merge that has begun still counts, by its ORIG_HEAD.
      git(['update-ref', 'ORIG_HEAD', 'HEAD']);
      expect(repo.outsideGit()?.kind).toBe('pull');
    } finally {
      fs.rmSync(remote, { recursive: true, force: true });
    }
  });

  /*
   * `outsideGit` set the app's own commit lock aside, but `justPulled` did not
   * get told, so that same lock plus an editor's fetch read as a pull starting.
   */
  it("does not take its own commit's lock, with an outside fetch, for a pull", async () => {
    const repo = new Repo(root);
    await repo.ensure();
    const dir = path.join(root, '.git');
    fs.writeFileSync(path.join(dir, 'FETCH_HEAD'), 'x');
    fs.writeFileSync(path.join(dir, 'index.lock'), '');
    try {
      expect(repo.outsideGit(true)).toBeUndefined();
      // Somebody else's lock is still another git at work.
      expect(repo.outsideGit(false)?.kind).toBe('lock');
    } finally {
      fs.rmSync(path.join(dir, 'index.lock'));
    }
  });

  it('does not hold the next write after its own fetch, when a push is refused', async () => {
    const remote = path.join(root, 'remote.git');
    execFileSync('git', ['init', '--bare', '-q', remote]);
    const a = new Repo(path.join(root, 'a'));
    fs.mkdirSync(a.root);
    await a.ensure();
    await a.setRemote(remote);
    expect((await a.push()).ok).toBe(true);
    const b = path.join(root, 'b');
    execFileSync('git', ['clone', '-q', remote, b]);
    fs.writeFileSync(path.join(b, 'voice.md'), 'from B\n');
    await new Repo(b).commitAll('B');
    expect((await new Repo(b).push()).ok).toBe(true);
    fs.writeFileSync(path.join(a.root, 'profile.yaml'), 'name: A\n');
    await a.commitAll('A');
    expect((await a.push()).ok).toBe(false); // refused, and fetched

    const started = Date.now();
    await withCommit(a, false, 'x', () => fs.writeFileSync(path.join(a.root, 'kept.txt'), 'kept'));
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('is answered as an error through the API, not 200', async () => {
    const t: TempStore = makeTempStore({ config: { ai: { enabled: false }, git: { autoCommit: true }, output: { dir: 'out' } } });
    try {
      const repo = Repo.forStore(t.dir);
      await repo.ensure();
      git(['checkout', '-q', '-b', 'other'], t.dir);
      fs.writeFileSync(path.join(t.dir, 'voice.md'), 'other\n');
      git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', 'other'], t.dir);
      git(['checkout', '-q', '-'], t.dir);
      git(['merge', '--no-commit', '--no-ff', 'other'], t.dir);

      const app = express();
      app.use(express.json());
      app.use('/api', createApi({ store: t.store, repo }));
      const res = await request(app).post('/api/applications').send({ company: 'Zeta', role: 'Dev' });

      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.body.error).toMatch(/Finish the pull/);
      expect(t.store.load().applications).toHaveLength(0);
    } finally {
      t.cleanup();
    }
  });
});

describe('a modify/delete conflict', () => {
  /** Ours edited resumes/newgrad.yaml; theirs deleted it. */
  async function modifyDelete(): Promise<Repo> {
    const repo = new Repo(root);
    await repo.ensure();
    write('resumes/newgrad.yaml', 'id: newgrad\n');
    await repo.commitAll('first');
    git(['checkout', '-q', '-b', 'other']);
    git(['rm', '-q', 'resumes/newgrad.yaml']);
    git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'Delete resume "newgrad"']);
    git(['checkout', '-q', '-']);
    write('resumes/newgrad.yaml', 'id: newgrad\nlabel: Edited\n');
    await repo.commitAll('Update resume "newgrad"');
    expect(() => git(['merge', 'other'])).toThrow();
    // No markers: the edited side is left in the tree as it was.
    expect(read('resumes/newgrad.yaml')).toBe('id: newgrad\nlabel: Edited\n');
    return repo;
  }

  it('counts as unresolved, so a save does not conclude the merge for one side', async () => {
    const repo = await modifyDelete();
    const before = head();

    expect(await repo.unresolved()).toEqual(['resumes/newgrad.yaml']);
    await expect(saveStore(repo, { message: 'keep my work' })).rejects.toThrow(/conflict.*resumes\/newgrad\.yaml/);
    expect(head()).toBe(before);
    expect(fs.existsSync(path.join(root, '.git', 'MERGE_HEAD'))).toBe(true);
  });

  it('lists the file left in the tree as modified, not deleted', async () => {
    const repo = await modifyDelete();
    expect(await repo.pending()).toContainEqual({ path: 'resumes/newgrad.yaml', state: 'modified' });
  });

  it('saves once somebody chooses a side', async () => {
    const repo = await modifyDelete();
    git(['rm', '-q', 'resumes/newgrad.yaml']);
    const result = await saveStore(repo, { message: 'let it go' });
    expect(result.saved).toBe(true);
    expect(fs.existsSync(path.join(root, '.git', 'MERGE_HEAD'))).toBe(false);
  });
});

describe('a remote with a token in its address', () => {
  const secret = 'https://alice:ghp_SECRETTOKEN123@127.0.0.1:9/me/save.git';

  it('never shows the token', async () => {
    const repo = new Repo(root);
    await repo.ensure();
    await repo.setRemote(secret);

    const status = await repo.remoteStatus();
    expect(status.url).toBe('https://alice:•••@127.0.0.1:9/me/save.git');
    expect(JSON.stringify(status)).not.toContain('ghp_');

    const saved = await saveStore(repo, { push: true });
    expect(JSON.stringify(saved)).not.toContain('ghp_');
  });

  it('keeps the token when the address it was shown is saved back', async () => {
    const repo = new Repo(root);
    await repo.ensure();
    await repo.setRemote(secret);

    await repo.setRemote((await repo.remoteStatus()).url!);
    expect(await repo.getRemote()).toBe(secret);

    // A different address is still a change.
    await repo.setRemote('https://127.0.0.1:9/me/other.git');
    expect(await repo.getRemote()).toBe('https://127.0.0.1:9/me/other.git');
  });

  it('leaves an SSH address alone', () => {
    expect(redactUrl('git@github.com:me/save.git')).toBe('git@github.com:me/save.git');
    expect(redactUrl('ssh://git@github.com/me/save.git')).toBe('ssh://git@github.com/me/save.git');
    expect(redactUrl('http://tok@example.com/a.git')).toBe('http://•••@example.com/a.git');
  });

  /*
   * The shown address used to be the address with no token at all, so it had
   * to be taken as "unchanged" — and saving the address without the token,
   * which is how anybody would try to remove it, kept it.
   */
  it('takes the token off when the address is saved without one', async () => {
    const repo = new Repo(root);
    await repo.ensure();
    await repo.setRemote(secret);

    await repo.setRemote('https://127.0.0.1:9/me/save.git');
    expect(await repo.getRemote()).toBe('https://127.0.0.1:9/me/save.git');
    expect((await repo.remoteStatus()).url).toBe('https://127.0.0.1:9/me/save.git');
  });

  it('keeps the token behind the mask when the rest of the address is edited', async () => {
    const repo = new Repo(root);
    await repo.ensure();
    await repo.setRemote(secret);
    await repo.setRemote('https://alice:•••@127.0.0.1:9/me/renamed.git');
    expect(await repo.getRemote()).toBe('https://alice:ghp_SECRETTOKEN123@127.0.0.1:9/me/renamed.git');
  });

  /*
   * The token was put back whatever else had changed, so a masked address
   * pointed at another host or scheme was saved with the real token in it,
   * and the next push sent that token to the other server.
   */
  it('does not put the token back when the address points somewhere else', async () => {
    const repo = new Repo(root);
    await repo.ensure();
    await repo.setRemote(secret);
    const edits = [
      'https://alice:•••@gitlab.example.net/me/save.git',
      'ssh://alice:•••@attacker.example:2222/x.git',
      'http://alice:•••@127.0.0.1:9/me/save.git',
      'https://alice:•••@127.0.0.1:10/me/save.git',
      'https://bob:•••@127.0.0.1:9/me/save.git',
    ];
    for (const edit of edits) {
      await expect(repo.setRemote(edit)).rejects.toThrow(/Type the token into the address again/);
      expect(await repo.getRemote()).toBe(secret);
    }
    // Same server, the host's case and the usual port spelled out: still the same place.
    await repo.setRemote('https://alice:•••@127.0.0.1:9/me/other.git');
    expect(await repo.getRemote()).toBe('https://alice:ghp_SECRETTOKEN123@127.0.0.1:9/me/other.git');
    await repo.setRemote('https://alice:tok2@Example.COM/me/save.git');
    await repo.setRemote('https://alice:•••@example.com:443/me/save.git');
    expect(await repo.getRemote()).toBe('https://alice:tok2@example.com:443/me/save.git');
  });

  it('masks an SSH password, and a token with an unencoded ? or # in it', () => {
    expect(redactUrl('ssh://user:secretpw@example.com/a/b.git')).toBe('ssh://user:•••@example.com/a/b.git');
    expect(redactUrl('https://oauth2:tok?en@gitlab.com/a/b.git')).toBe('https://oauth2:•••@gitlab.com/a/b.git');
    expect(redactUrl('https://x-access-token:t#k@github.com/a/b.git')).toBe('https://x-access-token:•••@github.com/a/b.git');
    expect(redactUrls("fatal: unable to access 'https://oauth2:tok?en@gitlab.com/a/b.git/': x")).not.toContain('tok?en');
    expect(redactUrls('to ssh://user:secretpw@example.com/a.git')).toBe('to ssh://user:•••@example.com/a.git');
    expect(redactUrls('to ssh://git@example.com/a.git')).toBe('to ssh://git@example.com/a.git');
  });
});

describe('pushing', () => {
  it('gives up on a remote that stops answering, with a sentence', async () => {
    // Accepts the connection and never says a word.
    const held: net.Socket[] = [];
    const server = net.createServer((socket) => held.push(socket));
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const port = (server.address() as net.AddressInfo).port;
    try {
      const repo = new Repo(root);
      await repo.ensure();
      await repo.setRemote(`http://alice:tok123@127.0.0.1:${port}/me/save.git`);

      const started = Date.now();
      const result = await repo.push(1500);

      expect(Date.now() - started).toBeLessThan(10_000);
      expect(result.ok).toBe(false);
      expect(result.output).toMatch(/took longer than 2 seconds and was stopped/);
      expect(result.output).not.toContain('tok123');
    } finally {
      for (const socket of held) socket.destroy();
      server.close();
    }
  }, 20_000);

  it('reports a push that landed as landed, when a slow post-receive hook outlasts the timeout', async () => {
    // The remote moves its branch and then runs the hook, which takes its time.
    const remote = path.join(root, 'slow.git');
    execFileSync('git', ['init', '--bare', '-q', remote]);
    fs.writeFileSync(path.join(remote, 'hooks', 'post-receive'), '#!/bin/sh\nsleep 30\n', { mode: 0o755 });
    const repo = new Repo(path.join(root, 'here'));
    fs.mkdirSync(repo.root);
    await repo.ensure();
    await repo.setRemote(remote);

    const result = await repo.push(1500);

    const branch = await repo.currentBranch();
    const landed = git(['rev-parse', `refs/heads/${branch}`], remote).trim() === git(['rev-parse', 'HEAD'], repo.root).trim();
    expect(landed).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.output).not.toMatch(/Nothing was changed on the remote/);
    expect((await repo.remoteStatus()).ahead).toBe(0);
  }, 20_000);

  /*
   * A slow pre-receive hook runs before the branch moves, so the remote asked
   * straight after the timeout does not have the commit yet, and takes it a
   * few seconds later. That was reported as "the push did not land" — and so
   * was a remote with no branch at all, which says nothing either way.
   */
  it('does not call a push that a slow pre-receive hook is still checking one that did not land', async () => {
    const remote = path.join(root, 'slow.git');
    execFileSync('git', ['init', '--bare', '-q', remote]);
    const repo = new Repo(path.join(root, 'here'));
    fs.mkdirSync(repo.root);
    await repo.ensure();
    await repo.setRemote(remote);
    const branch = (await repo.currentBranch())!;
    // Like a real server, whose receive-pack is not in this push's process group.
    git(['config', 'remote.origin.receivepack', 'setsid git-receive-pack'], repo.root);
    fs.writeFileSync(path.join(remote, 'hooks', 'pre-receive'), '#!/bin/sh\nsleep 3\n', { mode: 0o755 });

    // A remote with no branch yet: unknown, not "did not land".
    const first = await repo.push(1000);
    expect(first.ok).toBe(false);
    expect(first.output).toMatch(/may or may not have reached the remote/);
    expect(first.output).not.toMatch(/did not land/);
    await new Promise((done) => setTimeout(done, 3500));
    expect(git(['rev-parse', `refs/heads/${branch}`], remote).trim()).toBe(git(['rev-parse', 'HEAD'], repo.root).trim());

    // A remote on an older commit: not there yet, worth checking again.
    fs.writeFileSync(path.join(repo.root, 'b.txt'), 'b\n');
    await repo.commitAll('b');
    const second = await repo.push(1000);
    expect(second.ok).toBe(false);
    expect(second.output).toMatch(/had not landed when checked/);
    expect(second.output).toMatch(/may take it shortly/);
    expect(second.output).not.toMatch(/did not land/);
    await new Promise((done) => setTimeout(done, 3500));
    expect(git(['rev-parse', `refs/heads/${branch}`], remote).trim()).toBe(git(['rev-parse', 'HEAD'], repo.root).trim());
  }, 30_000);

  /*
   * The remote was compared with HEAD after the timeout, and an auto-commit
   * made while the push was waiting had moved HEAD on: the push that landed
   * was reported as not landing.
   */
  it('compares the remote with the commit that was pushed, not a later one', async () => {
    const remote = path.join(root, 'slow.git');
    execFileSync('git', ['init', '--bare', '-q', remote]);
    const repo = new Repo(path.join(root, 'here'));
    fs.mkdirSync(repo.root);
    await repo.ensure();
    await repo.setRemote(remote);
    // The branch moves, then a commit is made here while the hook holds the push open.
    fs.writeFileSync(
      path.join(remote, 'hooks', 'post-receive'),
      `#!/bin/sh\nenv -i PATH="$PATH" HOME="$HOME" git -C '${repo.root}' -c user.name=t -c user.email=t@t commit -q --allow-empty -m later\nsleep 30\n`,
      { mode: 0o755 },
    );
    const pushed = git(['rev-parse', 'HEAD'], repo.root).trim();
    const branch = (await repo.currentBranch())!;

    const result = await repo.push(1500);

    expect(git(['rev-parse', 'HEAD'], repo.root).trim()).not.toBe(pushed);
    expect(result.ok).toBe(true);
    expect(git(['rev-parse', `refs/remotes/origin/${branch}`], repo.root).trim()).toBe(pushed);
  }, 20_000);

  it('does not wait on an SSH master that keeps stderr open after the push has finished', async () => {
    // Like ssh with ControlPersist: a background process, in a session of its
    // own, that inherited git's stderr and outlives the push.
    const ssh = path.join(root, 'fake-ssh.sh');
    fs.writeFileSync(
      ssh,
      '#!/bin/sh\n( setsid sleep 6 & )\nwhile [ $# -gt 1 ]; do shift; done\nexec sh -c "$1"\n',
      { mode: 0o755 },
    );
    const remote = path.join(root, 'ssh.git');
    execFileSync('git', ['init', '--bare', '-q', remote]);
    const repo = new Repo(path.join(root, 'here'));
    fs.mkdirSync(repo.root);
    await repo.ensure();
    git(['config', 'core.sshCommand', ssh], repo.root);
    await repo.setRemote(`ssh://localhost${remote}`);

    const started = Date.now();
    const result = await repo.push(3000);

    expect(result.ok).toBe(true);
    expect(Date.now() - started).toBeLessThan(2500);
  }, 20_000);

  it('says what a refused push means here, and that the remote is ahead', async () => {
    const remote = path.join(root, 'remote.git');
    execFileSync('git', ['init', '--bare', '-q', remote]);
    const a = path.join(root, 'a');
    const b = path.join(root, 'b');
    fs.mkdirSync(a);
    const repoA = new Repo(a);
    await repoA.ensure();
    await repoA.setRemote(remote);
    expect((await repoA.push()).ok).toBe(true);

    execFileSync('git', ['clone', '-q', remote, b]);
    const repoB = new Repo(b);
    fs.writeFileSync(path.join(b, 'voice.md'), 'from B\n');
    await repoB.commitAll('B');
    expect((await repoB.push()).ok).toBe(true);

    fs.writeFileSync(path.join(a, 'profile.yaml'), 'name: A\n');
    await repoA.commitAll('A');
    const refused = await repoA.push();

    expect(refused.ok).toBe(false);
    expect(refused.output).toMatch(/remote has changes this save does not have.*git pull in /s);
    expect((await repoA.remoteStatus()).behind).toBe(1);
  });
});

describe('two tracker rows under one id', () => {
  const rows = [
    { id: '2026-10-12-zeta-dev', company: 'Zeta', role: 'Dev', status: 'offer' },
    { id: '2026-10-12-zeta-dev', company: 'Zeta', role: 'Dev', status: 'interview', notes: 'from machine A' },
    { id: '2026-10-12-zeta-dev-2', company: 'Zeta', role: 'Dev', status: 'applied' },
  ];

  it('load with ids of their own', () => {
    const ids = normalizeApplications(rows).map((a) => a.id);
    expect(ids).toEqual(['2026-10-12-zeta-dev', '2026-10-12-zeta-dev-3', '2026-10-12-zeta-dev-2']);
  });

  it('are removed one at a time', async () => {
    const t = makeTempStore();
    try {
      t.write('applications.yaml', rows.slice(0, 2));
      const app = express();
      app.use(express.json());
      app.use('/api', createApi({ store: t.store, repo: Repo.forStore(t.dir) }));

      await request(app).delete('/api/applications/2026-10-12-zeta-dev').expect(200);

      const left = YAML.parse(fs.readFileSync(path.join(t.dir, 'applications.yaml'), 'utf8')) as { notes?: string }[];
      expect(left).toHaveLength(1);
      expect(left[0]!.notes).toBe('from machine A');
    } finally {
      t.cleanup();
    }
  });
});

describe('a file a pull left conflicted', () => {
  it('says so, by name', () => {
    const raw = '<<<<<<< HEAD\n- id: a\n=======\n- id: b\n>>>>>>> 90504bf (Track application)\n';
    expect(() => parseStoreYaml('applications.yaml', raw, [])).toThrow(/^Unresolved git merge conflict in applications\.yaml/);
  });

  it('even when the conflict happens to parse', () => {
    const raw = 'name: x\n<<<<<<< HEAD\nemail: a\n=======\nphone: b\n>>>>>>> theirs\n';
    expect(() => parseStoreYaml('profile.yaml', raw, {})).toThrow(/merge conflict in profile\.yaml/);
  });
});
