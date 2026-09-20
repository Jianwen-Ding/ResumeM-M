import type { Application, Draft, ResumeSpec, ResumeTier, StoreData } from './types.js';
import { tierOf } from './types.js';

/**
 * How permanent a resume is, and how eagerly it is offered.
 *
 * A save fills up. One year of applying is a few hundred postings, and the
 * old model gave every one of them a resume that sat in the list forever,
 * named after a job that closed in March. The pickers grew to a scroll, the
 * one you actually build from was somewhere in the middle of it, and the only
 * way to tell the two apart was to read the names.
 *
 * Three tiers, which is what people already have in their heads:
 *
 *   `base` — what you build from. Comes first, and is what the extension
 *   offers by default. A handful of these, deliberately.
 *
 *   `extended` — a permanent resume in the save that is not offered first.
 *   The one you made for a particular kind of role and want to keep. Kept,
 *   findable, never swept.
 *
 *   `temporary` — made for one posting, worked on, sent, and then gone a week
 *   later. Recoverable from the version history like anything else deleted,
 *   and promotable out of the tier at any time.
 *
 * Absent means `extended`, and that is the important half of the rule: a
 * resume written by a version that had no tiers — or by hand, in a folder
 * advertised as editable YAML — is permanent until somebody says otherwise.
 * The sweep deletes things, and it must never delete one because of a field
 * its author had no way to know about.
 */

/** A week, which is the default life of a temporary resume. */
export const DEFAULT_TEMPORARY_DAYS = 7;

/**
 * Give an older save's resumes a tier, from what it already knows.
 *
 * `base: true` was the only tier there was: a resume pinned as a starting
 * point. Everything the extension made for a posting carries `generatedFor`,
 * which is exactly what `temporary` means. Everything else was written on
 * purpose and stays.
 *
 * Nothing is swept by this. See `dueToGo`: the clock on a resume that became
 * temporary in a migration starts when the migration ran, not when the
 * posting was applied to — a save upgraded today does not lose three months
 * of resumes tonight because a field appeared under it.
 */
export function tierForMigration(spec: ResumeSpec): ResumeTier {
  if (spec.base) return 'base';
  if (spec.generatedFor) return 'temporary';
  return 'extended';
}

/** True when a save still holds resumes written before tiers existed. */
export function needsTiering(all: ResumeSpec[]): boolean {
  return all.some((r) => !r.tier);
}

/**
 * Every resume with a tier written on it, and the moment the clock started.
 *
 * `since` is stamped on the resumes this pass makes temporary, and only on
 * those: a resume that was already temporary keeps the date it was given, or
 * it would live forever by being re-migrated.
 */
export function tierResumes(
  all: ResumeSpec[],
  since = new Date().toISOString(),
): { tiered: ResumeSpec[]; changed: string[] } {
  const changed: string[] = [];
  const tiered = all.map((spec) => {
    if (spec.tier) return spec;
    const tier = tierForMigration(spec);
    changed.push(spec.id);

    const next: ResumeSpec = { ...spec, tier };
    // The old flag is the tier now, and leaving both would let them disagree.
    delete next.base;
    if (tier === 'temporary' && !next.temporaryFrom) next.temporaryFrom = since;
    return next;
  });
  return { tiered, changed };
}

/** Bases first, then the permanent ones, then what is on its way out. */
const ORDER: Record<ResumeTier, number> = { base: 0, extended: 1, temporary: 2 };

/**
 * A list for a picker: by tier, and stable within each.
 *
 * Not a filter. A temporary resume is a perfectly good thing to open, look at
 * and promote — it is just not the answer to "where do I usually start".
 */
export function byTier(resumes: ResumeSpec[]): ResumeSpec[] {
  return [...resumes].sort((a, b) => ORDER[tierOf(a)] - ORDER[tierOf(b)]);
}

/**
 * When a temporary resume is done with, and its week starts counting.
 *
 * "Done with" is the application being sent, not the resume being made: a
 * posting you are still writing a cover letter for is not something to take
 * the resume away from, however long it has been open. Where there is no
 * application at all — a copy made and abandoned — the resume's own date
 * stands in, because otherwise nothing would ever clear it.
 *
 * `undefined` means it is not counting yet, which is the answer for a resume
 * whose application is still in flight.
 */
export function doneAt(
  spec: ResumeSpec,
  applications: Application[],
  drafts: Draft[] = [],
): string | undefined {
  /*
   * A workspace still open on this resume is the plainest statement there is
   * that nobody is done with it, and it was the one this never asked for.
   *
   * The paragraph above says "a posting you are still writing a cover letter
   * for is not something to take the resume away from", and then looked only
   * at the tracker — which does not necessarily know. `POST /workspace` writes
   * `resumeId` onto the tracker row only when it creates that row, so a job
   * already saved as `interested` never gets it; and the two endpoints that
   * attach a resume to a space, `/workspace/:id/variation` and
   * `/workspace/:id/tailor`, set it on the draft alone. In all three the
   * resume is referenced by the draft and by nothing else, so `mine` is empty
   * and the fallback below dates the clock from the moment the resume was
   * *made*.
   *
   * Seven days later it is deleted. The workspace card is still there, still
   * `drafting`, still pointing at it, and Preview, Compile and Complete all
   * fail with `No resume named "…"`. Nor does the space eventually close and
   * make that moot: `retireStaleDrafts` only ever lets go of drafts that have
   * been *submitted*, so one set aside and not sent stays open indefinitely
   * while the document under it is taken.
   */
  if (drafts.some((d) => d.resumeId === spec.id && d.status !== 'submitted')) return undefined;

  const mine = applications.filter((a) => a.resumeId === spec.id);

  if (mine.length > 0) {
    /*
     * Any application still going keeps the resume, whatever the others did.
     * Applying to two postings from one resume is ordinary, and the one that
     * closed is not permission to delete the document the other one is still
     * about.
     */
    const sent = mine.map((a) => sentAt(a));
    if (sent.some((at) => at === undefined)) return undefined;
    // The latest, so the week is measured from the last thing that happened.
    return sent.filter((at): at is string => Boolean(at)).sort().pop();
  }

  return spec.temporaryFrom ?? spec.generatedFor?.at;
}

/**
 * When an application stopped needing its resume, or `undefined` while it
 * still does.
 *
 * Read off the status, because the status is the thing the tracker actually
 * maintains — a timestamp of its own would be a second record of the same
 * fact, free to disagree with the first.
 *
 *   `interested`, `applying` — not sent. Nothing to take away yet, however
 *   long the posting has been sitting there.
 *
 *   `applied` — out of your hands, and the week starts.
 *
 *   `interview`, `offer` — sent, and still live. Somebody is about to ask you
 *   about the document you sent them, and the week does not run while that is
 *   true. This is the one that costs the sweep most of its work and is worth
 *   every bit of it.
 *
 *   `closed` — over, and counted from when it closed rather than from when it
 *   was sent, so a posting that ran for two months does not take its resume
 *   with it the day it ends.
 */
function sentAt(app: Application): string | undefined {
  if (app.status === 'applied') return app.appliedAt;
  if (app.status !== 'closed') return undefined;

  const closed = [...(app.history ?? [])].reverse().find((h) => h.status === 'closed');
  return closed?.at ?? app.appliedAt;
}

export interface DueToGo {
  id: string;
  label: string;
  /** When its week started. */
  since: string;
  /** When it goes, so the UI can say "in two days" rather than a date. */
  at: string;
}

/**
 * Which temporary resumes have run out their week.
 *
 * Deliberately a question rather than an action: the sweep that uses this is
 * a deletion, and a deletion that cannot be previewed is one nobody can trust.
 * The editor asks this to say what is about to go; the sweep asks the same
 * question and acts on the same answer, so the list and the deletion cannot
 * disagree.
 */
export function dueToGo(
  data: Pick<StoreData, 'resumes' | 'applications'> & Partial<Pick<StoreData, 'drafts'>>,
  { days = DEFAULT_TEMPORARY_DAYS, now = Date.now() }: { days?: number; now?: number } = {},
): DueToGo[] {
  const out: DueToGo[] = [];
  /*
   * Zero or less switches the sweep off rather than deleting everything
   * immediately, which is the only reading of "0" that cannot lose work by
   * being typed into a settings box by mistake.
   */
  if (!(days > 0)) return out;

  for (const spec of data.resumes) {
    if (tierOf(spec) !== 'temporary') continue;
    const since = doneAt(spec, data.applications ?? [], data.drafts ?? []);
    if (!since) continue;

    const started = Date.parse(since);
    // An unreadable date is not a reason to delete something.
    if (!Number.isFinite(started)) continue;

    const at = started + days * 24 * 60 * 60 * 1000;
    if (at <= now) out.push({ id: spec.id, label: spec.label, since, at: new Date(at).toISOString() });
  }
  return out;
}
