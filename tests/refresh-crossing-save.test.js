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
 * A look at the store that a save overtook.
 *
 * Coming back to the tab, or the side panel saying the save changed
 * underneath, reads the whole store again (`refreshOnReturn`). It stood aside
 * when an edit was pending as it started, and again when one had started by
 * the time the read came back — but the read had already been put in place
 * of the editor's copy of the store by then, so standing aside only kept the
 * screen from being redrawn. Whatever was saved while the read was out was
 * missing from the copy the editor went on holding.
 *
 * Measured in JobHelper's side panel, which asks for that read every few
 * seconds while the save is changing: a line switched off, and the panel
 * following another tab a moment later — a save, then a move, both inside
 * one read of the store. On coming back the line was on again, and the next
 * edit to that resume wrote it back on disk, under "All changes saved".
 *
 * Here the read is held open, and answers with the store as it was when it
 * was asked, which is what a server does.
 */
describe('a store read that a save crossed', () => {
  function serve() {
    const fixture = makeTempStore();
    const data = fixture.store.load();
    fixture.cleanup();

    const puts = [];
    const reads = { hold: false, held: [] };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, init = {}) => {
        const method = init.method ?? 'GET';
        let result = {};
        if (url === '/api/store') {
          // Read now, answered later.
          result = structuredClone(data);
          if (reads.hold) await new Promise((go) => reads.held.push(go));
        } else if (url === '/api/ai/jobs') result = { jobs: [] };
        else if (url === '/api/config') {
          result = { ai: { enabled: false }, latex: {}, git: {}, output: {}, overrides: {}, resumes: {} };
        } else if (url === '/api/resumes/expiring') result = { due: [] };
        else if (String(url).startsWith('/api/render')) {
          result = { pages: 1, fits: true, adjustments: [], warnings: [], lost: [], pdfUrl: '/pdf/x.pdf' };
        } else if (String(url).startsWith('/api/resumes/') && method === 'PUT') {
          const spec = JSON.parse(init.body);
          puts.push(spec);
          const at = data.resumes.findIndex((r) => r.id === spec.id);
          if (at >= 0) data.resumes[at] = structuredClone(spec);
          result = spec;
        }
        return { ok: true, json: async () => structuredClone(result) };
      }),
    );
    return { data, puts, reads };
  }

  const entryRow = (title) =>
    [...document.querySelectorAll('#editor .entry')].find((e) => e.querySelector('.title')?.textContent === title);
  /** An entry's own switch: in its head when on, first on its one line when off. */
  const box = (title) => entryRow(title)?.querySelector(':scope > .entry-head input[type=checkbox], :scope > .toggle input[type=checkbox]');
  const shownIn = (spec) => spec?.sections?.find((s) => s.kind === 'experience')?.entries ?? [];

  /** Pick a resume in the editor's own dropdown, and wait for the move. */
  async function pick(id) {
    const select = document.querySelector('#resume-select');
    // Drawn again once the move is made: the options are built anew.
    const drawn = select.options[0];
    select.value = id;
    select.dispatchEvent(new Event('change'));
    await vi.waitFor(
      () => {
        expect(select.options[0]).not.toBe(drawn);
        expect(select.value).toBe(id);
      },
      { timeout: 4000 },
    );
  }

  it('does not put back what was saved while it was out', async () => {
    vi.resetModules();
    document.documentElement.innerHTML = fs.readFileSync('web/index.html', 'utf8');
    window.location.hash = '#resumes/newgrad';
    const { data, puts, reads } = serve();
    await import('../web/app.js');
    await vi.waitFor(() => expect(box('Acme Co.')).toBeTruthy());
    expect(box('Acme Co.').checked).toBe(true);

    // Back to the tab: the store is read again, and that read is slow.
    reads.hold = true;
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await new Promise((go) => setTimeout(go, 0));
    expect(reads.held.length, 'the read is out').toBe(1);
    reads.hold = false;

    // While it is: a line switched off, and straight on to another resume,
    // which writes it first.
    box('Acme Co.').click();
    await pick('intern');
    expect(shownIn(puts.at(-1)), 'switching resume saved the edit').not.toContain('exp_acme');
    expect(shownIn(data.resumes.find((r) => r.id === 'newgrad'))).not.toContain('exp_acme');

    // The read comes back, with the store as it was before that save.
    reads.held.forEach((go) => go());
    await new Promise((go) => setTimeout(go, 20));

    // Back on the resume: the line is still off, on screen…
    await pick('newgrad');
    await vi.waitFor(() => expect(box('Thing')).toBeTruthy());
    expect(box('Acme Co.').checked, 'the switched-off line is still off').toBe(false);

    // …and the next edit to it does not write it back on.
    const sent = puts.length;
    box('Thing').click();
    await vi.waitFor(() => expect(puts.length).toBeGreaterThan(sent), { timeout: 4000 });
    const last = puts.at(-1);
    expect(last.id).toBe('newgrad');
    expect(shownIn(last), 'the next save keeps the earlier edit').not.toContain('exp_acme');
    expect(shownIn(data.resumes.find((r) => r.id === 'newgrad'))).not.toContain('exp_acme');
  });
});
