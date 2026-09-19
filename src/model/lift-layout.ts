import type { LayoutDefaults, ResumeSpec } from './types.js';

/**
 * Moving a page setting every resume agrees on up to the save that holds them.
 *
 * The fold that removed inheritance copied each base's layout down into every
 * resume that had been inheriting it. That is correct — the documents have to
 * come out the same — and it leaves the save in a state where the setting
 * meant to say "this is how I like a page" says nothing at all, because every
 * resume overrules it. Which is the exact complaint the save-wide setting
 * exists to answer, moved one level down and made harder to see: the number
 * in Settings changes and no resume moves.
 *
 * So a key every resume states identically is lifted into the save and
 * removed from the resumes. Nothing about any document changes — `layoutFor`
 * composes the save's defaults *under* the resume's own, so a value that was
 * on all of them and is now on none of them resolves to the same number — and
 * from then on changing it once changes all of them, which is what somebody
 * expects of a default.
 *
 * What gets lifted is the value *most* of them give a key, and it comes off
 * only the resumes that gave it. A save is twenty resumes at 11pt and one
 * squeezed to 10 to fit: the twenty lose the key and take 11 from the save,
 * the squeezed one goes on saying 10 and wins. No document moves, and the
 * setting now works for the twenty rather than for nobody.
 *
 * The one rule that cannot be relaxed is that every resume must state the key
 * before anything is lifted. A resume that never had an opinion was taking
 * the app's default, and putting a number on the save would silently move it.
 */

/** The layout keys worth lifting. `fitBounds` is nested and is handled below. */
const SIMPLE = ['fontSizePt', 'marginIn', 'spacing', 'paper', 'autoFit', 'maxPages'] as const;

export interface Lifted {
  /** What to put on the save, merged over whatever it already had. */
  layout: LayoutDefaults;
  /** The resumes with those keys taken off. */
  resumes: ResumeSpec[];
  /** Which keys moved, for the caller to report. */
  keys: string[];
}

/**
 * The value most of these resumes give a key, where every one of them gives
 * it something.
 *
 * Not unanimity, and the difference matters in the case that actually occurs.
 * A save is twenty resumes at 11pt and one squeezed to 10 to fit; demanding
 * agreement lifts nothing, and the save-wide setting goes on saying nothing
 * for the twenty because of the one. Taking the common value lifts it for the
 * twenty and leaves the squeezed one exactly as it is.
 *
 * It changes no document either way: a resume that shares the value loses the
 * key and gets the same number back from the save, and one that does not
 * keeps its own, which wins.
 *
 * "Every one of them gives it something" is the part that cannot be relaxed.
 * A resume that never stated the key was taking the app's default, and
 * putting a number on the save would silently move it — the migration would
 * be changing a document, which is the one thing it may not do.
 */
function commonValue(values: (unknown | undefined)[]): unknown | undefined {
  if (values.length === 0 || values.some((v) => v === undefined)) return undefined;

  const counts = new Map<unknown, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);

  /*
   * Ties go to the first value seen rather than to whichever the Map happens
   * to yield first — insertion order makes that the first resume's, which is
   * at least a stated reason. A two-two split lifts one of them and leaves
   * the other two stating theirs; both still print what they printed.
   */
  let best: unknown;
  let most = 0;
  for (const [value, n] of counts) {
    if (n > most) { best = value; most = n; }
  }
  return best;
}

export function liftLayout(resumes: ResumeSpec[], already: LayoutDefaults = {}): Lifted {
  // Nothing to agree about. One resume is a perfectly good unanimous vote,
  // but none is not — lifting from an empty save would invent a default.
  if (resumes.length === 0) return { layout: {}, resumes, keys: [] };

  const layout: LayoutDefaults = {};
  const keys: string[] = [];

  for (const key of SIMPLE) {
    const agreed = commonValue(resumes.map((r) => r.layout?.[key]));
    if (agreed === undefined) continue;
    /*
     * A key the save already sets to something else is still lifted, and the
     * save's old value is overwritten. It was being ignored: every resume
     * overruled it, so nothing rendered with it. Writing down what is
     * actually in force is the honest end state, and it changes no document.
     */
    Object.assign(layout, { [key]: agreed });
    keys.push(key);
  }

  const bounds: Record<string, unknown> = {};
  for (const key of ['minFontSizePt', 'minSpacing', 'minMarginIn'] as const) {
    const agreed = commonValue(resumes.map((r) => r.layout?.fitBounds?.[key]));
    if (agreed === undefined) continue;
    bounds[key] = agreed;
    keys.push(`fitBounds.${key}`);
  }
  if (Object.keys(bounds).length > 0) layout.fitBounds = { ...already.fitBounds, ...bounds };

  if (keys.length === 0) return { layout: {}, resumes, keys: [] };

  const stripped = resumes.map((spec) => {
    if (!spec.layout) return spec;
    const next: ResumeSpec = { ...spec, layout: { ...spec.layout } };

    // Only off the ones that share the lifted value. A resume set tighter
    // than the rest keeps saying so, which is why its document does not move.
    for (const key of SIMPLE) if (key in layout && next.layout![key] === layout[key]) delete next.layout![key];
    if (next.layout!.fitBounds) {
      const rest = { ...next.layout!.fitBounds };
      for (const [key, value] of Object.entries(bounds)) {
        if (rest[key as keyof typeof rest] === value) delete rest[key as keyof typeof rest];
      }
      // An empty `fitBounds` is a key that says nothing; it reads on disk as
      // a resume with an opinion about its floors, and it has none.
      if (Object.keys(rest).length > 0) next.layout!.fitBounds = rest;
      else delete next.layout!.fitBounds;
    }
    if (Object.keys(next.layout!).length === 0) delete next.layout;
    return next;
  });

  return { layout, resumes: stripped, keys };
}
