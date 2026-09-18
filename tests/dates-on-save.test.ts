import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { Store } from '../src/model/store.js';
import { withDatesFrom } from '../src/server/api.js';
import type { Entry } from '../src/model/types.js';

/*
 * What happens to the words when the date moves — and, far more importantly,
 * what happens to them when it does not.
 *
 * The editor edits the date and the server writes the text, which is what
 * keeps one implementation of the formatting. The risk in that arrangement is
 * entirely on one side: a rule that regenerated the text whenever a period was
 * present would respell every date in the store the first time each entry was
 * touched for any reason at all. "Jul. 2024" quietly becoming "July 2024"
 * across documents that have been proofread and sent is not a formatting
 * improvement, it is an edit nobody asked for in files nobody is going to
 * re-read.
 *
 * So the condition is narrow: the text is rewritten only when the period
 * disagrees with what the text already says. That happens exactly when the
 * user moved the date, and never when they edited something else on the same
 * entry. This file is that condition, from both sides.
 */

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * A store whose other entries establish a house style, since that is what the
 * rendering is supposed to follow.
 */
function aStore(style = 'Jul. 2024 -- Dec. 2024'): Store {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmm-dates-'));
  made.push(dir);
  fs.mkdirSync(path.join(dir, 'resumes'));
  fs.writeFileSync(path.join(dir, 'profile.yaml'), 'name: Someone\nemail: s@e.com\n');
  fs.writeFileSync(path.join(dir, 'config.yaml'), 'ai:\n  enabled: false\n');
  fs.writeFileSync(
    path.join(dir, 'experience.yaml'),
    YAML.stringify([
      { id: 'other1', kind: 'experience', title: 'A', dates: style },
      { id: 'other2', kind: 'experience', title: 'B', dates: style },
    ]),
  );
  return new Store(dir);
}

const entry = (over: Partial<Entry>): Entry =>
  ({ id: 'e', kind: 'experience', title: 'Everclear', ...over }) as Entry;

describe('keeping an entry’s date text in step with its date', () => {
  it('leaves the words alone when the date has not moved', () => {
    const store = aStore();
    const before = entry({
      dates: 'Jul. 2024 -- Dec. 2024',
      period: { start: { year: 2024, month: 7 }, end: { year: 2024, month: 12 } },
    });
    expect(withDatesFrom(before, store).dates).toBe('Jul. 2024 -- Dec. 2024');
  });

  /*
   * The case the condition exists for. The same date, spelt a way this program
   * would not have spelt it — and the person who wrote it that way has already
   * sent it. Saving a title change on this entry must not touch the date.
   */
  it('leaves a spelling the program would not have chosen, when the date is the same', () => {
    const store = aStore();
    for (const spelling of ['July 2024 - December 2024', '07/2024 -- 12/2024', 'Jul 2024 to Dec 2024']) {
      const kept = withDatesFrom(
        entry({ dates: spelling, period: { start: { year: 2024, month: 7 }, end: { year: 2024, month: 12 } } }),
        store,
      );
      expect(kept.dates).toBe(spelling);
    }
  });

  it('writes the words again once the date really has moved', () => {
    const store = aStore();
    const moved = withDatesFrom(
      entry({ dates: 'Jul. 2024 -- Dec. 2024', period: { start: { year: 2024, month: 7 }, end: { year: 2025, month: 3 } } }),
      store,
    );
    expect(moved.dates).toBe('Jul. 2024 -- Mar. 2025');
  });

  it('writes them in the style the rest of the save already uses', () => {
    // A store that writes months out in full and separates with an en dash.
    const store = aStore('July 2024 – December 2024');
    const moved = withDatesFrom(
      entry({ dates: 'July 2024 – December 2024', period: { start: { year: 2024, month: 7 }, end: { year: 2025, month: 3 } } }),
      store,
    );
    expect(moved.dates).toBe('July 2024 – March 2025');
  });

  it('says Present, in whatever word this store uses for it', () => {
    const store = aStore('Jan. 2023 -- Current');
    const moved = withDatesFrom(
      entry({ dates: 'Jan. 2023 -- Current', period: { start: { year: 2023, month: 1 }, ongoing: true, end: undefined } }),
      store,
    );
    // Unchanged: ongoing already, and the same start.
    expect(moved.dates).toBe('Jan. 2023 -- Current');

    const later = withDatesFrom(
      entry({ dates: 'Jan. 2023 -- Current', period: { start: { year: 2024, month: 2 }, ongoing: true } }),
      store,
    );
    expect(later.dates).toBe('Feb. 2024 -- Current');
  });

  it('marks a date still to come, at the end where it belongs', () => {
    const store = aStore('Sep. 2022 -- May 2026');
    const moved = withDatesFrom(
      entry({
        dates: 'Sep. 2022 -- May 2026',
        period: { start: { year: 2022, month: 9 }, end: { year: 2027, month: 5 }, expected: true },
      }),
      store,
    );
    expect(moved.dates).toBe('Sep. 2022 -- Expected May 2027');
  });

  /*
   * Nothing to go on, nothing to do. An entry saved by any of the forty other
   * routes carries no period, and must come back exactly as it went in.
   */
  it('does nothing to an entry that carries no date', () => {
    const store = aStore();
    expect(withDatesFrom(entry({ dates: 'Two semesters' }), store).dates).toBe('Two semesters');
    expect(withDatesFrom(entry({}), store).dates).toBeUndefined();
    expect(withDatesFrom(entry({ period: {} }), store).dates).toBeUndefined();
  });

  /*
   * A field with alternates is several phrasings, and a period is one date.
   * Rewriting one of the phrasings from it would be picking a winner nobody
   * asked for — the editor writes those itself, per alternate.
   */
  it('will not touch a date that has alternates', () => {
    const store = aStore();
    const field = {
      default: 'v_may',
      variants: [
        { id: 'v_may', label: 'May', text: 'Sep. 2022 -- May 2026' },
        { id: 'v_dec', label: 'Dec', text: 'Sep. 2022 -- Dec. 2026' },
      ],
    };
    const out = withDatesFrom(entry({ dates: field, period: { start: { year: 1999 }, end: { year: 2000 } } }), store);
    expect(out.dates).toEqual(field);
  });

  it('fills in words for a date that had none', () => {
    const store = aStore();
    const out = withDatesFrom(entry({ period: { start: { year: 2024, month: 3 }, ongoing: true } }), store);
    expect(out.dates).toBe('Mar. 2024 -- Present');
  });

  it('gives back a new entry rather than editing the one it was handed', () => {
    const store = aStore();
    const before = entry({ dates: 'Jul. 2024 -- Dec. 2024', period: { start: { year: 2023, month: 1 } } });
    const after = withDatesFrom(before, store);
    expect(before.dates).toBe('Jul. 2024 -- Dec. 2024');
    expect(after.dates).not.toBe(before.dates);
  });

  /*
   * A year is a date. A project dated "2024" whose period says 2024 has not
   * moved, and must not acquire a month it never had.
   */
  it('does not invent a month for a year', () => {
    const store = aStore();
    expect(withDatesFrom(entry({ dates: '2024', period: { start: { year: 2024 } } }), store).dates).toBe('2024');
    expect(
      withDatesFrom(entry({ dates: '2024', period: { start: { year: 2024 }, end: { year: 2026 } } }), store).dates,
    ).toBe('2024 -- 2026');
  });
});
