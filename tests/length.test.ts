import { describe, expect, it } from 'vitest';
import { letterWordCap, ownLetterLength, statedWordLimit, wordCount } from '../src/ai/length.js';
import type { CoverLetter } from '../src/model/types.js';

const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');
const letter = (n: number, over: Partial<CoverLetter> = {}): CoverLetter => ({
  id: `l${n}`,
  title: 'x',
  body: words(n),
  createdAt: '2026-01-01T00:00:00Z',
  ...over,
});

/*
 * The same reading as the card's word counter, so the number a draft is held
 * to is the one the person sees under the box.
 */
describe('a word limit the question states for itself', () => {
  it('reads the ways forms say it', () => {
    for (const [said, n] of [
      ['Why this role? (150 words or less)', 150],
      ['Describe a project, no more than 200 words.', 200],
      ['Tell us about yourself (250 words max)', 250],
      ['In a 200-word limit, explain…', 200],
      ['Maximum of 300 words.', 300],
      ['Answer in under 100 words', 100],
    ] as const) {
      expect(statedWordLimit(said), said).toBe(n);
    }
  });

  it('and not a number that is not a limit', () => {
    for (const said of ['Why this role?', 'Describe a time you shipped to 200 users.', 'We read 500 applications a week.']) {
      expect(statedWordLimit(said), said).toBeNull();
    }
  });
});

describe('how long the letters they send run', () => {
  it('is the middle of them, in words', () => {
    expect(ownLetterLength({ coverLetters: [letter(100), letter(200), letter(150)] })).toEqual({ median: 150, longest: 200, count: 3 });
    expect(ownLetterLength({ coverLetters: [letter(100), letter(140)] })?.median).toBe(120);
  });

  it('leaves out a note too short to be a letter, and one taken out of their voice', () => {
    expect(ownLetterLength({ coverLetters: [letter(9), letter(500, { voice: false })] })).toBeNull();
    expect(ownLetterLength({ coverLetters: [letter(9), letter(120)] })?.median).toBe(120);
  });

  it('caps a draft a fifth over the longest of theirs, or at 300 words with none', () => {
    expect(letterWordCap({ coverLetters: [letter(100), letter(200)] })).toBe(240);
    expect(letterWordCap({ coverLetters: [] })).toBe(300);
    // Never so tight that a short letter cannot be written at all.
    expect(letterWordCap({ coverLetters: [letter(60)] })).toBe(120);
  });

  it('counts words the way a person would', () => {
    expect(wordCount('  Two  words\n')).toBe(2);
    expect(wordCount('')).toBe(0);
    expect(wordCount(undefined)).toBe(0);
  });
});
