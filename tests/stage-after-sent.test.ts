import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import request from 'supertest';

/*
 * The compile, stood in for, so a stage can be held in the middle of it while
 * the form is sent — the ordering the extension meets for real, where a stage
 * queued or compiling at the moment of Submit lands after the send.
 */
const held = vi.hoisted(() => ({ gate: null as Promise<void> | null, started: [] as string[] }));
vi.mock('../src/render/compile.js', async (actual) => {
  const real = await actual<typeof import('../src/render/compile.js')>();
  return {
    ...real,
    compileResume: async (_resolved: unknown, { pdfPath }: { pdfPath: string }) => {
      held.started.push(pdfPath);
      if (held.gate) await held.gate;
      fs.mkdirSync(path.dirname(pdfPath), { recursive: true });
      fs.writeFileSync(pdfPath, `%PDF stand-in ${held.started.length}`);
      return { fits: true, pages: 1, usedPt: 0, availablePt: 0, overflowPt: 0, overflowLines: 0, layout: {}, adjustments: [], tex: '', engine: 'pdflatex', warnings: [] };
    },
  };
});

// The setup file has already loaded the real one; loaded again, through the stand-in.
vi.resetModules();
const { createApi } = await import('../src/server/api.js');
const { Repo } = await import('../src/git/repo.js');
const { makeTempStore } = await import('./helpers.js');
type TempStore = ReturnType<typeof makeTempStore>;

/*
 * Staging is the extension keeping the upload folder level with the card,
 * with nobody pressing anything: a bundle asking for `applying`. Once the
 * application has been recorded as sent, no stage may rebuild its files or
 * write its history — not one sent after, and not one that was already
 * compiling when the send landed. Filing it again on purpose still can.
 */
let t: TempStore;
let app: express.Express;

beforeEach(() => {
  held.gate = null;
  held.started.length = 0;
  t = makeTempStore();
  app = express();
  app.use('/api', createApi({ store: t.store, repo: Repo.forStore(t.dir) }));
});
afterEach(() => t.cleanup());

const JOB = { company: 'Helios', role: 'Platform Engineer', url: 'https://helios.example/jobs/1' };
const stage = (extra: Record<string, unknown> = {}) =>
  request(app).post('/api/applications/bundle').send({ ...JOB, resumeId: 'intern', status: 'applying', ...extra });
const send = () => request(app).post('/api/extension/sent').send({ ...JOB, note: '"Submit Application" was pressed on the page' });
const row = () => t.store.load().applications.find((a) => a.company === 'Helios')!;
const lastNote = () => row().history?.at(-1)?.note;
const folderResume = () => {
  const dir = t.store.outFile('applications', row().id);
  const pdf = fs.readdirSync(dir).find((f) => f.endsWith('.pdf'))!;
  return fs.readFileSync(path.join(dir, pdf), 'utf8');
};

describe('a stage over an application already sent', () => {
  it('is refused, and nothing of the application is rebuilt or written', async () => {
    await stage().expect(200);
    await send().expect(200);
    const filed = folderResume();
    const history = row().history?.length ?? 0;

    const res = await stage({ spec: { ...t.store.load().resumes.find((r) => r.id === 'intern')!, id: 'job-helios', label: 'Changed after' } }).expect(409);
    expect(res.body).toMatchObject({ kind: 'already-sent' });
    expect(res.body.error).toMatch(/already been sent/);
    expect(row().status).toBe('applied');
    expect(row().history).toHaveLength(history);
    expect(lastNote()).toMatch(/pressed/);
    expect(folderResume(), 'the files that went out').toBe(filed);
    expect(t.store.load().resumes.some((r) => r.id === 'job-helios'), 'not even its copy').toBe(false);
  });

  it('is refused when the send lands while it compiles, and the send stays the last word', async () => {
    await stage().expect(200);
    const filed = folderResume();
    let release!: () => void;
    held.gate = new Promise((go) => (release = go));
    const staging = stage();
    const out = staging.then((r) => r);
    await vi.waitFor(() => expect(held.started.length).toBe(2));
    await send().expect(200);
    release();

    const res = await out;
    expect(res.status).toBe(409);
    expect(res.body.kind).toBe('already-sent');
    expect(row().status).toBe('applied');
    expect(lastNote()).toMatch(/pressed/);
    expect(folderResume(), 'the files that went out').toBe(filed);
  });

  it('is written when asked for outright, as is filing it again', async () => {
    await stage().expect(200);
    await send().expect(200);
    await stage({ evenIfSent: true }).expect(200);
    expect(lastNote()).toBe('Files rebuilt');
    expect(row().status).toBe('applied');
    await request(app).post('/api/applications/bundle').send({ ...JOB, resumeId: 'intern' }).expect(200);
    expect(row().status).toBe('applied');
  });

  it('still stages an application that has not gone out, or was taken back', async () => {
    await stage().expect(200);
    await stage().expect(200);
    await send().expect(200);
    await request(app).post(`/api/applications/${row().id}/status`).send({ status: 'applying', note: 'Not sent after all' }).expect(200);
    await stage().expect(200);
    expect(lastNote()).toBe('Files rebuilt');
  });
});
