import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * One writer at a time per save, across processes.
 *
 * The server and the `rmm` CLI are separate processes working on the same
 * folder, and nothing stood between them. Each one's own writes were in
 * order — the server's commit queue, the handlers' check-then-write with
 * nothing awaited between — but those are promises inside one process, and
 * the other process cannot see them. Measured with the server saving one
 * tracker row in a loop while `rmm apply` filed new ones: the server read
 * applications.yaml, the CLI wrote its row, and the server wrote the list it
 * had read back over it. `rmm apply` had exited 0; its row was gone from the
 * file. `rmm config set ai.enabled` against the Settings page lost eight
 * changes in sixteen the same way, and the two processes' commits collided
 * on git's own `index.lock`.
 *
 * So a lock file, the oldest cross-process lock there is: created with
 * O_EXCL (`wx`), which the file system answers for exactly one of two
 * processes asking at once, and removed when the work is done. It is
 * advisory — a hand edit or a terminal git does not take it — and that is
 * all it has to be, since everything that takes it is this program.
 *
 * - **Where.** Inside `.git`, so it is never something git could see as a
 *   change to the save, and so there is no question of committing it. A save
 *   that is not a repository yet keeps it in its own folder, under a name
 *   (`.rmm-…tmp`) the save's `.gitignore` already leaves out (see
 *   `Repo.IGNORED`), for the moment it becomes one.
 * - **Whose.** It says which process holds it, on which machine, since when.
 *   A holder that has died — killed, crashed, the laptop closed on it — is
 *   noticed straight away by its pid when it is on this machine, and
 *   otherwise once the lock is `STALE_MS` old. A holder still working keeps
 *   it fresh (see `heartbeat`), so a long commit is not mistaken for a dead
 *   one.
 * - **How long to wait.** Up to `WAIT_MS`, in short steps, and then a
 *   sentence saying who holds it, rather than a write made over theirs.
 * - **Re-entrant.** Counted per process, per save: a store write that calls
 *   another store write, or a write made while this process's own commit
 *   holds the lock, goes straight through. Inside one process the order of
 *   things is already kept (the commit queue, and handlers that check and
 *   write with nothing awaited between); what this adds is the other process.
 * - **Fair.** A process that has been kept waiting says so with a file of
 *   its own beside the lock (see `want`), and one that comes along after it
 *   lets it go first. Without that, a server committing in a loop took the
 *   lock again in the same tick it let go, and the CLI, polling, saw a free
 *   lock about never.
 *
 * Synchronous (`holdSaveSync`) for the store's writes, which are synchronous
 * all the way down and are measured in milliseconds; asynchronous
 * (`holdSave`) for a commit or a pull's merge, which run git and await it.
 *
 * The synchronous wait is `Atomics.wait` on the main thread, and in the
 * server that is the event loop standing still: every request on the server
 * waits with it. So the server takes the lock asynchronously first, in
 * `withCommit`, around the write and the commit together, and the store's
 * synchronous write inside finds it held already by this process and goes
 * straight through. Measured with the CLI's commit running a hook that
 * slept seven seconds: the server's GETs stood still for five seconds and
 * its PATCH then failed with "remove …/rmm-write.lock"; with the lock taken
 * in `withCommit`, the GETs went on answering and the PATCH waited and
 * succeeded. The synchronous wait is left for writes made outside
 * `withCommit` — the CLI's, a test's — where nothing else is waiting on the
 * thread. Because nothing is blocked while it waits, `withCommit` waits
 * longer (`COMMIT_WAIT_MS`) than a synchronous write does (`WAIT_MS`).
 *
 * What the lock keeps apart is writes, not commits' scopes. The server
 * commits with `git add -- .`, so a file the CLI has just written and not
 * yet committed may go into the server's commit under the server's message
 * ("Update settings" holding `rmm apply`'s row), and the CLI's own commit
 * then finds nothing left to commit. Nothing is lost by it — every write is
 * in the history, under one message or the other — and `commitFromTerminal`
 * treats an empty commit as the ordinary thing it is. Documented behaviour,
 * not a bug to fix here.
 */
export class SaveLock {
  /** How old an unrefreshed lock has to be before it is taken for an abandoned one. */
  static STALE_MS = 10_000;
  /** How long a writer waits for the other process before saying so. */
  static WAIT_MS = 5_000;
  /**
   * How long `withCommit` waits, asynchronously, with nothing else waiting
   * on it. Long enough to sit out the other process's slowest commit — a
   * hook, a slow disk — rather than fail an edit that would have landed a
   * moment later.
   */
  static COMMIT_WAIT_MS = 30_000;
  /**
   * How long a waiter's file (see `want`) may go unrefreshed before it is
   * taken for a waiter that is gone. A waiter refreshes it at every poll,
   * so a live one is never near this; one whose process was killed is past
   * it soon after the wait it would have given up on anyway.
   */
  static get WANT_STALE_MS(): number {
    return SaveLock.WAIT_MS + 1_000;
  }
  /** How often a holder that is awaiting something says it is still there. */
  static HEARTBEAT_MS = 2_000;

  /** How many holds this process has on each save's lock right now. */
  private static readonly depth = new Map<string, number>();
  /** The refresher for each lock this process holds across an await. */
  private static readonly beats = new Map<string, NodeJS.Timeout>();
  /** When this process began waiting for each save's lock, while it waits. */
  private static readonly waitingSince = new Map<string, number>();
  /** The saves this process has already said it is writing unlocked. See `tryTake`. */
  private static readonly warnedUnlocked = new Set<string>();

  /**
   * Where a save's lock lives, and where the files of those waiting for it
   * go. `.git` when it is a folder, or a file pointing at one (a worktree);
   * otherwise the save's own folder.
   */
  static where(root: string): { dir: string; lock: string; wantPrefix: string; wantSuffix: string } {
    const gitDir = gitDirOf(root);
    return gitDir
      ? { dir: gitDir, lock: path.join(gitDir, 'rmm-write.lock'), wantPrefix: 'rmm-write.want-', wantSuffix: '' }
      : { dir: root, lock: path.join(root, '.rmm-write-lock.tmp'), wantPrefix: '.rmm-write-want-', wantSuffix: '.tmp' };
  }

  /** Whether this process holds the save's lock at the moment. */
  static held(root: string): boolean {
    return (SaveLock.depth.get(path.resolve(root)) ?? 0) > 0;
  }

  /**
   * One attempt: true when this process now holds the lock. Re-entrant, so a
   * process that holds it already always succeeds.
   */
  private static tryTake(root: string): boolean {
    const depth = SaveLock.depth.get(root) ?? 0;
    if (depth > 0) {
      SaveLock.depth.set(root, depth + 1);
      return true;
    }
    const at = SaveLock.where(root);
    const since = SaveLock.waitingSince.get(root);
    /*
     * After whoever was waiting first. A waiter whose process is gone, or
     * whose file is older than any wait could be, is not waiting.
     */
    if (SaveLock.someoneAhead(at, since)) {
      SaveLock.want(root, at);
      return false;
    }
    for (let tries = 0; tries < 3; tries++) {
      let fd: number;
      try {
        fd = fs.openSync(at.lock, 'wx');
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'EEXIST') {
          if (SaveLock.breakIfAbandoned(at.lock)) continue;
          SaveLock.want(root, at);
          return false;
        }
        if (code === 'ENOENT' && tries === 0) {
          // A save not made yet: the folder the write is about to create.
          try {
            fs.mkdirSync(at.dir, { recursive: true });
            continue;
          } catch {
            // Falls through to writing unlocked, below; the write says what is wrong.
          }
        }
        /*
         * Anything else — a read-only `.git`, a folder this account cannot
         * write in — is not a lock somebody else holds, and refusing every
         * write over it would turn a lock that only exists to stop lost
         * writes into a reason no write happens. The write itself says what
         * is wrong, if anything is.
         *
         * Said once, though. Going ahead unlocked is going without the
         * protection this exists for, and it went without a word: `rmm
         * config set` against a read-only `.git` wrote the setting, exited
         * 0 and left no lock, and nothing said the next write from another
         * process could land over it.
         */
        if (!SaveLock.warnedUnlocked.has(root)) {
          SaveLock.warnedUnlocked.add(root);
          console.warn(
            `[rmm] could not create the save's write lock at ${at.lock} (${code ?? 'unknown error'}); ` +
              'writing without it. Another ResumeM-M process writing this save at the same time could lose a change.',
          );
        }
        SaveLock.depth.set(root, 1);
        SaveLock.unwant(root, at);
        return true;
      }
      try {
        fs.writeSync(fd, `${process.pid} ${os.hostname()} ${new Date().toISOString()} ${process.argv.slice(1, 4).join(' ')}\n`);
      } finally {
        fs.closeSync(fd);
      }
      SaveLock.depth.set(root, 1);
      SaveLock.unwant(root, at);
      return true;
    }
    SaveLock.want(root, at);
    return false;
  }

  private static release(root: string): void {
    const depth = (SaveLock.depth.get(root) ?? 1) - 1;
    if (depth > 0) {
      SaveLock.depth.set(root, depth);
      return;
    }
    SaveLock.depth.delete(root);
    const beat = SaveLock.beats.get(root);
    if (beat) clearInterval(beat);
    SaveLock.beats.delete(root);
    const { lock } = SaveLock.where(root);
    /*
     * Only a lock that is still ours. One taken over as abandoned while this
     * process was stopped — a laptop asleep for longer than `STALE_MS` — is
     * somebody else's now, and removing it would let a third writer in.
     */
    try {
      if (SaveLock.ownerOf(lock)?.mine) fs.rmSync(lock, { force: true });
    } catch {
      // Gone already.
    }
  }

  /** Who a lock file says holds it. */
  private static ownerOf(lock: string): { pid: number; host: string; text: string; mine: boolean } | undefined {
    let text: string;
    try {
      text = fs.readFileSync(lock, 'utf8');
    } catch {
      return undefined;
    }
    const [pid, host] = text.split(' ');
    const n = Number(pid);
    return { pid: n, host: host ?? '', text, mine: n === process.pid && host === os.hostname() };
  }

  /** Whether a process on this machine is gone. Unknown (another machine, no permission to ask) is not gone. */
  private static gone(pid: number, host: string): boolean {
    if (host !== os.hostname() || !Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return false;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'ESRCH';
    }
  }

  /**
   * Remove a lock whose holder is gone, or which nobody has refreshed in
   * `STALE_MS`. True when it was removed and taking it is worth trying again.
   *
   * Moved aside before it is removed, and looked at again once it is aside,
   * so two processes that both judged the same lock abandoned cannot each
   * remove the other's fresh one: the second rename finds the first's new
   * lock, sees it is not the one it judged, and puts it back.
   */
  private static breakIfAbandoned(lock: string): boolean {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(lock);
    } catch {
      return true; // Let go of while we looked.
    }
    const owner = SaveLock.ownerOf(lock);
    if (!owner) return true;
    if (owner.mine) return false; // Ours, from a hold being let go this moment.
    const old = Date.now() - stat.mtimeMs > SaveLock.STALE_MS;
    if (!old && !SaveLock.gone(owner.pid, owner.host)) return false;
    const aside = `${lock}.${process.pid}.${Math.random().toString(36).slice(2)}.stale`;
    try {
      fs.renameSync(lock, aside);
    } catch {
      return true; // Somebody else moved it first.
    }
    let moved = '';
    try {
      moved = fs.readFileSync(aside, 'utf8');
    } catch {
      // Nothing to compare: treat as the one judged.
      moved = owner.text;
    }
    if (moved !== owner.text) {
      try {
        fs.linkSync(aside, lock);
      } catch {
        // A third process has taken it in the meantime; theirs stands.
      }
    } else {
      console.warn(`[rmm] took over the save's write lock from ${owner.pid}, which ${old ? 'had not touched it in a while' : 'is no longer running'}.`);
    }
    fs.rmSync(aside, { force: true });
    return true;
  }

  /** Say that this process is waiting, once per wait. See `someoneAhead`. */
  private static want(root: string, at: ReturnType<typeof SaveLock.where>): void {
    if (SaveLock.waitingSince.has(root)) return;
    const since = Date.now();
    SaveLock.waitingSince.set(root, since);
    try {
      fs.writeFileSync(path.join(at.dir, `${at.wantPrefix}${process.pid}${at.wantSuffix}`), `${process.pid} ${os.hostname()} ${since}\n`);
    } catch {
      // Without it this waiter is merely not first in line.
    }
  }

  /** This process's own waiter file. */
  private static wantFile(at: ReturnType<typeof SaveLock.where>, pid = process.pid): string {
    return path.join(at.dir, `${at.wantPrefix}${pid}${at.wantSuffix}`);
  }

  /**
   * Say that this process is still waiting: the file's modification time is
   * what `someoneAhead` judges a waiter by. Without it a waiter was judged by
   * when it began, and a wait longer than `STALE_MS` — which `withCommit`'s
   * may be — lost its place in line half way through.
   */
  private static stillWaiting(root: string): void {
    if (!SaveLock.waitingSince.has(root)) return;
    try {
      const now = new Date();
      fs.utimesSync(SaveLock.wantFile(SaveLock.where(root)), now, now);
    } catch {
      // Removed by a process that took it for abandoned; `want` writes it again on the next try.
      SaveLock.waitingSince.delete(root);
    }
  }

  private static unwant(root: string, at = SaveLock.where(root)): void {
    if (!SaveLock.waitingSince.delete(root)) return;
    fs.rmSync(SaveLock.wantFile(at), { force: true });
  }

  /**
   * Whether another process began waiting for this lock before this one did
   * (`since`; undefined for one not waiting at all), and is still waiting.
   */
  /*
   * A waiter is gone when its process is (on this machine), or when it has
   * not refreshed its file (`stillWaiting`) in `WANT_STALE_MS`. The time
   * written inside the file is when the wait began, which is what the order
   * is decided by; it used to be what staleness was judged by too, and a
   * file left by a waiter killed mid-wait, whose pid had since been given to
   * another program, kept every writer out for `STALE_MS` with no lock
   * anywhere. Judged by its modification time, it is out of the way once
   * the wait it stood for would have been over.
   *
   * And a lock moved aside (`breakIfAbandoned`) by a process that died
   * before it could remove it is swept here too, once it is `STALE_MS` old:
   * the one place that already lists the folder.
   */
  private static someoneAhead(at: ReturnType<typeof SaveLock.where>, since: number | undefined): boolean {
    let names: string[];
    try {
      names = fs.readdirSync(at.dir);
    } catch {
      return false;
    }
    const lockName = path.basename(at.lock);
    for (const name of names) {
      const full = path.join(at.dir, name);
      if (name.startsWith(`${lockName}.`) && name.endsWith('.stale')) {
        try {
          if (Date.now() - fs.statSync(full).mtimeMs > SaveLock.STALE_MS) fs.rmSync(full, { force: true });
        } catch {
          // Gone already.
        }
        continue;
      }
      if (!name.startsWith(at.wantPrefix) || !name.endsWith(at.wantSuffix)) continue;
      let text: string;
      let touched: number;
      try {
        text = fs.readFileSync(full, 'utf8');
        touched = fs.statSync(full).mtimeMs;
      } catch {
        continue;
      }
      const [pid, host, at0] = text.trim().split(' ');
      const theirs = Number(at0);
      if (Number(pid) === process.pid && host === os.hostname()) continue;
      if (!Number.isFinite(theirs) || Date.now() - touched > SaveLock.WANT_STALE_MS || SaveLock.gone(Number(pid), host ?? '')) {
        fs.rmSync(full, { force: true });
        continue;
      }
      if (since === undefined || theirs < since || (theirs === since && Number(pid) < process.pid)) return true;
    }
    return false;
  }

  /** The waiters ahead of this process, for `busy` to name when there is no lock to name. */
  private static waitersAhead(at: ReturnType<typeof SaveLock.where>): { pid: string; file: string }[] {
    let names: string[];
    try {
      names = fs.readdirSync(at.dir);
    } catch {
      return [];
    }
    return names
      .filter((name) => name.startsWith(at.wantPrefix) && name.endsWith(at.wantSuffix))
      .map((name) => ({ pid: name.slice(at.wantPrefix.length, name.length - at.wantSuffix.length), file: path.join(at.dir, name) }))
      .filter((w) => Number(w.pid) !== process.pid);
  }

  /**
   * The sentence for a writer that waited and did not get in.
   *
   * What to do depends on what can be told. A holder that is running on this
   * machine is simply busy — a commit through a slow hook, a long pull — and
   * the one thing to do is wait; the sentence used to end "remove
   * …/rmm-write.lock and try again" all the same, which, followed, lets a
   * second writer in on top of the first. The lock is only worth removing
   * when nothing can say its holder is alive: a holder on another machine,
   * or a waiter's file with no lock behind it.
   */
  private static busy(root: string, waited: number): SaveBusyError {
    const at = SaveLock.where(root);
    SaveLock.unwant(root, at);
    const seconds = `${Math.round(waited / 1000)} seconds`;
    const owner = SaveLock.ownerOf(at.lock);
    if (owner && owner.host === os.hostname() && !SaveLock.gone(owner.pid, owner.host)) {
      const command = owner.text.trim().split(' ').slice(3).join(' ');
      return new SaveBusyError(
        `Not saved: another ResumeM-M process (pid ${owner.pid}${command ? `, \`${command}\`` : ''}) is writing this save, ` +
          `and has been for more than ${seconds}. Nothing was changed. Wait a moment and try again.`,
      );
    }
    if (owner) {
      const who = `process ${owner.pid}${owner.host && owner.host !== os.hostname() ? ` on ${owner.host}` : ''}`;
      return new SaveBusyError(
        `Not saved: ${who} — another ResumeM-M server or rmm command on this save — has been writing to it for ` +
          `more than ${seconds}. Nothing was changed. Try again in a moment. ` +
          `If nothing else is running on ${root}, remove ${at.lock} and try again.`,
      );
    }
    /*
     * No lock at all: what kept this writer out was somebody ahead of it in
     * line (`someoneAhead`) who never took the lock — a waiter killed
     * mid-wait whose pid is now another program's, most likely.
     */
    const ahead = SaveLock.waitersAhead(at);
    const files = ahead.map((w) => w.file);
    return new SaveBusyError(
      `Not saved: ${ahead.length ? `process ${ahead.map((w) => w.pid).join(', ')} has` : 'another process had'} been waiting to write ` +
        `this save for more than ${seconds}, and nothing is writing it. Nothing was changed. Try again in a moment. ` +
        (files.length
          ? `If nothing else is running on ${root}, remove ${files.join(' and ')} and try again.`
          : 'If it happens again, see what else is running on the save.'),
    );
  }

  /**
   * Hold the save's lock for the length of `fn`, waiting for it
   * synchronously. For the store's writes, which have nothing to await.
   */
  static holdSync<T>(rootIn: string, fn: () => T): T {
    const root = path.resolve(rootIn);
    if (!SaveLock.tryTake(root)) {
      const until = Date.now() + SaveLock.WAIT_MS;
      const pause = new Int32Array(new SharedArrayBuffer(4));
      let step = 2;
      do {
        if (Date.now() >= until) throw SaveLock.busy(root, SaveLock.WAIT_MS);
        Atomics.wait(pause, 0, 0, step + Math.random() * step);
        step = Math.min(step * 2, 20);
        SaveLock.stillWaiting(root);
      } while (!SaveLock.tryTake(root));
    }
    try {
      return fn();
    } finally {
      SaveLock.release(root);
    }
  }

  /**
   * Hold the save's lock for the length of `fn`, which may await. Waits
   * without blocking, for `waitMs`, and keeps the lock fresh while `fn`
   * runs, so a commit that takes longer than `STALE_MS` is not taken for an
   * abandoned one.
   *
   * When the lock is free, `fn` is called before this returns to the event
   * loop: nothing of the caller's runs between a check it made and the
   * write `fn` makes, as with the synchronous hold. Only when another
   * process holds the lock is there a wait, and then other requests on this
   * server run meanwhile (that is the point); a caller whose check must
   * stand makes it inside `fn`.
   */
  static async hold<T>(rootIn: string, fn: () => Promise<T>, waitMs = SaveLock.WAIT_MS): Promise<T> {
    const root = path.resolve(rootIn);
    if (!SaveLock.tryTake(root)) {
      const until = Date.now() + waitMs;
      let step = 2;
      do {
        if (Date.now() >= until) throw SaveLock.busy(root, waitMs);
        await new Promise((done) => setTimeout(done, step + Math.random() * step));
        step = Math.min(step * 2, 20);
        SaveLock.stillWaiting(root);
      } while (!SaveLock.tryTake(root));
    }
    SaveLock.heartbeat(root);
    try {
      return await fn();
    } finally {
      SaveLock.release(root);
    }
  }

  /** Touch the lock now and then while this process holds it across awaits. */
  private static heartbeat(root: string): void {
    if (SaveLock.beats.has(root)) return;
    const timer = setInterval(() => {
      const { lock } = SaveLock.where(root);
      try {
        if (SaveLock.ownerOf(lock)?.mine) {
          const now = new Date();
          fs.utimesSync(lock, now, now);
        }
      } catch {
        // Gone; `release` is on its way.
      }
    }, SaveLock.HEARTBEAT_MS);
    timer.unref();
    SaveLock.beats.set(root, timer);
  }
}

/**
 * A save's `.git` folder, without asking git: the folder, or the one a
 * `.git` file points at (a worktree). Undefined when the save is not a
 * repository of its own yet.
 */
export function gitDirOf(root: string): string | undefined {
  const dotGit = path.join(root, '.git');
  try {
    if (fs.statSync(dotGit).isDirectory()) return dotGit;
    const pointer = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, 'utf8'))?.[1]?.trim();
    return pointer ? path.resolve(root, pointer) : undefined;
  } catch {
    return undefined;
  }
}

/** Another process held the save's lock for longer than a writer waits. */
export class SaveBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SaveBusyError';
  }
}

export const holdSaveSync = SaveLock.holdSync;
export const holdSave = SaveLock.hold;
/** `holdSave` with `withCommit`'s longer wait: for a write and its commit together. */
export const holdSaveForCommit = <T>(root: string, fn: () => Promise<T>): Promise<T> =>
  SaveLock.hold(root, fn, SaveLock.COMMIT_WAIT_MS);
