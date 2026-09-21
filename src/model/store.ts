import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { flattenResumes, needsFlattening } from './flatten.js';
import { entryLosesIds, findMovedWordings, forgetMissing, indexStore, skillsLoseIds } from './forget.js';
import { liftLayout } from './lift-layout.js';
import { needsTiering, tierResumes } from './tiers.js';
import { adoptBulletOrder, adoptDateOrder, PLACEHOLDER_NAME } from './resolve.js';
import {
  DEFAULT_CONFIG,
  type AnswerBankItem,
  type Application,
  type CoverLetter,
  type Draft,
  type Entry,
  type Profile,
  type ResumeSpec,
  type SkillGroup,
  type StandingDocument,
  type WritingSample,
  type StoreConfig,
  type StoreData,
} from './types.js';

// It lives with the presets, which are what it repairs a config back towards,
// and is re-exported here because this is where config is read.
import { applyModelAndEffort, applyResearch, repairAiArgs } from '../ai/presets.js';
import {
  normalizeAnswers,
  normalizeApplications,
  normalizeEntry,
  normalizeProfile,
  normalizeSkillGroups,
} from './normalize.js';
export { repairAiArgs };

/** What a value turned out to be, in words, for a message about a file. */
function describeValue(v: unknown): string {
  if (Array.isArray(v)) return 'a list';
  if (v === null) return 'empty';
  switch (typeof v) {
    case 'string':
      return 'a single piece of text';
    case 'number':
      return 'a number';
    case 'boolean':
      return 'true or false';
    default:
      return 'a set of keys and values';
  }
}

/**
 * Take a file out of the save, and say something useful when it will not go.
 *
 * `fs.unlinkSync` throws `EACCES: permission denied, unlink '/home/…/resumes/
 * summer-intern.yaml'`, which reaches the user through the API's error
 * handler exactly as written. It names a path they did not ask about and a
 * code they have no reason to know, and it does not say which of their
 * documents it was talking about — on a delete, that is the only question.
 *
 * The common causes get a sentence. Anything else keeps the system's own
 * words, because a rare errno said plainly is more use than a guess.
 */
export function removeFile(full: string, what: string): void {
  if (!fs.existsSync(full)) return;
  try {
    fs.unlinkSync(full);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    const said = err instanceof Error ? err.message : String(err);
    const because =
      code === 'EACCES' || code === 'EPERM'
        ? 'the save folder is not writable'
        : code === 'EBUSY'
          ? 'something else on this machine has the file open'
          : code === 'EROFS'
            ? 'the save is on a read-only disk'
            : code === 'EISDIR'
              ? 'there is a folder where that file should be'
              /*
               * Anything else keeps the system's own words, which are more
               * use than a guess — but not the path it puts after them. It
               * names the store's full location, which the person already
               * knows and did not ask about, and it is the half of the
               * message that made the raw version unreadable.
               */
              : said.replace(/,\s*unlink\s+'[^']*'\s*$/, '');
    throw new Error(`${what} could not be removed from the save — ${because}. Nothing else was changed.`);
  }
}

/**
 * Read one file of the store, and say which file it was when it will not read.
 *
 * Two failures, both of which happen on the day somebody first imports files
 * they wrote or generated elsewhere, and both of which used to end somewhere
 * unhelpful.
 *
 * The first is YAML that does not parse. `YAML.parse` throws "Flow sequence in
 * block collection must be sufficiently indented and end with a ] at line 2,
 * column 1" — accurate, and useless, because a store is ten YAML files at its
 * root plus a folder of resumes, a folder of drafts, a folder of letters and a
 * corpus, and that message names none of them. The parser's own complaint is
 * kept, because the line and column are the useful half; the file's name is put
 * in front of it, because "which file?" is the only question anybody has here.
 *
 * The second is a file that parses into the wrong shape, and it was the worse
 * of the two because it was silent. `applications.yaml` written as a mapping of
 * id to application — an entirely reasonable thing for a person or a script to
 * produce — parsed fine, failed `Array.isArray` inside `normalizeApplications`,
 * and came back as `[]`. The tracker was empty, nothing was raised, and the
 * next save wrote that empty list over the file: a year of applications gone,
 * silently, in two steps. `profile.yaml` holding a bare line of text failed the
 * other way — `{...'A Name'}` spreads a string into `{0:'A', 1:' ', 2:'N'…}`,
 * so the profile became a numbered map of single characters.
 *
 * So a file that is there, has content, and is not the shape this store keeps
 * in it is refused by name. Refusing costs a minute of somebody's afternoon;
 * the alternative cost them the afternoon's data and did not say so.
 *
 * Which shape is allowed comes from the empty value the caller would accept
 * instead: every file here is either a list of things (`experience.yaml`,
 * `applications.yaml`) or one object (`profile.yaml`, `config.yaml`), and the
 * fallback already says which — so there is no second argument to keep in step
 * with the first.
 *
 * An empty file, and a file holding only `---`, are not malformed. They are a
 * file somebody made and has not filled in yet, and they stay the empty thing
 * they are.
 */
export function parseStoreYaml<T>(label: string, raw: string, fallback: T): T {
  if (!raw.trim()) return fallback;

  let parsed: unknown;
  try {
    parsed = YAML.parse(raw);
  } catch (err) {
    // The first line only: the rest is a code frame repeating the file back at
    // you, which is noise in a dialog box. The colon it ends with introduced
    // that frame and now introduces nothing.
    const said = (err instanceof Error ? err.message : String(err)).split('\n')[0]!.trim().replace(/:$/, '');
    throw new Error(`${label} is not valid YAML — ${said}`);
  }

  if (parsed === null || parsed === undefined) return fallback;

  const wantList = Array.isArray(fallback);
  if (typeof parsed !== 'object' || Array.isArray(parsed) !== wantList) {
    throw new Error(
      `${label} should be ${wantList ? 'a list' : 'a set of keys and values'}, and it is ${describeValue(parsed)}. ` +
        'Nothing has been changed — fix the file, or move it aside, and try again.',
    );
  }
  return parsed as T;
}

/**
 * A file already in this folder whose name differs from `full` only in case.
 *
 * Deliberately only the same folder, and only on an exact case-insensitive
 * match: this is asking the narrow question "would these two be one file on a
 * Mac", not the broad one "are these names similar".
 */
function siblingDifferingOnlyInCase(full: string): string | undefined {
  const name = path.basename(full);
  let siblings: string[];
  try {
    siblings = fs.readdirSync(path.dirname(full));
  } catch {
    // No folder yet, so nothing to clash with. Anything else that stops the
    // listing will stop the write a line later, where it is reported properly.
    return undefined;
  }
  return siblings.find((other) => other !== name && other.toLowerCase() === name.toLowerCase());
}

/**
 * Make the rename itself durable, not only the bytes it points at.
 *
 * The write above fsyncs the temp file, so a power cut can never leave the
 * name pointing at half a resume. But the rename is a change to the
 * *directory*, and that is a separate thing to get onto the disk: on ext4 with
 * the usual mount options the entry can still be in flight for a few seconds
 * after `renameSync` returns. Lose power in that window and the save comes
 * back as it was before the edit — the data perfectly intact somewhere the
 * directory no longer mentions.
 *
 * The narrow catch is the point, and it is worth being explicit about why it
 * is not the usual silent one. Opening a directory for reading is a POSIX
 * thing; Windows refuses it outright, and some filesystems refuse to fsync one
 * even where it opens. Those are answers about the platform, not about this
 * save, and there is nothing a person could do about them — whereas anything
 * else here is a real failure and is left to the caller, who reports it
 * against the file being written.
 *
 * It costs one fsync per save. Everything this writes is a document somebody
 * has just typed, so the trade — a few milliseconds against losing the edit —
 * only goes one way.
 */
function fsyncDirectory(dir: string): void {
  let fd: number | undefined;
  try {
    fd = fs.openSync(dir, 'r');
    fs.fsyncSync(fd);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    // The platform does not do this. Every other errno is the caller's news.
    if (!['EPERM', 'EINVAL', 'EISDIR', 'EACCES', 'ENOTSUP', 'EBADF'].includes(code ?? '')) throw err;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Closing a descriptor that fsync already rejected; nothing is owed.
      }
    }
  }
}

/**
 * Split a markdown file into its YAML header and the prose under it.
 *
 * The line endings are the whole reason this is a named function rather than a
 * regex sitting in two places. It required `---\n` exactly, so a letter with
 * CRLF endings — which is what anything saved out of Word, out of a Windows
 * editor, or downloaded through a browser gives you — matched nothing at all.
 * The entire file including both `---` fences became the body, the title fell
 * back to the filename, and the date and the company were simply gone. Saving
 * that letter then wrote a *second* header above the first, so the body opened
 * with a horizontal rule and a stanza of stale metadata, and every later read
 * saw the new header and the old one as prose.
 *
 * Trailing spaces after a fence are allowed for the same reason: they are
 * invisible, and a file that has one is not a file without a header.
 */
function splitFrontMatter(raw: string): { header: string; body: string } | undefined {
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/.exec(raw);
  return m ? { header: m[1] ?? '', body: m[2] ?? '' } : undefined;
}

/**
 * One segment of a path, checked as the filename it is about to become.
 *
 * Every id in this app is also a filename, and ids arrive from a URL, from a
 * request body the browser extension supplies, and from YAML somebody edited
 * by hand. All three checks live here rather than at the callers, because
 * there are a dozen callers and one of them is always the one that was
 * forgotten.
 *
 * A name that contains a path is not a name. `../config` from the resumes
 * folder overwrites the store's own configuration, whose `ai.command` this
 * application executes — see `Store.file` below, which is where that one was
 * first caught, and `Store.outFile`, which is where it was still open.
 *
 * A name with a null byte in it is refused here so the message is about the
 * name. Node throws on its own further down — "The argument 'path' must be a
 * string, Uint8Array, or URL without null bytes. Received '/…/resumes/a\x00b
 * .yaml.19280d27-….tmp'" — which is accurate, names a temp file the person
 * never typed, and leaves them to work out that their id was the problem.
 *
 * And 255 bytes is the filename limit on ext4, APFS, NTFS and every other
 * filesystem this is likely to meet, so a longer one cannot be written
 * anywhere and should say so in those words rather than as ENAMETOOLONG
 * pointing at a path with a UUID in it.
 */
function assertName(segment: string): void {
  /*
   * `segment === '..'`, and it used to be `segment.split('.').includes('..')`,
   * which can never be true: splitting on `.` cannot leave a `.` in any piece,
   * so the one name this clause was written to refuse was the one name it let
   * through. `outFile('applications', '..')` therefore resolved to the output
   * folder itself — which `outFile`'s own boundary check allows, since the
   * output folder is inside the output folder — and `buildBundle` deletes
   * every loose file in the folder it is about to write into. The id comes off
   * a tracker row, and applications.yaml is hand-editable by design.
   */
  if (segment.includes('/') || segment.includes('\\') || segment === '..') {
    throw new Error('That name is not allowed — a name cannot contain a path.');
  }
  if (segment.includes('\u0000')) {
    throw new Error('That name is not allowed — a name cannot contain a null character.');
  }
  if (Buffer.byteLength(segment, 'utf8') > 255) {
    throw new Error(
      `That name is too long — "${segment.slice(0, 40)}…" comes to ${Buffer.byteLength(segment, 'utf8')} bytes ` +
        'as a filename, and 255 is the most a filesystem will take. Shorten the id.',
    );
  }
}

/** `CON.yaml` and `com1.md` included: the extension does not save them. */
const WINDOWS_DEVICE_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/**
 * Why a filename would survive here and nowhere else, or undefined when it
 * travels.
 *
 * The store is a git repository, and the reason it is one is that it gets
 * cloned: onto the laptop, which is a Mac, and onto the desktop, which is
 * Windows. Linux will hold a file called `Acme: Engineer.yaml`, `why?.yaml`,
 * `CON.yaml` or `ends with a dot..yaml` quite happily. Windows will not create
 * any of them, so `git clone` of that store fails partway through the
 * checkout, with an error naming git and a file, and leaves a save missing
 * exactly the resumes whose names were interesting.
 *
 * A leading dot is in here for a different reason: a store entry written as a
 * hidden file is invisible in Finder, in Explorer and in a plain `ls`, and
 * this folder's own bookkeeping — the temp files below, `.rmm-current.json` —
 * already lives behind that prefix. An empty name is the same failure at its
 * limit: an id of `''` wrote `resumes/.yaml`, which `loadResumes` read, took
 * an empty id from, and dropped — a file that could not be opened, edited or
 * deleted from the app and sat in every commit.
 */
function unportableReason(name: string): string | undefined {
  const stem = name.replace(/\.[^.]*$/, '');
  if (!stem) return 'it has no name in front of the file extension';
  if (stem === '.' || stem === '..') return 'a name of dots is not a name';
  if (name.startsWith('.')) return 'a name beginning with a dot is hidden in every file browser';
  // Control characters included: they are legal on ext4, unprintable in every
  // listing, and rejected outright by Windows.
  const bad = name.match(/[\u0000-\u001f<>:"|?*]/g);
  if (bad) return `Windows will not take ${[...new Set(bad)].map((c) => `"${c}"`).join(', ')} in a filename`;
  if (/[. ]$/.test(stem)) return 'Windows drops a dot or a space from the end of a name';
  if (WINDOWS_DEVICE_NAMES.test(name)) return `"${stem}" is a reserved device name on Windows`;
  return undefined;
}

/**
 * Read one file of a store folder, saying which one when it will not read.
 *
 * `parseStoreYaml` already names the file when the *content* is wrong, and the
 * step before it did not: `readFileSync` on `resumes/acme.yaml` that turns out
 * to be a directory, or that the process cannot open, throws "EISDIR: illegal
 * operation on a directory, read" — which names neither the file nor the
 * resume, arrives from inside `store.load()`, and so presents as the whole
 * application being broken rather than one file in it.
 */
function readStoreFile(full: string, label: string): string {
  try {
    return fs.readFileSync(full, 'utf8');
  } catch (err) {
    const said = err instanceof Error ? err.message : String(err);
    throw new Error(`${label} could not be read (${full}) — ${said}`);
  }
}

/**
 * The name this file has on disk, when that is not quite the name it was asked
 * for.
 *
 * macOS keeps filenames decomposed. A store written on Linux with `géraldine
 * .yaml` — one code point for the é — comes back from `readdir` on a Mac as
 * `e` followed by a combining acute, and no two of those strings compare
 * equal. `loadResumes` takes the id from the filename, so the store then held
 * a resume with an id nothing could look up: the editor answered "No resume",
 * every variation extending it lost its base, and saving from the editor wrote
 * a *second* file whose name lists identically beside the first. On the Mac,
 * where those two names are one file, that second write silently replaced a
 * resume the app had just said did not exist.
 *
 * So a name that is not there is looked for again under Unicode
 * normalisation, and the spelling that is actually on disk wins. Reads find
 * it, writes go back into it rather than beside it, and deletes remove the
 * file that exists rather than reporting success over one that does not.
 *
 * Deliberately not case-folding. `Acme` and `acme` are one file on macOS and
 * Windows and two on Linux, and folding them here would make a save under one
 * name overwrite the other resume on the filesystem where they are genuinely
 * separate — turning a portability problem into data loss on the platform that
 * does not have it.
 */
function onDiskSpelling(full: string): string {
  if (fs.existsSync(full)) return full;
  const dir = path.dirname(full);
  const wanted = path.basename(full).normalize('NFC');
  let siblings: string[];
  try {
    siblings = fs.readdirSync(dir);
  } catch {
    // No folder yet, or not a folder at all. Either way there is nothing on
    // disk to match, and the name asked for is the name to create; whatever is
    // wrong with the folder is reported by the read or write that follows,
    // which knows what it was trying to do.
    return full;
  }
  const found = siblings.find((name) => name.normalize('NFC') === wanted);
  return found === undefined ? full : path.join(dir, found);
}

/**
 * The store is a directory of YAML files under git. It is deliberately dumb:
 * read everything, hand out plain objects, write back whole files. A resume
 * store is a few hundred kilobytes; there is no reason for an index or a
 * database, and plain files mean `git diff` stays readable.
 */
export class Store {
  readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  /**
   * A path inside the store, and never outside it.
   *
   * Ids reach here from URLs and from request bodies, and they end up as
   * filenames — so a resume called `../config` wrote over the store's own
   * configuration, whose `ai.command` this application executes. With the
   * server answering any origin, that was a page you visited being able to run
   * a command on your machine.
   *
   * Checked here rather than at each route because there are a dozen routes and
   * one of them will always be the one that was forgotten. Everything that
   * becomes a file goes through this function.
   */
  private file(...p: string[]): string {
    /*
     * Each segment is one name, never a path. Checking only that the result
     * lands inside the store is not enough: `../config` from the resumes
     * folder stays inside it and overwrites the store's own configuration,
     * whose `ai.command` this application executes.
     */
    for (const segment of p) assertName(segment);
    const full = path.resolve(this.root, ...p);
    // And the belt to that pair of braces, in case a segment ever gets through.
    if (full !== this.root && !full.startsWith(this.root + path.sep)) {
      throw new Error('That name is not allowed — it points outside the save folder.');
    }
    return onDiskSpelling(full);
  }

  /**
   * Parsed files, keyed by what they were when they were parsed.
   *
   * `load()` re-reads and re-parses the whole save on every call, and every
   * API route calls it. Measured on a store the size a year of applying
   * produces: 52ms at ten applications, 102ms at a hundred, 186ms at three
   * hundred, growing about half a millisecond per application. Asking the
   * filesystem what has changed instead costs 2.2ms for nine hundred files —
   * eighty-five times less — so the parse is worth not repeating.
   *
   * Keyed on size and modification time together rather than either alone. A
   * hand edit, a git checkout, a second process writing: all of them move at
   * least one of the two, and `writeAtomic` renames a fresh file into place,
   * which moves both. Nothing here is keyed on this program having been the
   * one to write the file, because most of the interesting edits are not.
   */
  private parsed = new Map<string, { key: string; value: unknown }>();

  /**
   * Read and parse one file, or hand back what it parsed to last time.
   *
   * Everything that reads a file in this class goes through here, which is the
   * only way the saving is worth having: the four whole-file reads are a small
   * part of a real store, and the per-file loaders — a resume, a letter, a
   * writing sample, a draft, each its own file — are most of it and all of the
   * growth.
   *
   * What is kept is the parsed value, not the text: parsing is the cost, and
   * caching the bytes would save the read and pay for the parse again.
   *
   * And a copy of it goes out, never the cached object. Callers treat what
   * they are given as theirs — the loaders spread it into a new shape, and
   * that is a shallow copy, so anything nested stays shared. One route sorting
   * a section in place would then rewrite what the next route reads, with
   * nothing about it looking wrong from either end. Cloning costs a fraction
   * of parsing and removes the question rather than arguing it per caller.
   */
  private cached<T>(full: string, parse: (raw: string) => T, missing: T): T {
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      return missing; // Not there, which is a perfectly ordinary answer.
    }

    /*
     * Size and modification time together, rather than either alone. A hand
     * edit, a git checkout, a restored snapshot, a second process writing:
     * all of them move at least one, and `writeAtomic` renames a fresh file
     * into place, which moves both. Nothing is keyed on this program having
     * been the one to write the file, because most of the interesting edits
     * are not.
     */
    const key = `${stat.size}:${stat.mtimeMs}`;
    const hit = this.parsed.get(full);
    if (hit?.key === key) return structuredClone(hit.value) as T;

    const value = parse(readStoreFile(full, path.relative(this.root, full)));
    this.parsed.set(full, { key, value });
    return structuredClone(value) as T;
  }

  /** A markdown file with a YAML header, read once and kept apart. */
  private cachedFrontMatter(full: string, label: string): { raw: string; split: ReturnType<typeof splitFrontMatter> } {
    return this.cached(
      full,
      (raw) => ({ raw, split: splitFrontMatter(raw) }),
      { raw: '', split: undefined },
    );
  }

  private readYaml<T>(rel: string | string[], fallback: T): T {
    const parts = Array.isArray(rel) ? rel : [rel];
    const f = this.file(...parts);
    return this.cached(f, (raw) => parseStoreYaml(parts.join('/'), raw, fallback), fallback);
  }

  /*
   * Every write lands whole, or not at all.
   *
   * `fs.writeFileSync` opens with O_TRUNC, so for the length of the write the
   * file is observably zero bytes and then partially written. A second process
   * reading it is not hypothetical here — the `rmm` CLI, a second server, a
   * hand edit while the app is up — and the failure is silent in the worst
   * way: a YAML list truncated at an item boundary parses cleanly. Reading
   * applications.yaml during a write returned 130 of 300 applications with no
   * error, and the next save wrote that list back. A crash or a power cut
   * mid-write leaves the same truncated file with nothing to recover from.
   *
   * Write to a temp file, flush it, rename over the target: rename within a
   * directory is atomic, so a reader sees either the old file or the new one.
   * The pattern is already used for projects.json and the asset store; user
   * data deserves it at least as much.
   */
  private writeAtomic(f: string, text: string): void {
    /*
     * A name is judged when it is created, and never afterwards.
     *
     * `unportableReason` above says why a store must not *acquire* a file
     * called `CON.yaml` or `Acme: Engineer.yaml`. It says nothing about one
     * that is already there — from a store written before this check, from a
     * hand edit, from an import — and refusing to write those would mean the
     * app can see a file of the user's, list it, and then decline to save
     * their edit to it. That is the loss this whole layer is trying to avoid,
     * so an existing file is always writable and only a new one is refused.
     */
    if (!fs.existsSync(f)) {
      const reason = unportableReason(path.basename(f));
      if (reason) {
        throw new Error(
          `"${path.basename(f)}" is not a name this save can hold: ${reason}. ` +
            'The save is a git repository meant to be cloned onto other machines, and a name ' +
            'like that stops the clone partway. Choose another id.',
        );
      }
      /*
       * And not a second name that only differs from an existing one in case.
       *
       * Linux keeps `Acme.yaml` and `acme.yaml` apart; macOS and Windows do
       * not. So a store that holds both is a store that cannot be cloned
       * faithfully — on those machines the second checkout overwrites the
       * first, and the resume that loses is simply gone.
       *
       * Refused here, when the second name is created, rather than folded on
       * read. Folding would mean a save under one spelling silently
       * overwriting a genuinely different file on the platform that keeps them
       * apart — turning a portability problem into data loss on the machine
       * that does not have the problem. Refusing costs one rename by somebody
       * who has two ids a letter apart, which is a thing worth being told
       * about anyway.
       *
       * Existing pairs are left alone: both are writable, because this only
       * runs when a name is new.
       */
      const clash = siblingDifferingOnlyInCase(f);
      if (clash) {
        throw new Error(
          `This save already holds "${clash}", and "${path.basename(f)}" differs from it only in ` +
            'capitalisation. macOS and Windows treat those as one file, so a save holding both ' +
            'cannot be cloned onto them without losing one. Choose an id that differs by more than case.',
        );
      }
    }

    fs.mkdirSync(path.dirname(f), { recursive: true });
    /*
     * A fixed-length temp name, in the same directory so the rename is atomic.
     *
     * It used to be the target's own name with `.<uuid>.tmp` after it, which
     * spends 41 of the 255 bytes a filename gets — so a resume whose filename
     * was long and entirely legal, and which loaded and rendered perfectly,
     * could not be saved: ENAMETOOLONG, naming a temp path with a UUID in it,
     * and the edit lost. The temp file exists for the length of one write and
     * nothing reads it by name.
     */
    const temp = path.join(path.dirname(f), `.rmm-${randomUUID()}.tmp`);
    try {
      const fd = fs.openSync(temp, 'w');
      try {
        fs.writeFileSync(fd, text, 'utf8');
        // So a power cut cannot leave the rename pointing at empty bytes.
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(temp, f);
      fsyncDirectory(path.dirname(f));
    } catch (err) {
      fs.rmSync(temp, { force: true });
      /*
       * Named for the file that was being saved, not for the scratch file it
       * was being saved through.
       *
       * Everything that goes wrong here goes wrong on the temp file — a folder
       * that cannot be written to, a full disk, a read-only mount — so the
       * errno arrived as "EACCES: permission denied, open
       * '/…/resumes/.rmm-9f3c….tmp'", a path with a UUID in it that exists for
       * a millisecond and that nobody can act on. The person needs to know
       * which of their files did not save and where it lives; the original
       * complaint is kept after it, because the errno is the diagnosis.
       */
      const said = err instanceof Error ? err.message : String(err);
      throw new Error(`${path.basename(f)} could not be saved to ${path.dirname(f)} — ${said}`, { cause: err });
    }
  }

  private writeYaml(rel: string | string[], data: unknown): void {
    const f = this.file(...(Array.isArray(rel) ? rel : [rel]));
    // lineWidth 0 keeps long bullet text on one line so diffs stay per-bullet
    // instead of reflowing a whole paragraph every time a word changes.
    this.writeAtomic(f, YAML.stringify(data, { lineWidth: 0 }));
  }

  /** Read every file in the store into one object. */
  load(): StoreData {
    const config = this.loadConfig();
    const entries = this.loadEntries();
    return {
      profile: normalizeProfile(this.readYaml<Profile>('profile.yaml', { name: PLACEHOLDER_NAME })),
      // Normalised on the way in, so nothing downstream has to guard against a
      // hand-edited file that left a field without its alternates. See
      // normalize.ts — this is the only place it needs doing.
      entries,
      skillGroups: normalizeSkillGroups(this.readYaml<SkillGroup[]>('skills.yaml', [])),
      /*
       * A section that has never said how it wants to be ordered is asked the
       * one question that can be answered safely — would sorting it change
       * anything? — and takes over its own date order where the answer is no.
       * See `adoptDateOrder`. Nothing is written to disk here: the section is
       * only recorded as date-ordered when the resume is next saved, and a
       * section where sorting *would* move something is left exactly alone for
       * the editor to offer rather than decide.
       */
      /*
       * And the same question about the lines inside an entry — see
       * `adoptBulletOrder`. A resume arranged before the master had a say
       * carries no record of having been arranged, and reading it as
       * deliberate is the only reading that cannot silently restack a
       * document somebody already sent.
       */
      resumes: this.loadResumes().map((resume) =>
        resume.sections
          ? {
              ...resume,
              sections: adoptBulletOrder(adoptDateOrder(resume.sections, entries).adopted, entries),
            }
          : resume,
      ),
      applications: normalizeApplications(this.readYaml<Application[]>('applications.yaml', [])),
      coverLetters: this.loadCoverLetters(),
      drafts: this.loadDrafts(),
      samples: this.loadSamples(),
      answers: normalizeAnswers(this.readYaml<AnswerBankItem[]>('answers.yaml', [])),
      voice: this.loadVoice(),
      config,
    };
  }

  loadConfig(): StoreConfig {
    const raw = this.readYaml<Partial<StoreConfig>>('config.yaml', {});
    const config: StoreConfig = {
      latex: { ...DEFAULT_CONFIG.latex, ...(raw.latex ?? {}) },
      ai: { ...DEFAULT_CONFIG.ai, ...(raw.ai ?? {}) },
      git: { ...DEFAULT_CONFIG.git, ...(raw.git ?? {}) },
      output: { ...DEFAULT_CONFIG.output, ...(raw.output ?? {}) },
      layout: { ...DEFAULT_CONFIG.layout, ...(raw.layout ?? {}) },
      resumes: { ...DEFAULT_CONFIG.resumes, ...(raw.resumes ?? {}) },
    };

    config.ai.args = repairAiArgs(config.ai.command, config.ai.args);
    // The deny list follows the research setting, so the two cannot disagree.
    config.ai.args = applyResearch(config.ai.command, config.ai.args, Boolean(config.ai.research));
    // And the model and effort flags follow their own settings, for the same
    // reason: the saved arguments stay the preset's, and the choice is a
    // setting rather than a hand edit that drifts.
    config.ai.args = applyModelAndEffort(config.ai.command, config.ai.args, {
      model: config.ai.model,
      effort: config.ai.effort,
    });

    // Escape hatches for automated runs. A test suite driving a real server
    // should be able to leave no commits behind without editing config.yaml.
    if (process.env.RMM_AUTOCOMMIT === '0') config.git.autoCommit = false;
    if (process.env.RMM_AI === '0') config.ai.enabled = false;
    if (process.env.RMM_LATEX_ENGINE) {
      config.latex.engine = process.env.RMM_LATEX_ENGINE as StoreConfig['latex']['engine'];
    }
    return config;
  }

  /**
   * Write config.yaml. Only the fields the caller supplies are changed, so a
   * GUI that knows about the AI settings cannot clobber the LaTeX ones.
   */
  saveConfig(patch: Partial<StoreConfig>): StoreConfig {
    const current = this.readYaml<Partial<StoreConfig>>('config.yaml', {});
    const merged: Partial<StoreConfig> = {
      ...current,
      ...(patch.latex ? { latex: { ...current.latex, ...patch.latex } } : {}),
      ...(patch.ai ? { ai: { ...current.ai, ...patch.ai } } : {}),
      ...(patch.git ? { git: { ...current.git, ...patch.git } } : {}),
      ...(patch.output ? { output: { ...current.output, ...patch.output } } : {}),
      /*
       * `fitBounds` merged at its own level, like every block above. Sending
       * one floor would otherwise drop the other two back to this version's
       * defaults, which is a change nobody asked for and would not notice
       * until a resume came out set smaller than they had allowed.
       */
      ...(patch.resumes ? { resumes: { ...current.resumes, ...patch.resumes } } : {}),
      ...(patch.layout
        ? {
            layout: {
              ...current.layout,
              ...patch.layout,
              ...(patch.layout.fitBounds || current.layout?.fitBounds
                ? { fitBounds: { ...current.layout?.fitBounds, ...patch.layout.fitBounds } }
                : {}),
            },
          }
        : {}),
    };
    this.writeYaml('config.yaml', merged);
    return this.loadConfig();
  }

  loadVoice(): string {
    const f = this.file('voice.md');
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
  }

  saveVoice(text: string): void {
    this.writeAtomic(this.file('voice.md'), text);
  }

  /**
   * What is in one of the store's folders, and a sentence about the folder
   * when there is no answer.
   *
   * A folder that is not there yet is not a problem: a store with no letters
   * in it has no `letters/`, and the empty list is the truth. Two other things
   * happen to real people on import day and used to arrive as a raw errno from
   * the middle of `store.load()`, which every page of the app calls:
   *
   * `corpus` as a *file* — an export that wrote one, a note somebody saved
   * next to their store — threw "ENOTDIR: not a directory, scandir '/…/corpus'"
   * and took down the whole application, including the parts that had nothing
   * to do with the corpus. The path was in the message; what it was for, and
   * what to do about it, were not.
   *
   * A folder that cannot be read — wrong owner after a restore from a backup,
   * a mode of 0500 on a copied tree — threw EACCES the same way. Both are
   * still refusals, because the alternative is reporting an empty corpus to
   * somebody who has one and letting the next save write that emptiness back.
   * They just say which folder, and what was expected of it.
   */
  private listing(rel: string, keep: (name: string) => boolean): string[] {
    const dir = this.file(rel);
    let stat: fs.Stats | undefined;
    try {
      // Missing comes back as undefined; a parent that cannot be searched, or
      // a mount that has gone away, still throws — and must, for the reason
      // above.
      stat = fs.statSync(dir, { throwIfNoEntry: false });
    } catch (err) {
      const said = err instanceof Error ? err.message : String(err);
      throw new Error(`The save's "${rel}" folder could not be looked at (${dir}) — ${said}`);
    }
    if (!stat) return [];
    if (!stat.isDirectory()) {
      throw new Error(
        `The save has a file called "${rel}" where it expects a folder (${dir}). ` +
          'Move that file aside and try again — nothing has been changed.',
      );
    }
    try {
      return fs.readdirSync(dir).filter(keep);
    } catch (err) {
      const said = err instanceof Error ? err.message : String(err);
      throw new Error(`The save's "${rel}" folder could not be read (${dir}) — ${said}`);
    }
  }

  /** Resumes live one-per-file so a new variation is a new small file. */
  loadResumes(): ResumeSpec[] {
    /*
     * A save written by a version that had inheritance is folded flat here,
     * on the way in, so nothing past this line has to know that `extends`
     * ever existed.
     *
     * In memory rather than on disk, and on every read rather than once:
     * `migrateResumes` writes the flattened files back and commits them, but
     * it is not the thing that makes this safe. A store can be cloned from a
     * git link, restored from history, or hand-edited between two reads, and
     * any of those can put an `extends` back under a running server. Folding
     * on read means the worst case is a file that still says something the
     * app no longer means, never a resume that resolves to the wrong
     * document.
     */
    /*
     * And a tier, for a save written before there were any. The date stamped
     * on a resume this makes temporary is *this read's* date, which never
     * reaches disk — so a save that has not been written back yet has a clock
     * that restarts on every read and therefore never runs out. That is the
     * right way round: the sweep deletes things, and it should not begin
     * until the save has actually been migrated and the date recorded.
     */
    return tierResumes(flattenResumes(this.loadResumesAsWritten())).tiered;
  }

  /**
   * Fold an older save's inheritance into the files themselves, once.
   *
   * Returns what it changed and what it found wrong, for the caller to log —
   * and nothing at all when the save is already flat, which is the case every
   * time after the first. See `flatten.ts` for why the fold cannot change any
   * document.
   */
  migrateResumes(): { flattened: string[]; tiered: string[]; lifted: string[]; problems: string[] } {
    const all = this.loadResumesAsWritten();
    if (!needsFlattening(all) && !needsTiering(all)) {
      return { flattened: [], tiered: [], lifted: [], problems: [] };
    }

    const problems: string[] = [];
    const flattened: string[] = [];
    const flat = flattenResumes(all, problems);
    const { tiered: withTiers, changed: tiered } = tierResumes(flat);

    /*
     * And a page setting every one of them agrees on goes up to the save.
     *
     * Only on a save actually being migrated, which is why it is inside the
     * guard above rather than run on every start. Folding copied each base's
     * layout down into every resume that had been inheriting it — correct,
     * and it leaves the save-wide setting saying nothing, because every
     * resume overrules it. See `liftLayout`: no document changes, and from
     * then on the number in Settings moves all of them.
     */
    const config = this.loadConfig();
    const { layout, resumes: lightened, keys: lifted } = liftLayout(withTiers, config.layout);
    if (lifted.length > 0) this.saveConfig({ layout });

    for (const spec of lightened) {
      const before = all.find((r) => r.id === spec.id);
      if (before?.extends) flattened.push(spec.id);
      /*
       * One write per resume however many migrations touched it, and none at
       * all for a resume none of them changed.
       *
       * Compared rather than inferred from which pass ran: the layout lift
       * takes a key off some resumes and not others, so "something was
       * lifted" is not the same question as "was this one of them". Writing
       * on the coarser answer put every file in the save into one commit,
       * most of them identical to themselves, which buries the ones that did
       * change in the history somebody would be reading to find them.
       */
      if (JSON.stringify(before) !== JSON.stringify(spec)) this.saveResume(spec);
    }
    return { flattened, tiered, lifted, problems };
  }

  /**
   * The resume files as written, before any migration.
   *
   * Public because the migration needs it and because a test that claims the
   * fold changes no document has to be able to read what was there before.
   * Nothing else should: `loadResumes` is the one that answers "what does
   * this save hold", and this one can hand back a shape the app no longer
   * understands.
   */
  loadResumesAsWritten(): ResumeSpec[] {
    const dir = this.file('resumes');
    return (
      this.listing('resumes', (f) => f.endsWith('.yaml') || f.endsWith('.yml'))
        /*
         * `.yaml` before `.yml`, so a folder holding both spellings of one id
         * is not decided by whatever order the filesystem returned. `saveResume`
         * writes `.yaml`, so `.yaml` is the copy that has been edited; the
         * dedupe below keeps the first of the two it sees.
         */
        .sort((a, b) => a.localeCompare(b))
    )
      .map((f) => {
        const spec = this.cached<Partial<ResumeSpec>>(
          path.join(dir, f),
          (raw) => parseStoreYaml<Partial<ResumeSpec>>(`resumes/${f}`, raw, {}),
          {},
        );
        /*
         * Filename is the source of truth for the id, which the comment here
         * always said and the code did not: it preferred the id written inside
         * the file, so two files could claim one id. Copying resumes/base.yaml
         * to resumes/base-old.yaml — an ordinary thing to do in a folder
         * advertised as hand-editable YAML — made the copy sort first, and from
         * then on it answered every lookup for `base`. Edits went to base.yaml
         * and appeared to be thrown away, every child of `base` resolved
         * through the copy, and the next save wrote the copy's content over the
         * real file.
         *
         * Taken from the name, a copied file is simply its own resume — and
         * normalised, so the id is the same string whichever filesystem last
         * wrote the name. See `onDiskSpelling`: a Mac hands back the é of an
         * accented filename as two code points, and an id nothing can match is
         * a resume nothing can open.
         */
        const id = path.basename(f).replace(/\.ya?ml$/, '').normalize('NFC');
        /*
         * And a name for it, from the same place, when the file does not give
         * one. A resume file that exists and is still empty — created by hand,
         * or copied and not yet filled in — arrived with `label: undefined`,
         * which is the label every picker in the app then showed for it.
         */
        return { ...spec, id, label: String(spec.label ?? id) } satisfies ResumeSpec;
      })
      .filter((r, i, all) => Boolean(r.id) && all.findIndex((o) => o.id === r.id) === i);
  }

  getResume(id: string): ResumeSpec | undefined {
    return this.loadResumes().find((r) => r.id === id);
  }

  saveResume(spec: ResumeSpec): void {
    this.writeYaml(['resumes', `${spec.id}.yaml`], spec);
  }

  /**
   * Deleting a resume takes nothing else with it.
   *
   * This used to be the most dangerous write in the store. Variations were
   * thin — "new grad" was the base plus a handful of choices, recorded as
   * `extends: base` — so unlinking the base left every variation throwing
   * "extends 'base', which does not exist" from that moment on, in the
   * editor, the preview and the tracker alike, with nothing in the UI able to
   * edit `extends` and so no way back but hand-editing YAML. The fix was a
   * rewrite of every child on the way past, which then had to be careful
   * about which of the parent's fields were content and which were identity,
   * and got that wrong too.
   *
   * Resumes stand alone now, so none of that has anything to rewrite — as
   * long as they actually do, which is what the fold below makes sure of.
   *
   * A save can still be sitting on disk in the old shape: folding happens on
   * read, and the write-back is a separate pass that a given process may not
   * have run. Delete the base of an unfolded save and the children lose
   * everything it was contributing, silently — the next read finds nothing to
   * fold and they resolve to their own handful of overrides. So the files are
   * brought up to date first, and only then is one of them removed. It costs
   * one pass over a folder of small files, once, on the first delete after an
   * upgrade.
   */
  deleteResume(id: string): void {
    this.migrateResumes();

    const named = this.loadResumes().find((r) => r.id === id);
    for (const ext of Store.RESUME_SPELLINGS) {
      removeFile(this.file('resumes', `${id}.${ext}`), `"${named?.label ?? id}"`);
    }
  }

  /**
   * Both spellings of a resume's filename. A hand-made `.yml` beside the
   * `.yaml` the app writes would bring a deleted resume back on the next read.
   */
  static readonly RESUME_SPELLINGS = ['yaml', 'yml'] as const;

  /**
   * Where a resume is kept, relative to the store, whether or not it is there.
   *
   * For asking git — the sweep checks that the history has a resume before it
   * deletes one, and git speaks in paths from the root of the repository.
   * Never for opening a file: paths are composed by `file`, one name at a
   * time, and splitting one of these back into segments would hand it
   * `['resumes', '..', 'profile.yaml']`, three names each of which passes the
   * check that `../profile.yaml` fails. The id is checked here anyway, so a
   * path cannot be smuggled into a pathspec either.
   */
  static resumeFiles(id: string): string[] {
    assertName(`${id}.yaml`);
    return Store.RESUME_SPELLINGS.map((ext) => `resumes/${id}.${ext}`);
  }

  /** The four files entries are split across, in the order `load` reads them. */
  private static readonly ENTRY_FILES = [
    'education.yaml',
    'experience.yaml',
    'projects.yaml',
    'custom.yaml',
  ] as const;

  /**
   * Entries are split across files by kind for readability, so writing one back
   * means knowing which file it came from.
   */
  private fileForKind(kind: Entry['kind']): string {
    switch (kind) {
      case 'education':
        return 'education.yaml';
      case 'experience':
        return 'experience.yaml';
      case 'project':
        return 'projects.yaml';
      default:
        return 'custom.yaml';
    }
  }

  /**
   * The four entry files, read into one list holding each id once.
   *
   * This was a plain concatenation of the four, which meant `load()` could hand
   * back two entries with one id — and then the app disagreed with itself about
   * which of them was the entry. `resolveResume` does `entries.find(...)` and
   * got the first; the editor, the inventory and the tailoring prompt iterate
   * the list and got both, so a copied entry was listed twice, counted twice,
   * and rendered from whichever copy happened to sort first.
   *
   * One id, one entry. Where two copies exist, the first in file order wins —
   * the same one `find` was already picking, so nothing that worked before
   * resolves differently — except for the one case where the files themselves
   * say which copy is misfiled. An entry copied into projects.yaml while still
   * saying `kind: experience` belongs to experience.yaml by its own account,
   * and the copy sitting in the file its kind names is the one to believe.
   *
   * What this cannot do is tell a stale copy from a fresh one when both sit in
   * the file their kind names — which is exactly the wreckage `saveEntry` can
   * leave if the second of its two writes fails. Nothing in the content
   * distinguishes them, so that case still falls to file order and the error
   * `saveEntry` threw at the time remains the only notice of it. See the
   * comment there.
   *
   * Entries with no id at all are left alone: they are not duplicates of each
   * other, and folding two of them into one would be exactly the silent loss
   * this is here to prevent.
   */
  private loadEntries(): Entry[] {
    const out: Entry[] = [];
    const at = new Map<string, { index: number; misfiled: boolean }>();

    for (const rel of Store.ENTRY_FILES) {
      for (const raw of this.readYaml<Entry[]>(rel, [])) {
        if (!raw || typeof raw !== 'object') continue;
        const entry = normalizeEntry(raw);
        const misfiled = this.fileForKind(entry.kind) !== rel;

        const seen = entry.id ? at.get(entry.id) : undefined;
        if (!seen) {
          at.set(entry.id, { index: out.push(entry) - 1, misfiled });
        } else if (seen.misfiled && !misfiled) {
          // Replaced where the first copy stood, so the order the four files
          // are read in still decides the order of the list.
          out[seen.index] = entry;
          seen.misfiled = false;
        }
      }
    }

    return out;
  }

  /**
   * An id lives in exactly one of the four files.
   *
   * Splitting entries by kind means changing an entry's kind moves it between
   * files, and writing the new one without removing the old left the same id in
   * two places at once. `load()` concatenates the four files with no dedupe, so
   * the store then held two entries with that id — and `resolveResume` takes
   * the first match, which for education → project is the stale copy. The
   * master document showed the entry as you had just edited it while the PDF
   * you actually sent showed the old title and the old bullets, with nothing
   * anywhere saying so. `deleteEntry` returned at the first file it found a
   * match in, so the twin could not be cleared from the app either.
   */
  saveEntry(entry: Entry): void {
    // Normalised on the way out as well as in, so a bad write from the API
    // never becomes a bad file: reads are already safe, but a file that says
    // something impossible is a trap for whoever opens it next.
    const clean = normalizeEntry(entry);
    const rel = this.fileForKind(clean.kind);

    /*
     * The write that adds it comes first, and the ones that remove the old copy
     * come after.
     *
     * Each file is written atomically, but changing an entry's kind touches
     * two of them and nothing makes the pair atomic. Removing first meant a
     * window — a full disk, an EIO, a crash — in which the entry was in neither
     * file, and `load()` simply concatenates the four: the title, the dates and
     * every phrasing of every bullet, gone, with the error naming the disk
     * rather than the entry. In this order the same failure leaves the entry in
     * both files instead, and the next successful save tidies up.
     *
     * Be clear about what that costs, because the comment here used to claim
     * more than the code did: `loadEntries` hands out one entry per id, but
     * both copies sit in the file their own `kind` names — the fresh one
     * because it was just written there, the stale one because its `kind` was
     * never changed — so nothing in the content says which is which, and file
     * order decides. For a project becoming education the fresh copy wins; for
     * education becoming a project the stale one does. The error thrown from
     * here is the only notice of that, which is why it must not be swallowed
     * by a caller.
     */
    // Read before anything is written, so it is the entry as it stood rather
    // than the one this call is about to put in its place.
    const was = this.loadEntries();
    const before = was.find((e) => e.id === clean.id);

    const list = this.readYaml<Entry[]>(rel, []);
    const idx = list.findIndex((e) => e.id === clean.id);
    if (idx >= 0) list[idx] = clean;
    else list.push(clean);
    this.writeYaml(rel, list);

    for (const other of Store.ENTRY_FILES) {
      if (other === rel) continue;
      const stale = this.readYaml<Entry[]>(other, []);
      const next = stale.filter((e) => e.id !== clean.id);
      if (next.length !== stale.length) this.writeYaml(other, next);
    }

    /*
     * A line, a wording or a list item removed here is removed everywhere.
     *
     * Most saves of an entry add or reword, and those change nothing any
     * resume points at — so the question is asked first and the pass over the
     * resumes only runs for the one kind of write that needs it. See
     * `forget.ts`.
     */
    if (before && entryLosesIds(before, clean)) {
      this.forgetInResumes(was, was.map((e) => (e.id === clean.id ? clean : e)));
    }
  }

  /** Removes the id from every file, not merely the first one holding it. */
  deleteEntry(id: string): boolean {
    const was = this.loadEntries();
    let removed = false;
    for (const rel of Store.ENTRY_FILES) {
      const list = this.readYaml<Entry[]>(rel, []);
      const next = list.filter((e) => e.id !== id);
      if (next.length !== list.length) {
        this.writeYaml(rel, next);
        removed = true;
      }
    }
    // And out of every resume that was showing it. A section listing an entry
    // the store no longer has is not a resume that prints it — it is a resume
    // that complains about it, on every resolve, with no way to say so back.
    if (removed) this.forgetInResumes(was, was.filter((e) => e.id !== id));
    return removed;
  }

  saveSkillGroups(groups: SkillGroup[]): void {
    const before = normalizeSkillGroups(this.readYaml<SkillGroup[]>('skills.yaml', []));
    this.writeYaml('skills.yaml', groups);
    // Dropping a skill from a group, or a whole group, reaches the resumes
    // that had pinned it — same reasoning as entries above.
    if (skillsLoseIds(before, groups)) this.forgetInResumes(undefined, undefined, before, groups);
  }

  /**
   * Take every reference to something the store no longer holds out of the
   * resumes, and say which ones that changed.
   *
   * The new entries and groups are passed in rather than read back, because
   * they were written a moment ago and the read cache is keyed on a file's
   * size and modification time: two writes inside one millisecond that happen
   * to land on the same length would be served the copy from before the
   * delete, and the pass would then prune against a store that no longer
   * exists — which is the one way this could remove something somebody still
   * had.
   *
   * Written through `saveResume` one file at a time, inside whatever commit
   * the delete itself is being made in, so undoing the delete in the version
   * history brings the resumes back with it.
   */
  private forgetInResumes(
    wasEntries?: Entry[],
    nowEntries?: Entry[],
    wasGroups?: SkillGroup[],
    nowGroups?: SkillGroup[],
  ): string[] {
    const entries = this.loadEntries();
    const groups = normalizeSkillGroups(this.readYaml<SkillGroup[]>('skills.yaml', []));
    const before = indexStore(wasEntries ?? entries, wasGroups ?? groups);
    const after = indexStore(nowEntries ?? entries, nowGroups ?? groups);
    // Where a deleted alternate sends the resumes that had pinned it. See
    // `forget.ts`: only alternates move, because only alternates have a
    // nearest surviving version of themselves.
    const moved = findMovedWordings(before, after);

    const changed: string[] = [];
    /*
     * As written, not as resolved.
     *
     * `loadResumes` folds inheritance and stamps a date on anything it has to
     * make temporary, and that date is deliberately never written to disk —
     * see the note on `tierResumes`. Saving what it hands back would write it,
     * and start a one-week clock on resumes nobody has touched.
     */
    for (const spec of this.loadResumesAsWritten()) {
      const next = forgetMissing(spec, after, moved);
      if (JSON.stringify(next) !== JSON.stringify(spec)) {
        this.saveResume(next);
        changed.push(spec.id);
      }
    }
    return changed;
  }

  saveProfile(profile: Profile): void {
    this.writeYaml('profile.yaml', normalizeProfile(profile));
  }

  saveApplications(apps: Application[]): void {
    this.writeYaml('applications.yaml', apps);
  }

  upsertApplication(app: Application): Application[] {
    const apps = normalizeApplications(this.readYaml<Application[]>('applications.yaml', []));
    const idx = apps.findIndex((a) => a.id === app.id);
    if (idx >= 0) apps[idx] = app;
    else apps.push(app);
    this.saveApplications(apps);
    return apps;
  }

  saveAnswers(answers: AnswerBankItem[]): void {
    this.writeYaml('answers.yaml', answers);
  }

  /** Cover letters are markdown files with a YAML front-matter header. */
  loadCoverLetters(): CoverLetter[] {
    const dir = this.file('letters');
    return this.listing('letters', (f) => f.endsWith('.md'))
      .map((f) => {
        const { raw, split } = this.cachedFrontMatter(path.join(dir, f), `letters/${f}`);
        const id = path.basename(f, '.md').normalize('NFC');
        if (!split) {
          return { id, title: id, createdAt: '', body: raw } satisfies CoverLetter;
        }
        const meta = parseStoreYaml<Partial<CoverLetter>>(`letters/${f}`, split.header, {});
        /*
         * The header as it was written, with the fields we know about settled
         * over the top of it.
         *
         * This was rebuilt field by field, and a field missed there was a field
         * deleted: the editor loads a letter and PUTs back exactly what it was
         * given, so anything dropped on the way in is dropped from the file on
         * the way out. It happened to `applicationId` — completing an
         * application tags its letter with the application it belongs to, and
         * opening that letter once untagged it, after which the per-application
         * lookup could never match and the application showed no letter.
         *
         * Listing the fields again would only move the next omission somewhere
         * else, and it would still throw away a key this version has never
         * heard of. A store is hand-editable YAML under git; somebody who adds
         * `sentOn:` or `portal:` to their own letter means it, and a later
         * version of this app may well mean it too. So the header is kept whole
         * and only the four fields that must have a value are settled.
         */
        return {
          ...meta,
          id,
          title: String(meta.title ?? id),
          createdAt: String(meta.createdAt ?? ''),
          body: split.body,
        } satisfies CoverLetter;
      });
  }

  /**
   * Write a cover letter.
   *
   * `voice` is taken from the copy on disk when the letter being written does
   * not state one, because it is a decision *about* the letter rather than a
   * part of it — and every writer here bar one is replacing the letter's
   * text. The Workspace files the letter when the application goes out; the
   * AI files the one it drafted; both mint the id from the company and the
   * day, so re-running either for the same job lands on the same letter.
   * Written literally, saying "this one is not how I write" and then sending
   * that application would quietly say the opposite, with nothing on screen
   * about it and the corpus silently a letter larger.
   *
   * `decidesVoice` is for the one caller that is deciding rather than
   * writing. `POST /voice/include` says "counted again" by taking the key
   * away, so it has to be able to write an absence and mean it.
   */
  saveCoverLetter(letter: CoverLetter, { decidesVoice = false } = {}): void {
    const { body, id, ...meta } = letter;
    if (!decidesVoice && meta.voice === undefined) {
      const stored = this.loadCoverLetters().find((l) => l.id === id)?.voice;
      if (stored !== undefined) meta.voice = stored;
    }
    const dir = this.file('letters');
    fs.mkdirSync(dir, { recursive: true });
    const front = YAML.stringify(meta, { lineWidth: 0 }).trimEnd();
    this.writeAtomic(this.file('letters', `${id}.md`), `---\n${front}\n---\n${body}`);
  }

  /**
   * The writing corpus: markdown files with a front-matter header, the same
   * shape as cover letters, because they are the same kind of thing — your
   * words, kept so they can be read back.
   */
  loadSamples(): WritingSample[] {
    const dir = this.file('corpus');
    return this.listing('corpus', (f) => f.endsWith('.md'))
      .map((f) => {
        const { raw, split } = this.cachedFrontMatter(path.join(dir, f), `corpus/${f}`);
        const id = path.basename(f, '.md').normalize('NFC');
        if (!split) return { id, title: id, kind: 'other' as const, text: raw, createdAt: '' };
        const meta = parseStoreYaml<Partial<WritingSample>>(`corpus/${f}`, split.header, {});
        // Kept whole, for the reason given over the letters above: a sample is
        // a file somebody wrote, and a key this version does not recognise is
        // not a key to delete on their behalf.
        return {
          ...meta,
          id,
          title: String(meta.title ?? id),
          kind: meta.kind ?? 'other',
          createdAt: String(meta.createdAt ?? ''),
          text: split.body,
        } satisfies WritingSample;
      });
  }

  saveSample(sample: WritingSample): void {
    const { text, id, ...meta } = sample;
    const dir = this.file('corpus');
    fs.mkdirSync(dir, { recursive: true });
    const front = YAML.stringify(meta, { lineWidth: 0 }).trimEnd();
    this.writeAtomic(this.file('corpus', `${id}.md`), `---\n${front}\n---\n${text}`);
  }

  deleteSample(id: string): boolean {
    const f = this.file('corpus', `${id}.md`);
    if (!fs.existsSync(f)) return false;
    removeFile(f, 'That writing sample');
    return true;
  }

  /* ------------------------------------------------------------------ *
   * Standing documents                                                  *
   * ------------------------------------------------------------------ */

  /**
   * Files you attach again and again and never generate: a transcript, a
   * portfolio, a writing sample a form asks for as a PDF.
   *
   * Everything else in a save is either text this program composes or text it
   * learns from. These are neither — they arrive finished, from a registrar
   * or a designer, and the only thing wanted of them is to be attached. So
   * they are stored as the bytes they came as, under the names they will be
   * uploaded under, and copied into the flat folder beside the built resume
   * so that one place holds everything a form is going to ask for.
   *
   * Not `assets/`, which is the voice corpus's inbox: material the AI reads.
   * A transcript is not something to write from.
   */
  listDocuments(): StandingDocument[] {
    const dir = this.file('documents');
    return this.listing('documents', (f) => !f.startsWith('.'))
      .map((name) => {
        let bytes = 0;
        let at = '';
        try {
          const stat = fs.statSync(path.join(dir, name));
          bytes = stat.size;
          at = stat.mtime.toISOString();
        } catch {
          // Removed between the listing and the stat. Report it without a
          // size rather than failing the whole list over one file.
        }
        return { name: name.normalize('NFC'), bytes, at };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Where one is on disk, or undefined when the name is not allowed. */
  documentPath(name: string): string | undefined {
    try {
      const f = this.file('documents', name);
      return fs.existsSync(f) ? f : undefined;
    } catch {
      // `file` refuses a name with a path in it. Not there, as far as anything
      // that wants to read it is concerned.
      return undefined;
    }
  }

  /** The bytes of one, or undefined when it is not there. */
  readDocument(name: string): Buffer | undefined {
    const f = this.file('documents', name);
    try {
      return fs.readFileSync(f);
    } catch {
      return undefined;
    }
  }

  /**
   * Keep one, under the name it will be uploaded as.
   *
   * The name is the whole of the interface: a form's reviewer sees it, so
   * "Transcript.pdf" is right and "scan_001 (3).pdf" is not, and renaming is
   * saving it again under the better name. `file` refuses anything with a
   * path in it, as everywhere else.
   */
  saveDocument(name: string, bytes: Buffer): StandingDocument {
    const clean = name.trim().normalize('NFC');
    if (!clean) throw new Error('Give the document a name.');
    const dir = this.file('documents');
    fs.mkdirSync(dir, { recursive: true });
    const f = this.file('documents', clean);
    fs.writeFileSync(f, bytes);
    return { name: clean, bytes: bytes.length, at: new Date().toISOString() };
  }

  deleteDocument(name: string): boolean {
    const f = this.file('documents', name);
    if (!fs.existsSync(f)) return false;
    removeFile(f, `"${name}"`);
    return true;
  }

  /**
   * Applications in progress. One file each, like resumes, so a draft is
   * readable in a diff and easy to delete by hand.
   */
  loadDrafts(): Draft[] {
    const dir = this.file('drafts');
    return this.listing('drafts', (f) => f.endsWith('.yaml'))
      .map((f) => {
        const draft = parseStoreYaml<Partial<Draft>>(
          `drafts/${f}`,
          readStoreFile(path.join(dir, f), `drafts/${f}`),
          {},
        );
        // The filename is the id, the same way it is for resumes, and for the
        // same reason: an id written inside the file meant that copying a draft
        // to `d1-backup.yaml` produced two drafts claiming to be `d1`, and that
        // renaming one left `deleteDraft` unlinking a path that is not there —
        // so discarding it failed and completing it silently left it on the
        // list forever.
        return { ...draft, id: path.basename(f, '.yaml').normalize('NFC') };
      })
      .filter((d): d is Draft => Boolean(d && d.id))
      .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
  }

  getDraft(id: string): Draft | undefined {
    return this.loadDrafts().find((d) => d.id === id);
  }

  saveDraft(draft: Draft): Draft {
    const next = { ...draft, updatedAt: new Date().toISOString() };
    this.writeYaml(['drafts', `${draft.id}.yaml`], next);
    return next;
  }

  deleteDraft(id: string): boolean {
    const f = this.file('drafts', `${id}.yaml`);
    if (!fs.existsSync(f)) return false;
    removeFile(f, 'That draft');
    return true;
  }

  /**
   * Absolute path to the configured output directory, created on demand.
   *
   * `output.dir` is a setting in a hand-editable file, and blank is what a
   * half-finished edit leaves behind. Blank resolved to the *parent of the
   * save* — so `current/` and `applications/` were scattered beside the save
   * folder, and `/pdf/:name`, which serves whatever is in the output
   * directory, was pointed at a directory full of the user's unrelated files.
   * `dir: '.'` with `withinProject` did the same to the save folder itself,
   * which would have put generated PDFs under version control.
   *
   * Neither is a thing anybody means, and neither is worth refusing to start
   * over: the output folder holds only files this app can rebuild, so falling
   * back to `out` inside the save costs a rebuild and loses nothing.
   */
  outDir(): string {
    const output = this.loadConfig().output;
    const asked = String(output.dir ?? '').trim();
    let dir = path.resolve(this.root, output.withinProject ? '.' : '..', asked || 'out');
    if (dir === this.root || this.root.startsWith(dir + path.sep)) dir = path.join(this.root, 'out');
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (err) {
      const said = err instanceof Error ? err.message : String(err);
      throw new Error(
        `The output folder could not be created (${dir}) — ${said}. ` +
          'Change where built files go under Settings → output folder.',
      );
    }
    return dir;
  }

  /**
   * A path inside the output folder, and never outside it.
   *
   * The twin of `file` above, for the same reason and against a worse case.
   * A bundle folder is named after an application id, and that id is not
   * always one this code made: `buildBundle` prefers the id of the tracker row
   * the job already has, which comes out of applications.yaml — hand-editable
   * by design, and written by `POST /api/applications` from a body the browser
   * extension supplies, `id` and all.
   *
   * An id of `../../..` plus a real path therefore chose the bundle folder,
   * and `buildBundle` deletes every file in that folder before it writes. One
   * request from any page in the browser, and a folder of the owner's is
   * emptied. Checked here, where the path is built, because the alternative is
   * remembering to check at each of the callers.
   */
  outFile(...p: string[]): string {
    const out = this.outDir();
    for (const segment of p) assertName(segment);
    const full = path.resolve(out, ...p);
    if (full !== out && !full.startsWith(out + path.sep)) {
      throw new Error('That name is not allowed — it points outside the output folder.');
    }
    return full;
  }

  /**
   * A path the tracker recorded, resolved — or nothing, when it leads out of
   * the output folder.
   *
   * `snapshotDir` is stored relative to the output folder, and everything that
   * reads it walks the folder and copies what it finds: `syncCurrent` copies
   * it into `out/current`, which this app serves over HTTP to any origin that
   * asks. A `snapshotDir` of `../../.ssh` is then a tidy little file server for
   * somebody's keys, and the only thing standing between that and a visited
   * web page was that nothing had written such a value yet — which the id
   * above could do.
   *
   * Undefined rather than a throw: a row pointing somewhere else is one row,
   * and failing the whole sync over it would take down the tab that lists
   * every other application. Nothing of the user's is lost by declining to
   * copy a folder that was never a bundle.
   */
  outPath(rel: string): string | undefined {
    const out = this.outDir();
    if (!rel || rel.includes('\u0000')) return undefined;
    const full = path.resolve(out, rel);
    return full.startsWith(out + path.sep) ? full : undefined;
  }
}
