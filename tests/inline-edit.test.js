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
  /** Set by the one test that needs the store to refuse a write. */
  let refuseEntryWrites;

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    document.documentElement.innerHTML = fs.readFileSync('web/index.html', 'utf8');
    const fixture = makeTempStore();
    data = fixture.store.load();
    fixture.cleanup();
    requests = [];
    refuseEntryWrites = false;

    vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
      const body = options.body ? JSON.parse(options.body) : null;
      requests.push({ url, method: options.method ?? 'GET', body });
      let result = {};
      if (refuseEntryWrites && url.startsWith('/api/entries/') && options.method === 'PUT') {
        return { ok: false, status: 409, statusText: 'Conflict', json: async () => ({ error: 'The save moved under you.' }) };
      }
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

  /*
   * An inline commit that fails, and the resume switch that walks into it.
   *
   * `flushEdits` waited on the inline saves with `Promise.all`, which rejects
   * on the first failure — and nothing caught it. The `.catch` at the call
   * site is attached to a *derived* promise, so the one in the set is still
   * rejected. That rejection went out through `leaveResume` and out of the
   * dropdown's own handler, past both of `leaveResume`'s exits: neither its
   * refusal message nor the line that puts the dropdown back ever ran. The
   * dropdown was left naming a resume that is not the one on screen, with
   * nothing said, and an unhandled rejection in the console.
   */
  it('refuses to switch resumes when an inline edit did not land', async () => {
    await openMaster();
    refuseEntryWrites = true;

    const row = rowFor('Built a pipeline handling');
    const line = row.querySelector('.editable');
    line.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    line.textContent = `${line.textContent} at p95`;
    line.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    const selector = document.querySelector('#resume-select');
    selector.value = 'newgrad';
    selector.dispatchEvent(new Event('change'));
    await vi.advanceTimersByTimeAsync(3000);

    expect(selector.value, 'the dropdown still names what is on screen').toBe('__master__');
    expect(document.querySelector('#status')?.textContent ?? '').toMatch(/has not saved yet/i);
  });

  /*
   * And the typed sentence is still there to try again with.
   *
   * A failed commit put a message in the status line and left the line
   * holding text the store does not have — so the next render anywhere in the
   * editor rebuilt it from the store and the wording was gone, with no way
   * back but typing it from memory.
   */
  it('keeps a failed wording in its line, so it can be tried again', async () => {
    await openMaster();
    refuseEntryWrites = true;

    const row = rowFor('Built a pipeline handling');
    const line = row.querySelector('.editable');
    line.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    const typed = `${line.textContent} at p95`;
    line.textContent = typed;
    line.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await vi.advanceTimersByTimeAsync(200);

    expect(line.textContent, 'the sentence that was typed').toBe(typed);
    expect(line.classList.contains('editing'), 'still open for another go').toBe(true);
    expect(document.querySelector('#status')?.textContent ?? '').toMatch(/try again/i);

    // And pressing Enter again, once the store is answering, saves it.
    refuseEntryWrites = false;
    line.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await vi.advanceTimersByTimeAsync(200);
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
 * Two edits, close enough together that the first has not come back yet.
 *
 * An entry is saved whole: the editor takes the copy it rendered from, changes
 * one wording in it, and sends the result. The copy on screen only refreshes
 * when a save comes back, so an edit made a moment later is built from the text
 * as it was *before* the first edit — and sending it puts that old text back.
 * Fix a sentence, then fix the one under it, and the first fix is gone: from
 * the store, from every resume sharing the phrasing, silently.
 */
describe('two edits in quick succession', () => {
  let data;
  let release;

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    document.documentElement.innerHTML = fs.readFileSync('web/index.html', 'utf8');
    const fixture = makeTempStore();
    data = fixture.store.load();
    fixture.cleanup();
    release = [];

    vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
      const body = options.body ? JSON.parse(options.body) : null;
      let result = {};
      if (url === '/api/store') result = data;
      else if (url === '/api/ai/jobs') result = { jobs: [] };
      else if (url === '/api/render') result = { pages: 1, fits: true, adjustments: [], pdfUrl: '/pdf/x.pdf' };
      else if (url.startsWith('/api/entries/') && options.method === 'PUT') {
        // Held open until the test says so, which is what makes the second
        // edit land while the first is still in the air.
        await new Promise((go) => release.push(go));
        data.entries = data.entries.map((entry) => (entry.id === body.id ? body : entry));
        result = body;
      }
      return { ok: true, json: async () => structuredClone(result) };
    }));

    await import('../web/app.js');
    await vi.waitFor(() => expect(document.querySelector('#resume-select')).not.toBeNull());
    const selector = document.querySelector('#resume-select');
    selector.value = '__master__';
    selector.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(document.querySelector('.master-source-variant')).not.toBeNull());
  });

  const lineFor = (startsWith) =>
    [...document.querySelectorAll('.master-source-variant')]
      .find((node) => node.querySelector('.text').textContent.startsWith(startsWith))
      .querySelector('.editable');

  const edit = (line, text) => {
    line.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    line.textContent = text;
    line.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  };

  const stored = (variantId) =>
    data.entries
      .find((e) => e.id === 'exp_acme')
      .bullets.find((b) => b.id === 'b_pipeline')
      .variants.find((v) => v.id === variantId).text;

  it('keeps the first edit when the second is made before it comes back', async () => {
    // Both taken from the same render, as they would be by someone typing.
    const first = lineFor('Built a pipeline handling');
    const second = lineFor('Built a Kafka pipeline');

    edit(first, 'Built a pipeline handling 4M events/day');
    await vi.advanceTimersByTimeAsync(150);
    edit(second, 'Built the Kafka ingest path');

    await vi.waitFor(() => expect(release.length).toBeGreaterThan(0));
    for (let n = 0; n < 4 && (release.length || n < 2); n++) {
      release.shift()?.();
      await vi.advanceTimersByTimeAsync(50);
    }

    expect(stored('v_kafka')).toBe('Built the Kafka ingest path');
    expect(stored('v_base'), 'the edit made first').toBe('Built a pipeline handling 4M events/day');
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
  /** Set by the one test that needs the store to refuse a write. */
  let refuseEntryWrites;

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    document.documentElement.innerHTML = fs.readFileSync('web/index.html', 'utf8');
    const fixture = makeTempStore();
    data = fixture.store.load();
    fixture.cleanup();
    requests = [];
    refuseEntryWrites = false;

    vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
      const body = options.body ? JSON.parse(options.body) : null;
      requests.push({ url, method: options.method ?? 'GET', body });
      let result = {};
      if (refuseEntryWrites && url.startsWith('/api/entries/') && options.method === 'PUT') {
        return { ok: false, status: 409, statusText: 'Conflict', json: async () => ({ error: 'The save moved under you.' }) };
      }
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

  it('records a hidden bullet, and leaves the rest of the resume as it was', async () => {
    /*
     * Snapshotted before the click, not read back after it: the fake API
     * writes the saved spec into `data`, so reading it afterwards compares
     * the write against itself and passes whatever happened.
     */
    const before = structuredClone(data.resumes.find((r) => r.id === 'newgrad').sections ?? []);

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
     * And nothing else moved.
     *
     * This used to be an assertion that the untouched sections stayed
     * *absent*, because absent meant inherited and writing them down pinned
     * the variation to the entries its base had at that moment. Resumes stand
     * alone now, so every section is written every time and the question is
     * the simpler one it always should have been: did hiding one line change
     * anything other than that line?
     */
    const untouched = (s) => ({ ...s, bullets: undefined });
    expect((spec.sections ?? []).map(untouched)).toEqual(before.map(untouched));
  });
});

/*
 * Drafting an entry with the AI existed, but only from a link inside the
 * master view — so the button everyone actually presses gave a blank form and
 * nothing on it said the other way was there.
 */
describe('adding an entry', () => {
  let drafted;

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    document.documentElement.innerHTML = fs.readFileSync('web/index.html', 'utf8');
    location.hash = '';
    const fixture = makeTempStore();
    const data = fixture.store.load();
    fixture.cleanup();
    drafted = [];

    vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
      let result = {};
      if (url === '/api/store') result = data;
      else if (url === '/api/ai/jobs') result = { jobs: [] };
      else if (url === '/api/render') result = { pages: 1, fits: true, adjustments: [], pdfUrl: '/pdf/x.pdf' };
      else if (String(url).includes('/ai/draft-entry')) {
        drafted.push(JSON.parse(options.body ?? '{}'));
        result = { entry: null, prompt: 'the prompt' };
      }
      return { ok: true, json: async () => structuredClone(result) };
    }));

    await import('../web/app.js');
    await vi.waitFor(() => expect(document.querySelector('#resume-select')).not.toBeNull());
  });

  const fill = async (values) => {
    await vi.waitFor(() => expect(document.querySelector('#modal select')).not.toBeNull());
    for (const [name, value] of Object.entries(values)) {
      const field = document.querySelector(`#modal [name="${name}"]`);
      expect(field, name).toBeTruthy();
      field.value = value;
    }
    [...document.querySelectorAll('#modal button')].find((b) => /save|add|ok/i.test(b.textContent))?.click();
  };

  it('offers the AI as a way to start, from the button people press', async () => {
    document.querySelector('#btn-add-entry').click();
    await vi.waitFor(() => expect(document.querySelector('#modal [name="how"]')).not.toBeNull());

    const how = document.querySelector('#modal [name="how"]');
    const options = [...how.options].map((o) => o.textContent);
    expect(options.some((o) => /blank/i.test(o)), 'writing it yourself').toBe(true);
    expect(options.some((o) => /AI/.test(o)), 'and letting the AI draft it').toBe(true);
    // The blank form stays the default: it is instant, and nothing is spent.
    expect(how.value).toBe('blank');
  });

  it('asks the AI when that is what was chosen', async () => {
    document.querySelector('#btn-add-entry').click();
    await fill({ kind: 'project', how: 'ai' });

    // The AI path opens its own form; what matters is that it was taken.
    await vi.waitFor(() =>
      expect(document.querySelector('#modal')?.textContent ?? '').toMatch(/repository|describe|link|draft/i),
    );
  });
});
