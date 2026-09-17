import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Repo } from '../src/git/repo.js';
import { describePending, saveStore } from '../src/git/save.js';

let root: string;
let repo: Repo;

const write = (rel: string, text: string) => {
  const f = path.join(root, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text, 'utf8');
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'rmm-save-'));
  repo = Repo.forStore(root);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('describePending', () => {
  it('names the parts of the store that changed, not the filenames', () => {
    expect(
      describePending([
        { path: 'resumes/newgrad.yaml', state: 'modified' },
        { path: 'resumes/intern.yaml', state: 'added' },
        { path: 'answers.yaml', state: 'modified' },
      ]),
    ).toBe('Save: 2 resumes, the answer bank');
  });

  it('counts the countable things and leaves the rest alone', () => {
    expect(describePending([{ path: 'letters/a.md', state: 'added' }])).toBe('Save: 1 cover letter');
    expect(describePending([{ path: 'profile.yaml', state: 'modified' }])).toBe('Save: the profile');
    expect(describePending([{ path: 'experience.yaml', state: 'modified' }])).toBe('Save: entries');
    expect(describePending([{ path: 'voice.md', state: 'modified' }])).toBe('Save: voice notes');
  });

  it('summarises rather than listing everything when a lot changed', () => {
    const message = describePending([
      { path: 'resumes/a.yaml', state: 'modified' },
      { path: 'letters/a.md', state: 'added' },
      { path: 'drafts/a.yaml', state: 'added' },
      { path: 'corpus/a.md', state: 'added' },
      { path: 'answers.yaml', state: 'modified' },
      { path: 'profile.yaml', state: 'modified' },
    ]);
    expect(message).toContain('and 2 more');
  });

  it('falls back to something sensible when nothing is pending', () => {
    expect(describePending([])).toBe('Save store');
  });
});

describe('saveStore', () => {
  it('makes a store into a repository and reports the files it saved', async () => {
    write('profile.yaml', 'name: Test Person\n');
    write('resumes/newgrad.yaml', 'id: newgrad\n');

    const result = await saveStore(repo);
    expect(result.initialised).toBe(true);
    expect(result.saved).toBe(true);
    // `.gitignore` is written the first time, and reported rather than
    // hidden: it is a file in the user's folder that they did not create, and
    // a save that lists what it saved should list it. See `ignoreDerived`.
    expect(result.files.map((f) => f.path).sort()).toEqual(['.gitignore', 'profile.yaml', 'resumes/newgrad.yaml']);
    expect(await repo.isRepo()).toBe(true);
  });

  it('commits later hand edits with a message derived from them', async () => {
    write('profile.yaml', 'name: Test Person\n');
    await saveStore(repo);

    write('resumes/newgrad.yaml', 'id: newgrad\nlabel: New grad\n');
    write('answers.yaml', '[]\n');
    const result = await saveStore(repo);

    expect(result.initialised).toBe(false);
    expect(result.saved).toBe(true);
    expect(result.message).toBe('Save: 1 resume, the answer bank');
    expect((await repo.log(1))[0]?.message).toBe('Save: 1 resume, the answer bank');
  });

  it('takes the message it is given', async () => {
    write('profile.yaml', 'name: Test Person\n');
    await saveStore(repo);
    write('profile.yaml', 'name: Someone Else\n');

    const result = await saveStore(repo, { message: '  Before the Streamly interview  ' });
    expect(result.message).toBe('Before the Streamly interview');
    expect((await repo.log(1))[0]?.message).toBe('Before the Streamly interview');
  });

  it('says nothing was saved rather than making an empty commit', async () => {
    write('profile.yaml', 'name: Test Person\n');
    await saveStore(repo);
    const commits = (await repo.log(50)).length;

    const result = await saveStore(repo);
    expect(result.saved).toBe(false);
    expect(result.files).toEqual([]);
    expect((await repo.log(50)).length).toBe(commits);
  });

  it('records a deletion as a deletion', async () => {
    write('profile.yaml', 'name: Test Person\n');
    write('resumes/old.yaml', 'id: old\n');
    await saveStore(repo);

    fs.rmSync(path.join(root, 'resumes/old.yaml'));
    const result = await saveStore(repo);
    expect(result.files).toEqual([{ path: 'resumes/old.yaml', state: 'deleted' }]);
    expect(await repo.show((await repo.log(1))[0]!.hash, 'profile.yaml')).toContain('Test Person');
  });

  it('pushes when asked, and reports the remote afterwards', async () => {
    const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'rmm-remote-'));
    try {
      execFileSync('git', ['init', '--bare', '-q', remote]);
      write('profile.yaml', 'name: Test Person\n');
      await saveStore(repo);
      await repo.setRemote(remote);

      write('answers.yaml', '[]\n');
      const result = await saveStore(repo, { push: true });

      expect(result.saved).toBe(true);
      expect(result.pushed?.ok).toBe(true);
      expect(result.remote.tracked).toBe(true);
      expect(result.remote.ahead).toBe(0);

      const onRemote = execFileSync('git', ['-C', remote, 'log', '--oneline'], { encoding: 'utf8' });
      expect(onRemote).toContain('Save: the answer bank');
    } finally {
      fs.rmSync(remote, { recursive: true, force: true });
    }
  });

  it('pushes even when there was nothing new to commit locally', async () => {
    const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'rmm-remote-'));
    try {
      execFileSync('git', ['init', '--bare', '-q', remote]);
      write('profile.yaml', 'name: Test Person\n');
      await saveStore(repo);
      await repo.setRemote(remote);

      // An earlier save committed but never reached the remote.
      const result = await saveStore(repo, { push: true });
      expect(result.saved).toBe(false);
      expect(result.pushed?.ok).toBe(true);
      expect(execFileSync('git', ['-C', remote, 'log', '--oneline'], { encoding: 'utf8' })).toContain('Initialise');
    } finally {
      fs.rmSync(remote, { recursive: true, force: true });
    }
  });

  it('reports a failed push instead of throwing, so the commit still counts', async () => {
    write('profile.yaml', 'name: Test Person\n');
    await saveStore(repo);
    await repo.setRemote(path.join(root, 'nowhere.git'));

    write('answers.yaml', '[]\n');
    const result = await saveStore(repo, { push: true });

    expect(result.saved).toBe(true); // the work is committed locally
    expect(result.pushed?.ok).toBe(false);
    expect(result.pushed?.output).toBeTruthy();
  });
});

describe('Repo.pending', () => {
  it('is empty for a directory that is not a repository', async () => {
    expect(await repo.pending()).toEqual([]);
  });

  it('reports added, modified, and deleted files', async () => {
    write('a.yaml', 'one\n');
    write('b.yaml', 'two\n');
    await saveStore(repo);

    write('a.yaml', 'one changed\n');
    write('c.yaml', 'three\n');
    fs.rmSync(path.join(root, 'b.yaml'));

    expect(await repo.pending()).toEqual([
      { path: 'a.yaml', state: 'modified' },
      { path: 'b.yaml', state: 'deleted' },
      { path: 'c.yaml', state: 'added' },
    ]);
  });

  it('handles paths with spaces, which git quotes in its own output', async () => {
    write('resumes/new grad.yaml', 'id: newgrad\n');
    const pending = await repo.pending();
    expect(pending).toHaveLength(0); // not a repo yet

    await saveStore(repo);
    write('resumes/new grad.yaml', 'id: newgrad\nlabel: x\n');
    expect(await repo.pending()).toEqual([{ path: 'resumes/new grad.yaml', state: 'modified' }]);
  });
});

/*
 * A save keeps what was sent and rebuilds the rest.
 *
 * Saves created through the app put `out/` inside themselves, and everything
 * inside a save is committed — so looking at a resume put another copy of its
 * compiled PDF into the history, on a repository whose whole point is that it
 * stays small and readable. The snapshot of an application is the exception:
 * that is the record of what actually went out, and it is kept byte for byte.
 */
describe('what goes into the history', () => {
  const tracked = () =>
    execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);

  const laydown = () => {
    write('profile.yaml', 'name: Test Person\n');
    write('out/base.pdf', '%PDF-1.7 pretend\n');
    write('out/base.tex', '\\documentclass{article}\n');
    write('out/current/.rmm-current.json', '["Test-Person-Resume.pdf"]\n');
    write('out/current/Test-Person-Resume.pdf', '%PDF-1.7 pretend\n');
    write('out/applications/2026-09-16-acme-swe/Test-Person-Resume.pdf', '%PDF-1.7 what was sent\n');
    write('out/applications/2026-09-16-acme-swe/source/resolved.yaml', 'spec: {}\n');
  };

  it('keeps the application snapshots and leaves the previews out', async () => {
    laydown();
    await saveStore(repo);

    const files = tracked();
    expect(files).toContain('out/applications/2026-09-16-acme-swe/Test-Person-Resume.pdf');
    expect(files).toContain('out/applications/2026-09-16-acme-swe/source/resolved.yaml');
    expect(files).toContain('profile.yaml');
    expect(files).not.toContain('out/base.pdf');
    expect(files).not.toContain('out/base.tex');
    expect(files.some((f) => f.startsWith('out/current/'))).toBe(false);

    // And recompiling a preview does not make the save look unsaved.
    write('out/base.pdf', '%PDF-1.7 compiled again\n');
    expect(await repo.pending()).toHaveLength(0);
  });

  it('untracks previews a save was already carrying, without deleting them', async () => {
    // A repository from before this rule: everything committed, previews too.
    write('profile.yaml', 'name: Test Person\n');
    await repo.ensure();
    fs.rmSync(path.join(root, '.gitignore'));
    laydown();
    execFileSync('git', ['add', '-A'], { cwd: root });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'everything'], { cwd: root });
    expect(tracked()).toContain('out/base.pdf');

    await saveStore(repo, { message: 'tidy' });

    expect(tracked()).not.toContain('out/base.pdf');
    expect(tracked()).toContain('out/applications/2026-09-16-acme-swe/Test-Person-Resume.pdf');
    // The file itself is untouched: the preview on screen must not blink.
    expect(fs.existsSync(path.join(root, 'out/base.pdf'))).toBe(true);
  });

  it('leaves a save that is not a repository alone', async () => {
    laydown();
    await repo.ignoreDerived();
    expect(fs.existsSync(path.join(root, '.gitignore'))).toBe(false);
    expect(await repo.isRepo()).toBe(false);
  });
});
