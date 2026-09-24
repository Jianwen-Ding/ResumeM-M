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
 * the history the same way a deleted entry does. The files that were *sent*
 * are in the application's snapshot folder and are not touched by any of this
 * — the sweep removes the recipe, never the document.
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
  return dueToGo(store.load(), { days: temporaryDays(store), now });
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
  const due = dueToGo(store.load(), { days, now });
  if (due.length === 0) return { swept: [], held: [], days };

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
    (d) => store.deleteResume(d.id),
  );
  return { swept: removed, held, days };
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
