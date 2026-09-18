import { describe, expect, it } from 'vitest';
import * as server from '../src/model/period.ts';
import * as browser from '../web/dates.js';

/*
 * The renderer and the editor read and write dates with two separate
 * implementations, because the two halves cannot share a module: one is
 * TypeScript compiled for node, the other is a script the browser loads
 * directly, and the build has no path between them.
 *
 * Duplication is tolerable; drift is not. If they disagree, the control shows
 * one date and the resume prints another, and both look entirely right on
 * their own — the sort of thing you find out from a recruiter, or never. So
 * the two are pinned here over the shapes people actually write, in both
 * directions, and a change to either side fails.
 */

const TEXTS = [
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
  '2022-09 -- 2026-05',
  'Sept 2022',
  'Jan 2023 – Present',
  'Jan 2023 — Present',
  'Jan 2023 to Present',
  '2021-2024',
  'May 2026 (expected)',
  'Anticipated: May 2027',
  'Autumn 2023',
  '2024, July',
  '2024-07',
  // And the things that are not dates at all.
  '',
  '   ',
  'Various',
  'Ongoing since university',
  'Two semesters',
  '20',
  'Summer',
  'May',
];

const PERIODS = [
  { start: { year: 2024 } },
  { start: { year: 2024, month: 7 } },
  { start: { year: 2024, month: 7 }, end: { year: 2024, month: 12 } },
  { start: { year: 2024, month: 7 }, ongoing: true },
  { start: { year: 2022, month: 9 }, end: { year: 2027, month: 5 }, expected: true },
  { start: { year: 2027, month: 5 }, expected: true },
  { start: { year: 2024, month: 6 }, season: 'summer' },
  { start: { year: 2021 }, end: { year: 2024 } },
  { start: { year: 2024, month: 5 } },
  { start: { year: 2024, month: 5 }, end: { year: 2024, month: 6 } },
  undefined,
  {},
];

const STYLES = [
  undefined,
  { month: 'abbrDot', range: ' -- ', present: 'Present', expected: 'Expected' },
  { month: 'abbr', range: ' – ', present: 'Current', expected: 'Anticipated' },
  { month: 'long', range: ' to ', present: 'Now', expected: 'Expected' },
  { month: 'numeric', range: '-', present: 'present', expected: 'Expected' },
];

describe('the editor and the renderer agree about dates', () => {
  it.each(TEXTS)('reads %j the same way', (text) => {
    expect(browser.parsePeriod(text)).toEqual(server.parsePeriod(text));
  });

  it.each(TEXTS)('reads the same style out of %j', (text) => {
    expect(browser.styleOf(text)).toEqual(server.styleOf(text));
  });

  it('infers the same style from a whole store', () => {
    for (const sample of [[], TEXTS, ['Jan 2023 - Current', 'Mar 2021 - Current'], ['Various', '2024']]) {
      expect(browser.inferStyle(sample)).toEqual(server.inferStyle(sample));
    }
  });

  it('writes every period the same way, in every style', () => {
    for (const period of PERIODS) {
      for (const style of STYLES) {
        expect(browser.formatPeriod(period, style ?? browser.DEFAULT_STYLE)).toBe(
          server.formatPeriod(period, style ?? server.DEFAULT_STYLE),
        );
      }
    }
  });

  it.each(TEXTS)('agrees on where %j sorts', (text) => {
    const mine = browser.parsePeriod(text);
    expect(browser.sortKey(mine)).toBe(server.sortKey(mine));
    expect(browser.startKey(mine)).toBe(server.startKey(mine));
  });

  /*
   * The round trip, through both sides at once: what the browser reads, the
   * server writes back unchanged, and the other way about. This is what makes
   * it safe for the control to parse a variant's text, hand the user a date,
   * and write the text back.
   */
  it.each(TEXTS.filter(Boolean))('round-trips %j through one side and out the other', (text) => {
    const style = { ...server.DEFAULT_STYLE, ...server.styleOf(text) };
    const viaBrowser = browser.formatPeriod(server.parsePeriod(text), style);
    const viaServer = server.formatPeriod(browser.parsePeriod(text), style);
    expect(viaBrowser).toBe(viaServer);
  });

  it('exports the same default style', () => {
    expect(browser.DEFAULT_STYLE).toEqual(server.DEFAULT_STYLE);
  });
});
