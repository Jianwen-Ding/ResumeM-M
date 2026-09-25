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
 * Two sections of one kind, ticked in the editor.
 *
 * A resume can hold two `custom` sections — "Awards" and "Leadership" — and
 * the resolver, the flattening and `currentSpec` all keep them apart. The
 * unsaved ticks did not: `state.entryEdits` was keyed by the section's kind,
 * so switching an entry off under Awards wrote one list for "custom", and
 * that list was then read as the selection of *both* sections. Leadership
 * lost its entries on screen and in the next auto-save, which the server
 * then compiled — a tick in one section changing another.
 */

let puts;

function serve() {
  const fixture = makeTempStore();
  const data = fixture.store.load();
  fixture.cleanup();

  data.entries.push(
    { id: 'c_award', kind: 'custom', title: 'Dean’s List', bullets: [] },
    { id: 'c_lead', kind: 'custom', title: 'Robotics Club President', bullets: [] },
  );
  for (const resume of data.resumes) {
    resume.sections = [
      ...(resume.sections ?? []),
      { kind: 'custom', heading: 'Awards', entries: ['c_award'] },
      { kind: 'custom', heading: 'Leadership', entries: ['c_lead'] },
    ];
  }

  puts = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url, init = {}) => {
      const method = init.method ?? 'GET';
      let result = {};
      if (url === '/api/store') result = data;
      else if (url === '/api/ai/jobs') result = { jobs: [] };
      else if (url === '/api/config') {
        result = { ai: { enabled: false }, latex: {}, git: {}, output: {}, overrides: {}, resumes: { temporaryDays: 7 } };
      } else if (url === '/api/resumes/expiring') result = { due: [] };
      else if (String(url).startsWith('/api/render')) {
        result = { pages: 1, fits: true, adjustments: [], warnings: [], lost: [], pdfUrl: '/pdf/x.pdf' };
      } else if (String(url).startsWith('/api/resumes/') && method === 'PUT') {
        const spec = JSON.parse(init.body);
        puts.push(spec);
        const at = data.resumes.findIndex((r) => r.id === spec.id);
        if (at >= 0) Object.assign(data.resumes[at], spec);
        result = spec;
      }
      return { ok: true, json: async () => structuredClone(result) };
    }),
  );
}

async function boot() {
  vi.resetModules();
  document.documentElement.innerHTML = fs.readFileSync('web/index.html', 'utf8');
  window.location.hash = '#resumes';
  serve();
  await import('../web/app.js');
  await vi.waitFor(() => expect(document.querySelectorAll('#editor .entry').length).toBeGreaterThan(1));
}

const saved = (heading) => puts.at(-1)?.sections?.find((s) => s.heading === heading)?.entries;

/** Whether the entry called `title` is drawn switched on, in the `n`th row of that name. */
const shownOn = (title, n) =>
  [...document.querySelectorAll('#editor .entry')]
    .filter((e) => e.querySelector('.title')?.textContent === title)
    .map((e) => !e.classList.contains('off'))[n];

describe('two sections of one kind', () => {
  beforeEach(async () => {
    await boot();
    vi.useFakeTimers();
  });

  it('switching an entry off in one leaves the other as it was', async () => {
    // Listed under each section, on in its own and off in the other.
    expect(shownOn('Dean’s List', 0), 'on under Awards').toBe(true);
    expect(shownOn('Robotics Club President', 1), 'on under Leadership').toBe(true);

    const award = [...document.querySelectorAll('#editor .entry')].find(
      (e) => e.querySelector('.title')?.textContent === 'Dean’s List' && !e.classList.contains('off'),
    );
    award.querySelector(':scope > .entry-head input[type=checkbox]').click();
    await vi.advanceTimersByTimeAsync(1500);

    expect(saved('Awards')).toEqual([]);
    expect(saved('Leadership'), 'the other section kept its entry').toEqual(['c_lead']);
    expect(shownOn('Robotics Club President', 1), 'and still shows it').toBe(true);
  });

  it('switching one on in one does not put it in the other', async () => {
    const offUnderAwards = [...document.querySelectorAll('#editor .entry.off')].find(
      (e) => e.querySelector('.title')?.textContent === 'Robotics Club President',
    );
    offUnderAwards.querySelector('input[type=checkbox]').click();
    await vi.advanceTimersByTimeAsync(1500);

    expect(saved('Awards')).toEqual(['c_award', 'c_lead']);
    expect(saved('Leadership')).toEqual(['c_lead']);
  });

  it('adds an entry to the section whose button was pressed, and not to the other', async () => {
    const dialog = (async () => {
      await vi.waitFor(() => expect(document.querySelector('#modal [name=title]')).not.toBeNull());
      const title = document.querySelector('#modal [name=title]');
      title.value = 'Hackathon Winner';
      title.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#modal-ok').click();
    })();
    const headings = [...document.querySelectorAll('#editor .section-heading')].filter(
      (h) => h.querySelector('.name')?.textContent === 'Additional',
    );
    expect(headings).toHaveLength(2);
    [...headings[1].querySelectorAll('button')].find((b) => /^\+ Add entry$/.test(b.textContent)).click();
    await dialog;
    await vi.advanceTimersByTimeAsync(2000);

    expect(saved('Awards')).toEqual(['c_award']);
    expect(saved('Leadership')).toEqual(['c_lead', 'entry_hackathon-winner']);
  });
});
