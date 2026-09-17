import { describe, expect, it } from 'vitest';
import {
  classifyPage,
  companyFromUrl,
  employerFallback,
  looksLikeCompanyName,
  extractJob,
  extractKeywords,
  JOB_SHAPED,
  jobPostingScore,
  mergeJobPages,
} from '../src/jobs/extract.js';
import { matchVariants } from '../src/jobs/match.js';
import { DEFAULT_CONFIG, type Entry, type ResumeSpec, type StoreData } from '../src/model/types.js';

const JSON_LD_PAGE = `<html><head><title>SWE Intern at Streamly</title>
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"JobPosting","title":"Software Engineer Intern, Data Platform",
"hiringOrganization":{"@type":"Organization","name":"Streamly"},
"jobLocation":{"@type":"Place","address":{"addressLocality":"Boston","addressRegion":"MA"}},
"description":"<p>Work on Kafka streaming infrastructure in Go and Python. Responsibilities include Kubernetes on AWS.</p>"}
</script></head><body>Apply now</body></html>`;

describe('posting extraction', () => {
  it('prefers JSON-LD when a board provides it', () => {
    const job = extractJob(JSON_LD_PAGE, 'https://boards.greenhouse.io/streamly/jobs/1');
    expect(job.source).toBe('json-ld');
    expect(job.title).toBe('Software Engineer Intern, Data Platform');
    expect(job.company).toBe('Streamly');
    expect(job.location).toBe('Boston, MA');
  });

  it('strips markup out of the description', () => {
    const job = extractJob(JSON_LD_PAGE);
    expect(job.description).not.toContain('<p>');
    expect(job.description).toContain('Kafka streaming infrastructure');
  });

  it('falls back to the page when there is no JSON-LD', () => {
    const html = '<html><head><title>Backend Engineer at Acme</title></head><body><p>Responsibilities: build APIs in Python.</p></body></html>';
    const job = extractJob(html, 'https://acme.com/careers/1', 'Backend Engineer at Acme');
    expect(job.title).toBe('Backend Engineer');
    expect(job.company).toBe('Acme');
    expect(job.keywords).toContain('python');
  });

  it('ignores scripts and styles when reading the page as text', () => {
    const html = '<html><body><style>.a{color:red}</style><script>var x = "responsibilities"</script><p>Real text</p></body></html>';
    expect(extractJob(html).description).not.toContain('color:red');
    expect(extractJob(html).description).toContain('Real text');
  });
});

describe('company from url', () => {
  it.each([
    ['https://boards.greenhouse.io/streamly/jobs/1', 'Streamly'],
    ['https://jobs.lever.co/acme-corp/abc', 'Acme Corp'],
    ['https://jobs.ashbyhq.com/example/1', 'Example'],
  ])('reads %s', (url, expected) => {
    expect(companyFromUrl(url)).toBe(expected);
  });

  it('returns nothing for a url it does not recognise', () => {
    expect(companyFromUrl('https://example.com/careers')).toBeUndefined();
  });
});

describe('keywords', () => {
  it('matches on word boundaries so "go" does not fire on "going"', () => {
    expect(extractKeywords('We are going to the category')).not.toContain('go');
    expect(extractKeywords('Experience with Go and Python')).toContain('go');
  });

  it('finds multi-word terms', () => {
    expect(extractKeywords('experience with distributed systems')).toContain('distributed systems');
  });
});

describe('posting confidence', () => {
  it('scores a real posting well above an ordinary page', () => {
    const job = jobPostingScore(JSON_LD_PAGE, 'https://boards.greenhouse.io/streamly/jobs/1');
    const blog = jobPostingScore('<html><body><h1>Bread</h1><p>Sourdough notes.</p></body></html>', 'https://blog.example.com');
    expect(job).toBeGreaterThanOrEqual(4);
    expect(blog).toBeLessThan(4);
  });
});

/* ------------------------------------------------------------------ */

const entry: Entry = {
  id: 'exp',
  kind: 'experience',
  title: 'Example Co.',
  bullets: [
    {
      id: 'b_pipeline',
      default: 'v_base',
      variants: [
        { id: 'v_base', label: 'Neutral', text: 'Built an event pipeline', tags: ['backend'] },
        { id: 'v_kafka', label: 'Kafka', text: 'Built a Kafka pipeline', tags: ['kafka', 'streaming'] },
        { id: 'v_short', label: 'Short', text: 'Built a pipeline', tags: ['short'] },
      ],
    },
  ],
};

const eduEntry: Entry = {
  id: 'edu',
  kind: 'education',
  title: 'University',
  dates: {
    default: 'v_may',
    variants: [
      { id: 'v_may', label: 'May', text: 'May 2026', tags: ['newgrad'] },
      { id: 'v_dec', label: 'Dec', text: 'Dec 2026', tags: ['intern', 'streaming'] },
    ],
  },
};

const data: StoreData = {
  profile: { name: 'T' },
  entries: [entry, eduEntry],
  skillGroups: [
    {
      id: 'sk',
      name: 'Languages',
      items: [
        { id: 's_py', text: 'Python', tags: ['python'] },
        { id: 's_go', text: 'Go', tags: ['go'] },
        { id: 's_php', text: 'PHP', tags: ['php'] },
      ],
    },
  ],
  resumes: [],
  applications: [],
  coverLetters: [],
  drafts: [],
  samples: [],
  answers: [],
  voice: '',
  config: DEFAULT_CONFIG,
};

const base: ResumeSpec = { id: 'base', label: 'Base' };

describe('variant matching', () => {
  it('swaps to the variant the posting actually calls for', () => {
    const result = matchVariants(data, base, { keywords: ['kafka', 'streaming'] });
    expect(result.choices.b_pipeline).toBe('v_kafka');
  });

  it('leaves everything alone when the posting gives no signal', () => {
    const result = matchVariants(data, base, { keywords: ['php'] });
    expect(result.choices.b_pipeline).toBeUndefined();
  });

  it('explains every change it makes', () => {
    const result = matchVariants(data, base, { keywords: ['kafka', 'streaming'] });
    expect(result.rationale[0]).toMatchObject({ key: 'b_pipeline', to: 'v_kafka' });
    expect(result.rationale[0]?.because).toContain('kafka');
  });

  it('never picks a graduation date from a job posting', () => {
    // "Dec 2026" is tagged `streaming` here on purpose: a posting's vocabulary
    // must not be able to change a fact about the applicant.
    const result = matchVariants(data, base, { keywords: ['streaming'] });
    expect(result.choices['edu.dates']).toBeUndefined();
  });

  it('never auto-selects a variant reserved for fitting', () => {
    const result = matchVariants(data, base, { keywords: ['short', 'kafka', 'streaming'] });
    expect(result.choices.b_pipeline).not.toBe('v_short');
  });

  it('narrows a skills group to what the posting mentions', () => {
    const result = matchVariants(data, base, { keywords: ['python', 'go'] });
    expect(result.skills.sk).toEqual(['s_py', 's_go']);
  });

  it('leaves a skills group alone rather than narrowing it to one item', () => {
    const result = matchVariants(data, base, { keywords: ['python'] });
    expect(result.skills.sk).toBeUndefined();
  });

  it('respects a higher threshold by making fewer changes', () => {
    const loose = matchVariants(data, base, { keywords: ['kafka'] });
    const strict = matchVariants(data, base, { keywords: ['kafka'], threshold: 99 });
    expect(Object.keys(strict.choices).length).toBeLessThanOrEqual(Object.keys(loose.choices).length);
  });
});

/* ------------------------------------------------------------------ *
 * What kind of page is this                                           *
 * ------------------------------------------------------------------ */

const APPLICATION_FORM = `<html><head><title>Apply — Streamly</title></head><body>
<h1>Submit application</h1>
<form>
  <label>First name<input name="first"></label>
  <label>Last name<input name="last"></label>
  <label>Phone number<input name="phone"></label>
  <label>Resume<input type="file" name="resume"></label>
  <label>Cover letter<textarea name="cover"></textarea></label>
  <label>Why do you want to work here?<textarea></textarea></label>
  <label>Will you now or in the future require sponsorship?<select></select></label>
</form></body></html>`;

const LISTING = `<html><head><title>Careers at Streamly</title></head><body>
<h1>Open positions</h1><p>12 results found. Filter by team, sort by date.</p>
<ul><li><a href="/jobs/1">Backend Engineer</a></li><li><a href="/jobs/2">Designer</a></li></ul>
</body></html>`;

const FORUM = `<html><head><title>Ask HN: Who is hiring? (September 2026)</title></head><body>
<p>Streamly | Boston | Full-time | We are hiring a backend engineer. Kafka, Go.</p>
</body></html>`;

const SHOP = `<html><head><title>Sourdough starter</title></head><body>
<h1>Sourdough starter</h1><p>Add to cart. Checkout. See our privacy policy and terms of service.</p>
</body></html>`;

describe('what kind of page this is', () => {
  it('knows a posting from its structured data', () => {
    const v = classifyPage(JSON_LD_PAGE, 'https://boards.greenhouse.io/streamly/jobs/1');
    expect(v.kind).toBe('posting');
    expect(v.why.join(' ')).toContain('structured JobPosting');
  });

  it('knows an application form, which describes almost nothing', () => {
    const v = classifyPage(APPLICATION_FORM, 'https://jobs.lever.co/streamly/abc/apply');
    expect(v.kind).toBe('application');
    expect(v.score).toBeGreaterThanOrEqual(JOB_SHAPED);
  });

  it('knows a page listing roles from a page describing one', () => {
    expect(classifyPage(LISTING, 'https://streamly.com/careers').kind).toBe('listing');
  });

  it('knows a hiring thread on a forum', () => {
    expect(classifyPage(FORUM, 'https://news.ycombinator.com/item?id=1').kind).toBe('discussion');
  });

  it('stays quiet on an ordinary page', () => {
    const v = classifyPage(SHOP, 'https://shop.example.com/starter');
    expect(v.kind).toBe('none');
    expect(v.score).toBeLessThan(JOB_SHAPED);
  });

  it('stays quiet on a blog post that merely mentions work', () => {
    const blog = '<html><body><h1>Bread</h1><p>Sourdough notes from my kitchen.</p></body></html>';
    expect(classifyPage(blog, 'https://blog.example.com/bread').kind).toBe('none');
  });

  it('offers on a bare careers URL with little text, rather than missing it', () => {
    // The page a careers site renders before its JavaScript arrives.
    const thin = '<html><head><title>Backend Engineer</title></head><body><p>Apply now</p></body></html>';
    const v = classifyPage(thin, 'https://jobs.ashbyhq.com/streamly/apply');
    expect(v.kind).not.toBe('none');
  });

  it('says what it decided on, so a wrong call can be understood', () => {
    expect(classifyPage(APPLICATION_FORM, 'https://jobs.lever.co/x/apply').why.join(' ')).toMatch(/resume file|form/);
  });
});

describe('one application across several pages', () => {
  const DESCRIPTION = JSON_LD_PAGE;

  it('reads a single page exactly as it always did', () => {
    const merged = mergeJobPages([{ url: 'https://boards.greenhouse.io/streamly/jobs/1', html: DESCRIPTION }]);
    const alone = extractJob(DESCRIPTION, 'https://boards.greenhouse.io/streamly/jobs/1');
    expect(merged.description).toBe(alone.description);
    expect(merged.pages).toHaveLength(1);
  });

  it('carries the description forward to the form, where the questions are', () => {
    const merged = mergeJobPages([
      { url: 'https://boards.greenhouse.io/streamly/jobs/1', title: 'Data Platform Intern', html: DESCRIPTION },
      { url: 'https://jobs.lever.co/streamly/abc/apply', title: 'Apply — Streamly', html: APPLICATION_FORM },
    ]);

    // The thing the form page could never have said on its own.
    expect(merged.description).toContain('Kafka');
    // And the thing only the form knows.
    expect(merged.description).toContain('Why do you want to work here?');
    expect(merged.pages.map((p) => p.kind)).toEqual(['posting', 'application']);
  });

  it('takes the role and company from whichever page knew them', () => {
    const merged = mergeJobPages([
      { url: 'https://jobs.lever.co/streamly/abc/apply', html: APPLICATION_FORM },
      { url: 'https://boards.greenhouse.io/streamly/jobs/1', html: DESCRIPTION },
    ]);
    expect(merged.company).toBe('Streamly');
    expect(merged.title).toBeTruthy();
  });

  it('keeps the keywords of everything read, not just the last page', () => {
    const merged = mergeJobPages([
      { url: 'https://boards.greenhouse.io/streamly/jobs/1', html: DESCRIPTION },
      { url: 'https://jobs.lever.co/streamly/abc/apply', html: APPLICATION_FORM },
    ]);
    expect(merged.keywords).toContain('kafka');
  });

  it('labels each page, so the trail can be shown and pruned', () => {
    const merged = mergeJobPages([
      { url: 'https://boards.greenhouse.io/streamly/jobs/1', title: 'The role', html: DESCRIPTION },
      { url: 'https://jobs.lever.co/streamly/abc/apply', title: 'Apply', html: APPLICATION_FORM },
    ]);
    expect(merged.pages[0]).toMatchObject({ title: 'The role', kind: 'posting' });
    expect(merged.pages[1]?.chars).toBeGreaterThan(0);
  });

  it('is unbothered by an empty trail, or one full of blanks', () => {
    expect(mergeJobPages([]).description).toBe('');
    expect(mergeJobPages([{ html: '   ' }]).pages).toEqual([]);
  });
});

/*
 * What an employer is called when the page never says.
 *
 * "Unknown" was the answer, and it went into resume labels, cover letter
 * titles and the Workspace list — so every bare application form produced
 * "Apply — Unknown", and two of them were indistinguishable in the picker.
 */
describe('naming an employer the page does not name', () => {
  it('falls back to the host, which is at least true', () => {
    expect(employerFallback('https://boards.example.com/gh/acme/jobs/1')).toBe('boards.example.com');
  });

  it('drops a leading www, which is noise', () => {
    expect(employerFallback('https://www.example.com/apply')).toBe('example.com');
  });

  it('still says Unknown when there is not even a url', () => {
    expect(employerFallback(undefined)).toBe('Unknown');
    expect(employerFallback('not a url at all')).toBe('Unknown');
  });
});

describe('telling a company name from a job title', () => {
  it('accepts names that are names', () => {
    for (const name of [
      'Helios Robotics',
      'Acme Co.',
      'Stripe',
      'Two Sigma',
      'Palantir Technologies',
      'Designer Brands Inc.',
      'Lead Bank',
      'Acme Software',
      'Northeastern University',
      "Moody's",
      'Épicerie Générale',
    ]) {
      expect(looksLikeCompanyName(name), name).toBe(true);
    }
  });

  it('refuses a job title standing in for an employer', () => {
    // The one that reached a letter: "I want to bring that focus to Software
    // Engineering".
    for (const name of [
      'Software Engineering',
      'Senior Backend Developer',
      'Engineering',
      'Product Manager',
      'Data Scientist',
      'Summer Internship',
    ]) {
      expect(looksLikeCompanyName(name), name).toBe(false);
    }
  });

  it('refuses the page furniture every scraper picks up', () => {
    for (const name of ['Unknown', 'Careers', 'Jobs', 'n/a', 'Apply', 'We are hiring', 'Open Positions', '']) {
      expect(looksLikeCompanyName(name), name).toBe(false);
    }
    expect(looksLikeCompanyName(undefined)).toBe(false);
  });

  it('refuses a hostname, which employerFallback hands back on purpose', () => {
    // A true label for a folder, and not a thing you address a letter to.
    expect(looksLikeCompanyName(employerFallback('https://boards.example.com/gh/acme/jobs/1'))).toBe(false);
    expect(looksLikeCompanyName('acme.com')).toBe(false);
  });

  it('refuses a sentence, a list, or a paragraph of marketing', () => {
    expect(looksLikeCompanyName('Acme is hiring! Apply today.')).toBe(false);
    expect(looksLikeCompanyName('Acme | Careers | Open Roles')).toBe(false);
    expect(looksLikeCompanyName('A'.repeat(80))).toBe(false);
    expect(looksLikeCompanyName('2026')).toBe(false);
  });
});
