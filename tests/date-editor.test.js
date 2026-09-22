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

  async function open(entryList, { refuse } = {}) {
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
           * A server that will not take it. Nothing is written down, which is
           * the point: the next `/api/store` still says what it said before,
           * so the editor has to be the thing that puts the date back.
           */
          if (refuse) return { ok: false, json: async () => ({ error: refuse }) };
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
  const SEASON = { id: 's1', kind: 'experience', title: 'Seasonal', dates: 'Summer 2024 -- Dec. 2024' };

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
   * Picking a month on an end that reads as a season.
   *
   * A season prints as itself whatever month is underneath it — the month is
   * only there to sort by — so on "Summer 2024" this dropdown showed Jun,
   * took a change to Jul, saved it, and the text came back "Summer 2024"
   * unchanged. The control did nothing and said nothing about doing nothing,
   * and the next redraw put it back to Jun. Picking a month is saying the
   * month; it does not leave the old word standing.
   */
  it('a month chosen over a season replaces the season', async () => {
    await open([SEASON]);
    const from = [...dates('Seasonal').querySelectorAll('.date-end')][0];
    expect(from.querySelector('.date-month').value).toBe('6');
    const month = from.querySelector('.date-month');
    month.value = '7';
    month.dispatchEvent(new window.Event('change'));

    await vi.waitFor(() => expect(lastSave()).toBeDefined());
    expect(lastSave().period.start).toEqual({ year: 2024, month: 7 });
    expect(lastSave().period.start.season).toBeUndefined();
  });

  /* And blanking it says the year, which is not a season either. */
  it('blanking the month over a season drops the season too', async () => {
    await open([SEASON]);
    const from = [...dates('Seasonal').querySelectorAll('.date-end')][0];
    const month = from.querySelector('.date-month');
    month.value = '';
    month.dispatchEvent(new window.Event('change'));

    await vi.waitFor(() => expect(lastSave()).toBeDefined());
    expect(lastSave().period.start).toEqual({ year: 2024 });
  });

  /*
   * And an end nobody touched keeps its season. The save is a whole period,
   * so a fix that cleared the season everywhere would pass the two above and
   * destroy the word on the end the person was not editing.
   */
  it('and the end nobody touched keeps its own season', async () => {
    await open([SEASON]);
    const to = [...dates('Seasonal').querySelectorAll('.date-end')][1];
    const year = to.querySelector('.date-year');
    year.value = '2025';
    year.dispatchEvent(new window.Event('change'));

    await vi.waitFor(() => expect(lastSave()).toBeDefined());
    expect(lastSave().period.start).toEqual({ year: 2024, month: 6, season: 'summer' });
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
  /*
   * And the write the server will not take.
   *
   * The date is put on screen before it is put on disk, deliberately —
   * `saveEntryPeriod` says why: redrawing from a store that has not heard
   * about the change yet snaps the control back to the old date, and ticking
   * "Still going" left the far end sitting there on an entry that no longer
   * had one. The cost of that is that a *failed* write leaves the new date
   * showing over a save that never took it.
   *
   * Nothing caught it. `datesControl`'s `commit` calls `onChange` and drops
   * the promise, so the rejection went nowhere: no message, and the wrong
   * year still in the box. The store underneath was already right —
   * `inEntryLane` reloads it either way — so the screen and the model
   * disagreed until something unrelated forced a redraw, at which point the
   * date changed back on its own with nothing to explain it.
   */
  const status = () => document.querySelector('#status');

  it('says so when the save is refused, rather than showing the new date', async () => {
    await open([JOB], { refuse: 'The save folder is read-only.' });
    const from = [...dates('Everclear').querySelectorAll('.date-end')][0];
    from.querySelector('.date-year').value = '2023';
    from.querySelector('.date-year').dispatchEvent(new window.Event('change'));

    await vi.waitFor(() => expect(status().textContent).toContain('The save folder is read-only.'));
    expect(status().className).toContain('err');
  });

  it('and puts the date back to what the save still says', async () => {
    await open([JOB], { refuse: 'The save folder is read-only.' });
    const year = () => [...dates('Everclear').querySelectorAll('.date-end')][0].querySelector('.date-year');
    year().value = '2023';
    year().dispatchEvent(new window.Event('change'));

    await vi.waitFor(() => expect(status().textContent).toContain('read-only'));
    // Redrawn from the store, which never took the change.
    await vi.waitFor(() => expect(year().value).toBe('2024'));
  });

  /*
   * And the ordinary case, which must not start reporting anything: a write
   * that lands says what it did and leaves the new date alone. A "fix" that
   * reported every save as a failure would pass both checks above.
   */
  it('while a save that lands says nothing about failing', async () => {
    await open([JOB]);
    const year = () => [...dates('Everclear').querySelectorAll('.date-end')][0].querySelector('.date-year');
    year().value = '2023';
    year().dispatchEvent(new window.Event('change'));

    await vi.waitFor(() => expect(saved.length).toBeGreaterThan(0));
    expect(status().className).not.toContain('err');
    await vi.waitFor(() => expect(year().value).toBe('2023'));
  });
});

/*
 * A graduation date, which is the case the variant system was built for: one
 * education entry, two endings, chosen per resume. It was also the last place
 * still asking you to type "Sep. 2022 -- May 2026" by hand — and to type it
 * the same way twice, since there are two of them.
 */
describe('editing a graduation date that has alternates', () => {
  let saved;

  async function openEdu() {
    vi.resetModules();
    saved = [];
    document.documentElement.innerHTML = fs.readFileSync('web/index.html', 'utf8');
    window.location.hash = '#resumes';

    const fixture = makeTempStore();
    const loaded = fixture.store.load();
    fixture.cleanup();

    const entries = normalizeEntries([
      {
        id: 'edu',
        kind: 'experience',
        title: 'Northeastern',
        dates: {
          default: 'v_may',
          variants: [
            { id: 'v_may', label: 'May 2026 (new grad)', text: 'Sep. 2022 -- May 2026' },
            { id: 'v_dec', label: 'Dec 2026 (intern)', text: 'Sep. 2022 -- Dec. 2026' },
          ],
        },
      },
      // A second entry, so the store has a habit for the style to be read from.
      { id: 'j1', kind: 'experience', title: 'Everclear', dates: 'Jul. 2024 -- Dec. 2024' },
    ]);

    const data = {
      ...loaded,
      entries,
      skillGroups: [],
      resumes: [{ id: 'base', label: 'Base', base: true, sections: [{ kind: 'experience', entries: ['edu', 'j1'] }] }],
    };

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, init) => {
        if (String(url).startsWith('/api/entries/') && init?.method === 'PUT') {
          const body = JSON.parse(init.body);
          saved.push(body);
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
    await vi.waitFor(() => expect(document.querySelector('#editor .field .dates')).not.toBeNull());
  }

  const eduDates = () => document.querySelector('#editor .field .dates');

  it('offers the date as a date, not as a line of text to retype', async () => {
    await openEdu();
    const [from, to] = [...eduDates().querySelectorAll('.date-end')];
    expect(from.querySelector('.date-month').value).toBe('9');
    expect(from.querySelector('.date-year').value).toBe('2022');
    expect(to.querySelector('.date-month').value).toBe('5');
    expect(to.querySelector('.date-year').value).toBe('2026');
  });

  /*
   * The words are written on this side for an alternate, so the assertion that
   * matters is that they come back in the store's own spelling — "May" with no
   * full stop after it, and the "--" this store separates with.
   */
  it('writes the alternate back in the spelling the store already uses', async () => {
    await openEdu();
    const to = [...eduDates().querySelectorAll('.date-end')][1];
    const month = to.querySelector('.date-month');
    month.value = '6';
    month.dispatchEvent(new window.Event('change'));

    await vi.waitFor(() => expect(saved.length).toBeGreaterThan(0));
    const field = saved.at(-1).dates;
    const chosen = field.variants.find((v) => v.id === 'v_may');
    expect(chosen.text).toBe('Sep. 2022 -- Jun. 2026');
  });

  it('leaves the other alternate exactly as it was', async () => {
    await openEdu();
    const to = [...eduDates().querySelectorAll('.date-end')][1];
    to.querySelector('.date-year').value = '2027';
    to.querySelector('.date-year').dispatchEvent(new window.Event('change'));

    await vi.waitFor(() => expect(saved.length).toBeGreaterThan(0));
    const other = saved.at(-1).dates.variants.find((v) => v.id === 'v_dec');
    expect(other.text).toBe('Sep. 2022 -- Dec. 2026');
  });

  it('can say a graduation has not happened yet', async () => {
    await openEdu();
    const notYet = [...eduDates().querySelectorAll('.date-switch')].find((l) => l.textContent.includes('Not yet'));
    notYet.querySelector('input').click();
    await vi.waitFor(() => expect(saved.length).toBeGreaterThan(0));
    const chosen = saved.at(-1).dates.variants.find((v) => v.id === 'v_may');
    expect(chosen.text).toBe('Sep. 2022 -- Expected May 2026');
  });

});
