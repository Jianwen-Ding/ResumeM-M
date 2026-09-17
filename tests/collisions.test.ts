/**
 * Two applications that turn into one.
 *
 * Both of these are silent, and both end with the wrong document in front of
 * an employer — which is the failure this whole tool exists to prevent, so
 * they get their own file.
 */
import { describe, expect, it } from 'vitest';
import { applicationId, bundleFileName, slug } from '../src/model/applications.js';

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
