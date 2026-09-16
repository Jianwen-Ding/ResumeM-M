import type { PendingChange, RemoteStatus, Repo } from './repo.js';

/**
 * One deliberate "save everything" for the store.
 *
 * Auto-commit handles the edits made through the app, but that is not the
 * whole story: it can be switched off, the store is plain YAML that people
 * edit in an editor, and a first run has a directory that is not a repository
 * yet. This is the command that makes the answer to "is my work safe?"
 * unambiguous — initialise if needed, commit everything in the store, and
 * optionally push it to the remote — and the CLI, the API, and the GUI button
 * all run exactly this, so they cannot drift apart.
 */

export interface SaveOptions {
  /** Commit message. One is derived from what changed when omitted. */
  message?: string;
  /** Also push to `origin` afterwards. */
  push?: boolean;
}

export interface SaveResult {
  /** False when everything was already committed — not an error. */
  saved: boolean;
  /** Set when this call created the repository. */
  initialised: boolean;
  hash?: string;
  message: string;
  /** What went into the commit. Empty when there was nothing to save. */
  files: PendingChange[];
  remote: RemoteStatus;
  /** Present only when a push was asked for. */
  pushed?: { ok: boolean; output: string };
}

/**
 * Which parts of the store a set of paths touches, in the words the app uses
 * for them. A commit message that says "2 resumes, answers" is worth more than
 * one that says "Save store", and worth more than a list of forty filenames.
 */
/** Most-to-least interesting, for the summary a commit message leads with. */
const ORDER = [
  'resume',
  'cover letter',
  'draft',
  'writing sample',
  'entries',
  'skills',
  'the profile',
  'the answer bank',
  'the tracker',
  'voice notes',
  'settings',
  'other files',
];

export function describePending(files: PendingChange[]): string {
  const counts = new Map<string, number>();
  const bump = (what: string) => counts.set(what, (counts.get(what) ?? 0) + 1);

  for (const { path: file } of files) {
    if (file.startsWith('resumes/')) bump('resume');
    else if (file.startsWith('letters/')) bump('cover letter');
    else if (file.startsWith('drafts/')) bump('draft');
    else if (file.startsWith('corpus/')) bump('writing sample');
    else if (file === 'applications.yaml') bump('the tracker');
    else if (file === 'answers.yaml') bump('the answer bank');
    else if (file === 'skills.yaml') bump('skills');
    else if (file === 'profile.yaml') bump('the profile');
    else if (file === 'config.yaml') bump('settings');
    else if (file === 'voice.md') bump('voice notes');
    else if (/^(education|experience|projects|custom)\.yaml$/.test(file)) bump('entries');
    else bump('other files');
  }

  // "the tracker" and "skills" are already plural or singular-by-nature; only
  // the counted things take an -s.
  const COUNTABLE = new Set(['resume', 'cover letter', 'draft', 'writing sample']);
  const parts = [...counts.entries()]
    // Alphabetical filenames would put "the answer bank" ahead of the resume
    // that was the actual work. Lead with what the message is really about.
    .sort((a, b) => ORDER.indexOf(a[0]) - ORDER.indexOf(b[0]))
    .map(([what, n]) => (COUNTABLE.has(what) ? `${n} ${what}${n === 1 ? '' : 's'}` : what));

  if (parts.length === 0) return 'Save store';
  const shown = parts.slice(0, 4).join(', ');
  const rest = parts.length > 4 ? `, and ${parts.length - 4} more` : '';
  return `Save: ${shown}${rest}`;
}

export async function saveStore(repo: Repo, opts: SaveOptions = {}): Promise<SaveResult> {
  const initialised = !(await repo.isRepo());
  // A store that is not a repository yet becomes one here: "save my work"
  // should never fail on a setup step the user did not know about.
  if (initialised) await repo.ensure();

  // Read the pending list before committing — afterwards there is nothing to
  // read, and this is what the caller reports back to the user.
  let files = await repo.pending();
  let message = opts.message?.trim() || describePending(files);
  let hash = files.length > 0 ? await repo.commitAll(message) : undefined;

  // Initialising already committed the store, so `pending` is empty and the
  // honest answer is not "nothing had changed" — it is "all of it was saved,
  // just now". Report that first commit as the save it was.
  if (initialised && !hash) {
    const head = (await repo.log(1))[0];
    const detail = head ? await repo.commit(head.hash) : undefined;
    if (detail && detail.files.length > 0) {
      hash = detail.hash;
      message = detail.message;
      files = detail.files.map((f) => ({ path: f.path, state: 'added' as const }));
    }
  }

  const result: SaveResult = {
    saved: Boolean(hash),
    initialised,
    hash,
    message,
    files,
    remote: await repo.remoteStatus(),
  };

  if (opts.push) {
    // Pushing with nothing new locally is still worth doing: an earlier save
    // may not have reached the remote.
    result.pushed = await repo.push();
    result.remote = await repo.remoteStatus();
  }

  return result;
}
