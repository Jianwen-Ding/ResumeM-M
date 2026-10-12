import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import request from 'supertest';

/*
 * Two requisitions under one title.
 *
 * `cleanRole` cuts a requisition number off the end of a title so a role reads
 * the way the employer's other page writes it — SuccessFactors' "Image
 * Processing Engineer Intern (41213)" is L3Harris's "Image Processing
 * Engineer Intern" — and `identity` reads the cut title. So "Software
 * Engineer Intern (12345678)" and "(87654321)" at one employer were one key:
 * the second was found as the first's row, and read as already sent once the
 * first was. A number on both sides, and not the same number, is two jobs; a
 * number on one side only is still the one.
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
const { alreadySent, findApplication, identity, sameIdentity } = await import('../src/model/applications.js');
const { cleanRole, trailingJobId } = await import('../src/jobs/names.js');
type Application = import('../src/model/types.js').Application;
type TempStore = ReturnType<typeof makeTempStore>;

const PAIRS: [string, string][] = [
  ['Software Engineer Intern (12345678)', 'Software Engineer Intern (87654321)'],
  ['Software Engineer - JR0286834', 'Software Engineer - JR0299999'],
  ['Software Engineer (Req #123456)', 'Software Engineer (Req #654321)'],
  ['Software Engineer (R22724)', 'Software Engineer (R22725)'],
];

describe('the requisition number on the end of a title', () => {
  it('is cut for display, and read out as the number it is', () => {
    expect(cleanRole('Software Engineer Intern (12345678)', 'Acme')).toBe('Software Engineer Intern');
    expect(trailingJobId('Software Engineer Intern (12345678)', 'Acme')).toBe('12345678');
    expect(cleanRole('Software Engineer - JR0286834', 'Acme')).toBe('Software Engineer');
    expect(trailingJobId('Software Engineer - JR0286834', 'Acme')).toBe('jr0286834');
    expect(trailingJobId('Software Engineer (Req #123456)', 'Acme')).toBe('123456');
    expect(trailingJobId('Robotics - Software Development Engineer - Job ID: 10452115 | Amazon.jobs', 'Amazon')).toBe('10452115');
    expect(trailingJobId('Software Engineer Intern', 'Acme')).toBeUndefined();
  });

  /*
   * Workday's "(R22724)": letters and five digits or more, as `isJobIdSegment`
   * reads "R171666" after a separator. Not a bracketed year with letters
   * before it, and not `unnamedRole`'s own "(job N)".
   */
  it('includes a lettered one like "(R22724)", and not "(FY2026)" or "(job 4012345)"', () => {
    expect(cleanRole('Software Engineer (R22724)', 'Acme')).toBe('Software Engineer');
    expect(trailingJobId('Software Engineer (R22724)', 'Acme')).toBe('r22724');
    expect(cleanRole('Software Engineer Intern (FY2026)', 'Acme')).toBe('Software Engineer Intern (FY2026)');
    expect(trailingJobId('Software Engineer Intern (FY2026)', 'Acme')).toBeUndefined();
    expect(cleanRole('Unknown role (job 4012345)', 'Acme')).toBe('Unknown role (job 4012345)');
    expect(trailingJobId('Unknown role (job 4012345)', 'Acme')).toBeUndefined();
  });

  it('reads one number however it is written: "(Req #123456)" is "- Job ID: 123456"', () => {
    expect(sameIdentity('Acme', 'Software Engineer (Req #123456)', 'Acme', 'Software Engineer - Job ID: 123456')).toBe(true);
  });
});

describe('two titles carrying two different requisition numbers', () => {
  for (const [a, b] of PAIRS) {
    it(`are two jobs: "${a}" and "${b}"`, () => {
      // One key still: the cut title is the same, and that is what the key reads.
      expect(identity('Acme', a)).toBe(identity('Acme', b));
      expect(sameIdentity('Acme', a, 'Acme', b)).toBe(false);
    });
  }

  it('and the same number on both is one job', () => {
    for (const [a] of PAIRS) expect(sameIdentity('Acme', a, 'Acme', a)).toBe(true);
    expect(sameIdentity('Acme', 'Software Engineer - JR0286834', 'Acme Inc.', 'software engineer - jr0286834')).toBe(true);
  });

  /*
   * That is what the cut is for: "Image Processing Engineer Intern (41213)"
   * on Ns2cloud and L3Harris's own "Image Processing Engineer Intern" are one
   * application.
   */
  it('and a number on one side only is still one job', () => {
    expect(sameIdentity('L3Harris', 'Image Processing Engineer Intern (41213)', 'L3Harris', 'Image Processing Engineer Intern')).toBe(true);
    for (const [a] of PAIRS) expect(sameIdentity('Acme', a, 'Acme', 'Software Engineer' + (a.includes('Intern') ? ' Intern' : ''))).toBe(true);
  });
});

const row = (role: string, status: Application['status'], url?: string): Application =>
  ({
    id: `r-${role}`,
    company: 'Acme',
    role,
    status,
    url,
    appliedAt: '2026-10-01T00:00:00.000Z',
    history: [{ at: '2026-10-01T00:00:00.000Z', status }],
  }) as Application;

describe('finding the row for a requisition', () => {
  for (const [a, b] of PAIRS) {
    it(`does not find "${a}" for "${b}"`, () => {
      expect(findApplication([row(a, 'applying')], 'Acme', b)).toBeUndefined();
    });

    it(`does not read "${b}" as already sent because "${a}" was`, () => {
      expect(alreadySent([row(a, 'applied')], 'Acme', b)).toBeUndefined();
    });
  }

  it('across two addresses naming the two numbers on one board', () => {
    const apps = [row('Software Engineer Intern (12345678)', 'applied', 'https://acme.wd1.myworkdayjobs.com/x/job/12345678')];
    const other = ['Acme', 'Software Engineer Intern (87654321)', 'https://acme.wd1.myworkdayjobs.com/x/job/87654321'] as const;
    expect(findApplication(apps, ...other)).toBeUndefined();
    expect(alreadySent(apps, ...other)).toBeUndefined();
  });

  it('still finds the same requisition, and a title with the number cut', () => {
    const [a] = PAIRS[0]!;
    expect(findApplication([row(a, 'applying')], 'Acme', a)?.role).toBe(a);
    expect(findApplication([row(a, 'applying')], 'Acme', 'Software Engineer Intern')?.role).toBe(a);
    expect(findApplication([row('Software Engineer Intern', 'applying')], 'Acme', a)?.role).toBe('Software Engineer Intern');
    expect(alreadySent([row(a, 'applied')], 'Acme', a)?.role).toBe(a);
    expect(alreadySent([row(a, 'applied')], 'Acme', 'Software Engineer Intern')?.role).toBe(a);
  });
});

describe('staging a second requisition under the title of one already sent', () => {
  let t: TempStore;
  let app: express.Express;

  beforeEach(() => {
    t = makeTempStore();
    app = express();
    app.use('/api', createApi({ store: t.store, repo: Repo.forStore(t.dir) }));
  });
  afterEach(() => t.cleanup());

  const FIRST = { company: 'Acme', role: 'Software Engineer Intern (12345678)', url: 'https://acme.wd1.myworkdayjobs.com/x/job/12345678' };
  const SECOND = { company: 'Acme', role: 'Software Engineer Intern (87654321)', url: 'https://acme.wd1.myworkdayjobs.com/x/job/87654321' };
  const stage = (job: typeof FIRST) => request(app).post('/api/applications/bundle').send({ ...job, resumeId: 'intern', status: 'applying' });

  it('is staged as its own application', async () => {
    await stage(FIRST).expect(200);
    await request(app).post('/api/extension/sent').send({ ...FIRST, note: '"Submit" was pressed on the page' }).expect(200);
    const res = await stage(SECOND);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const apps = t.store.load().applications;
    expect(apps).toHaveLength(2);
    const first = apps.find((a) => a.role === FIRST.role)!;
    const second = apps.find((a) => a.role === SECOND.role)!;
    expect(first.status).toBe('applied');
    expect(second.status).toBe('applying');
    expect(second.id).not.toBe(first.id);
  });
});
