// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { makeTempStore } from './helpers.ts';

vi.mock('../web/preview.js', () => ({ createPreview: () => ({ show: async () => {} }) }));
vi.mock('../web/assets.js', () => ({
  setupAssets: () => ({
    init: async () => {
      for (const b of document.querySelectorAll('#tabs button')) b.disabled = false;
      return { current: '/test-save' };
    },
    load: async () => {},
  }),
}));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/*
 * The tracker in the order the stages matter.
 *
 * Sorted by date alone, the application you are halfway through filling in
 * sits wherever its start date puts it — after a busy week, below a screenful
 * of jobs that are sent, closed, or were never started. The tracker is opened
 * to ask "what needs me"; a list in date order answers "what happened
 * recently" instead.
 */
const app = (over) => ({
  role: 'Platform Engineer',
  status: 'applied',
  appliedAt: '2026-05-01T09:00:00Z',
  ...over,
});

/*
 * Dates chosen against the grouping on purpose: the stages that must come
 * first carry the *oldest* rows, so nothing here can pass by date order.
 */
const OLD = '2026-01-01T09:00:00Z';
const MID = '2026-05-01T09:00:00Z';
const NEW = '2026-08-01T09:00:00Z';

const APPS = [
  app({ id: 'a', company: 'AppliedCo', status: 'applied', appliedAt: NEW }),
  app({ id: 'b', company: 'ClosedCo', status: 'closed', appliedAt: NEW }),
  app({ id: 'c', company: 'ApplyingCo', status: 'applying', appliedAt: OLD }),
  app({ id: 'd', company: 'NotStartedCo', status: 'interested', appliedAt: NEW }),
  app({ id: 'e', company: 'OfferCo', status: 'offer', appliedAt: MID }),
  app({ id: 'f', company: 'InterviewCo', status: 'interview', appliedAt: OLD }),
];

async function draw(applications) {
  vi.resetModules();
  document.documentElement.innerHTML = fs.readFileSync('web/index.html', 'utf8');
  window.location.hash = '#applications';

  const fixture = makeTempStore();
  const data = fixture.store.load();
  fixture.cleanup();

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url) => {
      let result = {};
      if (url === '/api/store') result = data;
      else if (url === '/api/ai/jobs') result = { jobs: [] };
      else if (url === '/api/applications') {
        result = {
          applications,
          stats: { total: applications.length, last7: 0, last30: 0, responseRate: 0 },
          current: { dir: '/tmp/current', files: [], applications: 0, inFlight: 0 },
        };
      }
      return { ok: true, json: async () => structuredClone(result) };
    }),
  );

  await import('../web/app.js');
  await vi.waitFor(() => expect(document.querySelector('#apps-wrap tbody tr')).not.toBeNull());
}

/** Every row in order, each one either a heading or a company name. */
function readOut() {
  return [...document.querySelectorAll('#apps-wrap tbody tr')].map((tr) =>
    tr.classList.contains('group') ? `— ${tr.querySelector('b')?.textContent} —` : tr.children[1]?.textContent,
  );
}

describe('the tracker is ordered by what needs the reader', () => {
  it('puts the stages in the order they matter, not the order they happen', async () => {
    await draw(APPS);

    expect(readOut()).toEqual([
      '— Interviewing —',
      'InterviewCo',
      '— Applying —',
      'ApplyingCo',
      '— Got it! —',
      'OfferCo',
      '— Applied —',
      'AppliedCo',
      '— Not applied —',
      'NotStartedCo',
      '— Closed —',
      'ClosedCo',
    ]);
  });

  /*
   * The two that must lead are the two oldest rows in the fixture, so this is
   * the same fact as the check above said a different way: an ordering that
   * fell back to dates would put AppliedCo and ClosedCo on top.
   */
  it('does not fall back to date order', async () => {
    await draw(APPS);
    const out = readOut().filter((r) => !r.startsWith('—'));

    expect(out.slice(0, 2)).toEqual(['InterviewCo', 'ApplyingCo']);
    expect(out.indexOf('AppliedCo')).toBeGreaterThan(out.indexOf('OfferCo'));
  });

  it('keeps each stage in date order within itself', async () => {
    await draw([
      app({ id: 'x', company: 'Older', status: 'applying', appliedAt: OLD }),
      app({ id: 'y', company: 'Newer', status: 'applying', appliedAt: NEW }),
      app({ id: 'z', company: 'Middle', status: 'applying', appliedAt: MID }),
    ]);

    // One stage only, so no headings — see below.
    expect(readOut()).toEqual(['Newer', 'Middle', 'Older']);
  });

  it('counts each stage beside its name', async () => {
    await draw([
      app({ id: 'x', company: 'One', status: 'applying' }),
      app({ id: 'y', company: 'Two', status: 'applying' }),
      app({ id: 'z', company: 'Three', status: 'applied' }),
    ]);

    const counts = [...document.querySelectorAll('#apps-wrap tbody tr.group .group-count')].map((s) => s.textContent);
    expect(counts).toEqual(['2 applications', '1 application']);
  });

  /*
   * A single heading over the whole list repeats what the status filter
   * already says, and on a tracker where everything is at one stage it is
   * furniture.
   */
  it('says nothing when there is only one stage on screen', async () => {
    await draw([
      app({ id: 'x', company: 'Helios', status: 'applying' }),
      app({ id: 'y', company: 'Altair', status: 'applying' }),
    ]);

    expect(document.querySelectorAll('#apps-wrap tbody tr.group')).toHaveLength(0);
    expect(readOut()).toEqual(['Helios', 'Altair']);
  });

  /*
   * `applications.yaml` is hand-editable, so a status this does not know
   * about is a thing that happens. Dropping such a row would hide an
   * application; putting it last is merely untidy.
   */
  it('shows a stage it has never heard of rather than losing it', async () => {
    await draw([
      app({ id: 'x', company: 'Known', status: 'applying' }),
      app({ id: 'y', company: 'Strange', status: 'ghosted' }),
    ]);

    const out = readOut();
    expect(out).toContain('Strange');
    expect(out.indexOf('Strange')).toBeGreaterThan(out.indexOf('Known'));
  });

  /*
   * The heading is not a row you can open, and the table's rows are. Leaving
   * it clickable means a click on the divider opens whichever application the
   * event happens to reach — the kind of thing nobody reports and everybody
   * notices.
   */
  it('does not make a heading look like something you can open', async () => {
    await draw(APPS);
    const heading = document.querySelector('#apps-wrap tbody tr.group');

    expect(heading.onclick).toBeFalsy();
    // It spans the table rather than pushing the columns about.
    expect(heading.querySelector('td').colSpan).toBe(7);
  });

  /*
   * Filtering narrows the table, and the grouping has to follow it down: a
   * filter that leaves one stage must not leave headings standing over it.
   */
  it('regroups what a filter leaves behind', async () => {
    await draw(APPS);

    const filter = document.querySelector('#app-status');
    filter.value = 'applied';
    filter.dispatchEvent(new Event('change', { bubbles: true }));

    await vi.waitFor(() => expect(readOut()).toEqual(['AppliedCo']));
    expect(document.querySelectorAll('#apps-wrap tbody tr.group')).toHaveLength(0);
  });
});

/*
 * The Sent column, for a row the tracker closed itself.
 *
 * `closeStaleApplying` closes an application left at Applying for a fortnight
 * with nothing sent, and says so in the note it writes. `sentOn` falls back to
 * the day a row was started for anything closed — right for a row from before
 * the history was kept, and for a close somebody chose — so a stale close read
 * as sent on the day it was begun. The server stopped counting these as sent
 * (`alreadySent`, the response rate); the column beside them still did.
 */
describe('the Sent column', () => {
  const sentFor = (company) =>
    [...document.querySelectorAll('#apps-wrap tbody tr')].find((tr) => tr.children[1]?.textContent === company)
      ?.children[4]?.textContent;

  it('is blank for one the tracker closed for sitting at Applying, and dated for one closed by hand', async () => {
    await draw([
      app({
        id: 's',
        company: 'StaleCo',
        status: 'closed',
        appliedAt: OLD,
        history: [
          { at: OLD, status: 'applying', note: 'Workspace opened' },
          { at: MID, status: 'closed', note: 'Closed on its own: at Applying for 14 days with nothing sent' },
        ],
      }),
      app({ id: 't', company: 'TurnedCo', status: 'closed', appliedAt: OLD, history: [{ at: OLD, status: 'closed', note: 'Rejected' }] }),
      app({ id: 'o', company: 'OldCo', status: 'closed', appliedAt: OLD }),
    ]);

    expect(sentFor('StaleCo')).toBe('');
    expect(sentFor('TurnedCo')).toBe('2026-01-01');
    expect(sentFor('OldCo')).toBe('2026-01-01');
  });
});
