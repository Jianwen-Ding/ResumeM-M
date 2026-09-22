// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { makeTempStore } from './helpers.ts';

vi.mock('../web/preview.js', () => ({ createPreview: () => ({ show: async () => {} }) }));
vi.mock('../web/assets.js', () => ({
  setupAssets: () => ({
    // The real one enables the tab strip once a save is open, and the tabs
    // start disabled in the markup. A stub that skips that leaves every tab
    // button inert, so `showTab` clicks nothing and the deep link appears
    // broken for a reason that has nothing to do with deep links.
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
 * One application, linked to directly.
 *
 * The card in the browser says "you applied to this on the twelfth of March"
 * while you are standing on the posting, and the only reply anyone has to that
 * is "what did I send them?". The link it offers has to land on the record
 * rather than on the tracker's front page — a tab with two hundred rows on it
 * is not an answer, it is the same question with more scrolling.
 */
describe('linking straight to one tracked application', () => {
  const sent = {
    id: '2026-03-12-helios-platform-engineer',
    company: 'Helios',
    role: 'Platform Engineer',
    status: 'closed',
    appliedAt: '2026-03-12T09:00:00Z',
    resumeId: 'job-helios-platform-engineer',
    history: [{ at: '2026-03-12T09:00:00Z', status: 'applied', note: 'Bundle created' }],
  };
  const other = {
    id: '2026-05-01-lyra-data-scientist',
    company: 'Lyra',
    role: 'Data Scientist',
    status: 'applied',
    appliedAt: '2026-05-01T09:00:00Z',
  };

  let asked;

  beforeEach(async () => {
    vi.resetModules();
    document.documentElement.innerHTML = fs.readFileSync('web/index.html', 'utf8');
    window.location.hash = `#applications/${sent.id}`;

    const fixture = makeTempStore();
    const data = fixture.store.load();
    fixture.cleanup();

    asked = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url) => {
        asked.push(String(url));
        let result = {};
        if (url === '/api/store') result = data;
        else if (url === '/api/ai/jobs') result = { jobs: [] };
        else if (url === '/api/applications') {
          result = {
            applications: [other, sent],
            stats: { total: 2, last7: 0, last30: 1, responseRate: 0 },
            current: { dir: '/tmp/current', files: [], applications: 0, inFlight: 0 },
          };
        } else if (url === `/api/applications/${encodeURIComponent(sent.id)}`) {
          result = { application: sent, resume: null, copiedFromLabel: null, letter: null, files: [] };
        } else if (String(url).startsWith('/api/applications/')) {
          // As the server answers for an id it does not have.
          return { ok: false, status: 404, statusText: 'Not Found', json: async () => ({ error: 'No application "2020-01-01-gone"' }) };
        }
        return { ok: true, json: async () => structuredClone(result) };
      }),
    );

    await import('../web/app.js');
    await vi.waitFor(() => expect(document.querySelector('#apps-wrap tbody tr')).not.toBeNull());
  });

  it('opens the tracker rather than whatever tab was showing', () => {
    expect(document.querySelector('#tab-applications')?.classList.contains('active')).toBe(true);
  });

  it('shows the record of the one that was linked to', async () => {
    await vi.waitFor(() => {
      const panel = document.querySelector('#app-detail');
      expect(panel?.textContent).toContain('Platform Engineer');
      expect(panel?.textContent).toContain('Helios');
    });
  });

  /*
   * The resume this was sent with is gone, which the sweep makes ordinary:
   * a resume built for one posting is removed a week after that posting is
   * done with. The pane printed its filename — `job-helios-platform-engineer`
   * — which says nothing and reads like a fault.
   *
   * What it has to say is what is still true: the files that went are in
   * this application's own folder and listed further down the same pane, and
   * the resume is in the version history like everything else deleted here.
   */
  it('says what happened to a resume that is no longer in the save', async () => {
    await vi.waitFor(() => {
      const panel = document.querySelector('#app-detail');
      expect(panel?.textContent).toMatch(/removed from the save/i);
    });
    const panel = document.querySelector('#app-detail');
    expect(panel?.textContent).toMatch(/version history/i);
    // And not its filename, which is what it used to print instead.
    expect(panel?.textContent).not.toContain('job-helios-platform-engineer');
  });

  it('marks its row in the list, so the link and the table agree', async () => {
    /*
     * The row draws itself selected while the table renders, which happens
     * before the record comes back. Set the other way round, the link opened
     * the right record beside a table with nothing highlighted in it — and
     * nothing on screen connected the two.
     */
    await vi.waitFor(() => {
      const selected = document.querySelector('#apps-wrap tr.selected');
      expect(selected?.textContent).toContain('Helios');
    });
    expect(document.querySelectorAll('#apps-wrap tr.selected')).toHaveLength(1);
  });

  it('asks the store for that application by id', () => {
    expect(asked).toContain(`/api/applications/${encodeURIComponent(sent.id)}`);
  });

  it('says so plainly when the link names something that is not there', async () => {
    // A row can be removed after the extension read it. The panel is where
    // the answer was going to appear, so that is where the lack of one goes.
    window.location.hash = '#applications/2020-01-01-gone';
    window.dispatchEvent(new window.HashChangeEvent('hashchange'));
    await vi.waitFor(() => {
      expect(document.querySelector('#app-detail .err')?.textContent).toContain('No application');
    });
  });
});

/*
 * The tracker gains a row per application and never loses one, so the list a
 * job hunt ends with is nothing like the list it starts with. The questions
 * people actually have of it — what am I waiting to hear back on, what have I
 * not finished, did I apply to these people already — were all answered by
 * scrolling.
 */
describe('narrowing the tracker', () => {
  // The application rows, not the headings the list is grouped under — see
  // tests/tracker-grouping.test.js. A heading is not something that was found
  // or filtered, so counting one here would make every count below wrong by
  // however many groups happen to be on screen.
  const rows = () => [...document.querySelectorAll('#apps-wrap tbody tr:not(.group)')];
  const companies = () => rows().map((r) => r.children[1]?.textContent);

  const listing = [
    { id: 'a', company: 'Helios', role: 'Platform Engineer', status: 'applied', appliedAt: '2026-03-12T09:00:00Z' },
    { id: 'b', company: 'Lyra', role: 'Data Scientist', status: 'applying', appliedAt: '2026-05-01T09:00:00Z' },
    { id: 'c', company: 'Helios Robotics', role: 'Controls Engineer', status: 'interview', appliedAt: '2026-06-01T09:00:00Z' },
  ];

  beforeEach(async () => {
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
            applications: listing,
            stats: { total: 3, last7: 0, last30: 1, responseRate: 33 },
            current: { dir: '/tmp/current', files: [], applications: 0, inFlight: 0 },
          };
        }
        return { ok: true, json: async () => structuredClone(result) };
      }),
    );

    await import('../web/app.js');
    await vi.waitFor(() => expect(rows()).toHaveLength(3));
  });

  it('shows everything, and says nothing about a count, until asked', () => {
    expect(document.querySelector('#app-count')?.textContent).toBe('');
  });

  it('finds by company, and by role', async () => {
    const find = document.querySelector('#app-find');
    find.value = 'helios';
    find.dispatchEvent(new window.Event('input'));
    await vi.waitFor(() => expect(rows()).toHaveLength(2));
    expect(companies()).toEqual(['Helios Robotics', 'Helios']);

    find.value = 'data scientist';
    find.dispatchEvent(new window.Event('input'));
    await vi.waitFor(() => expect(companies()).toEqual(['Lyra']));
  });

  it('narrows to one stage', async () => {
    const stage = document.querySelector('#app-status');
    stage.value = 'interview';
    stage.dispatchEvent(new window.Event('change'));
    await vi.waitFor(() => expect(companies()).toEqual(['Helios Robotics']));
  });

  it('says how much of the list is showing, once it is not all of it', async () => {
    const stage = document.querySelector('#app-status');
    stage.value = 'applied';
    stage.dispatchEvent(new window.Event('change'));
    await vi.waitFor(() => expect(document.querySelector('#app-count')?.textContent).toMatch(/1 of 3 applications/));
  });

  it('tells an empty result from an empty tracker', async () => {
    const find = document.querySelector('#app-find');
    find.value = 'nobody has this name';
    find.dispatchEvent(new window.Event('input'));
    await vi.waitFor(() => {
      const empty = document.querySelector('#apps-wrap .empty');
      expect(empty?.textContent).toContain('Nothing matches');
      // The distinction that matters: three applications exist, none match.
      expect(empty?.textContent).toContain('3 applications filed');
    });
  });

  it('keeps the filter when a row changes stage under it', async () => {
    /*
     * Changing a status reloads the list. A filter that cleared itself there
     * would drop you back into the whole tracker every time you moved a row
     * on, which is exactly when you are working through a filtered set.
     */
    const stage = document.querySelector('#app-status');
    stage.value = 'applied';
    stage.dispatchEvent(new window.Event('change'));
    await vi.waitFor(() => expect(rows()).toHaveLength(1));

    const rowSelect = rows()[0].querySelector('select');
    rowSelect.value = 'interview';
    rowSelect.dispatchEvent(new window.Event('change'));
    await vi.waitFor(() => expect(document.querySelector('#app-status')?.value).toBe('applied'));
  });
});
