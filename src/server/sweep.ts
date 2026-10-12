import fs from 'node:fs';
import path from 'node:path';
import { removeWhatIsFiled, withCommit } from '../git/repo.js';
import type { Repo } from '../git/repo.js';
import { Store } from '../model/store.js';
import { DEFAULT_TEMPORARY_DAYS, dueToGo, type DueToGo } from '../model/tiers.js';
import { closeStale, DEFAULT_APPLYING_DAYS, goneStale } from '../model/applications.js';
import type { Application } from '../model/types.js';
import { workdayEmployer } from '../jobs/extract.js';

/**
 * Taking away the resumes that were made for one posting and are done with.
 *
 * The one piece of this program that deletes something nobody asked it to
 * delete, which is why every line here is about not doing it wrongly.
 *
 * What makes it acceptable at all is that nothing is actually lost: the store
 * is a git repository, the sweep commits, and a swept resume comes back out of
 * the history the same way a deleted entry does.
 *
 * And it never takes the resume of an application that went out. This used
 * to say "the files that were *sent* are in the application's snapshot
 * folder … the sweep removes the recipe, never the document" — but that
 * folder is under `out/`, which a save does not track, so the recipe was the
 * only tracked record of what was sent. See `wentOut` in model/tiers.ts.
 *
 * That argument has a hole in it, and it is the reason for the first half of
 * `sweepTemporary`: committing the *deletion* recovers nothing if the resume
 * was never committed in the first place. Auto-commit is a setting people turn
 * off, and even with it on a commit that fails is a console warning and no
 * retry — so a resume can sit on disk, in no commit at all, for the week it
 * takes to become sweepable. Deleting that one is not "removed, and in the
 * history". It is gone.
 */

export interface SweepResult {
  /** What went, in the order it went. */
  swept: DueToGo[];
  /**
   * What was due and was left alone, because the history does not have it and
   * taking it would have been unrecoverable. Empty on any save whose git is
   * working, which is the point: this is the net, not the mechanism.
   */
  held: DueToGo[];
  /** The window in days, so a caller can say why nothing happened. */
  days: number;
}

/** How long a temporary resume lives in this save. */
export function temporaryDays(store: Store): number {
  const said = store.loadConfig().resumes?.temporaryDays;
  return typeof said === 'number' ? said : DEFAULT_TEMPORARY_DAYS;
}

/**
 * What the sweep would take right now, without taking it.
 *
 * The editor asks this to show the list before anything happens, and the
 * sweep below asks the same function — so what is shown and what is deleted
 * cannot drift apart, which is the way a preview usually goes wrong.
 */
export function wouldSweep(store: Store, now = Date.now()): DueToGo[] {
  return dueNow(store, temporaryDays(store), now);
}

/**
 * `dueToGo`, less every resume whose file says `extended`.
 *
 * A sent temporary resume is written as `extended` with `keptBecauseSent`
 * (`keptOnDisk` in model/tiers.ts) and read back by `asLoaded` as the
 * temporary copy it is, and "the sweep still keeps it, for the reason it
 * always did — it was sent" was true only while a row said so. Delete the
 * application, or file it again from another resume without the row
 * remembering this one, and nothing named it: `doneAt` counted it as a copy
 * made and abandoned, from the day it was made, and the sweep took the one
 * record of what was sent. What is on disk is the keep, and it is the
 * promise made to every other version of the app that opens this save —
 * `extended` is never swept — so this version keeps it too, whatever
 * `asLoaded` shows. Read as written, because the loaded tier is the one
 * thing that cannot tell the two apart.
 */
function dueNow(store: Store, days: number, now: number): DueToGo[] {
  const due = dueToGo(store.load(), { days, now });
  if (due.length === 0) return due;
  const extended = new Set(
    store
      .loadResumesAsWritten()
      .filter((spec) => spec.tier === 'extended')
      .map((spec) => spec.id),
  );
  return due.filter((d) => !extended.has(d.id));
}

/** "Alpha", "Alpha, Beta" — and a count once a list would be a wall. */
function naming(due: DueToGo[]): string {
  const first = due.slice(0, 3).map((d) => `"${d.label}"`).join(', ');
  return `${first}${due.length > 3 ? ` and ${due.length - 3} more` : ''}`;
}

/**
 * Take them, in one commit, named with what went.
 *
 * The filing before it and the check that holds the deletion to what the
 * history has are `removeWhatIsFiled`, which the workspace retirement uses
 * too: the argument for deleting something nobody asked to delete is the same
 * in both places, and so is the hole that was in it.
 */
export async function sweepTemporary(
  store: Store,
  repo: Repo,
  { now = Date.now() }: { now?: number } = {},
): Promise<SweepResult> {
  const days = temporaryDays(store);
  const due = dueNow(store, days, now);
  if (due.length === 0) return { swept: [], held: [], days };

  /*
   * What each one was when it was found due, byte for byte.
   *
   * `due` is an answer from before the filing commit and the status check,
   * and both of those wait on git — long enough for the editor to promote the
   * resume to extended, or for somebody to save an edit to it. Deleting from
   * the stale answer took the one they had just decided to keep, and an edit
   * made after the check is in no commit at all. So the deletion asks again,
   * in the synchronous callback where nothing can land between the question
   * and the act: still due, and still the file that was found due. Anything
   * else is held, like one the history does not have.
   */
  const read = (id: string) =>
    Store.resumeFiles(id).map((rel) => {
      try {
        return fs.readFileSync(path.join(store.root, rel), 'utf8');
      } catch {
        return null;
      }
    });
  const found = new Map(due.map((d) => [d.id, JSON.stringify(read(d.id))]));
  const changed: DueToGo[] = [];

  /*
   * "Still due" is asked once, at the first deletion, and the answer kept for
   * the rest.
   *
   * It was asked once per resume, and asking is a whole `store.load()` — every
   * resume, the tracker, the letters, the drafts — so sweeping ninety resumes
   * out of a save with a thousand applications loaded that save ninety times
   * and took three times as long as the sweep it replaced. The re-check is
   * there for what can land while git is busy, and nothing can land between
   * one deletion and the next: `removeWhatIsFiled` calls this for every resume
   * in one synchronous loop, so the answer taken at the first is still the
   * answer at the last. Nor does a deletion change it for the others — whether
   * a resume is due reads that resume, the tracker and the workspaces, never
   * another resume. The per-file comparison stays per resume, because it is a
   * read of two small files and it is the half that catches an edit.
   */
  let stillDue: Set<string> | undefined;
  let migrated = false;

  const { removed, held } = await removeWhatIsFiled(
    repo,
    store.root,
    due.map((d) => ({ paths: Store.resumeFiles(d.id), what: d })),
    {
      filing: `File ${naming(due)} before sweeping`,
      // Named with what actually goes, not with what was due: one that
      // could not be filed is still there and does not belong in the message.
      removing: (swept) => `Sweep ${naming(swept)} — temporary, and done with`,
    },
    (d) => {
      stillDue ??= new Set(dueNow(store, days, now).map((x) => x.id));
      if (stillDue.has(d.id) && JSON.stringify(read(d.id)) === found.get(d.id)) {
        /*
         * And the fold `deleteResume` does before every deletion, done here
         * once, before the first. It reads every resume in the save to find
         * out that there is nothing to fold, which is the answer every time
         * after the first. A fold that did change something is the one thing
         * that could move the answer above, so that answer is asked again.
         */
        if (!migrated) {
          migrated = true;
          const folded = store.migrateResumes();
          if (folded.flattened.length + folded.tiered.length + folded.lifted.length > 0) stillDue = undefined;
        }
        // The label is only for the message if the file will not go, and
        // `due` has it already; see `deleteResume`.
        store.deleteResume(d.id, { migrated: true, label: d.label });
      } else changed.push(d);
    },
  );
  return { swept: removed.filter((d) => !changed.includes(d)), held: [...held, ...changed], days };
}

/** How long an application may sit at Applying in this save. */
export function applyingDays(store: Store): number {
  const said = store.loadConfig().applications?.applyingDays;
  return typeof said === 'number' ? said : DEFAULT_APPLYING_DAYS;
}

/**
 * Close what has sat at Applying for the window with nothing done to it.
 *
 * On opening the save, like the resume sweep, and for its reason: never at
 * the moment a clock ticks over under somebody using the tracker. Scoped to
 * the tracker file, because this is the app changing something on its own
 * and has no business committing whatever else is unsaved on disk.
 */
export async function closeStaleApplying(
  store: Store,
  repo: Repo,
  { now = Date.now() }: { now?: number } = {},
): Promise<Application[]> {
  const days = applyingDays(store);
  const stale = goneStale(store.load().applications, store.loadDrafts(), { days, now });
  if (stale.length === 0) return [];
  const names = stale.slice(0, 3).map((s) => `${s.company} — ${s.role}`).join(', ');
  return withCommit(
    repo,
    store.loadConfig().git.autoCommit,
    `Close ${names}${stale.length > 3 ? ` and ${stale.length - 3} more` : ''} — ${days} days at Applying`,
    () => closeStale(store, stale, days),
    ['applications.yaml'],
  );
}

/**
 * Employer names stored the way Workday books them, put right.
 *
 * `workdayEmployer` stops "2100 NVIDIA USA" being read off a Workday page from
 * now on; the rows already filed under such a name are still filed under it,
 * and an application still in flight would then be sent under the tidied
 * name and land in a second row beside its own. Only rows whose address is a
 * Workday board, by the same rule the reading uses, and in one commit of the
 * tracker and the workspaces.
 */
export async function tidyWorkdayNames(store: Store, repo: Repo): Promise<string[]> {
  const apps = store.load().applications;
  const renamed: string[] = [];
  for (const app of apps) {
    const tidied = workdayEmployer(app.company, app.url);
    if (tidied && tidied !== app.company) {
      renamed.push(`${app.company} → ${tidied}`);
      app.company = tidied;
    }
  }
  const drafts = store.loadDrafts().filter((d) => {
    const tidied = workdayEmployer(d.company, d.url);
    return tidied && tidied !== d.company;
  });
  if (renamed.length === 0 && drafts.length === 0) return [];
  await withCommit(
    repo,
    store.loadConfig().git.autoCommit,
    `Tidy Workday employer names — ${renamed.slice(0, 3).join(', ') || `${drafts.length} workspace(s)`}`,
    () => {
      if (renamed.length > 0) store.saveApplications(apps);
      for (const d of drafts) store.saveDraft({ ...d, company: workdayEmployer(d.company, d.url)! }, { touch: false });
    },
    ['applications.yaml', 'drafts'],
  );
  return renamed;
}
