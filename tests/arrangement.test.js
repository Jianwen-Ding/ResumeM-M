// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { makeTempStore } from './helpers.ts';
import { normalizeEntries } from '../src/model/normalize.ts';

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
 * An arrangement, once made, stays made.
 *
 * Which job is at the top of the page and which line is first underneath it
 * is most of what tailoring a resume consists of, and three separate paths
 * quietly threw that decision away. All three had the same shape: read the
 * membership from the list the user is actually looking at, and the order
 * from somewhere else.
 *
 * `reorder.test.js` covers the arithmetic and the drag wiring on a resume
 * whose stored order and displayed order agree. These are the cases where
 * they do not.
 */

let puts;

/**
 * Three jobs, and three lines under the first of them.
 *
 * `bullets` deliberately disagrees with the master's line order, which is not
 * a contrived state: the list is written whenever a line is unticked, and
 * `SectionSpec.bullets` says it is read as a set — so any rearrangement of
 * the master afterwards leaves it stale, by design. `bulletOrder` is absent,
 * which is this resume saying it follows the master.
 */
function serve({ bullets = { j1: ['b3', 'b1', 'b2'] }, bulletOrder } = {}) {
  const bullet = (id, text) => ({ id, default: 'v', variants: [{ id: 'v', label: 'Neutral', text }] });
  const entries = normalizeEntries([
    {
      id: 'j1',
      kind: 'experience',
      title: 'Everclear',
      dates: 'Jul. 2024 -- Dec. 2024',
      bullets: [bullet('b1', 'Built the pipeline'), bullet('b2', 'Cut the latency'), bullet('b3', 'Wrote the runbook')],
    },
    { id: 'j2', kind: 'experience', title: 'Northwind', dates: 'Jun. 2023 -- Aug. 2023', bullets: [bullet('b4', 'Shipped the thing')] },
    { id: 'j3', kind: 'experience', title: 'Helios', dates: 'Jan. 2022 -- May 2022', bullets: [bullet('b5', 'Held the pager')] },
  ]);

  const fixture = makeTempStore();
  const loaded = fixture.store.load();
  fixture.cleanup();

  const base = {
    id: 'base',
    label: 'Base',
    base: true,
    sections: [
      // `newest` is what a section gets when it is made, and it is what makes
      // the drag below a real instruction rather than a no-op: it turns the
      // date sort off, and that has to be written down with the order.
      { kind: 'experience', order: 'newest', entries: ['j1', 'j2', 'j3'], bullets, ...(bulletOrder ? { bulletOrder } : {}) },
    ],
  };
  const data = { ...loaded, entries, skillGroups: [], resumes: [base] };

  puts = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url, init = {}) => {
      let result = {};
      if (url === '/api/store') result = data;
      else if (url === '/api/ai/jobs') result = { jobs: [] };
      else if (url === '/api/render') {
        result = { pages: 1, fits: true, overflowLines: -4, adjustments: [], warnings: [], lost: [], pdfUrl: '/pdf/x.pdf' };
      } else if (String(url).startsWith('/api/resumes/') && init.method === 'PUT') {
        result = JSON.parse(init.body);
        puts.push(result);
        Object.assign(base, result);
      }
      return { ok: true, json: async () => structuredClone(result) };
    }),
  );
}

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
  ontoRow.getBoundingClientRect = () => ({ top: 0, height: 100, bottom: 100, left: 0, right: 0, width: 0 });
  ontoRow.dispatchEvent(
    Object.assign(new window.Event('dragover', { bubbles: true, cancelable: true }), {
      dataTransfer,
      clientY: after ? 80 : 20,
    }),
  );
  ontoRow.dispatchEvent(Object.assign(new window.Event('drop', { bubbles: true, cancelable: true }), { dataTransfer }));
}

const entryRows = () => [...document.querySelectorAll('#editor .entry:not(.off):not(.profile-entry)')];
const entryTitles = () => entryRows().map((e) => e.querySelector('.title')?.textContent);
const firstJob = () => entryRows().find((e) => e.querySelector('.title')?.textContent === 'Everclear');
const lineRows = () => [...firstJob().querySelectorAll(':scope .bullet')];
const textOf = (row) => row.querySelector('.bullet-head .editable, .bullet-head .text')?.textContent.trim();
const lineText = () => lineRows().map(textOf);

async function boot(options) {
  vi.resetModules();
  document.documentElement.innerHTML = fs.readFileSync('web/index.html', 'utf8');
  window.location.hash = '#resumes';
  serve(options);
  await import('../web/app.js');
  await vi.waitFor(() => expect(entryRows().length).toBeGreaterThan(1));
}

describe('dragging a line whose stored order is not the order on screen', () => {
  beforeEach(() => boot());

  it('draws the master’s order, because this resume has not arranged its own', () => {
    expect(lineText()).toEqual(['Built the pipeline', 'Cut the latency', 'Wrote the runbook']);
  });

  /*
   * The whole of it. The drop used to be computed against the stored list —
   * `['b3','b1','b2']` — while the screen showed `[b1,b2,b3]`, so "put the
   * first line last" moved something else entirely, and wrote the result down
   * as a deliberate arrangement.
   */
  it('moves the line you dragged, to where you dropped it', () => {
    const rows = lineRows();
    dragOnto(rows[0], rows[2], { after: true });
    expect(lineText()).toEqual(['Cut the latency', 'Wrote the runbook', 'Built the pipeline']);
  });

  it('and the same with the keyboard', () => {
    const grip = lineRows()[0].querySelector(':scope > .bullet-head > .grip');
    grip.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true }));
    expect(lineText()).toEqual(['Cut the latency', 'Built the pipeline', 'Wrote the runbook']);
  });
});

describe('an arrangement already made, and something ticked afterwards', () => {
  beforeEach(() => boot());

  /*
   * Unticking rebuilt the list from the master's order, so the two lines left
   * came back in the master's order — and `bulletOrder` stayed `manual`, so
   * the chip went on saying "Lines arranged here" about an arrangement that
   * had just been thrown away, and the entry went on ignoring the master it
   * had been silently restacked to match.
   */
  it('keeps the lines where you put them when one of them is switched off', async () => {
    const rows = lineRows();
    dragOnto(rows[2], rows[0]); // "Wrote the runbook" to the top
    expect(lineText()).toEqual(['Wrote the runbook', 'Built the pipeline', 'Cut the latency']);

    const off = lineRows().find((b) => b.textContent.includes('Built the pipeline'));
    off.querySelector('.bullet-head input[type=checkbox]').click();
    await vi.waitFor(() => expect(lineRows().filter((b) => !b.classList.contains('off')).length).toBe(2));

    const on = lineRows().filter((b) => !b.classList.contains('off'));
    expect(on.map(textOf)).toEqual(['Wrote the runbook', 'Cut the latency']);
  });

  /*
   * The same one level up: dragging an entry sets the section to `manual`, so
   * nothing was ever going to put the arrangement back once a tick undid it.
   */
  it('keeps the entries where you put them when one of them is switched off', async () => {
    dragOnto(entryRows()[2], entryRows()[0]); // Helios to the top
    expect(entryTitles()).toEqual(['Helios', 'Everclear', 'Northwind']);

    const off = entryRows().find((e) => e.querySelector('.title')?.textContent === 'Everclear');
    off.querySelector(':scope > .entry-head input[type=checkbox]').click();
    await vi.waitFor(() => expect(entryTitles()).toHaveLength(2));
    expect(entryTitles()).toEqual(['Helios', 'Northwind']);
  });

  /*
   * And it is the arrangement that gets written, not merely the one drawn.
   * Every one of these paths auto-saves, so a screen that recovers on its own
   * over a file that did not would be the worst of the three outcomes.
   */
  it('writes the arrangement it is showing', async () => {
    vi.useFakeTimers();
    dragOnto(entryRows()[2], entryRows()[0]);
    entryRows()
      .find((e) => e.querySelector('.title')?.textContent === 'Everclear')
      .querySelector(':scope > .entry-head input[type=checkbox]')
      .click();
    await vi.advanceTimersByTimeAsync(1500);

    const saved = puts.at(-1);
    expect(saved, 'the edit reached the store').toBeTruthy();
    // "Everclear" was switched off, so it is out of the list; the two that
    // are left are in the order they were dragged into, not the date order.
    expect(saved.sections[0].entries).toEqual(['j3', 'j2']);
    expect(saved.sections[0].order).toBe('manual');
  });
});
