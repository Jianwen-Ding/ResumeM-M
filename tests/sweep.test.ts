import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

    const { swept } = await sweepTemporary(temp.store, Repo.forStore(temp.dir));

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
