import YAML from 'yaml';
import { normalizeEntries, normalizeProfile, normalizeSkillGroups } from './normalize.js';
import { PLACEHOLDER_NAME } from './resolve.js';
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
  if (!text?.trim()) return fallback;
  try {
    const value = YAML.parse(text) ?? fallback;
    return (shaped && !shaped(value) ? fallback : value) as T;
  } catch {
    // A commit mid-edit can hold unparseable YAML. That is a gap in the
    // history, not a reason to fail the whole timeline.
    return fallback;
  }
}

const isList = (v: unknown): boolean => Array.isArray(v);
const isRecord = (v: unknown): boolean => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/**
 * Build a snapshot from store-relative paths to file contents. Mirrors
 * `Store.load()`'s file layout — the one place the two must agree.
 */
export function parseSnapshot(files: Map<string, string>): StoreSnapshot {
  const entries: Entry[] = [];
  for (const name of ENTRY_FILES) entries.push(...parse<Entry[]>(files.get(name), [], isList));

  const resumes: ResumeSpec[] = [];
  for (const [file, text] of files) {
    if (!/^resumes\/[^/]+\.ya?ml$/.test(file)) continue;
    const spec = parse<ResumeSpec | undefined>(text, undefined, isRecord);
    if (!spec) continue;
    // Filename is the source of truth for the id, exactly as on disk — where
    // it now actually is. Both places said this and then preferred the id
    // written inside the file, so a hand-copied resume file appeared twice
    // under one id and the history for the real one came back empty.
    resumes.push({ ...spec, id: file.replace(/^resumes\//, '').replace(/\.ya?ml$/, '') });
  }

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
    profile: normalizeProfile(parse<Profile>(files.get('profile.yaml'), { name: PLACEHOLDER_NAME }, isRecord)),
    entries: normalizeEntries(entries),
    /*
     * And the skill groups, for the same reason the profile is. A group with
     * no `items:` key crashes the renderer on `g.items.length`, and an old
     * commit is where a half-written file is most likely to be found — which
     * would turn one bad revision into a timeline that cannot be opened at all
     * rather than one entry in it that cannot be resolved.
     */
    skillGroups: normalizeSkillGroups(parse<SkillGroup[]>(files.get('skills.yaml'), [], isList)),
    resumes,
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
