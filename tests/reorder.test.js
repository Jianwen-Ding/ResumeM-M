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
 * Order is a decision on a resume, and until now it was one you could only
 * make by editing YAML. Which job is at the top of the page, and which
 * achievement is the first line under it, is most of what tailoring a resume
 * actually consists of.
 *
 * The interesting mistakes in a reorder are all off-by-one and none of them
 * are visible in a drag, so the arithmetic is tested directly and the wiring
 * is tested through the page.
 */

/*
 * Three jobs and three lines under one of them.
 *
 * The bundled example store holds exactly one entry per section, which is a
 * perfectly good example and cannot exercise an ordering at all: a list of one
 * has no second position to move anything to. Written out here so the order
 * under test is the order in this file.
 */
function serve() {
  const bullet = (id, text) => ({ id, default: 'v', variants: [{ id: 'v', label: 'Neutral', text }] });
  const entries = [
    { id: 'j1', kind: 'experience', title: 'Everclear', dates: 'Jul. 2024 -- Dec. 2024',
      bullets: [bullet('b1', 'Built the pipeline'), bullet('b2', 'Cut the latency'), bullet('b3', 'Wrote the runbook')] },
    { id: 'j2', kind: 'experience', title: 'Northwind', dates: 'Jun. 2023 -- Aug. 2023', bullets: [bullet('b4', 'Shipped the thing')] },
    { id: 'j3', kind: 'experience', title: 'Helios', dates: 'Jan. 2022 -- May 2022', bullets: [bullet('b5', 'Held the pager')] },
  ];

  const fixture = makeTempStore();
  const loaded = fixture.store.load();
  fixture.cleanup();

  const data = {
    ...loaded,
    entries,
    skillGroups: [],
    resumes: [
      {
        id: 'base',
        label: 'Base',
        base: true,
        sections: [{ kind: 'experience', entries: ['j1', 'j2', 'j3'] }],
      },
    ],
  };

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url) => {
      let result = {};
      if (url === '/api/store') result = data;
      else if (url === '/api/ai/jobs') result = { jobs: [] };
      else if (url === '/api/render') {
        result = { pages: 1, fits: true, overflowLines: -4, adjustments: [], warnings: [], pdfUrl: '/pdf/x.pdf' };
      }
      return { ok: true, json: async () => structuredClone(result) };
    }),
  );
}

/** Longer than the editor's compile debounce (350ms) and its auto-save (900ms). */
const LIVE_SETTLE_MS = 1500;

/** Drive a drag from one row's grip to another row, as the browser would. */
function dragOnto(fromRow, ontoRow, { after = false } = {}) {
  const data = new Map();
  const dataTransfer = {
    setData: (k, v) => data.set(k, v),
    getData: (k) => data.get(k) ?? '',
    effectAllowed: '',
    dropEffect: '',
  };
  fromRow.querySelector(':scope > .entry-head > .grip, :scope > .bullet-head > .grip').dispatchEvent(
    Object.assign(new window.Event('dragstart', { bubbles: true }), { dataTransfer }),
  );

  // The drop lands before or after depending on which half of the row the
  // pointer is in, so the geometry has to be answered for jsdom, which lays
  // nothing out.
  ontoRow.getBoundingClientRect = () => ({ top: 0, height: 100, bottom: 100, left: 0, right: 0, width: 0 });
  ontoRow.dispatchEvent(
    Object.assign(new window.Event('dragover', { bubbles: true, cancelable: true }), {
      dataTransfer,
      clientY: after ? 80 : 20,
    }),
  );
  ontoRow.dispatchEvent(Object.assign(new window.Event('drop', { bubbles: true, cancelable: true }), { dataTransfer }));
}

describe('putting the entries of a resume in the order you want them', () => {
  const entries = () => [...document.querySelectorAll('#editor .entry:not(.off):not(.profile-entry)')];
  const titles = () => entries().map((e) => e.querySelector('.title')?.textContent);

  beforeEach(async () => {
    vi.resetModules();
    document.documentElement.innerHTML = fs.readFileSync('web/index.html', 'utf8');
    window.location.hash = '#resumes';

    serve();

    await import('../web/app.js');
    await vi.waitFor(() => expect(entries().length).toBeGreaterThan(1));
  });

  it('offers a grip on every entry that has somewhere to go', () => {
    for (const row of entries()) expect(row.querySelector(':scope > .entry-head > .grip')).not.toBeNull();
  });

  it('moves an entry up when it is dropped on the one above it', () => {
    const before = titles();
    if (before.length < 2) return;
    dragOnto(entries()[1], entries()[0]);
    expect(titles()).toEqual([before[1], before[0], ...before.slice(2)]);
  });

  /*
   * Dropping onto the lower half means after, and it is the only way to reach
   * the bottom of the list at all — without it the last position is
   * unreachable, which is the classic thing to leave out of a reorder.
   */
  it('moves an entry to the very bottom, which needs the lower half of the last row', () => {
    const before = titles();
    if (before.length < 2) return;
    dragOnto(entries()[0], entries()[before.length - 1], { after: true });
    expect(titles()).toEqual([...before.slice(1), before[0]]);
  });

  it('moves with the keyboard, for anyone not holding a mouse', () => {
    const before = titles();
    if (before.length < 2) return;
    const grip = entries()[0].querySelector(':scope > .entry-head > .grip');
    grip.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true }));
    expect(titles()).toEqual([before[1], before[0], ...before.slice(2)]);
  });

  it('ignores an arrow key pressed without Alt, which is how you leave a button', () => {
    const before = titles();
    entries()[0].querySelector(':scope > .entry-head > .grip').dispatchEvent(
      new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
    );
    expect(titles()).toEqual(before);
  });

  /*
   * A bullet dragged over the entry list must not reorder entries, and the
   * reverse. Both are drag sources on one screen and both are lists of rows
   * with grips on them.
   */
  it('does not let a bullet be dropped into the entry list', () => {
    const bullet = document.querySelector('#editor .bullet > .bullet-head > .grip');
    if (!bullet) return;
    const before = titles();
    const data = new Map();
    const dataTransfer = { setData: (k, v) => data.set(k, v), getData: (k) => data.get(k) ?? '' };
    bullet.dispatchEvent(Object.assign(new window.Event('dragstart', { bubbles: true }), { dataTransfer }));

    const target = entries()[0];
    target.getBoundingClientRect = () => ({ top: 0, height: 100, bottom: 100, left: 0, right: 0, width: 0 });
    target.dispatchEvent(
      Object.assign(new window.Event('dragover', { bubbles: true, cancelable: true }), { dataTransfer, clientY: 20 }),
    );
    target.dispatchEvent(Object.assign(new window.Event('drop', { bubbles: true, cancelable: true }), { dataTransfer }));
    expect(titles()).toEqual(before);
  });
});

describe('folding an entry that is switched on', () => {
  const firstEntry = () => document.querySelector('#editor .entry:not(.off):not(.profile-entry)');

  beforeEach(async () => {
    vi.resetModules();
    localStorage.clear();
    document.documentElement.innerHTML = fs.readFileSync('web/index.html', 'utf8');
    window.location.hash = '#resumes';

    serve();

    await import('../web/app.js');
    await vi.waitFor(() => expect(firstEntry()).not.toBeNull());
  });

  /*
   * Switching an entry off already collapsed it, which covers the entries you
   * are not using — and those were never the ones filling the screen. The one
   * with six bullets and three phrasings each is on, on purpose, and you are
   * simply not editing it right now.
   */
  it('folds away the lines of an entry without switching it off', async () => {
    const row = firstEntry();
    expect(row.querySelectorAll('.bullet').length).toBeGreaterThan(0);

    row.querySelector('.fold').click();
    await vi.waitFor(() => expect(firstEntry()?.classList.contains('folded')).toBe(true));

    const folded = firstEntry();
    expect(folded.querySelectorAll('.bullet')).toHaveLength(0);
    // Still on. Folding is about the screen, not about the document.
    expect(folded.classList.contains('off')).toBe(false);
    expect(folded.querySelector('input[type=checkbox]')?.checked).toBe(true);
  });

  it('says how much is folded away, so a folded entry is not a mystery', async () => {
    firstEntry().querySelector('.fold').click();
    await vi.waitFor(() => expect(firstEntry()?.classList.contains('folded')).toBe(true));
    expect(firstEntry()?.querySelector('.chip.count')?.textContent).toMatch(/\d+ lines?/);
  });

  it('unfolds again, bringing every line back', async () => {
    const before = firstEntry().querySelectorAll('.bullet').length;
    firstEntry().querySelector('.fold').click();
    await vi.waitFor(() => expect(firstEntry()?.classList.contains('folded')).toBe(true));
    firstEntry().querySelector('.fold').click();
    await vi.waitFor(() => expect(firstEntry()?.classList.contains('folded')).toBe(false));
    expect(firstEntry().querySelectorAll('.bullet')).toHaveLength(before);
  });

  /*
   * Folding must not reach the compiler. If it did, folding an entry to get it
   * out of the way would silently drop it from the PDF — which is the one
   * outcome that would make the feature dangerous rather than convenient.
   */
  it('changes nothing about what gets compiled', async () => {
    const bodies = () =>
      globalThis.fetch.mock.calls.filter(([url]) => url === '/api/render').map(([, init]) => init?.body);
    await vi.waitFor(() => expect(bodies().length).toBeGreaterThan(0));
    const before = bodies().at(-1);

    firstEntry().querySelector('.fold').click();
    await vi.waitFor(() => expect(firstEntry()?.classList.contains('folded')).toBe(true));

    // Either it never recompiled, or it recompiled to exactly the same spec.
    expect(bodies().at(-1)).toBe(before);
  });
});

/*
 * Folding belongs to the resume, not to the browser.
 *
 * It prints nothing, but which entries you are done with is a fact about the
 * document you are building: it should still be true on another machine, and
 * after the save has been cloned. Kept in localStorage it was a preference
 * that existed on one computer.
 */
describe('where a fold is remembered', () => {
  const firstEntry = () => document.querySelector('#editor .entry:not(.off):not(.profile-entry)');

  beforeEach(async () => {
    vi.resetModules();
    document.documentElement.innerHTML = fs.readFileSync('web/index.html', 'utf8');
    window.location.hash = '#resumes';
    serve();
    await import('../web/app.js');
    await vi.waitFor(() => expect(firstEntry()).not.toBeNull());
  });

  const savedSpecs = () =>
    globalThis.fetch.mock.calls
      .filter(([url]) => String(url).startsWith('/api/resumes/'))
      .map(([, init]) => JSON.parse(init?.body ?? '{}'));
  const renders = () => globalThis.fetch.mock.calls.filter(([url]) => url === '/api/render').length;

  it('puts the fold on the spec that gets saved', async () => {
    firstEntry().querySelector('.fold').click();
    await vi.waitFor(() => expect(firstEntry()?.classList.contains('folded')).toBe(true));
    // Auto-save is debounced; the fold is only real once it has been written.
    await vi.waitFor(() => expect(savedSpecs().at(-1)?.collapsed).toEqual(['j1']), { timeout: 4000 });
  });

  it('keeps nothing in localStorage, which is the machine and not the save', async () => {
    firstEntry().querySelector('.fold').click();
    await vi.waitFor(() => expect(firstEntry()?.classList.contains('folded')).toBe(true));
    expect(localStorage.getItem('rmm.collapsed')).toBeNull();
  });

  /*
   * Folding alters the editor and not the document, so it must not put the
   * preview through a compile. Recompiling for it is not just wasted work: the
   * pane flickers and the fit line drops to "Compiling…" because somebody
   * collapsed a heading.
   *
   * Real timers rather than fake ones, deliberately. Switching to fake timers
   * after the page has booted flushes whatever the boot still had pending, and
   * those renders then look like the fold's — which is exactly the false
   * failure this assertion first produced.
   */
  it('does not recompile, because nothing about the page changed', async () => {
    // Let the boot's own compile finish and settle.
    await vi.waitFor(() => expect(renders()).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, LIVE_SETTLE_MS));
    const before = renders();

    firstEntry().querySelector('.fold').click();
    await vi.waitFor(() => expect(firstEntry()?.classList.contains('folded')).toBe(true));
    // Longer than both debounces, so a scheduled compile would have happened.
    await new Promise((r) => setTimeout(r, LIVE_SETTLE_MS));

    expect(renders()).toBe(before);
    // And it still saved, which is the other half of the bargain.
    await vi.waitFor(() => expect(savedSpecs().at(-1)?.collapsed).toEqual(['j1']), { timeout: 4000 });
  });
});
