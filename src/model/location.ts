import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readProjects } from './projects.js';

/**
 * The directory the shipped files live in, found rather than counted to.
 *
 * `path.resolve(here, '..', '..')` was the rule, and it is right exactly once.
 * Under `tsx`, `src/server/index.ts` is two levels down and lands on the
 * repository. Compiled, `dist/src/server/index.js` is three, and two levels up
 * is `dist/` — which has no `web/` in it, because TypeScript emits JavaScript
 * and nothing else. So a built server answered every API call and served the
 * editor as a 404, which is also what the macOS app is: a WKWebView pointed at
 * that server, showing nothing.
 *
 * The same off-by-one moved the seed data, so a freshly built install also
 * looked for `dist/data` and found no example store to copy.
 *
 * Looking for the thing instead of counting to it survives both layouts, and
 * the one after that.
 */
export function findProjectRoot(from: string): string {
  let dir = from;
  // Six is more than any layout here needs and stops a symlink loop dead.
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, 'web', 'index.html')) && fs.existsSync(path.join(dir, 'package.json'))) {
      return dir;
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  // Nothing found: keep the old answer rather than inventing a new failure.
  return path.resolve(from, '..', '..');
}

/**
 * Where the working store lives.
 *
 * Deliberately not inside the application's source tree. The store is your
 * data: it has a different lifetime from the tool, it is the thing you might
 * push to a private repository, and it should survive deleting and re-cloning
 * the code. `data/` in the repo is an example to seed from, not the store
 * itself.
 *
 * Resolution order:
 *   1. `--data`, if the command line named a folder — the most explicit thing
 *      there is, and it must beat the remembered save. It did not, once: the
 *      CLI accepted `--data` and threw it away, so three test servers started
 *      over three copies of a store all quietly served the *real* one and
 *      wrote to it.
 *   2. RMM_DATA, if set — the same choice, made by the environment.
 *   3. The save that is open, or the one chosen as the default.
 *   4. ./data, if it looks like a real store someone has been using. This
 *      keeps existing checkouts working rather than silently moving them.
 *   5. ~/.resumem-m/store, seeded from the bundled example on first run.
 */
export function resolveStoreDir(projectRoot: string, chosen?: string): string {
  return resolveStore(projectRoot, chosen).dir;
}

/**
 * Where a store came from, beside where it is: `--data`, RMM_DATA, the save
 * remembered from the app, an in-tree store, or the home default.
 *
 * It matters for seeding. An empty folder somebody named, or the home default
 * on a first run, is a store to start; a remembered save that is not there any
 * more was moved, unmounted or deleted, and filling its path with the bundled
 * example made somebody else's resumes the save the app reopened next time.
 */
export type StoreSource = 'flag' | 'env' | 'remembered' | 'bundled' | 'home';

/**
 * A leading `~` as the home folder, the way a shell would have read it.
 *
 * The shell expands `--data ~/x` before this program sees it, and does not
 * expand `--data=~/x` — the tilde is not at the start of a word — nor a `~`
 * in an `RMM_DATA` set in a launcher or a `.env` file. Those arrived as a
 * literal `~/x`, `path.resolve` made it `./~/x`, and a new save was seeded
 * in a folder called `~` inside whatever directory the command ran from,
 * reported as "Started a new save" and nowhere near the save that was meant.
 * Only `~` on its own or followed by a separator: `~morgan/x` is another
 * user's home, which is not this program's to look up.
 */
export function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (/^~[\\/]/.test(p)) return path.join(os.homedir(), p.slice(2));
  return p;
}

export function resolveStore(projectRoot: string, chosen?: string): { dir: string; from: StoreSource } {
  if (chosen?.trim()) return { dir: path.resolve(expandHome(chosen.trim())), from: 'flag' };
  if (process.env.RMM_DATA) return { dir: path.resolve(expandHome(process.env.RMM_DATA)), from: 'env' };

  const preferences = readProjects();
  const selected = preferences.defaultFolder || preferences.active;
  if (selected) return { dir: selected, from: 'remembered' };

  const bundled = path.join(projectRoot, 'data');
  const home = path.join(os.homedir(), '.resumem-m', 'store');

  // An in-tree store that is already under its own git control, or that has
  // been edited beyond the shipped example, stays where it is.
  if (fs.existsSync(path.join(bundled, '.git'))) return { dir: bundled, from: 'bundled' };

  return { dir: home, from: 'home' };
}

/**
 * True when the directory holds no store yet.
 *
 * A path that exists and is not a directory is not an empty store and never
 * could be. This used to hand it straight to `readdirSync`, which throws
 * ENOTDIR from the top of the CLI — outside `main`'s catch — so `rmm list
 * --data notes.txt` answered with a raw Node stack trace naming this
 * function, in a file that goes to some trouble everywhere else to say what
 * went wrong in the user's own terms.
 */
export function isEmptyStore(dir: string): boolean {
  const at = fs.statSync(dir, { throwIfNoEntry: false });
  if (!at) return true;
  if (!at.isDirectory()) return false;
  const entries = fs.readdirSync(dir).filter((f) => !f.startsWith('.'));
  return entries.length === 0;
}

/**
 * Copy the bundled example into a fresh store. Only ever runs when the target
 * is empty, so it can never overwrite someone's real content.
 */
export function seedStore(from: string, to: string): boolean {
  if (!fs.existsSync(from) || !isEmptyStore(to)) return false;
  fs.mkdirSync(to, { recursive: true });
  copyDir(from, to);
  return true;
}

function copyDir(from: string, to: string): void {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    // Never copy a nested repository or generated output into a new store.
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dest);
    else fs.copyFileSync(src, dest);
  }
}
