import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import { createApi } from '../src/server/api.js';
import { Repo } from '../src/git/repo.js';
import { letterId } from '../src/jobs/answers.js';
import { DEFAULT_CONFIG } from '../src/model/types.js';
import type { Application, CoverLetter } from '../src/model/types.js';
import { makeTempStore, tempDir, type TempStore } from './helpers.js';

/*
 * Where a cover letter is filed, and what a save to it may write over.
 *
 * A letter's id is the day, the company and the role (`letterId`), and that
 * name is its file. Completing an application files its letter under it,
 * tagged `applicationId`; the extension's "Save to store", the cover-letter
 * route's `save`, the editor and undo all write under the same names. Each
 * case here is one of those writers taking a letter that was not theirs.
 */

let t: TempStore;
let app: express.Express;

function serve(config?: unknown): void {
  t = makeTempStore(config ? { config } : {});
  app = express();
  app.use(express.json());
  app.use('/api', createApi({ store: t.store, repo: Repo.forStore(t.dir) }));
}

afterEach(() => t?.cleanup());

const today = (company: string, role: string) => letterId(company, role);

function application(over: Partial<Application> & { id: string }): Application {
  return {
    company: 'Helios',
    role: 'Platform Engineer',
    resumeId: 'base',
    status: 'applied',
    appliedAt: new Date().toISOString(),
    history: [],
    ...over,
  } as Application;
}

function filedLetter(id: string, applicationId: string, body = 'Dear Helios, the letter that was sent.'): CoverLetter {
  return {
    id,
    title: 'Platform Engineer — Helios',
    company: 'Helios',
    role: 'Platform Engineer',
    createdAt: '2026-03-01T09:00:00.000Z',
    body,
    applicationId,
  };
}

describe('GET /letters/id, for a job that already has a letter filed under its name', () => {
  beforeEach(() => serve());

  it('numbers past a letter filed for a different application', async () => {
    const named = today('Helios', 'Platform Engineer');
    t.store.saveApplications([application({ id: 'app-first', url: 'https://jobs.example.com/helios/1111' })]);
    t.store.saveCoverLetter(filedLetter(named, 'app-first'));

    const res = await request(app)
      .get('/api/letters/id')
      .query({ company: 'Helios', role: 'Platform Engineer', url: 'https://jobs.example.com/helios/2222' })
      .expect(200);
    expect(res.body.id).toBe(`${named}-2`);
    expect(res.body.applicationId).toBeUndefined();
  });

  it("answers with the application's own letter, found by its address, whatever its name", async () => {
    t.store.saveApplications([
      application({
        id: 'app-first',
        url: 'https://jobs.example.com/helios/1111',
        letterId: '2026-03-01-helios-platform-engineer',
        status: 'applying',
      }),
    ]);
    t.store.saveCoverLetter(filedLetter('2026-03-01-helios-platform-engineer', 'app-first'));

    const res = await request(app)
      .get('/api/letters/id')
      .query({ company: 'Helios', role: 'Platform Engineer', url: 'https://jobs.example.com/helios/1111' })
      .expect(200);
    expect(res.body).toEqual({ id: '2026-03-01-helios-platform-engineer', applicationId: 'app-first' });
  });

  it('takes an application id it is given over the address', async () => {
    t.store.saveApplications([application({ id: 'app-second', url: 'https://jobs.example.com/helios/2222', status: 'applying' })]);
    t.store.saveCoverLetter(filedLetter('2026-03-02-helios-platform-engineer', 'app-second'));
    const res = await request(app)
      .get('/api/letters/id')
      .query({ company: 'Helios', role: 'Platform Engineer', applicationId: 'app-second' })
      .expect(200);
    expect(res.body).toEqual({ id: '2026-03-02-helios-platform-engineer', applicationId: 'app-second' });
  });

  /*
   * Coming back to a posting after sending, and pressing "Save to store",
   * wrote the new text over the letter that was sent: the application's own
   * letter was the answer whatever its status.
   */
  it('answers a name of its own, numbered past the sent letter, once the application has gone out', async () => {
    const named = today('Helios', 'Platform Engineer');
    for (const status of ['applied', 'interview', 'offer'] as const) {
      t.store.saveApplications([
        application({ id: 'app-first', url: 'https://jobs.example.com/helios/1111', letterId: named, status }),
      ]);
      t.store.saveCoverLetter(filedLetter(named, 'app-first'));
      const res = await request(app)
        .get('/api/letters/id')
        .query({ company: 'Helios', role: 'Platform Engineer', url: 'https://jobs.example.com/helios/1111' })
        .expect(200);
      expect(res.body).toEqual({ id: `${named}-2` });
    }
  });

  it('and for one closed after it went out, asked by its id', async () => {
    const named = today('Helios', 'Platform Engineer');
    t.store.saveApplications([
      application({
        id: 'app-first',
        letterId: named,
        status: 'closed',
        history: [
          { status: 'applied', at: '2026-03-01T09:00:00.000Z' },
          { status: 'closed', at: '2026-04-01T09:00:00.000Z', note: 'Rejected' },
        ],
      } as Partial<Application> & { id: string }),
    ]);
    t.store.saveCoverLetter(filedLetter(named, 'app-first'));
    const res = await request(app)
      .get('/api/letters/id')
      .query({ company: 'Helios', role: 'Platform Engineer', applicationId: 'app-first' })
      .expect(200);
    expect(res.body).toEqual({ id: `${named}-2` });
  });

  it('keeps answering the bare name when no letter holds it', async () => {
    const res = await request(app).get('/api/letters/id').query({ company: 'Helios', role: 'Platform Engineer' }).expect(200);
    expect(res.body).toEqual({ id: today('Helios', 'Platform Engineer') });
  });
});

describe("PUT /letters/:id, over another application's letter", () => {
  beforeEach(() => serve());

  it('is refused when the save says it is for a different application', async () => {
    const named = today('Helios', 'Platform Engineer');
    t.store.saveCoverLetter(filedLetter(named, 'app-first'));
    const res = await request(app)
      .put(`/api/letters/${named}`)
      .send({ title: 'Platform Engineer — Helios', body: 'Dear Helios, a different job.', applicationId: 'app-second' })
      .expect(409);
    expect(res.body.current.applicationId).toBe('app-first');
    expect(t.store.loadCoverLetters().find((l) => l.id === named)?.body).toBe('Dear Helios, the letter that was sent.');
  });

  it('is refused a new body for a letter whose application has gone out', async () => {
    const named = today('Helios', 'Platform Engineer');
    t.store.saveApplications([application({ id: 'app-first', letterId: named, status: 'applied' })]);
    t.store.saveCoverLetter(filedLetter(named, 'app-first'));
    const res = await request(app)
      .put(`/api/letters/${named}`)
      .send({ title: 'Platform Engineer — Helios', body: 'Dear Helios, a follow-up.' })
      .expect(409);
    expect(res.body.kind).toBe('conflict');
    expect(res.body.current.body).toBe('Dear Helios, the letter that was sent.');
    expect(t.store.loadCoverLetters().find((l) => l.id === named)?.body).toBe('Dear Helios, the letter that was sent.');

    // The same body, or no body, is no change to what was sent.
    await request(app).put(`/api/letters/${named}`).send({ title: 'Renamed', body: 'Dear Helios, the letter that was sent.' }).expect(200);
    await request(app).put(`/api/letters/${named}`).send({ tags: ['kept'] }).expect(200);
  });

  it('writes a sent letter when the request says it means to (the editor, `editSent=1`)', async () => {
    const named = today('Helios', 'Platform Engineer');
    t.store.saveApplications([application({ id: 'app-first', letterId: named, status: 'interview' })]);
    t.store.saveCoverLetter(filedLetter(named, 'app-first'));
    await request(app).put(`/api/letters/${named}?editSent=1`).send({ body: 'Dear Helios, corrected.' }).expect(200);
    expect(t.store.loadCoverLetters().find((l) => l.id === named)?.body).toBe('Dear Helios, corrected.');
  });

  it('writes a letter whose application has not gone out', async () => {
    const named = today('Helios', 'Platform Engineer');
    t.store.saveApplications([application({ id: 'app-first', letterId: named, status: 'applying' })]);
    t.store.saveCoverLetter(filedLetter(named, 'app-first'));
    await request(app).put(`/api/letters/${named}`).send({ body: 'Dear Helios, second draft.' }).expect(200);
    expect(t.store.loadCoverLetters().find((l) => l.id === named)?.body).toBe('Dear Helios, second draft.');
  });

  it('links an unlinked letter to the application the save names', async () => {
    t.store.saveCoverLetter({ id: 'draft-1', title: 'A draft', createdAt: '2026-03-01T09:00:00.000Z', body: 'Draft.' });
    await request(app).put('/api/letters/draft-1').send({ body: 'Draft, finished.', applicationId: 'app-first' }).expect(200);
    expect(t.store.loadCoverLetters().find((l) => l.id === 'draft-1')?.applicationId).toBe('app-first');
  });
});

describe('POST /ai/cover-letter with save', () => {
  const scripts = tempDir('rmm-letter-filing-stub-');
  const reply = 'Dear Helios team,\n\nI would like to build your ingest platform.\n\nBest,\nTest Person';

  beforeEach(() => {
    const file = path.join(scripts, `${Math.random().toString(36).slice(2)}.cjs`);
    fs.writeFileSync(file, `process.stdout.write(${JSON.stringify(reply)});\n`, 'utf8');
    serve({
      ai: { ...DEFAULT_CONFIG.ai, enabled: true, command: process.execPath, args: [file, '{prompt}'], timeoutMs: 20_000 },
      git: { autoCommit: false },
      output: { dir: 'out' },
    });
  });

  const JOB = { company: 'Helios', jobTitle: 'Platform Engineer', jobDescription: 'Streaming ingest.' };

  it("never writes over a letter an application filed", async () => {
    const named = today('Helios', 'Platform Engineer');
    t.store.saveCoverLetter(filedLetter(named, 'app-first'));
    const res = await request(app).post('/api/ai/cover-letter').send({ resumeId: 'newgrad', job: JOB, save: true }).expect(200);
    expect(res.body.saved.id).toBe(`${named}-2`);
    const filed = t.store.loadCoverLetters().find((l) => l.id === named)!;
    expect(filed).toMatchObject({ applicationId: 'app-first', createdAt: '2026-03-01T09:00:00.000Z', body: 'Dear Helios, the letter that was sent.' });
  });

  it('keeps the date and the header of its own unlinked draft when it saves it again', async () => {
    const named = today('Helios', 'Platform Engineer');
    t.store.saveCoverLetter({
      id: named,
      title: 'Platform Engineer — Helios',
      createdAt: '2026-03-01T09:00:00.000Z',
      body: 'An earlier draft.',
      tags: ['draft'],
      ...({ portal: 'Workday' } as object),
    });
    const res = await request(app).post('/api/ai/cover-letter').send({ resumeId: 'newgrad', job: JOB, save: true }).expect(200);
    expect(res.body.saved.id).toBe(named);
    const again = t.store.loadCoverLetters().find((l) => l.id === named)! as CoverLetter & { portal?: string };
    expect(again.body).toBe(reply);
    expect(again.createdAt).toBe('2026-03-01T09:00:00.000Z');
    expect(again.tags).toEqual(['draft']);
    expect(again.portal).toBe('Workday');
  });
});

describe('PUT /letters/:id?basedOn=', () => {
  beforeEach(() => serve());

  it('gives each letter a version, and refuses a save made on an older one', async () => {
    t.store.saveCoverLetter({ id: 'l1', title: 'One', createdAt: '2026-03-01T09:00:00.000Z', body: 'First text.' });
    const [opened] = (await request(app).get('/api/letters').expect(200)).body.filter((l: CoverLetter) => l.id === 'l1');
    expect(typeof opened.version).toBe('string');

    // Saved elsewhere while the box was open.
    await request(app).put('/api/letters/l1').send({ body: 'Changed in another tab.' }).expect(200);

    const refused = await request(app)
      .put(`/api/letters/l1?basedOn=${opened.version}`)
      .send({ title: 'Retitled' })
      .expect(409);
    expect(refused.body.current.body).toBe('Changed in another tab.');
    expect(t.store.loadCoverLetters().find((l) => l.id === 'l1')?.title).toBe('One');

    // Made again on what is there: only the field sent is written, and the
    // version is not written into the file.
    await request(app).put(`/api/letters/l1?basedOn=${refused.body.version}`).send({ title: 'Retitled', version: 'x' }).expect(200);
    const now = t.store.loadCoverLetters().find((l) => l.id === 'l1')! as CoverLetter & { version?: string };
    expect(now).toMatchObject({ title: 'Retitled', body: 'Changed in another tab.' });
    expect(now.version).toBeUndefined();
  });

  it('clears an optional field sent as null, as undo sends one', async () => {
    t.store.saveCoverLetter({ id: 'l2', title: 'Two', company: 'Acme', createdAt: '2026-03-01T09:00:00.000Z', body: 'Text.' });
    await request(app).put('/api/letters/l2').send({ title: 'Two', body: 'Text.', company: null }).expect(200);
    expect(t.store.loadCoverLetters().find((l) => l.id === 'l2')?.company).toBeUndefined();
  });

  it('can take away a letter, which undoing an added one needs', async () => {
    await request(app).put('/api/letters/l3').send({ title: 'Three', body: 'Text.' }).expect(200);
    await request(app).delete('/api/letters/l3').expect(200);
    expect(t.store.loadCoverLetters().some((l) => l.id === 'l3')).toBe(false);
  });

  it('dates a letter whose header had no date when it is next saved', async () => {
    t.write('letters/undated.md', '---\ntitle: Undated\n---\nBody.\n');
    await request(app).put('/api/letters/undated').send({ body: 'Body, again.' }).expect(200);
    expect(t.store.loadCoverLetters().find((l) => l.id === 'undated')?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe('DELETE /applications/:id', () => {
  beforeEach(() => serve());

  it('unlinks the letter filed for it, and keeps the letter', async () => {
    t.store.saveApplications([application({ id: 'app-gone', status: 'applying' })]);
    t.store.saveCoverLetter(filedLetter('2026-03-01-helios-platform-engineer', 'app-gone'));
    t.store.saveCoverLetter(filedLetter('2026-03-01-helios-other', 'app-kept'));
    await request(app).delete('/api/applications/app-gone').expect(200);
    const letters = t.store.loadCoverLetters();
    const kept = letters.find((l) => l.id === '2026-03-01-helios-platform-engineer')!;
    expect(kept.body).toBe('Dear Helios, the letter that was sent.');
    expect(kept.applicationId).toBeUndefined();
    expect(letters.find((l) => l.id === '2026-03-01-helios-other')?.applicationId).toBe('app-kept');
  });
});
