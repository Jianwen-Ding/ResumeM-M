import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Repo, withCommit } from '../src/git/repo.js';

let root: string;

function git(args: string[], cwd = root) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'rmm-repo-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('initialisation', () => {
  it('reports a plain directory as not a repo', async () => {
    expect(await new Repo(root).isRepo()).toBe(false);
  });

  it('creates a repo and makes the first commit', async () => {
    fs.writeFileSync(path.join(root, 'a.txt'), 'hello');
    const repo = new Repo(root);
    await repo.ensure();
    expect(await repo.isRepo()).toBe(true);
    expect((await repo.log())[0]?.message).toBe('Initialise resume store');
  });

  it('leaves an existing repo alone', async () => {
    git(['init']);
    git(['-c', 'user.email=a@b.c', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'existing']);
    const repo = new Repo(root);
    await repo.ensure();
    expect((await repo.log())[0]?.message).toBe('existing');
  });
});

describe('committing', () => {
  it('does nothing when there is nothing to commit', async () => {
    const repo = new Repo(root);
    await repo.ensure();
    expect(await repo.commitAll('no-op')).toBeUndefined();
  });

  it('returns the new commit hash when something changed', async () => {
    const repo = new Repo(root);
    await repo.ensure();
    fs.writeFileSync(path.join(root, 'b.txt'), 'new');
    const hash = await repo.commitAll('added b');
    expect(hash).toMatch(/^[0-9a-f]{40}$/);
  });

  it('returns undefined outside a repo rather than throwing', async () => {
    expect(await new Repo(root).commitAll('nope')).toBeUndefined();
  });

  it('works on a machine with no global git identity', async () => {
    const repo = new Repo(root);
    await repo.ensure();
    fs.writeFileSync(path.join(root, 'c.txt'), 'x');
    await expect(repo.commitAll('c')).resolves.toBeTruthy();
  });
});

describe('scoping', () => {
  it('keeps the store history entirely out of the surrounding repository', async () => {
    // The motivating case: a store that lives alongside the application's code.
    git(['init']);
    const dataDir = path.join(root, 'data');
    fs.mkdirSync(dataDir);
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(dataDir, 'profile.yaml'), 'name: A\n');
    fs.writeFileSync(path.join(root, 'src', 'code.ts'), 'export const x = 1;\n');

    const repo = Repo.forStore(dataDir);
    await repo.ensure();

    fs.writeFileSync(path.join(dataDir, 'profile.yaml'), 'name: B\n');
    fs.writeFileSync(path.join(root, 'src', 'code.ts'), 'export const x = 2;\n');
    await repo.commitAll('Update profile');

    // The store's own history holds the change…
    const committed = git(['show', '--name-only', '--pretty=format:', 'HEAD'], dataDir).trim();
    expect(committed).toContain('profile.yaml');
    expect(committed).not.toContain('code.ts');

    // …and the surrounding repository has no commits from it at all.
    expect(() => git(['rev-parse', 'HEAD'], root)).toThrow();
  });

  it('does not adopt an enclosing repository as its own', async () => {
    // A store placed inside the application's checkout must not report the
    // source repository as its own and commit resume history into it.
    git(['init']);
    const nested = path.join(root, 'nested', 'data');
    fs.mkdirSync(nested, { recursive: true });

    const repo = Repo.forStore(nested);
    expect(repo.root).toBe(nested);
    expect(await repo.isRepo()).toBe(false);

    await repo.ensure();
    expect(fs.existsSync(path.join(nested, '.git'))).toBe(true);
  });

  it('treats the store as its own root when no repo encloses it', () => {
    const dir = path.join(root, 'standalone');
    fs.mkdirSync(dir);
    const repo = Repo.forStore(dir);
    expect(repo.root).toBe(dir);
    expect(repo.scope).toEqual(['.']);
  });

  it('falls back to the whole repo when handed an empty scope', () => {
    expect(new Repo(root, []).scope).toEqual(['.']);
  });
});

describe('history', () => {
  it('lists commits newest first with dates', async () => {
    const repo = new Repo(root);
    await repo.ensure();
    fs.writeFileSync(path.join(root, 'x.txt'), '1');
    await repo.commitAll('first change');
    fs.writeFileSync(path.join(root, 'x.txt'), '2');
    await repo.commitAll('second change');

    const log = await repo.log();
    expect(log[0]?.message).toBe('second change');
    expect(log[0]?.date).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('returns an empty log outside a repo', async () => {
    expect(await new Repo(root).log()).toEqual([]);
  });

  it('recovers a file as it was at a past commit', async () => {
    const repo = new Repo(root);
    await repo.ensure();
    fs.writeFileSync(path.join(root, 'bullet.yaml'), 'text: original\n');
    const first = await repo.commitAll('original wording');
    fs.writeFileSync(path.join(root, 'bullet.yaml'), 'text: revised\n');
    await repo.commitAll('revised wording');

    expect(await repo.show(first!, 'bullet.yaml')).toContain('original');
  });
});

describe('withCommit', () => {
  it('commits after the write succeeds', async () => {
    const repo = new Repo(root);
    await repo.ensure();
    const result = await withCommit(repo, true, 'saved something', () => {
      fs.writeFileSync(path.join(root, 'f.txt'), 'data');
      return 'returned';
    });
    expect(result).toBe('returned');
    expect((await repo.log())[0]?.message).toBe('saved something');
  });

  it('skips the commit when auto-commit is off', async () => {
    const repo = new Repo(root);
    await repo.ensure();
    await withCommit(repo, false, 'should not appear', () => {
      fs.writeFileSync(path.join(root, 'f.txt'), 'data');
    });
    expect((await repo.log())[0]?.message).toBe('Initialise resume store');
  });

  it('does not lose the write when the commit itself fails', async () => {
    // Not a repo, so committing cannot work — the write must still land.
    const repo = new Repo(path.join(root, 'nonexistent'));
    await withCommit(repo, true, 'msg', () => {
      fs.writeFileSync(path.join(root, 'kept.txt'), 'kept');
    });
    expect(fs.existsSync(path.join(root, 'kept.txt'))).toBe(true);
  });

  /*
   * And remembers that it failed, which is the half that was missing.
   *
   * The write has to land whatever git does, so the failure cannot be thrown
   * — it was a line in the server's console instead, and a console nobody
   * reads is the same as saying nothing. Meanwhile the editor goes on saying
   * "All changes saved", truthfully, about the file: the history has stopped
   * recording and nothing on screen can tell anyone so. "Restore this
   * version" then has nothing to restore to, and the sweep will not take a
   * resume the history does not have.
   */
  it('remembers why the commit did not happen', async () => {
    const repo = new Repo(root);
    await repo.ensure();
    // A lock left behind by a git that was killed, which is the failure the
    // serialising in `commitAll` was written for and does not cover: this one
    // is somebody else's git, or one that crashed, and it stays until it is
    // removed by hand.
    fs.writeFileSync(path.join(root, '.git/index.lock'), '');

    await withCommit(repo, true, 'msg', () => {
      fs.writeFileSync(path.join(root, 'kept.txt'), 'kept');
    });

    // The write still landed, which is the rule this must not break —
    expect(fs.readFileSync(path.join(root, 'kept.txt'), 'utf8')).toBe('kept');
    // — and now there is something that can say the history did not.
    expect(repo.lastCommitError?.message).toMatch(/index\.lock/);
    expect(repo.lastCommitError?.at).toMatch(/^\d{4}-/);
  });

  it('forgets it again once a commit works', async () => {
    // The state of the save now, not a log of everything that ever went
    // wrong: a repository that was locked for a moment and then was not is a
    // repository that is fine, and saying otherwise sends somebody looking
    // for a fault that has already gone.
    const repo = new Repo(root);
    repo.lastCommitError = { message: 'index.lock exists', at: new Date().toISOString() };
    await repo.ensure();

    await withCommit(repo, true, 'saved something', () => {
      fs.writeFileSync(path.join(root, 'f.txt'), 'data');
    });

    expect(repo.lastCommitError).toBeUndefined();
  });

  /*
   * The quietest way of all to end up with no history.
   *
   * `commitAll` returns the same nothing for "there was nothing to commit"
   * and "there is no repository to commit to", so a save that has never been
   * saved took every write, wrote it, reported success and recorded none of
   * it — with auto-commit switched on and doing nothing at all.
   */
  it('says so when there is no repository to commit to', async () => {
    const repo = new Repo(root);

    await withCommit(repo, true, 'msg', () => {
      fs.writeFileSync(path.join(root, 'f.txt'), 'data');
    });

    expect(repo.lastCommitError?.message).toMatch(/not a git repository yet/);
  });

  it('says nothing when there was simply nothing to commit', async () => {
    // The ordinary case that shares its answer with the one above: a write
    // that put back exactly what was already there.
    const repo = new Repo(root);
    await repo.ensure();
    fs.writeFileSync(path.join(root, 'f.txt'), 'data');
    await repo.commitAll('the first time');

    await withCommit(repo, true, 'again', () => {
      fs.writeFileSync(path.join(root, 'f.txt'), 'data');
    });

    expect(repo.lastCommitError).toBeUndefined();
  });

  it('says nothing about a commit it was told not to make', async () => {
    // Auto-commit off is a choice, not a fault.
    const repo = new Repo(path.join(root, 'nonexistent'));
    await withCommit(repo, false, 'msg', () => undefined);
    expect(repo.lastCommitError).toBeUndefined();
  });

  it('awaits an async write before committing', async () => {
    const repo = new Repo(root);
    await repo.ensure();
    await withCommit(repo, true, 'async write', async () => {
      await new Promise((r) => setTimeout(r, 10));
      fs.writeFileSync(path.join(root, 'async.txt'), 'x');
    });
    expect(git(['show', '--name-only', '--pretty=format:', 'HEAD'])).toContain('async.txt');
  });
});

describe('commit detail', () => {
  it('reports what one commit changed, with counts and a patch', async () => {
    const repo = new Repo(root);
    await repo.ensure();
    fs.writeFileSync(path.join(root, 'bullet.yaml'), 'text: original\nother: kept\n');
    await repo.commitAll('add a bullet');
    fs.writeFileSync(path.join(root, 'bullet.yaml'), 'text: revised\nother: kept\n');
    const hash = await repo.commitAll('revise the wording');

    const detail = await repo.commit(hash!);
    expect(detail?.message).toBe('revise the wording');
    expect(detail?.hash).toBe(hash);
    expect(detail?.author).toBe('ResumeM-M');
    expect(detail?.date).toMatch(/^\d{4}-/);

    const file = detail?.files.find((f) => f.path === 'bullet.yaml');
    expect(file?.added).toBe(1);
    expect(file?.removed).toBe(1);

    expect(detail?.diff).toContain('-text: original');
    expect(detail?.diff).toContain('+text: revised');
  });

  it('carries the commit body separately from the subject', async () => {
    const repo = new Repo(root);
    await repo.ensure();
    fs.writeFileSync(path.join(root, 'a.txt'), 'x');
    git(['add', '-A']);
    execFileSync(
      'git',
      ['-c', 'user.email=a@b.c', '-c', 'user.name=T', 'commit', '-q', '-m', 'subject line', '-m', 'body line'],
      { cwd: root },
    );

    const [head] = await repo.log(1);
    const detail = await repo.commit(head!.hash);
    expect(detail?.message).toBe('subject line');
    expect(detail?.body).toBe('body line');
  });

  it('counts a binary file as an unknown number of lines', async () => {
    const repo = new Repo(root);
    await repo.ensure();
    fs.writeFileSync(path.join(root, 'blob.bin'), Buffer.from([0, 1, 2, 0, 255, 0]));
    const hash = await repo.commitAll('add a binary file');

    const detail = await repo.commit(hash!);
    const file = detail?.files.find((f) => f.path === 'blob.bin');
    expect(file?.added).toBeNull();
    expect(file?.removed).toBeNull();
  });

  it('returns nothing for a hash that is not in the history', async () => {
    const repo = new Repo(root);
    await repo.ensure();
    expect(await repo.commit('0000000')).toBeUndefined();
  });

  it('returns nothing outside a repo', async () => {
    expect(await new Repo(path.join(root, 'nope')).commit('abc1234')).toBeUndefined();
  });

  it('truncates an enormous diff rather than returning it whole', async () => {
    const repo = new Repo(root);
    await repo.ensure();
    fs.writeFileSync(path.join(root, 'huge.txt'), Array.from({ length: 40_000 }, (_, i) => `line ${i}`).join('\n'));
    const hash = await repo.commitAll('add a huge file');

    const detail = await repo.commit(hash!);
    expect(detail!.diff.length).toBeLessThanOrEqual(200_100);
    expect(detail!.diff).toContain('diff truncated');
  });
});

describe('store repositories are their own', () => {
  it('roots at the store directory, never the repo above it', () => {
    // The motivating case: the store must not end up sharing history with the
    // application's source tree.
    git(['init']);
    const dataDir = path.join(root, 'data');
    fs.mkdirSync(dataDir);

    const repo = Repo.forStore(dataDir);
    expect(repo.root).toBe(dataDir);
    expect(repo.scope).toEqual(['.']);
  });

  it('initialises a repository inside the store itself', async () => {
    const dataDir = path.join(root, 'store');
    fs.mkdirSync(dataDir);
    const repo = Repo.forStore(dataDir);
    await repo.ensure();
    expect(fs.existsSync(path.join(dataDir, '.git'))).toBe(true);
  });
});

describe('remotes', () => {
  it('reports a store with no remote as local only', async () => {
    const repo = new Repo(root);
    await repo.ensure();
    const status = await repo.remoteStatus();
    expect(status.url).toBeUndefined();
    expect(status.tracked).toBe(false);
  });

  it('adds, updates, and removes a remote', async () => {
    const repo = new Repo(root);
    await repo.ensure();

    await repo.setRemote('https://example.com/a.git');
    expect(await repo.getRemote()).toBe('https://example.com/a.git');

    await repo.setRemote('https://example.com/b.git');
    expect(await repo.getRemote()).toBe('https://example.com/b.git');

    await repo.setRemote('');
    expect(await repo.getRemote()).toBeUndefined();
  });

  it('refuses to set a remote outside a repository', async () => {
    await expect(new Repo(path.join(root, 'nope')).setRemote('x')).rejects.toThrow(/not a git repository/);
  });

  it('refuses to push with no remote configured', async () => {
    const repo = new Repo(root);
    await repo.ensure();
    await expect(repo.push()).rejects.toThrow(/No remote/);
  });

  it('reports a failed push rather than throwing', async () => {
    const repo = new Repo(root);
    await repo.ensure();
    await repo.setRemote(path.join(root, 'definitely-not-a-repo'));
    const result = await repo.push();
    expect(result.ok).toBe(false);
    expect(result.output.length).toBeGreaterThan(0);
  });

  it('pushes to a real remote and then reports itself up to date', async () => {
    const remoteDir = path.join(root, 'remote.git');
    execFileSync('git', ['init', '--bare', '-q', remoteDir]);

    const repo = new Repo(root);
    await repo.ensure();
    fs.writeFileSync(path.join(root, 'profile.yaml'), 'name: A\n');
    await repo.commitAll('add a profile');
    await repo.setRemote(remoteDir);

    const pushed = await repo.push();
    expect(pushed.ok).toBe(true);

    const status = await repo.remoteStatus();
    expect(status.tracked).toBe(true);
    expect(status.ahead).toBe(0);
    expect(status.behind).toBe(0);

    // A later change shows as waiting to be pushed.
    fs.writeFileSync(path.join(root, 'profile.yaml'), 'name: B\n');
    await repo.commitAll('rename');
    expect((await repo.remoteStatus()).ahead).toBe(1);
  });

  it('names the current branch', async () => {
    const repo = new Repo(root);
    await repo.ensure();
    expect(await repo.currentBranch()).toBeTruthy();
  });
});

/*
 * The store is a git repository people also use as one — they clone it to a
 * second machine, pull, and resolve a conflict by hand. Every one of these
 * states used to end with the app reporting success having committed nothing.
 */
describe('a store someone has also used git on', () => {
  const seed = (repo: Repo) => {
    fs.writeFileSync(path.join(root, 'profile.yaml'), 'name: First\n');
    return repo.commitAll('first');
  };

  it('can still save while a merge is in progress', async () => {
    const repo = new Repo(root);
    await repo.ensure();
    await seed(repo);

    // Two branches that touch the same line, merged into a conflict the user
    // has resolved in their editor but not committed.
    git(['checkout', '-q', '-b', 'other']);
    fs.writeFileSync(path.join(root, 'profile.yaml'), 'name: Other\n');
    await repo.commitAll('other side');
    git(['checkout', '-q', '-']);
    fs.writeFileSync(path.join(root, 'profile.yaml'), 'name: Mine\n');
    await repo.commitAll('my side');
    try {
      git(['merge', 'other']);
    } catch {
      // The conflict is the point.
    }
    expect(fs.existsSync(path.join(root, '.git', 'MERGE_HEAD'))).toBe(true);

    fs.writeFileSync(path.join(root, 'profile.yaml'), 'name: Resolved\n');
    const hash = await repo.commitAll('resolved the conflict');

    // `git commit -- <paths>` is a partial commit, which git refuses outright
    // during a merge: "fatal: cannot do a partial commit during a merge". The
    // editor reported 200 OK and committed nothing, every time, forever.
    expect(hash).toBeTruthy();
    expect(git(['show', '-s', '--format=%s', 'HEAD']).trim()).toBe('resolved the conflict');
  });

  it('refuses to push a detached HEAD rather than pushing the wrong branch', async () => {
    const repo = new Repo(root);
    await repo.ensure();
    const first = await seed(repo);

    fs.writeFileSync(path.join(root, 'profile.yaml'), 'name: Second\n');
    await repo.commitAll('second');

    // Looking at an old version — which this tool's own history invites.
    git(['checkout', '-q', first!]);
    git(['remote', 'add', 'origin', path.join(root, 'nowhere.git')]);

    /*
     * The branch fell back to the literal 'main', so this pushed the *stale*
     * branch and reported success while the commit just made sat on no branch
     * at all — reachable only by hash, and collectable the moment a branch was
     * checked out again.
     */
    await expect(repo.push()).rejects.toThrow(/detached/i);
  });

  it('counts the files in an untracked folder, not the folder', async () => {
    const repo = new Repo(root);
    await repo.ensure();
    await seed(repo);

    fs.mkdirSync(path.join(root, 'drafts'), { recursive: true });
    for (const n of ['a', 'b', 'c']) {
      fs.writeFileSync(path.join(root, 'drafts', `${n}.yaml`), `id: ${n}\n`);
    }

    // Porcelain collapses a wholly untracked directory to one entry, so this
    // said "1 file" and then committed three.
    const pending = await repo.pending();
    expect(pending.length).toBe(3);
    expect(pending.every((p) => p.path.endsWith('.yaml'))).toBe(true);
  });
});

/*
 * A bundle is built into `out/applications/.rmm-building-XXXXXX` and moved
 * into place when it is whole, which is what makes a half-written archive
 * impossible. `git add -- .` walks the whole tree, and a second application
 * finishing during that walk takes its staging folder away mid-stat:
 *
 *   fatal: unable to stat 'out/applications/.rmm-building-sCPWqE/source/resume.tex':
 *   No such file or directory
 *
 * git aborts the entire add, the commit never happens, and `withCommit` has
 * nowhere to put that but a line in the console. The files are already on
 * disk, so nothing is lost there — but the version history quietly stops
 * recording, and "restore this version", the diff between two resumes and
 * the sweep are all built on it.
 */
describe('folders that exist only between two renames', () => {
  const building = () => path.join(root, 'out', 'applications', '.rmm-building-aBcDeF');

  beforeEach(() => {
    fs.mkdirSync(path.join(building(), 'source'), { recursive: true });
    fs.writeFileSync(path.join(building(), 'source', 'resume.tex'), '\\documentclass{article}');
    fs.writeFileSync(path.join(root, 'profile.yaml'), 'name: Test Person\n');
  });

  it('are not committed, and not walked either', async () => {
    const repo = new Repo(root);
    await repo.ensure();
    await repo.commitAll('Save the profile');

    const tracked = git(['ls-files']).split('\n').filter(Boolean);
    expect(tracked).toContain('profile.yaml');
    expect(tracked.some((f) => f.includes('.rmm-building-'))).toBe(false);

    // Ignored rather than merely unstaged: `git add` skips what it is told to
    // ignore before it stats it, which is the whole point.
    const seen = git(['status', '--porcelain', '--untracked-files=all']);
    expect(seen).not.toContain('.rmm-building-');
    expect(repo.lastCommitError).toBeUndefined();
  });

  it('says so in the store’s own .gitignore, appending to whatever is there', async () => {
    fs.writeFileSync(path.join(root, '.gitignore'), 'scratch/\n');
    const repo = new Repo(root);
    await repo.ensure();
    await repo.commitAll('Save the profile');

    const ignores = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
    expect(ignores).toContain('scratch/');
    expect(ignores).toContain('.rmm-building-*/');
    // And not again on the next commit.
    fs.writeFileSync(path.join(root, 'profile.yaml'), 'name: Someone Else\n');
    await new Repo(root).commitAll('Rename');
    const after = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
    expect(after.split('.rmm-building-*/').length - 1).toBe(1);
  });
});
