import { describe, expect, it } from 'vitest';
import {
  isSensitiveAnswer,
  isSensitiveQuestion,
  letterId,
  matchAnswer,
  matchAnswers,
  questionSimilarity,
  relevantLetters,
  sameQuestion,
} from '../src/jobs/answers.js';
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

  /*
   * The same failure through a word too short to be looked at.
   *
   * `terms` drops anything of two characters or fewer, so the only word that
   * distinguishes "authorized to work in the US" from "…in the UK" is not in
   * the comparison at all. The two questions are then identical to the
   * matcher: it scores them 1.000 and calls it confident — and confident is
   * not advisory, it is written into the draft unmarked and carried into the
   * bundle by "Complete this application".
   *
   * So a UK or EU form comes back saying the applicant is a US citizen
   * authorized to work in the United States. That is a false declaration
   * about somebody's right to work, made on their behalf and sent unread,
   * which is the exact harm the test above this one was written to stop. It
   * was stopped for long words and left open for short ones.
   */
  it('does not answer about one country with the answer about another', () => {
    for (const [asked, stored] of [
      ['Are you legally authorized to work in the UK?', 'Are you legally authorized to work in the US?'],
      ['Are you legally authorized to work in the EU?', 'Are you legally authorized to work in the US?'],
      ['Are you legally authorized to work in the US?', 'Are you legally authorized to work in the UK?'],
    ] as [string, string][]) {
      expect(ask(asked, stored).confident, `${asked} ⟵ ${stored}`).toBe(false);
    }
  });

  /*
   * Your own company's answers are yours.
   *
   * The bank works out which employers it has written for from the labels on
   * its answers, and refuses to call one safe to send unread when it names a
   * *different* employer. Ask without saying who is asking and the caller is
   * nobody, so every employer in the bank counts as "different" — including
   * the one you are applying to.
   *
   * This was harmless only for as long as nothing labelled its answers with
   * a real company: the extension filed everything as "Saved", so the list of
   * employers was the word "Saved" and the check never fired at all. Teaching
   * the card to send the company made this reachable in the same change, and
   * it points the guard at exactly the answer it should be protecting.
   */
  it('does not call an answer written for this employer somebody else’s', () => {
    const bank = [
      {
        id: 'a1',
        question: 'Why do you want to work here?',
        default: 'v1',
        variants: [
          { id: 'v1', label: 'Helios', text: 'Helios is why I applied — I have followed the Helios platform for years.' },
        ],
      },
    ];
    const asked = 'Why do you want to work here?';

    const mine = matchAnswer(asked, bank as never, { company: 'Helios' });
    expect(mine.namesAnother).toBeUndefined();
    expect(mine.confident).toBe(true);

    // And the guard still does its job for somebody else.
    const theirs = matchAnswer(asked, bank as never, { company: 'Globex' });
    expect(theirs.namesAnother).toBe('Helios');
    expect(theirs.confident).toBe(false);
  });

  /*
   * And the same employer written another way: the posting says "Helios,
   * Inc.", the form says "Helios". Compared as written, the answer written
   * for them was called somebody else's and only offered.
   */
  it('knows an employer with or without its legal form', () => {
    const bank = [
      {
        id: 'a1',
        question: 'Why do you want to work here?',
        default: 'v0',
        variants: [
          { id: 'v0', label: 'Globex', text: 'Globex is why I applied — the Globex data team is the reason.' },
          { id: 'v1', label: 'Helios, Inc.', text: 'Helios is why I applied — I have followed the Helios platform for years.' },
        ],
      },
    ];
    const asked = 'Why do you want to work here?';
    const mine = matchAnswer(asked, bank as never, { company: 'Helios' });
    expect(mine.namesAnother).toBeUndefined();
    expect(mine.variant?.id).toBe('v1');
    const again = matchAnswer(asked, bank as never, { company: 'HELIOS LLC' });
    expect(again.variant?.id).toBe('v1');
    // A different employer is still somebody else.
    expect(matchAnswer(asked, bank as never, { company: 'Helios Labs' }).variant?.id).not.toBe('v1');
  });

  /*
   * A word the page added can reverse the question, and every added word
   * scores as shared vocabulary.
   *
   * `sameShortTerms` caught "no" because it is two characters. "not",
   * "never" and "cannot" are three or more, so they fell through to `terms`,
   * where a word the *asked* question has and the stored one lacks cost
   * nothing at all. The result was not a near miss: 0.95 and confident, on
   * the question about somebody's right to work, answered with its exact
   * opposite.
   */
  it('does not answer a question that has been negated', () => {
    for (const [asked, stored] of [
      ['Why should we not hire you?', 'Why should we hire you?'],
      [
        'Are you NOT legally authorized to work in the United States?',
        'Are you legally authorized to work in the United States?',
      ],
      ['Are you unable to work weekends?', 'Are you able to work weekends?'],
    ] as [string, string][]) {
      expect(ask(asked, stored).confident, `${asked} ⟵ ${stored}`).toBe(false);
      // Still offered, because a person reading it may well want it as a
      // starting point. It is sending it unread that is refused.
      expect(reuses(asked, stored), `${asked} ⟵ ${stored}`).toBe(true);
    }
  });

  /*
   * And a question narrowed to something the stored answer never addressed.
   * "Do you have a driver's license?" → "Yes, a full clean licence since
   * 2019." is a fine answer, and a confident one to "has it been suspended
   * or revoked?" is a different claim entirely.
   */
  it('does not answer a narrower question with the broader one’s answer', () => {
    for (const [asked, stored] of [
      [
        "Has your driver's license been suspended or revoked in the last five years?",
        "Do you have a driver's license?",
      ],
      ['Describe your experience with Kubernetes in production.', 'Describe your experience.'],
      ['What interests you about our compliance and audit tooling?', 'What interests you?'],
    ] as [string, string][]) {
      expect(ask(asked, stored).confident, `${asked} ⟵ ${stored}`).toBe(false);
    }
  });

  /*
   * And the same thing where the short word is a language rather than a
   * country. "How many years with Go?" answered by the stored answer about
   * C# is a claim about experience nobody has.
   */
  it('does not answer about one language with the answer about another', () => {
    for (const [asked, stored] of [
      ['How many years of experience do you have with Go?', 'How many years of experience do you have with C#?'],
      ['How many years of experience do you have with R?', 'How many years of experience do you have with Go?'],
    ] as [string, string][]) {
      expect(ask(asked, stored).confident, `${asked} ⟵ ${stored}`).toBe(false);
    }
  });

  /*
   * Without demoting the match this must not touch: the same question, short
   * words and all, is still safe to send as it stands.
   */
  it('still sends the same question’s own answer as it stands', () => {
    expect(ask('Are you legally authorized to work in the US?', 'Are you legally authorized to work in the US?').confident).toBe(true);
    expect(ask('How many years of experience do you have with Go?', 'How many years of experience do you have with Go?').confident).toBe(true);
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

/*
 * Some things are not this tool's to remember at all.
 *
 * Every other guard in `matchAnswer` withholds `confident` from a match that
 * is still offered — a wrong company, a narrower question, a negation — so a
 * person can read it and decide. There is no reading of an SSN, a date of
 * birth, a passport number, or a home address that makes handing it back
 * safe, so a question asking for one gets no match at all, not even a loose
 * one: an item stored under that wording could only ever have been put there
 * by something that should not have, and finding it again is the failure.
 */
describe('a question asking for something the bank must never hold', () => {
  const sensitiveQuestions = [
    'What is your Social Security Number?',
    'Please provide your SSN.',
    'What is your date of birth?',
    'DOB (mm/dd/yyyy)',
    'What is your passport number?',
    'What is your home address?',
    'Please give your mailing address.',
  ];

  it('recognises the questions this must refuse', () => {
    for (const q of sensitiveQuestions) expect(isSensitiveQuestion(q), q).toBe(true);
  });

  it('leaves an ordinary question alone', () => {
    for (const q of ['Why do you want to work here?', 'What is your email address for this application?']) {
      expect(isSensitiveQuestion(q), q).toBe(false);
    }
  });

  it('never returns a stored answer to one of these, even if the bank holds it', () => {
    for (const q of sensitiveQuestions) {
      const bank: never = [
        { id: 'a1', question: q, default: 'v', variants: [{ id: 'v', text: 'Something that should not travel.' }] },
      ] as never;
      const m = matchAnswer(q, bank);
      expect(m.item, q).toBeUndefined();
      expect(m.answer, q).toBeUndefined();
      expect(m.confident, q).toBe(false);
      expect(m.score, q).toBe(0);
    }
  });
});

/*
 * The question list cannot know every wording, so the value is checked too:
 * an SSN's shape, a card-length run of digits, an IBAN — under whatever the
 * question called it.
 */
describe('identifiers, however the question is worded', () => {
  it('recognises more ways a form asks for one', () => {
    for (const q of [
      'National ID number',
      'Tax ID (TIN)',
      "Driver's license number",
      'Birthday',
      'Bank account for direct deposit',
      'Credit card on file',
    ]) {
      expect(isSensitiveQuestion(q), q).toBe(true);
    }
  });

  it('recognises the values themselves', () => {
    for (const a of ['123-45-6789', '123 45 6789', '4111 1111 1111 1111', '4111111111111111', '3782-822463-10005', 'GB82 WEST 1234 5698 7654 32']) {
      expect(isSensitiveAnswer(a), a).toBe(true);
    }
  });

  it('leaves ordinary answers alone: phones, years, a ZIP code, prose', () => {
    for (const a of [
      '617-555-0100',
      '+44 20 7946 0958',
      '2019-2023',
      '02115-1234',
      'I have led three teams since 2019.',
      // A long number that is not a card: a timestamp, an order number.
      'Because of the pipelines you publish — 1790131234567',
      'Order 4000123456789 shipped late.',
    ]) {
      expect(isSensitiveAnswer(a), a).toBe(false);
    }
  });

  it('never hands back a stored identifier under an innocent question', () => {
    const bank = [
      { id: 'a1', question: 'Government reference', default: 'v', variants: [{ id: 'v', text: '123-45-6789' }] },
    ] as never;
    const m = matchAnswer('Government reference', bank);
    expect(m.item).toBeUndefined();
    expect(m.answer).toBeUndefined();
  });
});

describe('sameQuestion', () => {
  it('treats retyping — spacing and case — as the same question', () => {
    expect(sameQuestion('Why do you want to work here?', '  why do you want to work here?  ')).toBe(true);
    expect(sameQuestion('Why  do you want to work here?', 'Why do you want to work here?')).toBe(true);
  });

  it('treats an actual change in wording as a different question', () => {
    expect(sameQuestion('Why do you want to work here?', 'Why do you want to leave your current job?')).toBe(false);
  });
});

describe('earlier letters to the same employer, however it is written', () => {
  it('ranks a letter sent to "Acme, Inc." first for a form that says "Acme"', () => {
    const letters = [
      { id: 'l1', title: 'Globex letter', company: 'Globex', role: 'Engineer', body: '', createdAt: new Date().toISOString() },
      { id: 'l2', title: 'Acme letter', company: 'Acme, Inc.', role: 'Designer', body: '', createdAt: '2025-01-01T00:00:00Z' },
    ];
    expect(relevantLetters(letters as never, { company: 'Acme', role: 'Engineer' })[0]?.id).toBe('l2');
    expect(relevantLetters(letters as never, { company: 'Acme Labs', role: 'Engineer' })[0]?.id).toBe('l1');
  });
});
