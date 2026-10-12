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
 * A save of the resume the server refuses for good.
 *
 * Undo, switching resumes, Restore and asking for feedback all wait for the
 * edit on screen to save, and stop with "has not saved yet" when it will not.
 * That is right while the save may still land. But a 500, or a 409 after
 * three rebases, is only ever tried again on the next edit, so every one of
 * those actions refused for good and nothing on the screen said what to do:
 * reloading the page was the only way out. The chip now carries Retry and
 * "Discard unsaved change", and the refusals name them.
 */
describe('a save the server keeps refusing', () => {
  async function boot() {
    vi.resetModules();
    document.documentElement.innerHTML = fs.readFileSync('web/index.html', 'utf8');
    window.location.hash = '#resumes/intern';

    const fixture = makeTempStore();
    const data = fixture.store.load();
    fixture.cleanup();

    const server = { refuse: true, puts: 0 };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, options = {}) => {
        let result = {};
        if (url === '/api/store') result = data;
        else if (url === '/api/ai/jobs') result = { jobs: [] };
        else if (String(url).startsWith('/api/render')) {
          result = { pages: 1, fits: true, adjustments: [], warnings: [], lost: [], pdfUrl: '/pdf/x.pdf' };
        } else if (String(url).startsWith('/api/resumes/') && options.method === 'PUT') {
          server.puts++;
          if (server.refuse) {
            return { ok: false, status: 500, statusText: 'Internal Server Error', json: async () => ({ error: 'disk full' }) };
          }
          const spec = JSON.parse(options.body);
          const at = data.resumes.findIndex((r) => r.id === spec.id);
          if (at >= 0) data.resumes[at] = spec;
          result = spec;
        }
        return { ok: true, json: async () => structuredClone(result) };
      }),
    );

    await import('../web/app.js');
    await vi.waitFor(() => expect(document.querySelector('#resume-select')?.value).toBe('intern'));
    await vi.waitFor(() => expect(document.querySelector('#tab-resumes .toggle input')).not.toBeNull());
    return { data, server };
  }

  const chip = () => document.querySelector('#save-state');
  const stuck = () => document.querySelector('#save-stuck');
  const box = () => document.querySelector('#tab-resumes .toggle input');

  /** Make an edit and wait for the server to refuse it. */
  async function refusedEdit() {
    box().click();
    await vi.waitFor(() => expect(chip().className).toMatch(/failed/), { timeout: 4000 });
  }

  it('offers Retry and Discard, and Discard puts the editor back on what is saved', async () => {
    const { data } = await boot();
    expect(stuck().hidden, 'nothing to offer while all is well').toBe(true);
    const was = box().checked;
    const saved = structuredClone(data.resumes.find((r) => r.id === 'intern'));

    await refusedEdit();
    expect(box().checked).toBe(!was);
    expect(stuck().hidden, 'the way out is on screen').toBe(false);
    // The page hidden for a moment keeps the edit for a rescue (`keepForRescue`).
    const rescued = () => Object.keys(localStorage).filter((k) => k.startsWith('rmm-rescue:') && k.includes('"intern"'));
    const shown = (v) => Object.defineProperty(document, 'visibilityState', { value: v, configurable: true });
    shown('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    shown('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(rescued().length, 'a rescue copy was kept').toBe(1);
    await vi.waitFor(() => expect(chip().className).toMatch(/failed/), { timeout: 4000 });

    // Switching resumes refuses, and says where the way out is.
    const select = document.querySelector('#resume-select');
    select.value = 'newgrad';
    select.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(document.querySelector('#status').textContent).toMatch(/has not saved yet/i));
    expect(document.querySelector('#status').textContent).toMatch(/Retry it or discard it/);
    await vi.waitFor(() => expect(select.value).toBe('intern'));

    document.querySelector('#btn-save-discard').click();
    await vi.waitFor(() => expect(chip().textContent).toBe('All changes saved'));
    expect(stuck().hidden).toBe(true);
    expect(box().checked, 'the screen is back on the saved resume').toBe(was);
    expect(data.resumes.find((r) => r.id === 'intern'), 'nothing was written').toEqual(saved);
    expect(document.querySelector('#status').textContent).toMatch(/discarded/i);
    expect(rescued(), 'nor is it offered back on the next visit').toEqual([]);

    // And the rest of the editor is free again: switching resumes goes.
    select.value = 'newgrad';
    select.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(document.querySelector('#resume-select').value).toBe('newgrad'));
    expect(document.querySelector('#status').textContent).not.toMatch(/has not saved yet/i);
  });

  it('Retry sends the edit again once the server takes it', async () => {
    const { data, server } = await boot();
    const was = box().checked;
    await refusedEdit();
    const before = server.puts;

    server.refuse = false;
    document.querySelector('#btn-save-retry').click();
    await vi.waitFor(() => expect(chip().textContent).toBe('All changes saved'));
    expect(server.puts).toBeGreaterThan(before);
    expect(stuck().hidden).toBe(true);
    expect(box().checked).toBe(!was);
    expect(data.resumes.find((r) => r.id === 'intern')).toBeTruthy();
  });

  it('is not offered for a server that cannot be reached, which is retried on its own', async () => {
    await boot();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    box().click();
    await vi.waitFor(() => expect(chip().textContent).toMatch(/can’t reach/), { timeout: 4000 });
    expect(stuck().hidden).toBe(true);
  });
});
