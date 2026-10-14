/**
 * Tailoring from the workspace, when two postings share a name, and when the
 * copy was edited by hand since it was tailored.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createApi } from '../src/server/api.js';
import { Repo } from '../src/git/repo.js';
import { DEFAULT_CONFIG } from '../src/model/types.js';
import { hasLatex, makeTempStore, type TempStore } from './helpers.js';

const latex = await hasLatex();

let t: TempStore;
let app: express.Express;

beforeEach(() => {
  // No posting is fetched from the network: the spaces carry their text.
  vi.stubGlobal('fetch', async () => {
    throw new Error('offline');
  });
  t = makeTempStore({ config: { ai: { ...DEFAULT_CONFIG.ai, enabled: false }, git: { autoCommit: false }, output: { dir: 'out' } } });
  app = express();
  app.use(express.json());
  app.use('/api', createApi({ store: t.store, repo: Repo.forStore(t.dir) }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  t?.cleanup();
});

async function openSpace(url?: string, company = 'Acme', role = 'Software Engineer Intern') {
  const res = await request(app)
    .post('/api/workspace')
    .send({ company, role, ...(url ? { url } : {}), jobDescription: 'Kafka and Go on AWS. Distributed systems, Kubernetes.' })
    .expect(200);
  return res.body.draft ?? res.body;
}

const tailor = (id: string, body: object = {}) => request(app).post(`/api/workspace/${encodeURIComponent(id)}/tailor`).send(body);

describe('two postings with one company and one role', () => {
  it('gives each its own tailored copy', async () => {
    const a = await openSpace('https://job-boards.greenhouse.io/acme/jobs/1111111');
    const b = await openSpace('https://job-boards.greenhouse.io/acme/jobs/2222222');
    const first = await tailor(a.id).expect(200);
    const second = await tailor(b.id).expect(200);

    expect(second.body.spec.id).not.toBe(first.body.spec.id);
    const drafts = t.store.loadDrafts();
    expect(drafts.find((d) => d.id === a.id)?.resumeId).toBe(first.body.spec.id);
    expect(drafts.find((d) => d.id === b.id)?.resumeId).toBe(second.body.spec.id);
    const copyA = t.store.loadResumes().find((r) => r.id === first.body.spec.id);
    expect(copyA?.generatedFor?.url).toBe('https://job-boards.greenhouse.io/acme/jobs/1111111');
  });

  it('still writes the same copy when one posting is tailored again', async () => {
    const a = await openSpace('https://job-boards.greenhouse.io/acme/jobs/1111111');
    await openSpace('https://job-boards.greenhouse.io/acme/jobs/2222222');
    const first = await tailor(a.id).expect(200);
    const again = await tailor(a.id).expect(200);
    expect(again.body.spec.id).toBe(first.body.spec.id);
  });
});

describe('tailoring again over a copy edited since', () => {
  async function tailoredThenEdited() {
    const a = await openSpace('https://job-boards.greenhouse.io/acme/jobs/1111111');
    const first = await tailor(a.id).expect(200);
    const id = first.body.spec.id as string;
    const copy = t.store.loadResumes().find((r) => r.id === id)!;
    // A hand edit to the copy: one section hidden, and a name of its own.
    const edited = { ...copy, label: 'Acme — my pick', sections: (copy.sections ?? []).slice(1) };
    await request(app).put(`/api/resumes/${encodeURIComponent(id)}`).send(edited).expect(200);
    return { a, id, edited };
  }

  it('is refused with 409 edited, and the edit kept', async () => {
    const { a, id, edited } = await tailoredThenEdited();
    const res = await tailor(a.id).expect(409);
    expect(res.body.kind).toBe('edited');
    expect(t.store.loadResumes().find((r) => r.id === id)?.sections).toEqual(edited.sections);
  });

  it('is refused before the posting is fetched', async () => {
    const { a } = await tailoredThenEdited();
    const fetched = vi.fn(async () => {
      throw new Error('offline');
    });
    vi.stubGlobal('fetch', fetched);
    await tailor(a.id).expect(409);
    expect(fetched).not.toHaveBeenCalled();
  });

  it('replaces the edit when asked to, keeping the name given by hand', async () => {
    const { a, id, edited } = await tailoredThenEdited();
    await tailor(a.id, { overwrite: true }).expect(200);
    const now = t.store.loadResumes().find((r) => r.id === id)!;
    expect(now.sections?.length).toBeGreaterThan(edited.sections.length);
    expect(now.label).toBe('Acme — my pick');
  });

  it('is not refused when the copy was not touched', async () => {
    const a = await openSpace('https://job-boards.greenhouse.io/acme/jobs/1111111');
    await tailor(a.id).expect(200);
    await tailor(a.id).expect(200);
    await tailor(a.id).expect(200);
  });
});

/*
 * Copies JobHelper made or filed, and variations, are tailored copies too.
 * They were written with no fingerprint, a copy without one reads as never
 * edited, and tailoring again from the workspace wrote over a hand edit to
 * one of them without asking.
 */
describe('a copy written by another path, edited since', () => {
  const URL = 'https://boards.greenhouse.io/sigmaworks/jobs/4500001';
  const JD = 'Requirements: Python, Kafka, distributed systems, React, TypeScript, AWS, Docker. Responsibilities: design and build pipelines.';
  const HTML = `<html><head><title>ML Intern - Sigmaworks</title></head><body><h1>ML Intern</h1><p>Sigmaworks is hiring. ${JD}</p></body></html>`;
  const analyze = async () =>
    (await request(app).post('/api/extension/analyze').send({ url: URL, html: HTML, tailor: 'match' }).expect(200)).body;
  const stored = (id: string) => t.store.loadResumes().find((r) => r.id === id)!;
  const handEdit = async (id: string) => {
    const copy = stored(id);
    await request(app)
      .put(`/api/resumes/${encodeURIComponent(id)}`)
      .send({ ...copy, sections: (copy.sections ?? []).slice(0, -1) })
      .expect(200);
  };

  async function filedByJobHelper() {
    const a = await analyze();
    const g = a.spec.generatedFor;
    const w = await request(app).post('/api/workspace').send({ company: g.company, role: g.role, url: URL, spec: a.spec, jobDescription: JD }).expect(200);
    return { draftId: (w.body.draft ?? w.body).id as string, copyId: a.spec.id as string };
  }

  it('the analysis says what it tailored, and filing records it', async () => {
    const a = await analyze();
    expect(typeof a.spec.generatedFor.tailored).toBe('string');
    const { copyId } = await filedByJobHelper();
    expect(typeof stored(copyId).generatedFor?.tailored).toBe('string');
  });

  it('a copy filed from the card is refused when edited since', async () => {
    const { draftId, copyId } = await filedByJobHelper();
    await handEdit(copyId);
    const res = await tailor(draftId).expect(409);
    expect(res.body.kind).toBe('edited');
  });

  it('and still when the card files again what the save holds', async () => {
    const { draftId, copyId } = await filedByJobHelper();
    await handEdit(copyId);
    // The card's keeper filing the copy it read back: the same content.
    const g = stored(copyId).generatedFor!;
    const { tailored: _dropped, ...without } = g;
    await request(app)
      .post('/api/workspace')
      .send({ company: g.company, role: g.role, url: URL, spec: { ...stored(copyId), generatedFor: without } })
      .expect(200);
    await tailor(draftId).expect(409);
  });

  it('a copy filed again after re-analysing, untouched, is not refused', async () => {
    const { draftId } = await filedByJobHelper();
    await tailor(draftId).expect(200);
    const again = await analyze();
    const g = again.spec.generatedFor;
    await request(app).post('/api/workspace').send({ company: g.company, role: g.role, url: URL, spec: again.spec }).expect(200);
    await tailor(draftId).expect(200);
  });

  it('a write that leaves the fingerprint out keeps the one recorded', async () => {
    const space = await openSpace(URL, 'Sigmaworks', 'ML Intern');
    const copyId = (await tailor(space.id).expect(200)).body.spec.id as string;
    const was = stored(copyId).generatedFor!.tailored;
    expect(typeof was).toBe('string');
    const copy = stored(copyId);
    const { tailored: _dropped, ...without } = copy.generatedFor!;
    await request(app).put(`/api/resumes/${encodeURIComponent(copyId)}`).send({ ...copy, generatedFor: without }).expect(200);
    expect(stored(copyId).generatedFor?.tailored).toBe(was);
  });

  it('a variation records what it started as', async () => {
    const a = await openSpace(URL, 'Sigmaworks', 'ML Intern');
    const v = await request(app).post(`/api/workspace/${encodeURIComponent(a.id)}/variation`).send({}).expect(200);
    expect(stored(v.body.spec.id).generatedFor?.tailored).toBe(v.body.spec.generatedFor.tailored);
    expect(typeof v.body.spec.generatedFor.tailored).toBe('string');
  });

  // Filing an application typesets it, so only where there is a LaTeX engine.
  it.skipIf(!latex)('a copy filed with an application is refused when edited since', async () => {
    const a = await analyze();
    const g = a.spec.generatedFor;
    const space = await openSpace(URL, g.company, g.role);
    const b = await request(app).post('/api/applications/bundle').send({ company: g.company, role: g.role, url: URL, spec: a.spec });
    expect(b.status, JSON.stringify(b.body)).toBe(200);
    expect(typeof stored(a.spec.id).generatedFor?.tailored).toBe('string');
    await handEdit(a.spec.id);
    const res = await tailor(space.id).expect(409);
    expect(res.body.resumeId).toBe(a.spec.id);
  });
});
