import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import request from 'supertest';

/*
 * Which tracker row a job is.
 *
 * `sameJobAs` compared the names alone, and the address was never a reason
 * for two jobs to be different: Red Hat's "Software Engineer Intern" in
 * Raleigh, requisition R-059038, and in Boston, R-111111, were one row. The
 * workspace for Boston opened as `submitted` holding Raleigh's letter;
 * completing it replaced the letter, resume and files that had gone to
 * Raleigh; the send from Boston's form was swallowed as already made; the
 * card said "already applied" and handed back Raleigh's resume; a stage for
 * Boston was refused as sent. And the other way: one job written "(Remote)"
 * on LinkedIn and bare on the employer's form, or "2027 Summer" and "Summer
 * 2027", was two rows.
 *
 * Now two postings at one site, for one employer there, with two job numbers
 * are two jobs whatever they are called, and so are two requisitions; and a
 * match by the names alone (`MatchStrength` 'weak') may suggest, but never
 * says a job was sent, refuses a stage, swallows a send, or files into a row
 * that has gone out.
 */

/*
 * Round 23: and asks.
 *
 * Said nothing, a weak match to a sent row was as good as no match: 126 of
 * 128 sent rows in a real tracker were nothing to the same job's LinkedIn
 * posting, and a stage there filed a second row. Now a sent row with the
 * same names is "maybe sent" (`maybeSent`): the card says when and where it
 * went, an automatic stage is refused with `maybe` until somebody says it is
 * another job, and then it is filed as a new row — never into the sent one.
 * And the ATSs whose ids are global (Greenhouse, Lever, Ashby,
 * SmartRecruiters) are sure across hosts: the employer's page with `gh_jid`
 * and the Greenhouse board are one job.
 */

/*
 * The compile, stood in for: these are about which row and which folder a
 * build lands in, not about the PDF. Each PDF says which resume it came from,
 * so a replaced file can be told apart.
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
      fs.writeFileSync(pdfPath, '%PDF stand-in letter');
      return { pdfPath, tex: '', engine: 'pdflatex', pages: 1, fits: true, overflowLines: -5, warnings: [], fastPath: false };
    },
  };
});

vi.resetModules();
const { createApi } = await import('../src/server/api.js');
const { Repo } = await import('../src/git/repo.js');
const { makeTempStore } = await import('./helpers.js');
const applications = await import('../src/model/applications.js');
const { alreadySent, findApplication, sameIdentity } = applications;
type Application = import('../src/model/types.js').Application;
type TempStore = ReturnType<typeof makeTempStore>;

let t: TempStore | undefined;
afterEach(() => {
  t?.cleanup();
  t = undefined;
});

function serve(rows: unknown[] = [], drafts: { id: string }[] = []) {
  t = makeTempStore({ config: { git: { autoCommit: false }, output: { dir: 'out' } } });
  t.write('applications.yaml', rows);
  for (const d of drafts) t.write(`drafts/${d.id}.yaml`, d);
  const server = express();
  server.use(express.json({ limit: '5mb' }));
  server.use('/api', createApi({ store: t.store, repo: Repo.forStore(t.dir) }));
  return request(server);
}

const rows = () => t!.store.load().applications;
const row = (id: string) => rows().find((a) => a.id === id);
const draftsNow = () => t!.store.loadDrafts();

/** Days ago, as the tracker writes a date. */
const ago = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

const RALEIGH = 'https://redhat.wd5.myworkdayjobs.com/en-US/jobs/job/Raleigh/Software-Engineer-Intern_R-059038';
const BOSTON = 'https://redhat.wd5.myworkdayjobs.com/en-US/jobs/job/Boston/Software-Engineer-Intern_R-111111';

/* ------------------------------------------------------------------ *
 * The pairs                                                           *
 * ------------------------------------------------------------------ */

type Row = { id: string; company: string; role: string; url?: string; status: Application['status']; appliedAt: string };
type Pair = { name: string; row: Row; q: { company: string; role: string; url?: string }; truth: 'same' | 'different' };

/*
 * The hunt's matrix, A to Q: a row the tracker has, and a posting looked at
 * now. Each says whether the two are one job. Dated within the last month, so
 * nothing here is too old for a match by name (see the age test below).
 */
const recent = ago(20);
const PAIRS: Pair[] = [
  { name: 'A: a bare-title applied row, and another requisition in another city',
    row: { id: 'r1', company: 'Red Hat', role: 'Software Engineer Intern', url: 'https://redhat.wd5.myworkdayjobs.com/jobs/job/Raleigh/Software-Engineer-Intern_R-059038', status: 'applied', appliedAt: recent },
    q: { company: 'Red Hat', role: 'Software Engineer Intern (R-111111)', url: 'https://redhat.wd5.myworkdayjobs.com/jobs/job/Boston/Software-Engineer-Intern_R-111111' }, truth: 'different' },
  { name: 'B: one title, two Workday requisitions, both titles bare',
    row: { id: 'r2', company: 'Red Hat', role: 'Software Engineer Intern', url: 'https://redhat.wd5.myworkdayjobs.com/jobs/job/Raleigh/Software-Engineer-Intern_R-059038', status: 'applied', appliedAt: recent },
    q: { company: 'Red Hat', role: 'Software Engineer Intern', url: 'https://redhat.wd5.myworkdayjobs.com/jobs/job/Boston/Software-Engineer-Intern_R-111111' }, truth: 'different' },
  { name: 'C: one title, two job ids on one Greenhouse board',
    row: { id: 'r3', company: 'Coinbase', role: 'Software Engineer Intern', url: 'https://job-boards.greenhouse.io/coinbase/jobs/7000001', status: 'applied', appliedAt: recent },
    q: { company: 'Coinbase', role: 'Software Engineer Intern', url: 'https://job-boards.greenhouse.io/coinbase/jobs/7000999' }, truth: 'different' },
  { name: 'D: Summer 2026 and Summer 2027 in the title',
    row: { id: 'r4', company: 'Figma', role: 'Software Engineer Intern (Summer 2026)', url: 'https://job-boards.greenhouse.io/figma/jobs/5000001', status: 'interview', appliedAt: recent },
    q: { company: 'Figma', role: 'Software Engineer Intern (Summer 2027)', url: 'https://job-boards.greenhouse.io/figma/jobs/6143238004' }, truth: 'different' },
  { name: "E: last year's bare row and this year's repost, two job numbers on the employer's site",
    row: { id: 'r5', company: 'Coinbase', role: 'Software Engineer Intern', url: 'https://www.coinbase.com/careers/positions/5000001', status: 'applied', appliedAt: recent },
    q: { company: 'Coinbase', role: 'Software Engineer Intern', url: 'https://www.coinbase.com/careers/positions/7000777' }, truth: 'different' },
  { name: 'F: "(Remote)" on LinkedIn, bare on the form',
    row: { id: 'r6', company: 'Ivo', role: 'Software Engineer, Backend', url: 'https://jobs.ashbyhq.com/ivo/4a5b', status: 'applying', appliedAt: recent },
    q: { company: 'Ivo', role: 'Software Engineer, Backend (Remote)', url: 'https://www.linkedin.com/jobs/view/4470000001' }, truth: 'same' },
  { name: 'G: " - Remote" on LinkedIn, bare on the form',
    row: { id: 'r7', company: 'Ivo', role: 'Software Engineer, Backend', url: 'https://jobs.ashbyhq.com/ivo/4a5b', status: 'applying', appliedAt: recent },
    q: { company: 'Ivo', role: 'Software Engineer, Backend - Remote', url: 'https://www.linkedin.com/jobs/view/4470000001' }, truth: 'same' },
  { name: 'H: intern and new grad',
    row: { id: 'r8', company: 'Coinbase', role: 'Software Engineer Intern', status: 'applied', appliedAt: recent },
    q: { company: 'Coinbase', role: 'Software Engineer, New Grad' }, truth: 'different' },
  /*
   * Facebook and Meta are one employer, and nothing here says so: there is
   * no table of renamed companies, and one would be wrong as often as right.
   * Left as two rows, deliberately.
   */
  { name: 'I: a company renamed, Facebook and Meta (left as two, deliberately)',
    row: { id: 'r9', company: 'Facebook', role: 'Software Engineer Intern', status: 'applied', appliedAt: recent },
    q: { company: 'Meta', role: 'Software Engineer Intern' }, truth: 'different' },
  { name: "J: NVIDIA's Workday and its own site, one job",
    row: { id: 'r10', company: 'NVIDIA', role: 'NVIDIA 2027 Internships: Software Engineering', url: 'https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite/job/US-CA-Santa-Clara/NVIDIA-2027-Internships--Software-Engineering_JR2023495', status: 'applied', appliedAt: recent },
    q: { company: 'NVIDIA Corporation', role: 'NVIDIA 2027 Internships: Software Engineering', url: 'https://jobs.nvidia.com/careers/job/893397026205' }, truth: 'same' },
  { name: "K: LinkedIn's title with the requisition, Workday's address with it",
    row: { id: 'r11', company: 'Intel Corporation', role: 'Software Engineering - Intern, Bachelor’s', url: 'https://intel.wd1.myworkdayjobs.com/en-US/External/job/US-Oregon-Hillsboro/Software-Engineering---Intern--Bachelor-s_JR0286834', status: 'applied', appliedAt: recent },
    q: { company: 'Intel', role: 'Software Engineering - Intern, Bachelor’s - JR0286834', url: 'https://www.linkedin.com/jobs/view/4461337126' }, truth: 'same' },
  { name: 'L: one requisition written two ways',
    row: { id: 'r12', company: 'Red Hat', role: 'Software Engineer Intern (R-059038)', status: 'applied', appliedAt: recent },
    q: { company: 'Red Hat', role: 'Software Engineer Intern - R-059038' }, truth: 'same' },
  { name: 'M: Greenhouse and LinkedIn, the employer spelt two ways',
    row: { id: 'r13', company: 'Hpiq', role: 'Software Engineering Intern, Software Systems (Summer 2027)', url: 'https://job-boards.greenhouse.io/hpiq/jobs/6140119004', status: 'applied', appliedAt: recent },
    q: { company: 'HP IQ', role: 'Software Engineering Intern, Software Systems (Summer 2027)', url: 'https://www.linkedin.com/jobs/view/4466000000' }, truth: 'same' },
  { name: 'N: "2027 Summer" and "Summer 2027"',
    row: { id: 'r14', company: 'ByteDance', role: 'Software Engineer Intern (AI Infra Compute) - 2027 Summer', status: 'applying', appliedAt: recent },
    q: { company: 'ByteDance', role: 'Software Engineer Intern (AI Infra Compute) - Summer 2027' }, truth: 'same' },
  { name: 'O: " - Austin, TX" and " - Seattle, WA"',
    row: { id: 'r15', company: 'Coinbase', role: 'Software Engineer Intern - Austin, TX', status: 'applied', appliedAt: recent },
    q: { company: 'Coinbase', role: 'Software Engineer Intern - Seattle, WA' }, truth: 'different' },
  { name: 'P: "in Austin, TX | Coinbase" and "in Seattle, WA | Coinbase"',
    row: { id: 'r16', company: 'Coinbase', role: 'Software Engineer Intern in Austin, TX | Coinbase', status: 'applied', appliedAt: recent },
    q: { company: 'Coinbase', role: 'Software Engineer Intern in Seattle, WA | Coinbase' }, truth: 'different' },
  { name: 'Q: two Amazon job ids, the row bare',
    row: { id: 'r17', company: 'Amazon', role: 'Software Dev Engineer I, Graviton Software, Annapurna Labs', url: 'https://www.amazon.jobs/en/jobs/10526808/x', status: 'applied', appliedAt: recent },
    q: { company: 'Amazon', role: 'Software Dev Engineer I, Graviton Software, Annapurna Labs - Job ID: 10999999', url: 'https://www.amazon.jobs/en/jobs/10999999/x' }, truth: 'different' },
];

describe('whether a row and a posting are one job', () => {
  for (const pair of PAIRS) {
    it(`${pair.name}: ${pair.truth}`, () => {
      const apps = [pair.row as Application];
      const found = findApplication(apps, pair.q.company, pair.q.role, pair.q.url);
      const sent = alreadySent(apps, pair.q.company, pair.q.role, pair.q.url);
      if (pair.truth === 'different') {
        expect(found?.id).toBeUndefined();
        expect(sent?.id).toBeUndefined();
      } else {
        expect(found?.id).toBe(pair.row.id);
      }
    });
  }

  /*
   * How surely. A shared requisition is as good as an address; titles that
   * agree with nothing else in common — LinkedIn's page and an ATS's form —
   * are a suggestion, and a suggestion never says "already sent".
   */
  it('is sure of a shared requisition, and only suggests where the names alone agree', () => {
    const strength = (name: string) => {
      const pair = PAIRS.find((p) => p.name.startsWith(name))!;
      return applications.findApplicationMatch([pair.row as Application], pair.q.company, pair.q.role, pair.q.url)?.strength;
    };
    expect(strength('K:')).toBe('strong');
    expect(strength('L:')).toBe('strong');
    expect(strength('N:')).toBe('strong');
    expect(strength('F:')).toBe('weak');
    expect(strength('G:')).toBe('weak');
    expect(strength('J:')).toBe('weak');
    expect(strength('M:')).toBe('weak');
    // So a sent row matched only by the names is not "already sent", and nothing writes into it.
    for (const name of ['J:', 'M:']) {
      const pair = PAIRS.find((p) => p.name.startsWith(name))!;
      expect(alreadySent([pair.row as Application], pair.q.company, pair.q.role, pair.q.url)).toBeUndefined();
      expect(applications.applicationToWrite([pair.row as Application], pair.q.company, pair.q.role, pair.q.url)).toBeUndefined();
    }
    // While K's, tied by its requisition, still is.
    const k = PAIRS.find((p) => p.name.startsWith('K:'))!;
    expect(alreadySent([k.row as Application], k.q.company, k.q.role, k.q.url)?.id).toBe('r11');
  });

  /*
   * The employer's own site, its posting and its form, neither address with a
   * number in it: nothing there says another job, so the names on that site
   * are sure. Not on a board's site, which is everybody's.
   */
  it("is sure of one title on the employer's own site, and not on a board's", () => {
    const sent = { id: 'helios', company: 'Helios', role: 'Platform Engineer', url: 'https://careers.helios.example/apply/platform-engineer', status: 'applied', appliedAt: recent } as Application;
    expect(applications.findApplicationMatch([sent], 'Helios', 'Platform Engineer', 'https://careers.helios.example/roles/platform-engineer')?.strength).toBe('strong');
    expect(alreadySent([sent], 'Helios', 'Platform Engineer', 'https://careers.helios.example/roles/platform-engineer')?.id).toBe('helios');
    const onBoard = { ...sent, url: 'https://www.indeed.com/q-platform-jobs.html' };
    expect(applications.findApplicationMatch([onBoard], 'Helios', 'Platform Engineer', 'https://www.indeed.com/q-platform-engineer-jobs.html')?.strength).toBe('weak');
  });

  /*
   * A match by the names alone against a row nothing has happened to for
   * half a year is last year's application or another job: ignored.
   */
  it('ignores a match by the names alone against a row untouched for more than 180 days', () => {
    const old = { id: 'old', company: 'Ivo', role: 'Software Engineer, Backend', url: 'https://jobs.ashbyhq.com/ivo/4a5b', status: 'applying', appliedAt: ago(200) } as Application;
    const fresh = { ...old, id: 'fresh', appliedAt: ago(30) };
    const q = ['Ivo', 'Software Engineer, Backend', 'https://www.linkedin.com/jobs/view/4470000001'] as const;
    expect(findApplication([old], ...q)).toBeUndefined();
    expect(findApplication([fresh], ...q)?.id).toBe('fresh');
    // Nor by its history: a row touched last month is not old, whenever it began.
    const touched = { ...old, id: 'touched', history: [{ at: ago(10), status: 'applying' as const, note: 'Started filling in the form' }] };
    expect(findApplication([touched], ...q)?.id).toBe('touched');
    // At its own address it is the same job however old.
    expect(findApplication([old], 'Ivo', 'Software Engineer, Backend', 'https://jobs.ashbyhq.com/ivo/4a5b')?.id).toBe('old');
  });

  it('reads two places under one title as two jobs, and a place on one side only as the same', () => {
    expect(sameIdentity('Coinbase', 'Software Engineer Intern in Austin, TX | Coinbase', 'Coinbase', 'Software Engineer Intern in Seattle, WA | Coinbase')).toBe(false);
    expect(sameIdentity('Coinbase', 'Software Engineer Intern in Austin, TX | Coinbase', 'Coinbase', 'Software Engineer Intern')).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * Through the routes                                                  *
 * ------------------------------------------------------------------ */

const RALEIGH_ROW = {
  id: '2026-09-20-red-hat-software-engineer-intern',
  company: 'Red Hat',
  role: 'Software Engineer Intern',
  url: RALEIGH,
  status: 'applied',
  appliedAt: ago(20),
  resumeId: 'intern',
  coverLetter: 'Dear Red Hat Raleigh team, ... (letter A as sent)',
  history: [
    { at: ago(21), status: 'applying', note: 'Workspace opened' },
    { at: ago(20), status: 'applied', note: 'The form was submitted on the page' },
  ],
};
const BOSTON_JOB = { company: 'Red Hat', role: 'Software Engineer Intern (R-111111)', url: BOSTON };

describe('a second requisition at one employer, through the routes', () => {
  it('opens a space of its own, drafting, and records its send as a new row', async () => {
    const api = serve([RALEIGH_ROW]);
    const ws = await api.post('/api/workspace').send({ ...BOSTON_JOB, resumeId: 'base', coverLetterRequired: true }).expect(200);
    expect(ws.body.draft.id).not.toBe(RALEIGH_ROW.id);
    expect(ws.body.draft.status).toBe('drafting');

    const sent = await api.post('/api/extension/sent').send(BOSTON_JOB).expect(200);
    expect(sent.body.changed).toBe(true);
    expect(sent.body.application.id).toBe(ws.body.draft.id);
    expect(row(RALEIGH_ROW.id)).toMatchObject({ status: 'applied', url: RALEIGH, coverLetter: RALEIGH_ROW.coverLetter });
    expect(row(RALEIGH_ROW.id)?.history).toHaveLength(2);
  });

  it('completing it leaves the letter, resume and files sent to the first alone', async () => {
    const api = serve();
    const A = { company: 'Red Hat', role: 'Software Engineer Intern', url: RALEIGH };
    let r = await api.post('/api/workspace').send({ ...A, resumeId: 'intern', coverLetterRequired: true }).expect(200);
    const idA = r.body.draft.id;
    await api.put(`/api/workspace/${idA}`).send({ coverLetter: { required: true, body: 'LETTER A: Dear Raleigh team.', edited: true } }).expect(200);
    await api.post(`/api/workspace/${idA}/complete`).send({}).expect(200);
    const sentA = row(idA)!;
    const pdfA = fs.readFileSync(path.join(t!.store.outDir(), 'applications', idA, 'Test-Person-Resume.pdf'), 'utf8');

    r = await api.post('/api/workspace').send({ ...BOSTON_JOB, resumeId: 'newgrad', coverLetterRequired: true }).expect(200);
    const idB = r.body.draft.id;
    expect(idB).not.toBe(idA);
    expect(r.body.draft.status).toBe('drafting');
    expect(r.body.draft.coverLetter.body).not.toMatch(/LETTER A/);
    await api.put(`/api/workspace/${idB}`).send({ resumeId: 'newgrad', coverLetter: { required: true, body: 'LETTER B: Dear Boston team.', edited: true } }).expect(200);
    await api.post(`/api/workspace/${idB}/complete`).send({}).expect(200);

    expect(row(idA)).toMatchObject({ role: sentA.role, url: RALEIGH, resumeId: 'intern', letterId: sentA.letterId });
    expect(fs.readFileSync(path.join(t!.store.outDir(), 'applications', idA, 'Test-Person-Resume.pdf'), 'utf8')).toBe(pdfA);
    expect(t!.store.loadCoverLetters().find((l) => l.id === sentA.letterId)?.body).toMatch(/LETTER A/);
    expect(row(idB)).toMatchObject({ status: 'applied', resumeId: 'newgrad', url: BOSTON });
  });

  it('is not "already applied" on the card, nor given the first one\'s id and resume', async () => {
    const api = serve([RALEIGH_ROW]);
    const ld = {
      '@context': 'https://schema.org',
      '@type': 'JobPosting',
      title: 'Software Engineer Intern',
      identifier: { '@type': 'PropertyValue', name: 'Red Hat', value: 'R-111111' },
      hiringOrganization: { '@type': 'Organization', name: 'Red Hat' },
      jobLocation: { '@type': 'Place', address: { addressLocality: 'Boston', addressRegion: 'MA', addressCountry: 'US' } },
      datePosted: '2026-10-01',
      employmentType: 'INTERN',
      description:
        '<p>Join the RHEL kernel team in Boston as a Software Engineer Intern. You will write C and Python, work on Linux kernel subsystems, and collaborate with upstream communities. Requirements: pursuing a BS in Computer Science, experience with C, Python, Git, Linux. Summer 2027 internship, 12 weeks.</p>'.repeat(3),
    };
    const html = `<html><head><title>Software Engineer Intern - R-111111</title><script type="application/ld+json">${JSON.stringify(ld)}</script></head><body><h1>Software Engineer Intern</h1><div>${ld.description}</div><a>Apply</a></body></html>`;
    const r = await api.post('/api/extension/analyze').send({ url: BOSTON, title: 'Software Engineer Intern - R-111111', html, tailor: 'none' }).expect(200);
    // Not "you applied": "you may have", with when and where, so it can be told apart.
    expect(r.body.applied).toMatchObject({ maybe: true, id: RALEIGH_ROW.id, url: RALEIGH });
    expect(r.body.applied.at).toBeTruthy();
    expect(r.body.application.id).not.toBe(RALEIGH_ROW.id);
    expect(r.body.application.resumeId).toBeUndefined();
  });

  /*
   * Asked, not refused for good and not filed silently: the automatic stage
   * is held as "maybe sent", and told it is another job it files a row of
   * its own, the sent one as it was.
   */
  it('asks before staging, and once told it is another job files a new row', async () => {
    const api = serve([RALEIGH_ROW]);
    const job = { ...BOSTON_JOB, url: `${BOSTON}/apply`, resumeId: 'base', status: 'applying' };
    const asked = await api.post('/api/applications/bundle').send(job);
    expect(asked.status).toBe(409);
    expect(asked.body).toMatchObject({ kind: 'already-sent', maybe: true, application: { id: RALEIGH_ROW.id } });
    expect(asked.body.error).toMatch(/may be the same job/);
    expect(rows()).toHaveLength(1);

    const r = await api.post('/api/applications/bundle').send({ ...job, evenIfSent: true });
    expect(r.status).toBe(200);
    expect(r.body.application.id).not.toBe(RALEIGH_ROW.id);
    expect(rows()).toHaveLength(2);
    expect(row(RALEIGH_ROW.id)).toMatchObject({ status: 'applied', resumeId: 'intern', url: RALEIGH, coverLetter: RALEIGH_ROW.coverLetter });
    expect(row(RALEIGH_ROW.id)?.history).toHaveLength(2);
  });

  it('records a send with a bare title at another requisition as its own row', async () => {
    const api = serve([RALEIGH_ROW]);
    const r = await api.post('/api/extension/sent').send({ company: 'Red Hat', role: 'Software Engineer Intern', url: `${BOSTON}/apply` }).expect(200);
    expect(r.body.changed).toBe(true);
    expect(r.body.application.id).not.toBe(RALEIGH_ROW.id);
    expect(rows()).toHaveLength(2);
  });
});

describe('two jobs one title, through the other routes', () => {
  const INTERVIEW = {
    id: '2026-09-01-coinbase-software-engineer-intern',
    company: 'Coinbase',
    role: 'Software Engineer Intern',
    url: 'https://job-boards.greenhouse.io/coinbase/jobs/7000001',
    status: 'interview',
    appliedAt: ago(40),
    resumeId: 'intern',
    notes: 'Phone screen with the payments team',
    history: [
      { at: ago(40), status: 'applied', note: 'Recorded' },
      { at: ago(25), status: 'interview', note: 'Phone screen booked' },
    ],
  };

  it('records another Greenhouse job by hand as its own row, leaving the interview as it was', async () => {
    const api = serve([INTERVIEW]);
    const r = await api
      .post('/api/applications')
      .send({ company: 'Coinbase', role: 'Software Engineer Intern', url: 'https://job-boards.greenhouse.io/coinbase/jobs/7000999', resumeId: 'base', notes: 'Applied to the NYC posting' })
      .expect(200);
    expect(r.body.id).not.toBe(INTERVIEW.id);
    expect(row(INTERVIEW.id)).toMatchObject({ status: 'interview', url: INTERVIEW.url, notes: INTERVIEW.notes });
  });

  it('never moves a row found by name backwards', async () => {
    const api = serve([INTERVIEW]);
    await api.post('/api/applications').send({ company: 'Coinbase', role: 'Software Engineer Intern', url: INTERVIEW.url, status: 'applied' }).expect(200);
    expect(row(INTERVIEW.id)?.status).toBe('interview');
    expect(rows()).toHaveLength(1);
  });

  /*
   * Kept, and what was typed added to it: the note under the row's own, the
   * address as one more the row is found at. Both used to be dropped.
   */
  it('keeps the address and notes of a row found only by its name, adding what was typed', async () => {
    const working = { ...INTERVIEW, id: 'ivo', company: 'Ivo', role: 'Software Engineer, Backend', url: 'https://jobs.ashbyhq.com/ivo/4a5b', status: 'applying', notes: 'Referred by Sam' };
    const api = serve([working]);
    const linkedIn = 'https://www.linkedin.com/jobs/view/4470000001';
    await api
      .post('/api/applications')
      .send({ company: 'Ivo', role: 'Software Engineer, Backend', url: linkedIn, notes: 'Applied on LinkedIn' })
      .expect(200);
    expect(rows()).toHaveLength(1);
    expect(row('ivo')).toMatchObject({ url: working.url, notes: 'Referred by Sam\nApplied on LinkedIn' });
    expect(row('ivo')?.aliases).toEqual([{ company: 'Ivo', role: 'Software Engineer, Backend', url: linkedIn }]);
    // A note the row already says is not said twice.
    await api
      .post('/api/applications')
      .send({ company: 'Ivo', role: 'Software Engineer, Backend', url: 'https://ivo.example/careers/backend', notes: 'Referred by Sam' })
      .expect(200);
    expect(rows()).toHaveLength(1);
    expect(row('ivo')?.notes).toBe('Referred by Sam\nApplied on LinkedIn');
    expect(row('ivo')?.aliases).toHaveLength(2);
  });

  it("does not swallow this year's send into last year's row at another job number", async () => {
    const api = serve([{ id: '2025-09-20-coinbase-software-engineer-intern', company: 'Coinbase', role: 'Software Engineer Intern', url: 'https://www.coinbase.com/careers/positions/5000001', status: 'applied', appliedAt: ago(390), history: [{ at: ago(390), status: 'applied', note: 'Recorded' }] }]);
    const r = await api.post('/api/extension/sent').send({ company: 'Coinbase', role: 'Software Engineer Intern', url: 'https://www.coinbase.com/careers/positions/7000777' }).expect(200);
    expect(r.body.changed).toBe(true);
    expect(rows()).toHaveLength(2);
  });

  it('does not move the row of the job being written when another job is sent', async () => {
    const writing = { id: '2026-10-10-coinbase-software-engineer-intern', company: 'Coinbase', role: 'Software Engineer Intern', url: 'https://job-boards.greenhouse.io/coinbase/jobs/7000001', status: 'applying', appliedAt: ago(2), history: [{ at: ago(2), status: 'applying', note: 'Workspace opened' }] };
    const api = serve([writing]);
    const r = await api.post('/api/extension/sent').send({ company: 'Coinbase', role: 'Software Engineer Intern', url: 'https://job-boards.greenhouse.io/coinbase/jobs/7000999' }).expect(200);
    expect(r.body.application.id).not.toBe(writing.id);
    expect(row(writing.id)?.status).toBe('applying');
  });

  it('files the Seattle posting apart from the Austin one', async () => {
    const api = serve([{ id: '2026-09-20-coinbase-x', company: 'Coinbase', role: 'Software Engineer Intern in Austin, TX | Coinbase', status: 'applied', appliedAt: ago(20) }]);
    const r = await api.post('/api/extension/sent').send({ company: 'Coinbase', role: 'Software Engineer Intern in Seattle, WA | Coinbase' }).expect(200);
    expect(r.body.changed).toBe(true);
    expect(r.body.application.id).not.toBe('2026-09-20-coinbase-x');
  });

  /*
   * A sent row found only by the names, against a posting that has an
   * address: the ordinary second job with the same title. Recorded as its
   * own, never swallowed.
   */
  it('records a send at an address against a sent row with none as a new row', async () => {
    const api = serve([{ id: 'bare', company: 'Coinbase', role: 'Software Engineer Intern', status: 'applied', appliedAt: ago(20), history: [{ at: ago(20), status: 'applied', note: 'Recorded' }] }]);
    const r = await api.post('/api/extension/sent').send({ company: 'Coinbase', role: 'Software Engineer Intern', url: 'https://www.linkedin.com/jobs/view/4470000009' }).expect(200);
    expect(r.body.changed).toBe(true);
    expect(r.body.application.id).not.toBe('bare');
    expect(row('bare')?.history).toHaveLength(1);
  });
});

describe("a row's space, found when the row is moved or renamed", () => {
  const LAST_YEAR = {
    id: '2025-09-20-coinbase-software-engineer-intern',
    company: 'Coinbase',
    role: 'Software Engineer Intern',
    url: 'https://www.coinbase.com/careers/positions/5000001',
    status: 'closed',
    appliedAt: ago(390),
    history: [
      { at: ago(390), status: 'applied', note: 'Recorded' },
      { at: ago(340), status: 'closed', note: 'Rejected' },
    ],
  };
  const THIS_YEAR = {
    id: '2026-10-01-coinbase-software-engineer-intern',
    company: 'Coinbase',
    role: 'Software Engineer Intern',
    url: 'https://www.coinbase.com/careers/positions/7000777',
    status: 'applied',
    appliedAt: ago(11),
    history: [{ at: ago(11), status: 'applied', note: 'The form was submitted on the page' }],
  };
  const SPACE = {
    id: THIS_YEAR.id,
    company: 'Coinbase',
    role: 'Software Engineer Intern',
    url: THIS_YEAR.url,
    status: 'submitted',
    createdAt: ago(11),
    updatedAt: ago(11),
    coverLetter: { required: true, body: 'Letter sent for the 2027 internship', edited: true },
    questions: [],
  };

  it("does not reopen another row's sent space when last year's row is moved back to applying", async () => {
    const api = serve([LAST_YEAR, THIS_YEAR], [SPACE]);
    await api.post(`/api/applications/${LAST_YEAR.id}/status`).send({ status: 'applying', note: 'Recruiter asked me to re-apply' }).expect(200);
    expect(draftsNow().find((d) => d.id === SPACE.id)?.status).toBe('submitted');
  });

  it("does not rename another row's space when last year's row is renamed", async () => {
    const api = serve([LAST_YEAR, THIS_YEAR], [SPACE]);
    await api.patch(`/api/applications/${LAST_YEAR.id}`).send({ role: 'Software Engineer Intern (Summer 2026)' }).expect(200);
    expect(draftsNow().find((d) => d.id === SPACE.id)?.role).toBe('Software Engineer Intern');
  });

  /*
   * The fallback itself, with addresses that do not tell the two apart: a
   * space whose id is another row's is that row's, whatever its names.
   */
  it("leaves out a space whose id is another row's even when nothing else tells them apart", async () => {
    const bare = <T extends object>(r: T) => ({ ...r, url: undefined });
    const api = serve([bare(LAST_YEAR), bare(THIS_YEAR)], [bare(SPACE)]);
    await api.post(`/api/applications/${LAST_YEAR.id}/status`).send({ status: 'applying' }).expect(200);
    expect(draftsNow().find((d) => d.id === SPACE.id)?.status).toBe('submitted');
  });
});

describe('one job written two ways is one row', () => {
  const PAIRS_OF_PAGES: [string, Record<string, string>, Record<string, string>][] = [
    ['"(Remote)" on LinkedIn', { company: 'Ivo', role: 'Software Engineer, Backend (Remote)', url: 'https://www.linkedin.com/jobs/view/4470000001' }, { company: 'Ivo', role: 'Software Engineer, Backend', url: 'https://jobs.ashbyhq.com/ivo/1b2c3d4e-0000-4000-8000-000000000001/application' }],
    ['" - Remote" on LinkedIn', { company: 'Ivo', role: 'Software Engineer, Backend - Remote', url: 'https://www.linkedin.com/jobs/view/4470000001' }, { company: 'Ivo', role: 'Software Engineer, Backend', url: 'https://jobs.ashbyhq.com/ivo/1b2c3d4e-0000-4000-8000-000000000001/application' }],
    ['"2027 Summer" and "Summer 2027"', { company: 'ByteDance', role: 'Software Engineer Intern (AI Infra Compute) - 2027 Summer', url: 'https://joinbytedance.com/search/7667378931599214853' }, { company: 'ByteDance', role: 'Software Engineer Intern (AI Infra Compute) - Summer 2027', url: 'https://www.linkedin.com/jobs/view/4470000002' }],
  ];
  for (const [name, opened, sent] of PAIRS_OF_PAGES) {
    it(`${name}: the space opened on one page and the send from the other`, async () => {
      const api = serve();
      await api.post('/api/workspace').send({ ...opened, resumeId: 'base' }).expect(200);
      await api.post('/api/extension/sent').send(sent).expect(200);
      expect(rows()).toHaveLength(1);
      expect(rows()[0]?.status).toBe('applied');
      expect(draftsNow()[0]?.status).toBe('submitted');
    });
  }

  it('but two postings with two job numbers under those titles are still two', async () => {
    const api = serve();
    await api.post('/api/workspace').send({ company: 'Ivo', role: 'Software Engineer, Backend (Remote)', url: 'https://www.linkedin.com/jobs/view/4470000001', resumeId: 'base' }).expect(200);
    await api.post('/api/extension/sent').send({ company: 'Ivo', role: 'Software Engineer, Backend', url: 'https://www.linkedin.com/jobs/view/4470000777' }).expect(200);
    expect(rows()).toHaveLength(2);
  });
});

/* ------------------------------------------------------------------ *
 * Round 23: one job's other page, and asking                          *
 * ------------------------------------------------------------------ */

const { maybeSent, applicationToWrite, findApplicationMatch } = applications;
const { requisitionInUrl, globalJobId } = await import('../src/jobs/names.js');

const sentRow = (o: Partial<Application> & { id: string; company: string; role: string }) =>
  ({ status: 'applied', appliedAt: ago(10), history: [{ at: ago(10), status: 'applied', note: 'Recorded' }], ...o }) as Application;

/*
 * The ATSs that number a job once for everybody: the same id is the same
 * job on any host, the board and the employer's careers page alike; two of
 * them are two jobs.
 */
describe('an id an ATS gives a job everywhere', () => {
  const SAME: [string, string, string][] = [
    ['Greenhouse board, and the employer page with gh_jid', 'https://job-boards.greenhouse.io/figma/jobs/6143238004/confirmation?gh_src=28109e334us', 'https://www.figma.com/careers/job/?gh_jid=6143238004'],
    ["the employer's page, and the board", 'https://www.epicgames.com/site/careers/jobs/6152263004?gh_jid=6152263004&gh_src=32b5d0474us', 'https://job-boards.greenhouse.io/epicgames/jobs/6152263004'],
    ['the board, and the embedded form by token', 'https://job-boards.greenhouse.io/figma/jobs/6143238004', 'https://boards.greenhouse.io/embed/job_app?for=figma&token=6143238004'],
    ['a SmartRecruiters posting with and without its words', 'https://jobs.smartrecruiters.com/Visa/744000087654321-software-engineer-intern', 'https://jobs.smartrecruiters.com/Visa/744000087654321'],
    ['Lever, posting and form', 'https://jobs.lever.co/acme/1a2b3c4d-1111-2222-3333-444455556666', 'https://jobs.lever.co/acme/1a2b3c4d-1111-2222-3333-444455556666/apply?lever-source=LinkedIn'],
    ['Ashby, posting and form', 'https://jobs.ashbyhq.com/acme/1a2b3c4d-1111-2222-3333-444455556666', 'https://jobs.ashbyhq.com/acme/1a2b3c4d-1111-2222-3333-444455556666/application'],
  ];
  for (const [name, sentAt, visit] of SAME) {
    it(`${name}: already sent`, () => {
      const rows = [sentRow({ id: 'x', company: 'Figma', role: 'Software Engineer Intern', url: sentAt })];
      expect(findApplicationMatch(rows, 'Figma', 'Software Engineer Intern', visit)?.strength).toBe('strong');
      expect(alreadySent(rows, 'Figma', 'Software Engineer Intern', visit)?.id).toBe('x');
    });
  }

  it('reads the ids', () => {
    expect(globalJobId('https://www.figma.com/careers/job/?gh_jid=6143238004')).toBe('greenhouse:6143238004');
    expect(globalJobId('https://boards.greenhouse.io/embed/job_app?for=figma&token=6143238004')).toBe('greenhouse:6143238004');
    expect(globalJobId('https://jobs.smartrecruiters.com/oneclick-ui/company/Visa/publication/5b5d5d70-1c2e-4a6f-9d0b-123456789abc?dcr_ci=Visa')).toBe(
      'smartrecruiters-publication:5b5d5d70-1c2e-4a6f-9d0b-123456789abc',
    );
    expect(globalJobId('https://www.linkedin.com/jobs/view/4461337126/')).toBeUndefined();
  });

  it('reads two Greenhouse ids across hosts as two jobs, which only asks', () => {
    const rows = [sentRow({ id: 'x', company: 'Figma', role: 'Software Engineer Intern', url: 'https://job-boards.greenhouse.io/figma/jobs/6143238004' })];
    const visit = 'https://www.figma.com/careers/job/?gh_jid=6999999004';
    expect(findApplicationMatch(rows, 'Figma', 'Software Engineer Intern', visit)).toBeUndefined();
    expect(alreadySent(rows, 'Figma', 'Software Engineer Intern', visit)).toBeUndefined();
    expect(maybeSent(rows, 'Figma', 'Software Engineer Intern', visit)?.id).toBe('x');
  });
});

/*
 * Workday numbers each posting of a requisition, "_R-059038-1"; the count
 * is not the requisition. Real addresses from a tracker.
 */
describe("a Workday posting's count after its requisition", () => {
  it.each([
    ['https://redhat.wd5.myworkdayjobs.com/en-US/jobs/job/Raleigh/Software-Engineer-Intern_R-059038-1/apply', 'r059038'],
    ['https://intel.wd1.myworkdayjobs.com/External/job/US-Oregon-Hillsboro/Software-Engineering-Intern_JR0286834-1/apply', 'jr0286834'],
    ['https://pae.wd1.myworkdayjobs.com/en-US/Amentum_Careers/job/US-TX-Houston/Mission-Design-Tools-Software-Engineer_R0164451-9/apply/autofillWithResume?source=www.google.com', 'r0164451'],
    ['https://kla.wd1.myworkdayjobs.com/en-US/Search/job/Milpitas%2C-CA/Software-Engineering-Intern_2641581-1/apply/autofillWithResume?bid=370&source=Job_Board_LinkedIn', '2641581'],
    ['https://allegion.wd5.myworkdayjobs.com/en-US/careers/job/Golden%2C-CO/Summer-Intern---Software-Engineering_JR37795-1/apply/autofillWithResume?source=linkedin', 'jr37795'],
    ['https://redhat.wd5.myworkdayjobs.com/en-US/jobs/job/Raleigh/Software-Engineer-Intern_R-059038', 'r059038'],
    ['https://acme.wd5.myworkdayjobs.com/en-US/jobs/job/X/Engineer_JR-2026-0412', 'jr20260412'],
  ])('%s is %s', (url, req) => {
    expect(requisitionInUrl(url)).toBe(req);
  });

  it("is the same job as LinkedIn's title with the requisition", () => {
    const rows = [sentRow({ id: 'wd', company: 'Red Hat', role: 'Software Engineer Intern', url: 'https://redhat.wd5.myworkdayjobs.com/en-US/jobs/job/Raleigh/Software-Engineer-Intern_R-059038-1/apply' })];
    expect(alreadySent(rows, 'Red Hat', 'Software Engineer Intern (R-059038)', 'https://www.linkedin.com/jobs/view/4461337126/')?.id).toBe('wd');
  });
});

describe('a sent row the names alone tie to: maybe sent', () => {
  const STRIPE = sentRow({ id: 'stripe', company: 'Stripe', role: 'Software Engineer, Intern (Summer or Winter)', url: 'https://www.linkedin.com/jobs/view/4462047454/' });
  const FORM = 'https://stripe.com/jobs/listing/software-engineer-intern-summer-or-winter/7210115';

  it('is not "already sent", is "maybe sent", and nothing writes into it', () => {
    const rows = [STRIPE];
    expect(alreadySent(rows, STRIPE.company, STRIPE.role, FORM)).toBeUndefined();
    expect(maybeSent(rows, STRIPE.company, STRIPE.role, FORM)?.id).toBe('stripe');
    expect(applicationToWrite(rows, STRIPE.company, STRIPE.role, FORM)).toBeUndefined();
  });

  it('is not asked about when the job surely has its own row being worked on', () => {
    const working = { ...STRIPE, id: 'working', status: 'applying', url: FORM } as Application;
    expect(maybeSent([STRIPE, working], STRIPE.company, STRIPE.role, FORM)).toBeUndefined();
  });

  it('nor when it was sent more than half a year ago', () => {
    const old = { ...STRIPE, appliedAt: ago(200), history: [{ at: ago(200), status: 'applied' as const }] };
    expect(maybeSent([old], STRIPE.company, STRIPE.role, FORM)).toBeUndefined();
  });

  it('is said on the card with when and where', async () => {
    const api = serve([STRIPE]);
    const html = `<html><head><title>Software Engineer, Intern (Summer or Winter) | Stripe</title></head><body><h1>Software Engineer, Intern (Summer or Winter)</h1><p>${'Stripe is hiring interns to build payments infrastructure in Ruby, Go and Java. '.repeat(12)}</p><a>Apply</a></body></html>`;
    const r = await api.post('/api/extension/analyze').send({ url: FORM, title: 'Software Engineer, Intern (Summer or Winter) | Stripe', html, tailor: 'none', company: 'Stripe', role: STRIPE.role }).expect(200);
    expect(r.body.applied).toMatchObject({ maybe: true, id: 'stripe', url: STRIPE.url });
  });

  it('a strong match still re-files into the sent row with evenIfSent', async () => {
    const api = serve([{ ...STRIPE, resumeId: 'intern' }]);
    const job = { company: STRIPE.company, role: STRIPE.role, url: STRIPE.url, resumeId: 'base', status: 'applying' };
    const refused = await api.post('/api/applications/bundle').send(job);
    expect(refused.status).toBe(409);
    expect(refused.body.maybe).toBeUndefined();
    const r = await api.post('/api/applications/bundle').send({ ...job, evenIfSent: true }).expect(200);
    expect(r.body.application.id).toBe('stripe');
    expect(rows()).toHaveLength(1);
  });

  it('a send from the other page records a new row, and leaves the sent one alone', async () => {
    const api = serve([STRIPE]);
    const r = await api.post('/api/extension/sent').send({ company: STRIPE.company, role: STRIPE.role, url: FORM }).expect(200);
    expect(r.body.application.id).not.toBe('stripe');
    expect(row('stripe')).toMatchObject({ url: STRIPE.url, status: 'applied' });
    expect(row('stripe')?.history).toHaveLength(1);
  });

  /*
   * "Record an application" for a job sent from LinkedIn, with the
   * employer's address and a note: the person says it is the one they sent,
   * by its exact names. The row is updated — the address kept as an alias,
   * the note added — rather than a "-2" beside it. The employer's address
   * here names no job of its own (round 24: one that does is another job,
   * below).
   */
  it('recorded by hand with its exact names and the employer address, updates the sent row', async () => {
    const api = serve([STRIPE]);
    const CAREERS = 'https://stripe.com/jobs/listing/software-engineer-intern-summer-or-winter';
    await api.post('/api/applications').send({ company: STRIPE.company, role: STRIPE.role, url: CAREERS, notes: 'Recruiter: Jane' }).expect(200);
    expect(rows()).toHaveLength(1);
    expect(row('stripe')).toMatchObject({ status: 'applied', url: STRIPE.url, notes: 'Recruiter: Jane' });
    expect(row('stripe')?.aliases).toEqual([{ company: STRIPE.company, role: STRIPE.role, url: CAREERS }]);
    // And the employer's page is the row's now: already sent there.
    expect(alreadySent(rows(), STRIPE.company, STRIPE.role, CAREERS)?.id).toBe('stripe');
  });

  /*
   * Round 24. The typed address names a job: a LinkedIn posting's number,
   * beside a sent row whose address carries none (or another). Merged, the
   * posting's address became the sent row's alias, and from then on the
   * other job read as already sent there — strong evidence, made by hand
   * from a match by name. Two numbers are two rows.
   */
  it('but recorded at a posting with a job number of its own, is a new row, and the posting stays unsent', async () => {
    const SENT = sentRow({ id: 'stripe-site', company: 'Stripe', role: 'Software Engineer Intern', url: 'https://stripe.com/jobs/listing/software-engineer-intern/5555' });
    const LINKEDIN = 'https://www.linkedin.com/jobs/view/9999999999/';
    const api = serve([SENT]);
    const r = await api
      .post('/api/applications')
      .send({ company: SENT.company, role: SENT.role, url: LINKEDIN, status: 'applied', notes: 'Boston posting, applied via LinkedIn Easy Apply' })
      .expect(200);
    expect(r.body.id).not.toBe('stripe-site');
    expect(rows()).toHaveLength(2);
    expect(row('stripe-site')).toMatchObject({ url: SENT.url });
    expect(row('stripe-site')?.aliases).toBeUndefined();
    expect(row('stripe-site')?.notes).toBeUndefined();
    expect(row(r.body.id)).toMatchObject({ url: LINKEDIN, notes: 'Boston posting, applied via LinkedIn Easy Apply' });
    // Agreeing numbers still merge: the same Greenhouse job from its board and the employer's page.
    const GH = sentRow({ id: 'figma', company: 'Figma', role: 'Software Engineer Intern', url: 'https://boards.greenhouse.io/figma/jobs/6143238004' });
    t!.write('applications.yaml', [GH]);
    await api.post('/api/applications').send({ company: GH.company, role: GH.role, url: 'https://www.figma.com/careers/job/?gh_jid=6143238004', notes: 'Same one' }).expect(200);
    expect(rows()).toHaveLength(1);
  });

  it('but a posting the address says is another stays another', async () => {
    const api = serve([STRIPE]);
    await api.post('/api/applications').send({ company: STRIPE.company, role: STRIPE.role, url: 'https://www.linkedin.com/jobs/view/4462040000/', notes: 'The other one' }).expect(200);
    expect(rows()).toHaveLength(2);
    expect(row('stripe')?.notes).toBeUndefined();
  });
});

/*
 * Round 24: only a row that went, and only until the person has answered.
 *
 * Every status past `applying` counted as a send, so a row recorded at
 * `applying` and closed by hand — "Decided not to apply" — was "may have
 * applied to this already … was sent on <date>", the date being the day it
 * was recorded (`appliedAt`, stamped on every row). And once "It's another
 * job" had filed the new row, every later page of that application asked
 * the same question again, since the new row matched by name only and the
 * sent one was still there.
 */
describe('a sent row the names alone tie to: what counts as sent', () => {
  const { sendOf } = applications;
  const RALEIGH_WD = 'https://redhat.wd5.myworkdayjobs.com/jobs/job/Raleigh/Software-Engineer-Intern_R-059038';
  const LINKEDIN = 'https://www.linkedin.com/jobs/view/4462047454/';
  const neverSent = {
    id: 'redhat-1',
    company: 'Red Hat',
    role: 'Software Engineer Intern',
    status: 'closed',
    url: RALEIGH_WD,
    appliedAt: ago(12),
    history: [
      { at: ago(12), status: 'applying', note: 'Recorded' },
      { at: ago(8), status: 'closed', note: 'Decided not to apply' },
    ],
  } as Application;

  it('is not a row recorded and then closed by hand without ever going', () => {
    expect(sendOf(neverSent)).toBeUndefined();
    expect(maybeSent([neverSent], 'Red Hat', 'Software Engineer Intern', LINKEDIN)).toBeUndefined();
    const interestedThenClosed = { ...neverSent, history: [{ at: ago(12), status: 'interested' as const }, { at: ago(8), status: 'closed' as const, note: 'Not for me' }] };
    expect(maybeSent([interestedThenClosed], 'Red Hat', 'Software Engineer Intern', LINKEDIN)).toBeUndefined();
  });

  it('is a row that went and was closed after, and the date is the day it went', () => {
    const sentThenClosed = {
      ...neverSent,
      id: 'redhat-2',
      history: [
        { at: ago(12), status: 'applying' as const, note: 'Recorded' },
        { at: ago(9), status: 'applied' as const, note: 'The form was submitted on the page' },
        { at: ago(2), status: 'closed' as const, note: 'Rejected' },
      ],
    };
    expect(maybeSent([sentThenClosed], 'Red Hat', 'Software Engineer Intern', LINKEDIN)?.id).toBe('redhat-2');
    const { AlreadySent, localDay } = applications;
    const said = new AlreadySent(sentThenClosed, true).message;
    expect(said).toContain(`was sent on ${localDay(new Date(ago(9)))}`);
    expect(said).not.toContain(localDay(new Date(ago(12))));
    // A row from before the history was kept still counts by its status and its date.
    const legacy = { id: 'old', company: 'Red Hat', role: 'Software Engineer Intern', status: 'applied', appliedAt: ago(20) } as Application;
    expect(sendOf(legacy)).toEqual({ at: legacy.appliedAt });
    expect(maybeSent([legacy], 'Red Hat', 'Software Engineer Intern', LINKEDIN)?.id).toBe('old');
  });

  it('stands down for a live application by the same names begun after the send, and not for one begun before', () => {
    const sent = sentRow({ id: 'figma-sent', company: 'Figma', role: 'Software Engineer Intern', url: 'https://boards.greenhouse.io/figma/jobs/6143238004' });
    const FORM = 'https://boards.greenhouse.io/figma/jobs/7000000001';
    const after = { id: 'figma-2', company: 'Figma', role: 'Software Engineer Intern', status: 'applying', url: 'https://www.linkedin.com/jobs/view/4300000001/', history: [{ at: ago(1), status: 'applying', note: 'Files staged' }] } as Application;
    expect(maybeSent([sent], 'Figma', 'Software Engineer Intern', FORM)?.id).toBe('figma-sent');
    expect(maybeSent([sent, after], 'Figma', 'Software Engineer Intern', FORM)).toBeUndefined();
    // iCIMS's steps, begun before the send and left at applying, do not answer for it.
    const before = { ...after, id: 'figma-steps', url: 'https://careers-figma.icims.com/jobs/1234/login', history: [{ at: ago(30), status: 'applying' as const }] };
    expect(maybeSent([sent, before], 'Figma', 'Software Engineer Intern', FORM)?.id).toBe('figma-sent');
  });

  it('through the routes: a row recorded at applying and closed by hand does not hold a stage from LinkedIn', async () => {
    const api = serve([]);
    const made = await api.post('/api/applications').send({ company: 'Red Hat', role: 'Software Engineer Intern', status: 'applying', url: RALEIGH_WD }).expect(200);
    // Not sent, so no `appliedAt` — that is the date the card read as the send.
    expect(made.body.appliedAt).toBeUndefined();
    await api.post(`/api/applications/${made.body.id}/status`).send({ status: 'closed', note: 'Decided not to apply' }).expect(200);
    const seen = await api.post('/api/extension/analyze').send({ url: LINKEDIN, title: 'Software Engineer Intern - Red Hat', html: `<html><body><h1>Software Engineer Intern</h1><p>Red Hat</p><p>${'Build things in Go and Kubernetes. '.repeat(10)}</p></body></html>`, tailor: 'none', company: 'Red Hat', role: 'Software Engineer Intern' }).expect(200);
    expect(seen.body.applied).toBeUndefined();
    const staged = await api.post('/api/applications/bundle').send({ resumeId: 'intern', company: 'Red Hat', role: 'Software Engineer Intern', url: LINKEDIN, status: 'applying' });
    expect(staged.status).toBe(200);
    expect(staged.body.application.id).not.toBe(made.body.id);
    expect(rows()).toHaveLength(2);
    // Recorded as sent, the date is stamped as before.
    const sentByHand = await api.post('/api/applications').send({ company: 'Globex', role: 'Dev', status: 'applied' }).expect(200);
    expect(sentByHand.body.appliedAt).toBeTruthy();
  });

  it('through the routes: once "another job" has filed the new row, its later pages are not asked again', async () => {
    const sent = sentRow({ id: 'figma', company: 'Figma', role: 'Software Engineer Intern', url: 'https://boards.greenhouse.io/figma/jobs/6143238004', resumeId: 'intern' });
    const api = serve([sent]);
    const job = { resumeId: 'intern', company: 'Figma', role: 'Software Engineer Intern', status: 'applying' };
    const fromLinkedIn = await api.post('/api/applications/bundle').send({ ...job, url: 'https://www.linkedin.com/jobs/view/4300000001/' });
    expect(fromLinkedIn.status).toBe(409);
    expect(fromLinkedIn.body.maybe).toBe(true);
    const filed = await api.post('/api/applications/bundle').send({ ...job, url: 'https://www.linkedin.com/jobs/view/4300000001/', evenIfSent: true }).expect(200);
    expect(filed.body.application.id).not.toBe('figma');
    // The new job's own form, another Greenhouse id: not asked again.
    const FORM = 'https://boards.greenhouse.io/figma/jobs/7000000001';
    const onForm = await api.post('/api/applications/bundle').send({ ...job, url: FORM });
    expect(onForm.status).toBe(200);
    expect(onForm.body.application.id).toBe(filed.body.application.id);
    const seen = await api.post('/api/extension/analyze').send({ url: FORM, title: 'Software Engineer Intern', html: `<html><body><h1>Software Engineer Intern</h1><p>Figma</p><p>${'Design tools for everyone. '.repeat(10)}</p></body></html>`, tailor: 'none', company: 'Figma', role: 'Software Engineer Intern' }).expect(200);
    expect(seen.body.applied).toBeUndefined();
    expect(rows()).toHaveLength(2);
    expect(row('figma')?.history).toHaveLength(1);
  });
});

/*
 * The LinkedIn posting staged into a row, and the employer's form filling it
 * — a match by the names alone. The row moves to the form's address, and
 * keeps LinkedIn's as an alias, so the posting is still the row's after.
 */
describe("a row staged on LinkedIn, filled from the employer's form", () => {
  it("keeps LinkedIn's address as an alias", async () => {
    const linkedIn = 'https://www.linkedin.com/jobs/view/4462045886/';
    const ashby = 'https://jobs.ashbyhq.com/ramp/0f6e1c2a-1111-2222-3333-444455556666/application';
    const api = serve();
    const job = { company: 'Ramp', role: 'Software Engineering Intern, Backend', resumeId: 'base' };
    const first = await api.post('/api/applications/bundle').send({ ...job, url: linkedIn, status: 'applying' }).expect(200);
    const id = first.body.application.id;
    await api.post('/api/applications/bundle').send({ ...job, url: ashby, status: 'applied' }).expect(200);
    expect(rows()).toHaveLength(1);
    expect(row(id)).toMatchObject({ url: ashby, status: 'applied' });
    expect(row(id)?.aliases).toEqual([{ company: 'Ramp', role: job.role, url: linkedIn }]);
    expect(alreadySent(rows(), 'Ramp', job.role, linkedIn)?.id).toBe(id);
  });
});

/*
 * Found by replaying round 22 on a real history: lookups that found no row,
 * so a duplicate was filed, six of them against sent rows.
 */
describe('one job, by what its addresses really look like', () => {
  const at = (url: string, o: Partial<Application> = {}) => [{ ...sentRow({ id: 'r', company: 'Adobe', role: '2027 Intern - Software Engineer', url }), ...o } as Application];

  it("is not told apart by LinkedIn's currentJobId, which is a search page's selection", () => {
    const rows = at('https://www.linkedin.com/jobs/search-results/?currentJobId=4462058113&keywords=intern', { status: 'applying' });
    const q = ['Adobe', '2027 Intern - Software Engineer', 'https://www.linkedin.com/jobs/search-results/?currentJobId=4466497170&keywords=intern'] as const;
    expect(findApplicationMatch(rows, ...q)?.strength).toBe('weak');
    // And sent, it is asked about rather than nothing.
    const sent = at(rows[0]!.url!);
    expect(alreadySent(sent, ...q)).toBeUndefined();
    expect(maybeSent(sent, ...q)?.id).toBe('r');
  });

  it('reads one number spelt two ways on one site as one job', () => {
    expect(
      findApplicationMatch(
        at('https://careers.adobe.com/us/en/job/ADOBUSR171666EXTERNALENUS/2027-Intern-Software-Engineer?utm_source=linkedin', { status: 'applying' }),
        'Adobe',
        '2027 Intern - Software Engineer',
        'https://careers.adobe.com/us/en/job/R171666/2027-Intern-Software-Engineer',
      )?.row.id,
    ).toBe('r');
    const tesla = [sentRow({ id: 't', company: 'Tesla', role: 'Internship, Fullstack C++ Engineer, Vehicle User Interface (Winter/Spring 2027)', url: 'https://www.tesla.com/careers/search/job/apply/280604', status: 'applying' })];
    expect(
      findApplicationMatch(tesla, 'Tesla', tesla[0]!.role, 'https://www.tesla.com/careers/search/job/internship-fullstack-c-engineer-vehicle-user-interface-winter-spring-2027-280604')?.row.id,
    ).toBe('t');
  });

  it("is sure of an Eightfold posting and its form's pid", () => {
    const posting = 'https://bostonscientific.eightfold.ai/careers/job/563602813674232';
    const rows = [sentRow({ id: 'bsx', company: 'Boston Scientific', role: 'Software Engineer Intern', url: posting })];
    for (const form of [
      'https://bostonscientific.eightfold.ai/careers/apply/success?domain=bostonscientific.com&pid=563602813674232',
      'https://bostonscientific.eightfold.ai/careers/apply?pid=563602813674232&domain=bostonscientific.com',
    ]) {
      expect(findApplicationMatch(rows, 'Boston Scientific', 'Software Engineer Intern', form)?.strength, form).toBe('strong');
      expect(alreadySent(rows, 'Boston Scientific', 'Software Engineer Intern', form)?.id, form).toBe('bsx');
    }
    // The form and the page after it.
    const formRow = [{ ...rows[0]!, url: 'https://bostonscientific.eightfold.ai/careers/apply?pid=563602813674232&domain=bostonscientific.com' }];
    expect(alreadySent(formRow, 'Boston Scientific', 'Software Engineer Intern', 'https://bostonscientific.eightfold.ai/careers/apply/success?domain=bostonscientific.com&pid=563602813674232')?.id).toBe('bsx');
    // Another pid is not this job's, sure or otherwise: only asked about.
    const other = 'https://bostonscientific.eightfold.ai/careers/apply/success?domain=bostonscientific.com&pid=563602813567960';
    expect(alreadySent(rows, 'Boston Scientific', 'Software Engineer Intern', other)).toBeUndefined();
  });
});
