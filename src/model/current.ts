import fs from 'node:fs';
import path from 'node:path';
import type { Application, ApplicationStatus } from './types.js';
import type { Store } from './store.js';

/**
 * One flat folder holding the files for every application still in flight.
 *
 * Bundles are archived one folder per application, which is right for finding
 * what you sent to Acme in March and wrong for the moment you actually need
 * them: a portal's file picker is open, and every extra folder to navigate is
 * friction at exactly the point where a mistake attaches the wrong PDF. So the
 * same files also live together in `out/current`, already named for upload.
 *
 * It is a projection, not a second copy to maintain: rebuilt from the tracker
 * whenever something changes, so an application that moves past sending takes
 * its files out of the way on its own.
 */

/** Statuses that mean "this is being sent, or was just sent". */
const IN_FLIGHT: ApplicationStatus[] = ['applying', 'applied'];

export const CURRENT_DIR = 'current';

export interface CurrentFolder {
  dir: string;
  files: string[];
  applications: number;
}

/**
 * Rebuild the flat folder from the tracker. Returns what is in it, so the
 * caller can say where to look.
 */
export function syncCurrent(store: Store, applications?: Application[]): CurrentFolder {
  const apps = applications ?? store.load().applications;
  const dir = path.join(store.outDir(), CURRENT_DIR);
  fs.mkdirSync(dir, { recursive: true });

  const wanted = new Map<string, string>(); // file name → where to copy it from
  for (const app of apps) {
    if (!IN_FLIGHT.includes(app.status) || !app.snapshotDir) continue;
    const from = path.join(store.outDir(), app.snapshotDir);
    if (!fs.existsSync(from)) continue;

    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      // `source/` holds the .tex and the frozen spec: archive material, not
      // anything you would upload.
      if (!entry.isFile()) continue;
      wanted.set(entry.name, path.join(from, entry.name));
    }
  }

  // Anything no longer in flight leaves. Only files this folder put there are
  // removed — it is not a general-purpose cleaner of the user's directory.
  for (const existing of fs.readdirSync(dir)) {
    if (!wanted.has(existing)) fs.rmSync(path.join(dir, existing), { force: true });
  }

  for (const [name, from] of wanted) {
    const to = path.join(dir, name);
    // Copy only when it differs, so the folder's timestamps mean something.
    if (!fs.existsSync(to) || fs.statSync(to).mtimeMs < fs.statSync(from).mtimeMs) {
      fs.copyFileSync(from, to);
    }
  }

  return {
    dir,
    files: [...wanted.keys()].sort(),
    applications: apps.filter((a) => IN_FLIGHT.includes(a.status) && a.snapshotDir).length,
  };
}
