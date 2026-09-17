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
 * Undo, as the person pressing Ctrl+Z understands it.
 *
 * The mechanism was sound — snapshot the document either side of the write —
 * and the three things wrong with it were all about what counts as one step and
 * where the key applies.
 */
describe('undo in the builder', () => {
  let data;
  let requests;

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    document.documentElement.innerHTML = fs.readFileSync('web/index.html', 'utf8');
    location.hash = '';
    const fixture = makeTempStore();
    data = fixture.store.load();
    fixture.cleanup();
    requests = [];

    vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
      const body = options.body ? JSON.parse(options.body) : null;
      const method = options.method ?? 'GET';
      requests.push({ url, method, body });
      let result = {};
      if (url === '/api/store') result = data;
      else if (url === '/api/ai/jobs') result = { jobs: [] };
      else if (url === '/api/render') result = { pages: 1, fits: true, adjustments: [], pdfUrl: '/pdf/x.pdf' };
      else if (url.startsWith('/api/resumes/') && method === 'PUT') {
        const id = decodeURIComponent(url.split('?')[0].split('/').pop());
        data.resumes = data.resumes.map((r) => (r.id === id ? { ...body, id } : r));
        result = data.resumes.find((r) => r.id === id);
      } else if (url.startsWith('/api/entries/') && method === 'PUT') {
        data.entries = data.entries.map((e) => (e.id === body.id ? body : e));
        result = body;
      }
      return { ok: true, json: async () => structuredClone(result) };
    }));

    await import('../web/app.js');
    await vi.waitFor(() => expect(document.querySelector('#resume-select')).not.toBeNull());
    const selector = document.querySelector('#resume-select');
    selector.value = 'newgrad';
    selector.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(document.querySelector('#editor .toggle')).not.toBeNull());
  });

  const undoBtn = () => document.querySelector('#btn-undo');
  const spec = (id) => data.resumes.find((r) => r.id === id);
  const written = (id) =>
    requests.filter((r) => r.method === 'PUT' && r.url.includes(`/resumes/${id}`)).map((r) => r.body);

  /*
   * The one that made undo look broken.
   *
   * A resume is a thin overlay and the editor holds the unsaved part of it in
   * `state.choices` and friends. Undoing put the old spec back on disk and left
   * that overlay alone — so the next render re-applied exactly what had been
   * undone and the next auto-save wrote it out again. Ctrl+Z did nothing, over
   * and over.
   */
  it('takes back a selection instead of writing it out again', async () => {
    const boxes = [...document.querySelectorAll('#editor input[type=checkbox]')].filter((b) => !b.disabled);
    const box = boxes[0];
    expect(box, 'a selection to change').toBeTruthy();
    box.click();

    await vi.advanceTimersByTimeAsync(3000);
    await vi.waitFor(() => expect(written('newgrad').length).toBeGreaterThan(0));
    const afterEdit = structuredClone(spec('newgrad'));

    await vi.waitFor(() => expect(undoBtn().disabled).toBe(false));
    undoBtn().click();

    // The store goes back…
    await vi.waitFor(() => expect(spec('newgrad')).not.toEqual(afterEdit));
    const restored = structuredClone(spec('newgrad'));

    // …and stays back. The overlay that used to re-apply the change is gone,
    // so nothing writes it out again a moment later.
    await vi.advanceTimersByTimeAsync(5000);
    expect(spec('newgrad')).toEqual(restored);
  });

  /*
   * Ctrl+Z belongs to the resume builder. It used to fire from any tab, so
   * pressing it while reading the Applications list silently rolled back an
   * edit made somewhere the user was not looking.
   */
  it('does nothing on a tab that has no history of its own', async () => {
    const boxes = [...document.querySelectorAll('#editor input[type=checkbox]')].filter((b) => !b.disabled);
    boxes[0].click();
    await vi.advanceTimersByTimeAsync(3000);
    await vi.waitFor(() => expect(undoBtn().disabled).toBe(false));
    const afterEdit = structuredClone(spec('newgrad'));

    // Somewhere else entirely.
    for (const b of document.querySelectorAll('#tabs button')) b.disabled = false;
    document.querySelector('button[data-tab="applications"]').click();
    await vi.advanceTimersByTimeAsync(100);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
    await vi.advanceTimersByTimeAsync(500);
    expect(spec('newgrad'), 'the resume was not rolled back from another tab').toEqual(afterEdit);

    // Back where it means something, it works.
    document.querySelector('button[data-tab="resumes"]').click();
    await vi.advanceTimersByTimeAsync(100);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
    await vi.waitFor(() => expect(spec('newgrad')).not.toEqual(afterEdit));
  });
});
