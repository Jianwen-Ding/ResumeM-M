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
 *   `temporary` — made for one posting. Listed last, and gone a week after
 *   it is done with: abandoned, or its application closed without ever going
 *   out. One that was *sent* stays — see `wentOut` — because it is the only
 *   tracked record of what went out. Recoverable from the version history
 *   like anything else deleted, and promotable out of the tier at any time.
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
 * "Done with" is the application being over without having been sent, not
 * the resume being made: a posting you are still writing a cover letter for
 * is not something to take the resume away from, however long it has been
 * open, and a posting it was sent to is never done with (see `wentOut`).
 * Where there is no application at all — a copy made and abandoned — the
 * resume's own date stands in, because otherwise nothing would ever clear it.
 *
 * `undefined` means it is not counting, which is the answer for a resume
 * whose application is still in flight or went out.
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

  /*
   * And a resume an application went out with, even after that application
   * was built again from another one.
   *
   * Filing a sent application again moves its `resumeId` on to the new
   * resume, and this used to look at `resumeId` alone — so the resume that
   * had actually been sent was referenced by nothing, counted as abandoned
   * from the day it was made, and swept. The row remembers it in
   * `sentResumeIds`, and it is kept for the reason `wentOut` gives: the
   * employer can ask about that document whenever they like.
   */
  if (applications.some((a) => a.sentResumeIds?.includes(spec.id))) return undefined;

  const mine = applications.filter((a) => a.resumeId === spec.id);

  if (mine.length > 0) {
    /*
     * Any application still going keeps the resume, whatever the others did.
     * Applying to two postings from one resume is ordinary, and the one that
     * closed is not permission to delete the document the other one is still
     * about.
     */
    const sent = mine.map((a) => releasedAt(a));
    if (sent.some((at) => at === undefined)) return undefined;
    // The latest, so the week is measured from the last thing that happened.
    // As instants, through `later`: sorted as text, a close written with an
    // offset ("2026-10-05T23:00:00-07:00", which is 6 October in UTC) came
    // before "2026-10-06T01:00:00.000Z", and the week started early.
    const last = sent.reduce<string | undefined>((acc, at) => later(acc, at), undefined);

    /*
     * And never before the resume became temporary.
     *
     * `tierForMigration` promises this in as many words — "a save upgraded
     * today does not lose three months of resumes tonight because a field
     * appeared under it" — and `temporaryFrom` is how it was meant to work.
     * This branch never looked at it. It only ever reached the fallback
     * below when a resume had no application at all, and every resume the
     * extension makes has one, because filing the application is what the
     * extension does.
     *
     * So on the start that upgraded the save: the migration stamps
     * `temporary` and today's date, the sweep runs one line later in
     * `openSave`, this hands it an `appliedAt` from three months ago, and
     * every tailored resume in the save is deleted at once. The console says
     * "swept 47 temporary resume(s) … They are in the version history",
     * which is true and is not what anybody wanted to read.
     *
     * The same fix covers the other direction, which the route that marks a
     * resume temporary already worried about: "promoting it out has to
     * forget the date, or demoting it later would sweep it immediately".
     * Demoting one that had been applied with swept it immediately anyway.
     * A week means a week from the moment it was called temporary.
     */
    return later(last, spec.temporaryFrom);
  }

  return spec.temporaryFrom ?? spec.generatedFor?.at;
}

/**
 * The later of two moments, either of which may be missing or unreadable.
 *
 * Compared as instants rather than as strings, because `appliedAt` can have
 * been typed by hand or written by another tool and need not be the fixed-
 * width UTC form everything here produces. An unreadable one is handed back
 * as it is: `dueToGo` refuses to measure from a date it cannot read and keeps
 * the resume, which is the answer that cannot lose work.
 */
function later(a: string | undefined, b: string | undefined): string | undefined {
  if (!a) return b;
  if (!b) return a;
  const ta = Date.parse(a);
  if (!Number.isFinite(ta)) return a;
  const tb = Date.parse(b);
  if (!Number.isFinite(tb)) return b;
  return tb > ta ? b : a;
}

/**
 * Whether an application went out, which is what keeps its resume.
 *
 * This used to start the week at `applied`, on the argument the sweep's
 * header gives: "the files that were *sent* are in the application's
 * snapshot folder … the sweep removes the recipe, never the document". The
 * snapshot folder is under `out/`, and `out/` is not tracked — a save's own
 * README says so, "the first is rebuilt from the store" — and it cannot be
 * rebuilt from a store whose resume has been deleted. So the resume file was
 * the only record in the save's history of what was sent, and a week after
 * sending the sweep deleted it: measured on a real save, 100 rows at
 * `applied` naming resumes that no longer existed, three of them swept in one
 * commit a week after they went out, while the tracker still said `applied`.
 * That save's README describes the rule as "a week after the posting closes",
 * and for a posting that was sent nothing ever lets go of it: the employer
 * can ask about that document whenever they like.
 *
 * Read off the history, because that is where the tracker writes what
 * happened. A `closed` row went out if the last status it had before closing
 * was past `applying`; one with no history to read is kept, because the
 * sweep deletes things and "cannot tell" is not permission.
 */
const SENT: ReadonlySet<string> = new Set(['applied', 'interview', 'offer']);

export function wentOut(app: Application): boolean {
  if (SENT.has(app.status)) return true;
  if (app.status !== 'closed') return false;
  const before = [...(app.history ?? [])].reverse().find((h) => h.status !== 'closed');
  if (!before) return true;
  return SENT.has(before.status);
}

/**
 * When an application stopped needing its resume, or `undefined` while it
 * still does.
 *
 *   `interested`, `applying` — not sent. Nothing to take away yet, however
 *   long the posting has been sitting there.
 *
 *   `applied`, `interview`, `offer`, and `closed` after one of those — sent,
 *   and kept. See `wentOut`.
 *
 *   `closed` without having gone out — abandoned, or closed for sitting at
 *   Applying — counted from when it closed.
 */
function releasedAt(app: Application): string | undefined {
  if (app.status !== 'closed' || wentOut(app)) return undefined;

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
