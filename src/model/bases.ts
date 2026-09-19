import type { ResumeSpec } from './types.js';

/**
 * Which resumes are starting points, and which are leaves.
 *
 * A store fills up with resumes tailored for one posting each, most of them
 * closed months ago. Two or three are the ones anything new is built from. The
 * distinction was implicit — the code guessed at an id called "newgrad" and
 * fell back to whatever happened to be first — which is fine until the day you
 * rename it, and useless to anyone whose store never had one.
 *
 * So it is said outright: a resume can be pinned as a base. Where nothing is
 * pinned the old guess still applies, because a store that has never been told
 * should still behave sensibly.
 */

/** The historical default, kept as the guess for a store that pins nothing. */
const CONVENTIONAL = 'newgrad';

/** Pinned bases first, then everything else, each in store order. */
export function baseResumes(resumes: ResumeSpec[]): ResumeSpec[] {
  const pinned = resumes.filter((r) => r.base);
  return pinned.length > 0 ? pinned : [];
}

/**
 * The resume to start from when the caller did not say. A pinned base wins; a
 * resume nothing extends is a better guess than one three levels deep; and the
 * conventional id is the last word before "whatever is first".
 */
export function defaultBaseId(resumes: ResumeSpec[]): string | undefined {
  const pinned = resumes.find((r) => r.base);
  if (pinned) return pinned.id;

  const conventional = resumes.find((r) => r.id === CONVENTIONAL);
  if (conventional) return conventional.id;

  const root = resumes.find((r) => !r.extends);
  return root?.id ?? resumes[0]?.id;
}

/**
 * Bases first, for a picker. Not a filter: a resume that is not pinned is
 * still a perfectly good thing to build from, it is just not the answer to
 * "where do I usually start".
 */
export function byBaseFirst(resumes: ResumeSpec[]): ResumeSpec[] {
  const pinned = baseResumes(resumes);
  if (pinned.length === 0) return [...resumes];
  const rest = resumes.filter((r) => !r.base);
  return [...pinned, ...rest];
}

/**
 * The resume to build *this* posting's copy from, which is never that copy.
 *
 * The copy an application gets is named after the posting — `job-adobe-2027-
 * intern-software-engineer` — and it is a thin selection over a base. Apply
 * to the same posting twice and the second pass computes the same name, so if
 * the base it was handed happens to be that first copy, the resume is asked
 * to extend itself and the resolver refuses with "Resume inheritance cycle".
 *
 * Which is easy to arrive at: the copy shows up in the picker like any other
 * resume, the extension remembers whichever was chosen last, and the obvious
 * thing to pick when returning to a posting is the one already named after
 * it.
 *
 * The answer is the copy's own parent, which is what the person meant: build
 * it again from where it came from. Only when that is gone does this fall
 * back to the store's default, and it walks the chain rather than checking
 * one link, because a parent can be a copy of a copy.
 *
 * It refuses rather than repairing anything on disk. A resume that really
 * does extend itself is a store to be fixed in the editor, not quietly
 * rewritten underneath somebody.
 */
export function baseForCopy(resumes: ResumeSpec[], wanted: string | undefined, copyId: string): string | undefined {
  const asked = wanted ?? defaultBaseId(resumes);
  /*
   * Anything that is not this copy is handed back exactly as it came,
   * including an id that names nothing. "No resume called ghost" is the
   * caller's to say and worth saying — quietly building from a different
   * resume than the one asked for is the failure this whole function exists
   * to avoid, and it does not become acceptable because the name was a typo.
   */
  if (asked !== copyId) return asked;

  const seen = new Set<string>();
  let at: string | undefined = asked;
  while (at && at === copyId && !seen.has(at)) {
    seen.add(at);
    at = resumes.find((r) => r.id === at)?.extends;
  }
  /*
   * `seen` is what stops a store that already contains a self-extending
   * resume from spinning here — walking it lands back on the same id, and
   * the loop has to give up rather than follow it round again.
   *
   * And the answer has to name a resume that is actually there. A parent
   * that has been deleted would otherwise be handed on as the base and fail
   * two lines later as `No resume "…"`, which says nothing about what went
   * wrong or what to do; the store's default is both a real answer and the
   * one somebody would have picked.
   */
  const usable = at && at !== copyId && resumes.some((r) => r.id === at);
  return usable ? at : defaultBaseId(resumes.filter((r) => r.id !== copyId));
}
