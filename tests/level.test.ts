import { describe, expect, it } from 'vitest';
import { detectLevel } from '../src/jobs/level.js';

describe('reading the level off a posting', () => {
  it('reads an internship off the title', () => {
    expect(detectLevel({ title: 'Software Engineer Intern, Data Platform' })).toMatchObject({
      level: 'intern',
      from: 'title',
    });
  });

  it('reads a new grad role off the title', () => {
    expect(detectLevel({ title: 'Software Engineer, New Grad (2027)' })).toMatchObject({ level: 'newgrad' });
    expect(detectLevel({ title: 'Entry-Level Backend Developer' })).toMatchObject({ level: 'newgrad' });
    expect(detectLevel({ title: 'Graduate Programme — Technology' })).toMatchObject({ level: 'newgrad' });
  });

  it('reads an experienced role off the title', () => {
    expect(detectLevel({ title: 'Senior Software Engineer' })).toMatchObject({ level: 'experienced' });
    expect(detectLevel({ title: 'Staff Engineer, Infrastructure' })).toMatchObject({ level: 'experienced' });
  });

  it('calls an internship an internship even where the body says entry level', () => {
    const verdict = detectLevel({
      title: 'Summer 2027 Software Engineering Intern',
      description: 'This is an entry level position for new grads and students.',
    });
    expect(verdict?.level).toBe('intern');
  });

  /*
   * The false positives that would put an expected-graduation date on a resume
   * sent to a company hiring someone years out of school. All real titles.
   */
  it('does not read "intern" out of a word that merely contains it', () => {
    expect(detectLevel({ title: 'Internal Tools Engineer' })?.level).not.toBe('intern');
    expect(detectLevel({ title: 'International Payments Engineer' })?.level).not.toBe('intern');
    expect(detectLevel({ title: 'Engineer, Internationalization' })?.level).not.toBe('intern');
  });

  it('says nothing about a title that names no level', () => {
    expect(detectLevel({ title: 'Software Engineer' })).toBeNull();
    expect(detectLevel({ title: 'Backend Engineer, Payments' })).toBeNull();
    expect(detectLevel({})).toBeNull();
  });

  it('falls back to the body only when the title is silent', () => {
    expect(
      detectLevel({ title: 'Software Engineer', description: 'Apply to our 2027 internship in Boston.' }),
    ).toMatchObject({ level: 'intern', from: 'description' });
    expect(
      detectLevel({ description: 'We are hiring new graduates for a January start.' }),
    ).toMatchObject({ level: 'newgrad', from: 'description' });
    expect(
      detectLevel({ description: 'You have 5+ years of professional experience shipping services.' }),
    ).toMatchObject({ level: 'experienced', from: 'description' });
  });

  it('refuses to guess when the body says two things at once', () => {
    expect(
      detectLevel({
        title: 'Software Engineer',
        description: 'Our internship and new grad programs both open in September.',
      }),
    ).toBeNull();
  });

  /*
   * "0-2 years of experience" is written *for* people leaving school. Counting
   * it as experience would invert the answer on exactly the postings this
   * feature exists for.
   */
  it('does not read a low years-of-experience floor as an experienced role', () => {
    expect(detectLevel({ description: '0-2 years of experience required.' })).toBeNull();
    expect(detectLevel({ description: '1+ years of experience preferred.' })).toBeNull();
  });

  it('does not take a body mention of leading or mentoring as seniority', () => {
    expect(
      detectLevel({
        title: 'Software Engineer',
        description: 'You will lead projects end to end and mentor junior engineers.',
      }),
    ).toBeNull();
  });

  it('keeps the words it decided on, so a swap can be explained', () => {
    expect(detectLevel({ title: 'Software Engineer Intern' })?.why).toEqual(['intern']);
  });
});
