import YAML from 'yaml';
import { normalizeEntries, normalizeProfile, normalizeSkillGroups } from './normalize.js';
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

function parse<T>(text: string | undefined, fallback: T): T {
  if (!text?.trim()) return fallback;
  try {
    return (YAML.parse(text) ?? fallback) as T;
  } catch {
    // A commit mid-edit can hold unparseable YAML. That is a gap in the
    // history, not a reason to fail the whole timeline.
    return fallback;
  }
}

/**
 * Build a snapshot from store-relative paths to file contents. Mirrors
 * `Store.load()`'s file layout — the one place the two must agree.
 */
export function parseSnapshot(files: Map<string, string>): StoreSnapshot {
  const entries: Entry[] = [];
  for (const name of ENTRY_FILES) entries.push(...parse<Entry[]>(files.get(name), []));

  const resumes: ResumeSpec[] = [];
  for (const [file, text] of files) {
    if (!/^resumes\/[^/]+\.ya?ml$/.test(file)) continue;
    const spec = parse<ResumeSpec | undefined>(text, undefined);
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
    profile: normalizeProfile(parse<Profile>(files.get('profile.yaml'), { name: 'Your Name' })),
    entries: normalizeEntries(entries),
    /*
     * And the skill groups, for the same reason the profile is. A group with
     * no `items:` key crashes the renderer on `g.items.length`, and an old
     * commit is where a half-written file is most likely to be found — which
     * would turn one bad revision into a timeline that cannot be opened at all
     * rather than one entry in it that cannot be resolved.
     */
    skillGroups: normalizeSkillGroups(parse<SkillGroup[]>(files.get('skills.yaml'), [])),
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
