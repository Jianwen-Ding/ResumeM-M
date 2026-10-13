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
 */
export class SaveLock {
  /** How old an unrefreshed lock has to be before it is taken for an abandoned one. */
  static STALE_MS = 10_000;
  /** How long a writer waits for the other process before saying so. */
  static WAIT_MS = 5_000;
  /** How often a holder that is awaiting something says it is still there. */
  static HEARTBEAT_MS = 2_000;

  /** How many holds this process has on each save's lock right now. */
  private static readonly depth = new Map<string, number>();
  /** The refresher for each lock this process holds across an await. */
  private static readonly beats = new Map<string, NodeJS.Timeout>();
  /** When this process began waiting for each save's lock, while it waits. */
  private static readonly waitingSince = new Map<string, number>();

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
         */
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

  private static unwant(root: string, at = SaveLock.where(root)): void {
    if (!SaveLock.waitingSince.delete(root)) return;
    fs.rmSync(path.join(at.dir, `${at.wantPrefix}${process.pid}${at.wantSuffix}`), { force: true });
  }

  /**
   * Whether another process began waiting for this lock before this one did
   * (`since`; undefined for one not waiting at all), and is still waiting.
   */
  private static someoneAhead(at: ReturnType<typeof SaveLock.where>, since: number | undefined): boolean {
    let names: string[];
    try {
      names = fs.readdirSync(at.dir);
    } catch {
      return false;
    }
    for (const name of names) {
      if (!name.startsWith(at.wantPrefix) || !name.endsWith(at.wantSuffix)) continue;
      const full = path.join(at.dir, name);
      let text: string;
      try {
        text = fs.readFileSync(full, 'utf8');
      } catch {
        continue;
      }
      const [pid, host, at0] = text.trim().split(' ');
      const theirs = Number(at0);
      if (Number(pid) === process.pid && host === os.hostname()) continue;
      if (!Number.isFinite(theirs) || Date.now() - theirs > SaveLock.STALE_MS || SaveLock.gone(Number(pid), host ?? '')) {
        fs.rmSync(full, { force: true });
        continue;
      }
      if (since === undefined || theirs < since || (theirs === since && Number(pid) < process.pid)) return true;
    }
    return false;
  }

  /** The sentence for a writer that waited `WAIT_MS` and did not get in. */
  private static busy(root: string): SaveBusyError {
    SaveLock.unwant(root);
    const { lock } = SaveLock.where(root);
    const owner = SaveLock.ownerOf(lock);
    const who = owner ? `process ${owner.pid}${owner.host && owner.host !== os.hostname() ? ` on ${owner.host}` : ''}` : 'another process';
    return new SaveBusyError(
      `Not saved: ${who} — another ResumeM-M server or rmm command on this save — has been writing to it for ` +
        `more than ${Math.round(SaveLock.WAIT_MS / 1000)} seconds. Nothing was changed. Try again in a moment. ` +
        `If nothing else is running on ${root}, remove ${lock} and try again.`,
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
        if (Date.now() >= until) throw SaveLock.busy(root);
        Atomics.wait(pause, 0, 0, step + Math.random() * step);
        step = Math.min(step * 2, 20);
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
   * without blocking, and keeps the lock fresh while `fn` runs, so a commit
   * that takes longer than `STALE_MS` is not taken for an abandoned one.
   */
  static async hold<T>(rootIn: string, fn: () => Promise<T>): Promise<T> {
    const root = path.resolve(rootIn);
    if (!SaveLock.tryTake(root)) {
      const until = Date.now() + SaveLock.WAIT_MS;
      let step = 2;
      do {
        if (Date.now() >= until) throw SaveLock.busy(root);
        await new Promise((done) => setTimeout(done, step + Math.random() * step));
        step = Math.min(step * 2, 20);
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
