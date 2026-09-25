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
 * The flat folder as a line for the save's `.gitignore`, where it is inside
 * the save at all.
 *
 * It is rebuilt from the tracker whenever anything changes, so it is nothing
 * to keep a history of — and the rebuilding is what raced the commits. `git
 * add -- .` listed a PDF, the folder was synced under it, and the stat that
 * followed failed the whole add: "unable to stat
 * 'out/current/Jianwen-Ding-Resume.pdf'", twelve times on one test server in
 * a single run, each one a save the version history silently never recorded.
 * The same race `Repo.IGNORED` closes for scratch files, in a folder whose
 * files are replaced far more often.
 *
 * Nothing where the output folder is outside the save, which is the default:
 * there is no history of it to spare.
 */
export function currentIgnore(store: Store): string[] {
  let out: string;
  try {
    out = store.outDir();
  } catch {
    return [];
  }
  const rel = path.relative(store.root, path.join(out, CURRENT_DIR));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return [];
  return [`/${rel.split(path.sep).join('/')}/`];
}

/**
 * The owner recorded for a standing document, which is no application's.
 *
 * `applications` counts the applications whose files are actually here, and a
 * transcript that belongs to every one of them must not add a phantom to that
 * number — "1 application's files are ready" on a save with none in flight.
 */
export const STANDING = '\u0000standing';

/**
 * Recorded as the source of a file whose copy did not happen.
 *
 * A NUL, like `STANDING` above and for the same reason: no path can be this,
 * so a name carrying it is always re-copied and is never mistaken for a file
 * of the user's. An empty string was the obvious choice and does not survive
 * the round trip — `readSources` drops falsy sources on the way back in,
 * because a source is supposed to be a path.
 */
const FAILED = '\u0000failed';

/**
 * A name in this folder that is not ours to write, as opposed to one we could
 * not write this time.
 *
 * The difference decides what the manifest records, and getting it wrong cost
 * the user a file. Every failure went down under `FAILED`, which is right for
 * an `EBUSY` or a full disk — those are ours, and the point of recording them
 * is that the next sync retries. It is exactly wrong for "this belongs to the
 * user": recording that name put it in `from`, so on the next sync it was in
 * `claimed`, so the guard that had just refused to touch it was skipped.
 *
 * Measured: build an application over a file of your own, and the folder
 * correctly says it was left alone — then reload the Applications tab, and it
 * is overwritten with nothing reported. Which is the very failure the guard's
 * own comment says it was written to stop: "the name then went into the
 * manifest, so the *next* sync would have deleted it as ours."
 *
 * So a name refused for this reason is recorded nowhere. Untracked, it is not
 * in `owned`, so the delete loop leaves it; and `cameFrom[name]` stays
 * `undefined`, so the guard fires again and says so again. Saying the same
 * true thing on every sync is the honest answer while nothing has changed.
 */
class NotOurs extends Error {}

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
  /**
   * Which application each file came out of, or `standing` for one of the
   * documents kept in the save to be attached to anything.
   *
   * The folder holds every application in flight at once, which is right for
   * a person looking at it and wrong for a form: attaching another job's
   * resume is the worst thing this could do. So the caller is told whose each
   * file is, and the browser extension offers only the ones that belong to
   * the application in front of it.
   */
  belongsTo: Record<string, string>;
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

/**
 * A manifest entry that names a file in this folder, and nothing else.
 *
 * Every entry on either side of the manifest ends up in `owned`, and `owned`
 * is handed to a recursive delete. The file is ours, and it also sits in a
 * folder the user is invited to open, next to files they are told to keep
 * there; `"../../Documents"` is one hand edit or one bad merge away from
 * `rm -r` on a folder nobody meant.
 *
 * `.` has to be refused beside `..`, and it is the worse of the two:
 * `path.basename('.')` is `'.'`, so it passes a plain-name test, and
 * `path.join(dir, '.')` is the folder itself.
 */
const plainName = (f: unknown): f is string =>
  typeof f === 'string' && f !== '' && f === path.basename(f) && f !== '..' && f !== '.';

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
    return Array.isArray(parsed?.files) ? parsed.files.filter(plainName) : [];
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
 * Filtered by `plainName`, the same as `files`, and for the same reason.
 *
 * This said the filter was not needed here because these are "only ever
 * compared, never opened and never deleted". That stopped being true when
 * `owned` grew to `[...ours, ...Object.keys(cameFrom)]`: the keys reach the
 * very same recursive delete. Measured on a store with one archived bundle, a
 * manifest hand-edited to `"from": {"..": "x"}` took `out/` itself — the
 * archive and the upload folder both — and reported no problem.
 *
 * A path here that means nothing now simply forces a copy, which is the safe
 * way to be wrong, and was the intent all along.
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
      if (plainName(name) && typeof source === 'string' && source) out[name] = source;
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
 * applications apart is added: the role, the company, both, or failing
 * everything the application id. Nothing is added otherwise — the person
 * uploading knows what they are applying to, and a longer name is a worse one.
 *
 * `working` is the one exception, and it is the case that matters most. Added
 * to *all* of them, the suffix reached the application you are uploading right
 * now: with two jobs open, the file the portal showed was
 * `Jianwen-Ding-Resume-2027-Intern-Software-Engineer.pdf` — reported as
 * exactly that, by somebody who had asked for `Jianwen-Ding-Resume.pdf` and
 * whose setting says `type`. Nothing about the other application in the folder
 * is that person's problem at the moment they press upload, and the rule above
 * says so in its own words.
 *
 * The one being worked on keeps the plain name and the rest take the suffix.
 * Every name is still unique: the suffixes are chosen over the whole group, so
 * they tell each other apart, and none of them is empty, so none is the plain
 * name. Without a `working` application — a plain listing of the tracker, with
 * no upload in progress — every one of them is suffixed, as before.
 */
/*
 * But not away from another application still being worked on.
 *
 * "The one being worked on" is one application only when one tab is open.
 * With two applications in progress at once, each staging in turn, the plain
 * name went to whichever staged last: tab A's card said its resume was
 * `First-Last-Resume.pdf`, tab B staged, and the file under that name became
 * B's — with A's card still naming it and the upload dialog over this folder
 * still offering it for A's form. So a name already held by an application
 * touched within `HOLD_MS` stays with it (`heldBy`), and the newcomer takes
 * the suffix. One left alone longer than that hands the name on, which keeps
 * the plain name for the ordinary case of applying to one job after another.
 */
function uniqueNames(
  claims: { name: string; app: Application }[],
  working?: string,
  heldBy: Map<string, string> = new Map(),
): Map<string, string> {
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

    // The plain name goes to the one in hand, unless another in progress
    // already has it. See `working` and `heldBy` above.
    const plainTo = heldBy.get(name) ?? working;
    for (const claim of group) {
      out.set(
        `${claim.app.id} ${name}`,
        claim.app.id === plainTo ? name : `${stem}-${suffix(claim.app)}${ext}`,
      );
    }
  }
  return out;
}

/**
 * Rebuild the flat folder from the tracker. Returns what is in it, so the
 * caller can say where to look.
 */
/**
 * Where the flat upload folder is, without touching what is in it.
 *
 * `syncCurrent` answers this too, and it answers it by rebuilding the folder
 * from the tracker — reading every application, working out which files are
 * still in flight, copying and deleting. That is the right thing to do before
 * somebody attaches a file and much too much to do to put a path on screen.
 *
 * The path is a fixed property of the save. The card needs it from its first
 * paint, on any page, whether or not anything has been built yet: it is what
 * you paste into a portal's upload dialog instead of trudging back through
 * the save folder every time.
 */
/**
 * How long an application keeps the plain name against another one staged
 * after it.
 *
 * Two hours at first, the length of a sitting, and that suffixed the second
 * of any two applications made back to back. Asked for: "I'd rather have
 * plain names more often". Twenty minutes covers two tabs genuinely being
 * worked on at once, which is the mix-up this exists for, and lets the plain
 * name go to whichever posting is in hand the rest of the time.
 */
const HOLD_MS = 20 * 60 * 1000;

/**
 * Whether this application still holds its plain name: heard from within
 * `HOLD_MS`.
 *
 * Sent or not. "Mark as applied" files the application as sent and then says
 * its files are ready to attach — the upload dialog is still ahead — so a
 * rule that let a sent application give the name up at once took it from the
 * one in hand at exactly that moment, and the card listed a suffixed name.
 */
function recentlyTouched(app: Application, now = Date.now()): boolean {
  const last = Math.max(
    Date.parse(app.appliedAt ?? '') || 0,
    ...(app.history ?? []).map((h) => Date.parse(h.at ?? '') || 0),
  );
  return last > 0 && now - last < HOLD_MS;
}

export function currentDir(store: Store): string {
  const dir = path.join(store.outDir(), CURRENT_DIR);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function syncCurrent(
  store: Store,
  applications?: Application[],
  /*
   * The application being worked on, which keeps the plain filename where two
   * would otherwise clash. See `uniqueNames`.
   */
  working?: string,
): CurrentFolder {
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

  /*
   * Which application each plain name was given to last time, where that one
   * is still being worked on: its file is still the one under the name, and
   * the tracker has heard from it within `HOLD_MS`. See `uniqueNames`.
   */
  const lastFrom = readSources(dir);
  const heldBy = new Map<string, string>();
  for (const claim of claims) {
    if (lastFrom[claim.name] === claim.from && recentlyTouched(claim.app)) heldBy.set(claim.name, claim.app.id);
  }
  const renamed = uniqueNames(claims, working, heldBy);
  const wanted = new Map<string, string>(); // final name → where to copy it from
  // And whose it is, so the count at the bottom can be what actually landed
  // rather than what the tracker hoped for.
  const owner = new Map<string, string>(); // final name → application id
  for (const claim of claims) {
    const name = renamed.get(`${claim.app.id} ${claim.name}`) ?? claim.name;
    wanted.set(name, claim.from);
    owner.set(name, claim.app.id);
  }

  /*
   * And the standing documents, which belong to no application and to all of
   * them.
   *
   * A transcript is asked for by a third of the forms anybody fills in and
   * generated by none of them. Keeping it here means the folder this app
   * tells you to point an upload dialog at holds everything that dialog is
   * going to ask for — not the resume and the letter, and then a hunt through
   * the filesystem for the third file.
   *
   * A built file of the same name wins, and does not even warn: the resume
   * this application just produced is more specific than a standing copy of
   * anything, and somebody who has put `Resume.pdf` in `documents/` has said
   * what they want to happen on the applications that build no resume.
   */
  for (const doc of store.listDocuments()) {
    if (wanted.has(doc.name)) continue;
    const from = store.documentPath(doc.name);
    if (!from) continue;
    wanted.set(doc.name, from);
    owner.set(doc.name, STANDING);
  }

  // Anything this folder put here and no longer wants leaves. Only those: a
  // name the manifest does not claim belongs to the user, whatever it is.
  const ours = readManifest(dir);
  const cameFrom = readSources(dir);
  /*
   * Everything this folder owns, which is not the same as everything it is
   * holding correctly: a name whose copy failed is still ours to retry and
   * still ours to delete. See the manifest written at the end.
   */
  const owned = new Set([...ours, ...Object.keys(cameFrom)]);
  /*
   * Whether this folder has a record of what it put here.
   *
   * `readManifest` answers `[]` both for "the manifest lists nothing" and for
   * "there is no manifest", and the copy below has to tell those apart: with
   * a record, a name it does not hold is the user's; without one, nothing can
   * be said about any name and the old behaviour is the only safe one.
   */
  const tracked = fs.existsSync(path.join(dir, MANIFEST));
  const claimed = owned;
  for (const existing of owned) {
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
  /** Names this folder refused because they are the user's. See `NotOurs`. */
  const notOurs = new Set<string>();
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
        /*
         * A plain failure, not a `NotOurs`. A directory with the wanted name
         * reads as the user's, and the comment above says so — but it is also
         * what a copy interrupted halfway can leave behind, and `documents`
         * pins the retry deliberately ("a directory is only the device for
         * making the copy throw on demand"). Ambiguous, so it stays ours to
         * retry. The *file* case below is the unambiguous one.
         */
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
        throw new NotOurs('a file of your own already has that name here, so it was left alone');
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
      if (err instanceof NotOurs) notOurs.add(name);
      problems.push(`"${name}" could not be put in ${dir}: ${said}`);
    }
  }

  problems.push(...missing);

  const files = landed.sort();
  /*
   * And which bundle each one came out of, so the next sync can tell a
   * different application's file from a stale copy of the same one.
   *
   * Including the ones that did not land, which is the part that was wrong.
   * `landed` is pushed to after the copy, so a name whose copy threw was left
   * out of both halves of the manifest — and the next sync, finding the file
   * still on disk with nothing claiming it, read it as a file of the user's
   * and refused to touch it. For ever: never re-copied when the application
   * is rebuilt, never deleted when it ships, and no longer listed for the
   * extension to attach. One `EBUSY` from a PDF open in a viewer, and the
   * upload folder keeps yesterday's resume under exactly the right name while
   * the card shows nothing.
   *
   * Recorded under `FAILED`, so the next sync always re-copies it: it is not
   * a path any bundle can have produced, and it is not `undefined`, which is
   * what the guard reads as "somebody else's".
   *
   * Every failure except the one that is not a failure of ours. A name held
   * by a file of the user's is left out of both halves, so it stays
   * unattributed and the guard refuses it again next time — see `NotOurs`.
   */
  const failed = [...wanted.keys()].filter((name) => !landed.includes(name) && !notOurs.has(name));
  const from = Object.fromEntries([
    ...files.map((name) => [name, wanted.get(name)!]),
    ...failed.map((name) => [name, FAILED]),
  ]);
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
    /*
     * Carrying the sentinel, not flattening it to the word.
     *
     * `STANDING` is a NUL followed by "standing" precisely so that no
     * application id can ever be mistaken for it, and this turned it into the
     * ordinary string "standing" — which an application id can be. The one
     * consumer, `/attachments`, then offers every file of an application
     * called "standing" to every other application: the wrong resume in
     * somebody else's form, which is the single thing that filter exists to
     * prevent. Ids are date-slugs by default, but `POST /api/applications`
     * takes an id from the caller.
     */
    belongsTo: Object.fromEntries(files.map((name) => [name, owner.get(name) ?? ''])),
    // What is actually here, not what the tracker says should be: a row whose
    // bundle folder has gone is named in `problems` above rather than counted.
    applications: new Set(files.map((name) => owner.get(name)).filter((id) => id && id !== STANDING)).size,
    inFlight: apps.filter((a) => IN_FLIGHT.includes(a.status)).length,
    ...(problems.length ? { problems } : {}),
  };
}
