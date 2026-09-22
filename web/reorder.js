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

/*
 * Date order, for the editor's own list.
 *
 * The same rule the renderer applies in `src/model/resolve.ts`, and it has to
 * be, or the editor shows one order and the PDF prints another — which is the
 * worst failure available here, because both look right on their own.
 *
 * It exists twice because the two halves cannot share a module: the renderer is
 * TypeScript compiled for node, this is a script the browser loads directly,
 * and the build has no path between them. `tests/order-agreement.test.js`
 * pins the two against one table of cases so a change to either shows up as a
 * failure rather than as a document that does not match its editor.
 */

/**
 * How recent something is: what is still running beats everything finished,
 * and two things still running are ordered by when they began.
 *
 * See `sortKey` in period.ts, which this mirrors and which
 * `order-agreement.test.js` pins it against.
 */
export function sortKeyOf(period) {
  if (!period?.start) return undefined;
  if (period.ongoing) return ONGOING + (startKeyOf(period) ?? 0);
  const point = period.end ?? period.start;
  return point.year * 100 + (point.month ?? 12);
}

/** The floor for anything still running. See period.ts. */
const ONGOING = 1e12;

/** When something began, for reading a career forwards. */
export function startKeyOf(period) {
  if (!period?.start) return undefined;
  return period.start.year * 100 + (period.start.month ?? 1);
}

/**
 * `ids` in the order this section prints them.
 *
 * Undated entries are not placed: they keep their order relative to each other
 * and follow the dated ones, because an entry the program cannot date is one it
 * has no business moving.
 */
export function orderEntryIds(ids, entries, order) {
  if (order !== 'newest' && order !== 'oldest') return [...ids];

  const keyOf = (id) => {
    const entry = entries.find((e) => e.id === id);
    return order === 'oldest' ? startKeyOf(entry?.period) : sortKeyOf(entry?.period);
  };

  const dated = [];
  const undated = [];
  for (const id of ids) {
    const key = keyOf(id);
    if (key === undefined) undated.push(id);
    else dated.push({ id, key });
  }
  dated.sort((a, b) => (order === 'oldest' ? a.key - b.key : b.key - a.key));
  return [...dated.map((d) => d.id), ...undated];
}
