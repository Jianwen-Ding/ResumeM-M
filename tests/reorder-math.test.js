import { describe, expect, it } from 'vitest';
import { moveBefore, moveBy } from '../web/reorder.js';

/*
 * The three mistakes that a drag cannot show you, because each produces a list
 * that still looks plausible on screen.
 */
describe('moving one item to sit before another', () => {
  const list = ['a', 'b', 'c', 'd'];

  it('moves an item up', () => {
    expect(moveBefore(list, 'c', 'b')).toEqual(['a', 'c', 'b', 'd']);
  });

  /*
   * "Before c" where the item is already before c is not a move, and must not
   * become one. This is the assertion that has to be read carefully rather
   * than written quickly: the index of `c` in the original list is not the
   * index to insert at, because removing `b` first shifts everything after it.
   * Taking the index before the removal turns this case into `a c b d` — an
   * item that slides one place whenever you drop it back where it already was.
   */
  it('does not move an item that is already where it was dropped', () => {
    expect(moveBefore(list, 'b', 'c')).toEqual(['a', 'b', 'c', 'd']);
  });

  /*
   * Moving `b` past `c` is expressed as "before whatever follows c", which is
   * how the lower half of a row is turned into a position — and it is the only
   * way to say it, since "before c" is where `b` already is.
   */
  it('moves an item down past the one below it, by naming the one after that', () => {
    expect(moveBefore(list, 'b', 'd')).toEqual(['a', 'c', 'b', 'd']);
  });

  it('moves an item to the front', () => {
    expect(moveBefore(list, 'd', 'a')).toEqual(['d', 'a', 'b', 'c']);
  });

  /*
   * Without a way to say "after everything", the last position is unreachable
   * and the first item can never be made the last.
   */
  it('moves an item to the very end, which is what a null target means', () => {
    expect(moveBefore(list, 'a', null)).toEqual(['b', 'c', 'd', 'a']);
    expect(moveBefore(list, 'a', undefined)).toEqual(['b', 'c', 'd', 'a']);
  });

  it('does nothing, rather than duplicating, when something is dropped on itself', () => {
    expect(moveBefore(list, 'b', 'b')).toEqual(list);
  });

  it('does nothing when the target is not in the list', () => {
    // A row from another list, or one that has gone since the drag started.
    expect(moveBefore(list, 'b', 'zz')).toEqual(list);
  });

  it('never changes what is in the list, only the order', () => {
    for (const id of list) {
      for (const before of [...list, null]) {
        expect([...moveBefore(list, id, before)].sort()).toEqual([...list].sort());
      }
    }
  });

  it('leaves the list it was given alone', () => {
    const original = [...list];
    moveBefore(list, 'a', 'd');
    expect(list).toEqual(original);
  });
});

describe('nudging an item one place', () => {
  const list = ['a', 'b', 'c'];

  it('goes up and down', () => {
    expect(moveBy(list, 'b', -1)).toEqual(['b', 'a', 'c']);
    expect(moveBy(list, 'b', 1)).toEqual(['a', 'c', 'b']);
  });

  /*
   * Held at the ends rather than wrapping. Pressing up on the top item and
   * having it appear at the bottom is the behaviour of a carousel, not of a
   * list of jobs on a page.
   */
  it('stops at the ends instead of wrapping round', () => {
    expect(moveBy(list, 'a', -1)).toEqual(list);
    expect(moveBy(list, 'c', 1)).toEqual(list);
    expect(moveBy(list, 'a', -99)).toEqual(list);
    expect(moveBy(list, 'c', 99)).toEqual(list);
  });

  it('does nothing for an id that is not there', () => {
    expect(moveBy(list, 'zz', 1)).toEqual(list);
  });

  it('leaves the list it was given alone', () => {
    const original = [...list];
    moveBy(list, 'a', 1);
    expect(list).toEqual(original);
  });
});
