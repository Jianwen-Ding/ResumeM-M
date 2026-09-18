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

/*
 * The questions applicant tracking systems actually ask, in the wordings they
 * actually use.
 *
 * The premise of the bank is that application questions repeat, so the point is
 * whether a stored answer is found again when the next system asks the same
 * thing in its own words — and, just as much, whether it is kept away from a
 * question that merely looks similar. Sponsorship and work authorization are
 * the pair that matters: they share a subject, they have opposite answers, and
 * confusing them puts a false declaration on an application.
 */
describe('the same question, asked by another system', () => {
  const ask = (question: string, stored: string) =>
    matchAnswer(question, [
      { id: 'a', question: stored, variants: [{ id: 'v', text: 'The stored answer.' }], default: 'v' },
    ] as never);

  const reuses = (question: string, stored: string) => Boolean(ask(question, stored).answer);

  it('finds the answer again when the same question comes back word for word', () => {
    for (const question of [
      'Why do you want to work here?',
      'Why us?',
      'Describe a technical project you are proud of.',
      'Will you now or in the future require sponsorship?',
    ]) {
      expect(reuses(question, question), question).toBe(true);
    }
  });

  it('finds it through the wording each system puts round it', () => {
    expect(reuses('Why do you want to work at Acme?', 'Why do you want to work here?')).toBe(true);
    expect(
      reuses(
        'Will you now or in the future require sponsorship for employment visa status?',
        'Will you now or in the future require sponsorship?',
      ),
    ).toBe(true);
    expect(
      reuses('Do you require visa sponsorship now or in the future?', 'Will you now or in the future require sponsorship?'),
    ).toBe(true);
    expect(reuses('Tell us about a project you are proud of.', 'Describe a technical project you are proud of.')).toBe(true);
  });

  it('does not answer a vague question with a specific one', () => {
    /*
     * The raw-word fallback was meant only to let a question made of ordinary
     * words recognise itself. Applied when *either* side emptied out, it made
     * a short all-stop-word question fully "covered" by any longer question
     * containing those words — and coverage is weighted 0.7, so these came
     * back confident, which is not advisory: a confident match is written
     * straight into the draft as the answer.
     */
    expect(reuses('Tell us about you.', 'Tell us about a time you had to learn something quickly.')).toBe(false);
    expect(reuses('How would you describe it?', 'How would you describe your ideal team?')).toBe(false);
    expect(reuses('What do you do?', 'Why do you want to work at this company?')).toBe(false);
  });

  /*
   * The dangerous shape: the stored question is the asked question plus a
   * qualifier, and the qualifier is the whole answer.
   *
   * Coverage was computed over whichever question was shorter, so a stored
   * question that merely *added* words scored 1.0 on it. "Are you legally
   * authorized to work in the United States?" matched a stored "…without
   * sponsorship?" at 0.914 and came back confident — and a confident match is
   * not advisory. It is written into the draft, copied into the bundle and the
   * answers file, and sent. The stored answer was "No. I will require H-1B
   * sponsorship."
   */
  it('does not answer a question with the answer to a narrower one', () => {
    const pairs: [string, string][] = [
      [
        'Are you legally authorized to work in the United States?',
        'Are you legally authorized to work in the United States without sponsorship?',
      ],
      [
        'Have you ever been convicted of a felony?',
        'Have you ever been convicted of a felony or misdemeanor involving theft?',
      ],
      ['Do you hold a security clearance?', 'Do you hold an active TS/SCI security clearance?'],
      ['Are you willing to relocate?', 'Are you willing to relocate at your own expense?'],
    ];

    for (const [asked, stored] of pairs) {
      const m = ask(asked, stored);
      expect(m.confident, `${asked} ⟵ ${stored}`).toBe(false);
    }
  });

  it('still reuses a stored question the form has only padded out', () => {
    // The case the coverage bias exists for, and which must keep working: the
    // stored question says nothing the asked one did not.
    const m = ask(
      'Why are you interested in this role at our company? (500 characters max)',
      'Why are you interested in this role?',
    );
    expect(m.answer).toBeTruthy();
    expect(m.confident).toBe(true);
  });

  it('keeps sponsorship and work authorization apart, which have opposite answers', () => {
    expect(reuses('Are you legally authorized to work in the United States?', 'Will you now or in the future require sponsorship?')).toBe(false);
    expect(reuses('Will you now or in the future require sponsorship?', 'Are you legally authorized to work in the United States?')).toBe(false);
  });

  it('does not answer a question it has never been asked', () => {
    expect(reuses('What are your salary expectations?', 'Why do you want to work here?')).toBe(false);
    expect(reuses('Describe a time you failed.', 'Describe a technical project you are proud of.')).toBe(false);
  });

  it('only calls it confident when the question is near enough to send as-is', () => {
    expect(ask('Why do you want to work here?', 'Why do you want to work here?').confident).toBe(true);
    // Matched, so it is offered — but the company is named in one and not the
    // other, which is exactly the sort of thing to read before sending.
    const loose = ask('Why do you want to work at Acme?', 'Why do you want to work here?');
    expect(loose.answer).toBeTruthy();
    expect(loose.confident).toBe(false);
  });
});

/*
 * An answer that names the last employer, handed to the next one.
 *
 * "Why do you want to work here?" is answered by naming the company, and the
 * bank's whole premise is that the fifteenth time it is asked you start from
 * the fourteenth answer. So the answer written for Acme says Acme — and it
 * was put straight into the box for the next application, badged "answered
 * before", which is exactly the reassurance that stops somebody reading it.
 *
 * The cover letter learned this once already, and was fixed by offering
 * rather than adopting. The bank knows more than the letters did: every
 * variant carries the company it was written for, so the names to look for
 * are the names answers have actually been written for. Nothing is guessed.
 */
describe('an answer written for somebody else', () => {
  const bank: AnswerBankItem[] = [
    {
      id: 'ans_why',
      question: 'Why do you want to work here?',
      default: 'v_acme',
      variants: [
        { id: 'v_acme', label: 'Acme', text: 'Acme has been building the same pipelines I care about for a decade.' },
        { id: 'v_streamly', label: 'Streamly', text: 'Streamly runs the streaming infrastructure I want to learn on.' },
      ],
    },
    {
      id: 'ans_strength',
      question: 'What is your greatest strength?',
      default: 'v_1',
      variants: [{ id: 'v_1', label: 'Acme', text: 'Reading somebody else code before rewriting it.' }],
    },
  ];

  it('says whose name is in it, and refuses to call it safe to reuse', () => {
    const m = matchAnswer('Why do you want to work here?', bank, { company: 'Halcyon' });
    expect(m.namesAnother).toBe('Acme');
    // However exactly the question matches: this is the one failure the whole
    // tool exists to prevent.
    expect(m.confident).toBe(false);
    // Still handed over — it is a good starting point, and the caller offers
    // it rather than filling it in.
    expect(m.answer).toContain('Acme');
  });

  it('prefers what you told these people, when you have told them anything', () => {
    const m = matchAnswer('Why do you want to work here?', bank, { company: 'Streamly' });
    expect(m.answer).toContain('Streamly');
    expect(m.namesAnother).toBeUndefined();
    expect(m.confident).toBe(true);
  });

  it('is quiet about an answer that names nobody', () => {
    const m = matchAnswer('What is your greatest strength?', bank, { company: 'Halcyon' });
    expect(m.namesAnother).toBeUndefined();
    expect(m.confident).toBe(true);
  });

  it('only looks for names the bank has actually written answers for', () => {
    // "Reading" is a word in an answer and has never been an employer, so it
    // is never mistaken for one. Nothing here guesses at what a company is.
    const m = matchAnswer('What is your greatest strength?', bank, { company: 'Reading' });
    expect(m.namesAnother).toBeUndefined();
  });

  it('matches a name as a word, not as a fragment', () => {
    const acme: AnswerBankItem[] = [
      {
        id: 'ans_why',
        question: 'Why do you want to work here?',
        default: 'v_1',
        variants: [{ id: 'v_1', label: 'Ace', text: 'Placement here would suit me.' }],
      },
    ];
    // "Ace" is inside "Placement"; a substring is not a mention.
    expect(matchAnswer('Why do you want to work here?', acme, { company: 'Halcyon' }).namesAnother).toBeUndefined();
  });

  it('still takes a bare threshold, the way it always did', () => {
    // A loose question, which clears the default and not a strict one — so
    // the number is doing the work, and the old two-argument calls that pass
    // it positionally still mean what they meant.
    const loose = 'Why are you interested in this particular role at this company?';
    expect(matchAnswer(loose, SAMPLE_ANSWERS).item?.id).toBe('ans_why');
    expect(matchAnswer(loose, SAMPLE_ANSWERS, 0.99).item).toBeUndefined();
    expect(matchAnswers([loose], SAMPLE_ANSWERS, 0.99)[0]?.item).toBeUndefined();
  });
});
