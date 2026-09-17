import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isEmptyStore, resolveStoreDir, seedStore } from '../src/model/location.js';

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
