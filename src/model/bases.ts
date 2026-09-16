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
