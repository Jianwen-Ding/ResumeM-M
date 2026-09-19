import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface CommitDetail {
  hash: string;
  date: string;
  author: string;
  message: string;
  body: string;
  files: { path: string; added: number | null; removed: number | null }[];
  diff: string;
}

export interface PendingChange {
  path: string;
  state: 'added' | 'modified' | 'deleted' | 'renamed';
}

export interface RemoteStatus {
  /** Configured push url, if any. */
  url?: string;
  branch?: string;
  /** Commits made locally that the remote does not have. */
  ahead: number;
  /** Commits on the remote that are not local. */
  behind: number;
  /** False when the remote has never been contacted. */
  tracked: boolean;
}

/**
 * Thin wrapper over the local git repo holding the store. Version history is
 * the feature here: "what did the resume I sent in March actually say?" should
 * be answerable, and a plain git log answers it.
 */
export class Repo {
  readonly root: string;
  /**
   * Paths auto-commit is allowed to stage, relative to the repo root. Without
   * this, a store that shares a repo with its own source code would sweep
   * unrelated edits into "Update profile" commits.
   */
  readonly scope: string[];

  /**
   * Why the last automatic commit did not happen, if one did not.
   *
   * An auto-commit that fails cannot stop the edit — the file is already
   * written and losing it would be worse than losing its history — so the
   * failure was a line in the server's console and nothing else. Nobody reads
   * that, and the cost of not reading it is silent: the editor goes on saying
   * "All changes saved", because it is telling the truth about the file, while
   * the version history has quietly stopped recording. Everything built on the
   * history is then built on nothing — "restore this version", the diff
   * between two resumes, and the sweep, which now refuses to delete a resume
   * the history does not have and needs to be able to say why.
   *
   * Cleared by the next commit that works, so this is the current state of the
   * save rather than a log of everything that has ever gone wrong.
   */
  lastCommitError?: { message: string; at: string };

  constructor(root: string, scope: string[] = ['.']) {
    this.root = path.resolve(root);
    this.scope = scope.length > 0 ? scope : ['.'];
  }

  /**
   * The repository for a store.
   *
   * The store is always its own repository, rooted at the store directory —
   * deliberately *not* the repository the application's source happens to live
   * in. Your resume history is yours, it has a different lifetime from the
   * tool's code, and it is the thing you might one day push to a private
   * GitHub repo. Sharing a repo with the source would entangle all three.
   */
  static forStore(storeDir: string): Repo {
    return new Repo(path.resolve(storeDir), ['.']);
  }

  private async git(args: string[]): Promise<string> {
    const { stdout } = await run('git', args, { cwd: this.root, maxBuffer: 8 * 1024 * 1024 });
    return stdout;
  }

  /**
   * Is *this directory* the root of a repository?
   *
   * Deliberately not "is it inside one". A store placed inside the
   * application's checkout would otherwise report the source repository as its
   * own and commit your resume history into it. The store owns its root or it
   * does not have one yet.
   */
  async isRepo(): Promise<boolean> {
    try {
      const top = (await this.git(['rev-parse', '--show-toplevel'])).trim();
      if (!top) return false;
      return fs.realpathSync(top) === fs.realpathSync(this.root);
    } catch {
      return false;
    }
  }

  /** Initialise a repo if the store is not already inside one. */
  async ensure(): Promise<void> {
    if (await this.isRepo()) return;
    fs.mkdirSync(this.root, { recursive: true });
    await this.git(['init']);

    // --allow-empty so a brand-new store still gets a baseline commit. Without
    // one, git has no HEAD and every later read of the history fails.
    await this.git(['add', '--', ...this.scope]).catch(() => undefined);
    await this.git([
      '-c',
      'user.name=ResumeM-M',
      '-c',
      'user.email=resumem-m@localhost',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'Initialise resume store',
    ]);
  }

  /**
   * Stage everything under `paths` and commit. Returns the new commit hash, or
   * undefined when there was nothing to commit — a no-op save should not be an
   * error, and should not create an empty commit either.
   */
  async commitAll(message: string, paths?: string[]): Promise<string | undefined> {
    /*
     * One commit at a time, per repository.
     *
     * `add`, `diff --cached` and `commit` are three separate git processes, and
     * two overlapping requests interleaved them: "fatal: cannot lock ref 'HEAD'"
     * or "Unable to create '.git/index.lock'", swallowed by `withCommit` into a
     * console warning behind a 200. No text was lost — both writes rode into
     * whichever commit survived — but one edit got no history entry of its own,
     * and the history is what "restore this version" is built on. A version you
     * can see in the timeline and cannot go back to is worse than the delay of
     * waiting a moment for the commit in front.
     */
    const previous = Repo.commits.get(this.root) ?? Promise.resolve();
    let release!: () => void;
    const finished = new Promise<void>((done) => (release = done));
    const chained = previous.then(() => finished);
    Repo.commits.set(this.root, chained);

    await previous;
    try {
      return await this.commitNow(message, paths);
    } finally {
      release();
      // Only when nothing queued behind this one, so the next caller either
      // waits for a real predecessor or starts a fresh chain.
      if (Repo.commits.get(this.root) === chained) Repo.commits.delete(this.root);
    }
  }

  /** Serialised per repository directory by `commitAll`. */
  private static readonly commits = new Map<string, Promise<void>>();

  private async commitNow(message: string, paths?: string[]): Promise<string | undefined> {
    if (!(await this.isRepo())) return undefined;
    const targets = paths ?? this.scope;
    await this.git(['add', '--', ...targets]);

    // Only commit what is staged within scope; unrelated working-tree changes
    // elsewhere in the repo must not ride along.
    const staged = await this.git(['diff', '--cached', '--name-only', '--', ...targets]);
    if (!staged.trim()) return undefined;

    /*
     * No pathspec on the commit itself.
     *
     * `git commit -- <paths>` is a *partial* commit, and that had two costs.
     * Git refuses one outright while a merge is in progress, so anyone who
     * pulled their store on a second machine and resolved a conflict by hand
     * could never save again through the app — "fatal: cannot do a partial
     * commit during a merge" — and the GUI only console.warn'd it, so the
     * editor reported 200 OK and committed nothing. And a partial commit
     * records the *working tree* at commit time rather than the index that
     * `git diff --cached` just checked, so a concurrent write could put a
     * different version of a file into the commit than the one that was staged.
     *
     * The `git add -- targets` above already scopes what goes in.
     */
    // -c keeps the commit working even if the machine has no global identity.
    await this.git([
      '-c',
      'user.name=ResumeM-M',
      '-c',
      'user.email=resumem-m@localhost',
      'commit',
      '-q',
      '-m',
      message,
    ]);
    return (await this.git(['rev-parse', 'HEAD'])).trim();
  }

  /**
   * What is changed but not yet committed, within scope.
   *
   * With auto-commit on this is normally empty. It is not always: auto-commit
   * can be off, and the store is plain YAML that people edit by hand, which is
   * half the reason it is plain YAML. Knowing there is unsaved work is what
   * makes an explicit save worth offering.
   */
  async pending(): Promise<PendingChange[]> {
    if (!(await this.isRepo())) return [];
    // `-uall` because porcelain otherwise collapses a wholly untracked
    // directory to a single entry, so `rmm save` said "Saved 1 file — drafts/"
    // and committed six, and the editor's unsaved-work list under-reported the
    // same way.
    const out = await this.git(['status', '--porcelain', '-uall', '-z', '--', ...this.scope]).catch(() => '');

    const records = out.split('\0');
    const changes: PendingChange[] = [];
    for (let i = 0; i < records.length; i++) {
      const record = records[i];
      if (!record) continue;
      const code = record.slice(0, 2);
      const file = record.slice(3);
      // A rename or copy carries its old path in the following record.
      if (code[0] === 'R' || code[0] === 'C') i++;
      changes.push({ path: file, state: stateOf(code) });
    }
    return changes.sort((a, b) => a.path.localeCompare(b.path));
  }

  async log(limit = 30): Promise<{ hash: string; date: string; message: string }[]> {
    if (!(await this.isRepo())) return [];
    // A repo with no commits yet makes `git log` fail rather than print
    // nothing; an empty history is not an error to a caller.
    const out = await this.git(['log', `-${limit}`, '--pretty=format:%H%x01%aI%x01%s']).catch(
      () => '',
    );
    return out
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [hash = '', date = '', message = ''] = line.split('\u0001');
        return { hash, date, message };
      });
  }

  /** Contents of a file at a past commit, for recovering an old phrasing. */
  async show(hash: string, relPath: string): Promise<string> {
    return this.git(['show', `${hash}:${relPath}`]);
  }

  /**
   * Commits that touched one file, oldest problem first for this class of
   * question: "how has this specific resume changed over time?" A version
   * history that means anything is scoped to one file, not the whole store —
   * a commit that only touched a bullet in `experience.yaml` is not a change
   * to `resumes/newgrad.yaml`, even though newgrad references that bullet.
   */
  async logForPath(relPath: string, limit = 50): Promise<{ hash: string; date: string; message: string }[]> {
    if (!(await this.isRepo())) return [];
    const out = await this.git([
      'log',
      `-${limit}`,
      '--follow',
      '--pretty=format:%H%x01%aI%x01%s',
      '--',
      relPath,
    ]).catch(() => '');
    return out
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [hash = '', date = '', message = ''] = line.split('\u0001');
        return { hash, date, message };
      });
  }

  /**
   * Every file in the repo at one commit, as path → blob id.
   *
   * Reading a *resume* as it was at some commit is not enough to know what the
   * resume said: its bullets, its dates, and the resume it inherits from all
   * live in other files. Answering "what did this resume look like then"
   * means reading the whole store as it was then.
   */
  async treeAt(hash: string): Promise<Map<string, string>> {
    const out = await this.git(['ls-tree', '-r', '-z', hash]).catch(() => '');
    const files = new Map<string, string>();
    for (const record of out.split('\0')) {
      if (!record) continue;
      // "<mode> <type> <object>\t<path>"
      const tab = record.indexOf('\t');
      if (tab < 0) continue;
      const meta = record.slice(0, tab).split(/\s+/);
      const objectId = meta[2];
      const file = record.slice(tab + 1);
      if (objectId && meta[1] === 'blob') files.set(file, objectId);
    }
    return files;
  }

  /** One blob's contents. Blobs are content-addressed, so callers can cache. */
  async blob(objectId: string): Promise<string> {
    return this.git(['cat-file', 'blob', objectId]).catch(() => '');
  }

  /* ---- Remotes ---------------------------------------------------- *
   * The store is a local repository by default and stays that way unless you
   * ask otherwise. Pushing it somewhere private is an option, not a step.
   * ------------------------------------------------------------------ */

  async getRemote(): Promise<string | undefined> {
    if (!(await this.isRepo())) return undefined;
    const url = await this.git(['remote', 'get-url', 'origin']).catch(() => '');
    return url.trim() || undefined;
  }

  /** Point `origin` at a url, adding it if it is not there yet. */
  async setRemote(url: string): Promise<void> {
    if (!(await this.isRepo())) throw new Error('The store is not a git repository yet');
    if (!url.trim()) {
      await this.git(['remote', 'remove', 'origin']).catch(() => undefined);
      return;
    }
    const existing = await this.getRemote();
    await this.git(existing ? ['remote', 'set-url', 'origin', url] : ['remote', 'add', 'origin', url]);
  }

  async currentBranch(): Promise<string | undefined> {
    const name = await this.git(['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => '');
    const trimmed = name.trim();
    return trimmed && trimmed !== 'HEAD' ? trimmed : undefined;
  }

  /** How the local store compares with its remote, without contacting it. */
  async remoteStatus(): Promise<RemoteStatus> {
    const url = await this.getRemote();
    const branch = await this.currentBranch();
    if (!url || !branch) return { url, branch, ahead: 0, behind: 0, tracked: false };

    const counts = await this.git([
      'rev-list',
      '--left-right',
      '--count',
      `origin/${branch}...${branch}`,
    ]).catch(() => '');

    const [behind = '0', ahead = '0'] = counts.trim().split(/\s+/);
    return { url, branch, ahead: Number(ahead) || 0, behind: Number(behind) || 0, tracked: Boolean(counts.trim()) };
  }

  /**
   * Push the store to its remote. Returns git's own output, since an auth
   * failure or a rejected push is something the user has to read.
   */
  async push(): Promise<{ ok: boolean; output: string }> {
    const url = await this.getRemote();
    if (!url) throw new Error('No remote is configured for the store');
    /*
     * A detached HEAD is easy to reach from here — this tool's own history
     * invites `git checkout <hash>` to look at an old version — and falling
     * back to the literal 'main' pushed the *stale* branch and reported
     * success, while the commit just made sat on no branch at all, reachable
     * only by hash and eligible for collection the moment a branch was checked
     * out again. The CLI even went on to say the store had never been pushed.
     */
    const branch = await this.currentBranch();
    if (!branch) {
      throw new Error(
        'HEAD is detached — the store is not on a branch, so there is nothing to push. ' +
          'Check a branch out first (git checkout main), then try again.',
      );
    }
    try {
      const out = await this.git(['push', '-u', 'origin', branch]);
      return { ok: true, output: out.trim() || `Pushed ${branch} to origin.` };
    } catch (err) {
      const e = err as { stderr?: string; stdout?: string; message?: string };
      return { ok: false, output: (e.stderr ?? e.stdout ?? e.message ?? 'Push failed').trim() };
    }
  }

  /**
   * What one commit changed: the files it touched and the patch itself. This
   * is what makes the store's history browsable — "what did the resume I sent
   * in March actually say?" answered without leaving the app.
   */
  async commit(hash: string): Promise<CommitDetail | undefined> {
    if (!(await this.isRepo())) return undefined;

    const meta = await this.git([
      'show',
      '--no-patch',
      '--pretty=format:%H%x01%aI%x01%an%x01%s%x01%b',
      hash,
    ]).catch(() => '');
    if (!meta.trim()) return undefined;

    const [full = '', date = '', author = '', subject = '', body = ''] = meta.split('\u0001');

    // --numstat gives added/removed counts per file without parsing the patch.
    const stat = await this.git(['show', '--numstat', '--pretty=format:', hash]);
    const files = stat
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [added = '0', removed = '0', file = ''] = line.split('\t');
        return {
          path: file,
          // Binary files report "-" rather than a count.
          added: added === '-' ? null : Number(added),
          removed: removed === '-' ? null : Number(removed),
        };
      });

    const diff = await this.git(['show', '--pretty=format:', '--unified=3', hash]);

    return {
      hash: full.trim(),
      date,
      author,
      message: subject,
      body: body.trim(),
      files,
      // A whole-store rewrite would be unreadable in a panel; cap it.
      diff: diff.length > 200_000 ? `${diff.slice(0, 200_000)}\n… diff truncated` : diff,
    };
  }
}

/** Read a porcelain status code as one word. Untracked counts as added. */
function stateOf(code: string): PendingChange['state'] {
  if (code === '??') return 'added';
  const letters = code.replace(/\s/g, '');
  if (letters.includes('D')) return 'deleted';
  if (letters.includes('R') || letters.includes('C')) return 'renamed';
  if (letters.includes('A')) return 'added';
  return 'modified';
}

/**
 * Wrap a mutation so the store is committed after it succeeds. Every write
 * path goes through this, which is what makes `autoCommit` a single switch
 * rather than a call scattered through every handler.
 */
export async function withCommit<T>(
  repo: Repo,
  enabled: boolean,
  message: string,
  fn: () => T | Promise<T>,
): Promise<T> {
  const result = await fn();
  if (enabled) {
    try {
      const hash = await repo.commitAll(message);
      /*
       * No hash is usually "nothing had changed", and sometimes "there is no
       * repository to commit to" — `commitAll` returns the same nothing for
       * both. The second is the quietest way for a save to end up with no
       * history at all, and the check only runs in the rare case, because
       * auto-commit is invoked by a write that has just changed something.
       */
      repo.lastCommitError =
        !hash && !(await repo.isRepo())
          ? {
              message:
                'the save is not a git repository yet, so there is nothing keeping a history of it',
              at: new Date().toISOString(),
            }
          : undefined;
    } catch (err) {
      // A failed commit must not lose the write that already landed on disk.
      // Remembered as well as logged: see `lastCommitError`, because a console
      // line in a server nobody is looking at is the same as saying nothing.
      repo.lastCommitError = {
        message: (err as Error).message,
        at: new Date().toISOString(),
      };
      console.warn(`[rmm] auto-commit failed: ${(err as Error).message}`);
    }
  }
  return result;
}

/**
 * Clone a repository into a directory that already exists and is empty.
 *
 * Its own function rather than a method, because there is no `Repo` yet: this
 * is how one arrives. `--` separates the options from the operands, so a URL
 * that begins with a dash is an address git cannot find rather than an option
 * git obeys — belt and braces over the caller's own check.
 *
 * `GIT_TERMINAL_PROMPT=0` is the important one. A private repository with no
 * credentials makes git ask for a username on the terminal, and there is no
 * terminal: the server would hang until something killed it, with nothing on
 * screen to say why. Refused immediately, the failure is a sentence.
 */
export async function cloneRepo(url: string, into: string): Promise<void> {
  try {
    await run('git', ['clone', '--', url, into], {
      cwd: path.dirname(into),
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo', SSH_ASKPASS: 'echo' },
    });
  } catch (err) {
    const said = String((err as { stderr?: string }).stderr ?? (err as Error).message ?? '').trim();
    if (/could not read Username|terminal prompts disabled|Authentication failed|Permission denied \(publickey\)/i.test(said)) {
      throw new Error(
        'Git could not sign in to that repository. Set up the credentials it needs — an SSH key, or a ' +
          'credential helper — and try again. Nothing was written.',
      );
    }
    if (/repository .* not found|does not appear to be a git repository|Could not resolve host/i.test(said)) {
      throw new Error(`Git could not reach that repository. ${said.split('\n').pop() ?? ''}`.trim());
    }
    throw new Error(`git clone failed: ${said.split('\n').slice(-2).join(' ') || 'unknown error'}`);
  }
}

/**
 * Every path the newest commit holds, and nothing at all when git will not
 * say — no repository, no commits, a lock left by a crashed git.
 *
 * Empty is the safe answer rather than a thrown one, because every caller is
 * asking the same question: is this file recoverable if I replace or remove
 * it? "Git is not answering" means no.
 */
export async function filedPaths(repo: Repo): Promise<Set<string>> {
  try {
    const [head] = await repo.log(1);
    return head ? new Set((await repo.treeAt(head.hash)).keys()) : new Set();
  } catch {
    return new Set();
  }
}

/**
 * Take things away, and only ones the version history already has.
 *
 * The two places this program deletes something nobody asked it to — the
 * sweep that removes a resume built for one posting, and the retirement that
 * closes a workspace a fortnight after it was sent — are both acceptable for
 * the same reason: it is all still in the history. That argument has a hole
 * in it, and both of them fell through it. Committing the *deletion* of a
 * file git has never seen recovers nothing, and a file can easily have never
 * been seen: auto-commit is a setting people switch off, and even left on, a
 * commit that fails is a console warning with no retry.
 *
 * So whatever is about to go is filed first — scoped to those files, because
 * the rest of the save is somebody's work in progress and this is no reason
 * to commit it for them — and then what actually goes is held to what git can
 * be seen to have. Filing is the fix; the check is the part that cannot be
 * wrong, because it asks rather than assuming the filing worked. What is held
 * back is handed to the caller to report: somebody pressed a button, or
 * opened a list, and is owed a reason.
 *
 * One commit for the lot on each side. A deletion spread over eleven commits
 * buries the history it is meant to be recoverable from.
 */
export async function removeWhatIsFiled<T>(
  repo: Repo,
  root: string,
  going: { paths: string[]; what: T }[],
  messages: { filing: string; removing: (removed: T[]) => string },
  remove: (what: T) => void,
): Promise<{ removed: T[]; held: T[] }> {
  if (going.length === 0) return { removed: [], held: [] };

  const onDisk = going.flatMap((g) => g.paths.filter((p) => fs.existsSync(path.join(root, p))));
  await repo.commitAll(messages.filing, onDisk).catch(() => undefined);

  const filed = await filedPaths(repo);

  const taking = going.filter((g) => g.paths.some((p) => filed.has(p)));
  const held = going.filter((g) => !taking.includes(g)).map((g) => g.what);
  if (taking.length === 0) return { removed: [], held };

  // `true` whatever auto-commit is set to: that setting is about whether your
  // *edits* are recorded as you make them, and this is not an edit you made.
  await withCommit(repo, true, messages.removing(taking.map((g) => g.what)), () => {
    for (const g of taking) remove(g.what);
  });
  return { removed: taking.map((g) => g.what), held };
}
