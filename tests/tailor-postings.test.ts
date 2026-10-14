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
import { makeTempStore, type TempStore } from './helpers.js';

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
