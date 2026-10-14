/**
 * What a whole-resume write has to be, and when a resume may be deleted.
 *
 * `PUT /resumes/:id` wrote whatever it was sent: `{}` left a file holding
 * only its id, a layout of `fontSizePt: 0` was written as asked, and an
 * object for a name was listed as "[object Object]". And `DELETE` took a
 * resume an application went out with, leaving the tracker's row showing no
 * resume.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createApi } from '../src/server/api.js';
import { Repo } from '../src/git/repo.js';
import { makeTempStore, type TempStore } from './helpers.js';

let t: TempStore;
let app: express.Express;

beforeEach(() => {
  t = makeTempStore({ config: { git: { autoCommit: false } } });
  app = express();
  app.use(express.json());
  app.use('/api', createApi({ store: t.store, repo: Repo.forStore(t.dir) }));
});

afterEach(() => t?.cleanup());

const stored = (id: string) => t.store.loadResumes().find((r) => r.id === id);
const put = (id: string, body: unknown) =>
  request(app).put(`/api/resumes/${id}`).set('Content-Type', 'application/json').send(JSON.stringify(body));

describe('writing a whole resume', () => {
  it('refuses a body that is no resume, and leaves the file as it was', async () => {
    const before = stored('intern');
    for (const body of [{}, [], { label: 'No sections' }, { sections: 'all of them' }, { sections: [], layout: [] }]) {
      const res = await put('intern', body).expect(400);
      expect(res.body.error).toBeTruthy();
    }
    expect(stored('intern')).toEqual(before);
  });

  it('refuses a layout that cannot be typeset, saying which', async () => {
    const intern = stored('intern')!;
    const res = await put('intern', { ...intern, layout: { fontSizePt: 0 } }).expect(400);
    expect(res.body.error).toMatch(/fontSizePt.*between 4 and 40/);
    await put('intern', { ...intern, layout: { marginIn: 'wide' } }).expect(400);
    await put('intern', { ...intern, layout: { fitBounds: { minFontSizePt: 2 } } }).expect(400);
    await put('intern', { ...intern, layout: { spacing: -1 } }).expect(400);
    // Wide margins are a choice the renderer can set, even if Settings would not offer them.
    await put('intern', { ...intern, layout: { marginIn: 2.6 } }).expect(200);
    await put('intern', { ...intern, layout: { fontSizePt: 11, marginIn: 0.5 } }).expect(200);
    expect(stored('intern')?.layout).toEqual({ fontSizePt: 11, marginIn: 0.5 });
  });

  it('still saves a resume whose layout was already outside them, as long as that is not what changed', async () => {
    const intern = stored('intern')!;
    t.write('resumes/intern.yaml', { ...intern, layout: { fontSizePt: 2 } });
    await put('intern', { ...intern, notes: 'An edit of something else.', layout: { fontSizePt: 2 } }).expect(200);
  });

  it('refuses a name that is not text, on a write and on a rename', async () => {
    const intern = stored('intern')!;
    await put('intern', { ...intern, label: { text: 'Intern' } }).expect(400);
    await request(app).post('/api/resumes/intern/rename').send({ label: { text: 'Intern' } }).expect(400);
    expect(stored('intern')?.label).toBe(intern.label);
  });
});

describe('deleting a resume an application went out with', () => {
  const rows = (status: string) => [
    {
      id: 'acme-1',
      company: 'Acme',
      role: 'Backend Intern',
      status,
      resumeId: 'intern',
      history: [{ at: '2026-10-01T00:00:00.000Z', status }],
    },
  ];

  it('is refused with what it went out with, and the resume kept', async () => {
    t.write('applications.yaml', rows('applied'));
    const res = await request(app).delete('/api/resumes/intern').expect(409);
    expect(res.body.kind).toBe('in-use');
    expect(res.body.applications).toEqual([{ id: 'acme-1', company: 'Acme', role: 'Backend Intern', status: 'applied' }]);
    expect(res.body.error).toMatch(/Backend Intern at Acme/);
    expect(stored('intern')).toBeDefined();
  });

  it('goes when asked twice, with force', async () => {
    t.write('applications.yaml', rows('interview'));
    await request(app).delete('/api/resumes/intern?force=1').expect(200);
    expect(stored('intern')).toBeUndefined();
  });

  it('is not refused for an application that has not gone out', async () => {
    t.write('applications.yaml', rows('applying'));
    await request(app).delete('/api/resumes/intern').expect(200);
    expect(stored('intern')).toBeUndefined();
  });
});
