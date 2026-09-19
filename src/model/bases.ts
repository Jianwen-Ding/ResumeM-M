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
 * The resume to start from when the caller did not say. A pinned base wins;
 * then the conventional id; then a resume that was written rather than copied
 * off a posting, which is a better guess than the leftovers of an application
 * somebody sent in March.
 */
export function defaultBaseId(resumes: ResumeSpec[]): string | undefined {
  const pinned = resumes.find((r) => r.base);
  if (pinned) return pinned.id;

  const conventional = resumes.find((r) => r.id === CONVENTIONAL);
  if (conventional) return conventional.id;

  const written = resumes.find((r) => !r.copiedFrom && !r.generatedFor);
  return written?.id ?? resumes[0]?.id;
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
 * intern-software-engineer` — so applying to the same posting twice computes
 * the same name, and the second pass overwrites the first. The copy shows up
 * in the picker like any other resume, the extension remembers whichever was
 * chosen last, and the obvious thing to pick when returning to a posting is
 * the one already named after it. So "build this copy from itself" is easy to
 * ask for by accident.
 *
 * It no longer corrupts anything — resumes stand alone, and copying one onto
 * itself is just a write — but it is still the wrong answer, and quietly. The
 * copy's skills are already narrowed to this posting and its wordings already
 * chosen for it, so matching it again narrows what was narrowed: each pass
 * keeps fewer skills than the last, and what comes back is not what the
 * person asked for.
 *
 * What they meant is "build it again from where it came from", which
 * `copiedFrom` records. The walk follows that record rather than one link,
 * because a copy can have been made from a copy.
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
    at = resumes.find((r) => r.id === at)?.copiedFrom;
  }
  /*
   * `seen` stops a save whose provenance records point in a circle from
   * spinning here — a store copied about by hand can hold anything, and the
   * walk has to give up rather than follow it round again.
   *
   * And the answer has to name a resume that is actually there. A source
   * that has since been deleted would otherwise be handed on as the base and
   * fail two lines later as `No resume "…"`, which says nothing about what
   * went wrong or what to do; the store's default is both a real answer and
   * the one somebody would have picked.
   */
  const usable = at && at !== copyId && resumes.some((r) => r.id === at);
  return usable ? at : defaultBaseId(resumes.filter((r) => r.id !== copyId));
}
