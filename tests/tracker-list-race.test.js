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
  vi.unstubAllGlobals();
});

/*
 * Two loads of the tracker in flight, answered out of order.
 *
 * The list is loaded again after every status change and on every visit to
 * the tab, and nothing stopped an older answer landing after a newer one:
 * the list drawn — and kept for the search box — was the one from before.
 */
describe('the tracker list, loaded twice at once', () => {
  const row = (company) => ({
    id: `2026-10-10-${company.toLowerCase()}-engineer`,
    company,
    role: 'Engineer',
    status: 'applied',
    appliedAt: '2026-10-10T16:00:00.000Z',
    history: [{ at: '2026-10-10T16:00:00.000Z', status: 'applied' }],
  });
  let served;
  let holdNext;

  beforeEach(async () => {
    vi.resetModules();
    document.documentElement.innerHTML = fs.readFileSync('web/index.html', 'utf8');
    window.location.hash = '#applications';
    const fixture = makeTempStore();
    const data = fixture.store.load();
    fixture.cleanup();
    served = [row('Older')];
    holdNext = null;

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url) => {
        let result = {};
        if (url === '/api/store') result = data;
        else if (url === '/api/ai/jobs') result = { jobs: [] };
        else if (url === '/api/applications') {
          // What the server holds when the request arrives, as it would.
          const applications = structuredClone(served);
          const held = holdNext;
          holdNext = null;
          if (held) await held;
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
    await vi.waitFor(() => expect(document.querySelector('#apps-wrap')?.textContent).toContain('Older'));
  });

  it('draws the newest answer, whichever arrives last', async () => {
    const tab = document.querySelector('#tabs button[data-tab="applications"]');
    let release;
    holdNext = new Promise((go) => (release = go));
    tab.click();
    await new Promise((go) => setTimeout(go, 20));
    served = [row('Newer')];
    tab.click();
    await vi.waitFor(() => expect(document.querySelector('#apps-wrap').textContent).toContain('Newer'));
    release();
    await new Promise((go) => setTimeout(go, 50));
    expect(document.querySelector('#apps-wrap').textContent).toContain('Newer');
    expect(document.querySelector('#apps-wrap').textContent).not.toContain('Older');
  });
});
