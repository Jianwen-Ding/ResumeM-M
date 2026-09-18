/**
 * The arithmetic of moving one thing in a list.
 *
 * Its own file, and tested on its own, because every interesting mistake in a
 * reorder lives here and none of them are visible in a drag:
 *
 *   - Dropping onto the item directly below yourself is a no-op unless the
 *     removal is accounted for before the index is read. Get it wrong and the
 *     one move nobody can complete is "swap these two", which is the most
 *     common move there is.
 *   - Dropping onto yourself must not duplicate the id. An entry listed twice
 *     in a section prints twice.
 *   - There has to be a way to say "after the last one", or the bottom of the
 *     list is unreachable and the first entry can never be made the last.
 *
 * Testing through the DOM would exercise the event plumbing and miss all
 * three, because each of them produces a list that still looks plausible.
 */

/** `list` with `id` moved to sit immediately before `before`, or last for null. */
export function moveBefore(list, id, before) {
  if (id === before) return [...list];
  const without = list.filter((x) => x !== id);
  const at = before === null || before === undefined ? without.length : without.indexOf(before);
  // A target that is not in the list is a drop onto something from another
  // list, or onto a row that has since gone. Neither is a reason to move
  // anything anywhere.
  if (at < 0) return [...list];
  return [...without.slice(0, at), id, ...without.slice(at)];
}

/** `list` with `id` shifted `delta` places, clamped at both ends. */
export function moveBy(list, id, delta) {
  const from = list.indexOf(id);
  if (from < 0) return [...list];
  const to = Math.min(list.length - 1, Math.max(0, from + delta));
  if (to === from) return [...list];
  const out = [...list];
  out.splice(from, 1);
  out.splice(to, 0, id);
  return out;
}
