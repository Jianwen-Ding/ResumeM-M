import { describe, expect, it } from 'vitest';
import { mergeSections as browser } from '../web/sections.js';
import { mergeSections as server } from '../src/model/resolve.ts';

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
