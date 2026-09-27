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
 * The server stopping under an open editor, and coming back.
 *
 * A stopped server does not refuse anything: the browser never gets an answer
 * and `fetch` rejects with its own words, "Failed to fetch". The preview put
 * those words in the fit line, under a pane still reading "Compiling your
 * resume…", and the save chip put them after "Not saved". Neither asked again
 * by itself — only an edit asks for a compile or a save — so both stayed that
 * way after the server was back, until something else was touched.
 */
describe('a server that stops and comes back', () => {
  function serve({ down = false } = {}) {
    const fixture = makeTempStore();
    const data = fixture.store.load();
    fixture.cleanup();

    const net = { down, puts: [], renders: 0 };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, init = {}) => {
        const method = init.method ?? 'GET';
        const writes = String(url).startsWith('/api/render') || method !== 'GET';
        if (net.down && writes) throw new TypeError('Failed to fetch');
        let result = {};
        if (url === '/api/store') result = data;
        else if (url === '/api/ai/jobs') result = { jobs: [] };
        else if (url === '/api/config') {
          result = { ai: { enabled: false }, latex: {}, git: {}, output: {}, overrides: {}, resumes: {} };
        } else if (url === '/api/resumes/expiring') result = { due: [] };
        else if (String(url).startsWith('/api/render')) {
          net.renders++;
          result = { pages: 1, fits: true, adjustments: [], warnings: [], lost: [], pdfUrl: '/pdf/x.pdf' };
        } else if (String(url).startsWith('/api/resumes/') && method === 'PUT') {
          const spec = JSON.parse(init.body);
          net.puts.push(spec);
          result = spec;
        }
        return { ok: true, json: async () => structuredClone(result) };
      }),
    );
    return net;
  }

  async function boot(options) {
    vi.resetModules();
    document.documentElement.innerHTML = fs.readFileSync('web/index.html', 'utf8');
    window.location.hash = '#resumes';
    const net = serve(options);
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

  const text = (sel) => document.querySelector(sel).textContent;
  const shownIn = (spec) => spec?.sections?.find((s) => s.kind === 'experience')?.entries ?? [];

  it('says the preview cannot reach the server, and compiles again once it is back', async () => {
    const net = await boot();
    await vi.waitFor(() => expect(text('#live-state')).toBe('Live'), { timeout: 4000 });

    net.down = true;
    untick('Acme Co.');
    await vi.waitFor(() => expect(text('#fit')).toMatch(/can’t reach the server/i), { timeout: 4000 });
    expect(text('#fit')).not.toMatch(/failed to fetch/i);
    expect(text('#live-state')).toMatch(/can’t reach/i);

    // Back, and nothing else touched: no edit, no reload.
    const before = net.renders;
    net.down = false;
    await vi.waitFor(() => expect(net.renders).toBeGreaterThan(before), { timeout: 8000 });
    await vi.waitFor(() => expect(text('#live-state')).toBe('Live'));
    expect(text('#fit')).toMatch(/fits on one page/i);
  }, 20_000);

  it('says so in the pane when there was never a page to show', async () => {
    const net = await boot({ down: true });
    await vi.waitFor(() => expect(text('#preview-empty')).toMatch(/can’t reach the server/i), { timeout: 4000 });
    expect(text('#fit')).not.toMatch(/compiling/i);

    net.down = false;
    await vi.waitFor(() => expect(text('#fit')).toMatch(/fits on one page/i), { timeout: 8000 });
    expect(text('#preview-empty')).not.toMatch(/reach/i);
  }, 20_000);

  it('does not call an edit made meanwhile saved, and saves it once the server is back', async () => {
    const net = await boot();
    await vi.waitFor(() => expect(text('#live-state')).toBe('Live'), { timeout: 4000 });

    net.down = true;
    untick('Acme Co.');
    await vi.waitFor(() => expect(text('#save-state')).toMatch(/not saved/i), { timeout: 4000 });
    expect(text('#save-state')).toMatch(/can’t reach the server/i);
    expect(text('#save-state')).toMatch(/retry/i);
    expect(net.puts).toHaveLength(0);

    net.down = false;
    await vi.waitFor(() => expect(net.puts.length).toBeGreaterThan(0), { timeout: 8000 });
    await vi.waitFor(() => expect(text('#save-state')).toBe('All changes saved'));
    expect(shownIn(net.puts.at(-1))).not.toContain('exp_acme');
  }, 20_000);
});
