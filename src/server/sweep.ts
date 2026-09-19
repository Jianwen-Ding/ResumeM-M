import { withCommit } from '../git/repo.js';
import type { Repo } from '../git/repo.js';
import type { Store } from '../model/store.js';
import { DEFAULT_TEMPORARY_DAYS, dueToGo, type DueToGo } from '../model/tiers.js';

/**
 * Taking away the resumes that were made for one posting and are done with.
 *
 * The one piece of this program that deletes something nobody asked it to
 * delete, which is why every line here is about not doing it wrongly.
 *
 * What makes it acceptable at all is that nothing is actually lost: the store
 * is a git repository, the sweep commits, and a swept resume comes back out
 * of the history the same way a deleted entry does. The files that were
 * *sent* are in the application's snapshot folder and are not touched by any
 * of this — the sweep removes the recipe, never the document.
 */

export interface SweepResult {
  /** What went, in the order it went. */
  swept: DueToGo[];
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

/**
 * Take them, in one commit.
 *
 * One commit for the lot, named with what went: a sweep that spread itself
 * over eleven commits would bury the history it is supposed to be
 * recoverable from. Committed even when auto-commit is off, and that is
 * deliberate — auto-commit is about whether your *edits* are recorded as you
 * make them, and this is not an edit you made. A deletion that is not in the
 * history is the one thing here that would be unrecoverable.
 */
export async function sweepTemporary(
  store: Store,
  repo: Repo,
  { now = Date.now() }: { now?: number } = {},
): Promise<SweepResult> {
  const days = temporaryDays(store);
  const swept = dueToGo(store.load(), { days, now });
  if (swept.length === 0) return { swept, days };

  const named = swept.slice(0, 3).map((d) => `"${d.label}"`).join(', ');
  const rest = swept.length > 3 ? ` and ${swept.length - 3} more` : '';
  await withCommit(repo, true, `Sweep ${named}${rest} — temporary, and done with`, () => {
    for (const { id } of swept) store.deleteResume(id);
  });
  return { swept, days };
}
