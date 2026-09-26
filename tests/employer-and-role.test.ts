/**
 * Who a job is with and what it is called, read off the pages of one person's
 * real applications.
 *
 * Every `describe` below is a row that was in their tracker, as "company |
 * role", and every page is built from the real title and host of the posting
 * behind it (the descriptions are made up). Two mistakes made most of them:
 *
 *   - Something that is not an employer was taken for one: a season, a
 *     country, a field of work, a job board, a portal, a hostname.
 *   - The title was cut at every " - ", so a real title lost its second half
 *     and the half it lost was filed as the employer.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { companyFromUrl, extractJob, looksLikeCompanyName } from '../src/jobs/extract.js';
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

/** A posting page: its title, anything else in its head, and a body that names no role in a heading. */
const page = (title: string, head = '') =>
  `<html><head><title>${title}</title>${head}</head><body>${BODY}</body></html>`;
const og = (property: string, content: string) => `<meta property="${property}" content="${content}">`;

/** What `/extension/analyze` files a page under: the names the copy, the workspace and the tracker all use. */
async function analyzer() {
  const { default: express } = await import('express');
  const { default: request } = await import('supertest');
  const { createApi } = await import('../src/server/api.js');
  const { Repo } = await import('../src/git/repo.js');
  t = makeTempStore({ config: { git: { autoCommit: false }, output: { dir: 'out' } } });
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use('/api', createApi({ store: t.store, repo: Repo.forStore(t.dir) }));
  return async (url: string, title: string, html = page(title)) => {
    const res = await request(app)
      .post('/api/extension/analyze')
      .send({ url, title, html, baseResumeId: 'base', tailor: 'none' })
      .expect(200);
    return res.body.spec.generatedFor as { company: string; role: string };
  };
}

describe('"Summer 2027 | CPE SW E2E Triage Intern" — a season is an intake, not an employer', () => {
  const TITLE = 'CPE SW E2E Triage Intern - Summer 2027';
  const WORKDAY = 'https://motorolasolutions.wd5.myworkdayjobs.com/Careers/job/Schaumburg-IL/CPE-SW-E2E-Triage-Intern---Summer-2027_R51234';

  it('is Motorola Solutions, from its Workday tenant, and the title is kept whole', () => {
    const job = extractJob(page(TITLE), WORKDAY, TITLE);
    expect(job.company).toBe('Motorola Solutions');
    expect(job.title).toBe(TITLE);
  });

  it('and where nothing else names the employer, the season still is not it', () => {
    const job = extractJob(page(TITLE), 'http://127.0.0.1:9/postings/51234', TITLE);
    expect(job.company).toBeUndefined();
    expect(job.title).toBe(TITLE);
  });
});

describe('"Summer 2027 | Software Engineering Intern" and "Summer 2027 | Software Engineer Intern"', () => {
  it('never takes the season a title ends or starts with for the employer', () => {
    for (const title of [
      'Software Engineering Intern - Summer 2027',
      'Software Engineer Intern - Summer 2027',
      'Summer 2027 - Software Engineer Intern',
      'Software Engineer Intern | Summer 2027',
      'Software Engineer Intern | 2027 Summer',
    ]) {
      const job = extractJob(page(title), 'http://127.0.0.1:9/postings/40123', title);
      expect(job.company, title).toBeUndefined();
    }
  });

  it('refuses a season or a year as a name wherever it is read', () => {
    for (const name of ['Summer 2027', '2027 Summer', 'Winter 2027', 'Fall 2026', 'Spring', 'Fall 2026-Summer 2027']) {
      expect(looksLikeCompanyName(name), name).toBe(false);
    }
  });
});

describe('"2027 Summer | Software Engineer Intern (AI Infra Compute) - 2027 Summer"', () => {
  const TITLE = 'Software Engineer Intern (AI Infra Compute) - 2027 Summer';
  const URL = 'https://jobs.bytedance.com/en/position/7412345678901234567/detail';

  it('is ByteDance, and the intake stays part of the title rather than becoming the employer', async () => {
    const html = page(TITLE, og('og:title', TITLE));
    const job = extractJob(html, URL, TITLE);
    expect(job.company).toBeUndefined();
    expect(job.title).toBe(TITLE);
    const analyze = await analyzer();
    expect(await analyze(URL, TITLE, html)).toEqual({ company: 'ByteDance', role: TITLE, at: expect.any(String), url: URL });
  });
});

describe('"US | Software Engineer I, Entry-Level (Graduation Date: Fall 2026-Summer 2027)"', () => {
  const TITLE = 'Software Engineer I, Entry-Level (Graduation Date: Fall 2026-Summer 2027) - US';
  const URL = 'https://careersatdoordash.com/jobs/software-engineer-i-entry-level-graduation-date-fall-2026-summer-2027/6123456/';

  it('is DoorDash, the site the posting is on, and not the country its title ends with', async () => {
    const job = extractJob(page(TITLE), URL, TITLE);
    expect(job.company).toBeUndefined();
    expect(job.title).toBe(TITLE);
    const analyze = await analyzer();
    expect(await analyze(URL, TITLE)).toMatchObject({ company: 'DoorDash', role: TITLE });
  });

  it('refuses a country, a region, or a region’s careers portal as a name', () => {
    for (const name of ['US', 'USA', 'U.S.', 'United States', 'Americas', 'Careers Americas', 'EMEA', 'APAC', 'US Careers']) {
      expect(looksLikeCompanyName(name), name).toBe(false);
    }
    // While an employer with a place in its name is still one.
    for (const name of ['US Foods', 'Bank of America', 'American Express', 'Canada Goose']) {
      expect(looksLikeCompanyName(name), name).toBe(true);
    }
  });
});

describe('"Careers Americas | Software Engineer Intern, Summer U S"', () => {
  // Atlassian's iCIMS portal for the Americas; the posting's real title is
  // "Software Engineer Intern, 2027 Summer U.S.".
  const URL = 'https://careers-americas.icims.com/jobs/12345/software-engineer-intern%2c-2027-summer-u.s./job';

  it('names nobody when the portal is all the address says, and reads the title out of it whole', async () => {
    expect(companyFromUrl(URL)).toBeUndefined();
    const job = extractJob(page(''), URL, '');
    expect(job.company).toBeUndefined();
    expect(job.title).toBe('Software Engineer Intern, 2027 Summer U.S.');
    const analyze = await analyzer();
    expect(await analyze(URL, '', page(''))).toMatchObject({
      company: 'Unknown company',
      role: 'Software Engineer Intern, 2027 Summer U.S.',
    });
  });

  it('still reads the employer out of a portal that is named for it', () => {
    expect(companyFromUrl('https://careers-markon.icims.com/jobs/4021/login')).toBe('Markon');
  });
});

describe('"Robotics | Software Development Engineer"', () => {
  const TITLE = 'Robotics - Software Development Engineer - Job ID: 10452115 | Amazon.jobs';
  const URL = 'https://www.amazon.jobs/en/jobs/10452115/robotics-software-development-engineer';

  it('is Amazon; "Robotics" is the start of the title, and the site and the job number come off', async () => {
    const job = extractJob(page(TITLE), URL, TITLE);
    expect(job.company).not.toBe('Robotics');
    expect(job.title).toBe('Robotics - Software Development Engineer');
    expect(extractJob(page(TITLE, og('og:site_name', 'Amazon.jobs')), URL, TITLE).company).toBe('Amazon');
    const analyze = await analyzer();
    expect(await analyze(URL, TITLE)).toMatchObject({ company: 'Amazon', role: 'Robotics - Software Development Engineer' });
  });

  it('refuses a field of work, or a word about the page, as a name on its own', () => {
    for (const name of ['Robotics', 'Engineering', 'Careers', 'Jobs', 'Software', 'Research']) {
      expect(looksLikeCompanyName(name), name).toBe(false);
    }
    for (const name of ['Acme Robotics', 'Epic Games', 'Boston Dynamics']) {
      expect(looksLikeCompanyName(name), name).toBe(true);
    }
  });
});

describe('"LinkedIn | Neural Graphics Engineer" and "LinkedIn | Gameplay Programmer Intern"', () => {
  const SITE = og('og:site_name', 'LinkedIn');

  it('takes the employer from the part of the title that names who is hiring', () => {
    const signedIn = 'Neural Graphics Engineer | Arm | LinkedIn';
    expect(extractJob(page(signedIn, SITE), 'https://www.linkedin.com/jobs/view/3912345678/', signedIn)).toMatchObject({
      company: 'Arm',
      title: 'Neural Graphics Engineer',
    });
    const guest = 'Arm hiring Neural Graphics Engineer in Cambridge, England, United Kingdom | LinkedIn';
    expect(
      extractJob(page(guest, SITE), 'https://www.linkedin.com/jobs/view/neural-graphics-engineer-at-arm-3912345678', guest),
    ).toMatchObject({ company: 'Arm', title: 'Neural Graphics Engineer' });
  });

  it('and says it does not know, rather than naming the board, when the title names nobody', async () => {
    const title = '(3) Gameplay Programmer Intern | LinkedIn';
    const url = 'https://www.linkedin.com/jobs/collections/recommended/?currentJobId=3998877665';
    const job = extractJob(page(title, SITE), url, title);
    expect(job.company).toBeUndefined();
    expect(job.title).toBe('Gameplay Programmer Intern');
    const analyze = await analyzer();
    expect(await analyze(url, title, page(title, SITE))).toMatchObject({
      company: 'Unknown company',
      role: 'Gameplay Programmer Intern',
    });
    // Nor its address, where the page gives no name for the site at all.
    expect(await analyze(url, 'Gameplay Programmer Intern', page('Gameplay Programmer Intern'))).toMatchObject({
      company: 'Unknown company',
    });
  });
});

describe('"TalentAlly | Software Engineer" and "Indeed | Now Hiring: 300 Software Intern Jobs"', () => {
  it('never files a board that reposts other employers’ jobs as the employer', async () => {
    const title = 'Software Engineer | TalentAlly';
    const url = 'https://talentally.com/job/software-engineer-4412345';
    const html = page(title, og('og:site_name', 'TalentAlly'));
    expect(extractJob(html, url, title)).toMatchObject({ company: undefined, title: 'Software Engineer' });
    const analyze = await analyzer();
    expect(await analyze(url, title, html)).toMatchObject({ company: 'Unknown company', role: 'Software Engineer' });
  });

  it('nor Indeed for its own search results', () => {
    const title = 'Now Hiring: 300 Software Intern Jobs';
    const job = extractJob(page(title, og('og:site_name', 'Indeed')), 'https://www.indeed.com/q-software-intern-jobs.html', title);
    expect(job.company).toBeUndefined();
    expect(job.title).toBeUndefined();
  });
});

describe('"Amazon.jobs | Software Dev Engineer I, Graviton Software, Annapurna Labs"', () => {
  it('is Amazon, whose site that is, and the title loses the site and its number', async () => {
    const title = 'Software Dev Engineer I, Graviton Software, Annapurna Labs - Job ID: 2912345 | Amazon.jobs';
    const url = 'https://www.amazon.jobs/en/jobs/2912345/software-dev-engineer-i-graviton-software-annapurna-labs';
    const analyze = await analyzer();
    expect(await analyze(url, title)).toMatchObject({
      company: 'Amazon',
      role: 'Software Dev Engineer I, Graviton Software, Annapurna Labs',
    });
  });
});

describe('"redhat.wd5.myworkdayjobs.com | Software Engineer Intern" — a Workday tenant, named the employer’s way', () => {
  /*
   * A Workday page's title never names the employer; its tenant does. A short
   * list of checked names spells the ones that run words together, and every
   * other tenant is title-cased.
   */
  it('reads the tenants it knows the way their employers write them, and title-cases the rest', () => {
    const tenant = (name: string) => `https://${name}.wd5.myworkdayjobs.com/External/job/X/Software-Engineer-Intern_R045123`;
    // From the list of checked names.
    expect(companyFromUrl(tenant('motorolasolutions'))).toBe('Motorola Solutions');
    expect(companyFromUrl(tenant('redhat'))).toBe('Red Hat');
    expect(companyFromUrl(tenant('nvidia'))).toBe('NVIDIA');
    expect(companyFromUrl(tenant('intel'))).toBe('Intel');
    // Title-cased: right for every one-word employer.
    expect(companyFromUrl(tenant('salesforce'))).toBe('Salesforce');
    expect(companyFromUrl(tenant('adobe'))).toBe('Adobe');
  });

  it('files the application under Red Hat, not under the address it was on', async () => {
    const url = 'https://redhat.wd5.myworkdayjobs.com/jobs/job/Raleigh/Software-Engineer-Intern_R045123/apply';
    const analyze = await analyzer();
    expect(await analyze(url, 'Software Engineer Intern')).toMatchObject({ company: 'Red Hat', role: 'Software Engineer Intern' });
  });
});

describe('"careers.activision.com | Unknown role" — an address is never the employer', () => {
  it('names the employer an address belongs to, and otherwise says it does not know', async () => {
    const analyze = await analyzer();
    // Phenom's apply step on Activision's own careers host, naming nobody.
    const apply = 'https://careers.activision.com/apply?jobSeqNo=ACPUUSR027559EXTERNAL&step=1';
    expect((await analyze(apply, 'Apply', page('Apply'))).company).toBe('Activision');
    // A board's own address names nobody at all.
    expect((await analyze('https://www.indeed.com/viewjob?jk=a1b2c3d4e5f60718', 'Software Engineer Intern')).company).toBe(
      'Unknown company',
    );
  });
});

describe('"Electronic Arts | Gameplay Engineer Intern - Careers"', () => {
  it('takes the site’s word off the role, and reads jobs.ea.com as Electronic Arts', async () => {
    const title = 'Gameplay Engineer Intern - Careers';
    const url = 'https://jobs.ea.com/en_US/careers/JobDetail/Gameplay-Engineer-Intern/216245';
    const html = page(title, og('og:title', title));
    expect(extractJob(html, url, title).title).toBe('Gameplay Engineer Intern');
    const analyze = await analyzer();
    expect(await analyze(url, title, html)).toMatchObject({ company: 'Electronic Arts', role: 'Gameplay Engineer Intern' });
  });
});

describe('"Keysight Technologies, Inc. | Engineering Software Developer, Intern in Multiple Locations | Keysight Technologies, Inc."', () => {
  const URL = 'https://jobs.keysight.com/external/jobs/48123/engineering-software-developer-intern';
  const read = (title: string) => extractJob(page(title, og('og:title', title)), URL, title);

  it('takes " in {location} | {company}" off the end of the role, and nothing else', () => {
    const title = 'Engineering Software Developer, Intern in Multiple Locations | Keysight Technologies, Inc.';
    expect(read(title)).toMatchObject({ company: 'Keysight Technologies, Inc.', title: 'Engineering Software Developer, Intern' });
    expect(read('Engineering Software Developer, Intern in Santa Rosa, California | Keysight Technologies, Inc.').title).toBe(
      'Engineering Software Developer, Intern',
    );
    // A field is not a place, and stays.
    expect(read('Research Scientist in Machine Learning | Keysight Technologies, Inc.').title).toBe(
      'Research Scientist in Machine Learning',
    );
    // Nor is one that starts with a word a place can be: remote sensing is a field.
    expect(read('Research Scientist in Remote Sensing | Keysight Technologies, Inc.').title).toBe('Research Scientist in Remote Sensing');
    expect(read('Postdoctoral Researcher in Hybrid Quantum Systems | Keysight Technologies, Inc.').title).toBe(
      'Postdoctoral Researcher in Hybrid Quantum Systems',
    );
    // While working remotely, said as a place, still comes off.
    for (const where of ['Remote', 'Remote, US', 'Remote (US)', 'Hybrid - Santa Rosa, CA']) {
      expect(read(`Engineering Software Developer, Intern in ${where} | Keysight Technologies, Inc.`).title, where).toBe(
        'Engineering Software Developer, Intern',
      );
    }
  });
});

describe('"Qualcomm | #Software Engineer"', () => {
  it('drops a heading marker left in front of the role', async () => {
    const url = 'https://careers.qualcomm.com/careers/job/446700123456';
    const html = page('#Software Engineer', og('og:title', '#Software Engineer'));
    expect(extractJob(html, url, '#Software Engineer').title).toBe('Software Engineer');
    const analyze = await analyzer();
    expect(await analyze(url, '#Software Engineer', html)).toMatchObject({ company: 'Qualcomm', role: 'Software Engineer' });
  });
});

describe('"Activision | Activision 2027 Summer Internships - Graphics Engineering"', () => {
  it('keeps the title Activision wrote, company name and all', async () => {
    const title = 'Activision 2027 Summer Internships - Graphics Engineering';
    const url = 'https://careers.activision.com/job/R026123/Activision-2027-Summer-Internships-Graphics-Engineering';
    expect(extractJob(page(title), url, title).title).toBe(title);
    const analyze = await analyzer();
    expect(await analyze(url, title)).toMatchObject({ company: 'Activision', role: title });
  });
});

describe('a title is not cut at a " - " for being there', () => {
  /*
   * The real titles, on their real hosts, that the old cutter shortened:
   * Salesforce's came back "Summer 2027 Intern", Intel's (JR0286834)
   * "Software Engineering" and Adobe's (R171666) "2027 Intern".
   */
  it('keeps each of these whole', () => {
    const cases: [string, string, string][] = [
      [
        'Summer 2027 Intern - Software Engineer',
        'https://salesforce.wd12.myworkdayjobs.com/External_Career_Site/job/California---San-Francisco/Summer-2027-Intern---Software-Engineer_JR301234',
        'Salesforce',
      ],
      [
        "Software Engineering - Intern, Bachelor's",
        'https://intel.wd1.myworkdayjobs.com/External/job/US-California-Santa-Clara/Software-Engineering---Intern--Bachelor-s_JR0286834',
        'Intel',
      ],
      ['2027 Intern - Software Engineer', 'https://adobe.wd5.myworkdayjobs.com/external_experienced/job/San-Jose/2027-Intern---Software-Engineer_R171666', 'Adobe'],
    ];
    for (const [title, url, company] of cases) {
      expect(extractJob(page(title), url, title), title).toMatchObject({ title, company });
    }
  });

  it('and keeps what is part of a title: where, when, which team', () => {
    for (const title of ['Software Engineer (Remote)', 'Software Engineer Intern (Winter 2027)', 'Software Engineer - Early Careers']) {
      expect(extractJob(page(title), 'http://127.0.0.1:9/postings/40123', title).title, title).toBe(title);
    }
  });

  /*
   * A team named for the employer is still a team. The posting's own title,
   * in its structured data, came back "iOS Engineer" for both of these, and
   * the two jobs were one tracker row.
   */
  it('and a team named for the employer, after a spaced hyphen', () => {
    const url = 'https://jobs.apple.com/en-us/details/200512345/ios-engineer';
    for (const title of ['iOS Engineer - Apple Music', 'iOS Engineer - Apple Pay']) {
      const ld = `<script type="application/ld+json">${JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'JobPosting',
        title,
        hiringOrganization: { '@type': 'Organization', name: 'Apple' },
      })}</script>`;
      expect(extractJob(page(title, ld), url, title), title).toMatchObject({ title, company: 'Apple' });
    }
  });
});
