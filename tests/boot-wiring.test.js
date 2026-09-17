// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { makeTempStore } from './helpers.ts';

vi.mock('../web/preview.js', () => ({ createPreview: () => ({ show: async () => {} }) }));
vi.mock('../web/assets.js', () => ({
  setupAssets: () => ({ init: async () => ({ current: '/test-save' }), load: async () => {} }),
}));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/*
 * The controls have to work as soon as they are on screen.
 *
 * Arriving on a deep link — which is how the browser extension sends you here
 * — the editor drew the toolbar, then waited on the request that opens the
 * linked resume before attaching a single handler. In between, the resume
 * dropdown was a full list attached to nothing: picking one did nothing, said
 * nothing, and the next repaint put the old name back, so it read as a broken
 * control rather than as a slow one.
 *
 * It cost three full browser runs to find, because the window is invisible on
 * an idle machine and wide on a loaded one. Here the slow request is simply
 * held open, which makes the window as wide as the test likes.
 */
describe('arriving on a deep link', () => {
  let data;
  let release;

  beforeEach(async () => {
    vi.resetModules();
    document.documentElement.innerHTML = fs.readFileSync('web/index.html', 'utf8');
    window.location.hash = '#resumes/intern';

    const fixture = makeTempStore();
    data = fixture.store.load();
    fixture.cleanup();

    // The one request the deep link waits on, held open until the test says.
    const held = new Promise((done) => {
      release = done;
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, options = {}) => {
        let result = {};
        if (url === '/api/store') result = data;
        else if (url === '/api/ai/jobs') result = { jobs: [] };
        else if (url.startsWith('/api/resumes/') && url.includes('/resolved')) await held;
        else if (url === '/api/render') {
          await held;
          result = { pages: 1, fits: true, adjustments: [], pdfUrl: '/pdf/x.pdf' };
        }
        return { ok: true, json: async () => structuredClone(result) };
      }),
    );

    await import('../web/app.js');
    // The dropdown has been drawn and filled: as far as anyone looking at the
    // screen is concerned, the editor is ready.
    await vi.waitFor(() => expect(document.querySelector('#resume-select option')).not.toBeNull());
  });

  it('answers the resume dropdown before the linked resume has finished loading', async () => {
    const selector = document.querySelector('#resume-select');
    expect([...selector.options].map((o) => o.value)).toContain('__master__');

    selector.value = '__master__';
    selector.dispatchEvent(new Event('change'));

    // The master view is built from the store, which is already here — so
    // there is nothing legitimate for this to be waiting on.
    await vi.waitFor(() => expect(document.querySelector('.master-source-variant')).not.toBeNull());
    expect(selector.value).toBe('__master__');

    release();
  });

  it('has its buttons wired too, not only the dropdown', async () => {
    // Every handler in `boot` sat behind the same wait; the dropdown is the
    // one that was noticed because it is the one people reach for first.
    for (const id of ['#btn-add-entry', '#btn-save-as', '#btn-rebuild', '#btn-add-app', '#btn-new-draft']) {
      const button = document.querySelector(id);
      expect(button, id).not.toBeNull();
      expect(typeof button.onclick, id).toBe('function');
    }
    release();
  });
});
