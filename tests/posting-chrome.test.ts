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

const PAGE = `<!doctype html><html><head><title>Platform Engineer — Acme</title></head><body>
  <nav><ul><li><a>Home</a></li><li><a>All jobs</a></li><li><a>Teams</a></li></ul></nav>
  <div role="navigation"><div><a>Engineering blog</a></div><div><div><a>Our values</a></div></div></div>
  <header role="banner"><a>Acme careers</a></header>
  <label>Filter by location</label><select>${CITIES}</select>
  <main>${POSTING}</main>
  <aside><h3>Similar jobs</h3><ul><li>Data Scientist</li><li>Sales Engineer</li></ul></aside>
  <div id="onetrust-consent-sdk"><div class="banner"><p>We use cookies to improve your experience.</p></div></div>
  <footer><div><p>Copyright Acme Corporation. Privacy policy. Terms of use.</p></div></footer>
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
    expect(description).not.toContain('Copyright Acme');
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
    const page = `<div role="navigation"><div>Menu</div><div>More menu</div></div><div>${POSTING}</div>`;
    const out = withoutChrome(page);
    expect(out).not.toContain('More menu');
    expect(out).toContain('streaming platform');
  });
});
