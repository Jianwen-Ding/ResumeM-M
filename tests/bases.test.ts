import { describe, expect, it } from 'vitest';
import { baseResumes, byBaseFirst, defaultBaseId } from '../src/model/bases.js';
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

  it('prefers a resume nothing extends over one three levels deep', () => {
    const resumes = [spec('tailored', { extends: 'systems' }), spec('systems')];
    expect(defaultBaseId(resumes)).toBe('systems');
  });

  it('takes whatever is there rather than nothing', () => {
    expect(defaultBaseId([spec('only', { extends: 'gone' })])).toBe('only');
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
