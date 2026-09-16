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
  it('commits only the store directory, leaving other work alone', async () => {
    // The motivating case: a store that lives alongside its own source code.
    git(['init']);
    fs.mkdirSync(path.join(root, 'data'));
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'data', 'profile.yaml'), 'name: A\n');
    fs.writeFileSync(path.join(root, 'src', 'code.ts'), 'export const x = 1;\n');

    const repo = Repo.forStore(path.join(root, 'data'));
    await repo.ensure();

    fs.writeFileSync(path.join(root, 'data', 'profile.yaml'), 'name: B\n');
    fs.writeFileSync(path.join(root, 'src', 'code.ts'), 'export const x = 2;\n');
    await repo.commitAll('Update profile');

    const committed = git(['show', '--name-only', '--pretty=format:', 'HEAD']).trim();
    expect(committed).toContain('data/profile.yaml');
    expect(committed).not.toContain('src/code.ts');
    // The unrelated edit is still sitting in the working tree, untracked.
    // (git reports a wholly-untracked directory as `?? src/`.)
    expect(git(['status', '--porcelain'])).toMatch(/\?\?\s+src\//);
  });

  it('finds the enclosing repo when the store is a subdirectory', async () => {
    git(['init']);
    fs.mkdirSync(path.join(root, 'nested', 'data'), { recursive: true });
    const repo = Repo.forStore(path.join(root, 'nested', 'data'));
    expect(repo.root).toBe(fs.realpathSync(root));
    expect(repo.scope).toEqual([path.join('nested', 'data')]);
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
