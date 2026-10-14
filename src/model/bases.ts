import { createHash } from 'node:crypto';
import { byTier } from './tiers.js';
import { tierOf, type ResumeSpec } from './types.js';

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

/** The resumes marked as the ones to build from. */
export function baseResumes(resumes: ResumeSpec[]): ResumeSpec[] {
  return resumes.filter((r) => tierOf(r) === 'base');
}

/**
 * The resume to start from when the caller did not say. A pinned base wins;
 * then the conventional id; then a resume that was written rather than copied
 * off a posting, which is a better guess than the leftovers of an application
 * somebody sent in March.
 */
export function defaultBaseId(resumes: ResumeSpec[]): string | undefined {
  const pinned = resumes.find((r) => tierOf(r) === 'base');
  if (pinned) return pinned.id;

  const conventional = resumes.find((r) => r.id === CONVENTIONAL);
  if (conventional) return conventional.id;

  /*
   * Then anything that is not on its way out, and only then the leftovers.
   * A resume made for a posting last March is a poor guess at "where do I
   * usually start" even when it is the only thing in the save — but it is
   * still better than nothing, which is why the last clause is there.
   */
  const kept = resumes.find((r) => tierOf(r) !== 'temporary' && !r.copiedFrom && !r.generatedFor);
  return kept?.id ?? resumes.find((r) => tierOf(r) !== 'temporary')?.id ?? resumes[0]?.id;
}

/**
 * Bases first, for a picker — and now by tier, so what is on its way out
 * sorts last rather than wherever its filename put it.
 *
 * Not a filter: a resume that is not a base is still a perfectly good thing
 * to build from, it is just not the answer to "where do I usually start".
 */
export function byBaseFirst(resumes: ResumeSpec[]): ResumeSpec[] {
  return byTier(resumes);
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

/**
 * The resume a standing default names, as a starting point for this posting.
 *
 * The extension keeps one default for every tab and every posting, and it
 * used to be written by whichever card last changed its "Start from" picker.
 * Choosing another application's tailored copy there, which the picker offers,
 * made that copy the starting point of every posting after it. Measured on a
 * user's store: a Waymo posting opened on "Engineering Software Developer,
 * Intern | Keysight Technologies", a temporary resume built for and sent to
 * Keysight, over the base they meant to use.
 *
 * A temporary resume belongs to the posting it was made for. Named by a
 * default for any other posting, it gives way to the store's own default, as
 * long as the store has a resume that is not temporary. A choice made for this
 * application is not a default and does not come through here. See
 * `/extension/analyze`.
 */
export function standingBase(
  resumes: ResumeSpec[],
  wanted: string | undefined,
  madeForThis: (spec: ResumeSpec) => boolean,
): string | undefined {
  const named = wanted ? resumes.find((r) => r.id === wanted) : undefined;
  if (!named || tierOf(named) !== 'temporary' || madeForThis(named)) return wanted;
  return defaultBaseId(resumes.filter((r) => tierOf(r) !== 'temporary')) ?? wanted;
}

/**
 * The id a new tailored copy may take without writing over a resume that was
 * kept.
 *
 * A copy's id is derived from the company and the role, so the same posting
 * derives the same id every time — which is right for a second run, whose
 * temporary copy replaces the first. It is not right once that first copy was
 * promoted to a kept resume and edited: tailoring again wrote a fresh
 * temporary copy over it, the edits went, and the resume was marked for the
 * sweep. So an id held by anything but a temporary copy is skipped, and the
 * new copy takes the next one that is free.
 */
export function copyIdFor(resumes: ResumeSpec[], id: string, anothers?: (held: ResumeSpec) => boolean): string {
  /*
   * And, where the caller can tell, never over a temporary copy that belongs
   * to another posting (`anothers`): two postings with one company and one
   * role derive one id, and the second's tailoring wrote over the first's.
   */
  const free = (candidate: string) => {
    const held = resumes.find((r) => r.id === candidate);
    return !held || (held.tier === 'temporary' && !anothers?.(held));
  };
  if (free(id)) return id;
  for (let n = 2; ; n++) {
    const next = `${id}-${n}`;
    if (free(next)) return next;
  }
}

/**
 * What a tailored copy says, as one string: its sections, wordings, lists and
 * layout — what Tailor writes and what an edit to the copy changes — and not
 * its name, its notes, or which entries are folded in the editor.
 *
 * Recorded as `generatedFor.tailored` when the workspace tailors a copy.
 * Tailoring again rebuilt the copy from its base and wrote it over whatever
 * was there, so a wording chosen by hand on the copy since went without a
 * word; compared with this, the edit is noticed and asked about first.
 */
export function tailoredFingerprint(spec: ResumeSpec): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.keys(value as Record<string, unknown>)
          .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
          .sort()
          .map((k) => [k, canonical((value as Record<string, unknown>)[k])]),
      );
    }
    return value;
  };
  const { sections, choices, lists, layout } = spec;
  const text = JSON.stringify(canonical({ sections, choices: choices ?? {}, lists: lists ?? {}, layout: layout ?? {} }));
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/**
 * `spec` with `generatedFor.tailored` recorded, for any path that writes a
 * tailored copy's content — the extension's analysis, filing a copy from
 * JobHelper's card, starting a variation — and not only the workspace's
 * Tailor. Those wrote the copy with no fingerprint, and a copy without one
 * reads as never edited, so tailoring again wrote over a hand edit made to a
 * copy JobHelper had filed without a word.
 *
 * `held` is the copy as the save has it now. When what is written is what is
 * already there — the card filing again the copy it read back — the
 * fingerprint already recorded stays: recording a fresh one would make an
 * edit made since the last tailoring read as the tailoring itself. A spec
 * with no `generatedFor` is not a tailored copy and is left as it is.
 */
export function withTailoredFingerprint(spec: ResumeSpec, held?: ResumeSpec): ResumeSpec {
  if (!spec.generatedFor) return spec;
  const now = tailoredFingerprint(spec);
  const kept = held?.generatedFor?.tailored;
  const tailored = typeof kept === 'string' && tailoredFingerprint(held!) === now ? kept : now;
  return { ...spec, generatedFor: { ...spec.generatedFor, tailored } };
}

/** Whether a tailored copy was changed since Tailor last wrote it. Unknown (never recorded) is not. */
export function editedSinceTailored(spec: ResumeSpec): boolean {
  const recorded = spec.generatedFor?.tailored;
  return typeof recorded === 'string' && recorded !== tailoredFingerprint(spec);
}
