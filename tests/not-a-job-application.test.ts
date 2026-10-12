import { describe, expect, it } from 'vitest';
import { classifyPage, companyFromUrl, JOB_SHAPED } from '../src/jobs/extract.js';

/*
 * Forms that are applications, but not for a job.
 *
 * Reported from life: a bank's personal-loan application — name, email,
 * Social Security number, annual income — was posted to /extension/analyze,
 * came back as `kind: 'application'` with a score of 8, and on Submit the
 * tracker gained an "applied" row for "Bank / Personal loan application" and
 * the answer bank gained the user's annual income. The page asked who you are,
 * said "first name", "last name" and "submit application", and lived under
 * /application/ — every one of which a loan, an insurance quote, a university
 * and a letting agent share with an employer.
 *
 * The loan page is the one the extension was driven through, verbatim.
 */
const LOAN = `<!doctype html><html><head><title>Personal loan application | Example Bank</title></head><body>
<h1>Apply for a personal loan</h1><p>Requirements: you must be 18+. Benefits: low APR.</p>
<form><label for=fn>First name</label><input id=fn name=first_name><label for=ln>Last name</label><input id=ln name=last_name>
<label for=em>Email</label><input id=em type=email name=email><label for=ph>Phone</label><input id=ph name=phone>
<label for=inc>Annual income</label><input id=inc name=income><label for=emp>Employer</label><input id=emp name=employer>
<label for=ssn>Social Security number</label><input id=ssn name=ssn><p>SECRET-PAGE-MARKER-loan account 4111-1111</p>
<button>Submit application</button></form></body></html>`;

const INSURANCE = `<!doctype html><html><head><title>Get a car insurance quote | Example Insurance</title></head><body>
<h1>Get your quote</h1><p>Full-time or part-time drivers. Benefits: roadside assistance, compensation for courtesy cars.</p>
<form><label>First name<input name="firstName"></label><label>Last name<input name="lastName"></label>
<label>Email<input type="email" name="email"></label><label>Phone number<input name="phone"></label>
<label>Date of birth<input name="dob"></label><label>Occupation<input name="occupation"></label>
<label>Upload your driving licence<input type="file" name="licence"></label>
<p>Application form for new policies. Tell us about your car.</p>
<button>Submit application</button></form></body></html>`;

const ADMISSION = `<!doctype html><html><head><title>Undergraduate application | Example University</title></head><body>
<h1>Apply for undergraduate admission</h1>
<p>Requirements: transcripts and two references. Full-time and part-time study. Remote and on-site options.</p>
<form><label>First name<input name="first_name"></label><label>Last name<input name="last_name"></label>
<label>Email<input type="email" name="email"></label><label>Phone number<input name="phone"></label>
<label>Upload transcript<input type="file" name="transcript"></label>
<label>Personal statement — tell us about yourself<textarea name="statement"></textarea></label>
<label>Why do you want to study here?<textarea name="why"></textarea></label>
<button>Submit application</button></form></body></html>`;

const RENTAL = `<!doctype html><html><head><title>Rental application – 12 Elm Street | Example Lettings</title></head><body>
<h1>Rental application</h1><p>Requirements: proof of income, references.</p>
<form><label>First name<input name="first"></label><label>Last name<input name="last"></label>
<label>Email<input type="email" name="email"></label><label>Phone number<input name="phone"></label>
<label>Current employer<input name="employer"></label><label>Monthly income<input name="income"></label>
<label>Move-in date<input name="movein"></label>
<label>Upload proof of income<input type="file" name="payslip"></label>
<button>Submit application</button></form></body></html>`;

describe('an application form that is not for a job', () => {
  it.each([
    ['the personal loan that reached the tracker', LOAN, 'http://bank.example:5097/application/personal-loan'],
    ['the same loan at its other address', LOAN, 'http://bank2.example:5097/loans/personal'],
    ['an insurance quote', INSURANCE, 'https://insure.example/quote/apply'],
    ['a university admission', ADMISSION, 'https://uni.example/admissions/apply'],
    ['a rental application', RENTAL, 'https://lettings.example/properties/12-elm/application'],
  ])('is not a job application: %s', (_name, html, url) => {
    const v = classifyPage(html, url);
    expect(v.kind).not.toBe('application');
    expect(v.kind).toBe('none');
  });
});

/*
 * And the ones that came back once quick-apply pages were let in by their
 * address and a LinkedIn field. The careers address was read off the whole
 * URL, query and fragment too; a tracker's name in a query string made the
 * page that tracker; a `jobs.` host or a `/job/` segment counted whatever the
 * rest of the path said; and a LinkedIn field counted on its own, which an
 * MBA admission and an accelerator's founder form both ask for.
 */
const MBA = (extra = '') => `<!doctype html><html><head><title>MBA application | Example University</title></head><body>
<h1>Apply for the MBA programme</h1>
<p>Requirements: transcripts and two references. Full-time and part-time study.</p>
<form><label>First name<input name="first_name"></label><label>Last name<input name="last_name"></label>
<label>Email<input type="email" name="email"></label><label>Phone number<input name="phone"></label>
${extra}
<label>Why do you want to study here?<textarea name="why"></textarea></label>
<button>Submit application</button></form></body></html>`;

const ACCELERATOR = `<!doctype html><html><head><title>Apply to the Spring batch | Example Accelerator</title></head><body>
<h1>Founder application</h1><p>Requirements: a working prototype.</p>
<form><label>First name<input name="first_name"></label><label>Last name<input name="last_name"></label>
<label>Email<input type="email" name="email"></label><label>Phone number<input name="phone"></label>
<label>LinkedIn URL<input name="linkedin_url"></label><label>Company website<input name="site"></label>
<button>Submit application</button></form></body></html>`;

describe('a form that only looks like a job application by its address or a LinkedIn field', () => {
  it.each([
    ['a loan with /careers/ in its query', LOAN, 'https://bank.example/loans/apply?returnTo=/careers/'],
    ['a loan with #jobs', LOAN, 'https://bank.example/loans/apply#jobs'],
    ['a loan under a jobs. host', LOAN, 'https://jobs.example-cu.org/loans/apply'],
    ['a loan on a /job/ segment', LOAN, 'https://bank.example/job/loan-application'],
    ['a loan with a tracker’s host in its query', LOAN, 'https://bank.example/loans/apply?partner=acme.icims.com'],
    ['a loan with a Lever address in its query', LOAN, 'https://bank.example/loans/apply?utm_campaign=leverage&ref=jobs.lever.co/acme'],
    ['a loan with a Cornerstone tenant in its query', LOAN, 'https://bank.example/loans/apply?ref=acme.csod.com'],
    ['a loan with a Homerun address to go on to', LOAN, 'https://bank.example/loans/apply?next=https://acme.homerun.co/x'],
    ['an MBA admission with a LinkedIn field', MBA('<label>LinkedIn profile<input name="linkedin"></label>'), 'https://uni.example/admissions/mba/apply'],
    ['an MBA admission with a LinkedIn placeholder', MBA('<label>Profile URL<input name="url" placeholder="https://linkedin.com/in/you"></label>'), 'https://uni.example/admissions/mba/apply'],
    ['an accelerator’s founder form with a LinkedIn field', ACCELERATOR, 'https://accelerator.example/apply'],
    ['a career-fair registration under /careers', MBA(), 'https://uni.example/careers/events/fair-registration'],
    // A digit in the address is not a job's number: a cohort or a year.
    ['an accelerator’s founder form for a cohort', ACCELERATOR, 'https://accelerator.example/apply/s2027'],
    ['an accelerator’s founder form for a short cohort', ACCELERATOR, 'https://accelerator.example/apply/w27'],
    ['an MBA admission for a year', ACCELERATOR, 'https://uni.example/apply/mba-2027'],
    ['an admission for a term', ACCELERATOR, 'https://uni.example/application/fall2027'],
    // A department-like word under a careers path, with no number to say which job.
    ['a loan under a jobs. host and /careers', LOAN, 'https://jobs.example-cu.org/careers/loans/apply'],
    ['a career fair under /careers/events', MBA(), 'https://uni.example/careers/events/register'],
  ])('is not a job application: %s', (_name, html, url) => {
    expect(classifyPage(html, url).kind).toBe('none');
  });

  it('reads an employer from a tracker’s own host only', () => {
    expect(companyFromUrl('https://bank.example/loans/apply?ref=acme.csod.com')).toBeUndefined();
    expect(companyFromUrl('https://bank.example/loans/apply?next=https://acme.homerun.co/x')).toBeUndefined();
    expect(companyFromUrl('https://bank.example/acme.icims.com/apply')).toBeUndefined();
    expect(companyFromUrl('https://acme.homerun.co.example.net/x')).toBeUndefined();
    expect(companyFromUrl('https://acme.csod.com/ux/ats/careersite/1/home')).toBe('Acme');
    expect(companyFromUrl('https://boards.greenhouse.io/acme/jobs/123')).toBe('Acme');
  });
});

/*
 * And the forms that are, which have to stay so. Each carries at least one
 * thing only a job application has — a résumé, a tracker's address, a job's
 * own questions — and some carry only one.
 */
const WHO = `<label>First name<input name="first"></label><label>Last name<input name="last"></label>
<label>Email<input type="email" name="email"></label><label>Phone number<input name="phone"></label>`;

describe('an application form that is for a job', () => {
  // The pages of a tracker's own form that ask nothing but who you are: the
  // tracker's address is the only job evidence there is, and it is enough.
  it.each([
    ['Workday', 'https://acme.wd5.myworkdayjobs.com/en-US/External/job/Boston/Platform-Engineer_R123/apply/applyManually'],
    ['Greenhouse', 'https://boards.greenhouse.io/acme/jobs/123#app'],
    ['Lever', 'https://jobs.lever.co/acme/abc-123/apply'],
    ['iCIMS', 'https://careers-acme.icims.com/jobs/123/platform-engineer/candidate'],
    ['Ashby', 'https://jobs.ashbyhq.com/acme/abc-123/application'],
    ['SmartRecruiters', 'https://jobs.smartrecruiters.com/Acme/123-platform-engineer/apply'],
  ])('on %s, asking only who you are', (_ats, url) => {
    const html = `<html><head><title>Apply</title></head><body><h1>My information</h1>
<form>${WHO}<button>Submit application</button></form></body></html>`;
    const v = classifyPage(html, url);
    expect(v.kind).toBe('application');
    expect(v.score).toBeGreaterThanOrEqual(JOB_SHAPED);
  });

  it('on an employer’s own site, by its résumé upload', () => {
    const html = `<html><head><title>Apply — Acme</title></head><body><h1>Submit application</h1>
<form>${WHO}<label>Resume<input type="file" name="resume"></label></form></body></html>`;
    expect(classifyPage(html, 'https://acme.example/careers/apply').kind).toBe('application');
  });

  it('on an employer’s own site, by the questions only an employer asks', () => {
    const html = `<html><head><title>Apply — Acme</title></head><body><h1>Submit application</h1>
<form>${WHO}<label>Are you legally authorized to work in the United States?<select></select></label>
<label>Will you now or in the future require sponsorship?<select></select></label></form></body></html>`;
    expect(classifyPage(html, 'https://acme.example/apply').kind).toBe('application');
  });

  it('on an employer’s own site, by the position it is for', () => {
    const html = `<html><head><title>Apply — Acme</title></head><body><h1>Submit application</h1>
<p>You are applying for the position of Platform Engineer.</p>
<form>${WHO}</form></body></html>`;
    expect(classifyPage(html, 'https://acme.example/apply').kind).toBe('application');
  });

  /*
   * Quick-apply pages that ask who you are and nothing a loan would not, and
   * were missed once the job had to be on the form: the job is in the address
   * or in the LinkedIn field, and nowhere else.
   */
  it.each([
    ['an employer’s careers host, by its LinkedIn field', 'https://careers.acme.com/apply/4821', true],
    // A LinkedIn field alone is not enough (see below): with a job's number beside it, it is.
    ['an employer’s own /apply, by its LinkedIn field and the job’s number', 'https://acme.example/apply/48213', true],
    ['a careers host whose role starts with "loan"', 'https://careers.bank.example/jobs/loan-officer/apply', false],
    ['an employer’s jobs host with /careers in the path', 'https://jobs.acme.com/careers/apply?step=1', false],
    ['Pinpoint', 'https://acme.pinpointhq.com/en/postings/abc/applications/new', false],
    ['Personio', 'https://acme.jobs.personio.de/job/12345/apply', false],
    ['Comeet', 'https://www.comeet.com/jobs/acme/12.345/platform-engineer/apply', false],
    ['Zoho Recruit', 'https://acme.zohorecruit.com/jobs/Careers/123/Platform-Engineer/apply', false],
    ['JazzHR', 'https://acme.applytojob.com/apply/abc123/Platform-Engineer', false],
    /*
     * A loan's, an event's or an insurer's word that is the start of a role's
     * name further along, or after a ".", or beside a role noun the list did
     * not have; or a department under a careers path beside the job's number.
     */
    ['a mortgage loan officer', 'https://acme.example/careers/mortgage-loan-officer/apply', false],
    ['a loan servicing specialist', 'https://acme.example/careers/loan-servicing-specialist/apply', false],
    ['an insurance sales agent', 'https://acme.example/jobs/insurance-sales-agent-12345', false],
    ['a fair lending analyst', 'https://acme.example/careers/fair-lending-analyst', false],
    ['a lease administrator', 'https://acme.example/careers/lease-administrator/apply', false],
    ['a quotes engineer', 'https://acme.example/careers/quotes-engineer', false],
    ['an events sales manager', 'https://careers.acme.com/job/4821/events-sales-manager', false],
    ['event staff', 'https://careers.acme.com/apply/event-staff-4821', false],
    ['an event coordinator after a dot', 'https://acme.example/jobs/event.coordinator', false],
    ['a claims adjuster in the insurance department', 'https://acme.example/careers/insurance/claims-adjuster-4821', false],
    ['a job numbered before its department', 'https://careers.acme.com/job/4821/insurance', false],
    ['a numbered job under the events team', 'https://acme.example/careers/events/apply/4821', false],
  ])('on %s, asking only who you are', (_name, url, linkedIn) => {
    const html = `<html><head><title>Apply</title></head><body><h1>Your details</h1>
<form>${WHO}${linkedIn ? '<label>LinkedIn profile<input name="linkedin"></label>' : ''}
<button>Submit application</button></form></body></html>`;
    expect(classifyPage(html, url).kind).toBe('application');
  });

  it('by a résumé asked for in another language', () => {
    const upload = (word: string) => `<html><head><title>Bewerbung</title></head><body>
<form>${WHO}<label>${word}<input type="file" name="doc"></label></form></body></html>`;
    expect(classifyPage(upload('Lebenslauf'), 'https://acme.example/bewerbung').kind).toBe('application');
    expect(classifyPage(upload('简历'), 'https://hr.acme.example/apply/123').kind).toBe('application');
  });

  it('when the page declares a JobPosting', () => {
    const html = `<html><head><title>Apply — Acme</title>
<script type="application/ld+json">{"@type":"JobPosting","title":"Platform Engineer"}</script></head><body>
<h1>Submit application</h1><form>${WHO}</form></body></html>`;
    expect(classifyPage(html, 'https://acme.example/apply').kind).toBe('application');
  });
});
