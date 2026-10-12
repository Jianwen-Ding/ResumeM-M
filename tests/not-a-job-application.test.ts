import { describe, expect, it } from 'vitest';
import { classifyPage, JOB_SHAPED } from '../src/jobs/extract.js';

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

  it('when the page declares a JobPosting', () => {
    const html = `<html><head><title>Apply — Acme</title>
<script type="application/ld+json">{"@type":"JobPosting","title":"Platform Engineer"}</script></head><body>
<h1>Submit application</h1><form>${WHO}</form></body></html>`;
    expect(classifyPage(html, 'https://acme.example/apply').kind).toBe('application');
  });
});
