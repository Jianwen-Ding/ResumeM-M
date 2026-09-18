import { describe, expect, it } from 'vitest';
import { orderedEntries } from '../src/model/resolve.ts';
import { normalizeEntries } from '../src/model/normalize.ts';
import { orderEntryIds, sortKeyOf, startKeyOf } from '../web/reorder.js';
import { sortKey, startKey } from '../src/model/period.ts';

/*
 * The renderer and the editor sort entries with two separate implementations,
 * because the two halves cannot share a module: one is TypeScript compiled for
 * node, the other is a script the browser loads directly, and the build has no
 * path between them.
 *
 * Duplication is tolerable; drift is not. If they disagree, the editor shows
 * one order and the PDF prints another, and both look entirely right on their
 * own — you would find out from a recruiter, or not at all. So the two are
 * pinned against one table here, and a change to either one fails.
 */

const ENTRIES = normalizeEntries([
  { id: 'running', kind: 'experience', title: 'Still going', dates: 'Jan. 2025 -- Present' },
  { id: 'grad', kind: 'education', title: 'Degree', dates: 'Sep. 2022 -- Expected May 2027' },
  { id: 'coop', kind: 'experience', title: 'Co-op', dates: 'Jul. 2024 -- Dec. 2024' },
  { id: 'summer', kind: 'experience', title: 'Summer', dates: 'Summer 2023' },
  { id: 'first', kind: 'experience', title: 'First', dates: 'Jun. 2019 -- Aug. 2019' },
  { id: 'yearonly', kind: 'project', title: 'A year', dates: '2024' },
  { id: 'vague', kind: 'project', title: 'Vague', dates: 'Various' },
  { id: 'alsovague', kind: 'project', title: 'Also vague', dates: 'Two semesters' },
  { id: 'nodates', kind: 'project', title: 'No dates at all' },
]);

const ALL = ENTRIES.map((e) => e.id);

/** Every ordering of interest, including ones chosen to be awkward. */
const CASES = [
  { order: undefined, ids: ALL },
  { order: 'manual', ids: ALL },
  { order: 'newest', ids: ALL },
  { order: 'oldest', ids: ALL },
  { order: 'newest', ids: [] },
  { order: 'newest', ids: ['coop'] },
  { order: 'newest', ids: ['vague', 'alsovague', 'nodates'] },
  { order: 'oldest', ids: ['vague', 'alsovague', 'nodates'] },
  { order: 'newest', ids: ['first', 'running', 'coop'] },
  { order: 'oldest', ids: ['first', 'running', 'coop'] },
  // An id the store does not have: a section naming a deleted entry.
  { order: 'newest', ids: ['running', 'deleted', 'first'] },
  { order: 'oldest', ids: ['running', 'deleted', 'first'] },
  // Reversed input, to catch a sort that depends on the order it was given.
  { order: 'newest', ids: [...ALL].reverse() },
  { order: 'oldest', ids: [...ALL].reverse() },
];

describe('the editor and the renderer agree on order', () => {
  it.each(CASES)('orders $ids the same way with order=$order', ({ order, ids }) => {
    const fromRenderer = orderedEntries({ kind: 'experience', entries: ids, ...(order ? { order } : {}) }, ENTRIES);
    const fromEditor = orderEntryIds(ids, ENTRIES, order);
    expect(fromEditor).toEqual(fromRenderer);
  });

  it('agrees on the keys themselves, not only on the result', () => {
    // A result can match by luck on a small list. The keys cannot.
    for (const entry of ENTRIES) {
      expect(sortKeyOf(entry.period)).toBe(sortKey(entry.period));
      expect(startKeyOf(entry.period)).toBe(startKey(entry.period));
    }
  });

  it('agrees that an unknown order value means do not sort', () => {
    // A store hand-edited to say something neither side knows must not become
    // a disagreement about what to do about it.
    const odd = { kind: 'experience', entries: ALL, order: 'alphabetical' };
    expect(orderEntryIds(ALL, ENTRIES, 'alphabetical')).toEqual(orderedEntries(odd, ENTRIES));
    expect(orderEntryIds(ALL, ENTRIES, 'alphabetical')).toEqual(ALL);
  });

  /*
   * Neither side may rewrite the list it was handed. The stored list is the
   * manual arrangement you get back when the sort is turned off.
   */
  it('neither side touches the list it was given', () => {
    const ids = [...ALL];
    orderEntryIds(ids, ENTRIES, 'newest');
    expect(ids).toEqual(ALL);

    const section = { kind: 'experience', entries: [...ALL], order: 'newest' };
    orderedEntries(section, ENTRIES);
    expect(section.entries).toEqual(ALL);
  });
});
