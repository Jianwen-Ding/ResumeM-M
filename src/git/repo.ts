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
    // A repo with no commits yet makes `git log` fail rather than print
    // nothing; an empty history is not an error to a caller.
    const out = await this.git(['log', `-${limit}`, '--pretty=format:%H%aI%s']).catch(
      () => '',
    );
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

    const [full = '', date = '', author = '', subject = '', body = ''] = meta.split('');

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
