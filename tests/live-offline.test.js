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
  vi.unstubAllGlobals();
  localStorage.clear();
});

/*
 * The "Live" dot heard only from the compile. A save that could not reach a
 * stopped server never asks for one, so the dot stayed green and said "Live"
 * over an edit that had gone nowhere. Any request that never arrives turns it
 * to "Can’t reach server"; the next one answered turns it back.
 */
describe('the Live dot while the server is down', () => {
  function serve() {
    const fixture = makeTempStore();
    const data = fixture.store.load();
    fixture.cleanup();

    const net = { savesDown: false, puts: 0 };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, init = {}) => {
        const method = init.method ?? 'GET';
        // Only the saves: the compile, if one were asked for, would answer.
        if (net.savesDown && method !== 'GET' && !String(url).startsWith('/api/render')) {
          throw new TypeError('Failed to fetch');
        }
        let result = {};
        if (url === '/api/store') result = data;
        else if (url === '/api/ai/jobs') result = { jobs: [] };
        else if (url === '/api/config') {
          result = { ai: { enabled: false }, latex: {}, git: {}, output: {}, overrides: {}, resumes: {} };
        } else if (url === '/api/resumes/expiring') result = { due: [] };
        else if (String(url).startsWith('/api/render')) {
          result = { pages: 1, fits: true, adjustments: [], warnings: [], lost: [], pdfUrl: '/pdf/x.pdf' };
        } else if (String(url).startsWith('/api/resumes/') && method === 'PUT') {
          net.puts++;
          result = JSON.parse(init.body);
        }
        return { ok: true, json: async () => structuredClone(result) };
      }),
    );
    return net;
  }

  async function boot() {
    vi.resetModules();
    document.documentElement.innerHTML = fs.readFileSync('web/index.html', 'utf8');
    window.location.hash = '#resumes';
    const net = serve();
    await import('../web/app.js');
    await vi.waitFor(() => expect(document.querySelectorAll('#editor .entry').length).toBeGreaterThan(1));
    return net;
  }

  function untick(title) {
    const row = [...document.querySelectorAll('#editor .entry')].find(
      (e) => e.querySelector('.title')?.textContent === title,
    );
    expect(row, `an entry called ${title}`).toBeTruthy();
    row.querySelector(':scope > .entry-head input[type=checkbox]').click();
  }

  const live = () => document.querySelector('#live-state');

  it('turns to offline when a save cannot reach the server, and back once one does', async () => {
    const net = await boot();
    await vi.waitFor(() => expect(live().textContent).toBe('Live'), { timeout: 4000 });

    net.savesDown = true;
    untick('Acme Co.');
    await vi.waitFor(() => expect(document.querySelector('#save-state').textContent).toMatch(/not saved|reach/i), {
      timeout: 4000,
    });
    expect(live().textContent).toBe('Can’t reach server');
    expect(live().classList.contains('offline')).toBe(true);
    // On a phone the word is hidden and the dot is all there is: its title
    // says what the colour means.
    expect(live().title).toMatch(/can’t reach server/i);

    net.savesDown = false;
    const before = net.puts;
    untick('Thing');
    await vi.waitFor(() => expect(net.puts).toBeGreaterThan(before), { timeout: 8000 });
    await vi.waitFor(() => expect(live().textContent).toBe('Live'), { timeout: 8000 });
    expect(live().classList.contains('offline')).toBe(false);
    expect(live().title).toMatch(/^Live/);
  }, 20_000);
});
