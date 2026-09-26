/**
 * Pages that list jobs, filed as if each were one.
 *
 * Rows in one person's tracker, each the title of a page that is about many
 * roles: a careers home, a board's search results, a job category, a
 * programme page. None is a posting or an application, and each was filed
 * because it read like one — the vocabulary is a posting's, and the title
 * stood where a role goes.
 *
 *   Epic        Careers
 *   Intel       Intel Careers           the name of Intel's Workday site
 *   Activision  intern job openings     a search
 *   Adobe       Intern and Graduate     careers.adobe.com/us/en/intern-and-graduate
 *   Indeed      Now Hiring: 300 Software Intern Jobs
 *
 * What a single posting has that none of these has is one job declared: a
 * JobPosting in its structured data, or a job's number in its address.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { classifyPage, extractJob, looksLikeAnApplication, looksLikeRoleTitle } from '../src/jobs/extract.js';
import { makeTempStore, type TempStore } from './helpers.js';

let t: TempStore | undefined;
afterEach(() => {
  t?.cleanup();
  t = undefined;
});

const PROSE = `<p>We are looking for curious people. Full-time and internship roles, great benefits and
compensation, responsibilities that grow with you. Qualifications vary by team.</p>`;

const links = (hrefs: string[]) => `<ul>${hrefs.map((h, i) => `<li><a href="${h}">Opening ${i + 1}</a></li>`).join('')}</ul>`;

const listing = (title: string, h1: string, body: string) =>
  `<html><head><title>${title}</title></head><body><h1>${h1}</h1>${PROSE}${body}</body></html>`;

describe('"Epic | Careers" — a careers home is a list, however its hero is headed', () => {
  // A careers home headed with the role it hires most for: read together, the
  // title and the heading made "Careers Software Developer", a post.
  const HOME = listing(
    'Careers',
    'Software Developer',
    links([
      'https://careers.epic.com/Jobs/Job?jobid=21300',
      'https://careers.epic.com/Jobs/Job?jobid=21301',
      'https://careers.epic.com/Jobs/Job?jobid=21302',
      'https://careers.epic.com/Jobs/Job?jobid=21303',
    ]),
  );

  it('is a listing, not a posting — while a posting on the same site, declaring itself, is still one', () => {
    const verdict = classifyPage(HOME, 'https://www.epic.com/careers/');
    expect(verdict.kind).toBe('listing');
    expect(verdict.why.join(' ')).toContain('lists roles');

    const posting = HOME.replace(
      '</head>',
      '<script type="application/ld+json">{"@context":"https://schema.org","@type":"JobPosting","title":"Software Developer","hiringOrganization":{"@type":"Organization","name":"Epic"}}</script></head>',
    );
    expect(classifyPage(posting, 'https://careers.epic.com/Jobs/Job?jobid=21300').kind).toBe('posting');
  });
});

describe('"Intel | Intel Careers" and "Intel | Software Engineering" — a Workday site, and a category of it', () => {
  const JOBS = links([
    '/External/job/US-California-Santa-Clara/Software-Engineering---Intern--Bachelor-s_JR0286834',
    '/External/job/US-Oregon-Hillsboro/Graphics-Software-Engineer-Intern_JR0286001',
    '/External/job/US-Arizona-Phoenix/Validation-Engineer-Intern_JR0285512',
  ]);

  it('does not take the name of the site, or a category of it, for a posting', () => {
    expect(looksLikeRoleTitle('Intel Careers')).toBe(false);
    expect(looksLikeAnApplication('Intel', 'Intel Careers')).toBe(false);
    const home = listing('Intel Careers', 'Intel Careers', `<p>1,234 JOBS FOUND</p>${JOBS}`);
    const job = extractJob(home, 'https://intel.wd1.myworkdayjobs.com/External', 'Intel Careers');
    expect(job.title).toBeUndefined();
    expect(job.company).toBe('Intel');
    expect(classifyPage(home, 'https://intel.wd1.myworkdayjobs.com/External').kind).not.toBe('posting');

    // A job category, counting and linking its jobs, is a list of them too.
    const category = listing('Software Engineering', 'Software Engineering', `<p>57 jobs</p>${JOBS}`);
    expect(classifyPage(category, 'https://intel.wd1.myworkdayjobs.com/External?jobFamilyGroup=software').kind).not.toBe('posting');

    // While the posting itself, with its number in its address, is a posting whose title is whole.
    const url = 'https://intel.wd1.myworkdayjobs.com/External/job/US-California-Santa-Clara/Software-Engineering---Intern--Bachelor-s_JR0286834';
    const title = "Software Engineering - Intern, Bachelor's";
    const posting = listing(title, title, JOBS);
    expect(classifyPage(posting, url).kind).toBe('posting');
    expect(extractJob(posting, url, title).title).toBe(title);
  });
});

describe('"Activision | intern job openings" — a search', () => {
  const RESULTS = listing(
    'intern job openings',
    'Search results',
    `<p>Showing 1 - 10 of 57 jobs</p>${links([
      '/job/R026123/Software-Engineer-Intern',
      '/job/R026130/Graphics-Engineer-Intern',
      '/job/R026131/Gameplay-Engineer-Intern',
    ])}`,
  );
  const URL = 'https://careers.activision.com/search-results?keywords=intern';

  it('is a list, and its title is not a role', () => {
    expect(looksLikeRoleTitle('intern job openings')).toBe(false);
    expect(looksLikeAnApplication('Activision', 'intern job openings')).toBe(false);
    expect(extractJob(RESULTS, URL, 'intern job openings').title).toBeUndefined();
    expect(classifyPage(RESULTS, URL).kind).not.toBe('posting');
  });
});

describe('"Adobe | Intern and Graduate" — who a programme is for is not a role', () => {
  const PAGE = listing(
    'Intern and Graduate',
    'Intern and Graduate',
    links([
      '/us/en/job/R171666/2027-Intern-Software-Engineer',
      '/us/en/job/R171670/2027-Intern-Machine-Learning-Engineer',
      '/us/en/job/R171702/2027-Intern-Product-Designer',
    ]),
  );
  const URL = 'https://careers.adobe.com/us/en/intern-and-graduate';

  it('is a list, and neither its title nor its address is taken for a role', () => {
    for (const title of ['Intern and Graduate', 'Internships', 'Early Careers', 'Students and Graduates']) {
      expect(looksLikeRoleTitle(title), title).toBe(false);
    }
    expect(extractJob(PAGE, URL, 'Intern and Graduate').title).toBeUndefined();
    expect(classifyPage(PAGE, URL).kind).not.toBe('posting');

    // While a real intake that names no role noun is still a role.
    expect(looksLikeAnApplication('Acme', 'Product Marketing, Early Career')).toBe(true);
    expect(looksLikeAnApplication('Adobe', '2027 Intern - Software Engineer')).toBe(true);
    expect(looksLikeAnApplication('Intern Co', 'Intern')).toBe(true);
    // A role that ends in the word is a role: this is a job.
    expect(looksLikeRoleTitle('Director of Careers')).toBe(true);
  });
});

describe('"Indeed | Now Hiring: 300 Software Intern Jobs" — a board’s search results', () => {
  const RESULTS = listing(
    'Now Hiring: 300 Software Intern Jobs',
    'software intern jobs',
    `<p>300 jobs</p>${links([
      '/rc/clk?jk=a1b2c3d4e5f60718&from=serp',
      '/rc/clk?jk=b2c3d4e5f6071829&from=serp',
      '/rc/clk?jk=c3d4e5f607182930&from=serp',
    ])}`,
  );

  it('is a list with no role and no employer of its own', () => {
    const url = 'https://www.indeed.com/jobs?q=software+intern';
    expect(classifyPage(RESULTS, url).kind).not.toBe('posting');
    const job = extractJob(RESULTS, url, 'Now Hiring: 300 Software Intern Jobs');
    expect(job.title).toBeUndefined();
    expect(looksLikeRoleTitle('Software Intern Jobs')).toBe(false);
  });
});

describe('a row the store is asked to file on its own, for a page that lists jobs', () => {
  it('is refused, so the tracker never takes one', async () => {
    const { default: express } = await import('express');
    const { default: request } = await import('supertest');
    const { createApi } = await import('../src/server/api.js');
    const { Repo } = await import('../src/git/repo.js');
    t = makeTempStore({ config: { git: { autoCommit: false }, output: { dir: 'out' } } });
    const app = express();
    app.use(express.json());
    app.use('/api', createApi({ store: t.store, repo: Repo.forStore(t.dir) }));

    for (const [company, role] of [
      ['Intel', 'Intel Careers'],
      ['Activision', 'intern job openings'],
      ['Adobe', 'Intern and Graduate'],
    ]) {
      const res = await request(app).post('/api/workspace').send({ auto: true, company, role }).expect(400);
      expect(res.body.kind, `${company} — ${role}`).toBe('not-a-job');
    }
    expect((await request(app).get('/api/applications').expect(200)).body.applications).toEqual([]);
  });
});

/*
 * And a single posting is not a list for what is on the page beside it.
 *
 * A posting on a careers site's own pages often declares nothing a machine
 * reads — its role's name in its address, no number, no JobPosting data — and
 * many such sites title every page "Careers". Two things on it read as a
 * list: its own requirements ("3+ years in similar roles" counts roles), and
 * the "Similar jobs" rail and "View all 24 open positions" it ends with. Each
 * made the posting a listing, and the extension files no application for one.
 */
describe('a single posting on a careers site’s own pages', () => {
  const URL = 'https://northwind.example/careers/senior-platform-engineer';
  const posting = (title: string, requirement: string, after = '') =>
    `<html><head><title>${title}</title></head><body>
<h1>Senior Platform Engineer</h1>
<h2>About the role</h2><p>You will own the platform that runs our services. Responsibilities include designing,
building and operating infrastructure, and mentoring engineers.</p>
<h2>Qualifications</h2><ul><li>${requirement}</li><li>Experience with Kubernetes and Terraform</li></ul>
<h2>Benefits</h2><p>Competitive salary and compensation, health, dental and vision coverage, 401k match.</p>
<a href="/careers/senior-platform-engineer/apply">Apply now</a>${after}</body></html>`;

  it('is not a list for the years its requirements ask for', () => {
    for (const requirement of ['3+ years in similar roles', '2 years in backend roles']) {
      for (const title of ['Careers', 'Northwind Careers']) {
        expect(classifyPage(posting(title, requirement), URL).kind, `${title}: ${requirement}`).toBe('posting');
      }
    }
  });

  it('nor for the similar jobs it links to at the end', () => {
    const rail = `<section><h3>Similar jobs</h3><ul>
<li><a href="/careers/staff-backend-engineer-payments">Staff Backend Engineer</a></li>
<li><a href="/careers/site-reliability-engineer-infrastructure">Site Reliability Engineer</a></li>
<li><a href="/careers/senior-data-platform-engineer">Senior Data Platform Engineer</a></li>
</ul></section><p><a href="/careers">View all 24 open positions</a></p>`;
    const verdict = classifyPage(posting('Senior Platform Engineer | Northwind', '5+ years building distributed systems', rail), URL);
    expect(verdict.kind, verdict.why.join('; ')).toBe('posting');

    // While a page that is a list, with the same links, still is one.
    const home = listing('Careers at Northwind', 'Open roles', `<p>24 open positions</p>${rail.replace(/<\/?section>|<h3>Similar jobs<\/h3>/g, '')}`);
    expect(classifyPage(home, 'https://northwind.example/careers').kind).not.toBe('posting');
  });
});
