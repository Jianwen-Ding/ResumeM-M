import fs from 'node:fs';
import path from 'node:path';
import { withCommit } from '../git/repo.js';
import type { Repo } from '../git/repo.js';
import { Store } from '../model/store.js';
import { DEFAULT_TEMPORARY_DAYS, dueToGo, type DueToGo } from '../model/tiers.js';

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

/** Every path the newest commit holds, or nothing at all if it holds none. */
async function committed(repo: Repo): Promise<Set<string>> {
  try {
    const [head] = await repo.log(1);
    if (!head) return new Set();
    return new Set((await repo.treeAt(head.hash)).keys());
  } catch {
    // Git is not answering. Nothing is known to be recoverable, so nothing is.
    return new Set();
  }
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
 *
 * Which is also why what is about to go is filed first, and why the deletion
 * is then held to what the history can be seen to have. Filing is the fix;
 * the check is the part that cannot be wrong, because it asks git rather than
 * assuming git did as it was told.
 */
export async function sweepTemporary(
  store: Store,
  repo: Repo,
  { now = Date.now() }: { now?: number } = {},
): Promise<SweepResult> {
  const days = temporaryDays(store);
  const due = dueToGo(store.load(), { days, now });
  if (due.length === 0) return { swept: [], held: [], days };

  const filesOf = (d: DueToGo) =>
    Store.resumeFiles(d.id).filter((rel) => fs.existsSync(path.join(store.root, rel)));

  /*
   * File what is about to go, if it is not filed already.
   *
   * Scoped to those files: everything else in the save is the user's work in
   * progress, and a sweep is no reason to commit it for them. A resume that is
   * already committed stages nothing and this makes no commit at all.
   */
  await repo
    .commitAll(`File ${naming(due)} before sweeping`, due.flatMap(filesOf))
    .catch(() => undefined);

  const inHistory = await committed(repo);
  const swept = due.filter((d) => Store.resumeFiles(d.id).some((rel) => inHistory.has(rel)));
  const held = due.filter((d) => !swept.includes(d));
  if (swept.length === 0) return { swept, held, days };

  await withCommit(repo, true, `Sweep ${naming(swept)} — temporary, and done with`, () => {
    for (const { id } of swept) store.deleteResume(id);
  });
  return { swept, held, days };
}
