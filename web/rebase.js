/**
 * Three-way merge for the store's own objects.
 *
 * An entry is saved by sending the whole thing: the editor takes the copy it
 * rendered from, changes one wording in it, and PUTs the result. That is fine
 * until two edits happen close together. The second one is built from the copy
 * on screen — which is still the copy from before the first edit, because the
 * screen only refreshes when a save comes back. So the second PUT carries the
 * old text for everything the first PUT changed, and lands on top of it. Type a
 * sentence, fix a date a moment later, and the sentence is gone: from the
 * store, from every resume sharing it, with nothing having said so.
 *
 * Both edits were derived from the same base, so the base is what tells them
 * apart. Anything this edit did not touch is left as whoever wrote first left
 * it, and only what it actually changed is carried over.
 */

/** Deep structural equality, enough for YAML-shaped data. */
export function same(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((v, i) => same(v, b[i]));
  const ka = Object.keys(a).filter((k) => a[k] !== undefined);
  const kb = Object.keys(b).filter((k) => b[k] !== undefined);
  return ka.length === kb.length && ka.every((k) => same(a[k], b[k]));
}

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Lists in the store are lists of things with ids — bullets, phrasings, skill
 * items. Matching them by position would treat "a bullet was inserted above"
 * as "every bullet below it was rewritten", so they are matched by id where
 * every member has one.
 */
const keyed = (v) => Array.isArray(v) && v.every((x) => isPlain(x) && typeof x.id === 'string');

/**
 * `ours` and `theirs` are both edits of `base`. Returns the two of them
 * combined, with `ours` winning wherever they changed the same thing — this
 * runs on the way out of the editor, so "ours" is the edit the person is
 * making right now and theirs is the one that already landed.
 */
export function rebase(base, ours, theirs) {
  if (same(ours, theirs)) return ours;
  if (same(base, ours)) return theirs; // we changed nothing here
  if (same(base, theirs)) return ours; // nothing landed here to preserve

  if (keyed(ours) && keyed(theirs)) {
    const byId = (list) => new Map((list ?? []).map((x) => [x.id, x]));
    const inBase = byId(keyed(base) ? base : []);
    const inOurs = byId(ours);
    const inTheirs = byId(theirs);

    const out = [];
    for (const item of theirs) {
      // Something we deleted stays deleted; a member we never saw is theirs.
      if (!inOurs.has(item.id)) {
        if (inBase.has(item.id)) continue;
        out.push(item);
        continue;
      }
      out.push(rebase(inBase.get(item.id) ?? item, inOurs.get(item.id), item));
    }
    // Ours that they have not seen — added by this edit, or deleted by theirs
    // and still wanted here because we changed it.
    for (const item of ours) {
      if (inTheirs.has(item.id)) continue;
      if (inBase.has(item.id) && same(inBase.get(item.id), item)) continue; // they deleted it
      out.push(item);
    }
    return out;
  }

  if (isPlain(ours) && isPlain(theirs)) {
    const out = {};
    for (const key of new Set([...Object.keys(ours), ...Object.keys(theirs)])) {
      const merged = rebase(isPlain(base) ? base[key] : undefined, ours[key], theirs[key]);
      if (merged !== undefined) out[key] = merged;
    }
    return out;
  }

  // Two different values for one thing, and no structure left to go into.
  return ours;
}
