/**
 * A temporary resume that was sent, written as kept where every version of
 * the app reads it.
 *
 * This version keeps a sent temporary resume for good (`wentOut` in
 * model/tiers.ts). The version before it reads only the tier, starts the week
 * at `applied`, and deletes it — and both open the same clone. Measured with
 * both on one save: this version kept the sent copy, the previous one started
 * a minute later and swept it, and committed the deletion. So the keep is
 * written on the file, as `extended` (never swept by any version), and read
 * back here as the temporary copy it still is.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { Repo } from '../src/git/repo.js';
import { advance } from '../src/model/applications.js';
import { wouldSweep } from '../src/server/sweep.js';
import { makeTempStore, type TempStore } from './helpers.js';
import type { Application } from '../src/model/types.js';

let t: TempStore;
afterEach(() => t?.cleanup());

const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString();

/** The file as written, which is what another version of the app reads. */
const onDisk = (id: string) =>
  YAML.parse(fs.readFileSync(path.join(t.dir, 'resumes', `${id}.yaml`), 'utf8')) as Record<string, unknown>;

/** What the previous version decides, from the file alone: it knows only the tier. */
const previousVersionWouldSweep = (id: string) => (onDisk(id).tier ?? 'extended') === 'temporary';

function seed(status: Application['status'], extra: Partial<Application> = {}, config?: unknown) {
  t = makeTempStore(config ? { config } : {});
  t.write('resumes/job-acme.yaml', {
    id: 'job-acme',
    label: 'Backend Engineer — Acme',
    tier: 'temporary',
    temporaryFrom: daysAgo(30),
    generatedFor: { company: 'Acme', role: 'Backend Engineer', at: daysAgo(30) },
    sections: [{ kind: 'education', entries: ['edu_neu'] }],
  });
  t.write('applications.yaml', [
    {
      id: 'a1',
      company: 'Acme',
      role: 'Backend Engineer',
      status,
      resumeId: 'job-acme',
      appliedAt: daysAgo(20),
      history: [{ at: daysAgo(20), status }],
      ...extra,
    },
  ]);
}

describe('a row moving past Applying', () => {
  it('writes its temporary resume as kept, and this version still reads it as temporary', () => {
    seed('applying');
    expect(previousVersionWouldSweep('job-acme')).toBe(true);

    advance(t.store, 'a1', 'applied', 'Sent');

    const file = onDisk('job-acme');
    expect(file.tier).toBe('extended');
    expect(file.temporaryFrom).toBeUndefined();
    expect(file.keptBecauseSent).toBe(true);
    expect(previousVersionWouldSweep('job-acme')).toBe(false);

    const read = t.store.loadResumes().find((r) => r.id === 'job-acme')!;
    expect(read.tier).toBe('temporary');
    // And this version's sweep keeps it, as it always did.
    expect(wouldSweep(t.store)).toEqual([]);
  });

  it('leaves one whose row is still being worked on', () => {
    seed('interested');
    advance(t.store, 'a1', 'applying');
    expect(onDisk('job-acme').tier).toBe('temporary');
    expect(onDisk('job-acme').keptBecauseSent).toBeUndefined();
  });

  it('leaves a resume somebody marked as a base or kept exactly as it is', () => {
    seed('applying');
    t.write('resumes/job-acme.yaml', { id: 'job-acme', label: 'Acme', tier: 'base', sections: [] });
    advance(t.store, 'a1', 'applied');
    expect(onDisk('job-acme')).toEqual({ id: 'job-acme', label: 'Acme', tier: 'base', sections: [] });
  });

  it('writes it in the same commit as the row', async () => {
    seed('applying', {}, { ai: { enabled: false }, git: { autoCommit: true }, output: { dir: 'out' } });
    const repo = Repo.forStore(t.dir);
    await repo.ensure();
    await repo.commitAll('Before');
    const { default: express } = await import('express');
    const { default: request } = await import('supertest');
    const { createApi } = await import('../src/server/api.js');
    const server = express();
    server.use(express.json());
    server.use('/api', createApi({ store: t.store, repo }));

    const res = await request(server).post('/api/applications/a1/status').send({ status: 'interview' });
    expect(res.status).toBe(200);
    expect(await repo.pending()).toEqual([]);
    expect(previousVersionWouldSweep('job-acme')).toBe(false);
  });
});

describe('a row remembering the resume it was sent with', () => {
  it('writes that resume as kept when it is added to sentResumeIds', () => {
    // A sent row whose resume was a base, which nothing sweeps; the copy
    // sent with it as well is remembered when the row moves on.
    seed('applied', { resumeId: 'base' });
    t.write('resumes/job-acme-2.yaml', { id: 'job-acme-2', label: 'Acme again', tier: 'extended', sections: [] });
    const apps = t.store.load().applications;
    t.store.saveApplications(apps.map((a) => ({ ...a, resumeId: 'job-acme-2', sentResumeIds: ['job-acme'] })));

    expect(onDisk('job-acme').tier).toBe('extended');
    expect(onDisk('job-acme').keptBecauseSent).toBe(true);
  });
});

describe('writing a sent resume again', () => {
  it('keeps writing it as kept, whatever tier the writer sent', () => {
    seed('applying');
    advance(t.store, 'a1', 'applied');
    // The card filing its copy again, as the temporary copy it reads it as.
    const spec = t.store.loadResumes().find((r) => r.id === 'job-acme')!;
    t.store.saveResume({ ...spec, tier: 'temporary', keptBecauseSent: undefined, temporaryFrom: daysAgo(1) });
    expect(onDisk('job-acme').tier).toBe('extended');
    expect(onDisk('job-acme').temporaryFrom).toBeUndefined();
  });

  it('is plainly kept once somebody marks it Kept', async () => {
    seed('applying');
    advance(t.store, 'a1', 'applied');
    const { default: express } = await import('express');
    const { default: request } = await import('supertest');
    const { createApi } = await import('../src/server/api.js');
    const server = express();
    server.use(express.json());
    server.use('/api', createApi({ store: t.store, repo: Repo.forStore(t.dir) }));

    const res = await request(server).put('/api/resumes/job-acme/tier').send({ tier: 'extended' });
    expect(res.status).toBe(200);
    expect(onDisk('job-acme').keptBecauseSent).toBeUndefined();
    expect(t.store.loadResumes().find((r) => r.id === 'job-acme')!.tier).toBe('extended');
  });
});

describe('opening a save whose sent resumes are still written as temporary', () => {
  it('writes them as kept in one commit, and commits nothing on the next start', async () => {
    const { openSave } = await import('../src/server/index.js');
    seed('applied', {}, { ai: { enabled: false }, git: { autoCommit: true }, output: { dir: 'out' } });
    const repo = Repo.forStore(t.dir);
    await repo.ensure();
    // The sample save's own migrations out of the way, so what is counted is this.
    t.store.migrateResumes();
    await repo.commitAll('Written by the previous version');
    const before = (await repo.log(50)).length;

    await openSave(t.store, repo);

    expect(previousVersionWouldSweep('job-acme')).toBe(false);
    expect(t.exists('resumes/job-acme.yaml')).toBe(true);
    const log = await repo.log(50);
    expect(log.length).toBe(before + 1);
    expect(log[0]!.message).toMatch(/Keep 1 sent resume/);
    expect(await repo.pending()).toEqual([]);

    await openSave(t.store, repo);
    expect((await repo.log(50)).length).toBe(before + 1);
  });

  it('leaves one that was never sent to the sweep', async () => {
    const { openSave } = await import('../src/server/index.js');
    seed('applying');
    const repo = Repo.forStore(t.dir);
    await repo.ensure();
    await openSave(t.store, repo);
    expect(onDisk('job-acme').tier).toBe('temporary');
  });
});

/*
 * Kept on disk, and nothing in the tracker naming it any more: the row
 * deleted, or filed again from another resume without remembering this one.
 * `asLoaded` read it back as temporary, `doneAt` dated it from the day it was
 * made, and the sweep took the only record of what was sent — the one thing
 * `extended` on the file promises no version of the app will do.
 */
describe('a resume kept on disk for being sent, once no row names it', () => {
  it('is not swept', async () => {
    const { sweepTemporary } = await import('../src/server/sweep.js');
    t = makeTempStore({ config: { ai: { enabled: false }, git: { autoCommit: true }, output: { dir: 'out' } } });
    t.write('resumes/job-acme.yaml', {
      id: 'job-acme',
      label: 'Backend Engineer — Acme',
      tier: 'extended',
      keptBecauseSent: true,
      generatedFor: { company: 'Acme', role: 'Backend Engineer', at: daysAgo(90) },
      sections: [{ kind: 'education', entries: ['edu_neu'] }],
    });
    t.write('applications.yaml', []);
    const repo = Repo.forStore(t.dir);
    await repo.ensure();
    await repo.commitAll('Before');

    expect(t.store.loadResumes().find((r) => r.id === 'job-acme')!.tier).toBe('temporary');
    expect(wouldSweep(t.store)).toEqual([]);
    const { swept } = await sweepTemporary(t.store, repo);
    expect(swept).toEqual([]);
    expect(onDisk('job-acme').tier).toBe('extended');
  });

  it('is not swept after its row is deleted', () => {
    seed('applying');
    advance(t.store, 'a1', 'applied');
    t.store.saveApplications([]);
    expect(onDisk('job-acme').tier).toBe('extended');
    expect(wouldSweep(t.store)).toEqual([]);
  });

  it('is swept once the file itself says temporary again', () => {
    // A version that knows nothing of the flag marked it temporary: the
    // file's own tier is the answer then (see `asLoaded`).
    t = makeTempStore();
    t.write('resumes/job-acme.yaml', {
      id: 'job-acme',
      label: 'Backend Engineer — Acme',
      tier: 'temporary',
      keptBecauseSent: true,
      temporaryFrom: daysAgo(30),
      generatedFor: { company: 'Acme', role: 'Backend Engineer', at: daysAgo(90) },
      sections: [{ kind: 'education', entries: ['edu_neu'] }],
    });
    t.write('applications.yaml', []);
    expect(wouldSweep(t.store).map((d) => d.id)).toEqual(['job-acme']);
  });
});
