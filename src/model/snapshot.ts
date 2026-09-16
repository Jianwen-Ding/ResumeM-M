import YAML from 'yaml';
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
    // Filename is the source of truth for the id, exactly as on disk.
    resumes.push({ ...spec, id: spec.id ?? file.replace(/^resumes\//, '').replace(/\.ya?ml$/, '') });
  }

  return {
    profile: parse<Profile>(files.get('profile.yaml'), { name: 'Your Name' }),
    entries,
    skillGroups: parse<SkillGroup[]>(files.get('skills.yaml'), []),
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
