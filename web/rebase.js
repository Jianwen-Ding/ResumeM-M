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
 * store, from every resume sharing it, silently.
 *
 * Both edits were derived from the same base, so the base is what tells them
 * apart. Anything this edit did not touch is left as whoever wrote first left
 * it, and only what it actually changed is carried over.
 *
 * The rule throughout is that text is what cannot be recovered from the screen.
 * Where the two edits genuinely disagree, the one being made now wins; where
 * one of them would throw away wording the other wrote, the wording is kept.
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

/** Tags and the like: a list of plain values, merged as a set. */
const flat = (v) => Array.isArray(v) && v.every((x) => x === null || typeof x !== 'object');

const byId = (list) => new Map((list ?? []).map((x) => [x.id, x]));

/** An id nothing is using yet, for the second of two additions that collided. */
function freeId(wanted, taken) {
  let id = `${wanted}-2`;
  for (let n = 3; taken.has(id); n++) id = `${wanted}-${n}`;
  return id;
}

/**
 * Both sides added a member under the same id.
 *
 * Not as unlikely as it sounds: `addBullet` and `addFieldAlternate` derive an
 * id from the client's own copy of the entry (`b_acme_4`, `v_terse`), so two
 * additions made before the first save returns produce the same one — which is
 * exactly the case this merge exists for. Treating them as one edit kept a
 * single bullet and dropped the other one's text, so they are kept as the two
 * additions they are.
 */
function bothAdded(id, ours, theirs, taken) {
  return !same(ours, theirs) && { ...ours, id: freeId(id, taken) };
}

/**
 * Whether `side` put the members it shares with the other two lists in a
 * different order from `base`.
 *
 * Only the members all three lists have are compared. Comparing the whole list
 * counted an addition or a deletion as a reorder: this edit added a bullet, its
 * list no longer matched the base, so it was taken to have chosen an order —
 * and the order the other edit had just dragged into place was thrown away.
 */
function reordered(base, side, other, key) {
  const inSide = new Set(side.map(key));
  const inOther = new Set(other.map(key));
  const shared = (list) => list.map(key).filter((k) => inSide.has(k) && inOther.has(k));
  const was = shared(base);
  const now = shared(side);
  return was.length !== now.length || was.some((k, i) => k !== now[i]);
}

/**
 * The order to lay the result out in: whichever side moved things around, and
 * the edit being made now when both did. On a resume, bullet order is content.
 */
function skeleton(base, ours, theirs) {
  if (!keyed(base)) return ours;
  return reordered(base, ours, theirs, (x) => x.id) ? ours : theirs;
}

export function rebase(base, ours, theirs) {
  if (same(ours, theirs)) return ours;
  if (same(base, ours)) return theirs; // we changed nothing here
  if (same(base, theirs)) return ours; // nothing landed here to preserve

  if (keyed(ours) && keyed(theirs)) {
    const inBase = byId(keyed(base) ? base : []);
    const inOurs = byId(ours);
    const inTheirs = byId(theirs);
    const taken = new Set([...inOurs.keys(), ...inTheirs.keys(), ...inBase.keys()]);

    const merged = new Map(); // id → member, in no particular order yet
    const extra = []; // additions that collided on an id, kept under a new one

    for (const item of ours) {
      const was = inBase.get(item.id);
      const theirCopy = inTheirs.get(item.id);
      if (!theirCopy) {
        // Ours only: an addition of ours, or something they deleted. A deletion
        // wins only over a member we did not touch.
        if (!was || !same(was, item)) merged.set(item.id, item);
        continue;
      }
      if (!was) {
        const collided = bothAdded(item.id, item, theirCopy, taken);
        if (collided) {
          merged.set(item.id, theirCopy);
          taken.add(collided.id);
          extra.push(collided);
          continue;
        }
      }
      merged.set(item.id, rebase(was, item, theirCopy));
    }

    for (const item of theirs) {
      if (merged.has(item.id) || inOurs.has(item.id)) continue;
      /*
       * Theirs only, and we deleted it. Deleting something while the other edit
       * was rewriting it is a real disagreement, and their wording is the part
       * that cannot be recovered from the screen — so it stays. A member they
       * left exactly as it was goes.
       */
      const was = inBase.get(item.id);
      if (!was || !same(was, item)) merged.set(item.id, item);
    }

    const out = [];
    const placed = new Set();
    const put = (id) => {
      if (!merged.has(id) || placed.has(id)) return;
      placed.add(id);
      out.push(merged.get(id));
    };

    const frame = skeleton(base, ours, theirs);
    for (const { id } of frame) put(id);

    /*
     * What the skeleton does not name is the other side's additions. Appending
     * them would move them: a bullet inserted at the top of an entry came back
     * at the bottom of it. Each goes after whatever it followed on its own
     * side instead.
     *
     * Except an addition at the end. "After whatever it followed" is only right
     * while that neighbour is still where it was; once the skeleton has moved
     * it, a bullet added to the bottom of an entry followed it up into the
     * middle. Nothing that was already there came after it on its own side, so
     * it goes at the end.
     */
    const otherSide = frame === ours ? theirs : ours;
    const framed = new Set(placed);
    otherSide.forEach((item, i) => {
      if (placed.has(item.id) || !merged.has(item.id)) return;
      placed.add(item.id);
      const atEnd =
        otherSide.slice(0, i).some((x) => framed.has(x.id)) && otherSide.slice(i + 1).every((x) => !framed.has(x.id));
      const after = out.findIndex((x) => x.id === otherSide[i - 1]?.id);
      if (atEnd) out.push(merged.get(item.id));
      else if (after >= 0) out.splice(after + 1, 0, merged.get(item.id));
      else if (i === 0) out.unshift(merged.get(item.id));
      else out.push(merged.get(item.id));
    });

    for (const id of merged.keys()) put(id);
    return [...out, ...extra];
  }

  if (flat(ours) && flat(theirs)) {
    // Tags and the like. Ours in ours' order, plus anything they added, minus
    // anything either of them removed.
    // Their removals too: a line the other write switched off while this one
    // switched off another beside it came back on.
    //
    // Ours' order unless only they reordered: a line this edit switched on, put
    // beside a reorder the other one made, undid the reorder.
    const wasThere = new Set(flat(base) ? base : []);
    const theyMoved = flat(base) && !reordered(base, ours, theirs, (v) => v) && reordered(base, theirs, ours, (v) => v);
    const [frame, other] = theyMoved ? [theirs, ours] : [ours, theirs];
    const inFrame = new Set(frame);
    const inOther = new Set(other);
    return [
      ...frame.filter((v) => inOther.has(v) || !wasThere.has(v)),
      ...other.filter((v) => !inFrame.has(v) && !wasThere.has(v)),
    ];
  }

  /*
   * A heading field that became a set of alternates on one side while the other
   * was editing its text. Falling through to "ours wins" threw away the whole
   * alternate set and put a bare string in its place — every phrasing of that
   * field, gone, to save one word someone typed.
   */
  const grown = variantised(base, ours, theirs) ?? variantised(base, theirs, ours);
  if (grown) return grown;

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

/** One side kept a plain string and edited it; the other turned it into alternates. */
function variantised(base, edited, grew) {
  if (typeof base !== 'string' || typeof edited !== 'string') return undefined;
  if (!isPlain(grew) || !Array.isArray(grew.variants)) return undefined;
  return {
    ...grew,
    variants: grew.variants.map((v) => (v.text === base ? { ...v, text: edited } : v)),
  };
}
