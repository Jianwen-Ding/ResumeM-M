/**
 * The id a tailored copy is saved under, and the rename of the ones that
 * already exist.
 *
 * `tailoredResumeId` says what went wrong: the id was `job-<slug>-<slug>` and
 * `saveResume` writes `resumes/<id>.yaml` over whatever is there, so two
 * postings a slug cannot tell apart shared one file and the second tailoring
 * overwrote the first in silence. `applicationId` learned this lesson first
 * and has `fingerprint`/`faithful` to show for it; this is the same discipline
 * applied to the second thing keyed on a pair of names.
 */
import { describe, expect, it, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { legacyTailoredResumeId, tailoredResumeId } from '../src/model/applications.js';
import { makeTempStore, type TempStore } from './helpers.js';

let t: TempStore;
afterEach(() => t?.cleanup());

describe('the id a tailored copy gets', () => {
  it('leaves a name a slug represents faithfully alone', () => {
    expect(tailoredResumeId('Streamly', 'Data Platform Intern')).toBe('job-streamly-data-platform-intern');
  });

  it('tells apart two titles whose only difference is punctuation', () => {
    // Both are `c-engineer` to a slug. This is the everyday shape of it.
    expect(legacyTailoredResumeId('Acme', 'C++ Engineer')).toBe(legacyTailoredResumeId('Acme', 'C# Engineer'));
    expect(tailoredResumeId('Acme', 'C++ Engineer')).not.toBe(tailoredResumeId('Acme', 'C# Engineer'));
  });

  it('tells apart two postings with no ASCII in them at all', () => {
    // Where `slug` gives up entirely: both halves reduce to nothing, so every
    // such posting used to mint `job--`.
    expect(legacyTailoredResumeId('字节跳动', '软件工程师')).toBe('job--');
    expect(tailoredResumeId('字节跳动', '软件工程师')).not.toBe(tailoredResumeId('阿里巴巴', '后端工程师'));
    // And the empty halves do not leave a row of dashes behind.
    expect(tailoredResumeId('字节跳动', '软件工程师')).toMatch(/^job-[0-9a-f]{8}$/);
  });

  /*
   * The third way, and the one `faithful` alone does not catch: it measures
   * each name separately and the cut happens after they are joined. Two roles
   * under sixty characters each can still cut to the same id.
   */
  it('tells apart two long titles that cut to the same length', () => {
    const a = 'Senior Staff Software Engineer, Distributed Systems Platform Group';
    const b = 'Senior Staff Software Engineer, Distributed Systems Storage Group';
    expect(legacyTailoredResumeId('Acme', a)).toBe(legacyTailoredResumeId('Acme', b));
    expect(tailoredResumeId('Acme', a)).not.toBe(tailoredResumeId('Acme', b));
  });

  it('is the same id every time it is asked', () => {
    expect(tailoredResumeId('字节跳动', '软件工程师')).toBe(tailoredResumeId('字节跳动', '软件工程师'));
  });
});

/** A save written before the ids could tell two postings apart. */
function saveWithOldIds(): TempStore {
  const store = makeTempStore();
  const dir = store.dir;
  const write = (rel: string, data: unknown) =>
    fs.writeFileSync(path.join(dir, rel), YAML.stringify(data, { lineWidth: 0 }), 'utf8');

  write('resumes/job-acme-c-engineer.yaml', {
    id: 'job-acme-c-engineer',
    label: 'C++ Engineer — Acme',
    copiedFrom: 'base',
    tier: 'temporary',
    generatedFor: { company: 'Acme', role: 'C++ Engineer', at: '2026-09-01T00:00:00.000Z' },
  });
  // A copy of that copy, so the provenance link has somewhere to go wrong.
  write('resumes/job-acme-c-engineer-v2.yaml', {
    id: 'job-acme-c-engineer-v2',
    label: 'A second go',
    copiedFrom: 'job-acme-c-engineer',
    tier: 'temporary',
  });
  write('applications.yaml', [
    {
      id: '2026-09-01-acme-c-engineer',
      company: 'Acme',
      role: 'C++ Engineer',
      status: 'applying',
      resumeId: 'job-acme-c-engineer',
      createdAt: '2026-09-01T00:00:00.000Z',
    },
  ]);
  fs.mkdirSync(path.join(dir, 'drafts'), { recursive: true });
  write('drafts/d1.yaml', {
    id: 'd1',
    company: 'Acme',
    role: 'C++ Engineer',
    resumeId: 'job-acme-c-engineer',
    updatedAt: '2026-09-01T00:00:00.000Z',
  });
  return store;
}

describe('renaming the tailored copies a save already holds', () => {
  it('moves the file to the id that can tell two postings apart', () => {
    t = saveWithOldIds();
    const want = tailoredResumeId('Acme', 'C++ Engineer');

    const { renamed } = t.store.migrateTailoredIds();
    expect(renamed).toEqual([{ from: 'job-acme-c-engineer', to: want }]);

    const dir = path.join(t.dir, 'resumes');
    expect(fs.existsSync(path.join(dir, `${want}.yaml`))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'job-acme-c-engineer.yaml'))).toBe(false);
    // And it is the same document, under the new name.
    expect(t.store.getResume(want)?.label).toBe('C++ Engineer — Acme');
  });

  it('takes everything that names it along', () => {
    t = saveWithOldIds();
    const want = tailoredResumeId('Acme', 'C++ Engineer');
    t.store.migrateTailoredIds();

    expect(t.store.load().applications[0]?.resumeId).toBe(want);
    expect(t.store.getDraft('d1')?.resumeId).toBe(want);
    // Including the copy that recorded it as where it came from.
    expect(t.store.getResume('job-acme-c-engineer-v2')?.copiedFrom).toBe(want);
  });

  /*
   * A resume somebody named themselves is theirs. The predicate is "is this
   * the id the old scheme would have produced for the names it records" — not
   * "does it start with job-" — so a hand-named copy keeps its name.
   */
  it('leaves a resume nobody generated under that name alone', () => {
    t = saveWithOldIds();
    /*
     * Named `job-…` and carrying a `generatedFor` nothing else in the save
     * claims, so neither the prefix nor the presence of the two names is
     * enough to tell it apart. The only thing that does is that the old
     * scheme would have called this `job--`, and it is not called that.
     */
    fs.writeFileSync(
      path.join(t.dir, 'resumes', 'job-my-favourite.yaml'),
      YAML.stringify({
        id: 'job-my-favourite',
        label: 'The one I like',
        generatedFor: { company: '字节跳动', role: '软件工程师', at: '2026-09-01T00:00:00.000Z' },
      }),
      'utf8',
    );

    const { renamed } = t.store.migrateTailoredIds();
    expect(renamed.map((r) => r.from)).not.toContain('job-my-favourite');
    expect(t.store.getResume('job-my-favourite')?.label).toBe('The one I like');
  });

  it('does nothing at all the second time, and nothing on a save that never needed it', () => {
    t = saveWithOldIds();
    t.store.migrateTailoredIds();
    expect(t.store.migrateTailoredIds().renamed).toEqual([]);

    const fresh = makeTempStore();
    try {
      expect(fresh.store.migrateTailoredIds().renamed).toEqual([]);
    } finally {
      fresh.cleanup();
    }
  });
});
