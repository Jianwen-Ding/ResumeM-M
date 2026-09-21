// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
});

/*
 * The unsaved edits, and what they are still about.
 *
 * Every tick and every drag in the editor writes into an overlay —
 * `state.entryEdits`, `state.choices` and the rest — which `currentSpec`
 * merges over the resume the store holds. Nothing clears it once it exists:
 * an auto-save folds it into the stored copy and leaves it standing, and
 * while the two agree that is harmless.
 *
 * It stops being harmless the moment something changes the resume outside
 * the overlay, or changes which resume the overlay is about. Both happen
 * through buttons in the editor, and both used to write the overlay's old
 * answer back over the new state on the very next edit.
 */

let puts;
let deletes;
let swept;

function serve({ withTemporary = false } = {}) {
  const fixture = makeTempStore();
  const data = fixture.store.load();
  fixture.cleanup();

  puts = [];
  deletes = [];
  swept = false;
  const resumes = data.resumes;
  if (withTemporary) {
    // A resume built for one posting, which is what the sweep exists to take
    // away once the application is done with.
    resumes.push({
      id: 'temp_helios',
      label: 'Platform Engineer — Helios',
      tier: 'temporary',
      sections: structuredClone(resumes.find((r) => r.id === 'base').sections),
    });
  }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url, init = {}) => {
      const method = init.method ?? 'GET';
      let result = {};
      if (url === '/api/store') result = data;
      else if (url === '/api/ai/jobs') result = { jobs: [] };
      else if (url === '/api/config') {
        result = { ai: { enabled: false }, latex: {}, git: {}, output: {}, overrides: {}, resumes: { temporaryDays: 7 } };
      } else if (url === '/api/resumes/expiring') {
        result = swept ? { due: [] } : { due: [{ id: 'temp_helios', label: 'Platform Engineer — Helios' }] };
      } else if (url === '/api/resumes/sweep' && method === 'POST') {
        swept = true;
        const at = resumes.findIndex((r) => r.id === 'temp_helios');
        if (at >= 0) resumes.splice(at, 1);
        result = { swept: ['temp_helios'], held: [] };
      }
      else if (String(url).startsWith('/api/render')) {
        result = { pages: 1, fits: true, adjustments: [], warnings: [], lost: [], pdfUrl: '/pdf/x.pdf' };
      } else if (String(url).startsWith('/api/entries/') && method === 'PUT') {
        const entry = JSON.parse(init.body);
        const at = data.entries.findIndex((e) => e.id === entry.id);
        if (at >= 0) data.entries[at] = entry;
        else data.entries.push(entry);
        result = entry;
      } else if (String(url).startsWith('/api/entries/') && method === 'DELETE') {
        const id = decodeURIComponent(String(url).split('/').pop().split('?')[0]);
        deletes.push(id);
        data.entries = data.entries.filter((e) => e.id !== id);
        result = { ok: true };
      } else if (String(url).startsWith('/api/resumes/') && method === 'PUT') {
        const spec = JSON.parse(init.body);
        puts.push(spec);
        const at = resumes.findIndex((r) => r.id === spec.id);
        if (at >= 0) Object.assign(resumes[at], spec);
        result = spec;
      }
      return { ok: true, json: async () => structuredClone(result) };
    }),
  );
  return data;
}

/** The entries the last write said this resume's experience section shows. */
const savedExperience = () => puts.at(-1)?.sections?.find((s) => s.kind === 'experience')?.entries ?? [];

async function boot(options) {
  vi.resetModules();
  document.documentElement.innerHTML = fs.readFileSync('web/index.html', 'utf8');
  window.location.hash = '#resumes';
  const data = serve(options);
  await import('../web/app.js');
  await vi.waitFor(() => expect(document.querySelectorAll('#editor .entry').length).toBeGreaterThan(1));
  return data;
}

/**
 * Add an entry to Experience, answering the dialog directly.
 *
 * The one in the Experience heading: every section has a "+ Add entry", and
 * the first on the page belongs to Education — a test that pressed that one
 * would add an education entry and prove nothing about the section whose
 * overlay is under test.
 */
async function addNimbus() {
  const dialog = (async () => {
    await vi.waitFor(() => expect(document.querySelector('#modal [name=title]')).not.toBeNull());
    const title = document.querySelector('#modal [name=title]');
    title.value = 'Nimbus';
    title.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#modal-ok').click();
  })();
  const heading = [...document.querySelectorAll('#editor .section-heading')].find(
    (h) => h.querySelector('.name')?.textContent === 'Experience',
  );
  expect(heading, 'the Experience heading').toBeTruthy();
  const add = [...heading.querySelectorAll('button')].find((b) => /^\+ Add entry$/.test(b.textContent));
  expect(add, 'an add-entry button').toBeTruthy();
  add.click();
  await dialog;
  await vi.advanceTimersByTimeAsync(2000);
}

/** Tick an entry off, which is what puts an overlay on the section. */
async function untick(title) {
  const row = [...document.querySelectorAll('#editor .entry')].find(
    (e) => e.querySelector('.title')?.textContent === title,
  );
  expect(row, `an entry called ${title}`).toBeTruthy();
  row.querySelector(':scope > .entry-head input[type=checkbox]').click();
  await vi.advanceTimersByTimeAsync(1500);
}

describe('an entry added or deleted while a section has unsaved ticks on it', () => {
  beforeEach(async () => {
    await boot();
    vi.useFakeTimers();
  });


  /*
   * Adding wrote the new id into the file and not into the overlay, so the
   * entry was drawn greyed out on the resume it had just been added to — and
   * the next auto-save wrote the overlay back over the file and took the
   * reference out again, leaving the entry in the store belonging to nothing.
   */
  it('keeps a newly added entry on the resume it was added to', async () => {
    await untick('Acme Co.');
    expect(savedExperience()).not.toContain('exp_acme');

    await addNimbus();

    if (process.env.DEBUG_OVERLAY) {
      console.log('PUTS', JSON.stringify(puts.map((p) => [p.id, p.sections?.find((s) => s.kind === 'experience')?.entries])));
      console.log('ENTRY IDS', JSON.stringify(document.querySelectorAll('#editor .entry').length));
    }
    const added = puts.at(-1)?.sections?.find((s) => s.kind === 'experience')?.entries ?? [];
    expect(added.some((id) => /nimbus/.test(id))).toBe(true);

    // And it is still there after the next ordinary edit, which is the save
    // that used to undo it.
    await untick('Thing');
    expect(savedExperience().some((id) => /nimbus/.test(id))).toBe(true);
  });

  /*
   * And the other way round. Deleting took the id out of the file and left it
   * in the overlay, so the next auto-save wrote it straight back — and every
   * compile from then on said `Section "experience" lists entry "…", which
   * does not exist.` The line that drops the reference exists to prevent that
   * exact warning, and was putting it there itself.
   */
  it('takes a deleted entry off the resume for good', async () => {
    await untick('Acme Co.');
    await addNimbus();
    expect(savedExperience().some((id) => /nimbus/.test(id))).toBe(true);

    const row = [...document.querySelectorAll('#editor .entry')].find(
      (e) => e.querySelector('.title')?.textContent === 'Nimbus',
    );
    expect(row, 'the entry that was just added').toBeTruthy();
    const gone = (async () => {
      await vi.waitFor(() => expect(document.querySelector('#modal').classList.contains('hidden')).toBe(false));
      document.querySelector('#modal-ok').click();
    })();
    [...row.querySelectorAll('button')].find((b) => b.textContent === 'Delete').click();
    await gone;
    await vi.advanceTimersByTimeAsync(2000);
    expect(deletes.some((id) => /nimbus/.test(id)), 'the entry itself was deleted').toBe(true);

    // The save that used to put the reference back.
    await untick('Thing');
    expect(savedExperience().some((id) => /nimbus/.test(id))).toBe(false);
  });
});

describe('the resume that was open is deleted underneath the editor', () => {
  /*
   * The sweep is how this happens: it takes away temporary resumes, and one
   * of them can be the one on screen. `loadStore` then quietly moves the
   * editor to another resume — and the overlay stayed behind, still
   * describing the one that went, so the next edit merged its selections over
   * the resume that was left and wrote them to *that* id. Entries switched
   * off and phrasings changed on a document nobody had touched, under "All
   * changes saved", with the undo stack already dropped by the sweep for
   * exactly this kind of reason.
   *
   * Driven through `loadStore` rather than through the Save tab, because that
   * is where the resume changes and the sweep is only one way of getting
   * there — a resume deleted in another window arrives the same way.
   */
  it('does not carry its selections onto the resume left open', async () => {
    const data = await boot({ withTemporary: true });
    vi.useFakeTimers();

    const picker = document.querySelector('#resume-select');
    picker.value = 'temp_helios';
    picker.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.advanceTimersByTimeAsync(600);

    await untick('Acme Co.');
    const onTemp = puts.at(-1);
    expect(onTemp?.id, 'the edit went to the temporary resume').toBe('temp_helios');
    expect(onTemp.sections.find((s) => s.kind === 'experience').entries).not.toContain('exp_acme');

    // Gone, the way the sweep leaves it: out of the store, with the editor
    // still pointed at it.
    data.resumes.splice(data.resumes.findIndex((r) => r.id === 'temp_helios'), 1);

    /*
     * And the store read back, which is what the sweep does after deleting.
     * Reached here by committing an inline edit to a line — `saveEntry`
     * reloads the store, which is the same `loadStore` the sweep calls and
     * the moment `state.resumeId` moves.
     */
    const line = [...document.querySelectorAll('#editor .bullet .editable')][0];
    expect(line, 'a line to edit').toBeTruthy();
    line.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    line.textContent = `${line.textContent} at p95`;
    line.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await vi.advanceTimersByTimeAsync(3000);
    await vi.waitFor(() => expect(document.querySelectorAll('#editor .entry').length).toBeGreaterThan(1));

    await untick('Thing');
    const now = puts.at(-1);
    expect(now.id, 'the edit goes to the resume that is open now').not.toBe('temp_helios');
    /*
     * And carries only what was done to it. `exp_acme` was switched off on
     * the resume that has been deleted; the one left never lost it, and a
     * write that drops it here is the gone resume's overlay landing on
     * somebody else's document.
     */
    expect(now.sections.find((s) => s.kind === 'experience').entries).toContain('exp_acme');
  });
});
