/*
 * Laying a resume's sections over the ones it inherits, for the browser.
 *
 * A mirror of `mergeSections` in `src/model/resolve.ts`, which the editor
 * cannot import: that one is TypeScript compiled for node and this is a script
 * the browser loads directly, and the build has no path between them — the
 * same split that forced `reorder.js` and `dates.js` into existence.
 *
 * Duplication is tolerable; drift is not, and this is what drift costs. The
 * editor had its own one-line version of this, `child ?? parent`, which
 * replaced the parent's section outright instead of laying the child's over
 * it. The server had been fixed; the editor never was. So saving a bullet
 * reorder — which deliberately writes down the new bullet order and *not* the
 * entry list, because a reordered bullet is no reason to pin which entries a
 * resume shows — produced a child section carrying `bullets` and no `entries`,
 * and on the next load the editor read that as "this section has no entries".
 * Every entry in it vanished from the list and came back as something switched
 * off, while the PDF beside it went on printing them correctly, because the
 * PDF is built by the server and the server was right.
 *
 * `tests/sections-agreement.test.js` pins the two together over the shapes
 * that actually occur, so the next fix to one of them cannot quietly miss the
 * other.
 */

/**
 * What the child states, over what the parent had — not instead of it.
 *
 * Absent means inherited, which is how `choices`, `lists` and `layout` already
 * work one level up.
 */
function over(parent, child) {
  return {
    ...parent,
    ...child,
    entries: child.entries ?? parent.entries,
    groups: child.groups ?? parent.groups,
    bullets:
      child.bullets || parent.bullets
        ? { ...(parent.bullets ?? {}), ...(child.bullets ?? {}) }
        : undefined,
    items: child.items || parent.items ? { ...(parent.items ?? {}), ...(child.items ?? {}) } : undefined,
  };
}

/**
 * Merge one resume's sections onto its parent's.
 *
 * Matching is not by `kind` alone, because a store can hold two `custom`
 * sections — "Awards" and "Leadership". A child re-stating only Awards must
 * not replace both. Nor can it be an exact heading match, because the ordinary
 * child does not repeat the heading at all: it just lists different entries
 * under Experience and must go on replacing the parent's Experience rather
 * than adding a second one.
 *
 * So a heading that matches wins first; then a child that named no heading
 * takes the parent's section of that kind; then a renamed heading may take it,
 * but only where the parent has exactly one section of that kind and there is
 * nothing to be ambiguous about. Whatever is left is a section the parent
 * never had, appended in the child's order.
 */
export function mergeSections(base, override) {
  if (override.length === 0) return base;

  const out = [...base];
  const claimed = new Set();

  const claim = (o, where) => {
    const at = out.findIndex((s, i) => !claimed.has(i) && s.kind === o.kind && where(s, i));
    if (at < 0) return false;
    out[at] = over(out[at], o);
    claimed.add(at);
    return true;
  };

  const heading = (s) => s.heading ?? '';
  const onlyOneOfItsKind = (o) => base.filter((s) => s.kind === o.kind).length === 1;

  let pending = override.filter((o) => !claim(o, (s) => heading(s) === heading(o)));
  pending = pending.filter((o) => !(heading(o) === '' && claim(o, () => true)));
  pending = pending.filter((o) => !(onlyOneOfItsKind(o) && claim(o, () => true)));

  for (const o of pending) out.push(o);
  return out;
}

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
