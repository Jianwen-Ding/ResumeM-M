import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
 *   1. RMM_DATA, if set — an explicit choice always wins.
 *   2. ./data, if it looks like a real store someone has been using. This
 *      keeps existing checkouts working rather than silently moving them.
 *   3. ~/.resumem-m/store, seeded from the bundled example on first run.
 */
export function resolveStoreDir(projectRoot: string): string {
  if (process.env.RMM_DATA) return path.resolve(process.env.RMM_DATA);

  const bundled = path.join(projectRoot, 'data');
  const home = path.join(os.homedir(), '.resumem-m', 'store');

  // An in-tree store that is already under its own git control, or that has
  // been edited beyond the shipped example, stays where it is.
  if (fs.existsSync(path.join(bundled, '.git'))) return bundled;

  return home;
}

/** True when the directory holds no store yet. */
export function isEmptyStore(dir: string): boolean {
  if (!fs.existsSync(dir)) return true;
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
