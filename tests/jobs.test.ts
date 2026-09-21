import { describe, expect, it } from 'vitest';
import {
  classifyPage,
  companyFromUrl,
  employerFallback,
  looksLikeAnApplication,
  looksLikeCompanyName,
  looksLikeRoleTitle,
  extractJob,
  extractKeywords,
  JOB_SHAPED,
  jobPostingScore,
  mergeJobPages,
  roleFromUrl,
} from '../src/jobs/extract.js';
import { detectLevel } from '../src/jobs/level.js';
import { deriveSpec, matchVariants } from '../src/jobs/match.js';
import { resolveResume } from '../src/model/resolve.js';
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

/*
 * The page where you actually apply, which is not shaped like the posting.
 *
 * The enterprise systems — Oracle Recruiting, Cornerstone, UKG, Dayforce —
 * title that step "Apply" or "Job Details" and put the employer after the
 * dash. Reading the first segment regardless filed applications under the
 * role "Apply", which is not a job and cannot be looked up later, with no
 * company at all.
 */
describe('a page that calls itself Apply', () => {
  const applyPage = (title: string, heading = 'Novena Health', role = 'Platform Engineer') =>
    extractJob(
      `<html><head><title>${title}</title></head><body><h1>${heading}</h1><h2>${role}</h2>
       <p>Submit application. Upload your resume. Equal opportunity employer.</p></body></html>`,
      'https://novena.example/hcmUI/CandidateExperience/en/sites/CX_1/job/18842/apply',
      title,
    );

  it('does not take the word Apply as the job', () => {
    const job = applyPage('Apply — Novena Health');
    expect(job.title).not.toMatch(/^apply$/i);
    expect(job.title).toBe('Platform Engineer');
  });

  it('reads the employer out of the other half of the title', () => {
    expect(applyPage('Apply — Novena Health').company).toBe('Novena Health');
    expect(applyPage('Job Details | Halewood Group').company).toBe('Halewood Group');
  });

  it('still prefers a real role in the title to one in a heading', () => {
    const job = applyPage('Staff Platform Engineer — Novena Health');
    expect(job.title).toBe('Staff Platform Engineer');
  });

  /*
   * The company is held to the same standard as everywhere else: the other
   * half of a title is often another role, a tagline or a hostname, and any
   * of those filed as the employer is worse than none.
   */
  it('refuses a second role, or a sentence, where the company goes', () => {
    expect(applyPage('Apply — Platform Engineer').company).toBeUndefined();
    expect(applyPage('Apply — We are hiring!').company).toBeUndefined();
  });

  it('falls back to a heading only when it names a role', () => {
    // The first heading here is the employer, which must not become the job.
    const job = applyPage('Apply', 'Novena Health', 'Platform Engineer');
    expect(job.title).toBe('Platform Engineer');
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

/*
 * Who the application is with, when the page never said.
 *
 * It used to be the bare hostname, so a job was filed under
 * "careers.acme-corp.com" — where it came from rather than who it is with,
 * which reads as a mistake in a tracker, in a folder name and in a letter.
 */
describe('naming the employer from the address alone', () => {
  it('reads a company careers site as the company', () => {
    expect(employerFallback('https://careers.acme-corp.com/jobs/1')).toBe('Acme Corp');
    expect(employerFallback('https://jobs.northwind.io/openings/9')).toBe('Northwind');
    expect(employerFallback('https://www.vega.co.uk/careers/8')).toBe('Vega');
  });

  /*
   * A posting on a board is not a job at the board. When that is all there
   * is, the address stays as it is: it says where the application came from,
   * which is honest, where a tidied "Greenhouse" would be a lie.
   */
  it('never turns the system into the employer', () => {
    expect(employerFallback('https://boards.greenhouse.io/x/jobs/1')).toBe('boards.greenhouse.io');
    expect(employerFallback('https://www.indeed.com/viewjob?jk=1')).toBe('indeed.com');
  });

  it('leaves an address that is not a name alone', () => {
    expect(employerFallback('http://127.0.0.1:35267/gh/acme/jobs/9910')).toBe('127.0.0.1');
    expect(employerFallback('http://localhost:4600/x')).toBe('localhost');
    expect(employerFallback(undefined)).toBe('Unknown');
  });
});

/*
 * The address is the one source that is certain: a name in it was put there
 * by the system, where og:site_name is whatever the CMS was configured with
 * and a heading is whatever the page says.
 */
describe('the employer named in an address', () => {
  const cases: [string, string][] = [
    ['https://boards.greenhouse.io/streamly/jobs/1', 'Streamly'],
    ['https://jobs.eu.lever.co/vega-labs/8f21', 'Vega Labs'],
    ['https://careers.smartrecruiters.com/HalewoodGroup/743', 'HalewoodGroup'],
    ['https://novena.recruitee.com/o/platform-engineer', 'Novena'],
    ['https://kestrel.teamtailor.com/jobs/9', 'Kestrel'],
    ['https://tarn.applytojob.com/apply/x', 'Tarn'],
    ['https://arden.bamboohr.com/careers/12', 'Arden'],
    ['https://ats.rippling.com/quillon/jobs/1', 'Quillon'],
    ['https://nordhaus.jobs.personio.de/job/188', 'Nordhaus'],
    ['https://harbourline.pinpointhq.com/postings/1', 'Harbourline'],
    ['https://www.comeet.com/jobs/quillon/12.ABC', 'Quillon'],
    ['https://brightwater.icims.com/jobs/2201/apply', 'Brightwater'],
    ['https://jobs.jobvite.com/ridgeway/job/oX', 'Ridgeway'],
    ['https://kestrel-aero.avature.net/careers/JobDetail/1', 'Kestrel Aero'],
    ['https://lumen.eightfold.ai/careers/job?id=1', 'Lumen'],
    ['https://meridian.dayforcehcm.com/CandidatePortal/en-US/x', 'Meridian'],
  ];
  for (const [url, expected] of cases) {
    it(`reads ${expected} out of ${new URL(url).hostname}`, () => {
      expect(companyFromUrl(url)).toBe(expected);
    });
  }
});

describe('keywords', () => {
  it('matches on word boundaries so "go" does not fire on "going"', () => {
    expect(extractKeywords('We are going to the category')).not.toContain('go');
    expect(extractKeywords('Experience with Go and Python')).toContain('go');
  });

  it('finds multi-word terms', () => {
    expect(extractKeywords('experience with distributed systems')).toContain('distributed systems');
  });

  it('reaches outside web and backend, which is where it used to stop', () => {
    const found = extractKeywords(
      'You will write C++ against OpenGL and Vulkan, profiling with Tracy and debugging in GDB. SDL, animation and physics on Linux.',
    );
    expect(found).toEqual(
      expect.arrayContaining(['c++', 'opengl', 'vulkan', 'sdl', 'tracy', 'gdb', 'physics', 'animation', 'linux']),
    );
  });

  /*
   * A false keyword is not cosmetic: it reaches `matchVariants`, which swaps
   * a bullet toward the wording it thinks the posting asked for — so the
   * resume that goes out is wrong for a reason that was never in the
   * posting. These five sentences are why `unity`, `metal`, `make`, `excel`
   * and `blender` are not in the vocabulary, however useful they would be on
   * the postings that mean them.
   */
  it('does not read a technology out of ordinary posting prose', () => {
    const prose = [
      'You will excel in a fast-paced environment and thrive under pressure.',
      'We make time for each other and make space to grow.',
      'Operate a forklift; sheet metal handling experience a plus.',
      'A small team with real unity, shipping real things.',
      'We are an equal opportunity employer. All qualified applicants will receive consideration.',
    ];
    for (const sentence of prose) expect(extractKeywords(sentence)).toEqual([]);
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

/**
 * A tailored resume is a copy of the base with the posting's decisions laid
 * over it. It used to be a link — `extends: base` plus a handful of overrides
 * — and what it actually contained was worked out at render time, so the file
 * did not say what the document was and a copy of a copy grew a chain nobody
 * had chosen.
 */
describe('deriving a resume for a posting', () => {
  const withSkills: StoreData = {
    ...data,
    resumes: [
      { id: 'root', label: 'Root', sections: [{ kind: 'skills', entries: [], groups: ['sk'] }] },
    ],
  };
  const derive = (from: string, store: StoreData) =>
    deriveSpec(
      store.resumes.find((r) => r.id === from)!,
      'job-x',
      'Job X',
      { choices: {}, skills: { sk: ['s_py'] }, rationale: [] },
      {},
      store.resumes,
    );

  it('narrows the skills group the posting asked about', () => {
    const section = derive('root', withSkills).sections?.find((s) => s.kind === 'skills');
    expect(section?.items?.sk).toEqual(['s_py']);
  });

  /*
   * And brings the base's groups with it.
   *
   * The narrowing used to be stated as a bare `{ kind: 'skills', items }`,
   * deliberately leaving `groups` out so the merge would supply it — which
   * was right while resumes inherited and is a section with no groups at all
   * now that they do not. What a person would have seen is the skills heading
   * and nothing under it.
   */
  it('keeps the groups the base showed, so the section still prints', () => {
    const spec = derive('root', withSkills);
    expect(spec.sections?.find((s) => s.kind === 'skills')?.groups).toEqual(['sk']);

    const resolved = resolveResume(spec, { ...withSkills, resumes: [...withSkills.resumes, spec] });
    expect(resolved.sections.flatMap((s) => s.skillGroups.map((g) => g.name))).toEqual(['Languages']);
    expect(resolved.sections.flatMap((s) => s.skillGroups.flatMap((g) => g.items))).toEqual(['Python']);
  });

  /*
   * What the base *was*, as opposed to what it selects, stays with the base:
   * a copy is not itself pinned as a starting point, and it does not inherit
   * an explanation somebody wrote about a different document.
   */
  it('does not take the base’s identity with the base’s selections', () => {
    const pinned: StoreData = {
      ...withSkills,
      resumes: [{ ...withSkills.resumes[0]!, base: true, notes: 'The one I keep up to date.' }],
    };
    const spec = derive('root', pinned);
    expect(spec.base).toBeUndefined();
    expect(spec.notes).toBeUndefined();
    expect(spec.copiedFrom).toBe('root');
    expect(spec.generatedFor).toBeTruthy();
    // Made for one posting, so it is swept a week after that posting is done.
    expect(spec.tier).toBe('temporary');
  });

  it('says nothing about skills where the base has no skills section', () => {
    const bare: StoreData = { ...data, resumes: [{ id: 'plain', label: 'Plain' }] };
    expect(derive('plain', bare).sections).toBeUndefined();
  });
});

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

/* ------------------------------------------------------------------ */

/**
 * The one signal allowed to reach a date: a tag the applicant wrote on their
 * own variant, naming the kind of posting it belongs on.
 */
describe('matching on the posting’s level', () => {
  const intern = detectLevel({ title: 'Software Engineer Intern' });
  const newgrad = detectLevel({ title: 'Software Engineer, New Grad' });

  it('picks the ending marked for internships on an internship posting', () => {
    const result = matchVariants(data, base, { keywords: [], level: intern });
    expect(result.choices['edu.dates']).toBe('v_dec');
  });

  it('switches back off it when the next posting is a new grad role', () => {
    const onIntern: ResumeSpec = { id: 'base', label: 'Base', choices: { 'edu.dates': 'v_dec' } };
    const result = matchVariants(data, onIntern, { keywords: [], level: newgrad });
    expect(result.choices['edu.dates']).toBe('v_may');
  });

  it('leaves the date alone when it is already the right one', () => {
    const result = matchVariants(data, base, { keywords: [], level: newgrad });
    expect(result.choices['edu.dates']).toBeUndefined();
  });

  it('leaves the date alone when the posting names no level', () => {
    const result = matchVariants(data, base, { keywords: [], level: null });
    expect(result.choices['edu.dates']).toBeUndefined();
  });

  it('says which word in the posting moved it', () => {
    const result = matchVariants(data, base, { keywords: [], level: intern });
    const change = result.rationale.find((r) => r.key === 'edu.dates');
    expect(change).toMatchObject({ from: 'v_may', to: 'v_dec' });
    expect(change?.because).toEqual(['intern']);
  });

  /*
   * The setup most people will actually have: one plain wording and one marked
   * for internships, with the intern one left selected from the last
   * application. Nothing is marked `newgrad`, so the only honest move is back
   * to the default — and it has to happen, because otherwise an internship's
   * graduation date rides onto a new grad application.
   */
  it('falls back to the default when only the other level is marked', () => {
    const oneSided: StoreData = {
      ...data,
      entries: [
        {
          id: 'edu2',
          kind: 'education',
          title: 'University',
          dates: {
            default: 'v_plain',
            variants: [
              { id: 'v_plain', label: 'Plain', text: 'May 2026' },
              { id: 'v_intern', label: 'Expected', text: 'Expected May 2026', tags: ['intern'] },
            ],
          },
        },
      ],
    };
    const onIntern: ResumeSpec = { id: 'base', label: 'Base', choices: { 'edu2.dates': 'v_intern' } };
    expect(matchVariants(oneSided, onIntern, { keywords: [], level: newgrad }).choices['edu2.dates']).toBe('v_plain');
    // And it stays put on the posting it was written for.
    expect(matchVariants(oneSided, onIntern, { keywords: [], level: intern }).choices['edu2.dates']).toBeUndefined();
  });

  it('still refuses to pick a date out of the posting’s vocabulary', () => {
    // `v_dec` is tagged `streaming` as well as `intern`. A streaming posting
    // that says nothing about level must not reach it.
    const result = matchVariants(data, base, { keywords: ['streaming'], level: null });
    expect(result.choices['edu.dates']).toBeUndefined();
  });

  it('will not select a fitting variant even when it carries the level tag', () => {
    const reserved: StoreData = {
      ...data,
      entries: [
        {
          id: 'exp2',
          kind: 'experience',
          title: 'Example Co.',
          bullets: [
            {
              id: 'b_role',
              default: 'v_long',
              variants: [
                { id: 'v_long', label: 'Long', text: 'Built an event pipeline' },
                { id: 'v_other', label: 'Other', text: 'Built an event bus' },
                { id: 'v_tight', label: 'Tight', text: 'Built a pipeline', tags: ['intern', 'short'] },
              ],
            },
          ],
        },
      ],
    };
    expect(matchVariants(reserved, base, { keywords: [], level: intern }).choices.b_role).toBeUndefined();
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

  /*
   * A page that *talks about* applications, which is the hardest thing here to
   * tell from one that is an application.
   *
   * Both of these were reported from life: a pull request on the repository of
   * this very tool, and a chat window discussing a cover letter. The
   * vocabulary is genuinely present — that is the subject — and the furniture
   * is genuinely form-shaped: one long textarea, a file picker, a submit
   * button. Nothing in the word counting separates them from a form.
   *
   * What does is that neither has the slightest interest in who you are. Every
   * application form asks for a name, nearly always beside an email; a comment
   * box and a chat composer never do, because the site already knows.
   */
  const DISCUSSES_APPLICATIONS = `<html><head><title>Claude Code</title></head><body>
<h1>Claude Code</h1>
<p>Can you draft a cover letter for the Platform Engineer posting? I want to reuse
the answer about why do you want to work here. I have read the job description and
the requirements — years of experience, responsibilities, qualifications.</p>
<p>Make the resume fit on one page and attach the resume when you submit application
materials.</p>
<form>
  <label for="composer">Reply</label>
  <textarea id="composer" name="prompt"></textarea>
  <input name="attachment" type="file">
  <button type="submit">Send</button>
</form></body></html>`;

  it('refuses a page that discusses applications but asks nothing of you', () => {
    const v = classifyPage(DISCUSSES_APPLICATIONS, 'https://claude.ai/code/session_01');
    expect(v.kind).toBe('none');
    expect(v.why.join(' ')).not.toContain('asks for a resume file');
  });

  /*
   * The same page, with the one thing that makes a form a form. This is the
   * assertion that keeps the rule honest: it has to be the identity field
   * doing the work, not something incidental about the chat page.
   */
  it('accepts the same page once it starts asking who you are', () => {
    const asking = DISCUSSES_APPLICATIONS.replace(
      '<label for="composer">Reply</label>',
      '<label for="you">Full name</label><input id="you" name="fullName">\n  <input type="email" name="email">',
    );
    const v = classifyPage(asking, 'https://claude.ai/code/session_01');
    expect(v.kind).toBe('application');
  });

  it('still knows a real form, which asks for a name as they all do', () => {
    const v = classifyPage(APPLICATION_FORM, 'https://jobs.lever.co/streamly/abc/apply');
    expect(v.kind).toBe('application');
    expect(v.why.join(' ')).toContain('asks for a resume file');
  });

  /*
   * An email field alone is enough — plenty of forms ask for one and let the
   * name come off the resume.
   */
  it('takes an email field as asking who you are', () => {
    const form = `<html><head><title>Apply — Acme</title></head><body>
<h1>Submit application</h1>
<form><input type="email" name="e"><input type="file" name="r">
<label>Cover letter<textarea></textarea></label>
<label>Why do you want to work here?<textarea></textarea></label>
<p>Upload your resume. Work authorization?</p></form></body></html>`;
    expect(classifyPage(form, 'https://acme.example/careers/apply').kind).toBe('application');
  });

  /*
   * A page whose title names the post is a posting whatever its fields do, and
   * must not be caught by a rule aimed at chat windows.
   */
  it('does not need an identity field from a page that names the role', () => {
    const posting = `<html><head><title>Platform Engineer at Streamly</title></head><body>
<h1>Platform Engineer</h1><p>Responsibilities, qualifications, years of experience,
about the role, what you'll do, benefits, compensation.</p></body></html>`;
    expect(classifyPage(posting, 'https://streamly.com/careers/platform-engineer').kind).toBe('posting');
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

/*
 * Reddit, reported from life: the card came up on it.
 *
 * A comment thread is the hardest false positive there is, because it is
 * written by the people postings are written about, in their vocabulary, on a
 * page whose shell carries a login form and whose composer carries a file
 * input. Two of the gates meant to separate a posting from a page about
 * postings read a thread wrongly, and each on its own is enough:
 *
 *   `namesARole` — a title that is the name of a post rather than a sentence
 *   about one. On a careers site the employer wrote that title and it names
 *   the thing being advertised; on a forum it is a person talking, so a
 *   thread called "Software Engineer" is somebody asking about an offer.
 *
 *   `uploadsResume` — a file input, the word résumé, and a page that asks who
 *   you are. Every condition holds on r/resumes, and the verdict was not
 *   merely `posting` but `application`: the tool decided a thread was a form
 *   to fill in.
 *
 * The fixtures below carry the shell and the composer on purpose, because
 * without them the test passes for the wrong reason.
 */
describe('a comment thread, which is written like a posting and is not one', () => {
  const SHELL = `<header><a href="/">reddit</a>
    <form action="/login"><label for="lg">Email or username</label>
    <input id="lg" name="username" type="text"><input name="password" type="password"></form>
    <input type="search" name="q" placeholder="Search Reddit"></header>`;
  const COMPOSER = `<label for="c">Add a comment</label><textarea id="c" name="comment"></textarea>
    <input type="file" id="img" name="image">`;
  const thread = (title: string, body: string) =>
    `<!doctype html><html><head><title>${title}</title></head><body>${SHELL}` +
    `<div class="post"><h1>${title}</h1><p>${body}</p></div>${COMPOSER}` +
    `<div class="comments"><p>Posted by u/someone</p><p>312 comments</p></div></body></html>`;

  const at = (path: string) => `https://www.reddit.com${path}`;

  it('stays quiet on a thread about how many applications people sent', () => {
    const v = classifyPage(
      thread(
        'How many applications did it take you?',
        `I have sent about 200. Most were full-time new grad roles. A few asked for a cover
         letter, most wanted years of experience I do not have. The requirements are always
         "3+ years" even for an internship. Benefits and compensation are never mentioned.`,
      ),
      at('/r/cscareerquestions/comments/1a2b3c/how_many_applications/'),
    );
    expect(v.kind).toBe('none');
  });

  it('stays quiet on a thread whose title happens to be a job title', () => {
    const v = classifyPage(
      thread(
        'Software Engineer',
        `Got an offer. Salary range seems low for the responsibilities. The job description said
         minimum qualifications of 5 years. Should I negotiate? They are an equal opportunity
         employer if that matters.`,
      ),
      at('/r/cscareerquestions/comments/1a2b3d/software_engineer_offer/'),
    );
    expect(v.kind).toBe('none');
  });

  /* The one that was classified as a form to fill in. */
  it('does not read a resume-review thread as an application form', () => {
    const v = classifyPage(
      thread(
        'Resume review — new grad, 0 callbacks',
        `Here is my resume. I am applying to full-time new grad roles. Should I add a cover
         letter? Most postings want years of experience. Any feedback on the requirements?`,
      ),
      at('/r/resumes/comments/1a2b3e/resume_review_new_grad/'),
    );
    expect(v.kind).not.toBe('application');
    expect(v.kind).toBe('none');
  });

  /*
   * And the half that makes the rest mean something. A forum genuinely does
   * carry postings, and suppressing every thread would be the easy wrong
   * answer — quiet everywhere, including where the tool was wanted.
   */
  it('still offers on a thread that is actually hiring', () => {
    const v = classifyPage(
      thread(
        '[Hiring] Backend Engineer — Remote',
        `We are looking for a Backend Engineer. Responsibilities include building services in Go.
         Minimum qualifications: 3 years of experience. Full-time, salary range $150k-$180k.
         Apply now by emailing us. We are an equal opportunity employer.`,
      ),
      at('/r/forhire/comments/1a2b3g/hiring_backend_engineer/'),
    );
    expect(v.kind).toBe('discussion');
  });

  it('reads the Discourse and Stack Exchange shapes as threads too', () => {
    const chatter = thread(
      'Platform Engineer',
      `Responsibilities, qualifications, years of experience, about the role,
       what you'll do, benefits, compensation — what do these even mean?`,
    );
    expect(classifyPage(chatter, 'https://forum.example.com/t/platform-engineer/2').kind).toBe('none');
    expect(classifyPage(chatter, 'https://stackexchange.com/questions/12/what-is-this').kind).toBe('none');
  });

  it('leaves an ordinary site’s /t/ and /questions/ paths alone', () => {
    // The Discourse and Stack Exchange shapes are only read as threads on a
    // host that is one. `/questions/1` is an ordinary path anywhere else, and
    // a careers site is free to use it.
    const posting = `<html><head><title>Platform Engineer</title></head><body>
      <h1>Platform Engineer</h1><p>Responsibilities, qualifications, years of experience,
      about the role, what you'll do, benefits, compensation.</p></body></html>`;
    // Exactly the Discourse shape, `/t/<slug>/<id>`, on a host that is not a
    // forum. Only the host check keeps this a posting.
    expect(classifyPage(posting, 'https://streamly.com/t/platform-engineer/2').kind).toBe('posting');
    expect(classifyPage(posting, 'https://streamly.com/questions/12').kind).toBe('posting');
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

/*
 * The title of a bare application form, which names one thing.
 *
 * Nobody writes a page title for an application step: the system writes it,
 * and it comes out as the word for the step and who it is for — "Apply —
 * Acme", "Apply for this job — Novena Health". Taking the first segment that
 * is not page furniture then filed Acme as the *job* and the address the form
 * was served from as the *employer*, which is inverted, and the employer was
 * the only thing the page actually said.
 *
 * Found by looking at the tracker: a row reading "127.0.0.1 / Acme".
 */
describe('a form whose title is the employer and nothing else', () => {
  const form = '<html><body><p>Submit application. Upload your resume and cover letter.</p></body></html>';
  const read = (title: string, url = 'http://127.0.0.1:45227/gh/acme/jobs/9910') => extractJob(form, url, title);

  it('reads the one remaining segment as who, not as what', () => {
    expect(read('Apply — Acme')).toMatchObject({ company: 'Acme', title: undefined });
  });

  it('knows the applying phrase however many words it takes', () => {
    expect(read('Apply for this job — Novena Health').company).toBe('Novena Health');
    expect(read('Apply to this role — Halewood Group').company).toBe('Halewood Group');
    expect(read('Start your application — Kestrel Aerospace').company).toBe('Kestrel Aerospace');
  });

  it('files an address as neither', () => {
    // `looksLikeCompanyName` already refused a hostname as the employer; with
    // nothing else to be, it was landing as the role instead.
    const job = read('Apply — jobs.acme.com');
    expect(job.company).toBeUndefined();
    expect(job.title).toBeUndefined();
  });

  it('leaves a title that does name a job exactly as it was', () => {
    expect(read('Data Platform Intern | Streamly')).toMatchObject({
      company: 'Streamly',
      title: 'Data Platform Intern',
    });
    expect(read('Platform Engineer at Helios')).toMatchObject({ company: 'Helios', title: 'Platform Engineer' });
  });

  it('does not invent an employer when the page declares one', () => {
    // og:site_name is the site talking about itself, and it wins over a
    // segment of the title either way.
    const declared = '<html><head><meta property="og:site_name" content="Greenhouse"></head><body><p>Submit application.</p></body></html>';
    expect(extractJob(declared, 'http://127.0.0.1:9/x', 'Apply — Acme').company).toBe('Greenhouse');
  });
});

/*
 * The link in the email that says "finish your application" lands on the form,
 * and a bare application form does not name the job. Filing it as "Unknown
 * role" made it a different job from the same job filed off its posting —
 * identity being company and role — so the posting, opened later, filed a
 * second tracker row and said nothing about having already applied.
 */
describe('reading the role out of the address', () => {
  it('reads a job named in the path', () => {
    expect(roleFromUrl('https://x.test/helios/apply/platform-engineer')).toBe('Platform Engineer');
    expect(roleFromUrl('https://x.test/careers/JobDetail/Platform-Engineer/20918')).toBe('Platform Engineer');
    expect(roleFromUrl('https://x.test/lumen/careers/staff-platform-engineer')).toBe('Staff Platform Engineer');
    expect(roleFromUrl('https://x.test/icims/orion/jobs/4021/platform-engineer/form')).toBe('Platform Engineer');
    expect(roleFromUrl('https://x.test/careers/backend-engineer')).toBe('Backend Engineer');
  });

  it('drops the requisition number riding along with it', () => {
    expect(roleFromUrl('https://x.test/jobs/2209118-platform-engineer')).toBe('Platform Engineer');
    expect(roleFromUrl('https://x.test/en/jobs/Staff-Engineer_R-12345')).toBe('Staff Engineer');
  });

  it('takes the segment nearest the job, not the first one that reads like one', () => {
    // These addresses read outwards: the system is at the front, the job is
    // at the back, and a step of the form can follow it.
    expect(roleFromUrl('https://x.test/engineering/jobs/data-scientist/apply')).toBe('Data Scientist');
  });

  it('says nothing when the address names no job', () => {
    // The shapes that carry an opaque id instead, which is most of the big
    // systems. Inventing a role out of a number would be worse than none.
    expect(roleFromUrl('https://x.test/gh/acme/jobs/9910')).toBeUndefined();
    expect(roleFromUrl('https://x.test/lever/vega/8f21/apply')).toBeUndefined();
    expect(roleFromUrl('https://x.test/job/1882043')).toBeUndefined();
    expect(roleFromUrl('https://x.test/jobs/view/3918277401')).toBeUndefined();
    expect(roleFromUrl('https://x.test/Recruiting/Jobs/Details/2891044')).toBeUndefined();
    expect(roleFromUrl('https://x.test/apply/position/118204/submit')).toBeUndefined();
    expect(roleFromUrl('https://x.test/careers/908812/apply')).toBeUndefined();
  });

  it('refuses the page talking about itself, on the vocabulary that already existed', () => {
    expect(roleFromUrl('https://x.test/careers/JobBoard/apply')).toBeUndefined();
    expect(roleFromUrl('https://x.test/careers/job/40128/submit-candidate')).toBeUndefined();
    expect(roleFromUrl('https://x.test/ashby/lyra/role-4c2')).toBeUndefined();
    expect(roleFromUrl('https://x.test/hcmUI/CandidateExperience/en/sites/CX_1/job/18842/apply')).toBeUndefined();
    expect(roleFromUrl('https://x.test/CandidatePortal/en-US/meridian/Posting/View/30914')).toBeUndefined();
  });

  it('is not reached by anything that is not an address', () => {
    expect(roleFromUrl(undefined)).toBeUndefined();
    expect(roleFromUrl('not a url at all')).toBeUndefined();
    expect(roleFromUrl('https://x.test/')).toBeUndefined();
  });

  it('answers the form the page could not', () => {
    const form = '<html><body><h1>Helios</h1><p>Submit application. Upload your resume.</p></body></html>';
    const job = extractJob(form, 'http://127.0.0.1:9/helios/apply/platform-engineer', 'Apply — Helios');
    expect(job).toMatchObject({ company: 'Helios', title: 'Platform Engineer' });
  });

  it('and does not speak over a page that names the job itself', () => {
    // The address says one thing, the title says another; the page wins,
    // because it is the posting and the address is a guess about it.
    const page = '<html><body><p>Submit application.</p></body></html>';
    const job = extractJob(page, 'http://127.0.0.1:9/acme/apply/platform-engineer', 'Data Scientist | Acme');
    expect(job.title).toBe('Data Scientist');
  });
});

/*
 * A row filed without being asked.
 *
 * `holdASpace` in the extension opens a tracker row on its own, off whatever
 * the extractor made of the pages somebody walked through. The company went
 * through `looksLikeCompanyName` and the role went through nothing, so a
 * tracker that is supposed to be the record of what somebody applied for
 * filled up with the board they were browsing:
 *
 *   Indeed    Now Hiring: 300 Software Intern Jobs
 *   Reddit    https://preview.redd.it/qz1.jpeg?width=1280&format=pjpg
 *   ...       2027 Summer
 *
 * Refusing costs a moment — the application gets recorded by hand — and
 * accepting costs a line in the list that nobody can tell from a real one.
 */
describe('whether a pair is worth filing a row for on its own', () => {
  it("refuses a board's results page, which lists jobs and is not one", () => {
    expect(looksLikeRoleTitle('Now Hiring: 300 Software Intern Jobs')).toBe(false);
    expect(looksLikeRoleTitle('Software Intern Jobs, Employment in Boston, MA')).toBe(false);
    expect(looksLikeRoleTitle('1,204 Backend Engineer jobs')).toBe(false);
    expect(looksLikeRoleTitle('Search jobs')).toBe(false);
    expect(looksLikeRoleTitle('Job search results')).toBe(false);
  });

  /*
   * And not the employer, on a list of the places you look for work.
   *
   * The first version of this refused any application whose company was
   * Indeed, LinkedIn, Google or Reddit, on the grounds that those are boards
   * rather than employers. They are also four of the largest employers
   * anybody using this is applying to, and the rule meant no automatic row
   * for any of them — a worse error than the one it was fixing. What the
   * tracker actually filled up with was a board's *results page*, which is
   * something the role says.
   */
  it('and does not refuse an employer for having a job board', () => {
    expect(looksLikeAnApplication('Google', 'Software Engineer, Early Career')).toBe(true);
    expect(looksLikeAnApplication('LinkedIn', 'Software Engineer Intern')).toBe(true);
    expect(looksLikeAnApplication('Indeed', 'Backend Engineer')).toBe(true);
    // The Reddit row in the tracker was refused by what its role was, which
    // was an image address, and that is still refused below.
    expect(looksLikeAnApplication('Reddit', 'Android Engineer')).toBe(true);
  });

  it('refuses a role that is an address somebody pasted', () => {
    expect(looksLikeRoleTitle('https://preview.redd.it/qz1.jpeg?width=1280&format=pjpg')).toBe(false);
    expect(looksLikeRoleTitle('www.acme.test/careers')).toBe(false);
    expect(looksLikeRoleTitle('boards.greenhouse.io')).toBe(false);
    expect(looksLikeRoleTitle('Backend Engineer?utm_source=indeed')).toBe(false);
  });

  it('refuses a when with no what', () => {
    expect(looksLikeRoleTitle('2027 Summer')).toBe(false);
    expect(looksLikeRoleTitle('Summer 2027')).toBe(false);
    expect(looksLikeRoleTitle('Fall 2026 / Spring 2027')).toBe(false);
    // And keeps the real intake that says both.
    expect(looksLikeRoleTitle('Summer 2027 Software Engineering Intern')).toBe(true);
  });

  it('refuses the page talking about itself, and a role that is not words', () => {
    expect(looksLikeRoleTitle('Apply')).toBe(false);
    expect(looksLikeRoleTitle('Job Details')).toBe(false);
    expect(looksLikeRoleTitle('R-129384')).toBe(false);
    expect(looksLikeRoleTitle('')).toBe(false);
  });

  it('takes the ordinary job, which is the whole point of the gate', () => {
    expect(looksLikeAnApplication('Indeed', 'Now Hiring: 300 Software Intern Jobs')).toBe(false);
    expect(looksLikeAnApplication('Streamly', 'Data Platform Intern')).toBe(true);
    expect(looksLikeAnApplication('ByteDance', 'Software Engineer Intern (2027 Summer)')).toBe(true);
    expect(looksLikeAnApplication('Helios', 'Platform Engineer')).toBe(true);
    // Including the ones with no role noun anywhere in them, which is why the
    // gate does not ask for one: these are real intakes.
    expect(looksLikeAnApplication('Acme', 'Product Marketing, Early Career')).toBe(true);
    expect(looksLikeAnApplication('Vega', 'Quantitative Trading')).toBe(true);
  });
});
