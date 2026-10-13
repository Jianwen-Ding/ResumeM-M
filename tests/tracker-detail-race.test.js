// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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

/*
 * The tracker, with its clock somewhere other than Greenwich.
 *
 * Node reads `TZ` again when it is set, so the dates below are drawn the way
 * a browser in California draws them.
 */
const zone = process.env.TZ;
beforeAll(() => {
  process.env.TZ = 'America/Los_Angeles';
});
afterAll(() => {
  if (zone === undefined) delete process.env.TZ;
  else process.env.TZ = zone;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the tracker’s record pane, and the days it shows', () => {
  // Sent at 6:30pm in California on the tenth, which is the eleventh in UTC.
  const evening = {
    id: '2026-10-10-evening-corp-engineer',
    company: 'Evening Corp',
    role: 'Engineer',
    status: 'applied',
    appliedAt: '2026-10-11T01:30:00.000Z',
    history: [{ at: '2026-10-11T01:30:00.000Z', status: 'applied', note: 'Bundle created' }],
  };
  const morning = {
    id: '2026-10-09-morning-inc-analyst',
    company: 'Morning Inc',
    role: 'Analyst',
    status: 'applied',
    appliedAt: '2026-10-09T16:00:00.000Z',
    history: [{ at: '2026-10-09T16:00:00.000Z', status: 'applied' }],
  };

  /** Replies to a record held until released, by id. */
  let holds;

  beforeEach(async () => {
    vi.resetModules();
    document.documentElement.innerHTML = fs.readFileSync('web/index.html', 'utf8');
    window.location.hash = '#applications';
    const fixture = makeTempStore();
    const data = fixture.store.load();
    fixture.cleanup();
    holds = new Map();

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url) => {
        let result = {};
        if (url === '/api/store') result = data;
        else if (url === '/api/ai/jobs') result = { jobs: [] };
        else if (url === '/api/applications') {
          result = {
            applications: [evening, morning],
            stats: { total: 2, last7: 2, last30: 2, responseRate: 0 },
            current: { dir: '/tmp/current', files: [], applications: 0, inFlight: 0 },
          };
        } else if (String(url).startsWith('/api/applications/')) {
          const id = decodeURIComponent(String(url).slice('/api/applications/'.length));
          const a = [evening, morning].find((x) => x.id === id);
          if (holds.has(id)) await holds.get(id);
          result = { application: a, resume: null, copiedFromLabel: null, letter: null, files: [] };
        }
        return { ok: true, json: async () => structuredClone(result) };
      }),
    );

    await import('../web/app.js');
    await vi.waitFor(() => expect(document.querySelectorAll('#apps-wrap tbody tr:not(.group)').length).toBe(2));
  });

  const rowOf = (company) =>
    [...document.querySelectorAll('#apps-wrap tbody tr:not(.group)')].find((r) => r.textContent.includes(company));

  /*
   * Click one application, then another before the first has been read.
   * The first reply, arriving last, painted its record over the second's,
   * beside the second's row marked as the selected one.
   */
  it('shows the application clicked last, whichever record arrives last', async () => {
    let release;
    holds.set(evening.id, new Promise((go) => (release = go)));
    rowOf('Evening Corp').click();
    await new Promise((go) => setTimeout(go, 20));
    rowOf('Morning Inc').click();
    await vi.waitFor(() => expect(document.querySelector('#app-detail')?.textContent).toContain('Morning Inc'));
    release();
    await new Promise((go) => setTimeout(go, 50));
    expect(document.querySelector('#app-detail').textContent).toContain('Morning Inc');
    expect(document.querySelector('#app-detail').textContent).not.toContain('Evening Corp');
  });

  /* The day it was sent here, not the day it was in Greenwich. */
  it('dates an application by the local day, in the table and in its history', async () => {
    const cells = [...rowOf('Evening Corp').querySelectorAll('td.when')].map((td) => td.textContent);
    expect(cells).toEqual(['2026-10-10', '2026-10-10']);
    rowOf('Evening Corp').click();
    await vi.waitFor(() => expect(document.querySelector('#app-detail')?.textContent).toContain('Evening Corp'));
    const when = [...document.querySelectorAll('#app-detail .when')].map((s) => s.textContent);
    expect(when).toContain('2026-10-10');
    expect(when).not.toContain('2026-10-11');
  });
});
