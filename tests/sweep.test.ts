import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { Repo } from '../src/git/repo.js';
import { sweepTemporary, temporaryDays, wouldSweep } from '../src/server/sweep.js';
import { makeTempStore } from './helpers.js';
import type { Application, ResumeSpec } from '../src/model/types.js';

/*
 * Taking away the resumes that were made for one posting and are done with.
 *
 * The only thing in this program that deletes something nobody asked it to
 * delete. What makes that acceptable is that nothing is lost: the store is a
 * git repository, the sweep commits, and a swept resume comes back out of the
 * history the same way a deleted entry does — so the tests below check the
 * commit as carefully as they check the deletion, because without the commit
 * this is the one unrecoverable act in the program.
 *
 * The files that were *sent* live in the application's snapshot folder and
 * are not touched by any of this. The sweep removes the recipe, never the
 * document.
 */

let temp: ReturnType<typeof makeTempStore>;
const DAY = 24 * 60 * 60 * 1000;

beforeEach(() => {
  temp = makeTempStore();
});
afterEach(() => temp.cleanup());

const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString();

function planted(extra: Partial<ResumeSpec> = {}, apps: Application[] = []) {
  temp.write('resumes/job-old.yaml', {
    id: 'job-old',
    label: 'Backend Engineer — Acme',
    tier: 'temporary',
    temporaryFrom: daysAgo(30),
    sections: [{ kind: 'education', entries: ['edu_neu'] }],
    ...extra,
  });
  temp.write('applications.yaml', apps);
}

describe('what the sweep would take', () => {
  it('is a week by default, and says so', () => {
    expect(temporaryDays(temp.store)).toBe(7);
  });

  it('follows the save when it has been told otherwise', () => {
    temp.store.saveConfig({ resumes: { temporaryDays: 30 } });
    expect(temporaryDays(temp.store)).toBe(30);
  });

  it('names what is due, before anything happens to it', () => {
    planted();
    const due = wouldSweep(temp.store);
    expect(due.map((d) => d.id)).toEqual(['job-old']);
    // By the name its owner gave it, because that is what a confirmation
    // would have to show.
    expect(due[0]?.label).toBe('Backend Engineer — Acme');
  });

  it('takes nothing while the window is switched off', () => {
    planted();
    temp.store.saveConfig({ resumes: { temporaryDays: 0 } });
    expect(wouldSweep(temp.store)).toEqual([]);
  });
});

describe('sweeping', () => {
  it('removes the file, and leaves everything else where it was', async () => {
    planted();
    const others = temp.store.loadResumes().filter((r) => r.id !== 'job-old').map((r) => r.id);
    // A repository, because a save that has none is one where nothing can be
    // got back and the sweep declines to take anything — see the last block
    // of this file.
    const repo = Repo.forStore(temp.dir);
    await repo.ensure();

    const { swept } = await sweepTemporary(temp.store, repo);

    expect(swept.map((d) => d.id)).toEqual(['job-old']);
    expect(temp.exists('resumes/job-old.yaml')).toBe(false);
    expect(temp.store.loadResumes().map((r) => r.id).sort()).toEqual(others.sort());
  });

  /*
   * The half that makes the deletion acceptable. Auto-commit is off in these
   * fixtures on purpose: it is a setting about whether your *edits* are
   * recorded as you make them, and this is not an edit you made.
   */
  it('commits what it took, whatever auto-commit is set to', async () => {
    planted();
    expect(temp.store.loadConfig().git.autoCommit).toBe(false);

    const repo = Repo.forStore(temp.dir);
    await repo.ensure();
    await repo.commitAll('Before the sweep');

    await sweepTemporary(temp.store, repo);

    const [latest] = await repo.log(1);
    expect(latest?.message).toMatch(/Sweep/);
    // And by name, so the history says what to go looking for.
    expect(latest?.message).toMatch(/Backend Engineer — Acme/);
  });

  /*
   * And it commits nothing else.
   *
   * The filing commit that runs first is scoped, and says why: "the rest of
   * the save is somebody's work in progress and this is no reason to commit
   * it for them". The deletion commit one line below it was not, so it was
   * `git add -- .`: opening the app half-way through hand-editing the profile,
   * with one resume due, put the unfinished profile into the history under
   * "Sweep …, temporary and done with". Auto-commit being off made it worse
   * rather than better — the setting that says "do not record my edits as I
   * make them" was overruled by the one pass that had just finished saying it
   * was not recording anybody's edits.
   */
  it('leaves work in progress out of the history', async () => {
    planted();
    const repo = Repo.forStore(temp.dir);
    await repo.ensure();
    await repo.commitAll('Before the sweep');

    // Something the user is in the middle of, saved to disk and not committed.
    temp.write('profile.yaml', { name: 'Half A Name', email: '' });

    const { swept } = await sweepTemporary(temp.store, repo);
    expect(swept.map((d) => d.id)).toEqual(['job-old']);

    const [latest] = await repo.log(1);
    const changed = await repo.commit(latest!.hash);
    expect(changed?.files.map((f) => f.path)).toEqual(['resumes/job-old.yaml']);

    // And it is still sitting there, uncommitted, exactly as it was left.
    expect((temp.read('profile.yaml') as { name: string }).name).toBe('Half A Name');
    const waiting = await repo.pending();
    expect(waiting.map((f) => f.path)).toContain('profile.yaml');
  });

  it('is one commit however many it took', async () => {
    for (const n of [1, 2, 3, 4]) {
      temp.write(`resumes/job-${n}.yaml`, {
        id: `job-${n}`,
        label: `Role ${n}`,
        tier: 'temporary',
        temporaryFrom: daysAgo(30),
      });
    }
    const repo = Repo.forStore(temp.dir);
    await repo.ensure();
    await repo.commitAll('Before the sweep');
    const before = (await repo.log(50)).length;

    const { swept } = await sweepTemporary(temp.store, repo);

    expect(swept).toHaveLength(4);
    expect((await repo.log(50)).length).toBe(before + 1);
    // Named with the first few and a count, rather than a wall of titles.
    const [latest] = await repo.log(1);
    expect(latest?.message).toMatch(/and 1 more/);
  });

  it('does nothing, and commits nothing, when nothing is due', async () => {
    const repo = Repo.forStore(temp.dir);
    await repo.ensure();
    await repo.commitAll('Before the sweep');
    const before = (await repo.log(50)).length;

    const { swept } = await sweepTemporary(temp.store, repo);

    expect(swept).toEqual([]);
    expect((await repo.log(50)).length).toBe(before);
  });

  /*
   * The rule that costs the sweep most of its work. Somebody is about to ask
   * you about the document you sent them, and it is the last one to delete.
   */
  it('leaves one whose application is still live', async () => {
    planted({}, [
      {
        id: 'a1',
        company: 'Acme',
        role: 'Backend Engineer',
        status: 'interview',
        resumeId: 'job-old',
        appliedAt: daysAgo(60),
      } as Application,
    ]);

    const { swept } = await sweepTemporary(temp.store, Repo.forStore(temp.dir));

    expect(swept).toEqual([]);
    expect(temp.exists('resumes/job-old.yaml')).toBe(true);
  });

  it('leaves one that was promoted out of temporary', async () => {
    planted({ tier: 'extended' });
    const { swept } = await sweepTemporary(temp.store, Repo.forStore(temp.dir));
    expect(swept).toEqual([]);
    expect(temp.exists('resumes/job-old.yaml')).toBe(true);
  });

  /*
   * And a resume that says nothing about tiers at all. A file written by an
   * older version, or by hand, must not be deleted because a field appeared
   * under it — which is why absent means kept rather than temporary.
   */
  it('never takes one that has no tier written on it', async () => {
    temp.write('resumes/handmade.yaml', {
      id: 'handmade',
      label: 'Written by hand',
      generatedFor: { company: 'Acme', role: 'Dev', at: daysAgo(400) },
    });
    // Read, not migrated: the shape a save is in before anything upgrades it.
    const { swept } = await sweepTemporary(temp.store, Repo.forStore(temp.dir));
    expect(swept).toEqual([]);
    expect(temp.exists('resumes/handmade.yaml')).toBe(true);
  });

  it('can be recovered from the history afterwards', async () => {
    planted();
    const repo = Repo.forStore(temp.dir);
    await repo.ensure();
    await repo.commitAll('Before the sweep');
    const [was] = await repo.log(1);

    await sweepTemporary(temp.store, repo);
    expect(temp.exists('resumes/job-old.yaml')).toBe(false);

    // The whole basis on which deleting it is allowed at all.
    const tree = await repo.treeAt(was!.hash);
    const objectId = tree.get('resumes/job-old.yaml');
    expect(objectId).toBeTruthy();
    expect(await repo.blob(objectId!)).toMatch(/Backend Engineer/);
  });
});

/*
 * A resume that is not in the history at all.
 *
 * Every test above commits the fixture before sweeping it, which is a
 * precondition, not a fact. "Save history" is a setting people switch off,
 * and even left on a commit that fails is a console warning with no retry —
 * so a resume written by the extension can sit on disk, in no commit, for the
 * whole week it takes to become sweepable.
 *
 * Committing the *deletion* of a file git has never seen recovers nothing.
 * The commit is made, the sweep reports success, the editor says "Swept 1",
 * the server log says "They are in the version history", and the resume is
 * gone — the one unrecoverable act in the program, performed silently.
 *
 * Found by running the sweep in the order the server actually does it:
 * `ensure()` at boot, the resume written afterwards, nothing in between.
 */
describe('a resume the history has never had', () => {
  /** What `rmm serve` leaves behind at boot, and nothing more. */
  async function justOpened() {
    const repo = Repo.forStore(temp.dir);
    await repo.ensure();
    return repo;
  }

  it('is filed before it is taken, so it can be got back', async () => {
    const repo = await justOpened();
    planted();
    expect(temp.store.loadConfig().git.autoCommit).toBe(false);

    const { swept } = await sweepTemporary(temp.store, repo);

    expect(swept.map((d) => d.id)).toEqual(['job-old']);
    expect(temp.exists('resumes/job-old.yaml')).toBe(false);

    // Somewhere in the history — the commit the sweep made before its own.
    const found = await Promise.all(
      (await repo.log(10)).map(async (entry) => (await repo.treeAt(entry.hash)).get('resumes/job-old.yaml')),
    );
    const objectId = found.find(Boolean);
    expect(objectId, 'no commit in the history holds the swept resume').toBeTruthy();
    expect(await repo.blob(objectId!)).toMatch(/Backend Engineer/);
  });

  it('files only what it is about to take, not the rest of the save', async () => {
    const repo = await justOpened();
    planted();
    // Work in progress. It is not what this commit is about, and a version in
    // the history called "File …, about to be swept" that turns out to hold
    // somebody's half-finished edit is a version they cannot use.
    temp.write('resumes/in-progress.yaml', { id: 'in-progress', label: 'Half done', tier: 'extended' });

    await sweepTemporary(temp.store, repo);

    const filing = (await repo.log(10)).find((entry) => entry.message.startsWith('File '));
    expect(filing, 'nothing in the history filed the resume before it went').toBeTruthy();
    const tree = await repo.treeAt(filing!.hash);
    expect(tree.has('resumes/job-old.yaml')).toBe(true);
    expect(tree.has('resumes/in-progress.yaml')).toBe(false);
  });

  /*
   * And the part that cannot be wrong, because it asks git rather than
   * trusting that git did as it was told. Filing is the fix; this is the net
   * under it, for a save whose history is not working at all — no repository,
   * a lock left by a crashed git, a disk with nothing left on it.
   */
  it('is left alone when it could not be filed', async () => {
    // A store that is not a repository: `rmm serve` calls `ensure()`, but the
    // CLI and the MCP tools write to saves that have never been saved.
    planted();

    const { swept, held } = await sweepTemporary(temp.store, Repo.forStore(temp.dir));

    expect(swept).toEqual([]);
    expect(held.map((d) => d.id)).toEqual(['job-old']);
    expect(temp.exists('resumes/job-old.yaml')).toBe(true);
  });

  it('says which ones it kept, by the name their owner gave them', async () => {
    planted();
    const { held } = await sweepTemporary(temp.store, Repo.forStore(temp.dir));
    expect(held[0]?.label).toBe('Backend Engineer — Acme');
  });

  /*
   * Filing several is still one commit, for the same reason the sweep itself
   * is: a history with eleven entries between two versions is a history
   * nobody reads, and this one exists to be read.
   */
  it('files them all together, not one commit each', async () => {
    const repo = await justOpened();
    for (const n of [1, 2, 3]) {
      temp.write(`resumes/job-${n}.yaml`, {
        id: `job-${n}`,
        label: `Role ${n}`,
        tier: 'temporary',
        temporaryFrom: daysAgo(30),
      });
    }
    const before = (await repo.log(50)).length;

    const { swept } = await sweepTemporary(temp.store, repo);

    expect(swept).toHaveLength(3);
    // One to file them, one to take them.
    expect((await repo.log(50)).length).toBe(before + 2);
  });
});

/**
 * A resume whose newest version the history has never had.
 *
 * The block above covers a file git has never seen at all. This is the other
 * half, and it was passing the check: `filedPaths` is HEAD's *tree*, so it
 * says the path is in the history, not that the version about to be deleted
 * is. A resume committed a fortnight ago and edited every day since satisfied
 * it exactly as well as one committed a second ago.
 *
 * A fortnight of uncommitted edits is an ordinary state, not a contrived one.
 * The filing commit the sweep makes first is allowed to fail quietly — the
 * doc on `removeWhatIsFiled` says so — and every commit this program makes is
 * a console warning nobody reads when it fails. `commit.gpgsign` set with no
 * usable key does it; so does a `pre-commit` hook that exits non-zero.
 */
describe('a resume the history has an older version of', () => {
  /** Commits succeed, then stop, the way a signing or hook failure does. */
  function commitsStopWorking() {
    fs.writeFileSync(
      path.join(temp.dir, '.git', 'hooks', 'pre-commit'),
      '#!/bin/sh\nexit 1\n',
      { mode: 0o755 },
    );
  }

  it('is held rather than taken, and said out loud', async () => {
    planted();
    const repo = Repo.forStore(temp.dir);
    await repo.ensure();
    await repo.commitAll('A fortnight ago');

    // Edited since, and every commit since has failed.
    commitsStopWorking();
    temp.write('resumes/job-old.yaml', {
      id: 'job-old',
      label: 'Backend Engineer — Acme',
      tier: 'temporary',
      temporaryFrom: daysAgo(30),
      notes: 'Everything I learned in the fortnight since it was last committed.',
    });

    const { swept, held } = await sweepTemporary(temp.store, repo);

    expect(swept).toEqual([]);
    expect(held.map((d) => d.id)).toEqual(['job-old']);
    expect(temp.exists('resumes/job-old.yaml')).toBe(true);
    expect(String((temp.read('resumes/job-old.yaml') as { notes: string }).notes)).toMatch(/fortnight/);
  });

  it('and is taken once the history has the version on disk', async () => {
    planted();
    const repo = Repo.forStore(temp.dir);
    await repo.ensure();
    await repo.commitAll('A fortnight ago');

    const { swept } = await sweepTemporary(temp.store, repo);
    expect(swept.map((d) => d.id)).toEqual(['job-old']);
  });
});

/*
 * Opening a save brings it up to date, and with auto-commit on, what that
 * wrote is a version of its own.
 *
 * The migrations wrote the files and committed nothing, so after the start
 * `git status` listed every resume and config.yaml as changed, and they rode
 * into whatever commit came next — a bullet edit, a tracked application —
 * under a message that had nothing to do with them.
 */
describe('opening a save written by an older version', () => {
  it('commits what the migrations wrote, under their own name', async () => {
    const { openSave } = await import('../src/server/index.js');
    temp.store.saveConfig({ git: { autoCommit: true } });
    const repo = Repo.forStore(temp.dir);
    await repo.ensure();
    const before = (await repo.log(50)).length;

    await openSave(temp.store, repo);

    expect(await repo.pending(), 'nothing is left changed and uncommitted').toEqual([]);
    const log = await repo.log(50);
    expect(log.length).toBeGreaterThan(before);
    expect(log.map((c) => c.message).join('\n')).toMatch(/up to date/i);
  });

  it('commits nothing when auto-commit is off', async () => {
    const { openSave } = await import('../src/server/index.js');
    const repo = Repo.forStore(temp.dir);
    await repo.ensure();
    const before = (await repo.log(50)).length;

    await openSave(temp.store, repo);

    expect((await repo.log(50)).length).toBe(before);
  });
});
