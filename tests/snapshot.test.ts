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

  /*
   * And to the same document when the lines were dragged, which is the case
   * the one above cannot see.
   *
   * A resume whose bullets are out of the master's order carries no record of
   * having been arranged — nothing could write one before the mark existed —
   * so `Store.load()` asks `adoptBulletOrder` the one-time question, marks
   * those entries `manual`, and `resolveResume` then leaves them exactly as
   * they are. This did not ask, so it sorted them back.
   *
   * Which means version history showed a document that was never sent, the
   * diff between two versions showed bullet moves nobody made, and restoring
   * a version wrote the master's order over an arrangement somebody had
   * proofread. Measured before the fix: the live read `["b_testing",
   * "b_pipeline"]`, the snapshot `["b_pipeline","b_testing"]`.
   *
   * The test above uses the sample resumes, where nothing is dragged, so it
   * passed the whole time this was wrong.
   */
  it('resolves to the same document when the lines were dragged', () => {
    const t = makeTempStore();
    try {
      // The master orders these `b_pipeline, b_testing`; this resume does not.
      const dragged = {
        ...SAMPLE_BASE,
        sections: (SAMPLE_BASE.sections ?? []).map((section) =>
          section.kind === 'experience'
            ? { ...section, bullets: { exp_acme: ['b_testing', 'b_pipeline'] } }
            : section,
        ),
      };
      t.store.saveResume({ ...dragged, id: 'dragged', label: 'Dragged' });

      const live = resolveResume('dragged', t.store.load());
      const fromGit = resolveResume('dragged', {
        ...t.store.load(),
        ...parseSnapshot(files({ 'resumes/dragged.yaml': y({ ...dragged, id: 'dragged', label: 'Dragged' }) })),
      });

      // The entry that was dragged, not every line in the document.
      const lines = (doc: ReturnType<typeof resolveResume>) =>
        doc.sections
          .flatMap((sec) => sec.entries)
          .find((e) => e.id === 'exp_acme')
          ?.bullets.map((b) => b.id) ?? [];
      // The arrangement as written, on both sides.
      expect(lines(live)).toEqual(['b_testing', 'b_pipeline']);
      expect(lines(fromGit)).toEqual(lines(live));
      expect(fromGit.sections).toEqual(live.sections);
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

  /*
   * And valid YAML of the wrong shape, which is the half that got through.
   *
   * The guard above only catches YAML that *throws*. A file the person
   * hand-edited into a mapping — wrapping the list under an `entries:` key is
   * the natural mistake, and this store is advertised as hand-editable —
   * parses perfectly well and then `push(...it)` is a TypeError.
   *
   * That is worse than a gap in the timeline, because the throw escapes:
   * `readSnapshot` is called one line *outside* the try that exists to absorb
   * exactly this, so the whole of Version history 500s. And it keeps doing so
   * after the file is put right, because the bad blob is still in a commit
   * inside the scan window. One save, and the history is gone for good.
   */
  it('survives a commit holding YAML of the wrong shape, not just unparseable YAML', () => {
    for (const wrong of ['entries:\n  - id: e1\n    kind: experience\n    title: X\n', 'just a string', '42']) {
      const snapshot = parseSnapshot(files({ 'experience.yaml': wrong }));
      expect(snapshot.entries.map((e) => e.id)).toEqual(['edu_neu', 'proj_thing']);
      expect(snapshot.resumes).toHaveLength(2);
    }
  });

  it('falls back to empty content for files a commit did not have yet', () => {
    const snapshot = parseSnapshot(new Map([['resumes/base.yaml', y(SAMPLE_BASE)]]));
    expect(snapshot.entries).toEqual([]);
    expect(snapshot.skillGroups).toEqual([]);
    expect(snapshot.profile.name).toBe('Your Name');
  });
});
