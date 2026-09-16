import { describe, expect, it } from 'vitest';
import { companyFromUrl, extractJob, extractKeywords, jobPostingScore } from '../src/jobs/extract.js';
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
