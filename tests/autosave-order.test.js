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
 * Two saves of one resume, in the order they were made.
 *
 * `saveEntry` goes through a lane — read the note on `inEntryLane`, which
 * exists because "two changes a moment apart" let the second land under the
 * first. The resume document, which is what every tick and every alternate
 * writes to, had no such lane: `autoSave` overwrote the promise it was
 * holding and left two PUTs of the same file racing.
 *
 * What that costs is the newer edit, twice over. On disk, whichever request
 * the server finishes last wins, and it is not always the later one. In the
 * editor, each reply ends with `Object.assign(stored, spec)` — so a slow
 * first reply landing after a fast second one writes the *older* selection
 * back over the cached resume, under a status chip reading "All changes
 * saved". Switching resumes and back, or reloading, then shows the edit
 * undone with nothing having said so.
 *
 * Driven with the first write held open, because that is the whole of it:
 * the race needs a save still in flight when the next one is sent, which is
 * an ordinary thing on a store that is also compiling a PDF.
 */
describe('two auto-saves of one resume', () => {
  /** Resolve the returned promise to let the nth PUT finish. */
  function serve() {
    const fixture = makeTempStore();
    const data = fixture.store.load();
    fixture.cleanup();

    const puts = [];
    const held = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, init = {}) => {
        const method = init.method ?? 'GET';
        let result = {};
        if (url === '/api/store') result = data;
        else if (url === '/api/ai/jobs') result = { jobs: [] };
        else if (url === '/api/config') {
          result = { ai: { enabled: false }, latex: {}, git: {}, output: {}, overrides: {}, resumes: {} };
        } else if (url === '/api/resumes/expiring') result = { due: [] };
        else if (String(url).startsWith('/api/render')) {
          result = { pages: 1, fits: true, adjustments: [], warnings: [], lost: [], pdfUrl: '/pdf/x.pdf' };
        } else if (String(url).startsWith('/api/resumes/') && method === 'PUT') {
          const spec = JSON.parse(init.body);
          puts.push(spec);
          /*
           * The first one is held open. Everything after it answers at once,
           * which is what puts two writes of one file in the air together.
           */
          if (puts.length === 1) {
            await new Promise((go) => held.push(go));
          }
          const at = data.resumes.findIndex((r) => r.id === spec.id);
          if (at >= 0) Object.assign(data.resumes[at], spec);
          result = spec;
        }
        return { ok: true, json: async () => structuredClone(result) };
      }),
    );
    return { data, puts, letGo: () => held.forEach((go) => go()) };
  }

  /** Tick an entry off, which is an edit to the resume document. */
  function untick(title) {
    const row = [...document.querySelectorAll('#editor .entry')].find(
      (e) => e.querySelector('.title')?.textContent === title,
    );
    expect(row, `an entry called ${title}`).toBeTruthy();
    row.querySelector(':scope > .entry-head input[type=checkbox]').click();
  }

  const shownIn = (spec) => spec?.sections?.find((s) => s.kind === 'experience')?.entries ?? [];

  it('lands in the order they were made, not the order they answer', async () => {
    vi.resetModules();
    document.documentElement.innerHTML = fs.readFileSync('web/index.html', 'utf8');
    window.location.hash = '#resumes';
    const { data, puts, letGo } = serve();
    await import('../web/app.js');
    await vi.waitFor(() => expect(document.querySelectorAll('#editor .entry').length).toBeGreaterThan(1));

    // The first edit, and its write is still in the air.
    untick('Acme Co.');
    await vi.waitFor(() => expect(puts.length).toBe(1), { timeout: 4000 });

    // A second edit while it is.
    untick('Thing');
    // Nothing else may be sent while the first is unanswered: two writes of
    // one file in flight together is the whole bug.
    await new Promise((go) => setTimeout(go, 1500));
    expect(puts.length, 'the second write waits for the first').toBe(1);

    letGo();
    await vi.waitFor(() => expect(puts.length).toBe(2), { timeout: 4000 });

    // And the one that lands last is the later edit, carrying both changes.
    const last = puts.at(-1);
    expect(shownIn(last)).not.toContain('exp_acme');
    expect(shownIn(last)).not.toContain('exp_thing');

    // The store the editor is holding agrees with what it just sent, rather
    // than with the reply that came back out of order.
    await vi.waitFor(() => {
      const stored = data.resumes.find((r) => r.id === last.id);
      expect(shownIn(stored)).toEqual(shownIn(last));
    });
  });
});
