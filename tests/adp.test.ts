/**
 * A posting on ADP Workforce Now's candidate site, myjobs.adp.com.
 *
 * Reported from life: the card never came up on the posting, and three steps
 * into the application it started a new one with no role. ADP titles every
 * page "Career Site", draws the role's name in a web component with no <h1>,
 * and tags a board's links `?rb=LINKEDIN`. So the posting named no role, had
 * nowhere to apply, and was classified as no job at all.
 *
 * The page below is the live one's shape: its head, its furniture, and the
 * words around the role. The description is made up.
 */
import { describe, expect, it } from 'vitest';
import { classifyPage, companyFromUrl, employerOrUnknown, extractJob } from '../src/jobs/extract.js';

const POSTING_URL = 'https://myjobs.adp.com/astronautics/cx/job-details?reqId=5001225797306&rb=LINKEDIN';

const posting = `<!doctype html><html><head>
<meta name="og:title" property="og:title" content="Software Engineering Intern">
<meta name="og:image" property="og:image" content="https://myjobs.cf.adp.com/admin-config/assets/Logo2.jpg">
<title>Career Site</title></head><body>
<sdf-page-layout><header><span>Career Site</span><sdf-button>Sign in</sdf-button><a href="#">Employer Privacy Policy</a></header>
<main><sdf-link>Back</sdf-link><span>10d</span>
<h2 class="job-title">Software Engineering Intern</h2>
<p>#26-298 Oak Creek, Wisconsin, United States</p>
<sdf-button>Apply</sdf-button>
<h3>Job Description</h3>
<p>Join our team as a Software Engineering Intern. You will work closely with our engineering staff on
customer projects and write embedded software for avionics displays.</p>
<h3>Qualifications</h3>
<ul><li>Pursuing a degree in computer science or computer engineering</li><li>Experience with C or C++</li></ul>
<p>Responsibilities include design, code, test and review. Paid internship with benefits.</p>
<p>Astronautics is an equal opportunity employer.</p>
</main></sdf-page-layout></body></html>`;

describe('an ADP posting, titled "Career Site"', () => {
  it('is a posting', () => {
    const verdict = classifyPage(posting, POSTING_URL);
    expect(verdict.kind, verdict.why.join(', ')).toBe('posting');
    expect(verdict.why).toContain('names a role');
  });

  it('names the role from what it declares itself, and the employer from its address', () => {
    expect(extractJob(posting, POSTING_URL, 'Career Site')).toMatchObject({
      title: 'Software Engineering Intern',
      company: 'Astronautics',
    });
  });

  it('on a system for hiring, not a board, whatever the link it came by says', () => {
    const verdict = classifyPage(posting, POSTING_URL);
    expect(verdict.why).toContain('applicant tracking system');
    expect(verdict.why).not.toContain('job board');
  });

  it('and every step after it is the same employer’s: sign-in, apply', () => {
    for (const url of [
      'https://myjobs.adp.com/astronautics/auth',
      'https://myjobs.adp.com/astronautics/cx/apply?reqId=5001225797306',
    ]) {
      expect(companyFromUrl(url), url).toBe('Astronautics');
    }
  });

  it('is never "Adp": ADP is the system, not who is hiring', () => {
    expect(employerOrUnknown('https://myjobs.adp.com/astronautics/cx/apply')).not.toMatch(/adp/i);
  });
});

describe('what a page declares itself to be is not enough on its own', () => {
  it('an article titled for a role, but written about one, is still not a posting', () => {
    const article = `<html><head><title>Blog</title>
      <meta property="og:title" content="How to become a Software Engineer"></head><body>
      <h2>How to become a Software Engineer</h2><p>Responsibilities, qualifications and benefits vary.
      Years of experience matter. Read our privacy policy.</p></body></html>`;
    expect(classifyPage(article, 'https://example.com/blog/become-an-engineer').kind).toBe('none');
  });
});
