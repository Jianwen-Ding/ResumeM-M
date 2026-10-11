import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import { createApi } from '../src/server/api.js';
import { Repo } from '../src/git/repo.js';
import { stats } from '../src/model/applications.js';
import type { Application, CoverLetter } from '../src/model/types.js';
import { makeTempStore, type TempStore } from './helpers.js';

/*
 * The bundle compile is LaTeX, and what is being tested around it here is
 * what the route files afterwards: the letter, under which name. Stood in for
 * by a row like the one the real build writes, so the test runs on a machine
 * with no TeX install.
 */
vi.mock('../src/model/applications.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/model/applications.js')>();
  return {
    ...real,
    buildBundle: vi.fn(async (store: import('../src/model/store.js').Store, req: { company: string; role: string; url?: string; resumeId?: string }) => {
      const apps = store.load().applications;
      const existing = real.findApplication(apps, req.company, req.role, req.url);
      const application: Application = existing ?? {
        id: real.freshApplicationId(apps, req.company, req.role),
        company: req.company,
        role: req.role,
        status: 'applied',
        appliedAt: new Date().toISOString(),
        resumeId: req.resumeId,
        history: [{ at: new Date().toISOString(), status: 'applied' }],
      };
      store.upsertApplication(application);
      return { application, dir: store.root, files: [], pages: 1, fits: true, warnings: [] };
    }),
  };
});

let t: TempStore;
let app: express.Express;
let repo: Repo;

beforeEach(() => {
  t = makeTempStore();
  repo = Repo.forStore(t.dir);
  app = express();
  app.use('/api', createApi({ store: t.store, repo }));
});
afterEach(() => t.cleanup());

const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();

/** Run `change` after the sweep's status check, just before it deletes. */
function meanwhile(change: () => void | Promise<void>) {
  const pending = repo.pending.bind(repo);
  repo.pending = async (...args: Parameters<Repo['pending']>) => {
    const answer = await pending(...args);
    await change();
    return answer;
  };
}

/*
 * Listing the Workspace retires the sent spaces gone quiet, and it waits on
 * git to do it. A space reopened or edited in that wait was answered 200 and
 * then deleted, edit and all.
 */
describe('a sent workspace edited while it is being retired', () => {
  beforeEach(async () => {
    t.write('drafts/d1.yaml', {
      id: 'd1',
      company: 'Acme',
      role: 'Engineer',
      status: 'submitted',
      createdAt: ago(30),
      updatedAt: ago(30),
      coverLetter: { required: true, body: 'The letter that was sent.' },
      questions: [],
    });
    await repo.ensure();
    await repo.commitAll('Before the list');
  });

  it('is kept when it was reopened', async () => {
    meanwhile(() => {
      t.store.saveDraft({ ...t.store.getDraft('d1')!, status: 'drafting' });
    });
    const list = await request(app).get('/api/workspace').expect(200);
    expect(list.body.drafts.map((d: { id: string }) => d.id)).toContain('d1');
    expect(t.store.getDraft('d1')?.status).toBe('drafting');
  });

  it('is kept when it was edited and is still marked sent', async () => {
    meanwhile(() => {
      const d = t.store.getDraft('d1')!;
      t.store.saveDraft({ ...d, coverLetter: { ...d.coverLetter, body: 'The one they asked for again.' } });
    });
    await request(app).get('/api/workspace').expect(200);
    expect(t.store.getDraft('d1')?.coverLetter.body).toBe('The one they asked for again.');
  });

  it('and still goes when nobody touched it', async () => {
    const list = await request(app).get('/api/workspace').expect(200);
    expect(list.body.drafts).toEqual([]);
    expect(t.exists('drafts/d1.yaml')).toBe(false);
  });
});

/*
 * "Record an application" sends whichever resume is open, because that is
 * the resume a brand-new row was most likely sent with. Over a row the
 * tracker already had, it re-pointed the row at `base` — and the tailored
 * resume the interview was got with became an expiring temporary copy.
 */
describe('recording an application the tracker already has', () => {
  beforeEach(() => {
    t.write('resumes/acme-eng.yaml', {
      id: 'acme-eng',
      label: 'Acme copy',
      tier: 'temporary',
      temporaryFrom: ago(20),
      copiedFrom: 'base',
      sections: [{ kind: 'education', entries: ['edu_neu'] }],
    });
    t.write('applications.yaml', [
      {
        id: 'a1',
        company: 'Acme',
        role: 'Engineer',
        url: 'https://acme.example/jobs/1',
        status: 'interview',
        appliedAt: ago(20),
        resumeId: 'acme-eng',
        history: [
          { at: ago(20), status: 'applied' },
          { at: ago(3), status: 'interview' },
        ],
      },
    ]);
  });

  it('keeps the resume it was sent with', async () => {
    const res = await request(app)
      .post('/api/applications')
      .send({ company: 'Acme', role: 'Engineer', url: '', notes: 'Phone screen went well', resumeId: 'base' })
      .expect(200);
    expect(res.body.id).toBe('a1');
    expect(res.body.resumeId).toBe('acme-eng');
    const due = await request(app).get('/api/resumes/expiring').expect(200);
    expect(due.body.due.map((d: { id: string }) => d.id)).not.toContain('acme-eng');
  });

  it('but changes it when the row is named by id', async () => {
    const res = await request(app)
      .post('/api/applications')
      .send({ id: 'a1', company: 'Acme', role: 'Engineer', resumeId: 'base' })
      .expect(200);
    expect(res.body.resumeId).toBe('base');
  });

  it('and a new row still takes the one that is open', async () => {
    const res = await request(app)
      .post('/api/applications')
      .send({ company: 'Beta', role: 'Engineer', resumeId: 'base' })
      .expect(200);
    expect(res.body.resumeId).toBe('base');
  });
});

/*
 * The letter a completed workspace files was named for the day and the
 * company alone, so two roles at one company sent on one day wrote the same
 * file, and the second application's letter replaced the first's.
 */
describe('the letter a completed workspace files', () => {
  const complete = async (role: string) => {
    const created = await request(app)
      .post('/api/workspace')
      .send({ company: 'Acme', role, resumeId: 'base', coverLetterRequired: true, questions: [] })
      .expect(200);
    const draft = created.body.draft;
    draft.coverLetter.body = `Dear Acme, about the ${role} role.`;
    await request(app).put(`/api/workspace/${draft.id}`).send(draft).expect(200);
    return (await request(app).post(`/api/workspace/${draft.id}/complete`).send({}).expect(200)).body;
  };
  const letters = () => t.store.loadCoverLetters();

  it('is its own for each role at the same company', async () => {
    const before = letters().length;
    const first = await complete('Backend Engineer');
    const second = await complete('Frontend Engineer');
    expect(first.application.letterId).not.toBe(second.application.letterId);
    expect(letters()).toHaveLength(before + 2);
    const byId = (id: string) => letters().find((l) => l.id === id) as CoverLetter;
    expect(byId(first.application.letterId).body).toMatch(/Backend/);
    expect(byId(second.application.letterId).body).toMatch(/Frontend/);
  });

  it('takes a number rather than another application’s letter', async () => {
    const first = await complete('Engineer');
    // Another application's letter, under the name this one would take.
    const theirs = letters().find((l) => l.id === first.application.letterId)!;
    t.store.saveCoverLetter({ ...theirs, applicationId: 'someone-else' });
    const again = await request(app).post('/api/workspace').send({ company: 'Acme', role: 'Engineer', questions: [] });
    const done = (await request(app).post(`/api/workspace/${again.body.draft.id}/complete`).send({}).expect(200)).body;
    expect(done.application.letterId).toBe(`${first.application.letterId}-2`);
    expect(letters().find((l) => l.id === first.application.letterId)?.applicationId).toBe('someone-else');
  });

  it('but completing the same one again keeps its own letter', async () => {
    const before = letters().length;
    const first = await complete('Engineer');
    const draft = t.store.getDraft(first.application.id) ?? t.store.loadDrafts()[0]!;
    const done = (await request(app).post(`/api/workspace/${draft.id}/complete`).send({}).expect(200)).body;
    expect(done.application.letterId).toBe(first.application.letterId);
    expect(letters()).toHaveLength(before + 1);
  });
});

/*
 * "Sent in the last week" counted rows by when they were started, so a row
 * opened a month ago and sent yesterday was not in it, and one started this
 * week and sent the same week as an old one was.
 */
describe('the tracker’s sent-lately counts', () => {
  it('count by the day it was sent', () => {
    const counted = stats([
      {
        id: 'a',
        company: 'A',
        role: 'R',
        status: 'applied',
        appliedAt: ago(40),
        history: [
          { at: ago(40), status: 'applying' },
          { at: ago(1), status: 'applied' },
        ],
      },
    ]);
    expect(counted.last7).toBe(1);
    expect(counted.last30).toBe(1);
  });

  it('and by when it was recorded when there is no send in the history', () => {
    const counted = stats([{ id: 'a', company: 'A', role: 'R', status: 'applied', appliedAt: ago(2) }]);
    expect(counted.last7).toBe(1);
  });
});

describe('requests that would have written nonsense', () => {
  it('a status that is missing or not a stage is refused', async () => {
    const { body } = await request(app).post('/api/applications').send({ company: 'A', role: 'B' }).expect(200);
    await request(app).post(`/api/applications/${body.id}/status`).send({}).expect(400);
    await request(app).post(`/api/applications/${body.id}/status`).send({ status: 'bogus' }).expect(400);
    expect(t.store.load().applications.find((a) => a.id === body.id)?.status).toBe('applied');
    await request(app).post(`/api/applications/${body.id}/status`).send({ status: 'interview' }).expect(200);
  });

  it('a profile that is not one is refused, and the file is left alone', async () => {
    const before = fs.readFileSync(path.join(t.dir, 'profile.yaml'), 'utf8');
    await request(app).put('/api/profile').send([]).expect(400);
    await request(app).put('/api/profile').send({}).expect(400);
    expect(fs.readFileSync(path.join(t.dir, 'profile.yaml'), 'utf8')).toBe(before);
    await request(app).put('/api/profile').send({ name: 'Renamed' }).expect(200);
  });

  it('a letter with no body is refused rather than saved as "undefined"', async () => {
    await request(app).put('/api/letters/x1').send({ title: 'T' }).expect(400);
    expect(t.exists('letters/x1.md')).toBe(false);
    await request(app).put('/api/letters/x1').send({ title: 'T', body: 'Dear X,' }).expect(200);
  });

  it('an entry saved with only some of its fields keeps the rest, and its file', async () => {
    const stored = t.store.load().entries.find((e) => e.id === 'edu_neu')!;
    await request(app).put('/api/entries/edu_neu').send({ title: 'Renamed University' }).expect(200);
    const now = t.store.load().entries.find((e) => e.id === 'edu_neu')!;
    expect(now.title).toBe('Renamed University');
    expect(now.kind).toBe(stored.kind);
    expect(now.dates).toEqual(stored.dates);
    expect(t.exists('custom.yaml') && fs.readFileSync(path.join(t.dir, 'custom.yaml'), 'utf8').includes('edu_neu')).toBe(false);
  });

  it('but a whole entry still clears what it leaves out', async () => {
    const stored = t.store.load().entries.find((e) => e.id === 'edu_neu')!;
    expect(stored.location).toBeTruthy();
    const { location: _gone, ...rest } = stored;
    await request(app).put('/api/entries/edu_neu').send(rest).expect(200);
    expect(t.store.load().entries.find((e) => e.id === 'edu_neu')?.location).toBeUndefined();
  });
});

describe('the answer bank asked through the server', () => {
  it('does not treat a version label as an employer, and does treat the tracker\'s employers as ones', async () => {
    const { default: express } = await import('express');
    const { default: request } = await import('supertest');
    const { createApi } = await import('../src/server/api.js');
    const { Repo } = await import('../src/git/repo.js');
    const { makeTempStore } = await import('./helpers.js');
    const t = makeTempStore({ config: { git: { autoCommit: false }, output: { dir: 'out' } } });
    try {
      t.store.saveAnswers([
        { id: 'a1', question: 'Desired employment type', default: 'v1', variants: [{ id: 'v1', label: 'Full', text: 'Full-time' }] },
        { id: 'a2', question: 'Why do you want to work here?', default: 'v1', variants: [{ id: 'v1', label: 'Long', text: 'I have admired Globex for years.' }] },
      ] as never);
      t.store.saveApplications([{ id: 'x', company: 'Globex', role: 'Engineer', status: 'applied', appliedAt: '2026-01-01T00:00:00Z', history: [] }] as never);
      const app = express();
      app.use(express.json());
      app.use('/api', createApi({ store: t.store, repo: Repo.forStore(t.dir) }));
      const res = await request(app)
        .post('/api/answers/match')
        .send({ questions: ['Desired employment type', 'Why do you want to work here?'], company: 'Acme' })
        .expect(200);
      const [type, why] = res.body.matches;
      expect(type.confident).toBe(true);
      expect(why.confident).toBe(false);
      expect(why.namesAnother).toBe('Globex');
    } finally {
      t.cleanup();
    }
  });
});
