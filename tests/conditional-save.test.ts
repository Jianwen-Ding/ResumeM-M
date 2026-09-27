import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { createApi } from '../src/server/api.js';
import { Repo } from '../src/git/repo.js';
import { makeTempStore, type TempStore } from './helpers.js';

/*
 * A resume written only over the write it was based on.
 *
 * The editor saves a resume whole, and JobHelper's card files its copy whole
 * with every stage. Each looked before writing, and an edit that landed
 * between the look and the write was written away. A writer that says which
 * write it built on (`basedOn`) is refused with 409 when the save has moved
 * on, and told what is there now; a writer that says nothing writes as before.
 */

let t: TempStore;
let app: express.Express;

beforeEach(() => {
  t = makeTempStore();
  app = express();
  app.use('/api', createApi({ store: t.store, repo: Repo.forStore(t.dir) }));
});
afterEach(() => t.cleanup());

const stored = (id: string) => t.store.load().resumes.find((r) => r.id === id)!;
const versionOf = async (id: string): Promise<string> => (await request(app).get('/api/store').expect(200)).body.versions[id];
const save = (id: string, spec: object, query = '') =>
  request(app).put(`/api/resumes/${id}${query}`).send({ ...spec, id });
/** A later write of the same file, as anything else in the save would make one. */
const pause = () => new Promise((go) => setTimeout(go, 5));

describe('the editor’s save of a resume', () => {
  it('writes over the write it was based on, and says which write it made', async () => {
    const was = await versionOf('intern');
    expect(was).toMatch(/^[0-9a-f]{20}$/);
    const res = await save('intern', { ...stored('intern'), label: 'Summer, typed here' }, `?commit=0&basedOn=${was}`).expect(200);
    expect(stored('intern').label).toBe('Summer, typed here');
    const now = await versionOf('intern');
    expect(now).not.toBe(was);
    expect(res.headers.etag).toBe(`"${now}"`);
  });

  it('is refused over a write it did not see, with the resume as it is now, and writes nothing', async () => {
    const was = await versionOf('intern');
    await pause();
    await save('intern', { ...stored('intern'), label: 'Renamed by the card' }).expect(200);
    const theirs = await versionOf('intern');

    const res = await save('intern', { ...stored('intern'), label: 'Typed in the editor' }, `?commit=0&basedOn=${was}`).expect(409);
    expect(res.body).toMatchObject({ kind: 'conflict', id: 'intern', version: theirs });
    expect(res.body.current.label).toBe('Renamed by the card');
    expect(res.body.error).toMatch(/changed elsewhere/);
    expect(stored('intern').label).toBe('Renamed by the card');
    expect(await versionOf('intern')).toBe(theirs);
  });

  it('is refused over a write that put the resume back exactly as it was', async () => {
    const before = stored('intern');
    await save('intern', before).expect(200); // the file as a save writes it
    const file = () => fs.readFileSync(path.join(t.store.root, 'resumes', 'intern.yaml'), 'utf8');
    const bytes = file();
    const was = await versionOf('intern');
    await pause();
    await save('intern', { ...before, label: 'Briefly renamed' }).expect(200);
    await pause();
    await save('intern', before).expect(200);
    expect(file(), 'byte for byte what it was').toBe(bytes);

    await save('intern', { ...before, label: 'Typed in the editor' }, `?basedOn=${was}`).expect(409);
    expect(stored('intern').label).toBe(before.label);
  });

  it('without one, writes whatever is there, as it always did', async () => {
    await save('intern', { ...stored('intern'), label: 'Renamed by the card' }).expect(200);
    await save('intern', { ...stored('intern'), label: 'From the CLI' }, '?commit=0').expect(200);
    expect(stored('intern').label).toBe('From the CLI');
  });

  it('keeps refusing a deleted resume with `existing=1`, and writes one back without it', async () => {
    const was = await versionOf('intern');
    const spec = stored('intern');
    await request(app).delete('/api/resumes/intern').expect(200);
    await save('intern', spec, `?existing=1&basedOn=${was}`).expect(404);
    await save('intern', spec, `?basedOn=${was}`).expect(200);
    expect(stored('intern').label).toBe(spec.label);
  });
});

describe('the card filing its copy', () => {
  const copy = () => ({
    ...stored('intern'),
    id: 'job-helios-platform',
    label: 'Platform Engineer — Helios',
    tier: 'temporary',
    copiedFrom: 'intern',
    generatedFor: { company: 'Helios', role: 'Platform Engineer', at: new Date().toISOString() },
  });
  const workspace = (body: Record<string, unknown>) =>
    request(app).post('/api/workspace').send({ company: 'Helios', role: 'Platform Engineer', ...body });

  it('says which write the store holds when asked whether its copy is fresh', async () => {
    await workspace({ spec: copy() }).expect(200);
    const fresh = await request(app).post('/api/extension/fresh').send({ spec: copy() }).expect(200);
    expect(fresh.body.version).toBe(await versionOf('job-helios-platform'));
  });

  it('is filed with the workspace over the write it was based on, and told the write it made', async () => {
    const first = await workspace({ spec: copy(), basedOn: null }).expect(200);
    expect(first.body.resumeVersion).toBe(await versionOf('job-helios-platform'));
    await pause();
    const second = await workspace({ spec: { ...copy(), label: 'Filed again' }, basedOn: first.body.resumeVersion }).expect(200);
    expect(stored('job-helios-platform').label).toBe('Filed again');
    expect(second.body.resumeVersion).not.toBe(first.body.resumeVersion);
  });

  it('is not filed with the workspace over an edit it did not see, and neither is the workspace', async () => {
    const first = await workspace({ spec: copy(), basedOn: null }).expect(200);
    await pause();
    await save('job-helios-platform', { ...stored('job-helios-platform'), label: 'Edited in ResumeM-M' }).expect(200);
    const drafts = t.store.loadDrafts().length;

    const res = await request(app)
      .post('/api/workspace')
      .send({ company: 'Helios', role: 'Staff Engineer', spec: copy(), basedOn: first.body.resumeVersion })
      .expect(409);
    expect(res.body.current.label).toBe('Edited in ResumeM-M');
    expect(stored('job-helios-platform').label).toBe('Edited in ResumeM-M');
    expect(t.store.loadDrafts().length, 'no space was opened').toBe(drafts);
  });

  it('with `basedOn: null`, is filed only where there is no copy yet', async () => {
    await save('job-helios-platform', { ...copy(), label: 'Already there' }).expect(200);
    const res = await workspace({ spec: copy(), basedOn: null }).expect(409);
    expect(res.body.current.label).toBe('Already there');
    expect(stored('job-helios-platform').label).toBe('Already there');
  });

  it('is not staged over an edit it did not see, and nothing of the application is written', async () => {
    const first = await workspace({ spec: copy(), basedOn: null }).expect(200);
    await pause();
    await save('job-helios-platform', { ...stored('job-helios-platform'), label: 'Edited in ResumeM-M' }).expect(200);
    const apps = t.store.load().applications.length;

    const res = await request(app)
      .post('/api/applications/bundle')
      .send({ company: 'Helios', role: 'Platform Engineer', status: 'applying', spec: copy(), basedOn: first.body.resumeVersion })
      .expect(409);
    expect(res.body).toMatchObject({ kind: 'conflict', id: 'job-helios-platform' });
    expect(res.body.current.label).toBe('Edited in ResumeM-M');
    expect(stored('job-helios-platform').label).toBe('Edited in ResumeM-M');
    expect(t.store.load().applications.length, 'nothing was filed').toBe(apps);
  });

  it('without one, is filed with the workspace over whatever is there, as before', async () => {
    await save('job-helios-platform', { ...copy(), label: 'Edited in ResumeM-M' }).expect(200);
    await workspace({ spec: copy() }).expect(200);
    expect(stored('job-helios-platform').label).toBe('Platform Engineer — Helios');
  });
});
