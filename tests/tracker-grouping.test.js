// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
 * What is still moving, and what is only a record.
 *
 * Sorted by date alone, the application you are halfway through filling in
 * sits wherever its start date puts it — which after a busy week is below a
 * screenful of jobs that are sent, closed, or were never started. Those are
 * two different questions asked of the same table: "what am I in the middle
 * of" is a to-do list and "what have I sent" is a record, and a list that
 * interleaves them answers neither.
 */
const app = (over) => ({
  role: 'Platform Engineer',
  status: 'applied',
  appliedAt: '2026-05-01T09:00:00Z',
  ...over,
});

// Deliberately oldest, so date order alone would put them last. Anything that
// sorts these to the top by accident is sorting by something else.
const OLD = '2026-01-01T09:00:00Z';
const NEW = '2026-08-01T09:00:00Z';

const APPS = [
  app({ id: 'a-applied-new', company: 'Zenith', status: 'applied', appliedAt: NEW }),
  app({ id: 'b-applying-old', company: 'Helios', status: 'applying', appliedAt: OLD }),
  app({ id: 'c-closed-new', company: 'Vega', status: 'closed', appliedAt: NEW }),
  app({ id: 'd-interview-old', company: 'Altair', status: 'interview', appliedAt: OLD }),
  app({ id: 'e-interested-new', company: 'Nova', status: 'interested', appliedAt: NEW }),
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

describe('the tracker puts what is still moving at the top', () => {
  it('lifts applying and interviewing above everything else, whatever their dates', async () => {
    await draw(APPS);
    const out = readOut();

    // The two in flux are the two *oldest* rows in the fixture, so this
    // cannot pass by date order.
    expect(out).toEqual([
      '— Still going —',
      'Helios',
      'Altair',
      '— Sent, finished, or not started —',
      'Zenith',
      'Vega',
      'Nova',
    ]);
  });

  it('keeps each group in date order within itself', async () => {
    await draw([
      app({ id: 'x', company: 'Older', status: 'applying', appliedAt: OLD }),
      app({ id: 'y', company: 'Newer', status: 'applying', appliedAt: NEW }),
      app({ id: 'z', company: 'Done', status: 'closed', appliedAt: NEW }),
    ]);

    expect(readOut()).toEqual(['— Still going —', 'Newer', 'Older', '— Sent, finished, or not started —', 'Done']);
  });

  it('counts each group beside its name', async () => {
    await draw(APPS);
    const counts = [...document.querySelectorAll('#apps-wrap tbody tr.group .group-count')].map((s) => s.textContent);
    expect(counts).toEqual(['2 applications', '3 applications']);
  });

  /*
   * A heading over the whole list says nothing, and an empty half says less
   * than nothing. Both of these would look like a bug to somebody with three
   * applications, all of them at the same stage.
   */
  it('says nothing when everything is in flux', async () => {
    await draw([
      app({ id: 'x', company: 'Helios', status: 'applying' }),
      app({ id: 'y', company: 'Altair', status: 'interview' }),
    ]);

    expect(document.querySelectorAll('#apps-wrap tbody tr.group')).toHaveLength(0);
    expect(readOut()).toEqual(['Helios', 'Altair']);
  });

  it('says nothing when nothing is', async () => {
    await draw([
      app({ id: 'x', company: 'Zenith', status: 'applied' }),
      app({ id: 'y', company: 'Vega', status: 'closed' }),
    ]);

    expect(document.querySelectorAll('#apps-wrap tbody tr.group')).toHaveLength(0);
    expect(readOut()).toEqual(['Zenith', 'Vega']);
  });

  /*
   * The heading is not a row you can open, and the table's rows are. Leaving
   * it clickable means a click on the divider opens whichever application the
   * event happens to reach, which is the kind of thing nobody reports and
   * everybody notices.
   */
  it('does not make the divider look like something you can open', async () => {
    await draw(APPS);
    const heading = document.querySelector('#apps-wrap tbody tr.group');

    expect(heading.onclick).toBeFalsy();
    // It spans the table rather than pushing the columns about.
    expect(heading.querySelector('td').colSpan).toBe(7);
  });

  /*
   * Filtering narrows the table, and the grouping has to survive it: a filter
   * that leaves only sent applications must not leave a "Still going" heading
   * standing over them.
   */
  it('regroups what a filter leaves behind', async () => {
    await draw(APPS);

    const filter = document.querySelector('#app-status');
    filter.value = 'applied';
    filter.dispatchEvent(new Event('change', { bubbles: true }));

    await vi.waitFor(() => expect(readOut()).toEqual(['Zenith']));
    expect(document.querySelectorAll('#apps-wrap tbody tr.group')).toHaveLength(0);
  });
});
