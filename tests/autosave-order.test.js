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

  /**
   * Boot the editor over the stubbed store, with the first PUT held open.
   */
  async function boot() {
    vi.resetModules();
    document.documentElement.innerHTML = fs.readFileSync('web/index.html', 'utf8');
    window.location.hash = '#resumes';
    const served = serve();
    await import('../web/app.js');
    await vi.waitFor(() => expect(document.querySelectorAll('#editor .entry').length).toBeGreaterThan(1));
    return served;
  }

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

/*
 * Deleting a resume while a save of it is still out.
 *
 * `leaveResume` flushes before it moves and says so; `restoreResumeVersion`
 * does the same. `deleteVariation` did neither: it cleared the overlays, set
 * the chip to "saved" and sent the DELETE at once. Clearing the overlays
 * takes care of a save still on its timer — it un-dirties it, so the timer
 * fires into nothing — and does nothing at all about one already in the air.
 *
 * `PUT /resumes/:id` has no existence check; it writes the file. So a save
 * that left before the delete and lands after it puts the resume back. It
 * comes back in the list on the next load, looking like a deletion that did
 * not take — and there is no second confirmation to get rid of it, because
 * as far as the editor is concerned it already did.
 */
describe('deleting a resume with a save of it still out', () => {
  it('waits for the save to land before removing it', async () => {
    vi.resetModules();
    document.documentElement.innerHTML = fs.readFileSync('web/index.html', 'utf8');
    window.location.hash = '#resumes';

    const fixture = makeTempStore();
    const data = fixture.store.load();
    fixture.cleanup();

    const order = [];
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
          order.push('put');
          await new Promise((go) => held.push(go));
          const spec = JSON.parse(init.body);
          const at = data.resumes.findIndex((r) => r.id === spec.id);
          if (at >= 0) Object.assign(data.resumes[at], spec);
          else data.resumes.push(spec); // what the server does: no existence check
          result = spec;
        } else if (String(url).startsWith('/api/resumes/') && method === 'DELETE') {
          order.push('delete');
          const id = decodeURIComponent(String(url).split('/').pop().split('?')[0]);
          data.resumes = data.resumes.filter((r) => r.id !== id);
          result = { ok: true };
        }
        return { ok: true, json: async () => structuredClone(result) };
      }),
    );

    await import('../web/app.js');
    await vi.waitFor(() => expect(document.querySelectorAll('#editor .entry').length).toBeGreaterThan(1));

    const doomed = document.querySelector('#resume-select')?.value;
    expect(doomed, 'a resume is open').toBeTruthy();

    // An edit, whose save goes out and is held open. By title, because the
    // first `.entry` on the page is not always one with a tick on it.
    const row = [...document.querySelectorAll('#editor .entry')].find(
      (e) => e.querySelector(':scope > .entry-head input[type=checkbox]'),
    );
    expect(row, 'an entry that can be ticked off').toBeTruthy();
    row.querySelector(':scope > .entry-head input[type=checkbox]').click();
    await vi.waitFor(() => expect(order).toContain('put'), { timeout: 4000 });

    // And the resume is deleted while that save is still in the air.
    const answered = (async () => {
      await vi.waitFor(() => expect(document.querySelector('#modal')?.classList.contains('hidden')).toBe(false));
      document.querySelector('#modal-ok').click();
    })();
    document.querySelector('#btn-delete-resume').click();
    await answered;

    // Nothing may go out before the save that is already out comes back:
    // a PUT landing after the DELETE writes the file straight back.
    await new Promise((go) => setTimeout(go, 400));
    expect(order, 'the delete waits for the save').toEqual(['put']);

    held.forEach((go) => go());
    await vi.waitFor(() => expect(order).toEqual(['put', 'delete']), { timeout: 4000 });
    expect(data.resumes.some((r) => r.id === doomed), 'and it is gone for good').toBe(false);
  });
});

/*
 * Forking a resume out of an edit that has not landed yet.
 *
 * "Save as variation" builds the copy from `currentSpec()`, which folds in
 * the unsaved overlays — so the new variation is right. Then it clears those
 * overlays and moves to the copy, without ever writing them to the resume
 * they were made on.
 *
 * Which resume keeps the edit therefore depended on how fast you typed. Take
 * longer than the debounce over the name — the usual case — and the original
 * keeps it. Accept the two pre-filled boxes straight away and it does not,
 * and the timer that would have saved it fires into nothing, because
 * clearing the overlays un-dirties them first. The same edit, two answers,
 * neither of them announced.
 */
describe('saving a variation out of an edit that has not landed', () => {
  it('leaves the edit on the resume it was made on', async () => {
    vi.resetModules();
    document.documentElement.innerHTML = fs.readFileSync('web/index.html', 'utf8');
    window.location.hash = '#resumes';

    const fixture = makeTempStore();
    const data = fixture.store.load();
    fixture.cleanup();

    const puts = [];
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
          const at = data.resumes.findIndex((r) => r.id === spec.id);
          if (at >= 0) Object.assign(data.resumes[at], spec);
          else data.resumes.push(spec);
          result = spec;
        }
        return { ok: true, json: async () => structuredClone(result) };
      }),
    );

    await import('../web/app.js');
    await vi.waitFor(() => expect(document.querySelectorAll('#editor .entry').length).toBeGreaterThan(1));

    const original = document.querySelector('#resume-select').value;
    const row = [...document.querySelectorAll('#editor .entry')].find(
      (e) => e.querySelector(':scope > .entry-head input[type=checkbox]'),
    );
    expect(row, 'an entry that can be ticked off').toBeTruthy();
    const ticked = row.querySelector(':scope > .title')?.textContent ?? '';
    row.querySelector(':scope > .entry-head input[type=checkbox]').click();

    /*
     * And forked at once, inside the debounce — both boxes come pre-filled,
     * so accepting them is two presses.
     */
    const answered = (async () => {
      await vi.waitFor(() => expect(document.querySelector('#modal [name=label]')).not.toBeNull());
      document.querySelector('#modal-ok').click();
    })();
    document.querySelector('#btn-save-as').click();
    await answered;

    await vi.waitFor(() => expect(puts.some((p) => p.id !== original)).toBe(true), { timeout: 4000 });

    // The copy is right either way; the question is the resume it came from.
    await vi.waitFor(
      () => expect(puts.some((p) => p.id === original), `${ticked} was written back to ${original}`).toBe(true),
      { timeout: 4000 },
    );
  });
});
