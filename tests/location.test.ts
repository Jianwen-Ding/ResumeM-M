import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findProjectRoot, isEmptyStore, resolveStoreDir, seedStore } from '../src/model/location.js';
import { cloneProject } from '../src/model/projects.js';

describe('resolveStoreDir', () => {
  const original = process.env.RMM_DATA;
  const originalProjects = process.env.RMM_PROJECTS_FILE;
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rmm-project-'));
    /*
     * Point the remembered-projects file at somewhere that does not exist.
     *
     * `resolveStoreDir` consults it before anything else, so these tests were
     * reading whichever save the developer happened to have open in the app —
     * and failing, with a diff between two absolute paths and no hint that the
     * cause was outside the repository. A test that depends on the machine it
     * runs on is not testing the code.
     */
    process.env.RMM_PROJECTS_FILE = path.join(projectRoot, 'no-such-projects.json');
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
    if (originalProjects === undefined) delete process.env.RMM_PROJECTS_FILE;
    else process.env.RMM_PROJECTS_FILE = originalProjects;
    if (original === undefined) delete process.env.RMM_DATA;
    else process.env.RMM_DATA = original;
  });

  it('honours RMM_DATA above everything else', () => {
    const explicit = fs.mkdtempSync(path.join(os.tmpdir(), 'rmm-explicit-'));
    process.env.RMM_DATA = explicit;
    try {
      expect(resolveStoreDir(projectRoot)).toBe(path.resolve(explicit));
    } finally {
      fs.rmSync(explicit, { recursive: true, force: true });
    }
  });

  it('resolves a relative RMM_DATA against the current working directory', () => {
    process.env.RMM_DATA = 'somewhere/relative';
    expect(resolveStoreDir(projectRoot)).toBe(path.resolve('somewhere/relative'));
  });

  it('keeps an in-tree ./data that is already its own git repo', () => {
    delete process.env.RMM_DATA;
    const bundled = path.join(projectRoot, 'data');
    fs.mkdirSync(path.join(bundled, '.git'), { recursive: true });
    expect(resolveStoreDir(projectRoot)).toBe(bundled);
  });

  it('falls back to ~/.resumem-m/store when ./data is not a repo', () => {
    delete process.env.RMM_DATA;
    // projectRoot has no data/ at all here.
    expect(resolveStoreDir(projectRoot)).toBe(path.join(os.homedir(), '.resumem-m', 'store'));
  });

  it('falls back to home even when ./data exists but is not a git repo', () => {
    delete process.env.RMM_DATA;
    fs.mkdirSync(path.join(projectRoot, 'data'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'data', 'config.yaml'), 'ai: {}\n');
    expect(resolveStoreDir(projectRoot)).toBe(path.join(os.homedir(), '.resumem-m', 'store'));
  });
});

describe('isEmptyStore', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmm-store-'));
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('is true for a directory that does not exist yet', () => {
    expect(isEmptyStore(path.join(dir, 'missing'))).toBe(true);
  });

  it('is true for a directory with nothing but dotfiles', () => {
    fs.writeFileSync(path.join(dir, '.gitignore'), '');
    expect(isEmptyStore(dir)).toBe(true);
  });

  it('is false once real content exists', () => {
    fs.writeFileSync(path.join(dir, 'config.yaml'), 'ai: {}\n');
    expect(isEmptyStore(dir)).toBe(false);
  });
});

describe('seedStore', () => {
  let from: string;
  let to: string;

  beforeEach(() => {
    from = fs.mkdtempSync(path.join(os.tmpdir(), 'rmm-from-'));
    to = fs.mkdtempSync(path.join(os.tmpdir(), 'rmm-to-'));
    fs.rmSync(to, { recursive: true, force: true }); // seedStore must create it

    fs.writeFileSync(path.join(from, 'config.yaml'), 'ai: {}\n');
    fs.mkdirSync(path.join(from, 'resumes'));
    fs.writeFileSync(path.join(from, 'resumes', 'newgrad.yaml'), 'id: newgrad\n');
    fs.mkdirSync(path.join(from, '.git'));
    fs.writeFileSync(path.join(from, '.git', 'HEAD'), 'ref: refs/heads/master\n');
    fs.mkdirSync(path.join(from, 'node_modules'));
    fs.writeFileSync(path.join(from, 'node_modules', 'junk.js'), '');
  });

  afterEach(() => {
    fs.rmSync(from, { recursive: true, force: true });
    fs.rmSync(to, { recursive: true, force: true });
  });

  it('copies real content into a fresh, empty target', () => {
    const seeded = seedStore(from, to);
    expect(seeded).toBe(true);
    expect(fs.readFileSync(path.join(to, 'config.yaml'), 'utf8')).toContain('ai:');
    expect(fs.readFileSync(path.join(to, 'resumes', 'newgrad.yaml'), 'utf8')).toContain('newgrad');
  });

  it('never copies the source .git or node_modules', () => {
    seedStore(from, to);
    expect(fs.existsSync(path.join(to, '.git'))).toBe(false);
    expect(fs.existsSync(path.join(to, 'node_modules'))).toBe(false);
  });

  it('refuses to seed a target that already has content', () => {
    fs.mkdirSync(to, { recursive: true });
    fs.writeFileSync(path.join(to, 'config.yaml'), 'already: here\n');
    const seeded = seedStore(from, to);
    expect(seeded).toBe(false);
    expect(fs.readFileSync(path.join(to, 'config.yaml'), 'utf8')).toContain('already');
  });

  it('does nothing when there is no bundled example to seed from', () => {
    const missingFrom = path.join(from, 'does-not-exist');
    const seeded = seedStore(missingFrom, to);
    expect(seeded).toBe(false);
    expect(fs.existsSync(to)).toBe(false);
  });
});

/**
 * The layout is not the same before and after a build, and one of the two was
 * getting a 404 for the whole editor.
 */
describe('finding the files that ship with the tool', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'rmm-root-'));
    fs.mkdirSync(path.join(root, 'web'), { recursive: true });
    fs.writeFileSync(path.join(root, 'web', 'index.html'), '<!doctype html>');
    fs.writeFileSync(path.join(root, 'package.json'), '{"name":"resumem-m"}');
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('finds it from the source tree, which is two levels down', () => {
    const from = path.join(root, 'src', 'server');
    fs.mkdirSync(from, { recursive: true });
    expect(findProjectRoot(from)).toBe(fs.realpathSync(root));
  });

  /*
   * The one that was broken. `here/../..` from the compiled server is `dist`,
   * which holds JavaScript and nothing else — no `web`, no `data`. The server
   * answered every API call and served the editor as a 404, and the macOS app
   * is a WKWebView pointed at that server.
   */
  it('finds it from the compiled tree, which is three', () => {
    const from = path.join(root, 'dist', 'src', 'server');
    fs.mkdirSync(from, { recursive: true });
    expect(findProjectRoot(from)).toBe(fs.realpathSync(root));
    expect(findProjectRoot(from)).not.toBe(fs.realpathSync(path.join(root, 'dist')));
  });

  it('finds it from the compiled CLI, which is two below the same root', () => {
    const from = path.join(root, 'dist', 'src');
    fs.mkdirSync(from, { recursive: true });
    expect(findProjectRoot(from)).toBe(fs.realpathSync(root));
  });

  it('is not fooled by a package.json with no web beside it', () => {
    // `dist` gets no package.json today, but a bundler could put one there.
    fs.mkdirSync(path.join(root, 'dist', 'src', 'server'), { recursive: true });
    fs.writeFileSync(path.join(root, 'dist', 'package.json'), '{"type":"module"}');
    expect(findProjectRoot(path.join(root, 'dist', 'src', 'server'))).toBe(fs.realpathSync(root));
  });

  it('gives the old answer rather than a new failure when there is nothing to find', () => {
    const lost = fs.mkdtempSync(path.join(os.tmpdir(), 'rmm-lost-'));
    const from = path.join(lost, 'a', 'b');
    fs.mkdirSync(from, { recursive: true });
    expect(findProjectRoot(from)).toBe(path.resolve(from, '..', '..'));
    fs.rmSync(lost, { recursive: true, force: true });
  });
});

/**
 * A save is its own git repository, which is exactly why cloning should
 * exist: opening it on a second machine meant cloning by hand in a terminal,
 * remembering where you put it, and then finding that folder in the chooser.
 */
describe('cloning a save from a repository', () => {
  let into: string;

  beforeEach(() => {
    into = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rmm-clone-')), 'save');
  });

  /** A stand-in for git: copies a prepared folder into the staging directory. */
  const copies = (from: string) => async (_url: string, dir: string) => {
    fs.cpSync(from, dir, { recursive: true });
  };

  const aSave = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmm-src-'));
    fs.writeFileSync(path.join(dir, 'profile.yaml'), 'name: Someone\n');
    fs.writeFileSync(path.join(dir, 'config.yaml'), 'ai:\n  enabled: false\n');
    fs.mkdirSync(path.join(dir, 'resumes'));
    fs.writeFileSync(path.join(dir, 'resumes', 'base.yaml'), 'id: base\nlabel: Base\nbase: true\n');
    return dir;
  };

  it('brings the save down and opens it', async () => {
    const source = aSave();
    const store = await cloneProject('git@example.com:me/save.git', into, copies(source));
    expect(store.root).toBe(fs.realpathSync(into));
    expect(fs.existsSync(path.join(into, 'profile.yaml'))).toBe(true);
    // The folders a save needs that git does not carry, because they are empty.
    expect(fs.existsSync(path.join(into, 'assets', 'inbox'))).toBe(true);
    expect(fs.existsSync(path.join(into, 'out'))).toBe(true);
  });

  /*
   * Staged beside the destination, the way creating and moving are: a clone
   * that fails halfway must not leave something that looks like a save.
   */
  it('leaves nothing behind when the clone fails', async () => {
    await expect(
      cloneProject('git@example.com:me/save.git', into, async () => {
        throw new Error('Git could not reach that repository.');
      }),
    ).rejects.toThrow(/could not reach/);
    expect(fs.existsSync(into)).toBe(false);
    expect(fs.readdirSync(path.dirname(into))).toEqual([]);
  });

  it('refuses a repository that is not a save, and leaves nothing behind', async () => {
    const notASave = fs.mkdtempSync(path.join(os.tmpdir(), 'rmm-src-'));
    fs.writeFileSync(path.join(notASave, 'README.md'), '# not a save');
    await expect(cloneProject('git@example.com:me/x.git', into, copies(notASave))).rejects.toThrow(
      /not a resume save/,
    );
    expect(fs.existsSync(into)).toBe(false);
  });

  it('will not overwrite a folder that has anything in it', async () => {
    fs.mkdirSync(into, { recursive: true });
    fs.writeFileSync(path.join(into, 'mine.txt'), 'x');
    await expect(cloneProject('git@example.com:me/save.git', into, copies(aSave()))).rejects.toThrow(
      /empty or new folder/,
    );
    expect(fs.readFileSync(path.join(into, 'mine.txt'), 'utf8')).toBe('x');
  });

  /*
   * `--upload-pack=…` and friends are options, not addresses, and git reads
   * them as options wherever they appear. A pasted string beginning with a
   * dash is either a mistake or an attempt to turn a clone into "run this".
   */
  it('refuses an address that is really an option', async () => {
    let ran = false;
    await expect(
      cloneProject('--upload-pack=touch /tmp/pwned', into, async () => {
        ran = true;
      }),
    ).rejects.toThrow(/does not look like a repository address/);
    expect(ran).toBe(false);
  });

  it('refuses an address that is not one at all', async () => {
    for (const bad of ['', '   ', 'my-repo', 'www.github.com/me/save']) {
      await expect(cloneProject(bad, into, async () => undefined)).rejects.toThrow();
    }
  });

  it('takes the addresses people actually paste', async () => {
    for (const good of [
      'https://github.com/me/save.git',
      'git@github.com:me/save.git',
      'ssh://git@example.com/me/save.git',
    ]) {
      const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rmm-clone-')), 'save');
      await expect(cloneProject(good, dir, copies(aSave()))).resolves.toBeDefined();
    }
  });

  it('insists on an absolute destination, the way every other mode does', async () => {
    await expect(cloneProject('https://example.com/x.git', 'relative/path', copies(aSave()))).rejects.toThrow(
      /absolute folder path/,
    );
  });
});
