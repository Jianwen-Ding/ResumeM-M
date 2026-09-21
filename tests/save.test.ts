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
    /*
     * `.gitignore` is one of the files a store has. It is written when the
     * repository is made — see `Repo.IGNORED`, which keeps half-built
     * application folders out of the walk `git add` does — so it is saved
     * with everything else rather than appearing untracked afterwards.
     */
    expect(result.files.map((f) => f.path).sort()).toEqual([
      '.gitignore',
      'profile.yaml',
      'resumes/newgrad.yaml',
    ]);
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

  /*
   * And a push that cannot even be attempted is still a failed push, not a
   * failed save.
   *
   * `repo.push` throws for the two cases it cannot act on — no remote
   * configured, HEAD detached — and that throw went past the whole report:
   * `rmm save --push -m "keep my work"` printed "No remote is configured for
   * the store", exited 1, and said nothing about the commit it had just made.
   * The command whose job is to make "is my work safe?" unambiguous left it
   * maximally ambiguous.
   */
  it('reports a push it could not even start, and still reports the save', async () => {
    write('profile.yaml', 'name: Test Person\n');
    await saveStore(repo);
    write('answers.yaml', '[]\n');

    const result = await saveStore(repo, { push: true, message: 'keep my work' });

    expect(result.saved).toBe(true);
    expect(result.message).toBe('keep my work');
    expect((await repo.log(1))[0]?.message).toBe('keep my work');
    expect(result.pushed?.ok).toBe(false);
    expect(result.pushed?.output).toMatch(/no remote/i);
  });

  /*
   * The message on a store's very first save, which went nowhere.
   *
   * `ensure` makes the initial commit itself, so `pending()` came back empty,
   * `commitAll(message)` never ran, and the "report that first commit as the
   * save it was" branch overwrote the message from HEAD. `rmm save -m "my
   * very first save of real work"` put that sentence in no commit and printed
   * "Saved 15 files — Initialise resume store" as though it were the user's.
   */
  it('uses the message it was given for the very first save too', async () => {
    write('profile.yaml', 'name: Test Person\n');
    write('resumes/newgrad.yaml', 'id: newgrad\n');

    const result = await saveStore(repo, { message: 'my very first save of real work' });

    expect(result.initialised).toBe(true);
    expect(result.saved).toBe(true);
    expect(result.message).toBe('my very first save of real work');
    expect((await repo.log(1))[0]?.message).toBe('my very first save of real work');
  });

  it('and still names it for itself when no message was given', async () => {
    write('profile.yaml', 'name: Test Person\n');
    const result = await saveStore(repo);
    expect(result.message).toBe('Initialise resume store');
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
 * Everything in the save is in the save.
 *
 * `out/` lives inside a save made through the app, so the compiled previews
 * and the flat upload folder are versioned along with the snapshots of what
 * was sent. That is deliberate, and it is what "my work is in git" is taken
 * to mean: nothing in the folder is quietly left out of the history, and a
 * clone of the save is the save.
 *
 * It was briefly not true — previews were ignored to keep the history small —
 * and small was not what was wanted.
 */
describe('what goes into the history', () => {
  const tracked = () =>
    execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);

  it('keeps everything in the save folder, previews and snapshots alike', async () => {
    write('profile.yaml', 'name: Test Person\n');
    write('voice.md', 'I write plainly.\n');
    write('corpus/letter-1.md', '---\nkind: letter\n---\nDear sir\n');
    write('applications.yaml', '- id: a\n  company: Acme\n');
    write('out/base.pdf', '%PDF-1.7 a preview\n');
    write('out/current/Test-Person-Resume.pdf', '%PDF-1.7 ready to upload\n');
    write('out/applications/2026-09-16-acme-swe/Test-Person-Resume.pdf', '%PDF-1.7 what was sent\n');
    write('out/applications/2026-09-16-acme-swe/source/resolved.yaml', 'spec: {}\n');

    await saveStore(repo);

    const files = tracked();
    for (const kept of [
      'profile.yaml',
      'voice.md',
      'corpus/letter-1.md',
      'applications.yaml',
      'out/base.pdf',
      'out/current/Test-Person-Resume.pdf',
      'out/applications/2026-09-16-acme-swe/Test-Person-Resume.pdf',
      'out/applications/2026-09-16-acme-swe/source/resolved.yaml',
    ]) {
      expect(files, kept).toContain(kept);
    }
  });

  it('notices a recompiled preview as something to save', async () => {
    write('profile.yaml', 'name: Test Person\n');
    write('out/base.pdf', '%PDF-1.7 one\n');
    await saveStore(repo);

    write('out/base.pdf', '%PDF-1.7 two\n');
    expect(await repo.pending()).toEqual([{ path: 'out/base.pdf', state: 'modified' }]);
  });
});

/**
 * "Nothing to save" has to mean git looked and found nothing.
 *
 * `pending()` swallowed every way git can refuse to answer and returned an
 * empty list, and `saveStore` reads that list as the whole question: nothing
 * pending means nothing to commit, reported as `saved: false` and documented
 * as "everything was already committed — *not an error*". So a store whose
 * index a killed git process had left truncated came back from `rmm save` as
 * nothing-to-save, exit 0, and from the editor's Save button as success. The
 * one command whose entire job is to make "is my work safe?" unambiguous
 * answered yes without having asked.
 */
describe('a save that could not look', () => {
  it('fails rather than reporting that everything was already committed', async () => {
    write('profile.yaml', 'name: Test Person\n');
    await saveStore(repo);

    // Exactly what a killed `git add` leaves behind. `rev-parse` still
    // answers, so this is a repository by every check before the status.
    write('resumes/newgrad.yaml', 'id: newgrad\n');
    fs.writeFileSync(path.join(root, '.git', 'index'), 'not an index', 'utf8');

    await expect(saveStore(repo)).rejects.toThrow(/index|corrupt|fatal/i);
  });

  it('and a store that is simply not a repository yet is still not an error', async () => {
    // The one empty answer that is true, and the one this must keep giving.
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'rmm-bare-'));
    try {
      expect(await Repo.forStore(bare).pending()).toEqual([]);
    } finally {
      fs.rmSync(bare, { recursive: true, force: true });
    }
  });
});
