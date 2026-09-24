import { describe, expect, it } from 'vitest';
import { extractJob, withoutChrome } from '../src/jobs/extract.js';

/*
 * What of a page is the posting, when the page is all there is to go on.
 *
 * With no usable JSON-LD, a posting's description is the page's text — and the
 * page's text was the posting plus the site around it: the navigation, the
 * footer, a sidebar of other jobs, a cookie banner, and every option of every
 * dropdown. All of it went to the AI as though it were the job.
 */

const POSTING = `
  <h1>Platform Engineer</h1>
  <p>You will build the streaming platform that carries every event we see, in Go and Kafka.</p>
  <h2>Responsibilities</h2>
  <ul><li>Own the ingestion path end to end.</li><li>Keep p99 latency under a second.</li></ul>
  <h2>Qualifications</h2>
  <ul><li>Two years of production Go.</li><li>Distributed systems you have debugged at 3am.</li></ul>`;

const CITIES = Array.from({ length: 200 }, (_, i) => `<option>City number ${i}</option>`).join('');

/*
 * Six or more links, throughout — a small link group (chips, a breadcrumb, a
 * couple of nav items) is kept outright now unless it proves itself a rail
 * or a big site-navigation block (see `isSiteNavigationBlock`), so what
 * these fixtures test for — a nav, a `role="navigation"`/`"banner"` region
 * and a footer sitemap all being removed — needs a realistic number of links
 * in each, the way an actual site header or footer carries.
 */
const PAGE = `<!doctype html><html><head><title>Platform Engineer — Acme</title></head><body>
  <nav><ul><li><a>Home</a></li><li><a>All jobs</a></li><li><a>Teams</a></li>
    <li><a>Press</a></li><li><a>Investors</a></li><li><a>Contact</a></li></ul></nav>
  <div role="navigation"><div><a>Engineering blog</a></div><div><div><a>Our values</a></div></div>
    <div><a>Press</a></div><div><a>Investors</a></div><div><a>Contact</a></div><div><a>Support</a></div></div>
  <header role="banner"><a>Acme careers</a><a>About</a><a>Blog</a><a>Press</a><a>Contact</a><a>Support</a></header>
  <label>Filter by location</label><select>${CITIES}</select>
  <main>${POSTING}</main>
  <aside><h3>Similar jobs</h3><ul><li><a href="/jobs/41">Data Scientist</a></li><li><a href="/jobs/42">Sales Engineer</a></li></ul></aside>
  <div id="onetrust-consent-sdk"><div class="banner"><p>We use cookies to improve your experience.</p></div></div>
  <footer><div><ul><li><a href="/privacy">Privacy policy</a></li><li><a href="/terms">Terms of use</a></li>
    <li><a href="/careers">Careers</a></li><li><a href="/press">Press</a></li>
    <li><a href="/contact">Contact us</a></li><li><a href="/security">Security</a></li></ul></div></footer>
</body></html>`;

describe('the site around a posting is not the posting', () => {
  const { description } = extractJob(PAGE, 'https://acme.example/jobs/1', 'Platform Engineer — Acme');

  it('keeps every part of the posting', () => {
    expect(description).toContain('streaming platform that carries every event');
    expect(description).toContain('Own the ingestion path end to end.');
    expect(description).toContain('Distributed systems you have debugged at 3am.');
  });

  it('leaves out the navigation, in a nav or marked by its role', () => {
    expect(description).not.toContain('All jobs');
    // Nested two deep inside the role="navigation" div: cut at its real end.
    expect(description).not.toContain('Our values');
    expect(description).not.toContain('Acme careers');
  });

  it('leaves out every option of a dropdown', () => {
    expect(description).not.toContain('City number');
  });

  it('leaves out the sidebar, the cookie banner and the footer', () => {
    expect(description).not.toContain('Similar jobs');
    expect(description).not.toContain('We use cookies');
    expect(description).not.toContain('Privacy policy');
  });

  /*
   * The point of it, measured: the 200-city filter alone is several times the
   * length of the posting it sat beside.
   */
  it('is a fraction of what it was', () => {
    const untrimmed = PAGE.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').length;
    expect(description.length).toBeLessThan(untrimmed / 4);
  });
});

describe('never at the cost of the posting', () => {
  /*
   * A layout that puts the posting in an <aside>, or a board whose whole page
   * sits inside one landmark, would lose the posting with the chrome. A long
   * description is a cost; a missing one is a failure.
   */
  it('keeps a page whose posting is inside something that looks like chrome', () => {
    const body = `<p>${'The role is building Kafka pipelines for the payments team. '.repeat(30)}</p>`;
    const page = `<html><body><nav><a>Home</a></nav><aside>${body}</aside></body></html>`;
    expect(extractJob(page).description).toContain('building Kafka pipelines for the payments team');
  });

  /*
   * With enough of the posting before it that the fallback above stays out of
   * the way — otherwise that fallback hides whether this rule works at all.
   */
  it('leaves an element that never closes rather than cutting to the end of the page', () => {
    const page = `<html><body><main>${POSTING}</main><nav><a>Home</a><h2>Benefits</h2><p>Health, dental, and a bicycle.</p></body></html>`;
    const out = withoutChrome(page);
    expect(out).toContain('streaming platform');
    expect(out).toContain('Health, dental, and a bicycle.');
  });

  it('cuts nested elements of the same tag at their own end, not the first close it meets', () => {
    // Six links, so this is unambiguously a site-navigation block and not a
    // small kept link group (see `isSiteNavigationBlock`) — the nesting is
    // still what this test is actually about: if the real end of the outer
    // `role="navigation"` div were found wrongly, "More menu" would leak out
    // as its own top-level, unremoved fragment.
    const page =
      `<div role="navigation"><div><a href="/a">Menu</a></div><div><a href="/b">More menu</a></div>` +
      `<div><a href="/c">Even more</a></div><div><a href="/d">Careers</a></div>` +
      `<div><a href="/e">Blog</a></div><div><a href="/f">Contact</a></div></div><div>${POSTING}</div>`;
    const out = withoutChrome(page);
    expect(out).not.toContain('More menu');
    expect(out).toContain('streaming platform');
  });
});
