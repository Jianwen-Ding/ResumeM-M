import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { isSnapshotFile, parseSnapshot } from '../src/model/snapshot.js';
import { resolveResume } from '../src/model/resolve.js';
import {
  SAMPLE_BASE,
  SAMPLE_EDUCATION,
  SAMPLE_EXPERIENCE,
  SAMPLE_NEWGRAD,
  SAMPLE_PROJECT,
  SAMPLE_SKILLS,
  makeTempStore,
} from './helpers.js';

const y = (data: unknown) => YAML.stringify(data, { lineWidth: 0 });

/** The store as a set of file contents, the way it comes out of git. */
function files(overrides: Record<string, string> = {}): Map<string, string> {
  return new Map(
    Object.entries({
      'profile.yaml': y({ name: 'Test Person', email: 'test@example.com' }),
      'education.yaml': y([SAMPLE_EDUCATION]),
      'experience.yaml': y([SAMPLE_EXPERIENCE]),
      'projects.yaml': y([SAMPLE_PROJECT]),
      'skills.yaml': y(SAMPLE_SKILLS),
      'resumes/base.yaml': y(SAMPLE_BASE),
      'resumes/newgrad.yaml': y(SAMPLE_NEWGRAD),
      ...overrides,
    }),
  );
}

describe('isSnapshotFile', () => {
  it('takes the files that decide what a resume says', () => {
    for (const f of ['profile.yaml', 'skills.yaml', 'education.yaml', 'experience.yaml', 'projects.yaml', 'custom.yaml', 'resumes/newgrad.yaml']) {
      expect(isSnapshotFile(f)).toBe(true);
    }
  });

  it('leaves out the files that cannot', () => {
    for (const f of ['applications.yaml', 'answers.yaml', 'config.yaml', 'voice.md', 'letters/2026-01-01-acme.md', 'drafts/x.yaml', 'resumes/nested/x.yaml']) {
      expect(isSnapshotFile(f)).toBe(false);
    }
  });
});

describe('parseSnapshot', () => {
  it('rebuilds enough of the store to resolve a resume', () => {
    const snapshot = parseSnapshot(files());
    expect(snapshot.profile.name).toBe('Test Person');
    expect(snapshot.entries.map((e) => e.id)).toEqual(['edu_neu', 'exp_acme', 'proj_thing']);
    expect(snapshot.skillGroups[0]?.id).toBe('sk_lang');
    expect(snapshot.resumes.map((r) => r.id).sort()).toEqual(['base', 'newgrad']);
  });

  it('resolves to the same document the live store resolves to', () => {
    const t = makeTempStore();
    try {
      const live = resolveResume('newgrad', t.store.load());
      const fromGit = resolveResume('newgrad', { ...t.store.load(), ...parseSnapshot(files()) });
      expect(fromGit.sections).toEqual(live.sections);
      expect(fromGit.label).toBe(live.label);
    } finally {
      t.cleanup();
    }
  });

  it('takes the id from the filename, as the store does', () => {
    const snapshot = parseSnapshot(files({ 'resumes/older.yaml': y({ label: 'No id inside' }) }));
    expect(snapshot.resumes.find((r) => r.id === 'older')?.label).toBe('No id inside');
  });

  it('survives a commit holding unparseable YAML instead of failing the timeline', () => {
    const snapshot = parseSnapshot(files({ 'experience.yaml': 'this: [is: not: valid' }));
    expect(snapshot.entries.map((e) => e.id)).toEqual(['edu_neu', 'proj_thing']);
    expect(snapshot.resumes).toHaveLength(2);
  });

  it('falls back to empty content for files a commit did not have yet', () => {
    const snapshot = parseSnapshot(new Map([['resumes/base.yaml', y(SAMPLE_BASE)]]));
    expect(snapshot.entries).toEqual([]);
    expect(snapshot.skillGroups).toEqual([]);
    expect(snapshot.profile.name).toBe('Your Name');
  });
});
