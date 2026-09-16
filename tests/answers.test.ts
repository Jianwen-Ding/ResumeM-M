import { describe, expect, it } from 'vitest';
import { letterId, matchAnswer, matchAnswers, questionSimilarity, relevantLetters } from '../src/jobs/answers.js';
import type { AnswerBankItem, CoverLetter } from '../src/model/types.js';
import { SAMPLE_ANSWERS } from './helpers.js';

describe('questionSimilarity', () => {
  it('scores an identical question at the top', () => {
    expect(questionSimilarity('Why this role?', 'Why this role?')).toBeCloseTo(1, 5);
  });

  it('scores unrelated questions near zero', () => {
    expect(questionSimilarity('What is your phone number?', 'Describe a distributed system')).toBeLessThan(0.2);
  });

  it('rewards a short stored question contained in a longer page question', () => {
    // Boards pad questions with instructions; the stored question is the core.
    const score = questionSimilarity(
      'Why are you interested in this role at our company? (500 characters max)',
      'Why are you interested in this role?',
    );
    expect(score).toBeGreaterThan(0.6);
  });

  it('ignores filler words', () => {
    expect(questionSimilarity('What is the reason you applied?', 'reason applied')).toBeGreaterThan(0.5);
  });

  it('returns zero when either side has no significant words', () => {
    expect(questionSimilarity('', 'anything')).toBe(0);
    expect(questionSimilarity('the a of', 'anything')).toBe(0);
  });
});

describe('matchAnswer', () => {
  it('finds the stored answer for a question asked again', () => {
    const m = matchAnswer('Why are you interested in this role?', SAMPLE_ANSWERS);
    expect(m.item?.id).toBe('ans_why');
    expect(m.answer).toBe('Because the work is interesting.');
    expect(m.confident).toBe(true);
  });

  it('marks a loose match as not confident, so it gets read first', () => {
    const m = matchAnswer('Tell us what interests you about working here', SAMPLE_ANSWERS);
    if (m.item) expect(m.confident).toBe(false);
  });

  it('returns no item when nothing is close', () => {
    const m = matchAnswer('What is your favourite kind of sandwich?', SAMPLE_ANSWERS);
    expect(m.item).toBeUndefined();
    expect(m.answer).toBeUndefined();
    expect(m.confident).toBe(false);
  });

  it('handles an empty bank', () => {
    const m = matchAnswer('Anything?', []);
    expect(m.item).toBeUndefined();
    expect(m.score).toBe(0);
  });

  it('uses the default variant, not merely the first', () => {
    const bank: AnswerBankItem[] = [
      {
        id: 'a',
        question: 'Do you require sponsorship?',
        default: 'v_yes',
        variants: [
          { id: 'v_no', label: 'No', text: 'No' },
          { id: 'v_yes', label: 'Yes', text: 'Yes' },
        ],
      },
    ];
    expect(matchAnswer('Do you require sponsorship?', bank).answer).toBe('Yes');
  });

  it('respects a custom threshold', () => {
    // A partial overlap: "role" and "sponsorship" each hit one stored question
    // without matching it outright.
    const question = 'What interests you about the sponsorship process?';
    const loose = matchAnswer(question, SAMPLE_ANSWERS, 0.1);
    const strict = matchAnswer(question, SAMPLE_ANSWERS, 0.95);
    expect(loose.item).toBeDefined();
    expect(strict.item).toBeUndefined();
  });

  it('matches a list of questions in order', () => {
    const out = matchAnswers(['Why are you interested in this role?', 'Nonsense question here'], SAMPLE_ANSWERS);
    expect(out).toHaveLength(2);
    expect(out[0]?.item?.id).toBe('ans_why');
    expect(out[1]?.item).toBeUndefined();
  });
});

describe('relevantLetters', () => {
  const letters: CoverLetter[] = [
    { id: 'old-acme', title: 'Old Acme', company: 'Acme', role: 'Intern', createdAt: '2024-01-01T00:00:00Z', body: 'old acme' },
    { id: 'recent-other', title: 'Recent Other', company: 'Other', role: 'Engineer', createdAt: '2026-09-01T00:00:00Z', body: 'recent other' },
    { id: 'mid', title: 'Mid', company: 'Third', role: 'Intern', createdAt: '2025-06-01T00:00:00Z', body: 'mid' },
  ];

  it('puts a letter to the same company first, even when it is old', () => {
    const out = relevantLetters(letters, { company: 'Acme' });
    expect(out[0]?.id).toBe('old-acme');
  });

  it('matches company case-insensitively', () => {
    expect(relevantLetters(letters, { company: 'ACME' })[0]?.id).toBe('old-acme');
  });

  it('falls back to recency when no company matches', () => {
    expect(relevantLetters(letters, { company: 'Nobody' })[0]?.id).toBe('recent-other');
  });

  it('prefers a similar role when the company is unknown', () => {
    const out = relevantLetters(letters, { role: 'Intern' });
    expect(['old-acme', 'mid']).toContain(out[0]?.id);
  });

  it('respects the limit', () => {
    expect(relevantLetters(letters, {}, 2)).toHaveLength(2);
  });

  it('copes with letters that have no dates', () => {
    const undated: CoverLetter[] = [{ id: 'x', title: 'X', createdAt: '', body: 'b' }];
    expect(relevantLetters(undated, {})).toHaveLength(1);
  });
});

describe('letterId', () => {
  it('is readable in a directory listing', () => {
    const id = letterId('Acme Co.', 'Software Engineer Intern', new Date('2026-03-04T00:00:00Z'));
    expect(id).toBe('2026-03-04-acme-co-software-engineer-intern');
  });

  it('copes with a missing company or role', () => {
    expect(letterId(undefined, undefined, new Date('2026-03-04T00:00:00Z'))).toBe('2026-03-04');
  });
});
