import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createApi } from '../src/server/api.js';
import { Repo } from '../src/git/repo.js';
import { makeTempStore, type TempStore } from './helpers.js';

/**
 * The resume-centric version history reads real commits back off disk, so
 * these tests use a genuine (auto-committing) git repo rather than mocking
 * git away — the whole point of the feature is "what did this file actually
 * look like at each commit".
 */
let t: TempStore;
let app: express.Express;
let repo: Repo;

beforeEach(async () => {
  t = makeTempStore({ config: { ai: { enabled: false }, git: { autoCommit: true }, output: { dir: 'out' } } });
  repo = Repo.forStore(t.dir);
  await repo.ensure();
  app = express();
  app.use('/api', createApi({ store: t.store, repo }));
});
afterEach(() => t.cleanup());

describe('GET /resumes/:id/history', () => {
  it('is empty for a resume nobody has ever committed', async () => {
    const res = await request(app).get('/api/resumes/does-not-exist/history').expect(200);
    expect(res.body.versions).toEqual([]);
  });

  it('reports the first version as "created"', async () => {
    const res = await request(app).get('/api/resumes/newgrad/history').expect(200);
    expect(res.body.versions).toHaveLength(1);
    expect(res.body.versions[0].changes).toEqual([
      { kind: 'created', text: 'First version — "New grad"' },
    ]);
  });

  it('describes a phrasing change in words, newest version first', async () => {
    await request(app)
      .put('/api/resumes/newgrad')
      .send({ label: 'New grad', extends: 'base', choices: { 'edu_neu.dates': 'v_dec2026' } })
      .expect(200);

    const res = await request(app).get('/api/resumes/newgrad/history').expect(200);
    expect(res.body.versions).toHaveLength(2);
    // Newest first.
    expect(res.body.versions[0].changes.some((c: { kind: string }) => c.kind === 'choice')).toBe(true);
    expect(res.body.versions[0].changes[0].text).toContain('May 2026');
    expect(res.body.versions[0].changes[0].text).toContain('Dec 2026');
    expect(res.body.versions[1].changes[0].kind).toBe('created');
  });

  it('describes a reverted choice as reverting to the default wording', async () => {
    await request(app)
      .put('/api/resumes/newgrad')
      .send({ label: 'New grad', extends: 'base', choices: {} })
      .expect(200);
    const res = await request(app).get('/api/resumes/newgrad/history').expect(200);
    expect(res.body.versions[0].changes[0]).toEqual({
      kind: 'choice',
      text: 'Northeastern University: reverted to the default wording',
    });
  });

  it('describes a label rename and an extends change', async () => {
    await request(app)
      .put('/api/resumes/newgrad')
      .send({ label: 'New grad (renamed)', choices: { 'edu_neu.dates': 'v_may2026' } })
      .expect(200);
    const res = await request(app).get('/api/resumes/newgrad/history').expect(200);
    const changes = res.body.versions[0].changes;
    expect(changes).toContainEqual({ kind: 'label', text: 'Renamed to "New grad (renamed)"' });
    expect(changes).toContainEqual({ kind: 'extends', text: 'No longer inherits from another resume' });
  });

  it('describes entries and bullets being shown or hidden', async () => {
    // First make both bullets explicit, so the next save has something to
    // remove — inclusion is diffed against the previous *explicit* choice,
    // not against the extended default.
    await request(app)
      .put('/api/resumes/newgrad')
      .send({
        label: 'New grad',
        extends: 'base',
        choices: { 'edu_neu.dates': 'v_may2026' },
        sections: [{ kind: 'experience', entries: ['exp_acme'], bullets: { exp_acme: ['b_pipeline', 'b_testing'] } }],
      })
      .expect(200);

    await request(app)
      .put('/api/resumes/newgrad')
      .send({
        label: 'New grad',
        extends: 'base',
        choices: { 'edu_neu.dates': 'v_may2026' },
        sections: [{ kind: 'experience', entries: ['exp_acme'], bullets: { exp_acme: ['b_pipeline'] } }],
      })
      .expect(200);

    const res = await request(app).get('/api/resumes/newgrad/history').expect(200);
    const changes = res.body.versions[0].changes;
    expect(changes).toContainEqual({ kind: 'bullet', text: 'Raised coverage from 41% to 88%: hidden' });
  });

  it('describes an entry disappearing from a section entirely', async () => {
    await request(app)
      .put('/api/resumes/newgrad')
      .send({
        label: 'New grad',
        extends: 'base',
        choices: { 'edu_neu.dates': 'v_may2026' },
        sections: [{ kind: 'project', entries: ['proj_thing'] }],
      })
      .expect(200);
    await request(app)
      .put('/api/resumes/newgrad')
      .send({
        label: 'New grad',
        extends: 'base',
        choices: { 'edu_neu.dates': 'v_may2026' },
        sections: [{ kind: 'project', entries: [] }],
      })
      .expect(200);
    const res = await request(app).get('/api/resumes/newgrad/history').expect(200);
    const changes = res.body.versions[0].changes;
    expect(changes).toContainEqual({ kind: 'entry', text: 'Thing: hidden' });
  });

  it('describes a change in how many list items are shown', async () => {
    await request(app)
      .put('/api/resumes/newgrad')
      .send({ label: 'New grad', extends: 'base', lists: { b_course: ['x', 'y'] } })
      .expect(200);
    const res = await request(app).get('/api/resumes/newgrad/history').expect(200);
    const changes = res.body.versions[0].changes;
    expect(changes.some((c: { kind: string; text: string }) => c.kind === 'list' && c.text.includes('2 items'))).toBe(
      true,
    );
  });

  it('reports no meaningful change for a no-op save', async () => {
    await request(app)
      .put('/api/resumes/newgrad')
      .send({ label: 'New grad', extends: 'base', choices: { 'edu_neu.dates': 'v_may2026' } })
      .expect(200);
    const res = await request(app).get('/api/resumes/newgrad/history').expect(200);
    expect(res.body.versions[0].changes).toEqual([
      { kind: 'none', text: 'No meaningful change (formatting only)' },
    ]);
  });
});

describe('POST /resumes/:id/history/:hash/restore', () => {
  it('rolls a resume back to exactly what an earlier version said', async () => {
    const first = await request(app).get('/api/resumes/newgrad/history').expect(200);
    const originalHash = first.body.versions[0].hash;

    await request(app)
      .put('/api/resumes/newgrad')
      .send({ label: 'New grad', extends: 'base', choices: { 'edu_neu.dates': 'v_dec2026' } })
      .expect(200);

    const restored = await request(app)
      .post(`/api/resumes/newgrad/history/${originalHash}/restore`)
      .expect(200);
    expect(restored.body.choices?.['edu_neu.dates']).toBe('v_may2026');

    const resolved = await request(app).get('/api/resumes/newgrad/resolved').expect(200);
    const dates = resolved.body.sections
      .flatMap((s: { entries: { id: string; dates: string }[] }) => s.entries)
      .find((e: { id: string }) => e.id === 'edu_neu')?.dates;
    expect(dates).toBe('Sep. 2022 -- May 2026');

    // Restoring is itself a new version, so the history keeps growing rather
    // than being rewritten.
    const after = await request(app).get('/api/resumes/newgrad/history').expect(200);
    expect(after.body.versions).toHaveLength(3);
    expect(after.body.versions[0].message).toBe('Restore "newgrad" to an earlier version');
  });

  it('rejects a hash the resume never had', async () => {
    const res = await request(app).post('/api/resumes/newgrad/history/0000000000000000/restore');
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
