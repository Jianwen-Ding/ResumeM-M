import { randomUUID } from 'node:crypto';
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

/**
 * What this folder put here last time.
 *
 * Without it, "rebuilt from the tracker" meant deleting every name that is not
 * currently wanted — which is every file the user ever put in the folder
 * themselves. `out/current` is documented as the folder you point the file
 * picker at, so keeping a transcript or a signed offer letter in it is the
 * obvious thing to do, and a plain page load of the Applications tab removed
 * it. The comment claimed this was already the rule; the manifest is what
 * makes it true.
 */
const MANIFEST = '.rmm-current.json';

export interface CurrentFolder {
  dir: string;
  files: string[];
  /** In-flight applications whose files are in the folder. */
  applications: number;
  /**
   * In-flight applications altogether, built or not. An empty folder means
   * something different when two applications are in flight and neither has
   * been built than when none is in flight at all, and only the caller with
   * both numbers can say which.
   */
  inFlight: number;
  /**
   * Files that should be in the folder and are not, each with the reason.
   *
   * The folder is documented as the one to point a file dialog at, so the user
   * having put something of their own in it is ordinary — including, one day,
   * a folder with the same name as a file this sync wants to write. Copying
   * over it is not an option, and throwing was worse than it sounds: the sync
   * runs at the end of `buildBundle`, so an EISDIR here failed a request for
   * an application that had in fact been built and tracked, and took the whole
   * Applications tab with it.
   *
   * So the rest of the sync finishes and the file that could not be written
   * says so here, by name. Empty on the ordinary run.
   */
  problems?: string[];
}

/** Trimmed and hyphenated the way `bundleFileName` trims a part, for the same reason. */
function forFilename(s: string | undefined): string {
  return String(s ?? '')
    .replace(/[^\p{L}\p{N}_\s-]/gu, ' ')
    .replace(/[\s-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function readManifest(dir: string): string[] {
  try {
    const raw = fs.readFileSync(path.join(dir, MANIFEST), 'utf8');
    const parsed = JSON.parse(raw);
    /*
     * Plain names only, because every one of these is handed to a recursive
     * delete a few lines down. The file is ours, and it also sits in a folder
     * the user is invited to open, next to files they are told to keep there;
     * `"files": ["../../Documents"]` is one hand edit or one bad merge away
     * from `rm -r` on a folder nobody meant. A manifest entry that is not a
     * name in this folder describes nothing this sync put here.
     */
    return Array.isArray(parsed?.files)
      /*
       * `.` has to go in the list beside `..`, and it is the worse of the two.
       * `path.basename('.')` is `'.'`, so it passed the "plain name" test, and
       * `path.join(dir, '.')` is `dir` — so the recursive delete below was
       * handed the whole folder, including the transcript the folder's own
       * documentation invites the user to keep there.
       */
      ? parsed.files.filter(
          (f: unknown) => typeof f === 'string' && f !== '' && f === path.basename(f) && f !== '..' && f !== '.',
        )
      : [];
  } catch {
    // No manifest, or an unreadable one. Owning nothing is the safe reading:
    // it means the next sync deletes nothing it cannot account for.
    return [];
  }
}

/**
 * Which bundle each file in the folder was copied out of, last time.
 *
 * Freshness used to be a timestamp and nothing else, and a timestamp cannot
 * tell two applications apart. Every application produces the same
 * `First-Last-Resume.pdf` under the default naming, so when one hands that
 * name over to another the question is not "is the source newer?" but "is it
 * a different source?" — and the answer to the first was routinely no:
 * prepare Beta, prepare Acme, send Acme, then send Beta, and Beta's bundle is
 * older than the copy of Acme's already sitting in the folder. Nothing was
 * copied, nothing was reported, and the upload folder held Acme's tailored
 * resume under the name that now belonged to Beta.
 *
 * Only ever compared, never opened and never deleted — unlike `files`, which
 * is handed to a recursive delete and so has to be names in this folder. A
 * path here that means nothing simply forces a copy, which is the safe way to
 * be wrong.
 *
 * A manifest written before this existed has no `from` at all, so every name
 * reads as "came from somewhere else" and is copied once on the next sync.
 * That is the migration: one redundant copy, then right from then on.
 */
function readSources(dir: string): Record<string, string> {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST), 'utf8'));
    const from = parsed?.from;
    if (!from || typeof from !== 'object' || Array.isArray(from)) return {};
    const out: Record<string, string> = {};
    for (const [name, source] of Object.entries(from)) {
      if (typeof source === 'string' && source) out[name] = source;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Give each in-flight application a name of its own in the flat folder.
 *
 * Names are `FirstName-LastName-<Document Type>`, with the job title in the
 * middle when the setting asks for it. Neither shape is guaranteed unique:
 * without the title, two roles at one company clash; with it, the same role at
 * two companies does. Inside one shared folder the last writer would simply
 * win, and nothing about that was visible — the tracker reported two
 * applications in flight, the folder held one set of files, and the portal open
 * in front of you got the other job's resume and the other job's answers.
 *
 * So where names clash, the first thing that actually tells the clashing
 * applications apart is added to all of them: the role, the company, both, or
 * failing everything the application id. Nothing is added otherwise — the
 * person uploading knows what they are applying to, and a longer name is a
 * worse one.
 */
function uniqueNames(claims: { name: string; app: Application }[]): Map<string, string> {
  const groups = new Map<string, { name: string; app: Application }[]>();
  for (const claim of claims) {
    const group = groups.get(claim.name) ?? [];
    group.push(claim);
    groups.set(claim.name, group);
  }

  const out = new Map<string, string>(); // `${app.id} ${name}` → final name

  for (const [name, group] of groups) {
    if (group.length === 1) {
      out.set(`${group[0]!.app.id} ${name}`, name);
      continue;
    }

    const ext = path.extname(name);
    const stem = name.slice(0, name.length - ext.length);
    const candidates: ((a: Application) => string)[] = [
      (a) => forFilename(a.role),
      (a) => forFilename(a.company),
      (a) => forFilename(`${a.role ?? ''} ${a.company ?? ''}`),
      (a) => forFilename(a.id),
    ];

    // The first suffix that gives every one of them a name of its own.
    const suffix =
      candidates.find((of) => {
        const made = group.map((c) => of(c.app));
        return made.every(Boolean) && new Set(made).size === group.length;
      }) ?? ((a: Application) => forFilename(a.id));

    for (const claim of group) {
      out.set(`${claim.app.id} ${name}`, `${stem}-${suffix(claim.app)}${ext}`);
    }
  }
  return out;
}

/**
 * Rebuild the flat folder from the tracker. Returns what is in it, so the
 * caller can say where to look.
 */
export function syncCurrent(store: Store, applications?: Application[]): CurrentFolder {
  const apps = applications ?? store.load().applications;
  const dir = path.join(store.outDir(), CURRENT_DIR);
  fs.mkdirSync(dir, { recursive: true });

  const claims: { name: string; app: Application; from: string }[] = [];
  /*
   * The applications this folder could not put anything out for, and why.
   *
   * Every `continue` below is an in-flight application with a `snapshotDir`
   * that goes nowhere: a bundle folder the user deleted, one built under a
   * previous `output.dir` that no longer resolves, or a path that leads out
   * of the output folder and is refused. Each of those was skipped in
   * silence, and then counted at the bottom of this function as an
   * application "whose files are in the folder" — so the Applications tab
   * read "1 application's files are ready in out/current" beside a list that
   * did not include it, with nothing naming what was missing.
   */
  const missing: string[] = [];
  const says = (app: Application) => `${app.company} — ${app.role}`;

  for (const app of apps) {
    if (!IN_FLIGHT.includes(app.status) || !app.snapshotDir) continue;
    /*
     * Through the store, which refuses a `snapshotDir` leading out of the
     * output folder — see `Store.outPath`. This was a `path.join`, and the
     * value joined onto it comes from applications.yaml, so a row saying
     * `snapshotDir: ../../../.ssh` mirrored that folder into `out/current`,
     * which is served over HTTP to any origin that asks.
     */
    const from = store.outPath(app.snapshotDir);
    if (!from) {
      missing.push(`${says(app)}: its files are recorded at a path outside the output folder, so they were not read`);
      continue;
    }
    if (!fs.existsSync(from)) {
      missing.push(`${says(app)}: the folder its files were built into is not there any more`);
      continue;
    }

    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      // `source/` holds the .tex and the frozen spec: archive material, not
      // anything you would upload.
      if (!entry.isFile()) continue;
      claims.push({ name: entry.name, app, from: path.join(from, entry.name) });
    }
  }

  const renamed = uniqueNames(claims);
  const wanted = new Map<string, string>(); // final name → where to copy it from
  // And whose it is, so the count at the bottom can be what actually landed
  // rather than what the tracker hoped for.
  const owner = new Map<string, string>(); // final name → application id
  for (const claim of claims) {
    const name = renamed.get(`${claim.app.id} ${claim.name}`) ?? claim.name;
    wanted.set(name, claim.from);
    owner.set(name, claim.app.id);
  }

  // Anything this folder put here and no longer wants leaves. Only those: a
  // name the manifest does not claim belongs to the user, whatever it is.
  const ours = readManifest(dir);
  const cameFrom = readSources(dir);
  /*
   * Whether this folder has a record of what it put here.
   *
   * `readManifest` answers `[]` both for "the manifest lists nothing" and for
   * "there is no manifest", and the copy below has to tell those apart: with
   * a record, a name it does not hold is the user's; without one, nothing can
   * be said about any name and the old behaviour is the only safe one.
   */
  const tracked = fs.existsSync(path.join(dir, MANIFEST));
  const claimed = new Set(ours);
  for (const existing of ours) {
    if (wanted.has(existing) || existing === MANIFEST) continue;
    try {
      // `recursive` because a stale entry may be a directory — without it,
      // rmSync throws EISDIR and takes the whole Applications tab down with a
      // message naming no action the user could take.
      fs.rmSync(path.join(dir, existing), { recursive: true, force: true });
    } catch {
      // Locked, or gone already. Not a reason to fail the sync.
    }
  }

  const problems: string[] = [];
  const landed: string[] = [];
  for (const [name, from] of wanted) {
    const to = path.join(dir, name);
    try {
      /*
       * What is already there, if anything — and whether it is even a file.
       *
       * This was `existsSync` plus a timestamp, and a *directory* with the
       * wanted name passed both: freshly made, so newer than the bundle, so
       * nothing was copied, and the name went into the list of files the
       * folder holds. The Applications tab then said the resume was ready to
       * upload while the upload folder held a folder of the user's with that
       * name and no resume at all.
       */
      const at = fs.statSync(to, { throwIfNoEntry: false });
      if (at && !at.isFile()) {
        throw new Error('something that is not a file already has that name here');
      }
      /*
       * And a *file* of the user's is theirs too.
       *
       * The delete loop above commits to this in as many words — "a name the
       * manifest does not claim belongs to the user, whatever it is" — and
       * then only the directory case was honoured here. A file went straight
       * into the copy, so somebody who kept their own polished
       * `Jane-Doe-Resume.pdf` in the folder the app tells them to point the
       * upload dialog at lost it the first time a bundle produced that name.
       * Silently: it was not reported, and the name then went into the
       * manifest, so the *next* sync would have deleted it as ours.
       *
       * Only where there is a manifest to ask. Without one nothing here can
       * be attributed to anybody, and refusing every name would turn a
       * missing file into a folder that has stopped working.
       */
      if (at && tracked && !claimed.has(name) && cameFrom[name] === undefined) {
        throw new Error('a file of your own already has that name here, so it was left alone');
      }
      /*
       * Copy when it is a different bundle, or when the same bundle has been
       * rebuilt since. The second test alone let one application keep another
       * application's file — see `readSources`.
       */
      if (!at || cameFrom[name] !== from || at.mtimeMs < fs.statSync(from).mtimeMs) {
        /*
         * Through a temp file in the same folder, then renamed over the name.
         *
         * `copyFileSync` opens the destination with O_TRUNC, so for the length
         * of the copy the file in this folder is short — and this is the
         * folder whose entire purpose is that a portal's file dialog is open
         * over it. A PDF attached during that window is a truncated PDF that
         * the employer's viewer refuses, and nothing anywhere says so. A
         * rename within one directory is atomic, so the dialog sees the old
         * file or the new one.
         */
        const temp = path.join(dir, `.rmm-${randomUUID()}.tmp`);
        try {
          fs.copyFileSync(from, temp);
          fs.renameSync(temp, to);
        } catch (err) {
          fs.rmSync(temp, { force: true });
          throw err;
        }
      }
      landed.push(name);
    } catch (err) {
      /*
       * Named, rather than swallowed or thrown. Whatever is in the way — a
       * folder of the user's with this name, a file they have open and locked,
       * a full disk — the other applications' files are still worth putting
       * out, and the one that did not land is worth saying out loud, because
       * the alternative is a portal upload that quietly attaches yesterday's
       * resume.
       */
      const said = err instanceof Error ? err.message : String(err);
      problems.push(`"${name}" could not be put in ${dir}: ${said}`);
    }
  }

  problems.push(...missing);

  const files = landed.sort();
  // And which bundle each one came out of, so the next sync can tell a
  // different application's file from a stale copy of the same one.
  const from = Object.fromEntries(files.map((name) => [name, wanted.get(name)!]));
  try {
    fs.writeFileSync(path.join(dir, MANIFEST), JSON.stringify({ files, from }, null, 2), 'utf8');
  } catch {
    // A folder that cannot hold the manifest still holds the files. The cost
    // is that the next sync will not clean up after this one, which is the
    // side to err on.
  }

  return {
    dir,
    files,
    // What is actually here, not what the tracker says should be: a row whose
    // bundle folder has gone is named in `problems` above rather than counted.
    applications: new Set(files.map((name) => owner.get(name)).filter(Boolean)).size,
    inFlight: apps.filter((a) => IN_FLIGHT.includes(a.status)).length,
    ...(problems.length ? { problems } : {}),
  };
}
