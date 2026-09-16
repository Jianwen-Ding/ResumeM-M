import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Walk up from `dir` looking for the enclosing git repository. */
function findRepoRoot(dir: string): string | undefined {
  let cur = path.resolve(dir);
  for (;;) {
    if (fs.existsSync(path.join(cur, '.git'))) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) return undefined;
    cur = parent;
  }
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

  constructor(root: string, scope: string[] = ['.']) {
    this.root = path.resolve(root);
    this.scope = scope.length > 0 ? scope : ['.'];
  }

  /** A repo whose auto-commits only ever touch the store directory. */
  static forStore(storeDir: string): Repo {
    const abs = path.resolve(storeDir);
    const root = findRepoRoot(abs) ?? abs;
    const rel = path.relative(root, abs) || '.';
    return new Repo(root, [rel]);
  }

  private async git(args: string[]): Promise<string> {
    const { stdout } = await run('git', args, { cwd: this.root, maxBuffer: 8 * 1024 * 1024 });
    return stdout;
  }

  async isRepo(): Promise<boolean> {
    try {
      await this.git(['rev-parse', '--git-dir']);
      return true;
    } catch {
      return false;
    }
  }

  /** Initialise a repo if the store is not already inside one. */
  async ensure(): Promise<void> {
    if (await this.isRepo()) return;
    fs.mkdirSync(this.root, { recursive: true });
    await this.git(['init']);
    await this.commitAll('Initialise resume store');
  }

  /**
   * Stage everything under `paths` and commit. Returns the new commit hash, or
   * undefined when there was nothing to commit — a no-op save should not be an
   * error, and should not create an empty commit either.
   */
  async commitAll(message: string, paths?: string[]): Promise<string | undefined> {
    if (!(await this.isRepo())) return undefined;
    const targets = paths ?? this.scope;
    await this.git(['add', '--', ...targets]);

    // Only commit what is staged within scope; unrelated working-tree changes
    // elsewhere in the repo must not ride along.
    const staged = await this.git(['diff', '--cached', '--name-only', '--', ...targets]);
    if (!staged.trim()) return undefined;

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
      '--',
      ...targets,
    ]);
    return (await this.git(['rev-parse', 'HEAD'])).trim();
  }

  async log(limit = 30): Promise<{ hash: string; date: string; message: string }[]> {
    if (!(await this.isRepo())) return [];
    const out = await this.git(['log', `-${limit}`, '--pretty=format:%H%aI%s']);
    return out
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [hash = '', date = '', message = ''] = line.split('');
        return { hash, date, message };
      });
  }

  /** Contents of a file at a past commit, for recovering an old phrasing. */
  async show(hash: string, relPath: string): Promise<string> {
    return this.git(['show', `${hash}:${relPath}`]);
  }
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
      await repo.commitAll(message);
    } catch (err) {
      // A failed commit must not lose the write that already landed on disk.
      console.warn(`[rmm] auto-commit failed: ${(err as Error).message}`);
    }
  }
  return result;
}
