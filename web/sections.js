/*
 * How the editor reads a resume's bullet ordering, for the browser.
 *
 * A mirror of the same rules in `src/model/resolve.ts`, which the editor
 * cannot import: that one is TypeScript compiled for node and this is a
 * script the browser loads directly, and the build has no path between them —
 * the same split that forced `reorder.js` and `dates.js` into existence.
 *
 * Duplication is tolerable; drift is not, and `tests/sections-agreement.test.js`
 * pins the two together over the shapes that actually occur, so the next fix
 * to one of them cannot quietly miss the other. It is worth knowing what drift
 * cost the last time: the editor and the server disagreed about what a
 * variation inherited, the editor dropped every entry out of a section, and
 * the PDF beside it went on printing them correctly — the screen was the wrong
 * one, which is the worst way round, because the screen is what you check.
 * Resumes no longer inherit at all, which is how that whole class of
 * disagreement went away.
 */

/**
 * The lines of one entry, in the order the master document puts them.
 *
 * A mirror of `orderedBullets` in `src/model/resolve.ts`; see there for why
 * the master owns this order and a resume only says which lines it shows.
 */
export function orderedBullets(selected, entry) {
  const master = (entry.bullets ?? []).map((b) => b.id);
  const at = (id) => master.indexOf(id);
  const known = selected.filter((id) => at(id) >= 0).sort((a, b) => at(a) - at(b));
  return [...known, ...selected.filter((id) => at(id) < 0)];
}

/**
 * Whether this resume arranged an entry's lines itself.
 *
 * Read from the section, never inferred. A list that disagrees with the
 * master looks hand-arranged — and every resume faithfully following the
 * master disagrees with it the moment the master moves, so inferring it
 * detaches all of them at once. See `SectionSpec.bulletOrder`.
 */
export function bulletsAreHandOrdered(section, entryId) {
  return section?.bulletOrder?.[entryId] === 'manual';
}
