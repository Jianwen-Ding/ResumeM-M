import { describe, expect, it } from 'vitest';
import { adoptDateOrder, orderedEntries } from '../src/model/resolve.js';
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

/*
 * Most of the time a resume should keep itself in date order — that is the
 * convention every reader of the document already has, so it should not be a
 * setting anybody has to find. But a section written before ordering existed
 * says nothing about what it wants, and reading "says nothing" as "sort me"
 * would rearrange documents that have been proofread and sent.
 */
describe('adopting date order without rearranging anything', () => {
  const dated = normalizeEntries([
    { id: 'now', kind: 'experience', title: 'Current', dates: 'Jan. 2025 -- Present' },
    { id: 'mid', kind: 'experience', title: 'Middle', dates: 'Jul. 2024 -- Dec. 2024' },
    { id: 'old', kind: 'experience', title: 'Oldest', dates: 'Jun. 2019 -- Aug. 2019' },
  ]);

  it('takes over a section that is already in date order, since nothing moves', () => {
    const { adopted, handOrdered } = adoptDateOrder(
      [{ kind: 'experience', entries: ['now', 'mid', 'old'] }],
      dated,
    );
    expect(adopted[0]?.order).toBe('newest');
    expect(handOrdered).toEqual([]);
    // And the list itself is untouched: the order is now maintained, not rewritten.
    expect(adopted[0]?.entries).toEqual(['now', 'mid', 'old']);
  });

  /*
   * The case the whole function exists for. A project pulled to the top for
   * one application, or a job held back, is a decision — and a migration that
   * silently undid it would change a document its author had already checked.
   */
  it('leaves a hand-ordered section alone, and says which ones those are', () => {
    const sections = [{ kind: 'experience' as const, entries: ['old', 'now', 'mid'] }];
    const { adopted, handOrdered } = adoptDateOrder(sections, dated);
    expect(adopted[0]?.order).toBeUndefined();
    expect(handOrdered).toHaveLength(1);
    expect(handOrdered[0]?.entries).toEqual(['old', 'now', 'mid']);
  });

  it('never touches a section that has already said what it wants', () => {
    for (const order of ['manual', 'newest', 'oldest'] as const) {
      const { adopted, handOrdered } = adoptDateOrder([{ kind: 'experience', entries: ['old', 'now'], order }], dated);
      expect(adopted[0]?.order).toBe(order);
      expect(handOrdered).toEqual([]);
    }
  });

  it('adopts a section too short to be out of order', () => {
    for (const entries of [[], ['now']]) {
      expect(adoptDateOrder([{ kind: 'experience', entries }], dated).adopted[0]?.order).toBe('newest');
    }
  });

  /*
   * Skills have no dates and never will. Marking them sorted would be a lie
   * that the editor would then have to draw a control for.
   */
  it('leaves skills out of it entirely', () => {
    const { adopted } = adoptDateOrder([{ kind: 'skills', entries: [], groups: ['g'] }], dated);
    expect(adopted[0]?.order).toBeUndefined();
  });

  /*
   * A section whose entries cannot be dated sorts to itself, because undated
   * entries keep their positions — so it adopts, harmlessly, and the next
   * dated entry added to it lands where it belongs.
   */
  it('adopts a section of undated entries, which sorting cannot move', () => {
    const vague = normalizeEntries([
      { id: 'a', kind: 'project', title: 'A', dates: 'Various' },
      { id: 'b', kind: 'project', title: 'B', dates: 'Ongoing' },
    ]);
    const { adopted, handOrdered } = adoptDateOrder([{ kind: 'project', entries: ['a', 'b'] }], vague);
    expect(adopted[0]?.order).toBe('newest');
    expect(handOrdered).toEqual([]);
  });
});
