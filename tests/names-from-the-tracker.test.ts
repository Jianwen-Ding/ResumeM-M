/**
 * Who a job is with and what it is called — the rows the extractor still got
 * wrong after `employer-and-role.test.ts`, filed between 2026-09-29 and
 * 2026-10-08 in one person's tracker.
 *
 * Each `describe` is a row as "company | role", and each page is built from the
 * real title and address behind it (the descriptions are made up). Every case
 * goes through what `/extension/analyze` does with a trail — `mergeJobPages`,
 * then `employerOrUnknown` and `unnamedRole` for whatever the pages did not
 * name — and the first few go through the route itself.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  classifyPage,
  companyFromUrl,
  employerOrUnknown,
  extractJob,
  looksLikeAnApplication,
  looksLikeCompanyName,
  looksLikeRoleTitle,
  mergeJobPages,
  unnamedRole,
  type PageSource,
} from '../src/jobs/extract.js';
import { cleanRole, isFirmNamedForItsWork, jobNumberIn } from '../src/jobs/names.js';
import { makeTempStore, type TempStore } from './helpers.js';

let t: TempStore | undefined;
afterEach(() => {
  t?.cleanup();
  t = undefined;
});

const BODY = `<h2>About the role</h2>
<p>You will build and ship software with a small team. Responsibilities include design reviews,
testing and on-call. Minimum qualifications: pursuing a degree in computer science.</p>
<p>Apply now.</p>`;

const page = (title: string, head = '', body = BODY) =>
  `<html><head><title>${title}</title>${head}</head><body>${body}</body></html>`;

/** What `/extension/analyze` names a trail: the employer and the role, as it files them. */
function named(pages: { url: string; title: string; html?: string }[]): { company: string; role: string } {
  const trail: PageSource[] = pages.map((p) => ({ ...p, html: p.html ?? page(p.title) }));
  const job = mergeJobPages(trail);
  return {
    company: job.company ?? employerOrUnknown(...trail.map((p) => p.url)),
    role: job.title ?? unnamedRole(trail.map((p) => p.url)),
  };
}

/** The route itself, for the cases where it matters that the whole path agrees. */
async function analyzer() {
  const { default: express } = await import('express');
  const { default: request } = await import('supertest');
  const { createApi } = await import('../src/server/api.js');
  const { Repo } = await import('../src/git/repo.js');
  t = makeTempStore({ config: { git: { autoCommit: false }, output: { dir: 'out' } } });
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use('/api', createApi({ store: t.store, repo: Repo.forStore(t.dir) }));
  return async (pages: { url: string; title: string; html?: string }[]) => {
    const sent = pages.map((p) => ({ ...p, html: p.html ?? page(p.title) }));
    const last = sent[sent.length - 1]!;
    const res = await request(app)
      .post('/api/extension/analyze')
      .send({ url: last.url, title: last.title, html: last.html, pages: sent, baseResumeId: 'base', tailor: 'none' })
      .expect(200);
    return res.body.spec.generatedFor as { company: string; role: string };
  };
}

const LINKEDIN = (id: string) =>
  `https://www.linkedin.com/jobs/search-results/?currentJobId=${id}&keywords=c%2B%2B%20intern%20posted%20in%20the%20past%2024&origin=SUGGESTION&start=0`;

describe('"Unknown company | Software Engineering Intern | Thermagia Engineering" — a firm named for its work', () => {
  const TITLE = 'Software Engineering Intern | Thermagia Engineering | LinkedIn';

  it('is Thermagia Engineering, and the role is the job alone', async () => {
    const analyze = await analyzer();
    expect(await analyze([{ url: LINKEDIN('4472949726'), title: TITLE }])).toMatchObject({
      company: 'Thermagia Engineering',
      role: 'Software Engineering Intern',
    });
  });

  it('and "Wellington Management" the same way', () => {
    expect(
      named([{ url: LINKEDIN('4455904956'), title: 'Technology Undergraduate Summer Internship | Wellington Management | LinkedIn' }]),
    ).toEqual({ company: 'Wellington Management', role: 'Technology Undergraduate Summer Internship' });
  });

  it('is a name you can write to, where a kind of work is not', () => {
    for (const name of ['Thermagia Engineering', 'Wellington Management', 'Halcyon Development']) {
      expect(isFirmNamedForItsWork(name), name).toBe(true);
      expect(looksLikeCompanyName(name), name).toBe(true);
    }
    for (const name of [
      'Software Engineering',
      'Product Management',
      'Project Management',
      'Risk Management',
      'Business Development',
      'Senior Software Engineering',
      'Program Management',
      'software engineering',
      'Software Development Engineer',
    ]) {
      expect(isFirmNamedForItsWork(name), name).toBe(false);
      expect(looksLikeCompanyName(name), name).toBe(false);
    }
  });

  it('is taken off the end of a role the way any employer is', () => {
    expect(cleanRole('Software Engineering Intern | Thermagia Engineering', 'Thermagia Engineering')).toBe(
      'Software Engineering Intern',
    );
  });
});

describe('"Radiance Technologies | Technology Undergraduate Summer Internship | Wellington Management" — one board page, many jobs', () => {
  /*
   * LinkedIn's search results are one page: choosing a job changes
   * `currentJobId` and nothing else, so every job looked at was one trail, and
   * the role came from the first page and the employer from whichever page
   * first named one. Filed three times, under three employers.
   */
  const WELLINGTON = { url: LINKEDIN('4455904956'), title: 'Technology Undergraduate Summer Internship | Wellington Management | LinkedIn' };
  const RADIANCE = { url: LINKEDIN('4474796076'), title: 'Reverse Engineer Intern | Radiance Technologies | LinkedIn' };
  const UNNAMED = { url: LINKEDIN('4472949726'), title: 'Software Engineering Intern | Software Engineering | LinkedIn' };

  it('is the job on the page in front of you, not the first one looked at', async () => {
    const analyze = await analyzer();
    expect(await analyze([WELLINGTON, RADIANCE])).toMatchObject({ company: 'Radiance Technologies', role: 'Reverse Engineer Intern' });
  });

  it('never pairs one job’s role with another job’s employer', () => {
    expect(named([UNNAMED, RADIANCE])).toEqual({ company: 'Radiance Technologies', role: 'Reverse Engineer Intern' });
    expect(named([RADIANCE, UNNAMED]).company).toBe('Unknown company');
  });

  it('while the pages of one job, on two hosts, are still read together', () => {
    const posting = { url: 'https://www.linkedin.com/jobs/view/4474796076/', title: 'Reverse Engineer Intern | Radiance Technologies | LinkedIn' };
    const form = { url: 'https://radiance.example.com/apply?jobid=99881', title: 'Apply' };
    expect(named([posting, form])).toEqual({ company: 'Radiance Technologies', role: 'Reverse Engineer Intern' });
  });
});

describe('"Unknown company | Apply for Test Software Developer Intern" — Cornerstone, at macomtech.csod.com', () => {
  const URL = 'https://macomtech.csod.com/ux/ats/careersite/4/requisition/3723/application?c=macomtech&source=Linkedin&jobboardid=0#7';

  it('is MACOM, from its tenant, and the role without the step of applying', async () => {
    const analyze = await analyzer();
    expect(await analyze([{ url: URL, title: 'Apply for Test Software Developer Intern' }])).toMatchObject({
      company: 'MACOM',
      role: 'Test Software Developer Intern',
    });
  });

  it('reads any Cornerstone tenant as the employer', () => {
    expect(companyFromUrl('https://halewood.csod.com/ux/ats/careersite/1/home/requisition/88?c=halewood')).toBe('Halewood');
  });

  it('and keeps "Apply for this job" a page about itself', () => {
    const job = extractJob(page('Apply for this job — Novena Health'), 'https://jobs.novenahealth.com/apply', 'Apply for this job — Novena Health');
    expect(job.company).toBe('Novena Health');
    expect(job.title ?? '').not.toMatch(/this job/i);
  });
});

describe('"Ns2cloud | Career Opportunities: Apply for Image Processing Engineer Intern (41213)" — SuccessFactors for L3Harris', () => {
  it('is the role the posting calls it, and the system is nobody’s employer', () => {
    expect(
      named([{ url: 'https://career-hcm20.ns2cloud.com/portalcareer?_s.crb=9EfM3uK', title: 'Career Opportunities: Apply for Image Processing Engineer Intern (41213)' }]),
    ).toEqual({ company: 'Unknown company', role: 'Image Processing Engineer Intern' });
  });

  it('while the extension’s own "(job 4012345)" is left alone', () => {
    expect(cleanRole('Unknown role (job 4012345)')).toBe('Unknown role (job 4012345)');
  });
});

describe('"Messaging | Unknown role" — LinkedIn’s messaging overlay', () => {
  it('names no employer and no job', () => {
    for (const title of ['Messaging | LinkedIn', '(2) Messaging | LinkedIn', 'Messaging']) {
      const said = named([{ url: 'https://www.linkedin.com/preload/?_bprMode=vanilla', title }]);
      expect(said, title).toEqual({ company: 'Unknown company', role: 'Unknown role' });
      expect(looksLikeAnApplication(said.company, said.role), title).toBe(false);
    }
  });
});

describe('"Self Service | Unknown role" — ADP’s recruiting site', () => {
  const URL =
    'https://recruiting.adp.com/srccar/public/nghome.guid?ncsp=talcareers&r=5001218306906&cx=continue_application&_reqID=5001218306906&rb=LINKEDIN&c=1138141&d=TALSCareerSite';

  it('is not the employer, and neither is ADP', () => {
    expect(named([{ url: URL, title: 'Self Service' }]).company).toBe('Unknown company');
    expect(employerOrUnknown(URL)).toBe('Unknown company');
  });

  it('is a hiring system', () => {
    expect(classifyPage(page('Self Service'), URL).why).toContain('applicant tracking system');
  });

  it('nor are the other screens round an application', () => {
    for (const name of ['Self Service', 'Job Chat', 'Candidate Profile', 'Messaging', 'Notifications', 'Inbox', 'Dashboard']) {
      expect(looksLikeCompanyName(name), name).toBe(false);
      expect(looksLikeRoleTitle(name), name).toBe(false);
    }
  });
});

describe('"GitHub | Unknown role (job Automated-List-Of-…)" — a repository’s README', () => {
  const URL = 'https://github.com/zshah101/Automated-List-Of-Summer-2027-and-Fall-2026-Tech-Internships';
  const TITLE =
    'GitHub - zshah101/Automated-List-Of-Summer-2027-and-Fall-2026-Tech-Internships: A list of tech internships for Summer 2027 and Fall 2026';

  it('names no job number', () => {
    expect(jobNumberIn(URL)).toBeUndefined();
    expect(unnamedRole([URL])).toBe('Unknown role');
  });

  it('while a requisition number beside a year still is one', () => {
    expect(jobNumberIn('https://acme.wd5.myworkdayjobs.com/Careers/job/Austin-TX/Software-Engineer-Summer-2027_R171666')).toBe(
      'Software-Engineer-Summer-2027_R171666',
    );
    expect(jobNumberIn('https://boards.greenhouse.io/acme/jobs/4012345')).toBe('4012345');
    expect(jobNumberIn('https://www.linkedin.com/jobs/search-results/?currentJobId=4472949726')).toBe('4472949726');
  });

  it('is not an application at GitHub, and nothing worth a row', () => {
    const said = named([{ url: URL, title: TITLE }]);
    expect(said.company).toBe('Unknown company');
    expect(looksLikeAnApplication(said.company, said.role)).toBe(false);
  });
});

describe('"Embed | Job Application for Software Engineer, AI Platform" — Greenhouse’s embedded form', () => {
  const FRAME = 'https://job-boards.greenhouse.io/embed/job_app?for=nuro&token=7351061';

  it('is the board the embed is for', () => {
    expect(companyFromUrl(FRAME)).toBe('Nuro');
    expect(companyFromUrl('https://boards.greenhouse.io/embed/job_app?for=zipline&token=7992001003')).toBe('Zipline');
    expect(companyFromUrl('https://job-boards.greenhouse.io/embed/job_app?token=7351061')).toBeUndefined();
  });

  it('and the role is the job, not the step of applying for it', async () => {
    const analyze = await analyzer();
    expect(
      await analyze([
        { url: 'https://www.nuro.ai/careersitem?gh_jid=7351061', title: 'Careers | Nuro' },
        { url: FRAME, title: 'Job Application for Software Engineer, AI Platform at Nuro' },
      ]),
    ).toMatchObject({ company: 'Nuro', role: 'Software Engineer, AI Platform' });
    expect(named([{ url: FRAME, title: 'Job Application for Software Engineer, AI Platform at Nuro' }])).toEqual({
      company: 'Nuro',
      role: 'Software Engineer, AI Platform',
    });
  });
});

describe('iCIMS: "Careersus Shure", "Candidate Profile - …"', () => {
  it('reads the employer out of a tenant with a region in its careers words', () => {
    expect(
      named([
        {
          url: 'https://careersus-shure.icims.com/jobs/4956/application-software-engineering-intern/candidate?mode=apply&apply=yes&hashed=-1337711047&back=none',
          title: 'Candidate Profile - Application Software Engineering Intern',
        },
      ]),
    ).toEqual({ company: 'Shure', role: 'Application Software Engineering Intern' });
  });

  it('and takes the profile step off the front of the role', () => {
    expect(
      named([
        {
          url: 'https://careers-iridium.icims.com/jobs/5136/iridium-software-engineering-internship-%e2%80%93-summer-2027/candidate?mode=apply',
          title: 'Candidate Profile - Iridium Software Engineering Internship – Summer 2027',
        },
      ]),
    ).toEqual({ company: 'Iridium', role: 'Iridium Software Engineering Internship – Summer 2027' });
  });

  it('while the profile step alone is nobody', () => {
    const said = named([
      {
        url: 'https://careers-americas.icims.com/jobs/26266/software-engineer-intern%2c-2027-summer-u.s./candidate?csrf=28A21F12BC86E1E3',
        title: 'Candidate Profile',
      },
    ]);
    expect(said.company).toBe('Unknown company');
  });

  it('nor is its chat widget', () => {
    const url = 'https://careers-keysight.icims.com/jobs/54638/engineering-software-developer%2c-intern/questions?global=1';
    expect(named([{ url, title: 'Job Chat' }]).company).toBe('Keysight');
  });
});

describe('"Build your Career at Tesla" — a careers site’s invitation round its name', () => {
  it('is Tesla', () => {
    const title = 'Internship, Fullstack C++ Engineer, Vehicle User Interface (Winter/Spring 2027) | Tesla Careers';
    const html = page(title, '<meta property="og:site_name" content="Build your Career at Tesla">');
    expect(named([{ url: 'https://www.tesla.com/careers/search/job/apply/280604', title, html }])).toEqual({
      company: 'Tesla',
      role: 'Internship, Fullstack C++ Engineer, Vehicle User Interface (Winter/Spring 2027)',
    });
  });
});
