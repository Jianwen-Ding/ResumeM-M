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
 * Editing a line in place, and what the store ends up holding.
 *
 * The store is the point of this whole system: one canonical sentence, shared
 * by every resume that prints it. So an edit that changes more than the user
 * typed is not a display bug — it is a write, to shared text, that nobody
 * asked for and nothing reports.
 */
describe('editing a line in place', () => {
  let data;
  let requests;

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    document.documentElement.innerHTML = fs.readFileSync('web/index.html', 'utf8');
    const fixture = makeTempStore();
    data = fixture.store.load();
    fixture.cleanup();
    requests = [];

    vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
      const body = options.body ? JSON.parse(options.body) : null;
      requests.push({ url, method: options.method ?? 'GET', body });
      let result = {};
      if (url === '/api/store') result = data;
      else if (url === '/api/ai/jobs') result = { jobs: [] };
      else if (url === '/api/render') result = { pages: 1, fits: true, adjustments: [], pdfUrl: '/pdf/x.pdf' };
      else if (url.startsWith('/api/entries/') && options.method === 'PUT') {
        data.entries = data.entries.map((entry) => (entry.id === body.id ? body : entry));
        result = body;
      } else if (url.startsWith('/api/resumes/') && options.method === 'PUT') {
        data.resumes = data.resumes.map((r) => (r.id === body.id ? body : r));
        result = body;
      }
      return { ok: true, json: async () => structuredClone(result) };
    }));

    await import('../web/app.js');
    await vi.waitFor(() => expect(document.querySelector('#resume-select')).not.toBeNull());
  });

  const openMaster = async () => {
    const selector = document.querySelector('#resume-select');
    selector.value = '__master__';
    selector.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(document.querySelector('.master-source-variant')).not.toBeNull());
  };

  const rowFor = (startsWith) =>
    [...document.querySelectorAll('.master-source-variant')].find((node) =>
      node.querySelector('.text').textContent.startsWith(startsWith),
    );

  const storedText = (variantId) =>
    data.entries
      .find((e) => e.id === 'exp_acme')
      .bullets.find((b) => b.id === 'b_pipeline')
      .variants.find((v) => v.id === variantId).text;

  it('opens the sentence as the store holds it, markup and all', async () => {
    await openMaster();
    const row = rowFor('Built a Kafka pipeline');
    const line = row.querySelector('.editable');

    // Shown rendered…
    expect(line.textContent).not.toContain('**');

    line.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));

    // …and edited raw, which is the only way an edit can preserve it.
    expect(line.textContent).toBe('Built a `Kafka` pipeline handling **2M events/day**');
  });

  /*
   * The bug this file exists for. `display()` strips `**`, backticks and `*`,
   * and the editable box was seeded with its output — so committing any change
   * wrote the stripped sentence back over the original. Add one word to a
   * bullet and its bold metric is gone from the store, from every resume using
   * that phrasing, and from the PDF, with nothing on screen having said so.
   */
  it('keeps the markup when a word is added to the line', async () => {
    await openMaster();
    const row = rowFor('Built a pipeline handling');
    const line = row.querySelector('.editable');

    line.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    line.textContent = `${line.textContent} at p95`;
    line.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    await vi.waitFor(() =>
      expect(requests.some((r) => r.method === 'PUT' && r.url.startsWith('/api/entries/'))).toBe(true),
    );

    expect(storedText('v_base')).toBe('Built a pipeline handling **2M events/day** at p95');
  });

  it('leaves the store alone when the text comes back unchanged', async () => {
    await openMaster();
    const row = rowFor('Built a pipeline handling');
    const line = row.querySelector('.editable');
    const before = storedText('v_base');

    line.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    line.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    expect(requests.some((r) => r.method === 'PUT' && r.url.startsWith('/api/entries/'))).toBe(false);
    expect(storedText('v_base')).toBe(before);
  });

  it('still restores the rendered form when the edit is abandoned', async () => {
    await openMaster();
    const row = rowFor('Built a `Kafka` pipeline'.replace(/`/g, ''));
    const line = row.querySelector('.editable');

    line.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    line.textContent = 'something else entirely';
    line.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(line.textContent).not.toContain('**');
    expect(storedText('v_kafka')).toBe('Built a `Kafka` pipeline handling **2M events/day**');
  });
});

/*
 * What a variation writes down when you change one thing on it.
 *
 * A variation is meant to be thin — the base plus a few decisions. Both of
 * these made it thick, silently, and a thick variation is one that has stopped
 * tracking its base.
 */
describe('editing a variation', () => {
  let data;
  let requests;

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    document.documentElement.innerHTML = fs.readFileSync('web/index.html', 'utf8');
    const fixture = makeTempStore();
    data = fixture.store.load();
    fixture.cleanup();
    requests = [];

    vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
      const body = options.body ? JSON.parse(options.body) : null;
      requests.push({ url, method: options.method ?? 'GET', body });
      let result = {};
      if (url === '/api/store') result = data;
      else if (url === '/api/ai/jobs') result = { jobs: [] };
      else if (url === '/api/render') result = { pages: 1, fits: true, adjustments: [], pdfUrl: '/pdf/x.pdf' };
      else if (url.startsWith('/api/entries/') && options.method === 'PUT') {
        data.entries = data.entries.map((e) => (e.id === body.id ? body : e));
        result = body;
      } else if (url.startsWith('/api/resumes/') && options.method === 'PUT') {
        data.resumes = data.resumes.map((r) => (r.id === body.id ? body : r));
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

  const written = (id) => requests.filter((r) => r.method === 'PUT' && r.url.includes(`/resumes/${id}`)).pop()?.body;

  it('records a hidden bullet without pinning the entry list', async () => {
    // Switch off one bullet of one entry on the variation.
    const rows = [...document.querySelectorAll('#editor .bullet-row input[type=checkbox], #editor .bullet input[type=checkbox]')];
    const box = rows.find((b) => !b.disabled);
    expect(box, 'a bullet checkbox to toggle').toBeTruthy();
    box.click();

    await vi.advanceTimersByTimeAsync(3000);
    await vi.waitFor(() => expect(written('newgrad')).toBeTruthy());

    const spec = written('newgrad');
    const touched = (spec.sections ?? []).filter((s) => s.bullets && Object.keys(s.bullets).length);
    expect(touched.length, 'the section holding the bullet').toBeGreaterThan(0);

    /*
     * And nothing else came down with it. Writing the flattened chain back
     * copied every inherited section into the variation, after which entries
     * later added to the base arrived switched off rather than inherited.
     */
    for (const section of spec.sections ?? []) {
      if (section.bullets && Object.keys(section.bullets).length) continue;
      expect(section.entries, `${section.kind} should still be inherited`).toBeUndefined();
    }
  });
});
