import { describe, expect, it } from 'vitest';
import {
  bulletsAreHandOrdered as browserHand,
  orderedBullets as browserBullets,
} from '../web/sections.js';
import {
  bulletsAreHandOrdered as serverHand,
  orderedBullets as serverBullets,
} from '../src/model/resolve.ts';

/*
 * The editor and the renderer agree about the shapes they both compute.
 *
 * These are two implementations of one set of rules, for the usual reason:
 * one is TypeScript compiled for node, the other a script the browser loads
 * directly, and the build has no path between them.
 *
 * This file exists because they disagreed once, and because of how that
 * looked: the editor dropped every entry out of a section while the PDF
 * beside it went on printing them, so the screen and the document disagreed
 * and the screen was the wrong one — the worst way round, because the screen
 * is what you check. That particular rule was about what a variation
 * inherited, and it is gone: resumes stand alone. What is left is the line
 * ordering below, which both sides still compute separately and so still
 * have to be held together.
 */

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
