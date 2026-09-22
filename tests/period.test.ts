import { describe, expect, it } from 'vitest';
import {
  DEFAULT_STYLE,
  endsBeforeItStarts,
  formatPeriod,
  inferStyle,
  parsePeriod,
  sortKey,
  startKey,
  styleOf,
  type DateStyle,
} from '../src/model/period.js';

/*
 * The corpus, rather than examples chosen to pass.
 *
 * Every one of these is a shape someone actually writes in this field. The
 * point of listing them together is that the round-trip property below is
 * asserted over all of them at once: a parser that handles the four in the
 * bundled store and mangles the rest would look perfect from inside a test
 * written around the bundled store.
 */
const ROUND_TRIPS = [
  '2026',
  '2022 -- 2026',
  'Sep. 2022 -- May 2026',
  'Jul. 2024 -- Dec. 2024',
  'Sep 2022 -- May 2026',
  'September 2022 -- May 2026',
  'May 2026',
  'Jan. 2023 -- Present',
  'January 2023 -- Present',
  '2023 -- Present',
  'Summer 2024',
  'Fall 2023 -- Dec. 2023',
  'Expected May 2027',
  'Sep. 2022 -- Expected May 2027',
  '09/2022 -- 05/2026',
];

/*
 * And the ones that are the same date said differently. These cannot round-trip
 * through a single style — that is the whole reason a store keeps its original
 * text — but they must still parse, because an entry whose date cannot be read
 * is an entry that cannot be sorted.
 */
const READABLE_BUT_RESPELT = [
  ['2022-09 -- 2026-05', { start: { year: 2022, month: 9 }, end: { year: 2026, month: 5 } }],
  ['Sept 2022', { start: { year: 2022, month: 9 } }],
  ['Jan 2023 – Present', { start: { year: 2023, month: 1 }, ongoing: true }],
  ['Jan 2023 — Present', { start: { year: 2023, month: 1 }, ongoing: true }],
  ['Jan 2023 to Present', { start: { year: 2023, month: 1 }, ongoing: true }],
  ['2021-2024', { start: { year: 2021 }, end: { year: 2024 } }],
  ['May 2026 (expected)', { start: { year: 2026, month: 5 }, expected: true }],
  ['Anticipated: May 2027', { start: { year: 2027, month: 5 }, expected: true }],
  ['Autumn 2023', { start: { year: 2023, month: 9 }, season: 'fall' }],
  ['2024, July', { start: { year: 2024, month: 7 } }],
] as const;

/** Things in this field that are not dates, and must be left alone. */
const NOT_DATES = ['', '   ', 'Various', 'Ongoing since university', 'Two semesters', '20', '202', 'Summer', 'May'];

describe('reading a date out of the words someone wrote', () => {
  it.each(ROUND_TRIPS)('reads and rewrites %j unchanged', (text) => {
    const period = parsePeriod(text);
    expect(period, `did not parse: ${text}`).toBeDefined();
    // The style comes out of the same string, which is what the migration does
    // for a whole store at once.
    const style: DateStyle = { ...DEFAULT_STYLE, ...styleOf(text) };
    expect(formatPeriod(period, style)).toBe(text);
  });

  it.each(READABLE_BUT_RESPELT)('reads %j even though it cannot write it back', (text, expected) => {
    expect(parsePeriod(text)).toMatchObject(expected);
  });

  it.each(NOT_DATES)('says there is no date in %j rather than guessing', (text) => {
    expect(parsePeriod(text)).toBeUndefined();
  });

  /*
   * `2024-07` is one date. Read as a range it becomes "the year 2024 until the
   * year 7", which parses, sorts wrongly, and looks fine in the editor.
   */
  it('does not read a numeric month as the far end of a range', () => {
    expect(parsePeriod('2024-07')).toEqual({ start: { year: 2024, month: 7 } });
  });

  it('keeps a season as a season, and still knows when it is', () => {
    const summer = parsePeriod('Summer 2024');
    expect(summer).toMatchObject({ season: 'summer', start: { year: 2024, month: 6 } });
    expect(formatPeriod(summer, DEFAULT_STYLE)).toBe('Summer 2024');
  });
});

describe('the way a store already writes dates', () => {
  it('takes the majority, not the first entry', () => {
    /*
     * One project dated "2024" says nothing about month spelling, and one
     * hand-typed outlier must not decide the shape of every date written from
     * here on.
     */
    const style = inferStyle(['2024', 'Sep. 2022 -- May 2026', 'Jul. 2024 -- Dec. 2024', 'January 2020 -- Present']);
    expect(style.month).toBe('abbrDot');
    expect(style.range).toBe(' -- ');
    expect(style.present).toBe('Present');
  });

  /*
   * May is its own abbreviation, so it is evidence of nothing.
   *
   * `monthFromWord` tried the long names first, and "May" matches there, so
   * every May reported the *long* style. `formatMonth` already had the
   * symmetric guard on the writing side — "May." is not a thing anyone
   * writes — and the reading side had none.
   *
   * On one string it respells the other end: "May 2023 -- Aug. 2023" came
   * back "May 2023 -- August 2023", which is the invariant this module is
   * written around broken on a summer internship.
   *
   * Store-wide it is worse, because the style is a vote. Three internships
   * and a degree — the most ordinary new-grad save there is — carried three
   * Mays against two `Sep.`/`Jan.`, so the whole save inferred long months,
   * and every entry touched afterwards was rewritten into them one at a time.
   */
  it('takes no vote from a month that is its own abbreviation', () => {
    expect(styleOf('May 2023 -- Aug. 2023').month).toBe('abbrDot');
    const asTyped = 'May 2023 -- Aug. 2023';
    // The way a real caller reads a style: the store's habit, with whatever
    // this particular string is able to say laid over it.
    expect(formatPeriod(parsePeriod(asTyped), { ...DEFAULT_STYLE, ...styleOf(asTyped) })).toBe(asTyped);

    const ordinary = [
      'Sep. 2022 -- May 2026',
      'May 2024 -- Aug. 2024',
      'May 2023 -- Aug. 2023',
      'May 2022 -- Aug. 2022',
      'Jan. 2025 -- Present',
    ];
    expect(inferStyle(ordinary).month).toBe('abbrDot');
  });

  /*
   * And a store that really does write long months still says so — the point
   * is that May abstains, not that it votes the other way.
   */
  it('still hears a store that writes months out in full', () => {
    expect(inferStyle(['January 2020 -- May 2024', 'September 2021 -- December 2023']).month).toBe('long');
  });

  it('falls back to the bundled store’s own habit when there is nothing to go on', () => {
    expect(inferStyle([])).toEqual(DEFAULT_STYLE);
    expect(inferStyle(['Various', '2024'])).toEqual(DEFAULT_STYLE);
  });

  it('notices a store that writes Current instead of Present', () => {
    expect(inferStyle(['Jan 2023 - Current', 'Mar 2021 - Current']).present).toBe('Current');
  });
});

describe('putting entries in order', () => {
  const key = (text: string) => sortKey(parsePeriod(text));

  it('sorts by when a thing ended, because that is what recent means', () => {
    expect(key('Sep. 2022 -- May 2026')).toBeGreaterThan(key('Jul. 2024 -- Dec. 2024') as number);
  });

  it('puts what is still running above everything finished', () => {
    expect(key('Jan. 2019 -- Present')).toBeGreaterThan(key('Sep. 2022 -- May 2026') as number);
  });

  it('sorts a degree in progress by when it will finish', () => {
    // Above a job that ended last year, which is where a reader expects it.
    expect(key('Expected May 2027')).toBeGreaterThan(key('Jul. 2024 -- Dec. 2024') as number);
  });

  it('has no opinion about an entry whose date it could not read', () => {
    expect(key('Various')).toBeUndefined();
    expect(startKey(parsePeriod('Various'))).toBeUndefined();
  });

  it('sorts oldest-first by the start, not by the reversed end', () => {
    /*
     * A long job that began in 2019 and a short one that began in 2024 and
     * ended later: reversing the end key puts them the wrong way round for
     * anyone reading a career forwards.
     */
    const long = startKey(parsePeriod('Jan. 2019 -- Dec. 2025'));
    const short = startKey(parsePeriod('Jan. 2024 -- Jun. 2024'));
    expect(long).toBeLessThan(short as number);
  });

  it('treats a year with no month as ending at its end', () => {
    // "2024" against "Nov. 2024" — the bare year covers November, so it does
    // not sort below it.
    expect(key('2024')).toBeGreaterThanOrEqual(key('Nov. 2024') as number);
  });
});

/*
 * A range that finishes before it begins.
 *
 * The date control takes any year from 1900 to 2100 at either end and asks
 * nothing further, which is correct while you are editing — moving both ends
 * of a range means passing through a state where only one of them has moved.
 * But nothing downstream looked again, so a 6 typed for a 4 printed
 * "Jul. 2026 -- Dec. 2024" onto the one document that has to be right.
 *
 * The rule has to be generous, because the cost is lopsided: one false
 * complaint about a perfectly good date and the warnings stop being read.
 */
describe('noticing a date that runs backwards', () => {
  const backwards = (text: string) => endsBeforeItStarts(parsePeriod(text));

  it('says so when the end is before the start', () => {
    expect(backwards('Jul. 2026 -- Dec. 2024')).toBe(true);
    expect(backwards('2026 -- 2024')).toBe(true);
  });

  it('leaves an ordinary range alone', () => {
    for (const text of ['Jul. 2024 -- Dec. 2024', 'Sep. 2022 -- May 2026', '2021 -- 2024', 'Jan. 2023 -- Present']) {
      expect(backwards(text), text).toBe(false);
    }
  });

  /*
   * The retreat, and the reason for it. An earlier version compared months
   * as well, and called "Winter 2024 -- Spring 2024" a mistake — which it is
   * not. It is how a pair of academic terms is written, and the only reason
   * it looked wrong is that this file decides winter means December.
   *
   * Nor can the ambiguity be resolved after the fact: `parsePeriod` keeps
   * the start's season and drops the end's, so by the time anything asks,
   * "Dec. 2024 -- Spring 2024" is a March with no sign it was ever a season.
   * A co-op running into the next year and a typo look identical.
   */
  it('says nothing about a month that moves backwards inside one year', () => {
    for (const text of [
      'Winter 2024 -- Spring 2024',
      'Dec. 2024 -- Spring 2024',
      'Dec. 2024 -- Mar. 2024',
      'Fall 2024 -- Summer 2024',
    ]) {
      expect(backwards(text), text).toBe(false);
    }
  });

  it('reads a bare year against a month as the same year, not an inversion', () => {
    expect(backwards('2024 -- 2024')).toBe(false);
    expect(backwards('Dec. 2024 -- 2024')).toBe(false);
    expect(endsBeforeItStarts({ start: { year: 2024, month: 12 }, end: { year: 2024 } })).toBe(false);
    expect(endsBeforeItStarts({ start: { year: 2024 }, end: { year: 2024, month: 1 } })).toBe(false);
  });

  /*
   * Still going has no end to be wrong about. An entry switched to ongoing
   * keeps whatever was in `end` until the next save rewrites it, and
   * complaining about a value that prints nothing would be a warning with no
   * way to clear it.
   */
  it('has nothing to say about something still going', () => {
    expect(endsBeforeItStarts({ start: { year: 2026 }, end: { year: 2024 }, ongoing: true })).toBe(false);
  });

  it('has nothing to say about half a date, or none', () => {
    expect(endsBeforeItStarts(undefined)).toBe(false);
    expect(endsBeforeItStarts({})).toBe(false);
    expect(endsBeforeItStarts({ start: { year: 2024 } })).toBe(false);
    expect(endsBeforeItStarts({ end: { year: 2024 } })).toBe(false);
  });

  /*
   * An expected end is still an end. A graduation date typed before the year
   * you started is the same mistake, and the word in front of it does not
   * make it one the reader will forgive.
   */
  it('still says so when the end is one that has not happened yet', () => {
    expect(backwards('Sep. 2028 -- Expected May 2027')).toBe(true);
  });
});
