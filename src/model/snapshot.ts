import YAML from 'yaml';
import { withoutBom } from './bom.js';
import { normalizeEntries, normalizeProfile, normalizeSections, normalizeSkillGroups } from './normalize.js';
import { adoptBulletOrder, adoptDateOrder, PLACEHOLDER_NAME } from './resolve.js';
import type { Entry, Profile, ResumeSpec, SkillGroup, StoreData } from './types.js';

/**
 * The store as it was at some point in the past, rebuilt from file contents
 * rather than from disk.
 *
 * Version history asks a question the resume's own file cannot answer: "what
 * did this resume say in March?" The file holds choices — which phrasing,
 * which entries — and the phrasings themselves live in `experience.yaml`,
 * `education.yaml`, and the resume it inherits from. Rebuilding all of them
 * together is what lets a version be resolved into the document it produced.
 */

/** Files whose contents feed a resolved resume, in the order Store.load() reads them. */
export const ENTRY_FILES = ['education.yaml', 'experience.yaml', 'projects.yaml', 'custom.yaml'] as const;

/** Enough of a store to resolve a resume: everything else is irrelevant here. */
export type StoreSnapshot = Pick<StoreData, 'profile' | 'entries' | 'skillGroups' | 'resumes'>;

/**
 * One file out of a commit, or the fallback — for any reason at all.
 *
 * The `catch` was the whole of it, which covers YAML that *throws* and
 * nothing else. Valid YAML of the wrong shape sailed through: a file
 * hand-edited into a mapping — wrapping the list under an `entries:` key is
 * the natural mistake, and this store is advertised as hand-editable — parses
 * perfectly well, and then `push(...it)` is a TypeError.
 *
 * That is worse than a gap in the timeline, because the throw escapes.
 * `readSnapshot` is called one line outside the `try` that exists to absorb
 * exactly this, so the whole of Version history fails — and keeps failing
 * after the file is put right, because the bad blob is still in a commit
 * inside the scan window. One save, and the history is gone for good.
 *
 * So the shape is checked as well as the parse. A commit holding something
 * this cannot read is a gap, whichever way it cannot read it.
 */
function parse<T>(text: string | undefined, fallback: T, shaped?: (v: unknown) => boolean): T {
  return settle(parseYaml(text), fallback, shaped);
}

/**
 * What one file's text parsed to, before anybody's fallback is applied.
 *
 * Split from `parse` so that the parsing — which is the whole cost — can be
 * kept by blob id and the fallback and the shape check applied fresh for each
 * commit that holds the blob. `empty` and `failed` both settle to the
 * fallback; they are kept apart only so the record says what happened.
 */
export type ParsedYaml = { kind: 'value'; value: unknown } | { kind: 'empty' } | { kind: 'failed' };

export function parseYaml(text: string | undefined): ParsedYaml {
  if (!text?.trim()) return { kind: 'empty' };
  try {
    return { kind: 'value', value: YAML.parse(withoutBom(text)) };
  } catch {
    // A commit mid-edit can hold unparseable YAML. That is a gap in the
    // history, not a reason to fail the whole timeline.
    return { kind: 'failed' };
  }
}

/**
 * The value a parsed file stands for, given what the reader wants of it.
 *
 * `fresh` hands out a copy. A parse kept by blob id is shared by every commit
 * that holds the blob, and what comes out of here is spread, normalised and
 * sorted on its way into a snapshot — so the second commit would otherwise be
 * reading whatever the first one left behind, the bug the store's own parse
 * cache was written to avoid (see `Store.cached`).
 */
function settle<T>(parsed: ParsedYaml, fallback: T, shaped?: (v: unknown) => boolean, fresh = false): T {
  if (parsed.kind !== 'value') return fallback;
  const value = parsed.value === null || parsed.value === undefined ? fallback : fresh ? structuredClone(parsed.value) : parsed.value;
  return (shaped && !shaped(value) ? fallback : value) as T;
}

const isList = (v: unknown): boolean => Array.isArray(v);
const isRecord = (v: unknown): boolean => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/** One file of a commit, read the way `parse` reads it. */
type Reader = <T>(file: string, fallback: T, shaped?: (v: unknown) => boolean) => T;

const RESUME_FILE = /^resumes\/[^/]+\.ya?ml$/;
const resumeIdOf = (file: string): string => file.replace(/^resumes\//, '').replace(/\.ya?ml$/, '');

/**
 * Which resumes one resume needs to resolve: itself, and every resume its
 * `extends` chain names, however far back.
 *
 * `resolveResume` looks at the resume list for exactly two things — the
 * resume asked for, found by id, and the bases `flattenOne` walks to, found
 * by id the same way — and at nothing else in it. So a snapshot holding only
 * these resolves to the same document as one holding every resume in the
 * commit. That is the difference between parsing three files a commit and
 * parsing three hundred: version history was rebuilding every resume in the
 * save, at every commit in its window, to answer a question about one of them.
 *
 * A save written since inheritance was folded has no `extends` in it and this
 * is the resume alone; an old commit is where a chain is still to be found,
 * and history reads old commits.
 *
 * Asked by the filename, which is where the id comes from — `resumes/<id>.yaml`
 * and `.yml` are the only two names that can hold a given id, and a name that
 * is not a snapshot file (a `/` in the id) holds nothing, as it would not
 * when every file was read.
 */
function resumesNeeded(only: string, paths: ReadonlySet<string>, read: Reader): Set<string> {
  const needed = new Set<string>();
  const queue = [only];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (needed.has(id)) continue;
    needed.add(id);
    for (const file of [`resumes/${id}.yaml`, `resumes/${id}.yml`]) {
      if (!RESUME_FILE.test(file) || !paths.has(file)) continue;
      const base = read<Partial<ResumeSpec> | undefined>(file, undefined, isRecord)?.extends;
      // `walk` compares it with `===` against ids, which are strings; any
      // other value finds nothing there either.
      if (typeof base === 'string') queue.push(base);
    }
  }
  return needed;
}

/**
 * Build a snapshot from store-relative paths to file contents. Mirrors
 * `Store.load()`'s file layout — the one place the two must agree.
 *
 * With `only`, the snapshot holds just the resumes that one resume needs to
 * resolve — see `resumesNeeded` — and resolving that resume against it gives
 * the same document as resolving it against the whole snapshot. Nothing else
 * should be asked of a snapshot made that way.
 */
export function parseSnapshot(files: Map<string, string>, only?: string): StoreSnapshot {
  return assemble([...files.keys()], (file, fallback, shaped) => parse(files.get(file), fallback, shaped), only);
}

/**
 * The same snapshot, read out of one commit's tree a blob at a time.
 *
 * What version history calls, once per commit in its window. Two savings on
 * `parseSnapshot`, and neither changes the answer:
 *
 * - Only what the asked-for resume resolves against is read — the profile,
 *   skills.yaml, the entry files, and the resumes `resumesNeeded` names.
 * - A parse is kept in `parsed`, by blob id. A blob is its content, so an
 *   unchanged experience.yaml across fifty commits is one blob parsed once,
 *   where it used to be read once and then parsed fifty times. Each commit
 *   still gets its own copy; see `settle`.
 *
 * `readBlobs` is handed every blob a round needs at once, so a caller can
 * read them through one git process rather than one each. Undefined when no
 * file in the tree is one a snapshot reads, as `parseSnapshot`'s callers
 * have always treated an empty map.
 */
export async function readSnapshot(
  tree: Map<string, string>,
  readBlobs: (objectIds: string[]) => Promise<Map<string, string>>,
  only: string,
  parsed: Map<string, ParsedYaml>,
): Promise<StoreSnapshot | undefined> {
  const paths = [...tree.keys()].filter(isSnapshotFile);
  if (paths.length === 0) return undefined;
  const present = new Set(paths);

  const fetchParsed = async (files: string[]): Promise<void> => {
    const ids = [...new Set(files.map((f) => tree.get(f)!).filter((id) => !parsed.has(id)))];
    if (ids.length === 0) return;
    const texts = await readBlobs(ids);
    for (const id of ids) parsed.set(id, parseYaml(texts.get(id) ?? ''));
  };

  // A file the round has not fetched yet reads as missing and is noted, so
  // the chain of bases is followed one round per generation.
  let missing: string[] = [];
  const read: Reader = (file, fallback, shaped) => {
    const id = tree.get(file);
    const hit = id === undefined ? undefined : parsed.get(id);
    if (!hit) {
      if (id !== undefined) missing.push(file);
      return fallback;
    }
    return settle(hit, fallback, shaped, true);
  };

  await fetchParsed(paths.filter((f) => !RESUME_FILE.test(f)));
  for (;;) {
    missing = [];
    resumesNeeded(only, present, read);
    if (missing.length === 0) break;
    await fetchParsed(missing);
  }
  return assemble(paths, read, only);
}

function assemble(paths: string[], read: Reader, only?: string): StoreSnapshot {
  const entries: Entry[] = [];
  for (const name of ENTRY_FILES) entries.push(...read<Entry[]>(name, [], isList));

  const needed = only === undefined ? undefined : resumesNeeded(only, new Set(paths), read);
  const resumes: ResumeSpec[] = [];
  for (const file of paths) {
    if (!RESUME_FILE.test(file)) continue;
    const id = resumeIdOf(file);
    if (needed && !needed.has(id)) continue;
    const spec = read<ResumeSpec | undefined>(file, undefined, isRecord);
    if (!spec) continue;
    // Filename is the source of truth for the id, exactly as on disk — where
    // it now actually is. Both places said this and then preferred the id
    // written inside the file, so a hand-copied resume file appeared twice
    // under one id and the history for the real one came back empty.
    // And its sections made walkable, as the live read makes them.
    const sections = normalizeSections(spec.sections);
    resumes.push({ ...spec, id, ...(sections ? { sections } : {}) });
  }

  const entriesNow = normalizeEntries(entries);

  return {
    /*
     * Normalised, like the live read a few lines from here in store.ts.
     * Entries were and the profile was not, which matters most exactly here:
     * history rebuilds from old commits, and an old commit is where a field
     * that lost its `variants:` in a merge is most likely to live. Unnormalised
     * it is not a variant field, so the name renders as "[object Object]" — and
     * the timeline then described a real regression (the name gone from the
     * PDF) as the name having been changed to that.
     */
    profile: normalizeProfile(read<Profile>('profile.yaml', { name: PLACEHOLDER_NAME }, isRecord)),
    entries: entriesNow,
    /*
     * And the skill groups, for the same reason the profile is. A group with
     * no `items:` key crashes the renderer on `g.items.length`, and an old
     * commit is where a half-written file is most likely to be found — which
     * would turn one bad revision into a timeline that cannot be opened at all
     * rather than one entry in it that cannot be resolved.
     */
    skillGroups: normalizeSkillGroups(read<SkillGroup[]>('skills.yaml', [], isList)),
    /*
     * And asked the same one-time questions `Store.load()` asks, because this
     * has to resolve to the same document as the live read or it is not a
     * record of anything.
     *
     * `adoptBulletOrder` is the one that shows. A resume whose lines were
     * dragged out of the master's order carries no record of having been
     * arranged — nothing could write one before it existed — so the live read
     * marks those entries `manual`, and `resolveResume` then leaves them
     * exactly as they are. Without the mark it sorts them back into the
     * master's order.
     *
     * Version history did not ask. Measured on a resume whose section lists
     * `[b2, b1]` against a master ordering them `b1, b2`: the live read
     * resolves `["b2","b1"]` and the snapshot resolved `["b1","b2"]`. So the
     * preview showed a document that was never sent, the diff between two
     * versions showed bullet moves nobody made, and restoring one wrote the
     * master's order back over the arrangement somebody had proofread — which
     * is the exact silent restacking `adoptBulletOrder` exists to refuse.
     *
     * Nothing is written here either; the mark rides on the rebuilt spec and
     * the commit it came from is not touched.
     */
    resumes: resumes.map((resume) =>
      resume.sections
        ? {
            ...resume,
            sections: adoptBulletOrder(adoptDateOrder(resume.sections, entriesNow).adopted, entriesNow),
          }
        : resume,
    ),
  };
}

/** Which files in a tree are worth reading to rebuild a snapshot. */
export function isSnapshotFile(file: string): boolean {
  return (
    file === 'profile.yaml' ||
    file === 'skills.yaml' ||
    (ENTRY_FILES as readonly string[]).includes(file) ||
    /^resumes\/[^/]+\.ya?ml$/.test(file)
  );
}
