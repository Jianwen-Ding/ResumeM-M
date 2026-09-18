import { describe, expect, it } from 'vitest';
import {
  bulletsAreHandOrdered as browserHand,
  mergeSections as browser,
  orderedBullets as browserBullets,
} from '../web/sections.js';
import {
  bulletsAreHandOrdered as serverHand,
  mergeSections as server,
  orderedBullets as serverBullets,
} from '../src/model/resolve.ts';

/*
 * The editor and the renderer agree about what a variation inherits.
 *
 * These are two implementations of one rule, for the usual reason: one is
 * TypeScript compiled for node, the other a script the browser loads
 * directly, and the build has no path between them.
 *
 * This file exists because they disagreed, and because of how that looked.
 * The editor's version was `child ?? parent` — the child's section replaces
 * the parent's outright. The server's lays the child over the parent, so a
 * field the child does not mention stays inherited. Saving a bullet reorder
 * writes down the new bullet order and deliberately not the entry list (a
 * moved bullet is no reason to pin which entries a resume shows), which
 * produces exactly the shape the two disagreed about: a section with
 * `bullets` and no `entries`.
 *
 * On the next load the editor read that as a section with no entries and
 * dropped every one of them out of the resume, while the PDF beside it went
 * on printing them. The screen and the document disagreed, and the screen was
 * the wrong one — the worst way round, because the screen is what you check.
 */

/** The pairs that actually occur, including the one that broke. */
const CASES = [
  {
    what: 'a child that mentions only bullets keeps the entries it inherited',
    base: [{ kind: 'experience', entries: ['a', 'b'] }],
    over: [{ kind: 'experience', bullets: { a: ['b2', 'b1'] } }],
  },
  {
    what: 'a child that states entries replaces them',
    base: [{ kind: 'experience', entries: ['a', 'b'] }],
    over: [{ kind: 'experience', entries: ['b'] }],
  },
  {
    what: 'a child that mentions only an order keeps the entries',
    base: [{ kind: 'experience', entries: ['a', 'b'] }],
    over: [{ kind: 'experience', order: 'newest' }],
  },
  {
    what: 'bullets are merged per entry rather than swapped wholesale',
    base: [{ kind: 'experience', entries: ['a', 'b'], bullets: { a: ['a1'], b: ['b1'] } }],
    over: [{ kind: 'experience', bullets: { b: ['b2'] } }],
  },
  {
    what: 'a skills section keeps its groups and merges its items',
    base: [{ kind: 'skills', entries: [], groups: ['g1', 'g2'], items: { g1: ['i1'] } }],
    over: [{ kind: 'skills', items: { g2: ['i2'] } }],
  },
  {
    what: 'a section the parent never had is appended',
    base: [{ kind: 'experience', entries: ['a'] }],
    over: [{ kind: 'project', entries: ['p'] }],
  },
  {
    what: 'nothing stated leaves the parent exactly as it was',
    base: [{ kind: 'experience', entries: ['a'] }],
    over: [],
  },
  /*
   * Two sections of one kind, which is why matching cannot be on `kind`
   * alone: a child re-stating only Awards must not swallow Leadership.
   */
  {
    what: 'a named heading claims its own section and leaves its neighbour alone',
    base: [
      { kind: 'custom', heading: 'Awards', entries: ['aw1'] },
      { kind: 'custom', heading: 'Leadership', entries: ['ld1'] },
    ],
    over: [{ kind: 'custom', heading: 'Awards', entries: ['aw2'] }],
  },
  {
    what: 'a child naming no heading takes the parent section of that kind',
    base: [{ kind: 'custom', heading: 'Awards', entries: ['aw1'] }],
    over: [{ kind: 'custom', entries: ['aw2'] }],
  },
  {
    what: 'a renamed heading takes the only section of its kind',
    base: [{ kind: 'custom', heading: 'Awards', entries: ['aw1'] }],
    over: [{ kind: 'custom', heading: 'Honours' }],
  },
  {
    what: 'a renamed heading beside an ambiguous pair becomes its own section',
    base: [
      { kind: 'custom', heading: 'Awards', entries: ['aw1'] },
      { kind: 'custom', heading: 'Leadership', entries: ['ld1'] },
    ],
    over: [{ kind: 'custom', heading: 'Honours', entries: ['h1'] }],
  },
  {
    what: 'a chain of three, applied one after another',
    base: [{ kind: 'experience', entries: ['a', 'b'], bullets: { a: ['a1'] } }],
    over: [{ kind: 'experience', bullets: { a: ['a2', 'a1'] } }],
  },
];

describe('the editor and the renderer agree about inherited sections', () => {
  it.each(CASES)('$what', ({ base, over }) => {
    expect(browser(structuredClone(base), structuredClone(over))).toEqual(
      server(structuredClone(base), structuredClone(over)),
    );
  });

  /*
   * The specific shape that broke, asserted on its own rather than only
   * through the agreement — so that if both sides were ever wrong together,
   * this still fails.
   */
  it('keeps the entries when a saved bullet reorder is the only thing the child says', () => {
    const merged = browser(
      [{ kind: 'experience', entries: ['exp_example_co'] }],
      [{ kind: 'experience', bullets: { exp_example_co: ['b2', 'b1'] } }],
    );
    expect(merged[0]?.entries).toEqual(['exp_example_co']);
    expect(merged[0]?.bullets).toEqual({ exp_example_co: ['b2', 'b1'] });
  });

  /*
   * And neither side may mutate what it was handed. The editor merges on
   * every render, so a merge that wrote into the store's own objects would
   * corrupt them a keystroke at a time.
   */
  it('leaves both of its arguments alone', () => {
    const base = [{ kind: 'experience', entries: ['a'], bullets: { a: ['a1'] } }];
    const over = [{ kind: 'experience', bullets: { a: ['a2'] } }];
    const baseBefore = structuredClone(base);
    const overBefore = structuredClone(over);
    browser(base, over);
    server(base, over);
    expect(base).toEqual(baseBefore);
    expect(over).toEqual(overBefore);
  });
});

/*
 * And about which order the lines inside an entry come in.
 *
 * The master document is the inventory, and it is the one place an order can
 * be stated once and mean something on every resume — so it owns the order of
 * the lines inside an entry, while the resume owns which of them it shows.
 * Entries themselves stay ordered by date: a career has an order already.
 *
 * The exception is the resume that was arranged by hand, and it needs no
 * field of its own. Hiding a line rewrites the resume's list straight out of
 * the master's order, so a list that disagrees with the master can only have
 * got that way by somebody dragging it. Disagreement is the record — which
 * also means the arrangements made before any of this existed are read as
 * deliberate and left alone, rather than being thrown away by the upgrade
 * that introduced the feature.
 */
const entryOf = (...ids) => ({ id: 'e', kind: 'experience', bullets: ids.map((id) => ({ id })) });

describe('the editor and the renderer agree about the order of lines', () => {
  const cases = [
    { what: 'a selection in the master’s order stays in it', sel: ['b1', 'b2', 'b3'], master: ['b1', 'b2', 'b3'] },
    { what: 'a selection out of order is put back into it', sel: ['b3', 'b1'], master: ['b1', 'b2', 'b3'] },
    { what: 'a hidden line does not disturb the rest', sel: ['b1', 'b3'], master: ['b1', 'b2', 'b3'] },
    { what: 'a line the master has never heard of keeps its place at the end', sel: ['b3', 'gone', 'b1'], master: ['b1', 'b3'] },
    { what: 'one line', sel: ['b1'], master: ['b1'] },
    { what: 'none', sel: [], master: ['b1', 'b2'] },
    { what: 'an entry with no lines at all', sel: ['b1'], master: [] },
  ];

  it.each(cases)('$what', ({ sel, master }) => {
    const entry = entryOf(...master);
    expect(browserBullets(sel, entry)).toEqual(serverBullets(sel, entry));
  });

  /* And on reading the mark that says a resume arranged its own lines. */
  it.each([
    { what: 'no mark at all', section: { kind: 'experience' } },
    { what: 'a mark for this entry', section: { kind: 'experience', bulletOrder: { e: 'manual' } } },
    { what: 'a mark for a different entry', section: { kind: 'experience', bulletOrder: { other: 'manual' } } },
  ])('agree about $what', ({ section }) => {
    expect(browserHand(section, 'e')).toBe(serverHand(section, 'e'));
  });

  it('takes the mark from the section rather than guessing from the order', () => {
    // A list that disagrees with the master is not, on its own, evidence of
    // anything: see the header of tests/master-order.test.ts.
    expect(serverHand({ kind: 'experience' }, 'e')).toBe(false);
    expect(serverHand({ kind: 'experience', bulletOrder: { e: 'manual' } }, 'e')).toBe(true);
  });

  /*
   * The point of the whole thing: move a line in the master and every
   * resume that has not been arranged by hand moves with it.
   */
  it('restacks a selection when the master moves', () => {
    expect(serverBullets(['b1', 'b3'], entryOf('b3', 'b1', 'b2'))).toEqual(['b3', 'b1']);
  });
});
