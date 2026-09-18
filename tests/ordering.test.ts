import { describe, expect, it } from 'vitest';
import { orderedEntries } from '../src/model/resolve.js';
import { normalizeEntries } from '../src/model/normalize.js';
import type { Entry, SectionSpec } from '../src/model/types.js';

/*
 * Entries written in the order somebody happened to add them, which is the
 * order every store is in before anything sorts it. Deliberately not in date
 * order, and deliberately including one whose date is not a date.
 */
const ENTRIES: Entry[] = normalizeEntries([
  { id: 'coop', kind: 'experience', title: 'Everclear', dates: 'Jul. 2024 -- Dec. 2024' },
  { id: 'school', kind: 'education', title: 'Northeastern', dates: 'Sep. 2022 -- May 2026' },
  { id: 'old', kind: 'experience', title: 'First job', dates: 'Jun. 2019 -- Aug. 2019' },
  { id: 'now', kind: 'experience', title: 'Current thing', dates: 'Jan. 2025 -- Present' },
  { id: 'vague', kind: 'project', title: 'Side project', dates: 'Various' },
  { id: 'other', kind: 'project', title: 'Another', dates: 'Ongoing since university' },
]);

const section = (over: Partial<SectionSpec> = {}): SectionSpec => ({
  kind: 'experience',
  entries: ['coop', 'school', 'old', 'now', 'vague', 'other'],
  ...over,
});

describe('putting a section in order', () => {
  /*
   * The compatibility property, and the reason this file exists. Every store
   * written before ordering existed has no `order` on any section, and every
   * one of those resumes has been proofread in the order it is in. A program
   * that learns to sort must not start sorting.
   */
  it('leaves a section alone when nothing has asked for a sort', () => {
    expect(orderedEntries(section(), ENTRIES)).toEqual(['coop', 'school', 'old', 'now', 'vague', 'other']);
    expect(orderedEntries(section({ order: 'manual' }), ENTRIES)).toEqual([
      'coop',
      'school',
      'old',
      'now',
      'vague',
      'other',
    ]);
  });

  it('puts the most recent first, with what is still running above it', () => {
    expect(orderedEntries(section({ order: 'newest' }), ENTRIES)).toEqual([
      'now', // still running
      'school', // ends May 2026
      'coop', // ends Dec 2024
      'old', // ends Aug 2019
      'vague',
      'other',
    ]);
  });

  it('reads a career forwards, by when each thing began', () => {
    expect(orderedEntries(section({ order: 'oldest' }), ENTRIES)).toEqual([
      'old', // began 2019
      'school', // began Sep 2022
      'coop', // began Jul 2024
      'now', // began Jan 2025
      'vague',
      'other',
    ]);
  });

  /*
   * An entry whose date could not be read is not old and it is not new. Sorted
   * either way it lands somewhere nobody chose, on a document where position
   * carries meaning — so it goes after the dated ones and keeps the order it
   * was given relative to the others like it.
   */
  it('does not invent a position for an entry it cannot date', () => {
    for (const order of ['newest', 'oldest'] as const) {
      const out = orderedEntries(section({ order }), ENTRIES);
      expect(out.slice(-2)).toEqual(['vague', 'other']);
    }
  });

  /*
   * The stored list is the manual arrangement. Sorting reads it and does not
   * write it, so turning the sort off gives back the order that was there
   * rather than whatever the sort last produced.
   */
  it('does not rewrite the list it sorted', () => {
    const spec = section({ order: 'newest' });
    const before = [...spec.entries];
    orderedEntries(spec, ENTRIES);
    expect(spec.entries).toEqual(before);
    expect(orderedEntries({ ...spec, order: 'manual' }, ENTRIES)).toEqual(before);
  });

  it('is not upset by a section naming an entry that is gone', () => {
    // The resolver reports that separately; this must not throw or drop the
    // rest of the section on the way past it.
    const out = orderedEntries(section({ order: 'newest', entries: ['now', 'deleted', 'old'] }), ENTRIES);
    expect(out).toEqual(['now', 'old', 'deleted']);
  });
});

describe('reading dates out of a store that predates them', () => {
  it('gives every entry a period without touching what prints', () => {
    const [coop] = normalizeEntries([
      { id: 'coop', kind: 'experience', title: 'Everclear', dates: 'Jul. 2024 -- Dec. 2024' },
    ]);
    expect(coop?.period).toEqual({ start: { year: 2024, month: 7 }, end: { year: 2024, month: 12 } });
    expect(coop?.dates).toBe('Jul. 2024 -- Dec. 2024');
  });

  it('reads the date off the default phrasing when there are alternates', () => {
    /*
     * One education entry with two graduation dates is the case the variant
     * system was built for. Which one a given resume picks must not decide
     * where the entry sits on the page, so the period comes from the default.
     */
    const [school] = normalizeEntries([
      {
        id: 'edu',
        kind: 'education',
        title: 'Northeastern',
        dates: {
          default: 'v_may',
          variants: [
            { id: 'v_dec', label: 'Dec 2026', text: 'Sep. 2022 -- Dec. 2026' },
            { id: 'v_may', label: 'May 2026', text: 'Sep. 2022 -- May 2026' },
          ],
        },
      },
    ]);
    expect(school?.period).toEqual({ start: { year: 2022, month: 9 }, end: { year: 2026, month: 5 } });
  });

  it('leaves an entry undated rather than guessing at one', () => {
    const [vague] = normalizeEntries([{ id: 'v', kind: 'project', title: 'Thing', dates: 'Various' }]);
    expect(vague?.period).toBeUndefined();
    expect(vague?.dates).toBe('Various');
  });

  it('does not overrule a period the file already carries', () => {
    // A hand-edited file, or one written by a newer version: what is written
    // down wins over what can be read out of the words.
    const [entry] = normalizeEntries([
      { id: 'e', kind: 'experience', title: 'T', dates: '2019', period: { start: { year: 2024, month: 3 } } },
    ]);
    expect(entry?.period).toEqual({ start: { year: 2024, month: 3 } });
  });
});
