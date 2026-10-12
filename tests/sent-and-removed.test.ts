/**
 * What happens to an application's files and names after it has gone out:
 * filed again, removed from the tracker, renamed, rejected.
 *
 * Each of these was measured through the routes on a copy of a real save, and
 * each lost or split something without saying so.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import express from 'express';
import request from 'supertest';
import YAML from 'yaml';

/*
 * The compile, stood in for, as in rebuild-row: these are about what a build
 * writes on the tracker row and in the folder, not about the PDF. Each PDF
 * says which resume it came from, so a replaced file can be told apart.
 */
vi.mock('../src/render/compile.js', async (actual) => {
  const real = await actual<typeof import('../src/render/compile.js')>();
  return {
    ...real,
    compileResume: async (resolved: { spec?: { id?: string } }, { pdfPath }: { pdfPath: string }) => {
      fs.mkdirSync(path.dirname(pdfPath), { recursive: true });
      fs.writeFileSync(pdfPath, `%PDF stand-in ${resolved.spec?.id ?? ''}`);
      return { fits: true, pages: 1, usedPt: 0, availablePt: 0, overflowPt: 0, overflowLines: 0, layout: {}, adjustments: [], tex: '', engine: 'pdflatex', warnings: [] };
    },
    compileLetter: async (_letter: unknown, _layout: unknown, { pdfPath }: { pdfPath: string }) => {
      fs.mkdirSync(path.dirname(pdfPath), { recursive: true });
      fs.writeFileSync(pdfPath, '%PDF stand-in');
      return { pdfPath, tex: '', engine: 'pdflatex', pages: 1, fits: true, overflowLines: -5, warnings: [], fastPath: false };
    },
  };
});

vi.resetModules();
const { createApi } = await import('../src/server/api.js');
const { Repo } = await import('../src/git/repo.js');
const { makeTempStore } = await import('./helpers.js');
const { dueToGo } = await import('../src/model/tiers.js');
const { freshApplicationId, applicationId, stats } = await import('../src/model/applications.js');
type TempStore = ReturnType<typeof makeTempStore>;

let t: TempStore;
let app: express.Express;

beforeEach(() => {
  t = makeTempStore();
  app = express();
  app.use('/api', createApi({ store: t.store, repo: Repo.forStore(t.dir) }));
});
afterEach(() => t.cleanup());

const rows = () => t.store.load().applications;
const bundle = (body: Record<string, unknown>) => request(app).post('/api/applications/bundle').send(body);

/** `intern` as a copy made for one posting a month ago: temporary, its week long gone. */
function internIsTemporary() {
  const spec = t.store.getResume('intern')!;
  t.store.saveResume({ ...spec, tier: 'temporary', temporaryFrom: '2026-01-01T00:00:00.000Z' });
}

/*
 * `rmm apply newgrad` over an application at `interview` that went out with
 * `intern`: the row switched to `newgrad`, the PDF in its folder was replaced,
 * the history said "Files rebuilt", and nothing referenced `intern` any more —
 * so a temporary `intern` was swept a week later, and the save had a row at
 * `interview` whose sent resume no longer existed anywhere.
 */
describe('filing again an application that has already gone out', () => {
  const JOB = { company: 'Acme', role: 'SWE Intern', url: 'https://acme.example/careers/swe-intern' };

  it('keeps the resume that was sent from the sweep, says so in the history, and warns', async () => {
    internIsTemporary();
    await bundle({ ...JOB, resumeId: 'intern', status: 'applied' }).expect(200);
    const id = rows()[0]!.id;
    await request(app).post(`/api/applications/${id}/status`).send({ status: 'interview' }).expect(200);

    // Filed again, as `rmm apply` and "Prepare to submit" do: no status.
    const res = await bundle({ ...JOB, resumeId: 'newgrad' }).expect(200);

    const row = rows()[0]!;
    expect(row.resumeId).toBe('newgrad');
    expect(row.status).toBe('interview');
    expect(row.sentResumeIds).toEqual(['intern']);
    expect(row.history?.at(-1)?.note).toMatch(/replaced the resume \(Summer intern → .+\) that went out/i);
    expect(res.body.warnings[0]).toMatch(/already been sent.*replaced the resume/i);
    expect(res.body.replaced).toBe(res.body.warnings[0]);

    // The resume that went out is not on its way out.
    expect(dueToGo(t.store.load()).map((d) => d.id)).not.toContain('intern');
  });

  it('warns when the letter that went out is replaced, too', async () => {
    await bundle({ ...JOB, resumeId: 'intern', status: 'applied', coverLetter: 'Dear Acme, the first one.' }).expect(200);
    const res = await bundle({ ...JOB, resumeId: 'intern', coverLetter: 'Dear Acme, rewritten.' }).expect(200);
    expect(res.body.warnings[0]).toMatch(/replaced the cover letter/);
    expect(rows()[0]!.history?.at(-1)?.note).toMatch(/replaced the cover letter that went out/);
    // The resume did not change, so there is nothing to remember about it.
    expect(rows()[0]!.sentResumeIds).toBeUndefined();
  });

  it('says nothing for a rebuild that replaces nothing that was sent', async () => {
    await bundle({ ...JOB, resumeId: 'intern', status: 'applied', coverLetter: 'Dear Acme.' }).expect(200);
    const res = await bundle({ ...JOB, resumeId: 'intern' }).expect(200);
    expect(res.body.replaced).toBeUndefined();
    expect(res.body.warnings.join(' ')).not.toMatch(/already been sent/);
  });

  it('says nothing either while the application is still being worked on', async () => {
    await bundle({ ...JOB, resumeId: 'intern', status: 'applying' }).expect(200);
    const res = await bundle({ ...JOB, resumeId: 'newgrad', status: 'applying' }).expect(200);
    expect(res.body.replaced).toBeUndefined();
    expect(rows()[0]!.sentResumeIds).toBeUndefined();
  });

  it('passes the warning on from the Workspace’s Complete, without a "0 question(s) answered" line', async () => {
    await bundle({ ...JOB, resumeId: 'intern', status: 'applied' }).expect(200);
    const created = await request(app)
      .post('/api/workspace')
      .send({ ...JOB, resumeId: 'newgrad', questions: [] })
      .expect(200);
    const id = created.body.draft.id;
    // The space opened on the sent row; point it at another resume.
    t.store.saveDraft({ ...t.store.getDraft(id)!, resumeId: 'newgrad' });
    const res = await request(app).post(`/api/workspace/${id}/complete`).send({ saveAnswersToBank: false }).expect(200);
    expect(res.body.warnings.join(' ')).toMatch(/already been sent.*replaced the resume/);
    const notes = (rows()[0]!.history ?? []).map((h) => h.note ?? '');
    expect(notes.some((n) => /0 question\(s\) answered/.test(n))).toBe(false);
  });
});

/*
 * "Record an application" names the row by id and takes the resume it is
 * given. On a row that had gone out with `intern` it re-pointed `resumeId` at
 * `newgrad` and remembered nothing, so the resume that was sent was referenced
 * by nothing and swept — what `buildBundle` already guards against.
 */
describe('recording by hand, by id, a sent application with another resume', () => {
  const JOB = { company: 'Initech', role: 'Platform Intern', url: 'https://initech.example/jobs/platform-intern' };

  it('keeps the resume that went out from the sweep, and says so in the history', async () => {
    internIsTemporary();
    await bundle({ ...JOB, resumeId: 'intern', status: 'applied' }).expect(200);
    const id = rows()[0]!.id;
    await request(app).post(`/api/applications/${id}/status`).send({ status: 'interview' }).expect(200);

    await request(app).post('/api/applications').send({ ...JOB, id, resumeId: 'newgrad' }).expect(200);

    const row = rows()[0]!;
    expect(row.resumeId).toBe('newgrad');
    expect(row.status).toBe('interview');
    expect(row.sentResumeIds).toEqual(['intern']);
    expect(row.history?.at(-1)?.note).toMatch(/Resume changed after sending: Summer intern → .+ is kept/);
    expect(dueToGo(t.store.load()).map((d) => d.id)).not.toContain('intern');
  });

  it('remembers nothing for a row not yet sent, or the same resume again', async () => {
    await bundle({ ...JOB, resumeId: 'intern', status: 'applying' }).expect(200);
    const id = rows()[0]!.id;
    await request(app).post('/api/applications').send({ ...JOB, id, resumeId: 'newgrad' }).expect(200);
    expect(rows()[0]!.sentResumeIds).toBeUndefined();

    await request(app).post(`/api/applications/${id}/status`).send({ status: 'applied' }).expect(200);
    await request(app).post('/api/applications').send({ ...JOB, id, resumeId: 'newgrad' }).expect(200);
    expect(rows()[0]!.sentResumeIds).toBeUndefined();
    expect(rows()[0]!.history?.at(-1)?.note).toBe('Recorded again by hand');
  });
});

/*
 * Remove says "the tracker row goes; the files on disk stay". Measured: the
 * sent row's temporary resume became sweepable the moment the row went, and a
 * same-day re-file of the job took the removed row's id — its folder — and
 * replaced the kept resume and deleted the kept letter.
 */
describe('removing an application from the tracker', () => {
  const JOB = { company: 'Hooli', role: 'Data Intern', url: 'https://hooli.example/jobs/data-intern' };

  it('keeps the resume a sent row went out with', async () => {
    internIsTemporary();
    await bundle({ ...JOB, resumeId: 'intern', status: 'applied' }).expect(200);
    await request(app).delete(`/api/applications/${rows()[0]!.id}`).expect(200);
    expect(rows()).toHaveLength(0);
    expect(dueToGo(t.store.load()).map((d) => d.id)).not.toContain('intern');
    expect(t.store.getResume('intern')?.tier).toBe('extended');
  });

  it('leaves alone the resume of a row that was never sent', async () => {
    internIsTemporary();
    await bundle({ ...JOB, resumeId: 'intern', status: 'applying' }).expect(200);
    await request(app).delete(`/api/applications/${rows()[0]!.id}`).expect(200);
    expect(t.store.getResume('intern')?.tier).toBe('temporary');
  });

  it('does not file the same job again into the removed row’s folder', async () => {
    await bundle({ ...JOB, resumeId: 'intern', status: 'applied', coverLetter: 'Dear Hooli.' }).expect(200);
    const first = rows()[0]!;
    const kept = t.store.outFile('applications', first.id);
    const before = fs.readdirSync(kept).sort();
    await request(app).delete(`/api/applications/${first.id}`).expect(200);

    const res = await bundle({ ...JOB, resumeId: 'base', status: 'applied' }).expect(200);
    expect(res.body.application.id).not.toBe(first.id);
    expect(fs.readdirSync(kept).sort()).toEqual(before);
  });

  it('is what freshApplicationId reads, when told where the folders are', () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'rmm-fresh-'));
    try {
      const id = applicationId('Hooli', 'Data Intern');
      fs.mkdirSync(path.join(out, 'applications', id), { recursive: true });
      expect(freshApplicationId([], 'Hooli', 'Data Intern')).toBe(id);
      expect(freshApplicationId([], 'Hooli', 'Data Intern', out)).toBe(`${id}-2`);
    } finally {
      fs.rmSync(out, { recursive: true, force: true });
    }
  });
});

/*
 * A row staged from a page that named "Summer 2026" as the employer, corrected
 * in the tracker, then sent from the card still open on that page. The address
 * is a LinkedIn search with no job number in it, so only the names could tie
 * the send to the row — and they no longer matched.
 */
describe('a row whose names were corrected in the tracker', () => {
  const URL = 'https://www.linkedin.com/jobs/search-results/?keywords=software+intern&origin=JOB_SEARCH_PAGE_JOB_FILTER';

  it('is still the row a send under the old names belongs to', async () => {
    await bundle({ company: 'Summer 2026', role: 'Firmware Intern', url: URL, resumeId: 'intern', status: 'applying' }).expect(200);
    const id = rows()[0]!.id;
    await request(app).patch(`/api/applications/${id}`).send({ company: 'Zeta Motors', role: 'Firmware Intern' }).expect(200);
    expect(rows()[0]!.aliases).toEqual([{ company: 'Summer 2026', role: 'Firmware Intern' }]);

    const sent = await request(app).post('/api/extension/sent').send({ company: 'Summer 2026', role: 'Firmware Intern', url: URL }).expect(200);
    expect(sent.body.application.id).toBe(id);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ company: 'Zeta Motors', status: 'applied' });
  });

  it('keeps the corrected names when the page builds it again under the old ones', async () => {
    await bundle({ company: 'Summer 2026', role: 'Firmware Intern', url: URL, resumeId: 'intern', status: 'applying' }).expect(200);
    const id = rows()[0]!.id;
    await request(app).patch(`/api/applications/${id}`).send({ company: 'Zeta Motors' }).expect(200);
    await bundle({ company: 'Summer 2026', role: 'Firmware Intern', url: URL, resumeId: 'intern', status: 'applying' }).expect(200);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ id, company: 'Zeta Motors' });
  });
});

/*
 * Measured: 50% with one interview out of two sent, then 0% the moment that
 * interview's rejection was recorded.
 */
describe('the response rate', () => {
  it('still counts an interview that ended in a rejection', () => {
    const at = '2026-10-01T12:00:00.000Z';
    const s = stats([
      { id: 'a', company: 'A', role: 'R', status: 'closed', appliedAt: at, history: [
        { at, status: 'applied' }, { at, status: 'interview' }, { at, status: 'closed', note: 'Rejected' },
      ] },
      { id: 'b', company: 'B', role: 'R', status: 'applied', appliedAt: at, history: [{ at, status: 'applied' }] },
    ]);
    expect(s.responseRate).toBe(50);
  });
});

/*
 * `rmm track` printed `appliedAt.slice(0, 10)`, the day in Greenwich: an
 * application filed on the evening of the 11th in California read as the
 * 12th, beside an id and a tracker row reading the 11th.
 */
describe('rmm track', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

  it('prints the day on this machine’s clock, and a bare date as it is', async () => {
    fs.writeFileSync(
      path.join(t.dir, 'applications.yaml'),
      YAML.stringify([
        { id: 'evening', company: 'Acme', role: 'SWE Intern', status: 'applied', appliedAt: '2026-10-12T03:00:00.000Z' },
        { id: 'typed', company: 'Globex', role: 'Data Intern', status: 'applied', appliedAt: '2026-03-04' },
      ]),
      'utf8',
    );
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ['node_modules/.bin/tsx', 'src/cli.ts', 'track', '--data', t.dir],
      { cwd: root, env: { ...process.env, TZ: 'America/Los_Angeles', RMM_AUTOCOMMIT: '0' }, timeout: 60_000 },
    );
    expect(stdout).toMatch(/2026-10-11 +applied +Acme/);
    expect(stdout).toMatch(/2026-03-04 +applied +Globex/);
  }, 60_000);
});
