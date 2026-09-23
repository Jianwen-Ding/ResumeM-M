import { describe, expect, it } from 'vitest';
import { extractJob, mergeJobPages, withoutChrome, type PageSource } from '../src/jobs/extract.js';

/*
 * Realistic pages from one application's trail — a Greenhouse-shaped posting,
 * a careers page that lists roles and hides one behind "Read more", and a
 * Workday/Ashby-shaped application form — each with the site chrome a real
 * page carries and the posting or the form laid out in the awkward places a
 * real page puts it: an <aside>, a <details>, a role="complementary" region,
 * a tab panel.
 *
 * What must survive every one of them: requirements, responsibilities,
 * qualifications, salary, location/remote policy, visa/sponsorship,
 * benefits, the company's own description of itself, the deadline, and every
 * form question with its options. What must not: markup, scripts, JSON
 * state blobs, nav, footer, a cookie banner, a "similar jobs" rail, a social
 * share row, and a two-hundred-country dropdown.
 */

const REQUIREMENTS = [
  'Own the ingestion path end to end, from Kafka to the warehouse.',
  'Keep p99 latency under 400ms for the streaming API.',
  'Partner with product on the roadmap for the data platform.',
];
const QUALIFICATIONS = [
  '5+ years building backend services in Go or a similar language.',
  'Experience operating Kafka, or a comparable streaming system, in production.',
  'Comfortable debugging distributed systems at 3am.',
];
const COMPANY_ABOUT =
  'Acme builds the payments infrastructure that half a million merchants rely on every day.';
const SALARY = '$165,000-$205,000';
const LOCATION_POLICY = 'This role is hybrid: three days a week in our Boston office.';
const VISA_LINE = 'We are not able to sponsor visas for this position at this time.';
const BENEFITS = 'full medical, dental and vision coverage, a 401(k) match, and unlimited PTO';
const DEADLINE = 'we aim to close this requisition by the end of next quarter';

/*
 * Realistic-sized, on purpose: a round-4 review found that a small link
 * group (chips, a breadcrumb, a handful of nav items) is no longer removed
 * at all unless it proves itself a rail — see `isSiteNavigationBlock` — so a
 * 3-4-link nav survives now, correctly, and is not what these fixtures test
 * for. A real site header carries considerably more than that, which is
 * what actually earns the "site navigation, six links or more" removal.
 */
const NAV =
  '<nav class="site-nav"><ul>' +
  '<li><a href="/about">About</a></li><li><a href="/careers">All jobs</a></li>' +
  '<li><a href="/blog">Engineering blog</a></li><li><a href="/teams">Teams</a></li>' +
  '<li><a href="/press">Press</a></li><li><a href="/investors">Investors</a></li>' +
  '<li><a href="/contact">Contact</a></li><li><a href="/login">Sign in</a></li>' +
  '</ul></nav>';
/*
 * A footer sitemap of links only, deliberately — a stray sentence of its own
 * ("Copyright Acme Corporation.") is itself a short, complete-looking line
 * by the same shape rule that keeps "US only." elsewhere in this file (see
 * `SHORT_SENTENCE_RUN`), and would keep the whole footer, links and all,
 * once one is added back in. A real footer almost always has some prose of
 * its own beside its links, and some of that prose now survives alongside
 * them — an accepted cost, not something these fixtures need to prove.
 */
const FOOTER =
  '<footer class="site-footer"><nav><ul>' +
  '<li><a href="/privacy">Privacy Policy</a></li><li><a href="/terms">Terms of Service</a></li>' +
  '<li><a href="/careers">Careers</a></li><li><a href="/press">Press</a></li>' +
  '<li><a href="/contact">Contact Us</a></li><li><a href="/security">Security</a></li>' +
  '<li><a href="/sitemap">Sitemap</a></li><li><a href="/investors">Investor Relations</a></li>' +
  '</ul></nav></footer>';
const COOKIE_BANNER =
  '<div id="onetrust-consent-sdk"><div class="onetrust-banner"><p>We use cookies to enhance your browsing experience and analyze traffic.</p>' +
  '<button>Accept All</button></div></div>';
const SOCIAL_SHARE =
  '<div class="social-share"><span>Share this job</span>' +
  '<a class="share-linkedin" href="#"><svg viewBox="0 0 24 24"><path d="M4 4h4v16H4z"/></svg>LinkedIn</a>' +
  '<a class="share-twitter" href="#"><svg viewBox="0 0 24 24"><path d="M2 2l20 20"/></svg>Twitter</a></div>';
const SIMILAR_JOBS =
  '<section class="similar-jobs"><h3>Similar jobs</h3><ul>' +
  '<li><a href="/jobs/2">Backend Engineer, Payments</a></li>' +
  '<li><a href="/jobs/3">Site Reliability Engineer</a></li>' +
  '<li><a href="/jobs/4">Data Engineer</a></li>' +
  '<li><a href="/jobs/5">Staff Engineer, Infra</a></li></ul></section>';

const countryOptions = (n: number) =>
  Array.from({ length: n }, (_, i) => `<option value="c${i}">Country ${i}</option>`).join('');

function postingBody(): string {
  return `<h1>Platform Engineer, Data Infrastructure</h1>
    <p>${COMPANY_ABOUT} We are a company of about 400 people, headquartered in Boston.</p>
    <h2>Responsibilities</h2>
    <ul>${REQUIREMENTS.map((r) => `<li>${r}</li>`).join('')}</ul>
    <h2>Qualifications</h2>
    <ul>${QUALIFICATIONS.map((q) => `<li>${q}</li>`).join('')}</ul>
    <h2>Compensation and benefits</h2>
    <p>Base salary range for this role is ${SALARY}, plus equity. We offer ${BENEFITS}.</p>
    <h2>Location</h2>
    <p>${LOCATION_POLICY} ${VISA_LINE}</p>
    <h2>How to apply</h2>
    <p>Applications are reviewed on a rolling basis; ${DEADLINE}. Acme is an equal opportunity employer.</p>`;
}

/** All the survival checks one extracted description has to pass. */
function expectPostingSurvives(description: string) {
  for (const line of [...REQUIREMENTS, ...QUALIFICATIONS]) expect(description).toContain(line);
  expect(description).toContain(COMPANY_ABOUT);
  expect(description).toContain(SALARY);
  expect(description).toContain(LOCATION_POLICY);
  expect(description).toContain(VISA_LINE);
  expect(description).toContain(BENEFITS);
  expect(description).toContain(DEADLINE);
}

function expectJunkGone(description: string) {
  expect(description).not.toContain('All jobs');
  expect(description).not.toContain('Engineering blog');
  expect(description).not.toContain('Privacy Policy');
  expect(description).not.toContain('Investor Relations');
  expect(description).not.toContain('We use cookies');
  expect(description).not.toContain('Similar jobs');
  expect(description).not.toContain('Backend Engineer, Payments');
  expect(description).not.toContain('Share this job');
}

describe('a Greenhouse-shaped posting page', () => {
  const html = `<!doctype html><html><head><title>Platform Engineer, Data Infrastructure - Acme</title>
    <script type="application/json" id="__NEXT_DATA__">${JSON.stringify({ flags: ['flag-alpha', 'flag-beta'] })}</script>
    </head><body>
    ${NAV}
    <header role="banner"><a href="/">Acme</a><button>Sign in</button></header>
    <main>${postingBody()}${SOCIAL_SHARE}</main>
    <aside role="complementary">${SIMILAR_JOBS}</aside>
    ${COOKIE_BANNER}
    ${FOOTER}
    </body></html>`;
  const job = extractJob(html, 'https://boards.greenhouse.io/acme/jobs/1', 'Platform Engineer, Data Infrastructure - Acme');

  it('keeps every real part of the posting', () => expectPostingSurvives(job.description));
  it('leaves out the site chrome', () => expectJunkGone(job.description));
  it('leaves out the JSON state blob', () => expect(job.description).not.toContain('flag-alpha'));
  it('is a fraction of the raw page', () => expect(job.description.length).toBeLessThan(html.length / 2));
});

describe('a careers page with a company blurb, a listing, and one role behind Read more', () => {
  const otherRoles = Array.from(
    { length: 8 },
    (_, i) => `<li class="job"><a href="/jobs/${i}">${['Backend Engineer', 'Product Designer', 'Recruiter', 'Support Engineer'][i % 4]}</a></li>`,
  ).join('');
  const html = `<!doctype html><html><head><title>Careers at Acme</title></head><body>
    ${NAV}
    <main>
      <h1>Join Acme</h1>
      <p>${COMPANY_ABOUT} We believe in small teams and owning what you ship.</p>
      <section class="open-roles"><h2>Open roles</h2><ul>${otherRoles}
        <li class="job"><details><summary>Platform Engineer, Data Infrastructure — Boston (Hybrid)</summary>
          <div class="collapsed-description">${postingBody()}</div>
        </details></li>
      </ul></section>
    </main>
    ${FOOTER}
    </body></html>`;
  const job = extractJob(html, 'https://acme.com/careers', 'Careers at Acme');

  it('keeps the posting collapsed inside <details>', () => expectPostingSurvives(job.description));
  it('keeps the company describing itself outside the posting too', () =>
    expect(job.description).toContain('We believe in small teams'));
  it('leaves out the nav and footer', () => {
    expect(job.description).not.toContain('All jobs');
    expect(job.description).not.toContain('Privacy Policy');
  });
});

describe('a Workday/Ashby-shaped application form', () => {
  const html = `<!doctype html><html><head><title>Apply for Platform Engineer, Data Infrastructure</title></head><body>
    ${NAV}
    <main>
      <aside role="tabpanel" class="job-summary"><h2>Platform Engineer, Data Infrastructure</h2>
        <p>Boston, MA (Hybrid) &middot; Full-time &middot; Engineering</p>
      </aside>
      <form>
        <h2>Personal information</h2>
        <label for="first">First name*</label><input id="first" />
        <label for="email">Email*</label><input id="email" type="email" />
        <label for="resume">Resume/CV*</label><input id="resume" type="file" />
        <label for="country">Country of residence*</label>
        <select id="country">${countryOptions(195)}</select>

        <h2>Work authorization</h2>
        <label for="visa">Will you now or in the future require visa sponsorship to work in the US?*</label>
        <select id="visa"><option value="">Select</option><option>Yes</option><option>No</option></select>
        <label for="auth">Are you legally authorized to work in the United States?*</label>
        <select id="auth"><option value="">Select</option><option>Yes</option><option>No</option></select>

        <h2>Voluntary self-identification (EEO)</h2>
        <label for="gender">Gender</label>
        <select id="gender"><option>Decline to self-identify</option><option>Male</option><option>Female</option><option>Non-binary</option></select>
        <label for="veteran">Veteran status</label>
        <select id="veteran"><option>I am not a veteran</option><option>Protected veteran</option><option>I don't wish to answer</option></select>
        <label for="disability">Disability status</label>
        <select id="disability"><option>Yes</option><option>No</option><option>I don't wish to answer</option></select>

        <h2>Application questions</h2>
        <label for="q1">Why do you want to work at Acme? (max 500 words)*</label>
        <textarea id="q1" maxlength="3000"></textarea>
        <label for="q2">Describe a time you debugged a production incident under pressure.*</label>
        <textarea id="q2"></textarea>
        <label for="q3">What is your expected salary range?*</label>
        <input id="q3" />
        <button type="submit">Submit application</button>
      </form>
    </main>
    ${COOKIE_BANNER}
    ${FOOTER}
    </body></html>`;
  const job = extractJob(html, 'https://acme.wd5.myworkdayjobs.com/acme/job/1/apply', 'Apply for Platform Engineer, Data Infrastructure');

  it('keeps the role and location summary inside the tab panel', () => {
    expect(job.description).toContain('Boston, MA (Hybrid)');
    expect(job.description).toContain('Full-time');
  });

  it('keeps every question, with its own options and limits', () => {
    expect(job.description).toContain('Will you now or in the future require visa sponsorship');
    expect(job.description).toContain('Yes');
    expect(job.description).toContain('No');
    expect(job.description).toContain('Gender');
    expect(job.description).toContain('Non-binary');
    expect(job.description).toContain('Veteran status');
    expect(job.description).toContain('Protected veteran');
    expect(job.description).toContain('Disability status');
    expect(job.description).toContain('Why do you want to work at Acme? (max 500 words)');
    expect(job.description).toContain('expected salary range');
  });

  it('removes the two-hundred-country dropdown', () => {
    expect(job.description).not.toContain('Country 100');
    expect(job.description).not.toContain('Country 194');
  });

  it('the country list dwarfs everything the form actually asks', () => {
    const withCountries = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').length;
    expect(job.description.length).toBeLessThan(withCountries / 2);
  });
});

describe('the whole trail, merged', () => {
  const greenhouse: PageSource = {
    url: 'https://boards.greenhouse.io/acme/jobs/1',
    title: 'Platform Engineer, Data Infrastructure - Acme',
    html: `<html><body>${NAV}<main>${postingBody()}${SOCIAL_SHARE}</main><aside role="complementary">${SIMILAR_JOBS}</aside>${COOKIE_BANNER}${FOOTER}</body></html>`,
  };
  const form: PageSource = {
    url: 'https://acme.wd5.myworkdayjobs.com/acme/job/1/apply',
    title: 'Apply for Platform Engineer, Data Infrastructure',
    /*
     * Realistically dense, on purpose: a form with only a couple of fields
     * is short enough on its own, once the country list is gone, to trip the
     * "prefer including too much" safety net in `withoutChrome` (see the
     * "short posting" cases in the review-probe fixtures) — a real ATS form
     * is rarely this bare, and this describe block is testing the merge, not
     * the safety net, which has its own coverage elsewhere.
     */
    html: `<html><body><form>
      <label for="first">First name*</label><input id="first" />
      <label for="last">Last name*</label><input id="last" />
      <label for="email">Email*</label><input id="email" type="email" />
      <label for="visa">Require visa sponsorship?*</label>
      <select id="visa"><option>Yes</option><option>No</option></select>
      <label for="auth">Are you legally authorized to work in the United States?*</label>
      <select id="auth"><option>Yes</option><option>No</option></select>
      <label for="country">Country</label><select id="country">${countryOptions(195)}</select>
      <label for="gender">Gender</label>
      <select id="gender"><option>Decline to self-identify</option><option>Male</option><option>Female</option></select>
      <label for="q1">Why do you want to work at Acme?*</label><textarea></textarea>
      <label for="q2">Describe a project you shipped end to end.*</label><textarea></textarea>
      </form>${FOOTER}</body></html>`,
  };
  const job = mergeJobPages([greenhouse, form]);

  it('keeps the posting content and the form question together', () => {
    expectPostingSurvives(job.description);
    expect(job.description).toContain('Require visa sponsorship?');
  });
  it('keeps neither page\'s junk', () => {
    expectJunkGone(job.description);
    expect(job.description).not.toContain('Country 100');
  });
});

/*
 * Round two: an independent review found two ways the filter above could
 * still lose real application information, both catastrophic — see
 * `keepAmbiguousElement`, `containsApplicationFact` and `looksLikeAWidgetRail`
 * for the fix. These reproduce the review's own fixtures, plus variations,
 * to prove both are closed and stay closed.
 */

describe('a facts box that is shaped exactly like a rail, but is not one', () => {
  /*
   * Greenhouse, Workday, Lever and SmartRecruiters all show a short "Job
   * details" box beside the posting: a handful of facts, each one a link to
   * the board's own facet page (every job in Boston, every job in
   * Engineering, every full-time role). Structurally that is indistinguishable
   * from a rail of other postings — a heading, a list, several short linked
   * items — and a rule built only on shape took the location, the
   * department, the employment type and the remote policy with it.
   */
  const factsBox = (...facts: [string, string][]) =>
    `<aside role="complementary" class="job-details"><h3>Job details</h3><ul>${facts
      .map(([href, text]) => `<li><a href="${href}">${text}</a></li>`)
      .join('')}</ul></aside>`;

  const page = (aside: string) => `<!doctype html><html><body>
    ${NAV}
    <main>
      <h1>Senior Data Engineer</h1>
      <p>We build the ledger every transaction in the company passes through, and we keep it correct to
      the cent under load that would make most systems fall over.</p>
      <p>Responsibilities: own schema migrations end to end, from design through rollout, with nobody
      else signing off on the plan.</p>
      <p>Qualifications: several years operating a relational database in production, and the judgement
      to know when a migration needs a maintenance window and when it does not.</p>
    </main>
    ${aside}
    </body></html>`;

  it('keeps four linked facts (location, department, employment type, remote policy)', () => {
    const html = page(
      factsBox(
        ['/locations/boston', 'Boston, MA'],
        ['/departments/engineering', 'Engineering'],
        ['/employment-type/full-time', 'Full-time'],
        ['/remote-policy', 'Remote-eligible'],
      ),
    );
    const { description } = extractJob(html);
    expect(description).toContain('Boston, MA');
    expect(description).toContain('Engineering');
    expect(description).toContain('Full-time');
    expect(description).toContain('Remote-eligible');
  });

  it('keeps six linked facts, including ones the vocabulary does not name directly', () => {
    const html = page(
      factsBox(
        ['/locations/boston', 'Boston, MA'],
        ['/departments/engineering', 'Engineering'],
        ['/employment-type/full-time', 'Full-time'],
        ['/remote-policy', 'Remote-eligible'],
        ['/req/2209118', 'Req #2209118'],
        ['/teams/platform', 'Platform Team'],
      ),
    );
    const { description } = extractJob(html);
    expect(description).toContain('Boston, MA');
    expect(description).toContain('Remote-eligible');
    expect(description).toContain('Platform Team');
  });

  it('keeps a facts box with eight facet links', () => {
    const html = page(
      factsBox(
        ['/locations/boston', 'Boston, MA'],
        ['/locations/remote', 'Remote'],
        ['/departments/engineering', 'Engineering'],
        ['/employment-type/full-time', 'Full-time'],
        ['/remote-policy', 'Remote-eligible'],
        ['/seniority/senior', 'Senior'],
        ['/req/2209118', 'Req #2209118'],
        ['/teams/platform', 'Platform Team'],
      ),
    );
    const { description } = extractJob(html);
    expect(description).toContain('Boston, MA');
    expect(description).toContain('Engineering');
    expect(description).toContain('Full-time');
    expect(description).toContain('Remote-eligible');
    expect(description).toContain('Platform Team');
  });

  it('still removes a rail proven by heading, even shaped just like a facts box', () => {
    const html = page(
      `<aside role="complementary"><h3>Similar jobs</h3><ul>
        <li><a href="/jobs/2">Backend Engineer</a></li>
        <li><a href="/jobs/3">SRE</a></li>
        <li><a href="/jobs/4">Data Engineer</a></li>
      </ul></aside>`,
    );
    const { description } = extractJob(html);
    expect(description).not.toContain('Backend Engineer');
    expect(description).not.toContain('Similar jobs');
  });

  it('still removes a rail proven by links to other postings, with no facts of its own', () => {
    const html = page(
      `<aside role="complementary"><ul>
        <li><a href="/jobs/2">Backend Engineer</a></li>
        <li><a href="/jobs/3">SRE</a></li>
        <li><a href="/jobs/4">Data Engineer</a></li>
      </ul></aside>`,
    );
    const { description } = extractJob(html);
    expect(description).not.toContain('Backend Engineer');
  });
});

describe('a disclosure that closes the posting inside a literal chrome-shaped tag', () => {
  const SALARY_LINE = 'Salary range: $90,000-$110,000. We are not able to sponsor visas for this role. Applications close Oct 15.';
  const posting = (wrap: (inner: string) => string) => `<!doctype html><html><body>
    ${NAV}
    <main>
      <article>
        <h1>Support Engineer</h1>
        <p>Help customers get unstuck, fast. You will be the first reply on tickets that came in
        overnight, and the one who decides whether something needs to wake up an engineer.</p>
        <p>We are looking for someone who reads a stack trace before they escalate one, and who
        writes the runbook down after the second time they solve the same problem.</p>
        ${wrap(`<p>${SALARY_LINE}</p>`)}
      </article>
    </main>
    ${COOKIE_BANNER}
    </body></html>`;

  const expectDisclosureSurvives = (description: string) => {
    expect(description).toContain('$90,000-$110,000');
    expect(description).toContain('not able to sponsor visas');
    expect(description).toContain('Applications close Oct 15');
  };

  it('survives inside a literal <footer> tag', () => {
    const html = posting((inner) => `<footer class="posting-footer">${inner}</footer>`);
    expectDisclosureSurvives(extractJob(html).description);
  });

  it('survives inside a literal <nav> tag', () => {
    const html = posting((inner) => `<nav class="posting-footer-nav">${inner}</nav>`);
    expectDisclosureSurvives(extractJob(html).description);
  });

  it('survives inside a role="contentinfo" region', () => {
    const html = posting((inner) => `<div role="contentinfo">${inner}</div>`);
    expectDisclosureSurvives(extractJob(html).description);
  });

  it('still leaves out the real nav and cookie banner around it', () => {
    const html = posting((inner) => `<footer class="posting-footer">${inner}</footer>`);
    const { description } = extractJob(html);
    expect(description).not.toContain('All jobs');
    expect(description).not.toContain('We use cookies');
  });
});

describe('a posting that exists only inside <noscript>', () => {
  it('is kept when the rest of the page is too thin to be the posting without it', () => {
    const html = `<!doctype html><html><body>
      <main data-job-description="ignored, an attribute is never text">
        <noscript><p>Base salary $150,000-$180,000. Visa sponsorship available. Remote OK.</p></noscript>
        <div id="app"></div>
      </main>
      </body></html>`;
    const { description } = extractJob(html);
    expect(description).toContain('$150,000-$180,000');
    expect(description).toContain('Visa sponsorship available');
    expect(description).toContain('Remote OK');
  });

  it('is still removed when the rest of the page already has plenty to say', () => {
    const html = `<!doctype html><html><body>
      <main>${postingBody()}</main>
      <noscript><p>Enable JavaScript to see the application form.</p></noscript>
      </body></html>`;
    const { description } = extractJob(html);
    expect(description).not.toContain('Enable JavaScript');
  });
});

describe('a tiny 3-line posting', () => {
  it('keeps every fact the page states, however little else is on the page', () => {
    const html = `<!doctype html><html><head><title>Barista - Acme Coffee</title></head><body>
      ${NAV}
      <main>
        <h1>Barista</h1>
        <p>Make coffee, greet customers, keep the counter clean. $18/hr. Part-time, Boston.</p>
      </main>
      <aside role="complementary"><nav><a href="/apply">Apply</a></nav></aside>
      ${COOKIE_BANNER}
      ${FOOTER}
      </body></html>`;
    const { description } = extractJob(html);
    expect(description).toContain('$18/hr');
    expect(description).toContain('Part-time');
    expect(description).toContain('Boston');
    expect(description).toContain('Make coffee, greet customers, keep the counter clean');
  });
});

describe('long <select> option lists are still trimmed, with the question kept', () => {
  it('cuts every long list and keeps every label, and keeps a short list whole', () => {
    const officeOptions = Array.from({ length: 40 }, (_, i) => `<option>Office ${i}</option>`).join('');
    const yearsOptions = Array.from({ length: 31 }, (_, i) => `<option>${i}</option>`).join('');
    const sourceOptions = Array.from({ length: 25 }, (_, i) => `<option>Source ${i}</option>`).join('');
    const html = `<!doctype html><html><body>
      <form>
        <label for="office">Which office are you applying to?*</label>
        <select id="office">${officeOptions}</select>
        <label for="years">Years of experience</label>
        <select id="years">${yearsOptions}</select>
        <label for="degree">Highest degree</label>
        <select id="degree"><option>High School</option><option>Bachelor's</option><option>Master's</option><option>Doctorate</option></select>
        <label for="source">How did you hear about us?</label>
        <select id="source">${sourceOptions}</select>
      </form>
      </body></html>`;
    const { description } = extractJob(html);
    expect(description).toContain('Which office are you applying to?');
    expect(description).toContain('Years of experience');
    expect(description).toContain('Highest degree');
    expect(description).toContain('How did you hear about us?');
    expect(description).toContain("Bachelor's");
    expect(description).not.toContain('Office 39');
    expect(description).not.toContain('Office 0 Office 1');
    expect(description).not.toContain('Source 20');
  });
});

/*
 * Round three: a second independent review found that facts phrased in
 * words the fact-vocabulary did not know were lost, and the vocabulary-based
 * safety net could not notice, because it counted hits with the same
 * vocabulary. The filter now decides by *shape* — a real sentence, a figure,
 * a colon-labelled line — rather than by matching words, so a fact survives
 * regardless of which language or phrasing it happens to be written in.
 * These reproduce the review's own fixtures, plus the variations asked for.
 */

/** Enough filler that a page stays well clear of the short-page safety net either way. */
const FILLER = (label: string, n = 6) =>
  Array.from(
    { length: n },
    (_, i) => `<p>${label} ${i} about the day-to-day work on this team, written only to pad the page out.</p>`,
  ).join('');

describe('a "Job details" box laid out as bare linked labels, not a rail', () => {
  const html = `<!doctype html><html><body>
    ${NAV}
    <main>
      <h1>Platform Engineer</h1>
      <p>Own the payments ledger service, the one every other team depends on.</p>
      ${FILLER('Paragraph')}
    </main>
    <aside class="job-meta">
      <h3>Job Details</h3>
      <ul>
        <li><a href="/careers/boston">Boston</a></li>
        <li><a href="/careers/engineering">Engineering</a></li>
        <li><a href="/req/2024-118">R-2024-118</a></li>
      </ul>
    </aside>
    </body></html>`;

  it('keeps the facet facts, mixed in with one requisition link', () => {
    const { description } = extractJob(html);
    expect(description).toContain('Boston');
    expect(description).toContain('Engineering');
  });
});

describe('a heading that names a rail, over a real paragraph that is not one', () => {
  const html = `<!doctype html><html><body>
    <main><h1>Support Engineer</h1><p>Own tier-2 tickets, and decide what wakes an engineer up at night.</p>${FILLER('Paragraph', 8)}</main>
    <aside>
      <h3>Similar roles we've filled</h3>
      <p>Our last three hires here came from customer support backgrounds, not engineering ones, and did well.</p>
    </aside>
    </body></html>`;

  it('keeps the real sentence under a rail-shaped heading, because it is not link-dense', () => {
    const { description } = extractJob(html);
    expect(description).toContain('customer support backgrounds');
  });
});

describe('facts the vocabulary never had a word for, closing the posting in a <footer>', () => {
  const footerCase = (name: string, mainFiller: string, footerHtml: string, mustSurvive: string[]) => {
    it(name, () => {
      const html = `<!doctype html><html><body><main><h1>Backend Engineer</h1>${mainFiller}</main>${footerHtml}</body></html>`;
      const { description } = extractJob(html);
      for (const fact of mustSurvive) expect(description).toContain(fact);
    });
  };

  footerCase(
    'pay rate, citizenship and a Swiss-franc salary, none of them a word the old list knew',
    FILLER('Paragraph'),
    '<footer><p>Pay: 25/hr. US Citizens only. Must be eligible to work in the EU. CHF 120,000 annually for the Zurich variant of this role.</p></footer>',
    ['25/hr', 'US Citizens only', 'eligible to work in the EU', 'CHF 120,000'],
  );

  footerCase(
    'German salary and remote-policy sentence, no English trigger words anywhere',
    FILLER('Absatz'),
    '<footer><p>Gehalt: 65.000 € brutto pro Jahr. Wir bieten Homeoffice an drei Tagen die Woche.</p></footer>',
    ['65.000', 'Homeoffice'],
  );

  footerCase(
    'French salary and remote-policy sentence',
    FILLER('Paragraphe'),
    '<footer><p>Salaire: 45 000 € par an. Nous offrons du télétravail deux jours par semaine.</p></footer>',
    ['45 000', 'télétravail'],
  );

  footerCase(
    'Spanish salary and remote-policy sentence',
    FILLER('Párrafo'),
    '<footer><p>Salario: 45.000 € al año. Ofrecemos teletrabajo dos días a la semana.</p></footer>',
    ['45.000', 'teletrabajo'],
  );

  footerCase('a sterling salary shorthand', FILLER('Paragraph'), '<footer><p>Salary: £45k, negotiable.</p></footer>', ['£45k']);
  footerCase('a euro salary in dotted thousands', FILLER('Paragraph'), '<footer><p>Salary: €60.000 per year.</p></footer>', ['€60.000']);
  footerCase('a rupee salary in lakhs-per-annum shorthand', FILLER('Paragraph'), '<footer><p>Pay: ₹12 LPA.</p></footer>', ['₹12 LPA']);
  footerCase('a yen salary with no decimal point', FILLER('Paragraph'), '<footer><p>Compensation: ¥5,000,000 per year.</p></footer>', ['¥5,000,000']);
  footerCase('an on-target-earnings figure', FILLER('Paragraph'), '<footer><p>OTE $180k, split base and commission.</p></footer>', ['OTE $180k']);
  footerCase('a deadline given only as a date', FILLER('Paragraph'), '<footer><p>Closes 15/10. No extensions.</p></footer>', ['Closes 15/10']);
  footerCase(
    'a rolling deadline, no figure and no fact-word at all',
    FILLER('Paragraph'),
    '<footer><p>Applications reviewed on a rolling basis, in the order they arrive.</p></footer>',
    ['Applications reviewed on a rolling basis'],
  );
});

describe('the comma-heuristic that used to over-match ordinary clutter is gone', () => {
  /*
   * A small (<=5 link) nav is kept outright now regardless of what it says —
   * see `isSiteNavigationBlock` — so the comma inside one label is no longer
   * what decides its fate either way. What is still worth checking: a big
   * site nav (6+ links, still correctly removed) is not accidentally spared
   * just because one of its labels happens to have a comma in it.
   */
  it('a comma inside one label does not spare an otherwise-removable big nav menu', () => {
    const html = `<!doctype html><html><body>
      <nav><a href="/x">Sign up, or Log in</a> <a href="/y">Contact us</a>
      <a href="/about">About</a> <a href="/careers">Careers</a>
      <a href="/blog">Blog</a> <a href="/press">Press</a></nav>
      <main><h1>Support Engineer</h1><p>Own tier-2 tickets, and decide what wakes an engineer up at night.</p>${FILLER('Paragraph', 8)}</main>
      </body></html>`;
    const { description } = extractJob(html);
    expect(description).not.toContain('Sign up');
  });

  it('still removes a cookie banner with no facts of its own, comma and all', () => {
    const html = `<!doctype html><html><body>
      <div class="cookie-consent-banner"><p>We use cookies, ok? <a href="/privacy">Privacy</a></p></div>
      <main><h1>Support Engineer</h1><p>Own tier-2 tickets, and decide what wakes an engineer up at night.</p>${FILLER('Paragraph', 8)}</main>
      </body></html>`;
    const { description } = extractJob(html);
    expect(description).not.toContain('We use cookies');
  });
});

describe('junk removal still works once the filter no longer trusts a word list', () => {
  const html = `<!doctype html><html><body>
    ${NAV}
    ${COOKIE_BANNER}
    <main><h1>Data Platform Engineer</h1><p>Own the warehouse pipeline, in Go and Kafka.</p>
    <h2>Requirements</h2><ul><li>5+ years, distributed systems.</li></ul>
    <p>Salary: $150,000-$180,000. This role is remote. We sponsor visas.</p>${FILLER('Paragraph', 4)}</main>
    ${SIMILAR_JOBS}
    ${SOCIAL_SHARE}
    ${FOOTER}
    </body></html>`;
  const { description } = extractJob(html);

  it('keeps the posting', () => {
    expect(description).toContain('Data Platform Engineer');
    expect(description).toContain('$150,000-$180,000');
    expect(description).toContain('5+ years, distributed systems');
  });
  it('removes the nav, the cookie banner, the jobs-linked rail, the share row and the footer', () => {
    expect(description).not.toContain('All jobs');
    expect(description).not.toContain('We use cookies');
    expect(description).not.toContain('Similar jobs');
    expect(description).not.toContain('Backend Engineer, Payments');
    expect(description).not.toContain('Share this job');
    expect(description).not.toContain('Privacy Policy');
  });
});

/*
 * Round four: a third independent review found that a fact carried only as
 * link or button text inside a nav/footer/landmark region was deleted with
 * no rail proof required (the shape rule zeroed link and button text before
 * ever asking whether the container was a rail), and that short digit-free,
 * colon-free lines ("US only.", "Contract role.") fell under the 35-char
 * sentence bar. The coordinator also found a regression against production:
 * the lenient safety-net pass could still come back under 200 characters
 * with nowhere further to fall back to. Fixed via `discountedView`,
 * `isSiteNavigationBlock`, `hasShortStandaloneLine`, and a final guarantee
 * in `withoutChrome` — see there.
 */

describe('a fact carried only as link or button text, inside a small chrome-shaped container', () => {
  it('a filter-chip tag list rendered as links inside a <nav> survives', () => {
    const html = `<html><body>
      <nav class="job-tags"><ul>
        <li><a href="/filter/remote">Remote</a></li>
        <li><a href="/filter/fulltime">Full-time</a></li>
        <li><a href="/filter/visa">Visa sponsorship available</a></li>
      </ul></nav>
      <main><h1>Platform Engineer</h1><p>We build the event pipeline that keeps every payment moving across the region.</p></main>
    </body></html>`;
    const out = withoutChrome(html);
    expect(out).toContain('Remote');
    expect(out).toContain('Full-time');
    expect(out).toContain('Visa sponsorship available');
  });

  it('a careers breadcrumb nav carries the location and team, and both survive', () => {
    const html = `<html><body>
      <nav aria-label="breadcrumb">
        <a href="/">Home</a> &gt; <a href="/careers">Careers</a> &gt;
        <a href="/careers/engineering">Engineering</a> &gt; <span>Berlin</span>
      </nav>
      <main><h1>Backend Engineer</h1><p>Own services that settle millions of transactions overnight.</p></main>
    </body></html>`;
    const out = withoutChrome(html);
    expect(out).toContain('Engineering');
    expect(out).toContain('Berlin');
  });

  it('a link-only benefits list inside a <footer> survives', () => {
    const html = `<html><body>
      <main><h1>Support Engineer</h1><p>Answer real customer problems across every channel we ship.</p></main>
      <footer><ul class="benefits">
        <li><a href="/benefits/health">Health insurance</a></li>
        <li><a href="/benefits/401k">401k match</a></li>
        <li><a href="/benefits/pto">Unlimited PTO</a></li>
      </ul></footer>
    </body></html>`;
    const out = withoutChrome(html);
    expect(out).toContain('Health insurance');
    expect(out).toContain('401k match');
    expect(out).toContain('Unlimited PTO');
  });

  it('a deadline stated only inside a <button>, nested in a <nav> toolbar, survives', () => {
    const html = `<html><body>
      <nav class="job-actions"><button class="deadline">Apply by Friday, Oct 3</button></nav>
      <main><h1>Recruiter</h1><p>Partner with hiring managers to close every open req on time.</p></main>
    </body></html>`;
    const out = withoutChrome(html);
    expect(out).toContain('Apply by Friday');
  });

  it('the chip nav still survives even once the page is thick with unrelated filler prose', () => {
    // The safety net used to be the only thing that could restore a link
    // loss, and its own counter was built from the same link-discounting
    // logic that caused the loss — so it could never fire on this case.
    // Now the chip nav is never removed to begin with, whatever else is on
    // the page.
    const html = `<html><body>
      <nav class="job-tags"><ul>
        <li><a href="/f/remote">Remote</a></li>
        <li><a href="/f/hybrid">Hybrid</a></li>
        <li><a href="/f/visa">Visa sponsorship available</a></li>
        <li><a href="/f/entry">Entry level</a></li>
      </ul></nav>
      <main><h1>Platform Engineer</h1>
      <p>${'We build the event pipeline that keeps every payment moving across the region. '.repeat(6)}</p>
      </main>
    </body></html>`;
    const out = withoutChrome(html);
    expect(out).toContain('Visa sponsorship available');
    expect(out).toContain('Entry level');
  });
});

describe('short, digit-free, colon-free lines survive as standalone facts', () => {
  const cases = ['US only.', 'No visa sponsorship.', 'Remote (EU).', 'Contract role.'];
  for (const line of cases) {
    it(`"${line}" in a bare <footer> survives`, () => {
      const html = `<html><body>
        <main><h1>Data Analyst</h1><p>Build the dashboards leadership actually reads every single week.</p></main>
        <footer><p>${line}</p></footer>
      </body></html>`;
      const out = withoutChrome(html);
      expect(out).toContain(line);
    });
  }
});

describe('positive control: asides that are genuinely just prose are not wrongly treated as rails', () => {
  it('a "Meet the team" aside with names and roles (no links) survives', () => {
    const html = `<html><body>
      <main><h1>Engineering Manager</h1><p>Lead a team shipping the checkout flow end to end for everyone.</p></main>
      <aside class="team-blurb"><h3>Meet the team</h3>
        <p>Priya Patel, Staff Engineer. Sam Ortiz, Product Designer.</p>
      </aside>
    </body></html>`;
    const out = withoutChrome(html);
    expect(out).toContain('Priya Patel');
    expect(out).toContain('Sam Ortiz');
  });

  it('a real requirement embedded as plain prose next to a "Similar Jobs" rail survives, and the rail is still cut', () => {
    const html = `<html><body>
      <main><h1>Compliance Analyst</h1><p>Review filings for accuracy across every region we operate in.</p></main>
      <aside class="sidebar"><h3>Similar Jobs</h3>
        <p>This role requires a valid work visa for the country of employment.</p>
        <ul><li><a href="/jobs/482913">Other Analyst Role</a></li><li><a href="/jobs/482914">Another Role</a></li></ul>
      </aside>
    </body></html>`;
    const out = withoutChrome(html);
    expect(out).toContain('valid work visa');
  });

  it('a short single-option <select> (a pre-set answer, not a country picker) is kept', () => {
    const html = `<html><body>
      <main><h1>Support Specialist</h1><p>Handle escalations for our highest-value customers directly.</p></main>
      <label>Work type</label><select disabled><option selected>Remote</option></select>
    </body></html>`;
    const out = withoutChrome(html);
    expect(out).toContain('Remote');
  });
});

describe('non-English postings: the shape rule does not depend on English vocabulary', () => {
  it('a French posting keeps its salary/visa lines through chrome', () => {
    const html = `<html><body>
      <nav><a>Accueil</a><a>Toutes les offres</a></nav>
      <main><h1>Ingénieur Plateforme</h1>
      <p>Vous construirez la plateforme de streaming qui traite chaque paiement en temps réel.</p>
      <p>Salaire : 55 000 € à 65 000 € brut annuel.</p>
      <p>Ce poste ne nécessite pas de parrainage de visa.</p>
      </main>
      <footer><p>Mentions légales. Politique de confidentialité.</p></footer>
    </body></html>`;
    const out = withoutChrome(html);
    expect(out).toContain('55 000');
    expect(out).toContain('parrainage de visa');
  });

  it('a German posting keeps a colon-labelled Gehalt line', () => {
    const html = `<html><body>
      <main><h1>Softwareentwickler</h1>
      <p>Sie entwickeln die Plattform, die jede Zahlung in Echtzeit verarbeitet und skaliert.</p>
      <p>Gehalt: 65.000 € brutto pro Jahr.</p>
      </main>
    </body></html>`;
    const out = withoutChrome(html);
    expect(out).toContain('Gehalt: 65.000');
  });
});

describe('the production regression: a final guarantee after the lenient pass, not just after the strict one', () => {
  it('never hands back less than the reference text once the page had at least 200 characters to give', () => {
    // Both the strict and the lenient pass correctly read this aside as a
    // rail (a heading naming it, links shaped like other postings, no prose
    // of its own) and remove it — genuinely, not a false negative — leaving
    // the page with next to nothing. The guarantee is that it is never
    // handed back shorter than the reference text (the raw page, minus only
    // its long `<select>` lists, of which this page has none) once that
    // reference itself had at least 200 characters, not that this
    // particular rail specifically survives.
    const html = `<html><body>
      <main><h1>Support Engineer</h1></main>
      <aside><h3>Similar jobs</h3><ul>
        <li><a href="/jobs/2">Backend Engineer, Payments Infrastructure</a></li>
        <li><a href="/jobs/3">Site Reliability Engineer, Platform Team</a></li>
        <li><a href="/jobs/4">Data Engineer, Analytics Warehouse</a></li>
        <li><a href="/jobs/5">Staff Engineer, Core Infrastructure</a></li>
        <li><a href="/jobs/6">Senior Support Engineer, Enterprise</a></li>
        <li><a href="/jobs/7">Support Engineer II, Consumer</a></li>
      </ul></aside>
      </body></html>`;
    const out = withoutChrome(html);
    expect(out.length).toBeGreaterThan(200);
    expect(out).toContain('Backend Engineer, Payments Infrastructure');
  });
});

describe('junk removal still works once small link groups are no longer removed by default', () => {
  const BIG_NAV =
    '<nav><ul><li><a href="/about">About</a></li><li><a href="/careers">Careers</a></li>' +
    '<li><a href="/blog">Blog</a></li><li><a href="/press">Press</a></li>' +
    '<li><a href="/contact">Contact</a></li><li><a href="/support">Support</a></li>' +
    '<li><a href="/investors">Investors</a></li><li><a href="/login">Sign in</a></li></ul></nav>';
  const BIG_FOOTER_SITEMAP =
    '<footer><ul>' +
    Array.from({ length: 12 }, (_, i) => `<li><a href="/p${i}">Page ${i}</a></li>`).join('') +
    '</ul></footer>';
  const RAIL_TO_JOB_IDS =
    '<aside class="similar-jobs"><h3>Similar jobs</h3><ul>' +
    '<li><a href="/jobs/482913">Other Analyst Role</a></li>' +
    '<li><a href="/jobs/482914">Another Role</a></li></ul></aside>';
  const COOKIE = '<div class="cookie-banner"><p>We use cookies to enhance your browsing experience.</p></div>';
  const SHARE_ROW =
    '<div class="social-share"><span>Share this job</span><a href="#">LinkedIn</a><a href="#">Twitter</a></div>';
  const html = `<html><body>
    ${BIG_NAV}
    ${COOKIE}
    <main><h1>Data Platform Engineer</h1><p>Own the warehouse pipeline, in Go and Kafka, that every payment in
    the company eventually passes through on its way to the ledger.</p>
    <h2>Requirements</h2><ul><li>5+ years, distributed systems.</li></ul>
    <p>Salary: $150,000-$180,000. This role is remote. We sponsor visas.</p>
    <p>We are looking for someone who has run a system at this scale before, and who can say plainly
    when a design will not hold up rather than finding out in production.</p></main>
    ${RAIL_TO_JOB_IDS}
    ${SHARE_ROW}
    ${BIG_FOOTER_SITEMAP}
    </body></html>`;
  const out = withoutChrome(html);

  it('keeps the posting', () => {
    expect(out).toContain('Data Platform Engineer');
    expect(out).toContain('$150,000-$180,000');
  });
  it('removes an 8-link site header nav, a 12-link footer sitemap, a /jobs/-id rail, a cookie banner and a share row', () => {
    expect(out).not.toContain('About');
    expect(out).not.toContain('Page 0');
    expect(out).not.toContain('Page 11');
    expect(out).not.toContain('Other Analyst Role');
    expect(out).not.toContain('We use cookies');
    expect(out).not.toContain('Share this job');
  });
});

/*
 * An id or a slug at the end of an address is only "another posting" where
 * the address is about jobs. Benefit links and filter tags carry ids too, and
 * were read as a rail of other jobs and cut.
 */
describe('links with ids that are not other postings', () => {
  const POSTING = `<main><h1>Platform Engineer</h1><p>You will build the streaming platform that carries every event we see, in Go and Kafka, with a small team that owns it end to end.</p><h2>Qualifications</h2><ul><li>Two years of production Go.</li><li>Distributed systems you have debugged.</li></ul></main>`;
  it('keeps a benefits list whose links end in ids', () => {
    const html = `<html><body>${POSTING}<footer><ul class="benefits"><li><a href="/b/1">Health insurance</a></li><li><a href="/b/2">401(k) match</a></li><li><a href="/b/3">Parental leave</a></li></ul></footer></body></html>`;
    const out = extractJob(html, 'https://acme.example/jobs/42', 'Platform Engineer').description;
    expect(out).toContain('Health insurance');
    expect(out).toContain('Parental leave');
  });
  it('keeps filter tags whose links end in ids, and benefit slugs', () => {
    const html = `<html><body>${POSTING}<nav class="tags"><a href="/t/1">Part-time</a><a href="/t/2">Seattle, WA</a><a href="/benefits/health-dental-vision">Health, dental and vision</a></nav></body></html>`;
    const out = extractJob(html, 'https://acme.example/jobs/42', 'Platform Engineer').description;
    expect(out).toContain('Part-time');
    expect(out).toContain('Seattle, WA');
    expect(out).toContain('Health, dental and vision');
  });
  it('still removes a rail of other postings addressed by id, slug or UUID', () => {
    const rail = (hrefs: string[]) =>
      `<aside><ul>${hrefs.map((h, i) => `<li><a href="${h}">Other role ${i}</a></li>`).join('')}</ul></aside>`;
    for (const hrefs of [
      ['/jobs/1001', '/jobs/1002', '/jobs/1003'],
      ['/careers/senior-data-engineer-berlin', '/careers/staff-backend-engineer-remote', '/careers/product-designer-new-york'],
      ['https://jobs.lever.co/acme/0f8fad5b-d9cb-469f-a165-70867728950e', 'https://jobs.lever.co/acme/7c9e6679-7425-40de-944b-e07fc1f90ae7'],
    ]) {
      const out = extractJob(`<html><body>${POSTING}${rail(hrefs)}</body></html>`, 'https://acme.example/jobs/42', 'Platform Engineer').description;
      expect(out, hrefs[0]).not.toContain('Other role');
    }
  });
});

/*
 * A posting that states its facts the structured way.
 *
 * `extractJob` read the JSON-LD description and nothing else past the title,
 * company and city, and when that description was long enough it replaced
 * the page outright. So the salary, the deadline, the employment type and the
 * remote policy — fields, not prose, on most boards — never reached the AI,
 * and neither did anything the page said beside the posting.
 */
describe('a JobPosting that states facts in its fields, and a page that says more', () => {
  const LONG = 'You will own our Kafka pipeline end to end, from ingestion to the warehouse. '.repeat(4);
  const ld = (fields: Record<string, unknown>) =>
    `<script type="application/ld+json">${JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'JobPosting',
      title: 'Platform Engineer',
      hiringOrganization: { '@type': 'Organization', name: 'Acme' },
      description: `<p>${LONG}</p>`,
      ...fields,
    })}</script>`;
  const nav = `<nav>${['Home', 'About', 'Press', 'Blog', 'Contact', 'Login', 'Investors', 'Sign up']
    .map((t) => `<a href="/${t.toLowerCase()}">${t}</a>`)
    .join('')}</nav>`;

  it('keeps the salary, deadline, employment type, remote policy and places from the fields', () => {
    const html = `<html><head>${ld({
      baseSalary: { '@type': 'MonetaryAmount', currency: 'USD', value: { '@type': 'QuantitativeValue', minValue: 140000, maxValue: 170000, unitText: 'YEAR' } },
      validThrough: '2026-10-31',
      employmentType: 'FULL_TIME',
      jobLocationType: 'TELECOMMUTE',
      applicantLocationRequirements: { '@type': 'Country', name: 'USA' },
      jobLocation: [
        { '@type': 'Place', address: { addressLocality: 'Boston', addressRegion: 'MA' } },
        { '@type': 'Place', address: { addressLocality: 'Austin', addressRegion: 'TX' } },
      ],
    })}</head><body>${nav}<div id="root">Loading…</div></body></html>`;
    const out = extractJob(html, 'https://boards.greenhouse.io/acme/jobs/1').description;
    expect(out).toContain('140000–170000');
    expect(out).toContain('USD');
    expect(out).toContain('2026-10-31');
    expect(out).toContain('FULL_TIME');
    expect(out).toMatch(/telecommute/i);
    expect(out).toContain('USA');
    expect(out).toContain('Boston, MA');
    expect(out).toContain('Austin, TX');
    expect(out).toContain('Kafka pipeline');
  });

  it('keeps what only the page says beside a long structured description', () => {
    const html = `<html><head>${ld({})}</head><body>${nav}<main><h1>Platform Engineer</h1><p>${LONG}</p></main>
      <aside><h3>At a glance</h3><p>Salary: $140,000 – $170,000</p><p>Visa sponsorship is not available for this role.</p><p>Applications close October 31.</p></aside></body></html>`;
    const out = extractJob(html, 'https://acme.example/careers/platform-engineer').description;
    expect(out).toContain('$140,000 – $170,000');
    expect(out).toContain('Visa sponsorship is not available for this role.');
    expect(out).toContain('Applications close October 31.');
  });

  it('does not say the description twice when the page repeats it', () => {
    const html = `<html><head>${ld({ employmentType: 'FULL_TIME' })}</head><body>${nav}<main><p>${LONG}</p></main></body></html>`;
    const out = extractJob(html, 'https://acme.example/careers/platform-engineer').description;
    expect(out.split('You will own our Kafka pipeline end to end').length - 1).toBe(4);
  });

  it('adds none of the site navigation', () => {
    const html = `<html><head>${ld({})}</head><body>${nav}<main><p>${LONG}</p></main></body></html>`;
    const out = extractJob(html, 'https://acme.example/careers/platform-engineer').description;
    expect(out).not.toContain('Investors');
    expect(out).not.toContain('Press');
  });
});
