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
});

/*
 * The date on an entry, edited as a date.
 *
 * It was a text box holding "Jul. 2024 -- Dec. 2024" — the one field a person
 * has to get exactly right for the program to sort by it, and the one the
 * program could not check, because any string is a valid string. What prints
 * is still that text; what is edited is no longer it.
 */
describe('editing the date on an entry', () => {
  let saved;

  const entries = () => [...document.querySelectorAll('#editor .entry:not(.off):not(.profile-entry)')];
  const rowFor = (title) => entries().find((e) => e.querySelector('.title')?.textContent === title);
  const dates = (title) => rowFor(title)?.querySelector('.dates');
  const lastSave = () => saved.at(-1);

  async function open(entryList) {
    vi.resetModules();
    saved = [];
    document.documentElement.innerHTML = fs.readFileSync('web/index.html', 'utf8');
    window.location.hash = '#resumes';

    const fixture = makeTempStore();
    const loaded = fixture.store.load();
    fixture.cleanup();

    const data = {
      ...loaded,
      entries: normalizeEntries(entryList),
      skillGroups: [],
      resumes: [{ id: 'base', label: 'Base', base: true, sections: [{ kind: 'experience', entries: entryList.map((e) => e.id) }] }],
    };

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, init) => {
        if (String(url).startsWith('/api/entries/') && init?.method === 'PUT') {
          const body = JSON.parse(init.body);
          saved.push(body);
          /*
           * Persisted, as a server would. Without this the store handed back
           * by the next `/api/store` still holds the old date, and the editor
           * redraws the change away — which is a fact about this stub and not
           * about the editor.
           */
          const at = data.entries.findIndex((e) => e.id === body.id);
          if (at >= 0) data.entries[at] = { ...data.entries[at], ...body };
          return { ok: true, json: async () => body };
        }
        let result = {};
        if (url === '/api/store') result = data;
        else if (url === '/api/ai/jobs') result = { jobs: [] };
        else if (url === '/api/render') {
          result = { pages: 1, fits: true, overflowLines: -4, adjustments: [], warnings: [], pdfUrl: '/pdf/x.pdf' };
        }
        return { ok: true, json: async () => structuredClone(result) };
      }),
    );

    await import('../web/app.js');
    await vi.waitFor(() => expect(entries().length).toBe(entryList.length));
  }

  const JOB = { id: 'j1', kind: 'experience', title: 'Everclear', dates: 'Jul. 2024 -- Dec. 2024' };
  const PROJECT = { id: 'p1', kind: 'experience', title: 'Side project', dates: '2024' };
  const ONGOING = { id: 'j2', kind: 'experience', title: 'Current', dates: 'Jan. 2025 -- Present' };
  const VAGUE = { id: 'v1', kind: 'experience', title: 'Unclear', dates: 'Two semesters' };

  it('shows two ends and their months, not a line of text', async () => {
    await open([JOB]);
    const box = dates('Everclear');
    expect(box).not.toBeNull();
    const [from, to] = [...box.querySelectorAll('.date-end')];
    expect(from.querySelector('.date-month').value).toBe('7');
    expect(from.querySelector('.date-year').value).toBe('2024');
    expect(to.querySelector('.date-month').value).toBe('12');
    expect(to.querySelector('.date-year').value).toBe('2024');
  });

  /*
   * The request that started this: a project is a range too. "2024" is a
   * perfectly good date for one, and the same control has to take both without
   * forcing a month onto a year nobody has a month for.
   */
  it('gives a project the same range, with the months left blank', async () => {
    await open([PROJECT]);
    const box = dates('Side project');
    const [from, to] = [...box.querySelectorAll('.date-end')];
    expect(from.querySelector('.date-month').value).toBe('');
    expect(from.querySelector('.date-year').value).toBe('2024');
    // The far end is offered and empty, which is how a year becomes a range.
    expect(to.querySelector('.date-year').value).toBe('');
  });

  it('turns a year into a range when the far end is filled in', async () => {
    await open([PROJECT]);
    const to = [...dates('Side project').querySelectorAll('.date-end')][1];
    const year = to.querySelector('.date-year');
    year.value = '2026';
    year.dispatchEvent(new window.Event('change'));

    await vi.waitFor(() => expect(lastSave()).toBeDefined());
    expect(lastSave().period).toEqual({ start: { year: 2024 }, end: { year: 2026 } });
  });

  it('sends a month when one is chosen', async () => {
    await open([JOB]);
    const from = [...dates('Everclear').querySelectorAll('.date-end')][0];
    const month = from.querySelector('.date-month');
    month.value = '6';
    month.dispatchEvent(new window.Event('change'));

    await vi.waitFor(() => expect(lastSave()).toBeDefined());
    expect(lastSave().period.start).toEqual({ year: 2024, month: 6 });
  });

  /*
   * Still going hides the far end rather than leaving a box that does nothing,
   * and drops any end that was there — a period cannot be both.
   */
  it('drops the far end when the work is still going', async () => {
    await open([JOB]);
    const box = dates('Everclear');
    const still = [...box.querySelectorAll('.date-switch')].find((l) => l.textContent.includes('Still going'));
    still.querySelector('input').click();

    await vi.waitFor(() => expect(lastSave()).toBeDefined());
    expect(lastSave().period).toEqual({ start: { year: 2024, month: 7 }, ongoing: true });
    await vi.waitFor(() => expect(dates('Everclear').querySelectorAll('.date-end')).toHaveLength(1));
  });

  it('opens an ongoing entry with one end and the switch already on', async () => {
    await open([ONGOING]);
    const box = dates('Current');
    expect(box.querySelectorAll('.date-end')).toHaveLength(1);
    const still = [...box.querySelectorAll('.date-switch')].find((l) => l.textContent.includes('Still going'));
    expect(still.querySelector('input').checked).toBe(true);
  });

  it('marks a date still to come, for a graduation', async () => {
    await open([JOB]);
    const notYet = [...dates('Everclear').querySelectorAll('.date-switch')].find((l) => l.textContent.includes('Not yet'));
    notYet.querySelector('input').click();
    await vi.waitFor(() => expect(lastSave()).toBeDefined());
    expect(lastSave().period.expected).toBe(true);
  });

  /*
   * A date nothing could read keeps its text box. Replacing "Two semesters"
   * with two blank month-and-year boxes would throw away what the person wrote
   * in order to offer a control they did not ask for — and the only real
   * consequence, that it will not sort, is worth saying instead.
   */
  it('leaves an unreadable date as text, and says what that costs', async () => {
    await open([VAGUE]);
    const row = rowFor('Unclear');
    expect(row.querySelector('.dates')).toBeNull();
    expect(row.textContent).toContain('Two semesters');
    const chip = [...row.querySelectorAll('.chip')].find((c) => c.textContent === 'not a date');
    expect(chip).toBeDefined();
    expect(chip.title).toMatch(/sorted/i);
  });

  /*
   * The control sends the date and nothing else. What the resume prints is
   * rendered by the server, in the style the rest of the store already writes
   * dates in — which is the whole reason there is one implementation of the
   * formatting rather than one here and one there.
   */
  it('sends the date and leaves the wording to the server', async () => {
    await open([JOB]);
    const from = [...dates('Everclear').querySelectorAll('.date-end')][0];
    from.querySelector('.date-year').value = '2023';
    from.querySelector('.date-year').dispatchEvent(new window.Event('change'));

    await vi.waitFor(() => expect(lastSave()).toBeDefined());
    // The text it was loaded with, untouched by the browser.
    expect(lastSave().dates).toBe('Jul. 2024 -- Dec. 2024');
    expect(lastSave().period.start.year).toBe(2023);
  });

  it('does not save a half-typed year', async () => {
    await open([JOB]);
    const from = [...dates('Everclear').querySelectorAll('.date-end')][0];
    const year = from.querySelector('.date-year');
    year.value = '20';
    year.dispatchEvent(new window.Event('change'));
    // 20 is not a year; the start goes away and there is nothing to record.
    await new Promise((r) => setTimeout(r, 50));
    expect(saved).toHaveLength(0);
  });
});
