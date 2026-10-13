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
const { cleanRole, trailingJobId, withRequisition } = await import('../src/jobs/names.js');
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

/*
 * The same through the analysis, where the role is read off a page.
 *
 * Extraction cuts the number off the title for display, and the analysis
 * filed what was left: "Software Engineer Intern (87654321) | Acme" was
 * "Software Engineer Intern", so the second requisition was handed the first
 * one's tailored copy and found as its application. The number is carried
 * alongside (`job.requisition`) and put back on the role the analysis files.
 */
describe('analysing two postings whose titles differ only by requisition number', () => {
  let t: TempStore;
  let app: express.Express;

  beforeEach(() => {
    t = makeTempStore();
    app = express();
    app.use('/api', createApi({ store: t.store, repo: Repo.forStore(t.dir) }));
  });
  afterEach(() => t.cleanup());

  const BODY = `<h1>Software Engineer Intern</h1>
<h2>About the role</h2>
<p>You will build and ship software with a small team. Responsibilities include design reviews,
testing and on-call. Minimum qualifications: pursuing a degree in computer science. Python, TypeScript.</p>
<p>Apply now.</p>`;
  const posting = (title: string, url: string) => ({
    url,
    title,
    html: `<html><head><title>${title}</title></head><body>${BODY}</body></html>`,
  });
  const FIRST = posting('Software Engineer Intern (12345678) | Acme', 'https://careers.acme.com/jobs/first-posting');
  const SECOND = posting('Software Engineer Intern (87654321) | Acme', 'https://careers.acme.com/jobs/second-posting');
  const BARE = posting('Software Engineer Intern | Acme', 'https://careers.acme.com/jobs/the-posting');

  const analyze = async (p: ReturnType<typeof posting>) => {
    const res = await request(app)
      .post('/api/extension/analyze')
      .send({ ...p, pages: [p], baseResumeId: 'intern', tailor: 'none' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body as { spec: { id: string; generatedFor: { company: string; role: string } }; application: { id: string; resumeId?: string } };
  };
  /* As JobHelper stages: the copy, under `filedAs` — the copy's own `generatedFor`. */
  const stage = async (p: ReturnType<typeof posting>, analysis: Awaited<ReturnType<typeof analyze>>) => {
    const res = await request(app)
      .post('/api/applications/bundle')
      .send({ spec: analysis.spec, resumeId: analysis.spec.id, ...analysis.spec.generatedFor, url: p.url, source: 'careers.acme.com', status: 'applying' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  };

  it('gives each its own copy and its own application', async () => {
    const first = await analyze(FIRST);
    await stage(FIRST, first);
    const second = await analyze(SECOND);
    expect(second.spec.id).not.toBe(first.spec.id);
    expect(second.application.id).not.toBe(first.application.id);
    expect(second.application.resumeId).toBeUndefined();
    await stage(SECOND, second);
    const apps = t.store.load().applications;
    expect(apps).toHaveLength(2);
    expect(new Set(apps.map((a) => a.resumeId)).size).toBe(2);
  });

  it('and a posting with the number and one without still share one', async () => {
    const numbered = await analyze(FIRST);
    await stage(FIRST, numbered);
    const bare = await analyze(BARE);
    expect(bare.spec.id).toBe(numbered.spec.id);
    expect(bare.application.id).toBe(numbered.application.id);
    expect(bare.application.resumeId).toBe(numbered.spec.id);
  });

  /* The case the cut was made for: L3Harris's own posting, then SuccessFactors' "(41213)". */
  it('the other way round too', async () => {
    const own = posting('Image Processing Engineer Intern | L3Harris', 'https://careers.l3harris.com/job/image-processing-engineer-intern');
    const sf = posting('Image Processing Engineer Intern (41213) | L3Harris', 'https://careers.l3harris.com/apply/image-processing');
    const bare = await analyze(own);
    await stage(own, bare);
    const numbered = await analyze(sf);
    expect(numbered.spec.generatedFor.role).toBe('Image Processing Engineer Intern (41213)');
    expect(numbered.spec.id).toBe(bare.spec.id);
    expect(numbered.application.id).toBe(bare.application.id);
  });

  it('keeps the number on the role it files, and off the title it shows', async () => {
    const first = await analyze(FIRST);
    expect(first.spec.generatedFor.role).toBe('Software Engineer Intern (12345678)');
    expect((first as unknown as { job: { title: string; requisition: string } }).job).toMatchObject({
      title: 'Software Engineer Intern',
      requisition: '12345678',
    });
  });

  it('does not say the second was applied to because the first was', async () => {
    const first = await analyze(FIRST);
    await stage(FIRST, first);
    await request(app)
      .post('/api/extension/sent')
      .send({ ...first.spec.generatedFor, url: FIRST.url, note: '"Submit" was pressed on the page' })
      .expect(200);
    expect(((await analyze(FIRST)) as unknown as { applied?: unknown }).applied).toBeTruthy();
    expect(((await analyze(SECOND)) as unknown as { applied?: unknown }).applied).toBeFalsy();
  });

  it('and "- JR0286834" beside "- JR0299999" the same way', async () => {
    const a = posting('Software Engineer - JR0286834 | Acme', 'https://careers.acme.com/jobs/a');
    const b = posting('Software Engineer - JR0299999 | Acme', 'https://careers.acme.com/jobs/b');
    const first = await analyze(a);
    expect(first.spec.generatedFor.role).toBe('Software Engineer (JR0286834)');
    await stage(a, first);
    const second = await analyze(b);
    expect(second.spec.id).not.toBe(first.spec.id);
    expect(second.application.id).not.toBe(first.application.id);
  });
});

describe('putting a requisition number back on a role', () => {
  it('writes it the way the cut reads it back', () => {
    for (const [id, out] of [
      ['12345678', 'Software Engineer (12345678)'],
      ['JR0286834', 'Software Engineer (JR0286834)'],
      ['4021', 'Software Engineer (Req #4021)'],
      ['R1234', 'Software Engineer (Req #R1234)'],
    ] as const) {
      const role = withRequisition('Software Engineer', id);
      expect(role).toBe(out);
      expect(cleanRole(role, 'Acme')).toBe('Software Engineer');
      expect(trailingJobId(role, 'Acme')).toBe(id.toLowerCase());
    }
  });

  it('and leaves alone a role with none, or one already', () => {
    expect(withRequisition('Software Engineer', undefined)).toBe('Software Engineer');
    expect(withRequisition(undefined, '12345678')).toBeUndefined();
    expect(withRequisition('Software Engineer (12345678)', '12345678')).toBe('Software Engineer (12345678)');
  });
});
