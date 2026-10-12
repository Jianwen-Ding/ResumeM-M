/**
 * Writes made while a pull is stopped on a conflict, through the routes that
 * wrote first and asked about git afterwards.
 *
 * A document added or removed:
 * Both routes wrote first and asked `withCommit` second, with an empty `fn`,
 * so the outside-git check refused after the file was already on (or off) the
 * disk: a 400 saying "Not saved" about a document that was saved, and the
 * panel then listing a document that was gone. A refusal has to mean nothing
 * happened.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import express from 'express';
import { createApi } from '../src/server/api.js';
import { Repo } from '../src/git/repo.js';
import { makeTempStore, type TempStore } from './helpers.js';

let t: TempStore;
let app: express.Express;
let mergeHead: string;

beforeEach(async () => {
  t = makeTempStore();
  const repo = Repo.forStore(t.store.root);
  await repo.ensure();
  app = express();
  app.use(express.json({ limit: '32mb' }));
  app.use('/api', createApi({ store: t.store, repo }));
  mergeHead = path.join(t.store.root, '.git', 'MERGE_HEAD');
});
afterEach(() => t.cleanup());

const pdf = (text: string) => Buffer.from(`%PDF-1.4 ${text}`).toString('base64');
const listed = async () =>
  ((await request(app).get('/api/documents')).body.documents as { name: string }[]).map((d) => d.name);
const stopMidMerge = () => {
  const head = execFileSync('git', ['-C', t.store.root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  fs.writeFileSync(mergeHead, `${head}\n`);
};

describe('documents while a pull is half done', () => {
  it('refuses an upload without writing it', async () => {
    stopMidMerge();
    const r = await request(app).post('/api/documents').send({ name: 'Transcript.pdf', data: pdf('x') });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/^Not saved/);
    expect(await listed()).not.toContain('Transcript.pdf');
    expect(fs.existsSync(path.join(t.store.root, 'documents', 'Transcript.pdf'))).toBe(false);
  });

  it('refuses a delete without deleting', async () => {
    expect((await request(app).post('/api/documents').send({ name: 'Other.pdf', data: pdf('y') })).status).toBe(200);
    stopMidMerge();
    const r = await request(app).delete('/api/documents/Other.pdf');
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/^Not saved/);
    expect(await listed()).toContain('Other.pdf');
  });

  it('still saves and removes once the pull is finished', async () => {
    stopMidMerge();
    fs.rmSync(mergeHead);
    expect((await request(app).post('/api/documents').send({ name: 'CV.pdf', data: pdf('z') })).status).toBe(200);
    expect(await listed()).toContain('CV.pdf');
    expect((await request(app).delete('/api/documents/CV.pdf')).body.ok).toBe(true);
    expect(await listed()).not.toContain('CV.pdf');
  });
});

/*
 * The two routes that build an application wrote the bundle, the tracker row
 * and the rest before the first `withCommit` they reached — or reached none at
 * all — so a merge stopped on a conflict either answered "Not saved" about an
 * application that had been filed, or let it be written for the pull to
 * overwrite.
 */
describe('building an application while a pull is half done', () => {
  it('refuses a bundle before writing anything', async () => {
    stopMidMerge();
    const r = await request(app).post('/api/applications/bundle').send({ company: 'Streamly', role: 'Data Intern', resumeId: 'intern' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/^Not saved/);
    expect(t.store.load().applications).toHaveLength(0);
  });

  it('refuses to complete a workspace before writing anything', async () => {
    const created = await request(app)
      .post('/api/workspace')
      .send({ company: 'Acme', role: 'Platform Engineer', resumeId: 'intern', coverLetterRequired: false, questions: [] })
      .expect(200);
    const before = JSON.stringify(t.store.load().applications);
    stopMidMerge();
    const r = await request(app).post(`/api/workspace/${created.body.draft.id}/complete`).send({});
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/^Not saved/);
    expect(JSON.stringify(t.store.load().applications)).toBe(before);
    expect(t.store.getDraft(created.body.draft.id)?.status).not.toBe('submitted');
  });
});
