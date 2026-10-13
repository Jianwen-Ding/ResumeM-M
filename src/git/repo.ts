import { AsyncLocalStorage } from 'node:async_hooks';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  aiCommandChange,
  aiSwitchedOff,
  clearAiSwitchOff,
  reportAiOffNotWritten,
  storeFileProblem,
  switchAiOff,
  writeAiOff,
} from '../model/store.js';
import { holdSave } from '../model/save-lock.js';

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
  /** Configured push url, if any — without any `user:token@`; see `redactUrl`. */
  url?: string;
  branch?: string;
  /** Commits made locally that the remote does not have. */
  ahead: number;
  /**
   * Commits on the remote that are not local — as of the last time this
   * save heard from the remote (a push, or the fetch after a refused one).
   * `remoteStatus` does not go and ask, so 0 is "none that we know of".
   */
  behind: number;
  /** False when the remote has never been contacted. */
  tracked: boolean;
}

/** What `Repo.pull` did, in the shape the API, the CLI and the editor all report. */
/** One request's holds on the saves it writes, and whether it has been let go. See `Repo.writesOfRequest`. */
interface RequestHolds {
  closed: boolean;
  holds: { root: string; release: () => void }[];
}

export interface PullResult {
  /** True when the save now has what the remote had, or already did. */
  ok: boolean;
  /** Commits brought in from the remote; 0 when nothing was, or nothing could be. */
  pulled: number;
  /** Files the pull changed in the save, relative to it. */
  files: string[];
  /**
   * The files that conflicted, when the merge could not be made. The merge was
   * undone, so none of them has changed: this is what to resolve by hand.
   */
  conflict?: string[];
  /**
   * Files the pull would have left unreadable, when it was refused for that.
   * Nothing was merged. See `Repo.vetIncoming`.
   */
  unreadable?: string[];
  /** True when the pull changed the AI command, and the AI was switched off here for it. */
  aiSwitchedOff?: boolean;
  /** One paragraph for a person to read, with any address in it redacted. */
  message: string;
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

  /**
   * Set by the `rmm` CLI, so what a pull says to do next is something to
   * run in the terminal it was typed in, rather than a panel of an editor
   * that is not open. The server leaves it off and keeps the editor's words.
   */
  inTerminal = false;

  constructor(
    root: string,
    scope: string[] = ['.'],
    /**
     * Folders inside the save that are rebuilt rather than written, and so
     * are nothing to keep a history of — see `currentIgnore`. Asked at each
     * commit, because where the output folder is can change under a running
     * server.
     */
    private readonly rebuilt: () => string[] = () => [],
  ) {
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
  static forStore(storeDir: string, rebuilt?: () => string[]): Repo {
    return new Repo(path.resolve(storeDir), ['.'], rebuilt);
  }

  /** The most output one git command may hand back; see `blobs`, which keeps to it too. */
  static readonly MAX_BUFFER = 8 * 1024 * 1024;

  private async git(args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
    const { stdout } = await run('git', args, { cwd: this.root, maxBuffer: Repo.MAX_BUFFER, ...(env ? { env } : {}) });
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
  async ensure(message = 'Initialise resume store'): Promise<void> {
    if (await this.isRepo()) return;
    fs.mkdirSync(this.root, { recursive: true });
    await this.git(['init']);
    // Before the first `add`, so a store that already has a half-built
    // application folder in it does not take one into its opening commit.
    this.ensureIgnores();

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
      message,
    ]);
  }

  /**
   * Stage everything under `paths` and commit. Returns the new commit hash, or
   * undefined when there was nothing to commit — a no-op save should not be an
   * error, and should not create an empty commit either.
   */
  async commitAll(
    message: string,
    paths?: string[],
    /**
     * `auto` for a commit the app makes on its own behind an edit, which must
     * not conclude somebody's merge for them — see `commitNow`. A deliberate
     * save (`rmm save`, the Save button) may: that is how a conflict resolved
     * by hand is committed from here.
     */
    opts: { auto?: boolean } = {},
  ): Promise<string | undefined> {
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
    return this.queued(() => this.commitNow(message, paths, opts.auto ?? false));
  }

  /**
   * Run `work` in this repository's turn: after every commit queued before
   * it, and before every one queued after. See `commitAll`, and `pull`,
   * which merges in the same queue so no commit of the app's can land in the
   * middle of its merge.
   */
  private async queued<T>(work: () => Promise<T>): Promise<T> {
    const previous = Repo.commits.get(this.root) ?? Promise.resolve();
    let release!: () => void;
    const finished = new Promise<void>((done) => (release = done));
    const chained = previous.then(() => finished);
    Repo.commits.set(this.root, chained);

    await previous;
    try {
      return await work();
    } finally {
      release();
      // Only when nothing queued behind this one, so the next caller either
      // waits for a real predecessor or starts a fresh chain.
      if (Repo.commits.get(this.root) === chained) Repo.commits.delete(this.root);
    }
  }

  /** Serialised per repository directory by `commitAll`. */
  private static readonly commits = new Map<string, Promise<void>>();

  /**
   * How old an `index.lock` has to be before it is taken for one a killed git
   * left behind, rather than one a running git is holding. Every git command
   * that takes the lock lets it go within a second or two on a store this
   * size; a minute is a git that is not coming back.
   */
  static STALE_LOCK_MS = 60_000;
  /**
   * How long after `git pull` fetches, or `git merge` starts, its merge is
   * taken to be still running. See `outsideGit`.
   */
  static PULL_SETTLE_MS = 1_500;
  /** How long a write waits for somebody else's git to let go of the save. */
  static WRITE_WAIT_MS = 1_500;
  /** How long an automatic commit waits for a pull to finish before giving up. */
  static COMMIT_WAIT_MS = 3_000;

  /**
   * What a git outside this program is in the middle of, if anything.
   *
   * The commit queue in `commitAll` serialises this server's own commits and
   * knows nothing about anybody else's git — and the store is a repository
   * people use as one. A second machine catches up with `git pull` in a
   * terminal while the server runs, and measured that way, with the tracker
   * being written through the app during the pull, the app's auto-commit ran
   * while git was half-way through its merge: `git add` and `git commit` in
   * that window concluded git's merge for it, under "Track application to …",
   * and tracker rows that had been answered 200 were missing from the file
   * and from the history afterwards. A store write landing while git was
   * rewriting the same file lost the row the same way, with no commit
   * involved at all.
   *
   * Read straight off the files git leaves in `.git` while it works, with no
   * git process, because this runs before every write and has to answer
   * without an `await` (see `withCommit`). `MERGE_HEAD` and the rebase
   * folders are there for as long as the operation is unfinished, conflicts
   * and all. `index.lock` is there while any git is writing the index — the
   * part of a merge that rewrites the working tree is done under it — so it
   * counts only when it is fresh (an old one is a crashed git, see
   * `STALE_LOCK_MS`) and only when it is not this server's own commit holding
   * it, which `ownLock` lets the caller say.
   *
   * And one moment none of those cover, found by running the pull race again
   * with them in place. A merge that cannot start because the tracker has an
   * edit not yet committed ("Your local changes … would be overwritten") puts
   * the working tree back the way it found it — a stash taken at the start,
   * `reset --hard`, the stash applied — and a write landing between the
   * stash and the reset was rolled back with it, after its 200, with no lock
   * and no `MERGE_HEAD` to see. What a pull does leave is its timestamps:
   * `FETCH_HEAD` is written as the fetch hands over to the merge, and
   * `ORIG_HEAD` as a merge begins. Either one younger than `PULL_SETTLE_MS`
   * — `FETCH_HEAD` only with a sign a merge follows it, see `justPulled` —
   * is a pull or merge that may still be running, and a write or commit waits
   * that long rather than land in the middle of it.
   */
  outsideGit(
    ownLock = Repo.commits.has(this.root),
    /**
     * Set by `commitNow`, which runs in the commit queue: the app's own pull
     * holding writes is not a reason for a commit to wait, because nothing
     * can be in the queue while the pull's merge is, and the pull itself
     * commits what is on disk before it merges.
     */
    ownPull = false,
  ): { kind: 'merge' | 'rebase' | 'lock' | 'pull' | 'app'; what: string } | undefined {
    /*
     * The app's own pull, first and without looking at `.git`, because what
     * it leaves there while it works — its fetch, its `ORIG_HEAD`, the lock
     * its merge takes — is exactly what the rest of this reads as somebody
     * else's pull and waits out, synchronously. Refused rather than waited
     * for: see `pull`.
     */
    if (!ownPull && Repo.holding.has(this.root)) {
      return { kind: 'app', what: 'the save is being brought up to date from its remote (Pull) right now' };
    }
    const dir = this.gitDir();
    if (!dir) return undefined;
    const has = (name: string) => fs.existsSync(path.join(dir, name));
    if (has('rebase-merge') || has('rebase-apply')) {
      return { kind: 'rebase', what: 'a rebase (git pull --rebase, or git rebase) is in progress in the save' };
    }
    if (has('MERGE_HEAD')) return { kind: 'merge', what: 'a merge (git pull, or git merge) is in progress in the save' };
    if (has('CHERRY_PICK_HEAD') || has('REVERT_HEAD')) {
      return { kind: 'merge', what: 'a git cherry-pick or revert is in progress in the save' };
    }
    if (!ownLock) {
      try {
        const age = Date.now() - fs.statSync(path.join(dir, 'index.lock')).mtimeMs;
        if (age < Repo.STALE_LOCK_MS) return { kind: 'lock', what: 'another git process is using the save' };
      } catch {
        // No lock, which is the usual answer.
      }
    }
    if (this.justPulled(dir, ownLock)) return { kind: 'pull', what: 'a git pull or merge has only just started in the save' };
    return undefined;
  }

  /**
   * A pull or merge began within `PULL_SETTLE_MS`. See `outsideGit`.
   *
   * `ORIG_HEAD` on its own, because a merge writes it as it begins. A fresh
   * `FETCH_HEAD` only with something to say a merge is following it — a fresh
   * `ORIG_HEAD`, or a `MERGE_HEAD` or `index.lock` — because a fetch on its
   * own changes nothing in the working tree, and they are common: the app's
   * own fetch after a refused push, an editor's background autofetch, a
   * `git fetch` in a terminal. Counted on its own, each of those made the
   * next write wait out the whole `WRITE_WAIT_MS` in `assertNoOutsideGit`,
   * which waits synchronously — a second and a half in which the server
   * answered nothing at all. And the app's own fetch is recorded when it
   * makes it (`ownFetch`) and not counted even then.
   *
   * Nor is the lock this server's own commit is holding (`ownLock`, as in
   * `outsideGit`). It was counted here when `outsideGit` had already set it
   * aside, so the app's own commit and an editor's background fetch together
   * read as a pull starting, and the write waited for nothing.
   */
  private justPulled(dir = this.gitDir(), ownLock = Repo.commits.has(this.root)): boolean {
    if (!dir) return false;
    const age = (name: string) => {
      try {
        return Date.now() - fs.statSync(path.join(dir, name)).mtimeMs;
      } catch {
        return Infinity; // Never pulled, which is fine.
      }
    };
    if (age('ORIG_HEAD') < Repo.PULL_SETTLE_MS && !this.isOwn(dir, 'ORIG_HEAD')) return true;
    if (!(age('FETCH_HEAD') < Repo.PULL_SETTLE_MS)) return false;
    if (this.isOwn(dir, 'FETCH_HEAD')) return false;
    if (fs.existsSync(path.join(dir, 'MERGE_HEAD'))) return true;
    return !ownLock && age('index.lock') < Repo.STALE_LOCK_MS;
  }

  /**
   * `FETCH_HEAD` and `ORIG_HEAD` as this server's own fetch and pull left
   * them, per store. See `justPulled`.
   *
   * `ORIG_HEAD` as well since the app has had a Pull of its own: its merge
   * writes one, and read as an outside pull just begun it made every write
   * for the next second and a half wait — synchronously, the server
   * answering nothing — and every auto-commit wait, for a pull that had
   * already finished.
   */
  private static readonly ownMarks = new Map<string, Map<string, number>>();

  private isOwn(dir: string, name: 'FETCH_HEAD' | 'ORIG_HEAD'): boolean {
    try {
      return Repo.ownMarks.get(this.root)?.get(name) === fs.statSync(path.join(dir, name)).mtimeMs;
    } catch {
      return false;
    }
  }

  /** Remember the `FETCH_HEAD` (and `ORIG_HEAD`) this server's own git has just written. */
  private ownFetch(...names: ('FETCH_HEAD' | 'ORIG_HEAD')[]): void {
    const dir = this.gitDir();
    if (!dir) return;
    const marks = Repo.ownMarks.get(this.root) ?? new Map<string, number>();
    Repo.ownMarks.set(this.root, marks);
    for (const name of names.length ? names : (['FETCH_HEAD'] as const)) {
      try {
        marks.set(name, fs.statSync(path.join(dir, name)).mtimeMs);
      } catch {
        // Not there: the fetch failed, or no merge ran, and there is nothing to ignore.
      }
    }
  }

  /**
   * The `.git` folder, without asking git: a folder, or a file pointing at one
   * (a worktree or a submodule). Undefined when the store is not a repository
   * of its own, which has no outside git to wait for.
   */
  private gitDir(): string | undefined {
    const dotGit = path.join(this.root, '.git');
    try {
      if (fs.statSync(dotGit).isDirectory()) return dotGit;
      const pointer = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, 'utf8'))?.[1]?.trim();
      return pointer ? path.resolve(this.root, pointer) : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Refuse a store write while a git outside this program is part-way through
   * changing the store. See `outsideGit`.
   *
   * Synchronous on purpose: the handlers check something and then write, and
   * rely on nothing being awaited between the two (see `withCommit`). A fresh
   * `index.lock`, or a pull that has only just begun, is waited out for a
   * moment, because that is git rewriting files right now and it is done
   * within a second; a lock that is still there after `WRITE_WAIT_MS` is not
   * holding anything this write would lose, and the write goes ahead — the commit after it is what that lock stops, and
   * `commitNow` says so. A merge or rebase is refused outright: it lasts until
   * somebody finishes it, and a 200 for a write the pull is about to overwrite,
   * or that the next auto-commit would bury inside git's merge, is the bug.
   */
  assertNoOutsideGit(): void {
    /*
     * Not `MERGE_HEAD`, even one that has only just appeared and will be gone
     * in a moment when a clean pull commits its merge. Waiting that out was
     * tried, and measured against the pull race it lost rows again: the
     * waiting write lands just as git, having found the tracker changed under
     * it, puts the working tree back the way it found it. Turned away with a
     * sentence, the person makes the edit again a second later and nothing is
     * lost; a 200 for a row that then disappears is the bug this is for.
     */
    const passing = (b: ReturnType<Repo['outsideGit']>) => b?.kind === 'lock' || b?.kind === 'pull';
    let busy = this.outsideGit();
    if (passing(busy)) {
      const until = Date.now() + Repo.WRITE_WAIT_MS;
      const pause = new Int32Array(new SharedArrayBuffer(4));
      while (passing(busy) && Date.now() < until) {
        Atomics.wait(pause, 0, 0, 25);
        busy = this.outsideGit();
      }
    }
    /*
     * Not the app's own pull, though, to a request that already holds a
     * write in this save. The pull is waiting for that hold to go before it
     * merges (see `writesSettled`), so this write cannot land in the middle
     * of it. And refusing it part-way is what lost work: a route that writes
     * twice — a new variation's resume, then its draft — passed its first
     * check, the pull began, and the second write was refused with the first
     * already on disk. The person saw an error, tried again, and had two
     * variations, one of them belonging to nothing.
     */
    if (busy?.kind === 'app' && this.heldByThisRequest()) busy = undefined;
    if (busy && !passing(busy)) throw new GitBusyError(busy.what, this.root, false, busy.kind === 'app');
    this.holdForRequest();
  }

  /** Whether the request this runs in holds a write in this save already. See `holdForRequest`. */
  private heldByThisRequest(): boolean {
    const request = Repo.requestHolds.getStore();
    return Boolean(request && !request.closed && request.holds.some((h) => h.root === this.root));
  }

  /* ---- Writes under way, for a pull to wait for ------------------- *
   * `assertNoOutsideGit` is a check made before a write, and a handler can
   * await between the check and the write — `/api/apply` typesets a bundle
   * there, for seconds — so refusing new writes when a pull begins is not
   * enough on its own: a write that passed the check a moment before could
   * land in the middle of the merge. So each write that has passed is
   * counted until it is done, and `pull` waits for the count to reach nothing
   * before it touches the working tree.
   * ------------------------------------------------------------------ */

  /** Writes that have passed `assertNoOutsideGit` and not yet finished, per store. */
  private static readonly writing = new Map<string, number>();

  /**
   * The HTTP request a check is being made for, when there is one: its holds
   * are let go when the request is answered. See `writesOfRequest`.
   */
  private static readonly requestHolds = new AsyncLocalStorage<RequestHolds>();

  /**
   * `holdWrite`, for a write made outside any request; a no-op inside one,
   * which holds already. And a hold of its own for a write made in a request
   * that has been answered — work it left behind — which nothing holds for
   * any more. See `holdForRequest`.
   */
  holdWriteOutsideRequest(): () => void {
    const request = Repo.requestHolds.getStore();
    return request && !request.closed ? () => undefined : this.holdWrite();
  }

  /** Count one write under way until the returned function is called. */
  private holdWrite(): () => void {
    Repo.writing.set(this.root, (Repo.writing.get(this.root) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (Repo.writing.get(this.root) ?? 1) - 1;
      if (left > 0) Repo.writing.set(this.root, left);
      else Repo.writing.delete(this.root);
    };
  }

  /**
   * Hold for the rest of the request this check is part of, once per store.
   *
   * For the length of the request rather than of one write, because the
   * routes that check once and write several times — a bundle, its tracker
   * row, its letter — are the ones with an `await` in between. A check made
   * outside any request (the CLI, a test) is held by `withCommit` around its
   * own write instead.
   */
  private holdForRequest(): void {
    const request = Repo.requestHolds.getStore();
    /*
     * Not once the request has been let go. Work a handler leaves running
     * after it answers — a timer, a promise nobody awaited — is still in
     * the request's async context, and its check pushed a hold onto a list
     * `writesOfRequest` had already emptied for the last time: a hold that
     * was never released, and every pull of the save after it waited out
     * `PULL_DRAIN_MS` and gave up. Such a write is held by `withCommit`
     * around itself instead, as one outside any request is
     * (`holdWriteOutsideRequest`).
     */
    if (!request || request.closed || request.holds.some((h) => h.root === this.root)) return;
    request.holds.push({ root: this.root, release: this.holdWrite() });
  }

  /**
   * Run `next` — the rest of a request's handling — so that every write it
   * checks in for is counted until the returned function is called, which the
   * caller does when the request has been answered. See `holdForRequest`.
   */
  static writesOfRequest(next: () => void): () => void {
    const request: RequestHolds = { closed: false, holds: [] };
    Repo.requestHolds.run(request, next);
    return () => {
      // Closed first, so nothing can join the list after it is emptied. See `holdForRequest`.
      request.closed = true;
      for (const hold of request.holds.splice(0)) hold.release();
    };
  }

  /**
   * Wait for every write under way to finish, up to `ms`. True when none is
   * left. Polled, because the writes are spread over requests that know
   * nothing of each other and a few milliseconds of latency on a pull does
   * not matter.
   */
  private async writesSettled(ms: number): Promise<boolean> {
    const until = Date.now() + ms;
    while ((Repo.writing.get(this.root) ?? 0) > 0) {
      if (Date.now() >= until) return false;
      await new Promise((done) => setTimeout(done, 20));
    }
    return true;
  }

  /**
   * Paths that must never be committed, and must never be walked either.
   *
   * A bundle is built into `out/applications/.rmm-building-XXXXXX` and moved
   * into place when it is whole — which is what makes a half-written archive
   * impossible. But `git add -- .` walks the whole tree and stats what it
   * finds, and a *second* application finishing during that walk takes its
   * staging folder away mid-stat:
   *
   *   fatal: unable to stat 'out/applications/.rmm-building-sCPWqE/source/resume.tex':
   *   No such file or directory
   *
   * git then aborts the entire add, the commit never happens, and
   * `withCommit` has nowhere to put that but a line in the console. Nothing
   * is lost from disk — the files were already written — but the version
   * history quietly stops recording, and "restore this version", the diff
   * between two resumes and the sweep are all built on it. Two applications
   * being built at once is an ordinary afternoon.
   *
   * Ignoring them removes the walk rather than surviving it, and it is also
   * the honest answer: a folder that exists for the duration of one rename is
   * not part of anybody's history.
   *
   * And the same thing, one directory down and far more often: every write
   * through `Store.writeAtomic` goes out to `.rmm-<uuid>.tmp` beside its
   * target and is renamed over it. That is one file per save, in `resumes/`
   * and `letters/` and the store root, and the add above walks all of them —
   * so the identical race is not a two-bundles-at-once affair, it is two
   * ordinary saves overlapping. Measured, with one save looping while
   * `commitAll` ran forty times:
   *
   *   fatal: unable to stat 'resumes/.rmm-fb6b0e43-…-5eb7148d587c.tmp':
   *   No such file or directory
   *
   * Nine of the forty commits never happened. Nothing is lost from disk, and
   * the editor goes on saying "All changes saved" because that is true — but
   * the version history stops recording, and "restore this version", the diff
   * between two resumes and the sweep are all built on it.
   *
   * The other half is quieter and was reproduced first: when the walk wins
   * the race, the scratch file is committed. A store with a `.rmm-…tmp` blob
   * in its history, and a deletion of it in the next commit, for every save
   * that happened to be timed that way.
   */
  private static readonly IGNORED = ['.rmm-building-*/', '.rmm-*.tmp'];

  /** What was last made sure of, per process per store; see `IGNORED`. */
  private ignoresWrittenFor: string | null = null;

  /**
   * Make sure the store's `.gitignore` carries what it has to, without
   * disturbing whatever else is in it.
   *
   * Called before every commit rather than at `ensure`, because `ensure` only
   * runs when a repository is being created and the stores that need this
   * most are the ones that already exist. Appending, never rewriting: this
   * file belongs to whoever opened the store.
   *
   * Returns whether it wrote, and the rebuilt folders it has just started
   * ignoring — which may already be in the history, and `.gitignore` says
   * nothing about a file git already tracks.
   */
  private ensureIgnores(): { wrote: boolean; untrack: string[] } {
    const rebuilt = this.rebuilt();
    const wanted = [...Repo.IGNORED, ...rebuilt];
    const key = wanted.join('\n');
    if (this.ignoresWrittenFor === key) return { wrote: false, untrack: [] };
    this.ignoresWrittenFor = key;
    try {
      const at = path.join(this.root, '.gitignore');
      const had = fs.existsSync(at) ? fs.readFileSync(at, 'utf8') : '';
      const lines = had.split('\n').map((l) => l.trim());
      const missing = wanted.filter((p) => !lines.includes(p));
      if (missing.length === 0) return { wrote: false, untrack: [] };

      const temporary = missing.filter((p) => Repo.IGNORED.includes(p));
      const derived = missing.filter((p) => !Repo.IGNORED.includes(p));
      const blocks = [
        ...(temporary.length ? ['# ResumeM-M: files that exist for the length of one rename.', ...temporary] : []),
        ...(derived.length ? ['# ResumeM-M: rebuilt whenever anything changes, so nothing to keep a history of.', ...derived] : []),
      ].join('\n');
      const body = had && !had.endsWith('\n') ? `${had}\n${blocks}\n` : `${had}${blocks}\n`;
      fs.writeFileSync(at, body, 'utf8');
      return { wrote: true, untrack: derived.map((p) => p.replace(/^\/+|\/+$/g, '')) };
    } catch {
      // A store whose .gitignore cannot be written still commits; it just
      // keeps the race this was for. Not a reason to refuse the save.
      return { wrote: false, untrack: [] };
    }
  }

  private async commitNow(message: string, paths: string[] | undefined, auto: boolean): Promise<string | undefined> {
    if (!(await this.isRepo())) return undefined;
    /*
     * Not in the middle of somebody else's git. See `outsideGit`.
     *
     * An automatic commit waits a moment first, because a clean `git pull`
     * is over in well under a second and the edit behind this commit has
     * already landed on disk: once git is done, committing it is exactly
     * right. If git is still at it after that — a conflicted merge waits for
     * a person — the commit is refused and the edit stays on disk, uncommitted,
     * for the next commit after the pull to take. Refused rather than made,
     * because `git commit` with `MERGE_HEAD` present *is* concluding the
     * merge, with whatever half of it git had written so far.
     *
     * Inside the queue, so the lock is never this server's own here and is
     * counted. A deliberate save is not made to wait, and may conclude a merge
     * that has been resolved by hand — but never a rebase, where HEAD is
     * detached part-way down somebody else's branch and a commit made here
     * would be replayed into the middle of it.
     */
    let busy = this.outsideGit(false, true);
    if (auto && busy) {
      const until = Date.now() + Repo.COMMIT_WAIT_MS;
      while (busy && Date.now() < until) {
        await new Promise((done) => setTimeout(done, 50));
        busy = this.outsideGit(false, true);
      }
    }
    if (busy && (busy.kind === 'rebase' || (auto && busy.kind === 'merge'))) {
      throw new GitBusyError(busy.what, this.root, true);
    }
    /*
     * The rest under the save's lock (see `SaveLock`), which every other
     * ResumeM-M process on this save takes for its writes and its commits.
     *
     * The commit queue above keeps this server's commits apart, and nothing
     * kept them apart from the CLI's: `rmm apply` and the server committing
     * at once collided on git's own `index.lock` ("Command failed: git add"),
     * or one's commit took the other's staged files and the other's then had
     * nothing left to commit and failed for it — `rmm apply` exited 1 on six
     * runs in twelve, its application filed. Held from the add to the commit,
     * so no write of the other process's lands between the two either.
     * Waited for after the outside-git check, which can take seconds, so the
     * other process is not kept waiting through that as well.
     */
    return holdSave(this.root, () => this.commitHeld(message, paths, auto));
  }

  /** The part of `commitNow` made under the save's lock. */
  private async commitHeld(message: string, paths: string[] | undefined, auto: boolean): Promise<string | undefined> {
    const { wrote: wroteIgnores, untrack } = this.ensureIgnores();
    /*
     * And out of the index, where a store written before the folder was
     * ignored has it already: an ignored file git tracks is still walked by
     * the add below, which is the race all over again. The files stay on
     * disk; the next commit records only that they are no longer followed.
     */
    for (const folder of untrack) {
      await this.git(['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', folder]).catch(() => undefined);
    }
    /*
     * Only paths there is something at — on disk, or in the index as a file
     * that has since been removed.
     *
     * `git add` refuses the whole command over one path that matches
     * nothing: "pathspec 'drafts' did not match any files". The passes that
     * scope their commit to the tracker and the workspaces name `drafts`,
     * and a save that has never opened a workspace has no such folder — so
     * the tracker was rewritten, the commit behind it failed, and the change
     * sat on disk in no version.
     */
    const targets: string[] = [];
    for (const target of paths ?? this.scope) {
      const there =
        fs.existsSync(path.join(this.root, target)) ||
        (await this.git(['ls-files', '--', target]).catch(() => '')).trim() !== '';
      if (there) targets.push(target);
    }
    /*
     * And none that `.gitignore` covers.
     *
     * `git add` refuses a command that names an ignored path outright — "The
     * following paths are ignored by one of your .gitignore files", exit 1 —
     * and refuses it after staging the rest. So a store that ignores `drafts/`
     * failed every commit that named it, and left the tracker staged in the
     * index for whatever commit came next to sweep up. `check-ignore` without
     * `--no-index` does not count a path git already tracks as ignored, so
     * those still go in.
     */
    const ignored = new Set(
      // Exit 1 means none are, which is not a failure. quotePath off so a name
      // with an accent comes back as it was passed rather than escaped.
      (await this.git(['-c', 'core.quotePath=false', 'check-ignore', '--', ...targets]).catch(() => ''))
        .split('\n')
        .filter(Boolean),
    );
    const wanted = targets.filter((t) => !ignored.has(t));
    if (wanted.length === 0) return undefined;
    /*
     * Never over a conflict nobody has resolved.
     *
     * The `add` below is what tells git a conflicted file is settled, and the
     * commit after it concludes the merge. With the markers still in the file,
     * that put `<<<<<<<` into profile.yaml as a finished merge, behind a 200
     * that said the work was saved. A file someone has edited clean is theirs
     * to save; one still holding the markers is refused by name.
     */
    const unresolved = await this.unresolved();
    if (unresolved.length > 0) {
      throw new Error(
        `The store has a merge conflict nobody has resolved yet: ${unresolved.join(', ')}. ` +
          'Edit the conflict markers out of those files — or, for one that a side deleted, keep it with ' +
          'git add or let it go with git rm — (or run git merge --abort), then save again.',
      );
    }
    await this.git(['add', '--', ...wanted]);

    // Only commit what is staged within scope; unrelated working-tree changes
    // elsewhere in the repo must not ride along. The folders taken out of the
    // index above are this save's change too.
    const ours = [...wanted, ...untrack];
    const files = (await this.git(['diff', '--cached', '--name-only', '-z', '--', ...ours])).split('\0').filter(Boolean);
    if (files.length === 0) return undefined;

    /*
     * And a `.gitignore` this process has just written is not a change
     * somebody made.
     *
     * A save with nothing in it must not produce a commit — that is what the
     * whole `staged` check above is for — and adding the ignore file to an
     * existing store would have turned the next empty save into one. It stays
     * staged and rides along with the next real edit, which is where it
     * belongs: it is part of the store, not an event in its history.
     */
    if (wroteIgnores && files.length === 1 && files[0] === '.gitignore') return undefined;

    /*
     * Nor anything else that happens to be in the index.
     *
     * `git add -- targets` scopes what this save stages, but it does not empty
     * the index first, and a bare `git commit` takes all of it: a file the
     * user had staged by hand, or one a failed commit left staged, rode along
     * under "Update answer bank". One real store had the tracker and the
     * drafts folder in fifteen commits that said they were about the answer
     * bank.
     *
     * Not `git commit -- <paths>`, though, which is what would come to mind.
     * That is a *partial* commit, and git refuses one outright while a merge
     * is in progress — "fatal: cannot do a partial commit during a merge" —
     * so anyone who had resolved a conflict by hand could never save through
     * the app again. It also records the paths as the working tree has them
     * rather than as staged, so a folder taken out of the index above with
     * `rm --cached` went straight back in from the disk.
     *
     * So the index is used as it is when it holds nothing but this save — the
     * usual case — or when a merge is being concluded, which has to take
     * everything that was resolved. Otherwise the commit is built in an index
     * of its own: HEAD, plus exactly the entries this save staged, copied
     * from the real one. What the user staged stays staged for them.
     */
    const everything = (await this.git(['diff', '--cached', '--name-only', '-z'])).split('\0').filter(Boolean);
    const mine = new Set(files);
    const foreign = everything.some((f) => !mine.has(f));
    const merging = await this.git(['rev-parse', '-q', '--verify', 'MERGE_HEAD']).then(
      () => true,
      () => false,
    );
    /*
     * And asked again at the last moment: a pull started since the check at
     * the top has had the length of an `add` to write `MERGE_HEAD`, and the
     * commit below would conclude its merge. What was staged stays staged,
     * for the commit after the pull.
     */
    if (auto && merging) {
      throw new GitBusyError(this.outsideGit(false, true)?.what ?? 'a merge is in progress in the save', this.root, true);
    }
    const scoped = foreign && !merging ? await this.indexOf(files) : undefined;
    try {
      // -c keeps the commit working even if the machine has no global identity.
      await this.git(
        ['-c', 'user.name=ResumeM-M', '-c', 'user.email=resumem-m@localhost', 'commit', '-q', '-m', message],
        scoped?.env,
      );
    } catch (err) {
      /*
       * "Nothing to commit" is this save already being in the history: what
       * was staged went into a commit made a moment ago — a git of somebody
       * else's, since every ResumeM-M process takes the save's lock first.
       * The same answer as finding nothing staged above, not a failure.
       */
      const said = `${(err as { stdout?: string }).stdout ?? ''}${(err as { stderr?: string }).stderr ?? ''}${(err as Error).message}`;
      if (/nothing to commit|nothing added to commit|no changes added to commit/i.test(said)) return undefined;
      throw err;
    } finally {
      if (scoped) fs.rmSync(scoped.file, { force: true });
    }
    return (await this.git(['rev-parse', 'HEAD'])).trim();
  }

  /**
   * Unmerged paths whose conflict is still there to see: the markers are in
   * the file, one side deleted it (whatever the other side left in the
   * tree), or there is no text file to look at (a binary) and so nothing to
   * say it was settled. `git add` would mark every one of them resolved as
   * it stands.
   */
  async unresolved(): Promise<string[]> {
    const listed = await this.git(['-c', 'core.quotePath=false', 'ls-files', '-u', '-z']).catch(() => '');
    // One line per stage: "<mode> <object> <stage>\t<path>".
    const stages = new Map<string, Set<string>>();
    for (const line of listed.split('\0').filter(Boolean)) {
      const tab = line.indexOf('\t');
      const rel = line.slice(tab + 1);
      const stage = line.slice(0, tab).split(' ')[2] ?? '';
      stages.set(rel, (stages.get(rel) ?? new Set()).add(stage));
    }
    const left: string[] = [];
    for (const [rel, has] of stages) {
      /*
       * A side that deleted the file is a conflict no text can settle.
       *
       * Stage 2 is ours and stage 3 theirs; a modify/delete conflict has only
       * one of the two, and git leaves the surviving side's file in the tree
       * as it was — no markers, because there is nothing to mark. Read as
       * text, that looked resolved, the next auto-commit's `git add` took it,
       * and the commit concluded the merge keeping the edit and dropping the
       * deletion without anybody having chosen. Measured: a resume deleted on
       * one machine and edited on the other came back in the merge, under a
       * commit that said "Track application to Zeta". Only someone can say
       * which side wins, with `git add` or `git rm`, and until then it is
       * unresolved whatever the file says.
       */
      if (!has.has('2') || !has.has('3')) {
        left.push(rel);
        continue;
      }
      let text: string;
      try {
        text = fs.readFileSync(path.join(this.root, rel), 'utf8');
      } catch {
        left.push(rel);
        continue;
      }
      if (text.includes('\0') || (/^<{7}(?: |$)/m.test(text) && /^>{7}(?: |$)/m.test(text))) left.push(rel);
    }
    return left.sort();
  }

  /**
   * A throwaway index holding HEAD plus this save's entries from the real one,
   * for a commit that must not take what else is staged. See `commitNow`.
   */
  private async indexOf(files: string[]): Promise<{ file: string; env: NodeJS.ProcessEnv }> {
    const file = path.resolve(this.root, (await this.git(['rev-parse', '--git-path', 'index.rmm-scoped'])).trim());
    fs.rmSync(file, { force: true });
    const env = { ...process.env, GIT_INDEX_FILE: file };
    await this.git(['read-tree', 'HEAD'], env);

    // Literal, because these are file names and not patterns: a draft called
    // `Résumé [final].yaml` is a glob otherwise.
    const entries = (await this.git(['--literal-pathspecs', 'ls-files', '-s', '-z', '--', ...files]))
      .split('\0')
      .filter(Boolean)
      .map((line) => {
        const tab = line.indexOf('\t');
        const [mode, sha] = line.slice(0, tab).split(' ');
        return { mode, sha, path: line.slice(tab + 1) };
      });
    const kept = new Set(entries.map((e) => e.path));
    const gone = files.filter((f) => !kept.has(f));

    // In batches, so an import of thousands of files stays under the limit
    // on the length of a command line.
    for (let n = 0; n < entries.length; n += 200) {
      const add = entries.slice(n, n + 200).flatMap((e) => ['--cacheinfo', `${e.mode},${e.sha},${e.path}`]);
      await this.git(['update-index', '--add', ...add], env);
    }
    for (let n = 0; n < gone.length; n += 200) {
      await this.git(['update-index', '--force-remove', '--', ...gone.slice(n, n + 200)], env);
    }
    return { file, env };
  }

  /**
   * What is changed but not yet committed, within scope.
   *
   * With auto-commit on this is normally empty. It is not always: auto-commit
   * can be off, and the store is plain YAML that people edit by hand, which is
   * half the reason it is plain YAML. Knowing there is unsaved work is what
   * makes an explicit save worth offering.
   */
  async pending(paths?: string[]): Promise<PendingChange[]> {
    if (!(await this.isRepo())) return [];
    const where = paths ?? this.scope;
    // `-uall` because porcelain otherwise collapses a wholly untracked
    // directory to a single entry, so `rmm save` said "Saved 1 file — drafts/"
    // and committed six, and the editor's unsaved-work list under-reported the
    // same way.
    /*
     * Not caught.
     *
     * This used to be `.catch(() => '')`, which turned every way git can
     * refuse to answer — an index left truncated by a killed process, a
     * `status` that outgrew the 8 MB buffer, a permission problem in `.git` —
     * into an empty list. `saveStore` reads that list as the whole question:
     * nothing pending means nothing to commit, which it reports as `saved:
     * false`, documented as "everything was already committed — *not an
     * error*". So `rmm save` printed nothing-to-save and exited 0, and the
     * editor's Save button reported success, for a store where git had not
     * been able to look. The one command whose entire job is to make "is my
     * work safe?" unambiguous answered yes without having asked.
     *
     * A repository that is not there yet is the one empty answer that is
     * true, and it is already handled above.
     */
    /*
     * `--no-optional-locks`, because this runs outside the queue in
     * `commitAll`.
     *
     * Plain `git status` refreshes the index and writes it back under
     * `.git/index.lock` whenever a file's timestamps have moved, and every
     * save moves them. A commit whose `git add` starts while that lock is
     * held fails: "Unable to create '.git/index.lock': File exists". The save
     * panel, the start of every `saveStore` and the sweep all ask this, so a
     * commit beside any of them could fail and leave an edit with no version
     * of its own. Measured: three of these beside each of sixty commits, and
     * 8 of the commits failed. Without the refresh the answer is the same,
     * only git has to compare a few more files itself.
     */
    const out = await this.git(['--no-optional-locks', 'status', '--porcelain', '-uall', '-z', '--', ...where]);

    const records = out.split('\0');
    const changes: PendingChange[] = [];
    for (let i = 0; i < records.length; i++) {
      const record = records[i];
      if (!record) continue;
      const code = record.slice(0, 2);
      const file = record.slice(3);
      // A rename or copy carries its old path in the following record.
      if (code[0] === 'R' || code[0] === 'C') i++;
      changes.push({ path: file, state: stateOf(code, () => fs.existsSync(path.join(this.root, file))) });
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

  /**
   * Many blobs' contents, through one `git cat-file --batch`.
   *
   * `blob` above is a process per object, which is fine for one file. Version
   * history reads several for each of hundreds of commits, and starting git
   * costs more than reading the file, so this asks for all of a commit's on
   * one process's stdin.
   *
   * It answers as `blob` would, object by object, so a caller can use either:
   * an id git does not have, an object that is not a blob, and a blob over the
   * size `git` would have refused to buffer are all absent from the map, which
   * a caller reads as the `''` `blob` gives back. A process that fails outright
   * leaves out whatever it had not yet answered, the same way.
   */
  async blobs(objectIds: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    // Ids come out of `ls-tree`, but a newline in one would be a second
    // request on the same line, so anything that is not a hash is not asked.
    const asking = [...new Set(objectIds)].filter((id) => /^[0-9a-fA-F]{4,64}$/.test(id));
    if (asking.length === 0) return out;

    const raw = await new Promise<Buffer>((resolve) => {
      const child = spawn('git', ['cat-file', '--batch'], { cwd: this.root, stdio: ['pipe', 'pipe', 'ignore'] });
      const chunks: Buffer[] = [];
      child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
      child.once('error', () => resolve(Buffer.concat(chunks)));
      child.once('close', () => resolve(Buffer.concat(chunks)));
      // A process that died before reading its input is the close above.
      child.stdin.on('error', () => undefined);
      child.stdin.end(`${asking.join('\n')}\n`);
    });

    // "<oid> <type> <size>\n<contents>\n" per object, or "<id> missing\n",
    // one answer per line asked and in the order asked.
    let at = 0;
    for (const asked of asking) {
      const eol = raw.indexOf(0x0a, at);
      if (eol < 0) break; // Cut off: the rest was not answered.
      const [, type = '', size = ''] = raw.toString('utf8', at, eol).split(' ');
      at = eol + 1;
      if (!/^\d+$/.test(size)) continue;
      const length = Number(size);
      if (at + length > raw.length) break;
      if (type === 'blob' && length <= Repo.MAX_BUFFER) out.set(asked, raw.toString('utf8', at, at + length));
      at += length + 1;
    }
    return out;
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
    /*
     * The address as it is shown has its token masked (see `redactUrl`), and
     * the settings panel sends back what it shows. Saved as given, that put
     * the dots in place of the token and the next push failed to sign in.
     * The shown form of the remote that is already there is that remote,
     * unchanged — that exact form only, so an address with no token in it
     * really does take the token off.
     *
     * And the masked token with the rest of the address edited — a new
     * repository name typed over the old one — keeps the token it stands for,
     * rather than saving three dots as a password.
     *
     * But only while it still goes to the same place. The token was put back
     * whatever else had changed, so `https://alice:•••@gitlab.example.net/…`
     * or `ssh://alice:•••@attacker.example/…` was saved with the GitHub token
     * in it, and the next push handed that token to another server. The
     * secret is put back only when the scheme, host, port and user name are
     * the ones it was typed for; a path edit on the same host keeps it, as
     * before. Anywhere else the dots are refused rather than saved: they are
     * not a password, and quietly dropping them would push without one.
     */
    if (existing && url !== existing) {
      const shown = redactUrl(existing);
      if (url === shown) return;
      const masked = USERINFO.exec(shown)?.[2];
      const given = USERINFO.exec(url)?.[2];
      if (masked?.includes(REMOTE_MASK) && given === masked && sameServer(url, existing)) {
        const real = USERINFO.exec(existing)![2]!;
        url = url.replace(USERINFO, (_all, scheme: string) => `${scheme}${real}@`);
      }
    }
    if (USERINFO.exec(url)?.[2]?.includes(REMOTE_MASK)) {
      throw new Error(
        `The address still has the hidden token (${REMOTE_MASK}) in it, but it no longer points at the server that token was saved for. ` +
          'Type the token into the address again (or leave it out), so it is not sent somewhere it was not meant for.',
      );
    }
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
    if (!url || !branch) return { url: redactUrl(url), branch, ahead: 0, behind: 0, tracked: false };

    const counts = await this.git([
      'rev-list',
      '--left-right',
      '--count',
      /*
       * Full names, because short ones are looked up tags first: a tag
       * called `origin/main` — anybody can push one — was what this counted
       * against, and what the pull merged, instead of the branch. See
       * `mergeFrom`.
       */
      `refs/remotes/origin/${branch}...refs/heads/${branch}`,
    ]).catch(() => '');

    const [behind = '0', ahead = '0'] = counts.trim().split(/\s+/);
    return { url: redactUrl(url), branch, ahead: Number(ahead) || 0, behind: Number(behind) || 0, tracked: Boolean(counts.trim()) };
  }

  /**
   * Push the store to its remote. Returns git's own output, since an auth
   * failure or a rejected push is something the user has to read.
   */
  async push(timeout = PUSH_TIMEOUT_MS): Promise<{ ok: boolean; output: string }> {
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
    /*
     * With the clone's protections, all of them.
     *
     * No terminal to ask for a password on — see `cloneRepo`. Without that a
     * push to a remote with no credentials hung the request until it was
     * killed. Refusing the prompt was not enough, though: a remote that
     * accepts the connection and then sends nothing held `git push`, and the
     * request and the Push button waiting on it, open for as long as the
     * server ran — measured at over a minute with no end in sight, git and its
     * `git-remote-http` helper still there afterwards. So it gets what the
     * clone has: the low-speed limit, SSH that will not ask and gives up
     * connecting, and an overall timeout that takes the whole process group
     * down with it.
     *
     * The user's own `core.sshCommand` is theirs to keep, as their
     * `GIT_SSH_COMMAND` is: the environment variable would override it.
     */
    const ownSsh = (await this.git(['config', '--get', 'core.sshCommand']).catch(() => '')).trim();
    // The commit being pushed, as it is now: see `afterTimedOutPush`.
    const pushing = (await this.git(['rev-parse', `refs/heads/${branch}`]).catch(() => '')).trim();
    try {
      const { stdout } = await gitWithin(['push', '-u', 'origin', branch], this.root, timeout, Boolean(ownSsh));
      return { ok: true, output: redactUrls(stdout.trim()) || `Pushed ${branch} to origin.` };
    } catch (err) {
      const e = err as { stderr?: string; message?: string; timedOut?: boolean };
      if (e.timedOut) return this.afterTimedOutPush(branch, pushing, url, timeout, Boolean(ownSsh));
      const said = redactUrls((e.stderr || e.message || 'Push failed').trim());
      /*
       * Rejected because the remote has commits this save does not.
       *
       * Git's hint ends "use 'git pull' before pushing again", which is advice
       * for a terminal. Said in the app's words instead, naming its own Pull
       * (which it did not always have) — and the remote is fetched,
       * cheaply, since it has just answered, so the status beside the message
       * can say how far behind this save is rather than "behind 0".
       */
      if (/\[rejected\]|non-fast-forward|fetch first/i.test(said)) {
        await gitWithin(['fetch', '--quiet', 'origin', branch], this.root, FETCH_TIMEOUT_MS, Boolean(ownSsh)).catch(() => undefined);
        this.ownFetch(); // Not somebody's pull: see `justPulled`.
        return {
          ok: false,
          output:
            `The remote has changes this save does not have — saved from another machine — so the push was refused ` +
            `and nothing on the remote was changed. Pull them in first (the Pull button beside Push, or rmm pull), ` +
            `settle any conflict it reports, and then push again.\n\n${said}`,
        };
      }
      return { ok: false, output: said };
    }
  }

  /**
   * A push that was stopped for taking too long, asked about rather than
   * assumed about.
   *
   * This used to say "Nothing was changed on the remote", and that is not
   * something a timeout knows. The remote moves its branch before it runs
   * its `post-receive` hook, so a hook that takes its time — a CI trigger, a
   * mirror — holds `git push` open after the push has landed, and the
   * timeout then reported a push that had happened as one that had not. The
   * person pushes again, is told "Everything up-to-date", and stops trusting
   * either answer.
   *
   * So the remote is asked, briefly, with `git ls-remote`: if its branch is
   * the commit that was pushed, the push landed, and the tracking ref and
   * upstream that `push -u` would have recorded are recorded here.
   *
   * If it is not, that is not a "did not land" either, though it used to be
   * said as one. A `pre-receive` hook that takes its time — a server-side
   * check — runs before the branch moves, so the remote can still be about to
   * take the push when it is asked; measured, it landed seconds after being
   * reported as not landed. So it is said as what was seen: not there yet
   * when asked, and worth checking again. A branch the remote does not have
   * at all, or a remote that will not answer, is the same "may or may not".
   *
   * And it is compared with the commit that was pushed, taken before the
   * push, not with HEAD afterwards: an auto-commit made while the push was
   * waiting moves HEAD on, and the push that did land was then reported as
   * not landing, its tracking ref left behind.
   */
  private async afterTimedOutPush(
    branch: string,
    pushed: string,
    url: string,
    timeout: number,
    keepSsh: boolean,
  ): Promise<{ ok: boolean; output: string }> {
    const took = `The push took longer than ${Math.round(timeout / 1000)} seconds and was stopped`;
    const shown = redactUrl(url);
    let remote: string | undefined;
    try {
      const { stdout } = await gitWithin(
        ['ls-remote', 'origin', `refs/heads/${branch}`],
        this.root,
        Math.min(VERIFY_TIMEOUT_MS, timeout),
        keepSsh,
      );
      remote = stdout.split(/\s/)[0] || undefined;
    } catch {
      remote = undefined;
    }
    if (pushed && remote === pushed) {
      await this.git(['update-ref', `refs/remotes/origin/${branch}`, pushed]).catch(() => undefined);
      await this.git(['config', `branch.${branch}.remote`, 'origin']).catch(() => undefined);
      await this.git(['config', `branch.${branch}.merge`, `refs/heads/${branch}`]).catch(() => undefined);
      return {
        ok: true,
        output:
          `Pushed ${branch} to origin. ${shown} was slow to finish answering, so the push was stopped after ` +
          `${Math.round(timeout / 1000)} seconds — but asked afterwards, the remote has the commit that was pushed.`,
      };
    }
    if (remote !== undefined) {
      return {
        ok: false,
        output:
          `${took}: ${shown} stopped answering. Asked afterwards, the remote did not have the commit that was ` +
          'pushed yet — it had not landed when checked, but a remote that is still working on it may take it ' +
          'shortly. The save here is as it was. Check again in a minute by pushing again: if it has landed, git ' +
          'will say everything is up to date.',
      };
    }
    return {
      ok: false,
      output:
        `${took}: ${shown} stopped answering, and asked afterwards did not say whether it has the commit, so the ` +
        'push may or may not have reached the remote. The save here is as it was. Check the address and your ' +
        'connection, and push again — if it had landed, git will say everything is up to date.',
    };
  }

  /** Stores with a `pull` under way, from its fetch to its last word. */
  private static readonly pulls = new Set<string>();
  /** Stores whose pull is holding writes off — `outsideGit` says 'app'. */
  private static readonly holding = new Set<string>();

  /**
   * How long a pull waits for the writes already under way to finish before
   * it gives up, having changed nothing. Long enough for an application's
   * bundle to typeset; see `writesSettled`.
   */
  static PULL_DRAIN_MS = 30_000;

  /**
   * Bring the save up to date with its remote: fetch, then fast-forward, or
   * merge when both sides have moved.
   *
   * The app had Push and Clone and no Pull, so a second machine caught up
   * with `git pull` in a terminal while the server ran — and the server's
   * own writes and commits could land in the middle of that merge. The
   * guards in `outsideGit` narrowed it to a window of milliseconds by reading
   * what git leaves in `.git`, and measured with the tracker written through
   * the app during a pull, nought to two rows per run were still lost in it.
   * Pulling here closes it instead of narrowing it, because this program then
   * knows exactly when its own merge starts and ends:
   *
   * - The fetch runs first, outside everything: it changes nothing in the
   *   working tree, and it is the slow part (a remote that stops answering
   *   is given up on, as a push is, after `timeout`). Edits go on as usual
   *   meanwhile.
   * - Then writes are held off. New ones are *refused* rather than made to
   *   wait. Waiting was the other choice, and it is the unsafe one: a handler
   *   checks something — the version of a resume the edit was based on — and
   *   then writes, with nothing awaited in between (see `withCommit`). One
   *   that waited inside `withCommit` would write after the pull on the
   *   strength of a check made before it, over whatever the pull brought in.
   *   Refused, the person makes the change again a moment later, on top of
   *   the pulled save; the editor already handles a refused save.
   * - Writes that passed their check before the hold are waited for, so none
   *   lands in the middle of the merge. See `writesSettled`.
   * - Then, in the commit queue, so no auto-commit can interleave: whatever
   *   is on disk and not yet committed is committed, so the merge starts
   *   from a clean tree and nothing of this machine's is left for git to
   *   refuse to overwrite (or, with `merge.autoStash` set, to stash and put
   *   back around a write — the loss `outsideGit` describes).
   * - A conflict is not left half-merged in the save. The merge is undone
   *   with `git merge --abort`, so every file is as it was, and the files
   *   that conflicted are named with how to settle them in a terminal. A
   *   save left with conflict markers in it stops the app reading it at all
   *   (see `parseStoreYaml`), which is far worse than not having pulled.
   */
  async pull(timeout = PULL_TIMEOUT_MS): Promise<PullResult> {
    const refused = (message: string): PullResult => ({ ok: false, pulled: 0, files: [], message });
    if (!(await this.isRepo())) {
      return refused('The save is not a git repository yet, so there is nothing to pull into. Save it once, and add a remote, first.');
    }
    const url = await this.getRemote();
    if (!url) {
      return refused(
        'No remote is configured for the save, so there is nowhere to pull from. ' +
          (this.inTerminal
            ? `Add one with \`git -C ${this.root} remote add origin <address>\` — the same address the other machine pushes to.`
            : 'Add one under Backup Remote (Save & Files) — the same address the other machine pushes to.'),
      );
    }
    const shown = redactUrl(url);
    // Detached, as `push` explains, is easy to reach from the history; a
    // merge there would land on no branch at all.
    const branch = await this.currentBranch();
    if (!branch) {
      return refused(
        'HEAD is detached — the save is not on a branch, so there is nothing to pull into. ' +
          'Check a branch out first (git checkout main), then try again.',
      );
    }
    if (Repo.pulls.has(this.root)) return refused('A pull of this save is already running. Wait for it to finish.');
    Repo.pulls.add(this.root);
    try {
      /*
       * Which branch of the remote. The upstream git was told about, when it
       * is on `origin` — a clone's, or the one `push -u` records — and
       * otherwise the branch of the same name, which is what Push sends to.
       */
      const configured = (await this.git(['config', '--get', `branch.${branch}.merge`]).catch(() => '')).trim();
      const upstreamRemote = (await this.git(['config', '--get', `branch.${branch}.remote`]).catch(() => '')).trim();
      const theirs =
        configured.startsWith('refs/heads/') && (!upstreamRemote || upstreamRemote === 'origin')
          ? configured.slice('refs/heads/'.length)
          : branch;
      const tracking = `refs/remotes/origin/${theirs}`;

      const ownSsh = (await this.git(['config', '--get', 'core.sshCommand']).catch(() => '')).trim();
      try {
        /*
         * `--prune`, so a branch the remote no longer has — or a remote
         * address changed to a new, empty repository — is not pulled from the
         * remote-tracking copy left over from before.
         */
        await gitWithin(['fetch', '--quiet', '--prune', 'origin'], this.root, timeout, Boolean(ownSsh));
      } catch (err) {
        const e = err as { stderr?: string; message?: string; timedOut?: boolean };
        if (e.timedOut) {
          return refused(
            `The pull took longer than ${Math.round(timeout / 1000)} seconds waiting for ${shown}, and was ` +
              'stopped. Nothing in the save was changed. Check the address and your connection, and pull again.',
          );
        }
        // Without any token in the address, as everywhere: see `redactUrl`.
        const said = redactUrls((e.stderr || e.message || 'git fetch failed').trim());
        if (/could not read Username|terminal prompts disabled|Authentication failed|Permission denied \(publickey\)/i.test(said)) {
          return refused(
            `Git could not sign in to ${shown}. Set up the credentials it needs — an SSH key, or a credential ` +
              `helper — and pull again. Nothing in the save was changed.\n\n${said}`,
          );
        }
        return refused(`Could not fetch from ${shown}, so nothing was pulled and nothing in the save was changed.\n\n${said}`);
      } finally {
        this.ownFetch('FETCH_HEAD'); // Not somebody's pull: see `justPulled`.
      }
      const there = await this.git(['rev-parse', '-q', '--verify', `${tracking}^{commit}`]).then(
        (out) => out.trim(),
        () => '',
      );
      if (!there) {
        return refused(
          `${shown} has no branch called ${theirs} yet, so there is nothing to pull. Push sends this save there.`,
        );
      }

      /*
       * Hold writes off, and let the ones already under way land. Before the
       * queue, not in it: a write still under way may be waiting for its own
       * commit in that queue, and the pull waiting for the write from inside
       * it would wait for ever.
       */
      Repo.holding.add(this.root);
      try {
        if (!(await this.writesSettled(Repo.PULL_DRAIN_MS))) {
          return refused(
            'Something was still being saved — an application being built, most likely — and the pull did not ' +
              'start in the middle of it. Nothing was pulled. Pull again in a moment.',
          );
        }
        /*
         * And under the save's lock, from the commit of what is on disk to
         * the merge's end, so another ResumeM-M process on this save — the
         * server, when this is `rmm pull` — cannot write between the two.
         * `rmm pull` beside a running server saving a tracker row in a loop
         * was refused nine times in ten without it: the server wrote the
         * tracker after the pull had committed it, and the merge then would
         * not touch a file with an uncommitted change in it. The other process's writes wait for the
         * merge (see `SaveLock`), and its next request reads what it brought
         * in (`Store.forgetReadsIfGitMoved`).
         */
        return await this.queued(() =>
          holdSave(this.root, () => this.mergeFrom(tracking, theirs, shown)).catch((err: unknown) => {
            if (err instanceof Error && err.name === 'SaveBusyError') return refused(`Not pulled: ${err.message}`);
            throw err;
          }),
        );
      } finally {
        this.ownFetch('FETCH_HEAD', 'ORIG_HEAD'); // The merge's own; see `justPulled`.
        Repo.holding.delete(this.root);
      }
    } finally {
      Repo.pulls.delete(this.root);
    }
  }

  /** The merge half of `pull`, in the commit queue with writes held off. */
  private async mergeFrom(tracking: string, theirs: string, shown: string): Promise<PullResult> {
    const refused = (message: string): PullResult => ({ ok: false, pulled: 0, files: [], message });
    /*
     * Not over somebody's git. A merge or rebase stopped in a terminal is
     * theirs to finish, and a merge made here on top of it would conclude
     * it — the very thing `outsideGit` exists to stop.
     */
    let busy = this.outsideGit(false, true);
    /*
     * A lock, or a pull that has only just begun by its timestamps, is
     * waited out for a moment first, as an automatic commit waits (see
     * `commitNow`): most often it is a pull that has just finished — another
     * `rmm pull` a second ago, whose `ORIG_HEAD` this process did not write
     * and cannot tell from a terminal's.
     */
    const until = Date.now() + Repo.COMMIT_WAIT_MS;
    while ((busy?.kind === 'pull' || busy?.kind === 'lock') && Date.now() < until) {
      await new Promise((done) => setTimeout(done, 50));
      busy = this.outsideGit(false, true);
    }
    if (busy) {
      return refused(
        `Not pulled: ${busy.what}. Finish it first — in a terminal, in ${this.root}, resolve any conflicts and run ` +
          'git commit (or git merge --abort / git rebase --abort to undo it) — then pull again.',
      );
    }
    /*
     * Everything on disk into a commit first, so the merge starts from a
     * clean tree. Not left for git to sort out: a merge refuses outright to
     * touch a file with an uncommitted change in it, and one set to stash
     * around it is the stash-and-reset that lost writes before.
     */
    let pending: PendingChange[];
    try {
      pending = await this.pending();
      if (pending.length > 0) await this.commitNow('Save before pulling', undefined, true);
    } catch (err) {
      return refused(
        `Not pulled: what is on disk here could not be saved to the history first, and a pull needs it to be. ` +
          `${(err as Error).message}`,
      );
    }
    const left = await this.pending().catch(() => pending);
    if (left.length > 0) {
      return refused(
        `Not pulled: ${left.map((c) => c.path).slice(0, 5).join(', ')}${left.length > 5 ? '…' : ''} could not be saved ` +
          'to the history first, and a pull needs everything saved. ' +
          (this.inTerminal
            ? `\`rmm save --data ${this.root}\` saves them and says why if it cannot; \`git -C ${this.root} status\` shows them.`
            : 'Save History under Save & Files says why.'),
      );
    }

    const before = (await this.git(['rev-parse', 'HEAD'])).trim();
    const count = async (range: string) => Number((await this.git(['rev-list', '--count', range]).catch(() => '0')).trim()) || 0;
    const incoming = await count(`HEAD..${tracking}`);
    const outgoing = await count(`${tracking}..HEAD`);
    if (incoming === 0) {
      return {
        ok: true,
        pulled: 0,
        files: [],
        message:
          `Already up to date with ${shown} — nothing new to pull.` +
          (outgoing > 0 ? ` This save has ${outgoing} commit${outgoing === 1 ? '' : 's'} the remote does not; Push sends them.` : ''),
      };
    }
    const fastForward = outgoing === 0;
    const conflicted = (files: string[], how: string): PullResult => ({
      ok: false,
      pulled: 0,
      files: [],
      conflict: files,
      message:
        `Not pulled: ${files.join(', ')} ${files.length === 1 ? 'was' : 'were'} changed both here and ` +
        `on ${shown}, in ways git cannot put together on its own. ${how}, so the save is exactly ` +
        'as it was. To settle it, in a terminal: ' +
        `cd ${this.root}, run git pull, edit the <<<<<<< conflict markers out of ${files.length === 1 ? 'that file' : 'those files'} ` +
        '(or keep one side whole with git checkout --ours or --theirs <file>), then git add them and git commit. ' +
        'The app holds edits until you have. Push afterwards, so the other machine has the result too.',
    });
    /*
     * A conflict found before the working tree is touched, where git can say.
     *
     * Merging and then undoing it leaves the save exactly as it was — but not
     * for the moment in between, when the files hold git's conflict markers.
     * Measured with two servers, one filing applications while the other
     * pulled: seven requests that read the tracker in that moment were
     * refused with "Unresolved git merge conflict in applications.yaml",
     * about a save that had none a moment later. `merge-tree` works the
     * merge out in the object store and names the files that would conflict,
     * so a pull that cannot go through never writes a marker anywhere. Git
     * older than 2.38 does not have it, and gets the merge and its undo.
     */
    /*
     * From `tracking`, the remote-tracking branch's full name, never the
     * short `origin/<branch>`. git looks a short name up as a tag before it
     * looks at the remotes, so a tag called `origin/main` on the remote —
     * fetched with everything else — was what this merged: an old commit,
     * "Already up to date", and every pull after it did nothing at all while
     * reporting success.
     */
    let merged: string | undefined;
    if (!fastForward) {
      const clash = await this.wouldConflict(tracking);
      if (clash && clash.conflicts.length > 0) return conflicted(clash.conflicts, 'Nothing was merged');
      merged = clash?.tree;
    }
    /*
     * And what the pull would leave in the save, looked at before the save
     * has it. See `vetIncoming`. The tree a fast-forward ends at is the
     * remote's own; a merge's is the one `merge-tree` has just worked out.
     * A git too old for `merge-tree` has no tree to look at until it has
     * merged, and is vetted, and undone if need be, after.
     */
    const resultTree = fastForward
      ? (await this.git(['rev-parse', '-q', '--verify', `${tracking}^{tree}`]).catch(() => '')).trim()
      : merged;
    let switchedOff: string | undefined;
    const hadSwitchOff = aiSwitchedOff(this.root) !== undefined;
    if (resultTree) {
      const vetted = await this.vetIncoming(resultTree, shown);
      if (typeof vetted === 'object') return vetted;
      switchedOff = vetted;
    }
    /*
     * Merged from the remote-tracking branch, never from `FETCH_HEAD`: git
     * names a merge of `FETCH_HEAD` after the address it came from, which
     * would have put a token pasted into that address into the history,
     * where no redaction can reach it. This merge is "Merge remote-tracking
     * branch 'origin/main'".
     *
     * `--no-autostash` whatever the user's config says, for the reason above;
     * the tree is clean, so there is nothing to stash anyway. No editor and
     * no prompt: there is nobody to answer one.
     */
    const env = { ...noPrompt(), GIT_MERGE_AUTOEDIT: 'no', GIT_EDITOR: 'true' };
    try {
      await this.git(
        fastForward
          ? ['merge', '--ff-only', '--no-autostash', '--quiet', tracking]
          : [
              '-c', 'user.name=ResumeM-M', '-c', 'user.email=resumem-m@localhost',
              'merge', '--no-ff', '--no-edit', '--no-autostash', '--quiet',
              // Named as git names it from the short name, which the full one does not get.
              '-m', `Merge remote-tracking branch 'origin/${theirs}'`,
              tracking,
            ],
        env,
      );
    } catch (err) {
      // Not switched off for a pull that did not happen.
      if (switchedOff && !hadSwitchOff) clearAiSwitchOff(this.root);
      const conflicts = await this.conflictedPaths();
      const merging = await this.git(['rev-parse', '-q', '--verify', 'MERGE_HEAD']).then(() => true, () => false);
      let undone = true;
      if (merging) {
        await this.git(['merge', '--abort'], env).catch(() => undefined);
        undone = (await this.git(['rev-parse', 'HEAD'])).trim() === before && !fs.existsSync(path.join(this.gitDir() ?? this.root, 'MERGE_HEAD'));
      }
      if (!undone) {
        return {
          ok: false,
          pulled: 0,
          files: [],
          conflict: conflicts.length ? conflicts : undefined,
          message:
            `The pull's merge stopped part-way and could not be undone. In a terminal, in ${this.root}, run ` +
            'git merge --abort to put the save back as it was, or settle the conflicts and git commit. ' +
            'The app will not save edits until that is done.',
        };
      }
      if (conflicts.length > 0) return conflicted(conflicts, 'The merge was undone');
      const said = redactUrls(((err as { stderr?: string }).stderr || (err as Error).message || 'git merge failed').trim());
      return refused(`The changes from ${shown} could not be merged in, and the save was left as it was.\n\n${said}`);
    }

    const after = (await this.git(['rev-parse', 'HEAD'])).trim();
    if (!resultTree) {
      /*
       * The older git's turn: vetted now it has merged, and put back exactly
       * as it was when the result would not open. Writes are still held off
       * and the tree was clean before the merge, so the reset loses nothing.
       */
      const vetted = await this.vetIncoming(`${after}^{tree}`, shown, before);
      if (typeof vetted === 'object') {
        await this.git(['reset', '--hard', '--quiet', before]).catch(() => undefined);
        return vetted;
      }
      switchedOff = vetted;
    }
    /*
     * And the switch-off written into config.yaml, as a commit of its own
     * after the merge, for the versions that do not read the marker. See
     * `writeAiOff`. Not counted in what was pulled: it is this machine's.
     */
    if (switchedOff) {
      await this.commitAiOff('Switch the AI off: the command changed in what was pulled');
      /*
       * And said, when config.yaml could not be made to say off — a file
       * `writeAiOff` cannot rewrite and still have it read the same. The
       * marker keeps the AI off here whatever the file says.
       */
      const notWritten = reportAiOffNotWritten(this.root);
      if (notWritten) switchedOff = `${switchedOff} ${notWritten}`;
    }
    const files = (await this.git(['-c', 'core.quotePath=false', 'diff', '--name-only', '-z', before, after]).catch(() => ''))
      .split('\0')
      .filter(Boolean);
    const commits = `${incoming} commit${incoming === 1 ? '' : 's'}`;
    const changed = `${files.length} file${files.length === 1 ? '' : 's'} changed`;
    return {
      ok: true,
      pulled: incoming,
      files,
      ...(switchedOff ? { aiSwitchedOff: true } : {}),
      message:
        (fastForward
          ? `Pulled ${commits} from ${shown} (origin/${theirs}) — ${changed}.`
          : `Pulled ${commits} from ${shown} (origin/${theirs}) and merged ${incoming === 1 ? 'it' : 'them'} with the ` +
            `${outgoing} made here — ${changed}. Push sends the merge back, so the other machine has it too.`) +
        (switchedOff ? ` ${switchedOff}` : ''),
    };
  }

  /**
   * Write `ai.enabled: false` into config.yaml and commit that file alone,
   * under `message`. See `writeAiOff`. True when there was a commit.
   *
   * Only config.yaml, whatever else is on disk: this is the app deciding
   * something on its own, and it has no business committing anything else.
   * Called from inside the pull's turn in the commit queue, and on a clone
   * nothing else can see yet, so it does not queue. A commit that fails
   * leaves the file saying off, which is the safe half to be left with; the
   * marker holds the AI off here either way.
   */
  async commitAiOff(message: string): Promise<boolean> {
    if (!writeAiOff(this.root)) return false;
    try {
      await this.git([
        '-c', 'user.name=ResumeM-M', '-c', 'user.email=resumem-m@localhost',
        'commit', '-q', '-m', message, '--', 'config.yaml',
      ]);
      return true;
    } catch (err) {
      console.warn(`ResumeM-M: the AI was switched off in config.yaml, but it could not be committed: ${(err as Error).message}`);
      return false;
    }
  }

  /**
   * Whether the save may have `tree` — what a pull would leave in it — and,
   * when it may, what that does to the AI here.
   *
   * A refusal (a `PullResult`) for either of two things, both found before
   * the working tree is touched, so the save is exactly as it was:
   *
   * - A symbolic link anywhere in the tree. git checks links out as links,
   *   and the store opened every path it was given: a remote that sent
   *   `voice.md -> ../outside/credentials`, or `letters -> ../outside`, had
   *   this app showing a file from outside the save in the editor after a
   *   pull, and writing into a folder outside it on the next save. A resume
   *   save has no use for a link, so any link at all is refused rather than
   *   only the ones that are found to lead out — working out where a link
   *   leads, through other links, is the kind of check that is right until
   *   it is not. `Store` refuses to follow one as well, for a link that got
   *   in some other way.
   * - A file the save reads that would not parse. See `storeFileProblem`:
   *   git merges lines, and a merge it calls clean can still be a
   *   profile.yaml with the same key twice. Only the files the pull changes,
   *   since a file it leaves alone is the save's own business.
   *
   * Otherwise a sentence to add to the pull's message when it switches the
   * AI off here (see `aiCommandChange`), having already done so — before the
   * merge, so there is no moment when the new command is in config.yaml and
   * switched on — or undefined.
   */
  private async vetIncoming(tree: string, shown: string, base = 'HEAD'): Promise<PullResult | string | undefined> {
    const refused = (message: string): PullResult => ({ ok: false, pulled: 0, files: [], message });
    const listed = await this.git(['-c', 'core.quotePath=false', 'ls-tree', '-r', '-z', '--full-tree', tree]).catch(() => '');
    const entries = new Map<string, { mode: string; oid: string }>();
    for (const line of listed.split('\0').filter(Boolean)) {
      const tab = line.indexOf('\t');
      const [mode = '', , oid = ''] = line.slice(0, tab).split(' ');
      entries.set(line.slice(tab + 1), { mode, oid });
    }
    const links = [...entries].filter(([, e]) => e.mode === '120000').map(([p]) => p).sort();
    if (links.length > 0) {
      return refused(
        `Not pulled: ${linksRefused(links, shown)} Nothing was merged, so the save is exactly as it was. On the ` +
          'machine that pushed it, replace the link with the file itself, commit and push, and pull again.',
      );
    }

    const changed = (await this.git(['-c', 'core.quotePath=false', 'diff-tree', '-r', '-z', '--name-only', '--no-renames', base, tree]).catch(() => ''))
      .split('\0')
      .filter((p) => entries.has(p));
    const contents = await this.blobs(changed.map((p) => entries.get(p)!.oid));
    const unreadable: { path: string; why: string }[] = [];
    for (const file of changed) {
      const raw = contents.get(entries.get(file)!.oid);
      const why = raw === undefined ? undefined : storeFileProblem(file, raw);
      if (why) unreadable.push({ path: file, why });
    }
    if (unreadable.length > 0) {
      const names = unreadable.map((u) => u.path);
      return {
        ...refused(
          `Not pulled: git could put the changes from ${shown} together with this save's, but the result would leave ` +
            `${names.join(', ')} unreadable, and the save would not open: ${unreadable.map((u) => u.why).join(' ')} ` +
            'Nothing was merged, so the save is exactly as it was. To settle it, in a terminal: ' +
            `cd ${this.root}, run git pull, fix ${names.length === 1 ? 'that file' : 'those files'} (a key written twice, ` +
            'most likely — keep one), then git add and git commit, and Push so the other machine has the fix too.',
        ),
        unreadable: names,
      };
    }

    // The AI command, after the checks: a pull that is refused switches nothing off.
    if (!changed.includes('config.yaml')) return undefined;
    const config = async (at: string) => this.git(['cat-file', 'blob', `${at}:config.yaml`]).catch(() => undefined);
    /*
     * Whether the `false` a pull may turn on is a switch-off's, which is the
     * one `false` that turning on with the same command does not need looking
     * at again (see `aiCommandChange`): the last commit to config.yaml before
     * the merge, by its subject — `commitAiOff`'s, here or on the other
     * machine, which every one of them starts with.
     */
    const lastSaid = await this.git(['log', '-1', '--format=%s', base, '--', 'config.yaml']).catch(() => '');
    const change = aiCommandChange(await config(base), await config(tree), {
      offBySwitchOff: lastSaid.startsWith('Switch the AI off'),
    });
    if (!change) return undefined;
    switchAiOff(this.root, `The AI command changed in what was pulled: ${change}.`);
    return (
      `The AI command changed in what was pulled: ${change}. AI is switched off until you turn it on again ` +
      (this.inTerminal ? `with \`rmm config set ai.enabled true --data ${this.root}\`.` : 'in Settings.')
    );
  }

  /**
   * Whether `git merge-tree --write-tree` is there to ask (git 2.38 and
   * later), learnt the first time it is tried. `false` makes `pull` merge
   * and undo instead; tests set it to exercise that path.
   */
  static mergeTreeWorks: boolean | undefined;

  /**
   * The files merging `theirs` into HEAD would conflict on, worked out
   * without touching the working tree or the index; `[]` for a clean merge,
   * and undefined when this git cannot say. See `mergeFrom`.
   */
  private async wouldConflict(theirs: string): Promise<{ conflicts: string[]; tree?: string } | undefined> {
    if (Repo.mergeTreeWorks === false) return undefined;
    try {
      // A clean merge prints the tree it would make, and nothing else: what `vetIncoming` reads.
      const out = await this.git(['merge-tree', '--write-tree', '--name-only', '--no-messages', 'HEAD', theirs]);
      Repo.mergeTreeWorks = true;
      const tree = /^[0-9a-f]{40,64}$/.exec(out.trim())?.[0];
      return { conflicts: [], ...(tree ? { tree } : {}) };
    } catch (err) {
      const e = err as { code?: number; stdout?: string };
      // Exit 1 with a tree is "conflicts": the tree's id, then one name per line.
      if (e.code === 1 && typeof e.stdout === 'string' && /^[0-9a-f]{40,64}\n/.test(e.stdout)) {
        Repo.mergeTreeWorks = true;
        return { conflicts: [...new Set(e.stdout.split('\n').slice(1).map((l) => l.trim()).filter(Boolean))].sort() };
      }
      // Usage error (an older git), or anything else: let the merge itself say.
      if (e.code === 129) Repo.mergeTreeWorks = false;
      return undefined;
    }
  }

  /** Paths with an unmerged entry in the index — what a stopped merge conflicted on. */
  private async conflictedPaths(): Promise<string[]> {
    const listed = await this.git(['-c', 'core.quotePath=false', 'ls-files', '-u', '-z']).catch(() => '');
    const paths = new Set<string>();
    for (const line of listed.split('\0').filter(Boolean)) paths.add(line.slice(line.indexOf('\t') + 1));
    return [...paths].sort();
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

    /*
     * The patch, when there is any prospect of showing it.
     *
     * The cap below is applied to what git handed back, which is too late:
     * `this.git` reads through an 8 MB buffer, and a commit whose patch is
     * larger than that does not come back truncated, it rejects with
     * `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`. Nothing caught it. The first save
     * of an imported store is one commit holding the whole of it — a corpus
     * of years of writing included — so `rmm save` threw *after* making that
     * commit, reporting failure for a save that had worked, and
     * `GET /api/history/:hash` answered 500 for that commit from then on.
     *
     * `--numstat` above already says how much changed, without parsing
     * anything, so the size is known before the patch is asked for. The line
     * below is drawn against the *buffer*, not against the 200,000-character
     * display cap: a patch between those two is fetched and truncated as it
     * always was, because the first 200,000 characters of a large diff are
     * worth more than a sentence saying there was one. Two hundred thousand
     * changed lines is 8 MB at forty bytes a line, which is longer than any
     * line in a store of YAML and prose.
     *
     * Caught as well as counted, because bytes per line is not fixed and a
     * commit of very long lines can clear the count and still overflow. A
     * history entry that says it is too large to show is a working panel; one
     * that throws is not.
     */
    const lines = files.reduce((n, f) => n + (f.added ?? 0) + (f.removed ?? 0), 0);
    const TOO_MUCH_TO_SHOW = 200_000;
    const enormous = `This commit changes ${lines.toLocaleString()} lines, which is too much to show here.`;
    const diff =
      lines > TOO_MUCH_TO_SHOW
        ? enormous
        : await this.git(['show', '--pretty=format:', '--unified=3', hash]).catch(() => enormous);

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

/**
 * Git outside this program is part-way through changing the save. See
 * `Repo.outsideGit`.
 *
 * A pull started in a terminal can only be finished there, and the message
 * says so in those words — unless it is the app's own Pull, which finishes by
 * itself (`inApp`). `written` says
 * whether the change it is refusing is already on disk (a commit refused after
 * the write) or was never made (a write refused before it).
 */
export class GitBusyError extends Error {
  constructor(
    what: string,
    root: string,
    written = false,
    /**
     * The pull is the app's own (`Repo.pull`), which finishes by itself in a
     * moment. Telling somebody to go and finish it in a terminal sent them
     * looking for a terminal that does not exist.
     */
    inApp = false,
  ) {
    const finish =
      `Finish the pull in a terminal first: in ${root}, resolve any conflicts and run git commit ` +
      '(or git merge --abort / git rebase --abort to undo it)';
    super(
      inApp
        ? `Not saved: ${what}. It takes a moment — make this change again once the pull has finished.`
        : written
          ? `Not added to the version history yet: ${what}. The change itself is saved on disk and goes into the history with the next save after that. ${finish}.`
          : `Not saved: ${what}. ${finish}, then make this change again.`,
    );
    this.name = 'GitBusyError';
  }
}

/**
 * What git's "Unable to create '.git/index.lock': File exists" means here.
 *
 * Git's own sentence is about a file, and says to remove it only "if no other
 * git process is currently running". Which of the two it is can be told from
 * the lock's age (see `Repo.STALE_LOCK_MS`), so this says which, and what to do.
 */
function explainLock(message: string, root: string): string {
  if (!/index\.lock.*File exists/is.test(message)) return message;
  let age = 0;
  try {
    age = Date.now() - fs.statSync(path.join(root, '.git', 'index.lock')).mtimeMs;
  } catch {
    // Gone since, which is the "another git was running" reading.
  }
  return age >= Repo.STALE_LOCK_MS
    ? `${message.trim()}\nThe lock is ${Math.round(age / 60_000)} minute(s) old, so it was left by a git that was stopped part-way. ` +
        `If no git is running, delete ${path.join(root, '.git', 'index.lock')} and save again.`
    : `${message.trim()}\nAnother git process was using the save at the time. Save again once it has finished.`;
}

/** Read a porcelain status code as one word. Untracked counts as added. */
function stateOf(code: string, onDisk: () => boolean): PendingChange['state'] {
  if (code === '??') return 'added';
  /*
   * An unmerged path, which porcelain spells with the two sides' letters:
   * `UD` is "we modified it, they deleted it". Read for a `D` like any other
   * code, that listed the file the merge had left in the tree — the one with
   * the edit in it — as deleted, which is the opposite of what is on disk and
   * the opposite of what the next commit would record. An unmerged path is
   * described by what is there now: both sides deleting it (`DD`) or nothing
   * on disk is a deletion, added on either side is an addition, and the rest
   * is a modification.
   */
  if (/^(DD|AU|UD|UA|DU|AA|UU)$/.test(code)) {
    if (code === 'DD' || !onDisk()) return 'deleted';
    return code.includes('A') ? 'added' : 'modified';
  }
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
 *
 * `paths` scopes the commit the way `commitAll` does. Almost every caller
 * here is an edit somebody just made through the app, where the whole store
 * is the right scope; the one that is not is the sweep, which is the app
 * removing something on its own and has no business recording whatever else
 * happens to be unsaved on disk while it does.
 */
export async function withCommit<T>(
  repo: Repo,
  enabled: boolean,
  message: string,
  fn: () => T | Promise<T>,
  paths?: string[],
): Promise<T> {
  /*
   * Not while a pull is half done, whether or not auto-commit is on: the
   * write is what the pull would overwrite, and the commit after it is what
   * would conclude the pull's merge. See `Repo.outsideGit`. Before `fn` and
   * with nothing awaited, so a handler's check-then-write stays one step.
   */
  repo.assertNoOutsideGit();
  /*
   * And counted as under way until `fn` is done, for a pull starting now to
   * wait for — when no request is holding it already. See `holdWrite`.
   * Released before the commit, which the pull does not need to wait for:
   * it is queued, and the pull's merge is queued behind it.
   */
  const release = repo.holdWriteOutsideRequest();
  let result: T;
  try {
    result = await fn();
  } finally {
    release();
  }
  if (enabled) await commitQuietly(repo, message, paths);
  return result;
}

/**
 * Commit, and let a failed commit be a failed commit rather than a failed
 * request.
 *
 * This is the containment half of `withCommit`, pulled out because two write
 * paths cannot use `withCommit` itself — `/api/apply` and the extension's
 * apply both do several things in an order that matters and commit at a
 * point in the middle — and both called `repo.commitAll` bare. `handler`
 * turns anything thrown at it into a 400, so a commit that failed for a
 * reason that has nothing to do with the application turned a bundle that
 * was built, files that were copied to the upload folder and a tracker row
 * that was written into:
 *
 *   400 {"error":"Command failed: git add -- ."}
 *
 * The person sees the application fail and builds it again, which is how one
 * application becomes two. And the failure is not hypothetical: a concurrent
 * save's scratch file disappearing mid-walk does exactly this — see
 * `Repo.IGNORED`, which is the other half of the same bug.
 *
 * The write has landed either way. What is owed is a record that the history
 * did not, which is what `lastCommitError` is for and what the editor's git
 * panel reads.
 */
export async function commitQuietly(repo: Repo, message: string, paths?: string[]): Promise<void> {
  try {
    const hash = await repo.commitAll(message, paths, { auto: true });
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
    const message = explainLock((err as Error).message, repo.root);
    repo.lastCommitError = { message, at: new Date().toISOString() };
    console.warn(`[rmm] auto-commit failed: ${message}`);
  }
}

/**
 * A remote's address as it can be shown: the token in front of the host
 * masked, `https://alice:•••@host/…`.
 *
 * A GitHub token pasted into the remote is the usual way to push over HTTPS
 * without a credential helper, and git keeps it in `.git/config` as typed.
 * `remoteStatus` handed that back as it was, so the token went out in every
 * `GET /api/config/store`, sat in plain sight in the settings field, and was
 * printed by `rmm save` — "3 commits not yet pushed to
 * https://alice:ghp_…@…". The remote keeps it; nothing that shows the address
 * does. Not a bare SSH login: in `git@github.com:me/save.git` the `git@` is
 * the SSH login every GitHub remote shares, not a secret, and the address is
 * not recognisable without it.
 */
/*
 * Masked rather than dropped: `https://alice:•••@github.com/me/save.git`.
 *
 * Dropped, the address shown was the address with no token, and the settings
 * panel sends back what it shows — so `setRemote` had to take the token-free
 * address as "unchanged", and then there was no way to say "take the token
 * off" from Settings at all: saving the address without it kept it. Masked,
 * only the masked address coming back is "unchanged", and an address with no
 * userinfo is exactly what it looks like.
 *
 * And not only http(s): `ssh://user:password@host` carries a password the
 * same way. A bare SSH login (`ssh://git@…`) stays, as in the scp form, and
 * a bare http(s) user is masked whole, since that is where a token pasted on
 * its own goes. The userinfo runs to the last "@" before the first "/", so a
 * token holding an unencoded "?", "#" or "@" is masked whole too, where
 * `[^/?#]*@` stopped at the "?" and showed it.
 */
export const REMOTE_MASK = '•••';
const USERINFO = /^([a-z][a-z0-9+.-]*:\/\/)([^/]*)@/i;
const USERINFO_IN_TEXT = /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/'"]*)@/gi;

function maskUserinfo(all: string, scheme: string, info: string): string {
  const colon = info.indexOf(':');
  if (colon >= 0) return `${scheme}${info.slice(0, colon)}:${REMOTE_MASK}@`;
  return /^https?:\/\/$/i.test(scheme) ? `${scheme}${REMOTE_MASK}@` : all;
}

/*
 * Whether two remote addresses go to the same server: the same scheme, host
 * and port (a port left out counts as that scheme's usual one). The user name
 * is compared by the caller, through the masked userinfo. See `setRemote`,
 * which uses this to decide whether a masked token may be put back.
 */
const SERVER = /^([a-z][a-z0-9+.-]*):\/\/(?:[^/]*@)?([^/?#]*)/i;
const USUAL_PORT: Record<string, string> = { http: '80', https: '443', ssh: '22', git: '9418' };

function server(url: string): string | undefined {
  const m = SERVER.exec(url);
  if (!m) return undefined;
  const scheme = m[1]!.toLowerCase();
  const hostPort = /^(\[[^\]]*\]|[^:]*)(?::(\d*))?$/.exec(m[2]!.toLowerCase());
  if (!hostPort) return undefined;
  const host = hostPort[1]!.replace(/\.$/, '');
  return `${scheme}://${host}:${hostPort[2] || USUAL_PORT[scheme] || ''}`;
}

function sameServer(a: string, b: string): boolean {
  const one = server(a);
  return one !== undefined && one === server(b);
}

export function redactUrl(url: string): string;
export function redactUrl(url: string | undefined): string | undefined;
export function redactUrl(url: string | undefined): string | undefined {
  return url?.replace(USERINFO, maskUserinfo);
}

/** The same, for any address inside git's own output. See `redactUrl`. */
export function redactUrls(text: string): string {
  return text.replace(USERINFO_IN_TEXT, maskUserinfo);
}

/** Git with nobody to answer it: a missing credential is refused, not asked for. */
function noPrompt(): NodeJS.ProcessEnv {
  return { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo', SSH_ASKPASS: 'echo' };
}

/**
 * The clone's environment: nobody to answer a prompt, and a remote that stops
 * sending is given up on rather than waited for. An HTTP transfer under 1 KB/s
 * for 30 seconds is abandoned; SSH is told not to ask (BatchMode) and not to
 * spend more than 15 seconds connecting — unless the user has their own
 * `GIT_SSH_COMMAND`, which is theirs to keep.
 */
function cloneEnv(): NodeJS.ProcessEnv {
  return {
    ...noPrompt(),
    GIT_HTTP_LOW_SPEED_LIMIT: '1000',
    GIT_HTTP_LOW_SPEED_TIME: '30',
    ...(process.env.GIT_SSH_COMMAND ? {} : { GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o ConnectTimeout=15' }),
  };
}

/**
 * `git clone`, and never for ever.
 *
 * A remote that accepts the connection and then sends nothing held the clone —
 * and the request waiting on it — open until the server was killed. The
 * low-speed limit in `cloneEnv` catches a transfer that stalls over HTTP; this
 * catches everything else. In a process group of its own, so the timeout takes
 * git's transport helper down with it: killing git alone left the helper
 * holding the pipes, and the clone still never finished.
 *
 * And `git push`, which talks to the same remotes and stalled the same way.
 * `keepSsh` leaves SSH to the store's own `core.sshCommand`, which the
 * environment variable would otherwise override.
 */
function gitWithin(
  args: string[],
  cwd: string,
  timeout: number,
  keepSsh = false,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const group = process.platform !== 'win32';
    const env = cloneEnv();
    if (keepSsh && !process.env.GIT_SSH_COMMAND) delete env.GIT_SSH_COMMAND;
    const child = spawn('git', args, { cwd, env, detached: group, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (stdout.length < 1024 * 1024) stdout += chunk;
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < 1024 * 1024) stderr += chunk;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (group && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }, timeout);
    /*
     * Settled when git exits, not when its pipes close.
     *
     * 'close' waits for every holder of stdout and stderr to let go, and git
     * is not the only holder: an SSH with `ControlPersist` leaves a master
     * running in the background (in a session of its own, so the group kill
     * does not reach it) that inherited git's stderr and keeps it for as long
     * as it persists. A push that had finished and exited 0 then sat waiting
     * on that master until the timeout fired, and was reported as a push that
     * timed out. So 'exit' stops the clock, and what is still to be read is
     * given a moment to arrive; whichever of that moment and 'close' comes
     * first decides, and an exit code of 0 is a success.
     */
    let settled = false;
    let exitCode: number | null = null;
    let drain: NodeJS.Timeout | undefined;
    const settle = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(drain);
      child.stdout.destroy();
      child.stderr.destroy();
      if (code === 0) resolve({ stdout, stderr });
      else reject(Object.assign(new Error(`git ${args[0]} exited with ${code}`), { stderr, timedOut }));
    };
    child.once('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(drain);
      reject(err);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      exitCode = code;
      drain = setTimeout(() => settle(code), DRAIN_GRACE_MS);
    });
    child.once('close', (code) => settle(code ?? exitCode));
  });
}

/** How long output still in the pipes is waited for once git has exited. See `gitWithin`. */
const DRAIN_GRACE_MS = 250;

/** How long a push that timed out spends asking the remote whether it landed. */
const VERIFY_TIMEOUT_MS = 15 * 1000;

/**
 * How long a push may take in all. A save is YAML and prose, and pushes in
 * seconds; this is for a remote that has stopped answering, not a slow one,
 * which the low-speed limit in `cloneEnv` already lets through.
 */
export const PUSH_TIMEOUT_MS = 2 * 60 * 1000;

/**
 * How long a pull's fetch may take in all — the part that talks to the
 * remote. The merge after it is local, and quick.
 */
export const PULL_TIMEOUT_MS = 2 * 60 * 1000;

/** The fetch after a refused push, which only has to bring down what the remote has. */
const FETCH_TIMEOUT_MS = 30 * 1000;

/** The sentence for symbolic links in what a pull or a clone brought. See `Repo.vetIncoming`. */
function linksRefused(links: string[], shown: string): string {
  return (
    `${links.slice(0, 5).join(', ')}${links.length > 5 ? '…' : ''} on ${shown} ` +
    `${links.length === 1 ? 'is a symbolic link' : 'are symbolic links'}, and a save cannot have one: a link can ` +
    'lead the app to read and write files outside the save, anywhere on this computer.'
  );
}

/**
 * Refuse a freshly cloned save that has a symbolic link in it, for the reason
 * `Repo.vetIncoming` refuses a pull with one. Read off the commit with
 * `ls-tree`, as the pull does, rather than off the disk; `cloneProject`
 * removes the clone when this throws, so nothing of it is ever opened.
 */
export async function refuseClonedLinks(dir: string, url: string): Promise<void> {
  const { stdout } = await run('git', ['-c', 'core.quotePath=false', 'ls-tree', '-r', '-z', '--full-tree', 'HEAD'], {
    cwd: dir,
    maxBuffer: Repo.MAX_BUFFER,
  });
  const links = stdout
    .split('\0')
    .filter((line) => line.startsWith('120000 '))
    .map((line) => line.slice(line.indexOf('\t') + 1))
    .sort();
  if (links.length > 0) {
    throw new Error(
      `Not opened: ${linksRefused(links, redactUrl(url))} The clone was removed. Replace the link with the file ` +
        'itself in that repository, and clone again.',
    );
  }
}

/** How long a clone may take in all, however steadily it is still arriving. */
export const CLONE_TIMEOUT_MS = 10 * 60 * 1000;

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
export async function cloneRepo(url: string, into: string, timeout = CLONE_TIMEOUT_MS): Promise<void> {
  try {
    await gitWithin(['clone', '--', url, into], path.dirname(into), timeout);
  } catch (err) {
    if ((err as { timedOut?: boolean }).timedOut) {
      throw new Error(`git clone took longer than ${Math.round(timeout / 1000)} seconds and was stopped. Nothing was written.`);
    }
    // Without any token in the address: see `redactUrl`.
    const said = redactUrls(String((err as { stderr?: string }).stderr ?? (err as Error).message ?? '').trim());
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
  await repo.commitAll(messages.filing, onDisk, { auto: true }).catch(() => undefined);

  const filed = await filedPaths(repo);

  /*
   * And what git has is not the same question as what is on disk.
   *
   * `filed` is HEAD's tree: it says the *path* is in the history, not that
   * the version about to be deleted is. Two weeks of edits to a resume git
   * committed a fortnight ago satisfy it exactly as well as a file committed
   * a second ago — and a fortnight of uncommitted edits is an ordinary state,
   * because the filing commit two lines up is allowed to fail quietly and
   * auto-commit is a switch people turn off. Set `commit.gpgsign` with no
   * usable key, or leave a `pre-commit` hook that exits non-zero, and every
   * commit this program makes is a console warning nobody reads.
   *
   * So the check asks the whole question: git has the path, and the working
   * tree agrees with it. Anything else is held and reported, which is what
   * `held` is for.
   *
   * A status that will not run at all holds everything, for the same reason:
   * this is the one unrecoverable act in the program, and "I could not check"
   * is not permission to go ahead.
   */
  const unsaved = new Set(
    await repo
      .pending(going.flatMap((g) => g.paths))
      .then((changes) => changes.map((c) => c.path))
      .catch(() => going.flatMap((g) => g.paths)),
  );

  const taking = going.filter((g) => g.paths.some((p) => filed.has(p)) && !g.paths.some((p) => unsaved.has(p)));
  const held = going.filter((g) => !taking.includes(g)).map((g) => g.what);
  if (taking.length === 0) return { removed: [], held };

  /*
   * `true` whatever auto-commit is set to: that setting is about whether your
   * *edits* are recorded as you make them, and this is not an edit you made.
   *
   * Which is also why it is scoped, for the reason the filing commit above is
   * scoped and said so — and this one was not, so it did the opposite of what
   * that comment promises. `withCommit` without paths is `git add -- .`, so
   * opening the app half-way through hand-editing `profile.yaml` and having
   * one resume fall due committed the unfinished profile too, under "Sweep
   * …, temporary and done with". With auto-commit switched off it was worse
   * than untidy: the one setting that says "do not record my edits as I make
   * them" was overruled by a pass that had just finished explaining it was
   * not recording anybody's edits.
   *
   * Held to the paths git can be seen to have, which is the same set the
   * check above admitted: those are tracked, so adding them stages the
   * deletion, and a pathspec naming a file git has never heard of is a fatal
   * error rather than a no-op.
   */
  const leaving = taking.flatMap((g) => g.paths).filter((p) => filed.has(p));
  await withCommit(
    repo,
    true,
    messages.removing(taking.map((g) => g.what)),
    () => {
      for (const g of taking) remove(g.what);
    },
    leaving,
  );
  return { removed: taking.map((g) => g.what), held };
}
