import { describe, expect, it } from 'vitest';
import { baseForCopy, baseResumes, byBaseFirst, defaultBaseId } from '../src/model/bases.js';
import type { ResumeSpec } from '../src/model/types.js';

const spec = (id: string, extra: Partial<ResumeSpec> = {}): ResumeSpec => ({ id, label: id, ...extra });

describe('which resume you start from', () => {
  it('takes the pinned one, whatever it is called', () => {
    const resumes = [spec('newgrad'), spec('systems', { base: true })];
    expect(defaultBaseId(resumes)).toBe('systems');
  });

  it('falls back to the conventional name for a store that pins nothing', () => {
    expect(defaultBaseId([spec('intern'), spec('newgrad')])).toBe('newgrad');
  });

  /*
   * A store fills up with resumes copied off postings that closed months ago.
   * One somebody actually wrote is a better guess at "where do I start" than
   * the leftovers of an application sent in March, whichever sorted first.
   */
  it('prefers a resume somebody wrote over one copied off a posting', () => {
    const resumes = [spec('tailored', { copiedFrom: 'systems' }), spec('systems')];
    expect(defaultBaseId(resumes)).toBe('systems');
  });

  it('counts a resume the extension generated as one of those leftovers', () => {
    const resumes = [
      spec('job-adobe', { generatedFor: { company: 'Adobe' } }),
      spec('systems'),
    ];
    expect(defaultBaseId(resumes)).toBe('systems');
  });

  it('takes whatever is there rather than nothing', () => {
    expect(defaultBaseId([spec('only', { copiedFrom: 'gone' })])).toBe('only');
    expect(defaultBaseId([])).toBeUndefined();
  });

  it('lists the pinned ones, and says so plainly when there are none', () => {
    expect(baseResumes([spec('a', { base: true }), spec('b')]).map((r) => r.id)).toEqual(['a']);
    expect(baseResumes([spec('a'), spec('b')])).toEqual([]);
  });
});

describe('ordering a picker', () => {
  it('puts the bases first and keeps everything else', () => {
    const resumes = [spec('tailored-1'), spec('systems', { base: true }), spec('tailored-2')];
    expect(byBaseFirst(resumes).map((r) => r.id)).toEqual(['systems', 'tailored-1', 'tailored-2']);
  });

  it('leaves the order alone when nothing is pinned', () => {
    const resumes = [spec('a'), spec('b')];
    expect(byBaseFirst(resumes).map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('does not drop anything', () => {
    const resumes = [spec('a', { base: true }), spec('b'), spec('c', { base: true })];
    expect(byBaseFirst(resumes)).toHaveLength(3);
  });
});

/**
 * The copy an application gets is named after the posting, and it is a thin
 * selection over a base. Apply to the same posting twice and the second pass
 * computes the same name — so if the base it is handed happens to be that
 * first copy, the resume is asked to extend itself and the resolver refuses
 * with "Resume inheritance cycle at …".
 *
 * Easy to arrive at: the copy shows up in the picker like any other resume,
 * the extension remembers whichever was chosen last, and the obvious thing to
 * pick on returning to a posting is the one already named after it.
 */
describe('building a posting’s copy again', () => {
  const adobe = 'job-adobe-2027-intern-software-engineer';

  it('takes what was asked for when it is not the copy itself', () => {
    const resumes = [spec('newgrad'), spec('intern'), spec(adobe, { copiedFrom: 'newgrad' })];
    expect(baseForCopy(resumes, 'intern', adobe)).toBe('intern');
  });

  it('builds from where the copy came from when the copy is what was asked for', () => {
    const resumes = [spec('newgrad'), spec('intern'), spec(adobe, { copiedFrom: 'intern' })];
    expect(baseForCopy(resumes, adobe, adobe)).toBe('intern');
  });

  it('walks the record, because a copy can be a copy of a copy', () => {
    const resumes = [spec('newgrad'), spec(adobe, { copiedFrom: adobe })];
    expect(baseForCopy(resumes, adobe, adobe)).toBe('newgrad');
  });

  /*
   * A parent that has been deleted would otherwise be handed on as the base
   * and fail two lines later as `No resume "…"`, which says nothing about
   * what went wrong or what to do.
   */
  it('falls back to the store’s default when the copy’s source is gone', () => {
    const gone = [spec('newgrad'), spec(adobe, { copiedFrom: 'a-resume-that-is-gone' })];
    expect(baseForCopy(gone, adobe, adobe)).toBe('newgrad');
    // And where it never named one either.
    expect(baseForCopy([spec('newgrad'), spec(adobe)], adobe, adobe)).toBe('newgrad');
  });

  it('never answers with the copy, even in a store that has nothing else', () => {
    expect(baseForCopy([spec(adobe, { copiedFrom: adobe })], adobe, adobe)).toBeUndefined();
  });

  it('still picks a default when nothing was asked for', () => {
    expect(baseForCopy([spec('newgrad'), spec(adobe)], undefined, adobe)).toBe('newgrad');
  });
});
