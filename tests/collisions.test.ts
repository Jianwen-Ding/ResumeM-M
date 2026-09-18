/**
 * Two applications that turn into one.
 *
 * Both of these are silent, and both end with the wrong document in front of
 * an employer — which is the failure this whole tool exists to prevent, so
 * they get their own file.
 */
import { describe, expect, it } from 'vitest';
import { applicationId, bundleFileName, slug } from '../src/model/applications.js';
import { resolveResume } from '../src/model/resolve.js';
import type { Entry, ResumeSpec, StoreData } from '../src/model/types.js';

describe('an application id identifies the application', () => {
  const day = new Date('2026-09-16T12:00:00Z');

  it('is readable for the ordinary case', () => {
    expect(applicationId('Acme', 'Platform Engineer', day)).toBe('2026-09-16-acme-platform-engineer');
  });

  it('still tells two applications apart when the names have no ASCII in them', () => {
    // `slug` is ASCII-only, so both of these collapsed to the bare date: one
    // tracker row overwrote the other, and the first application's files were
    // left inside the second's bundle folder.
    const a = applicationId('北京字节跳动', '软件工程师', day);
    const b = applicationId('上海腾讯控股', '数据科学家', day);
    expect(a).not.toBe(b);
    expect(a).not.toBe('2026-09-16');
  });

  it('tells apart two roles whose names are long and share a prefix', () => {
    const long = 'Senior Staff Software Engineer, Platform Infrastructure and Developer';
    expect(applicationId('Acme', `${long} Experience`, day)).not.toBe(
      applicationId('Acme', `${long} Productivity`, day),
    );
  });

  it('is still a name a person can read in a folder listing', () => {
    expect(applicationId('Acme', 'Platform Engineer', day)).toMatch(/^[a-z0-9-]+$/);
  });
});

describe('the file that gets uploaded says who it is for', () => {
  it('keeps a name that is not written in ASCII', () => {
    // "Jane Doe Resume rsted.pdf" went to Ørsted; the CJK case lost the word
    // from the filename altogether, which is also how two applications ended
    // up sharing one name in the upload folder.
    expect(bundleFileName('Jane Doe', 'Ørsted Engineer', 'Resume')).toBe('Jane-Doe-Ørsted-Engineer-Resume.pdf');
    expect(bundleFileName('Zoë Müller', 'Analyst', 'Resume')).toBe('Zoë-Müller-Analyst-Resume.pdf');
    expect(bundleFileName('张伟', '软件工程师', 'Resume')).toBe('张伟-软件工程师-Resume.pdf');
  });

  it('still strips what a filesystem will not take', () => {
    // The separator, the colon and the wildcard go, and what is left is joined
    // by the one separator this scheme uses.
    expect(bundleFileName('Jane Doe', 'A/B: Test*Co', 'Resume')).toBe('Jane-Doe-A-B-Test-Co-Resume.pdf');
  });
});

describe('slug', () => {
  it('stays ASCII, so an id stays typeable and greppable', () => {
    // Deliberate: the readable part of an id is ASCII, and `applicationId`
    // adds a fingerprint when the slug cannot tell two applications apart.
    expect(slug('北京字节跳动')).toBe('');
    expect(slug('Acme Corp!')).toBe('acme-corp');
  });
});

/*
 * Two lines that turn into one.
 *
 * Same shape as the two applications above and the same cost: a chosen
 * wording is recorded as `choices[bulletId]`, with no entry beside it, so two
 * lines carrying the same id share one choice. Picking a wording on one
 * changes the other — silently, whenever the other happens to have a wording
 * by the same name, which two lines minted from the same title usually do.
 *
 * It was reachable from ordinary use. Two roles at the same company, a
 * project and a job with the same name, or two drafts about the same
 * employer: every id the editor and the draft endpoint minted was named after
 * the title, and each checked for collisions only inside the entry it was
 * adding to — which is the one place a collision cannot come from.
 */
describe('two entries that carry a line with the same id', () => {
  const lineIn = (entryId: string, bulletId: string, wordings: { id: string; text: string }[]): Entry => ({
    id: entryId,
    kind: 'experience',
    title: 'Acme',
    bullets: [{ id: bulletId, default: wordings[0]!.id, variants: wordings.map((w) => ({ ...w, label: w.id })) }],
  });

  const dataWith = (entries: Entry[], choices: Record<string, string>) => {
    const spec: ResumeSpec = {
      id: 'r',
      label: 'R',
      choices,
      sections: [{ kind: 'experience', heading: 'Experience', entries: entries.map((e) => e.id) }],
    };
    return {
      spec,
      data: {
        profile: { name: 'A', email: 'a@b.c' },
        entries,
        resumes: [spec],
        skillGroups: [],
        answers: [],
        config: {},
      } as unknown as StoreData,
    };
  };

  it('says so, naming both entries and the line', () => {
    const { spec, data } = dataWith(
      [
        lineIn('exp_acme', 'b_acme_1', [{ id: 'v_base', text: 'Ran the billing migration.' }]),
        lineIn('exp_acme_2', 'b_acme_1', [{ id: 'v_base', text: 'Interned on the data team.' }]),
      ],
      {},
    );
    const said = resolveResume(spec, data).warnings.join(' ');
    expect(said).toContain('b_acme_1');
    expect(said).toContain('exp_acme');
    expect(said).toContain('exp_acme_2');
  });

  it('is quiet when the same entry is simply listed once, as every ordinary store is', () => {
    const { spec, data } = dataWith(
      [
        lineIn('exp_acme', 'b_acme_1', [{ id: 'v_base', text: 'Ran the billing migration.' }]),
        lineIn('exp_other', 'b_other_1', [{ id: 'v_base', text: 'Something else entirely.' }]),
      ],
      {},
    );
    expect(resolveResume(spec, data).warnings).toEqual([]);
  });

  it('is the warning for a real swap: one choice moves both lines', () => {
    // Both lines happen to have a wording called `v_kafka` — which is what
    // makes this silent rather than merely wrong. Choosing it for the first
    // line prints the second line's `v_kafka` too.
    const { spec, data } = dataWith(
      [
        lineIn('exp_acme', 'b_acme_1', [
          { id: 'v_base', text: 'Ran the billing migration.' },
          { id: 'v_kafka', text: 'Built the event pipeline.' },
        ]),
        lineIn('exp_acme_2', 'b_acme_1', [
          { id: 'v_base', text: 'Interned on the data team.' },
          { id: 'v_kafka', text: 'Watched somebody else build a pipeline.' },
        ]),
      ],
      { b_acme_1: 'v_kafka' },
    );
    const out = resolveResume(spec, data);
    const printed = out.sections.flatMap((s) => s.entries.map((e) => e.bullets[0]?.text));
    expect(printed).toEqual(['Built the event pipeline.', 'Watched somebody else build a pipeline.']);
    expect(out.warnings.join(' ')).toContain('picking a wording on either can change the other');
  });
});
