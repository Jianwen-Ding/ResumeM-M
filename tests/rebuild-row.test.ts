import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import request from 'supertest';

/*
 * The compile, stood in for: these are about what a rebuild writes on the
 * tracker row, not about the PDF. The same stand-in as stage-after-sent.
 */
vi.mock('../src/render/compile.js', async (actual) => {
  const real = await actual<typeof import('../src/render/compile.js')>();
  return {
    ...real,
    compileResume: async (_resolved: unknown, { pdfPath }: { pdfPath: string }) => {
      fs.mkdirSync(path.dirname(pdfPath), { recursive: true });
      fs.writeFileSync(pdfPath, '%PDF stand-in');
      return { fits: true, pages: 1, usedPt: 0, availablePt: 0, overflowPt: 0, overflowLines: 0, layout: {}, adjustments: [], tex: '', engine: 'pdflatex', warnings: [] };
    },
  };
});

vi.resetModules();
const { createApi } = await import('../src/server/api.js');
const { Repo } = await import('../src/git/repo.js');
const { makeTempStore } = await import('./helpers.js');
type TempStore = ReturnType<typeof makeTempStore>;

let t: TempStore;
let app: express.Express;

beforeEach(() => {
  t = makeTempStore();
  app = express();
  app.use('/api', createApi({ store: t.store, repo: Repo.forStore(t.dir) }));
});
afterEach(() => t.cleanup());

const bundle = (body: Record<string, unknown>) =>
  request(app).post('/api/applications/bundle').send({ resumeId: 'intern', ...body });
const rows = () => t.store.load().applications;

/*
 * A stage carries whatever answers the card is holding, which is `[]` when the
 * card has not got the questions in hand. Measured: a Workday row's recorded
 * answer went to `answers: []` eight seconds after it was written, under a
 * "Files rebuilt" line, by a stage nobody pressed.
 */
describe('answers already recorded on an application', () => {
  const JOB = { company: 'Workday', role: 'Software Development Engineer Intern', url: 'https://workday.wd5.myworkdayjobs.com/x/job/123' };
  const recorded = [{ question: 'Please enter your name:', answer: 'Jian wen Ding' }];

  it('survive a stage that sends an empty list', async () => {
    await bundle({ ...JOB, status: 'applying', answers: recorded }).expect(200);
    await bundle({ ...JOB, status: 'applying', answers: [] }).expect(200);
    expect(rows()[0]?.answers).toEqual(recorded);
    // And the bundle still carries them, since it is built from the same list.
    const dir = t.store.outFile('applications', rows()[0]!.id);
    expect(fs.readdirSync(dir).some((f) => f.endsWith('.md'))).toBe(true);
  });

  it('are replaced by a stage that sends answers of its own', async () => {
    await bundle({ ...JOB, status: 'applying', answers: recorded }).expect(200);
    const next = [{ question: 'Why us?', answer: 'The platform work.' }];
    await bundle({ ...JOB, status: 'applying', answers: next }).expect(200);
    expect(rows()[0]?.answers).toEqual(next);
  });

  it('are cleared by filing the application with an empty list, which is said on purpose', async () => {
    await bundle({ ...JOB, status: 'applying', answers: recorded }).expect(200);
    await bundle({ ...JOB, status: 'applied', answers: [] }).expect(200);
    expect(rows()[0]?.answers).toEqual([]);
  });
});

/*
 * A row found only by its job number keeps its own names. Measured: a Texas
 * Instruments row, found by the `currentJobId` in a LinkedIn search address
 * sent beside L3Harris's posting, was renamed "L3Harris Technologies".
 */
describe('a rebuild filed into a row found by its job number', () => {
  const linkedIn = 'https://www.linkedin.com/jobs/search-results/?currentJobId=4466495180&keywords=C%2B%2B%20intern';

  it('does not rename the row to the request’s employer', async () => {
    await bundle({ company: 'Texas Instruments', role: 'Software Engineering Intern', url: linkedIn, status: 'applying' }).expect(200);
    const [ti] = rows();
    await bundle({ company: 'L3Harris Technologies', role: 'Software Engineering Intern', url: linkedIn, status: 'applying' }).expect(200);

    const after = rows();
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: ti!.id, company: 'Texas Instruments', role: 'Software Engineering Intern' });
  });

  /*
   * EA's job 216245, under the publisher and under the studio: still one
   * application (see `sameJobAs`), filed into the row that was there first.
   */
  it('still files EA and Respawn’s one job into one row', async () => {
    await bundle({
      company: 'Electronic Arts',
      role: 'Gameplay Engineer Intern',
      url: 'https://jobs.ea.com/en_US/careers/JobDetail/Gameplay-Engineer-Intern/216245',
      status: 'applying',
    }).expect(200);
    await bundle({
      company: 'Respawn Entertainment',
      role: 'Gameplay Engineer Intern',
      url: 'https://jobs.ea.com/en_US/careers/ApplicationMethods?jobId=216245',
      status: 'applying',
    }).expect(200);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ company: 'Electronic Arts', role: 'Gameplay Engineer Intern' });
  });

  it('takes a new spelling of the same employer, as it always has', async () => {
    await bundle({ company: 'Acme', role: 'Platform Engineer', status: 'applying' }).expect(200);
    await bundle({ company: 'Acme, Inc.', role: 'Platform Engineer', status: 'applying' }).expect(200);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]?.company).toBe('Acme, Inc.');
  });
});

/*
 * One history line for a run of rebuilds. A real save carried over a thousand
 * "Files rebuilt" lines, eight within two minutes on one row, each its own
 * commit.
 */
describe('the history of an application rebuilt again and again', () => {
  const JOB = { company: 'Helios', role: 'Platform Engineer', url: 'https://helios.example/jobs/1' };
  const notes = () => rows()[0]!.history!.map((h) => `${h.status}: ${h.note}`);

  it('says it once, not once per rebuild', async () => {
    for (let i = 0; i < 4; i++) await bundle({ ...JOB, status: 'applying' }).expect(200);
    expect(notes()).toEqual(['applying: Bundle created']);
  });

  it('says it again after something else happened, and on a change of status', async () => {
    await bundle({ ...JOB, status: 'applying' }).expect(200);
    await request(app).post(`/api/applications/${rows()[0]!.id}/status`).send({ status: 'applying', note: 'Called the recruiter' }).expect(200);
    await bundle({ ...JOB, status: 'applying' }).expect(200);
    await bundle({ ...JOB, status: 'applying' }).expect(200);
    await bundle({ ...JOB, status: 'applied' }).expect(200);
    await bundle({ ...JOB, status: 'applied' }).expect(200);
    expect(notes()).toEqual([
      'applying: Bundle created',
      'applying: Called the recruiter',
      'applying: Files rebuilt',
      'applied: Files rebuilt',
    ]);
  });

  it('commits nothing for a rebuild that changes nothing on the row', async () => {
    t.store.saveConfig({ git: { autoCommit: true } });
    const repo = Repo.forStore(t.dir);
    await repo.ensure();
    await bundle({ ...JOB, status: 'applying' }).expect(200);
    await repo.commitAll('settle');
    const before = (await repo.log(100)).length;
    await bundle({ ...JOB, status: 'applying' }).expect(200);
    await bundle({ ...JOB, status: 'applying' }).expect(200);
    expect((await repo.log(100)).length).toBe(before);
  });
});
