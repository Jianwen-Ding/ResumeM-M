import { describe, expect, it, vi } from 'vitest';
import {
  fileSentAnswer,
  isSensitiveAnswer,
  isSensitiveQuestion,
  letterId,
  matchAnswer,
  matchAnswers,
  asksWhenYouStart,
  namesPassedDate,
  questionSimilarity,
  redactIdentifiers,
  relevantLetters,
  sameQuestion,
  tidyQuestion,
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
    const id = letterId('Acme Co.', 'Software Engineer Intern', new Date(2026, 2, 4));
    expect(id).toBe('2026-03-04-acme-co-software-engineer-intern');
  });

  it('copes with a missing company or role', () => {
    expect(letterId(undefined, undefined, new Date(2026, 2, 4))).toBe('2026-03-04');
  });

  it('keeps names in other scripts, so two such letters on one day are two letters', () => {
    const day = new Date(2026, 9, 11);
    const mercari = letterId('株式会社メルカリ', 'ソフトウェアエンジニア', day);
    const yandex = letterId('Яндекс', 'Разработчик', day);
    expect(mercari).toBe('2026-10-11-株式会社メルカリ-ソフトウェアエンジニア');
    expect(yandex).toBe('2026-10-11-яндекс-разработчик');
  });

  /*
   * The role was cut to 30 characters and the cut took the number, so two
   * requisitions under one long title on one day were one id, and the
   * second letter was saved over the first.
   */
  it('keeps the requisition number of a long title, so two requisitions are two letters', () => {
    const day = new Date(2026, 9, 11);
    const first = letterId('Helios', 'Senior Software Engineer, Platform (12345678)', day);
    const second = letterId('Helios', 'Senior Software Engineer, Platform (87654321)', day);
    expect(first).toBe('2026-10-11-helios-senior-software-engineer-platf-12345678');
    expect(second).toBe('2026-10-11-helios-senior-software-engineer-platf-87654321');
    // After a separator too, and in the case it was written.
    expect(letterId('Helios', 'Senior Software Engineer, Platform Infrastructure - JR0286834', day)).toBe(
      '2026-10-11-helios-senior-software-engineer-platf-jr0286834',
    );
  });

  it('is the id it always was for a short title with a number, and for a title with none', () => {
    const day = new Date(2026, 9, 11);
    expect(letterId('Helios', 'Engineer (12345678)', day)).toBe('2026-10-11-helios-engineer-12345678');
    expect(letterId('Helios', 'Senior Software Engineer, Platform Infrastructure', day)).toBe(
      '2026-10-11-helios-senior-software-engineer-platf',
    );
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

  /*
   * The same question with the furniture on the stored side.
   *
   * `unanswered` forgave "position", "role" and the rest on the asked side
   * and `fullyAsked` did not forgive them on the stored side, so the bank
   * matched one way round and not the other. Measured with one row saved
   * from each wording and the other asked: "Are you willing to relocate for
   * this role?" then "Are you willing to relocate?" scored 0.67 and was left
   * for the person; the other order scored 0.90 and was filled. Which form
   * somebody happened to apply through first decided whether their answer
   * came back.
   */
  it('finds the answer again whichever of two wordings was saved first', () => {
    for (const [asked, stored] of [
      ['How did you hear about us?', 'How did you hear about this position?'],
      ['How did you hear about us?', 'How did you hear about this job?'],
      ['How did you hear about this opportunity?', 'How did you hear about us?'],
      ['Are you willing to relocate?', 'Are you willing to relocate for this role?'],
      ['What is your earliest start date?', 'Earliest start date for this position'],
    ] as [string, string][]) {
      expect(ask(asked, stored).confident, `${asked} ⟵ ${stored}`).toBe(true);
    }
  });

  it('and still tells apart the questions that differ by a word that is not furniture', () => {
    for (const [asked, stored] of [
      ['Earliest start date', 'Latest start date'],
      ['Preferred last name', 'Preferred first name'],
      ['Current salary', 'Expected salary'],
      ['Where did you hear about us?', 'How did you hear about us?'],
      ['Are you willing to relocate?', 'Are you willing to relocate at your own expense for this role?'],
    ] as [string, string][]) {
      expect(ask(asked, stored).confident, `${asked} ⟵ ${stored}`).toBe(false);
    }
  });

  /*
   * Two wordings of one question, typed on one form and asked by the next.
   * Measured before this: none of the first four pairs was confident, so the
   * extension, which fills only confident matches, left each for the person
   * to type again.
   */
  it('finds the answer again through inflection and word order', () => {
    for (const [asked, stored] of [
      ['Salary expectations', 'Expected salary'],
      ['Expected salary', 'Salary expectations'],
      ['What are your salary expectations?', 'Expected salary'],
      ['Desired salary', 'Expected salary'],
      ['Expected compensation', 'Expected salary'],
      ['Are you willing to relocate?', 'Willingness to relocate'],
    ] as [string, string][]) {
      expect(ask(asked, stored).confident, `${asked} ⟵ ${stored}`).toBe(true);
    }
  });

  it('finds the answer again through another word for a link', () => {
    for (const [asked, stored] of [
      ['Portfolio URL', 'Portfolio link'],
      ['Portfolio link', 'Portfolio URL'],
      ['Portfolio website', 'Portfolio link'],
      ['Link to your portfolio', 'Portfolio URL'],
    ] as [string, string][]) {
      expect(ask(asked, stored).confident, `${asked} ⟵ ${stored}`).toBe(true);
    }
  });

  it('finds the answer again through the framing a form puts round it', () => {
    for (const [asked, stored] of [
      ['Who is your current employer?', 'Current employer'],
      ['Current employer', 'Who is your current employer?'],
      ['Please enter your current employer', 'Current employer'],
      ['Please enter your portfolio URL', 'Portfolio link'],
      ['Please provide your emergency contact', 'Emergency contact'],
    ] as [string, string][]) {
      expect(ask(asked, stored).confident, `${asked} ⟵ ${stored}`).toBe(true);
    }
  });

  it('finds the answer again however a minimum age is put', () => {
    for (const [asked, stored] of [
      ['Are you at least 18?', 'Are you 18 or older?'],
      ['Are you 18 or older?', 'Are you at least 18?'],
      ['Are you at least 18 years of age?', 'Are you 18 or older?'],
      ['Are you at least 18 years old?', 'Are you 18 or older?'],
      ['Are you over the age of 18?', 'Are you 18 or older?'],
      ['Are you 18 years or older?', 'Are you at least 18?'],
      ['Are you 18+?', 'Are you at least 18?'],
    ] as [string, string][]) {
      expect(ask(asked, stored).confident, `${asked} ⟵ ${stored}`).toBe(true);
    }
  });

  /*
   * And none of that reaches a question that differs by a word that matters.
   * Two of these were confident before any of it: "Are you 21 or older?"
   * against "...18 or older?" and "5+ years" against "3+ years", because a
   * one- or two-digit number was too short to be a term at all.
   */
  it('still tells apart the questions those wordings sit beside', () => {
    for (const [asked, stored] of [
      // What somebody is paid now is not what they are asking for.
      ['Current salary', 'Expected salary'],
      ['Expected salary', 'Current salary'],
      ['What is your current salary?', 'Salary expectations'],
      ['Salary expectations', 'What is your current salary?'],
      ['Current compensation', 'Desired salary'],
      ['Salary history', 'Expected salary'],
      ['Latest start date', 'Earliest start date'],
      ['Earliest start date', 'Latest start date'],
      ['Preferred last name', 'Preferred first name'],
      ['Preferred first name', 'Preferred last name'],
      ['Who is your previous employer?', 'Current employer'],
      ['Are you a current employee?', 'Current employer'],
      ['GitHub URL', 'Portfolio link'],
      ['LinkedIn URL', 'Portfolio URL'],
      // "site" is a working arrangement, not a web address.
      ['Are you comfortable working on site?', 'Are you comfortable working on our website?'],
      // The other side of an age, another age, and an age denied.
      ['Are you under 18?', 'Are you 18 or older?'],
      ['Are you younger than 18?', 'Are you at least 18?'],
      ['Are you at least 21?', 'Are you 18 or older?'],
      ['Are you 21 or older?', 'Are you at least 18?'],
      ['Are you not at least 18?', 'Are you 18 or older?'],
      // A minimum that is not an age, and another minimum.
      ['Do you have at least 3 years of experience?', 'Are you at least 18?'],
      ['Do you have 5+ years of Python experience?', 'Do you have 3+ years of Python experience?'],
      ['Do you have at least 5 years of experience?', 'Do you have at least 3 years of experience?'],
      ['Do you have more than 5 years of experience?', 'Do you have at least 5 years of experience?'],
    ] as [string, string][]) {
      expect(ask(asked, stored).confident, `${asked} ⟵ ${stored}`).toBe(false);
    }
    // While the same minimum, put another way, is the same question.
    expect(ask('Do you have 5 or more years of experience?', 'Do you have 5+ years of experience?').confident).toBe(true);
  });

  it('never takes a word back to a stem that is a negation', () => {
    // "note" is not "not", and "none" is not "non".
    expect(ask('Anything else not?', 'Anything else to note?').confident).toBe(false);
    expect(ask('Non of the above', 'None of the above').confident).toBe(false);
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
    'Address Line 1',
    'Zip code',
    'Postal Code',
    'Apartment/Suite',
    // The self-identification block, as the bank had it banked.
    'Veterans Status',
    'What is your Veterans Status?',
    'Are you Hispanic/Latino?',
    'Do you have a disability?',
    'Gender',
  ];

  it('recognises the questions this must refuse', () => {
    for (const q of sensitiveQuestions) expect(isSensitiveQuestion(q), q).toBe(true);
  });

  it('leaves an ordinary question alone', () => {
    for (const q of ['Why do you want to work here?', 'What is your email address for this application?']) {
      expect(isSensitiveQuestion(q), q).toBe(false);
    }
  });

  /*
   * The framing a form puts round a question is taken off before it is
   * compared. The refusal reads the question as it was asked, so a national
   * ID or a date of birth asked for "please" is refused the same.
   */
  it('refuses them however the form frames the question', () => {
    for (const q of [
      'Please enter your national ID number',
      'Please provide your social security number',
      'Who is your passport issuer and what is your passport number?',
      'Please enter your date of birth',
    ]) {
      const bank: never = [
        { id: 'a1', question: q.replace(/^please (enter|provide) your /i, ''), default: 'v', variants: [{ id: 'v', text: 'Kept by mistake.' }] },
      ] as never;
      const m = matchAnswer(q, bank);
      expect(m.item, q).toBeUndefined();
      expect(m.confident, q).toBe(false);
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

  // Each of these was a separate row in a real bank, saved from a form.
  it('treats the required marker and a label read twice as the same question', () => {
    expect(sameQuestion('Discipline*', 'Discipline')).toBe(true);
    expect(sameQuestion('Discipline *', 'Discipline*')).toBe(true);
    expect(sameQuestion('DisciplineDiscipline', 'Discipline')).toBe(true);
    expect(
      sameQuestion(
        'Are you legally authorized to work in the country where this position is located?Are you legally authorized to work in the country where this position is located? Required',
        'Are you legally authorized to work in the country where this position is located?',
      ),
    ).toBe(true);
    expect(sameQuestion('Discipline*', 'Degree*')).toBe(false);
  });
});

describe('tidyQuestion', () => {
  it('takes off what a form adds at the ends: the required marker, in its usual spellings', () => {
    expect(tidyQuestion('End date month*')).toBe('End date month');
    expect(tidyQuestion('Active Security Clearance(s) *')).toBe('Active Security Clearance(s)');
    expect(tidyQuestion('Are you willing to relocate?*')).toBe('Are you willing to relocate?');
    expect(tidyQuestion('* Phone Device Type')).toBe('Phone Device Type');
    expect(tidyQuestion('Phone Device Type (required)')).toBe('Phone Device Type');
    expect(tidyQuestion('Will you require sponsorship? Required')).toBe('Will you require sponsorship?');
  });

  it('keeps "required" when it is a word of the question', () => {
    expect(tidyQuestion('Is visa sponsorship required?')).toBe('Is visa sponsorship required?');
    expect(tidyQuestion('Will visa sponsorship be required')).toBe('Will visa sponsorship be required');
  });

  it('reads a label read twice as once', () => {
    expect(tidyQuestion('SchoolSchool')).toBe('School');
    expect(tidyQuestion('Walla Walla')).toBe('Walla Walla');
    expect(tidyQuestion('Security clearance (TS/SCI) required')).toBe('Security clearance (TS/SCI) required');
    expect(tidyQuestion('**Are you one of the following?** Citizen')).toBe('**Are you one of the following?** Citizen');
    expect(tidyQuestion('Location (city)Location (city)')).toBe('Location (city)');
    expect(tidyQuestion('How did you hear about this job?How did you hear about this job?')).toBe(
      'How did you hear about this job?',
    );
    expect(tidyQuestion('I am available to begin in 2028I am available to begin in 2028 Required')).toBe(
      'I am available to begin in 2028',
    );
    // A word that merely repeats inside a longer question is left alone.
    expect(tidyQuestion('Yes or no: yes or no?')).toBe('Yes or no: yes or no?');
    expect(tidyQuestion('Bye bye')).toBe('Bye bye');
  });

  it('lets a row kept with the markup on it be found by the question as asked', () => {
    const bank = [
      { id: 'a1', question: 'SchoolSchool', default: 'v_1', variants: [{ id: 'v_1', label: 'Chosen on a form', text: 'Northeastern University' }] },
      { id: 'a2', question: 'Discipline*', default: 'v_1', variants: [{ id: 'v_1', label: 'Chosen on a form', text: 'Computer Science' }] },
    ];
    const school = matchAnswer('School', bank);
    expect(school.item?.id).toBe('a1');
    expect(school.confident).toBe(true);
    const discipline = matchAnswer('Discipline', bank);
    expect(discipline.item?.id).toBe('a2');
    expect(discipline.confident).toBe(true);
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

describe('a label that is not an employer', () => {
  /*
   * Every variant's label was taken for a company, so the seed bank's own
   * "May 2026" answer, labelled "May 2026", named an employer called "May
   * 2026" — and the graduation date, the sponsorship "Yes", and anything
   * saved from a form under "Chosen on a form" or "Saved" came back never
   * confident, with the card warning that they named somebody else.
   */
  const bank: AnswerBankItem[] = [
    {
      id: 'ans_grad',
      question: 'What is your expected graduation date?',
      default: 'v_may',
      variants: [
        { id: 'v_may', label: 'May 2026', text: 'May 2026' },
        { id: 'v_dec', label: 'December 2026', text: 'December 2026' },
      ],
    },
    {
      id: 'ans_sponsor',
      question: 'Will you now or in the future require sponsorship?',
      default: 'v_yes',
      variants: [
        { id: 'v_no', label: 'No', text: 'No' },
        { id: 'v_yes', label: 'Yes', text: 'Yes' },
      ],
    },
    {
      id: 'ans_hear',
      question: 'How did you hear about us?',
      default: 'v_1',
      variants: [{ id: 'v_1', label: 'Chosen on a form', text: 'A friend saved the posting for me' }],
    },
    {
      id: 'ans_relocate',
      question: 'Are you willing to relocate?',
      default: 'v_1',
      variants: [{ id: 'v_1', label: 'Saved', text: 'Yes, anywhere on the east coast' }],
    },
  ];

  it('does not treat an answer that repeats its own label as naming an employer', () => {
    const grad = matchAnswer('What is your expected graduation date?', bank, { company: 'Helios' });
    expect(grad.namesAnother).toBeUndefined();
    expect(grad.confident).toBe(true);
    const sponsor = matchAnswer('Will you now or in the future require sponsorship?', bank, { company: 'Helios' });
    expect(sponsor.namesAnother).toBeUndefined();
    expect(sponsor.confident).toBe(true);
  });

  it('nor the labels the tools themselves give saved answers', () => {
    const heard = matchAnswer('How did you hear about us?', bank, { company: 'Helios' });
    expect(heard.namesAnother).toBeUndefined();
  });

  /*
   * The extension keeps what was typed on a form under "Typed on a form", as
   * it keeps what was chosen under "Chosen on a form". An answer that happens
   * to say those words — "I typed on a form at the career fair" — is not an
   * answer written for an employer by that name.
   */
  it('nor the label the extension gives an answer typed on a form', () => {
    const typed: AnswerBankItem[] = [
      ...bank,
      {
        id: 'ans_start',
        question: 'Earliest start date',
        default: 'v_1',
        variants: [{ id: 'v_1', label: 'Typed on a form', text: 'Two weeks after an offer, as typed on a form last spring' }],
      },
    ];
    const start = matchAnswer('Earliest start date', typed, { company: 'Helios' });
    expect(start.namesAnother).toBeUndefined();
    expect(start.confident).toBe(true);
  });

  it('while a company label still vetoes an answer that names that company', () => {
    const withAcme: AnswerBankItem[] = [
      ...bank,
      {
        id: 'ans_why',
        question: 'Why do you want to work here?',
        default: 'v_acme',
        variants: [{ id: 'v_acme', label: 'Acme', text: 'Acme builds the rockets I grew up watching.' }],
      },
    ];
    const why = matchAnswer('Why do you want to work here?', withAcme, { company: 'Helios' });
    expect(why.namesAnother).toBe('Acme');
    expect(why.confident).toBe(false);
  });
});

describe('identifiers taken out before anything reaches the AI', () => {
  /*
   * Only an SSN written with its dashes was caught. Labelled and without them,
   * or a Canadian SIN, a UK National Insurance number, a driver's licence or a
   * tax id, went to the model as written.
   */
  it.each([
    ['SSN: 123456789', '123456789'],
    ['Social Security Number 123456789', '123456789'],
    ['SIN: 123 456 789', '123 456 789'],
    ['National Insurance number: AB 12 34 56 C', 'AB 12 34 56 C'],
    ['NI: JK 98 76 54 A', 'JK 98 76 54 A'],
    ['my NI number is QQ123456C', 'QQ123456C'],
    ["Driver's license: D1234567", 'D1234567'],
    ['Driving licence number MORGA753116SM9IJ', 'MORGA753116SM9IJ'],
    ['Tax ID: 912-34-5678', '912-34-5678'],
  ])('takes out %s', (text, secret) => {
    const out = redactIdentifiers(text);
    expect(out.text).not.toContain(secret);
    expect(out.redacted).toBeGreaterThan(0);
  });

  it.each([
    'Call me at 617-555-0142',
    'Order 123456789 shipped',
    'Built a SIN wave generator',
    'I hold a driver’s license and a car',
    'Improved throughput by 123456 requests a day',
  ])('leaves %s alone', (text) => {
    expect(redactIdentifiers(text).text).toBe(text);
  });
});

describe('identifier questions the bank never answers', () => {
  /*
   * The redaction learned these; the bank's own list did not, so an answer
   * given to "What is your SIN?" or "Driving licence number" was kept and
   * offered on the next form that asked.
   */
  it.each(['What is your SIN?', 'Social Insurance Number', 'NI number', 'Driving licence number'])(
    'treats "%s" as an identifier',
    (q) => {
      expect(isSensitiveQuestion(q)).toBe(true);
    },
  );
  it('and an NI number as an identifier whatever the question called it', () => {
    expect(isSensitiveAnswer('AB 12 34 56 C')).toBe(true);
  });
  it.each(['Is there anything you would change about your last role?', 'Do you have a single point of contact?'])(
    'while "%s" is an ordinary question',
    (q) => {
      expect(isSensitiveQuestion(q)).toBe(false);
    },
  );
});

describe('an identifier with a hint between its label and its value', () => {
  /*
   * A form's label carries the format it wants, and a review step writes the
   * label out whole: "Date of Birth (MM/DD/YYYY): 04/02/1999", "Social
   * Security Number *: 123456789". Only a colon, a dash or a space was allowed
   * between the label and the value, so each of these went to the AI whole.
   */
  it.each([
    ['Date of Birth (MM/DD/YYYY): 04/02/1999', '04/02/1999'],
    ['Birth date (YYYY-MM-DD) 1999-04-02', '1999-04-02'],
    ['Date of birth *: 04/02/1999', '04/02/1999'],
    ['your date of birth, 04/02/1999, is on file', '04/02/1999'],
    ['SSN (no dashes): 123456789', '123456789'],
    ['Social Security Number *: 123456789', '123456789'],
    ['SIN (Canada): 046 454 286', '046 454 286'],
    ["Driver's license # (optional): D1234567", 'D1234567'],
    ['Passport number (as shown): X12345678', 'X12345678'],
  ])('takes out %s', (text, secret) => {
    const out = redactIdentifiers(text);
    expect(out.text).not.toContain(secret);
    expect(out.redacted).toBeGreaterThan(0);
  });

  it.each([
    'Social Security Number (last 4 digits): 6789',
    'Passport (required for travel) 2 trips a year',
    'Date of birth (you must be 18 or older)',
  ])('leaves %s alone', (text) => {
    expect(redactIdentifiers(text).text).toBe(text);
  });
});

describe('a national ID number, where it is named', () => {
  /*
   * The labelled numbers were an American, a Canadian and a British set. A
   * national ID by that name, India's Aadhaar, Singapore's NRIC, Brazil's CPF,
   * Spain's DNI and NIE, Poland's PESEL, the Dutch BSN and the Swedish
   * personnummer went to the AI as written — the CPF also because its dots
   * ended the number after three digits.
   */
  it.each([
    ['National ID: 12345678', '12345678'],
    ['National ID number: A1234567', 'A1234567'],
    ['National identity card number 850402-1234', '850402-1234'],
    ['Government-issued ID #: 4410-2231-77', '4410-2231-77'],
    ['Aadhaar: 1234 5678 9012', '1234 5678 9012'],
    ['NRIC: S1234567D', 'S1234567D'],
    ['CPF: 123.456.789-09', '123.456.789-09'],
    ['DNI: 12345678Z', '12345678Z'],
    ['NIE: X1234567L', 'X1234567L'],
    ['PESEL 85040212345', '85040212345'],
    ['BSN: 123456782', '123456782'],
    ['Personnummer: 850402-1234', '850402-1234'],
    ['Personal identity number 19850402-1234', '19850402-1234'],
  ])('takes out %s', (text, secret) => {
    const out = redactIdentifiers(text);
    expect(out.text).not.toContain(secret);
    expect(out.redacted).toBeGreaterThan(0);
  });

  it.each([
    'A national ID is required for the background check',
    'Bring a government-issued ID on day 1',
    'Requisition ID: 2025-10-0045',
  ])('leaves %s alone', (text) => {
    expect(redactIdentifiers(text).text).toBe(text);
  });
});

describe('a date of birth, however it is written', () => {
  /*
   * A labelled date of birth was caught as digits, as "April 2, 1999" and as
   * "2 April 1999". Under "Birthday" or "Born", with the month cut short, or
   * with the day said as "2nd", it went to the AI as written.
   */
  it.each([
    ['Birthday: 04/02/1999', '04/02/1999'],
    ['Born: 04/02/1999', '04/02/1999'],
    ['Date of Birth: Apr. 2, 1999', 'Apr. 2, 1999'],
    ['Date of birth: 2nd April 1999', '2nd April 1999'],
    ['Date of birth - April 2nd, 1999', 'April 2nd, 1999'],
    ['DOB: 2nd of April 1999', '2nd of April 1999'],
  ])('takes out %s', (text, secret) => {
    const out = redactIdentifiers(text);
    expect(out.text).not.toContain(secret);
    expect(out.redacted).toBeGreaterThan(0);
  });

  it.each(['Founded in 2012, born out of a hackathon', 'Our birthday party is on Friday', 'Posted April 2nd, 2026'])(
    'leaves %s alone',
    (text) => {
      expect(redactIdentifiers(text).text).toBe(text);
    },
  );
});

describe('an SSN written with dots or with en dashes', () => {
  /*
   * The 3-2-4 shape was caught with hyphens and spaces only. Typed with dots,
   * or with the en dashes a word processor or a PDF's text puts in place of
   * hyphens, it went to the AI whole — with its label or without.
   */
  it.each([
    ['123.45.6789', '123.45.6789'],
    ['SSN: 123.45.6789', '123.45.6789'],
    ['SSN: 123–45–6789', '123–45–6789'],
    ['my number is 123 – 45 – 6789', '6789'],
  ])('takes out %s', (text, secret) => {
    const out = redactIdentifiers(text);
    expect(out.text).not.toContain(secret);
    expect(out.redacted).toBeGreaterThan(0);
  });

  it.each(['Version 12.45.6789 of the SDK', 'Salary $120.000 – $150.000', 'Years 2019–2024', 'Call 617.555.0142'])('leaves %s alone', (text) => {
    expect(redactIdentifiers(text).text).toBe(text);
  });
});

describe('a card number from any of the networks', () => {
  /*
   * A card was known by Visa's, Mastercard's, Amex's and part of Discover's
   * prefixes. A JCB card, a Diners Club card, a Discover card in its 644–649
   * range and a UnionPay card went to the AI whole, Luhn digit and all.
   */
  it.each([
    ['JCB', '3530 1113 3330 0000'],
    ['Diners Club', '3056 930902 5904'],
    ['Diners Club', '3852 0000 0232 37'],
    ['Discover', '6445 6445 6445 6445'],
    ['UnionPay', '6200 0000 0000 0005'],
  ])('takes out a %s card', (_network, number) => {
    const out = redactIdentifiers(`Card number: ${number}`);
    expect(out.text).not.toContain(number);
    expect(out.redacted).toBeGreaterThan(0);
  });

  it('leaves a long number that fails the check alone', () => {
    expect(redactIdentifiers('Order 3530 1113 3330 0001 shipped').text).toBe('Order 3530 1113 3330 0001 shipped');
  });
});

describe('the identifiers the extension refuses, refused here as well', () => {
  /*
   * JobHelper's remembering.js refuses a government ID by its short names,
   * a visa, card or account number, and the secrets a security check asks
   * for; the national numbers `redactIdentifiers` takes out by name were
   * refused by neither. Each of these was saved to the bank by /answers/save
   * and handed back by `matchAnswer` on the next form that asked.
   */
  it.each([
    'Government ID',
    'Govt. ID #',
    "Gov't ID number",
    'Government-issued ID number',
    'State ID',
    'Citizen ID',
    'Personal identification number',
    'Aadhaar number',
    'Aadhar card number',
    'NRIC / FIN',
    'CPF',
    'DNI',
    'NIE',
    'PESEL',
    'BSN',
    'Personnummer',
    'Visa number',
    'Card number',
    'Account number',
    'Unique Taxpayer Reference',
    'Driver’s License Number',
    "Mother's maiden name",
    'Mother’s maiden name',
    'Password',
    'Security question answer',
  ])('treats "%s" as an identifier', (q) => {
    expect(isSensitiveQuestion(q)).toBe(true);
    const bank = [{ id: 'a1', question: q, default: 'v', variants: [{ id: 'v', text: 'Kept by mistake.' }] }] as never;
    expect(matchAnswer(q, bank).item).toBeUndefined();
  });

  it.each([
    'Which finance tools have you used?',
    'Do you have a fin-tech background?',
    'What is your state of residence?',
    'Tell us about a time you had to protect a customer account',
    'Do you hold a work visa?',
  ])('while "%s" is an ordinary question', (q) => {
    expect(isSensitiveQuestion(q)).toBe(false);
  });

  /*
   * And an answer the redaction would take out is not kept to be handed back.
   * The bank refused an SSN by its dashes and a card by its check digit, and
   * kept "DOB: 04/02/1999" or "Aadhaar: 1234 5678 9012" typed under an
   * innocent question — the same text `redactIdentifiers` removes before
   * anything else reads it.
   */
  it.each([
    'DOB: 04/02/1999',
    'Aadhaar: 1234 5678 9012',
    'NRIC: S1234567D',
    'Passport # X1234567',
    'SSN 123456789',
  ])('refuses the answer "%s"', (a) => {
    expect(isSensitiveAnswer(a)).toBe(true);
    const bank = [{ id: 'a1', question: 'Reference for the form', default: 'v', variants: [{ id: 'v', text: a }] }] as never;
    expect(matchAnswer('Reference for the form', bank).item).toBeUndefined();
  });

  /*
   * Where somebody was born, and a Medicare or Medicaid number. Refused by
   * neither this list nor JobHelper's: "Place of birth" and "Country of birth"
   * missed `date of birth`, "Birthplace" missed `birthday`, and a Medicare
   * number is a government health identifier named by neither list. Each was
   * saved by /answers/save and handed back by `matchAnswer`.
   */
  it.each([
    'Place of birth',
    'Country of birth',
    'City of birth',
    'Birthplace',
    'Birth place',
    'Birth country',
    'Where were you born?',
    'Medicare number',
    'Medicaid number',
    'Medicare/Medicaid number',
  ])('treats "%s" as an identifier', (q) => {
    expect(isSensitiveQuestion(q)).toBe(true);
    const bank = [{ id: 'a1', question: q, default: 'v', variants: [{ id: 'v', text: 'Kept by mistake.' }] }] as never;
    expect(matchAnswer(q, bank).item).toBeUndefined();
  });

  it.each(['Are you willing to give birth to new ideas?', 'Which medical devices have you worked on?', 'Have you worked with Medicare claims data?'])(
    'while "%s" is still asked',
    (q) => {
      // Not a place of birth, and not a number: a question about work.
      expect(isSensitiveQuestion(q)).toBe(false);
    },
  );
});

describe('a question that asks about a different number', () => {
  const one = (question: string, text = 'Yes'): AnswerBankItem[] => [
    { id: 'ans_n', question, default: 'v_1', variants: [{ id: 'v_1', label: 'Saved', text }] },
  ];

  it('is not answered confidently with what was said about another number', () => {
    expect(matchAnswer('Do you have 3 years of experience?', one('Do you have 5 years of experience?')).confident).toBe(false);
    expect(matchAnswer('Is your GPA above 3.0?', one('Is your GPA above 3.5?')).confident).toBe(false);
    expect(
      matchAnswer('Are you able to work in the office 3 days a week?', one('Are you able to work in the office 5 days a week?'))
        .confident,
    ).toBe(false);
  });

  it('while the same number, and a length limit beside the box, still match', () => {
    expect(matchAnswer('Do you have 5 years of experience?', one('Do you have 5 years of experience?')).confident).toBe(true);
    expect(matchAnswer('Is your GPA above 3.0?', one('Is your GPA above 3?')).confident).toBe(true);
    expect(
      matchAnswer('Why do you want this job? (500 characters max)', one('Why do you want this job?', 'The work.')).confident,
    ).toBe(true);
  });
});

describe('an employer label with its legal form on it', () => {
  it('still vetoes an answer that names that employer for somebody else', () => {
    const bank: AnswerBankItem[] = [
      {
        id: 'ans_why',
        question: 'Why do you want to work here?',
        default: 'v_1',
        variants: [{ id: 'v_1', label: 'Stripe, Inc.', text: 'I want to join Stripe because payments infrastructure excites me.' }],
      },
    ];
    const m = matchAnswer('Why do you want to work here?', bank, { company: 'Plaid' });
    expect(m.namesAnother).toBe('Stripe, Inc.');
    expect(m.confident).toBe(false);
    // And written for these people, it is theirs.
    expect(matchAnswer('Why do you want to work here?', bank, { company: 'Stripe' }).confident).toBe(true);
  });
});

describe('a label that says which version of an answer it is', () => {
  const bank: AnswerBankItem[] = [
    {
      id: 'ans_type',
      question: 'Are you looking for full-time work?',
      default: 'v_full',
      variants: [
        { id: 'v_full', label: 'Full', text: 'Full-time, starting in June.' },
        { id: 'v_short', label: 'Short (two lines)', text: 'Short answer: full-time.' },
      ],
    },
    {
      id: 'ans_link',
      question: 'LinkedIn profile',
      default: 'v_1',
      variants: [{ id: 'v_1', label: 'Profile URL', text: 'https://www.linkedin.com/in/someone' }],
    },
    {
      id: 'ans_why',
      question: 'Why do you want to work here?',
      default: 'v_1',
      variants: [{ id: 'v_1', label: 'Acme', text: 'Acme builds the rockets I grew up watching.' }],
    },
  ];

  it('is not taken for an employer', () => {
    const m = matchAnswer('Are you looking for full-time work?', bank, { company: 'Helios' });
    expect(m.namesAnother).toBeUndefined();
    expect(m.confident).toBe(true);
    // While a company's name still is.
    expect(matchAnswer('Why do you want to work here?', bank, { company: 'Helios' }).namesAnother).toBe('Acme');
  });

  it('and the employers the caller knows are looked for as well as the labels', () => {
    const known = { company: 'Helios', employers: ['Helios', 'Globex'] };
    // "Acme" was never tracked, but an answer written for it still names it:
    // with the list alone it went confidently into another employer's form.
    const acme = matchAnswer('Why do you want to work here?', bank, known);
    expect(acme.namesAnother).toBe('Acme');
    expect(acme.confident).toBe(false);
    // And a version label is still not an employer with the list given.
    expect(matchAnswer('Are you looking for full-time work?', bank, known).confident).toBe(true);
    const globex: AnswerBankItem[] = [
      { id: 'ans_why', question: 'Why do you want to work here?', default: 'v_1', variants: [{ id: 'v_1', label: 'Saved', text: 'Globex is where I learned to ship.' }] },
    ];
    const m = matchAnswer('Why do you want to work here?', globex, known);
    expect(m.namesAnother).toBe('Globex');
    expect(m.confident).toBe(false);
  });
});

/*
 * An address asked for a box at a time, or qualified some other way.
 * "Address Line1" has no word break between the line and its number, so
 * `address\s*(line|[12])\b` never reached it; and "current full address"
 * names no word the list knew.
 */
describe('an address however a form asks for it', () => {
  it('refuses the wordings the list missed, and still the ones it had', () => {
    for (const q of [
      'Address Line1',
      'Address Line2',
      'address line1*',
      'What is your current full address?',
      'Current address',
      'Permanent address',
      'What is your address?',
      'Address',
      // The ones it already refused.
      'Address Line 1',
      'Address Line 2',
      'Address 1',
      'What is your home address?',
      'Please give your mailing address.',
      'Street address',
      'Zip code',
    ]) {
      expect(isSensitiveQuestion(q), q).toBe(true);
    }
    // And still not an email or a web address.
    for (const q of [
      'What is your email address for this application?',
      'Current email address',
      'Your email address',
      'Website address',
      'Why do you want to work here?',
    ]) {
      expect(isSensitiveQuestion(q), q).toBe(false);
    }
  });
});

/*
 * Every answer not taken from the bank was filed into it on completion,
 * the AI's drafts as if the person had written them, so the next form asking
 * the same question had the AI's text filled in confidently and unread. A
 * draft still word for word as written is filed as a suggestion, and offered
 * like a loose match; one the person typed or edited is filed as before.
 */
describe('an AI-written answer filed from a completed application', () => {
  const Q = 'Why do you want to work at a streaming company?';
  const file = (bank: AnswerBankItem[], answer: string, unread: boolean, label = 'Streamly') =>
    fileSentAnswer(bank, { question: Q, answer, label, unread, newId: () => 'ans_new' });

  it('is offered next time, not filled in', () => {
    const bank: AnswerBankItem[] = [];
    file(bank, 'Because streaming is the work I want to do.', true);
    expect(bank).toHaveLength(1);
    const m = matchAnswer(Q, bank);
    expect(m.answer).toBe('Because streaming is the work I want to do.');
    expect(m.confident).toBe(false);
  });

  it('but one the person typed or edited is filled as before', () => {
    const bank: AnswerBankItem[] = [];
    file(bank, 'Because I edited this one myself.', false);
    expect(matchAnswer(Q, bank).confident).toBe(true);
  });

  it('does not push a reviewed answer out of the default', () => {
    const bank: AnswerBankItem[] = [];
    file(bank, 'My own answer.', false, 'Acme');
    file(bank, 'The AI answer.', true, 'Streamly');
    expect(bank[0]!.variants).toHaveLength(2);
    const m = matchAnswer(Q, bank, { company: 'Plaid' });
    expect(m.answer).toBe('My own answer.');
    expect(matchAnswer(Q, bank, { company: 'Streamly' }).confident).toBe(false);
  });

  it('does not push it out when the same unread draft is sent a second time', () => {
    const bank: AnswerBankItem[] = [];
    file(bank, 'My own answer.', false, 'Acme');
    file(bank, 'The AI answer.', true, 'Streamly');
    file(bank, 'The AI answer.', true, 'Globex');
    expect(bank[0]!.variants).toHaveLength(2);
    expect(matchAnswer(Q, bank, { company: 'Plaid' })).toMatchObject({ answer: 'My own answer.', confident: true });
  });

  it('is filled once the person has sent it having read it', () => {
    const bank: AnswerBankItem[] = [];
    file(bank, 'Because streaming is the work I want to do.', true);
    file(bank, 'Because streaming is the work I want to do.', false);
    expect(matchAnswer(Q, bank).confident).toBe(true);
  });
});

describe('the stored question that is the question asked', () => {
  const item = (id: string, question: string, text: string): AnswerBankItem => ({
    id,
    question,
    default: 'v1',
    variants: [{ id: 'v1', label: 'Base', text }],
  });

  it('answers it, even when a near-duplicate scoring the same comes first', () => {
    // "desired" and "expected" are one word to the matcher, so both score 1.
    const bank = [
      item('expected', 'What is your expected salary?', '$90,000'),
      item('desired', 'What is your desired salary?', '$110,000'),
    ];
    expect(questionSimilarity('What is your desired salary?', bank[0]!.question)).toBe(
      questionSimilarity('What is your desired salary?', bank[1]!.question),
    );
    const m = matchAnswer('What is your desired salary?', bank);
    expect(m.item?.id).toBe('desired');
    expect(m.answer).toBe('$110,000');
    expect(matchAnswer('What is your expected salary?', bank).item?.id).toBe('expected');
  });

  it('as sameQuestion reads it: case, spacing and a required marker aside', () => {
    const bank = [
      item('expected', 'What is your expected salary?', '$90,000'),
      item('desired', 'What is your desired salary?*', '$110,000'),
    ];
    expect(matchAnswer('what is your  desired salary? ', bank).item?.id).toBe('desired');
  });

  it('and the same through matchAnswers, for a whole form at once', () => {
    const bank = [
      item('m05', 'month 2027-05', 'May'),
      item('m12', 'month 2027-12', 'December'),
      item('expected', 'What is your expected salary?', '$90,000'),
      item('desired', 'What is your desired salary?', '$110,000'),
    ];
    const ms = matchAnswers(bank.map((b) => b.question), bank);
    expect(ms.map((m) => m.item?.id)).toEqual(['m05', 'm12', 'expected', 'desired']);
  });

  it('without one, equal scores go to the first in the bank every time', () => {
    const bank = [
      item('expected', 'What is your expected salary?', '$90,000'),
      item('desired', 'What is your desired salary?', '$110,000'),
    ];
    expect(matchAnswer('Your desired salary', bank).item?.id).toBe('expected');
    expect(matchAnswer('Your desired salary', [...bank].reverse()).item?.id).toBe('desired');
  });
});

describe('C, C# and C++', () => {
  const bank: AnswerBankItem[] = ['C', 'C#', 'C++'].map((lang) => ({
    id: lang,
    question: `${lang} Skill Proficiency Levels`,
    default: 'v1',
    variants: [{ id: 'v1', label: 'Base', text: `My ${lang} is solid.` }],
  }));

  it('are three different words to the matcher', () => {
    expect(questionSimilarity('C# Skill Proficiency Levels', 'C Skill Proficiency Levels')).toBeLessThan(1);
    expect(questionSimilarity('C++ Skill Proficiency Levels', 'C Skill Proficiency Levels')).toBeLessThan(1);
    expect(questionSimilarity('C# Skill Proficiency Levels', 'C++ Skill Proficiency Levels')).toBeLessThan(1);
  });

  it('each find their own answer, in any order in the bank', () => {
    for (const order of [bank, [...bank].reverse()]) {
      for (const lang of ['C', 'C#', 'C++']) {
        expect(matchAnswer(`${lang} Skill Proficiency Levels`, order).item?.id).toBe(lang);
        // Worded past `sameQuestion`, so found by score alone.
        expect(matchAnswer(`Please rate your ${lang} skill proficiency levels`, order).item?.id).toBe(lang);
      }
    }
  });

  it('and C# asked is never confidently answered with C', () => {
    const m = matchAnswer('Please rate your C# skill proficiency levels', [bank[0]!]);
    expect(m.confident).toBe(false);
  });
});

describe('matchAnswers', () => {
  it('matches each question as matchAnswer does, sensitive ones and stored identifiers included', () => {
    const bank: AnswerBankItem[] = [
      ...SAMPLE_ANSWERS,
      {
        id: 'dob',
        question: 'Anything else we should know?',
        default: 'v1',
        variants: [{ id: 'v1', label: 'Base', text: 'DOB: 04/02/1999' }],
      },
    ];
    const qs = [
      ...bank.map((b) => b.question),
      'What is your Social Security number?',
      'Anything else we should know?',
      'Why us?',
    ];
    const one = qs.map((q) => matchAnswer(q, bank, { company: 'Acme' }));
    expect(matchAnswers(qs, bank, { company: 'Acme' })).toEqual(one);
    expect(matchAnswers(qs, bank, 0.3)).toEqual(qs.map((q) => matchAnswer(q, bank, 0.3)));
  });
});

/*
 * Two answers filed under one item by one completion.
 *
 * A completion files everything it holds in one go, so two answers taken
 * from the same bank item (a form asking the question twice, long and short)
 * both got `v_<now>`, the same millisecond. The default then named the first
 * of the two rather than the one just filed, and the editor, which finds the
 * version to change by its id, wrote an edit of one over both.
 */
describe('two answers filed under one item in the same millisecond', () => {
  it('get ids of their own, and the last one filed leads', () => {
    const bank: AnswerBankItem[] = [
      { id: 'why_us', question: 'Why do you want to work here?', default: 'v_1', variants: [{ id: 'v_1', label: 'Initech', text: 'About Initech.' }] },
    ];
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      for (const answer of ['Because Acme builds compilers I use daily.', 'Compilers.']) {
        fileSentAnswer(bank, { question: 'Why do you want to work here?', answer, fromAnswerId: 'why_us', label: 'Acme', unread: false, newId: () => 'new' });
      }
    } finally {
      clock.mockRestore();
    }
    const item = bank[0]!;
    const ids = item.variants.map((v) => v.id);
    expect(new Set(ids).size, ids.join(', ')).toBe(3);
    expect(item.variants.find((v) => v.id === item.default)?.text).toBe('Compilers.');
  });
});

/*
 * An answer that names a date stops being true when the date goes by. The
 * bank keeps no record of when an answer was filed, so "November 2026",
 * banked as an earliest start date in October, was filled in unread on a form
 * the next March. Once its date has passed it is offered to be read, not
 * filled in; a date still to come is as good as it was.
 */
describe('an answer whose date has passed', () => {
  const bank = (): AnswerBankItem[] => {
    const items: AnswerBankItem[] = [];
    fileSentAnswer(items, { question: 'What is your earliest start date?', answer: 'November 2026', label: 'Helios Systems', unread: false, newId: () => 'start' });
    fileSentAnswer(items, { question: 'When are you available to start?', answer: 'Available from 1 December 2026', label: 'Helios Systems', unread: false, newId: () => 'avail' });
    return items;
  };
  const at = (when: Date, run: () => void) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(when);
      run();
    } finally {
      vi.useRealTimers();
    }
  };

  it('is offered, not filled in, once the date is behind us', () => {
    at(new Date(2027, 2, 1, 12), () => {
      for (const q of ['What is your earliest start date?', 'When are you available to start?']) {
        const m = matchAnswer(q, bank(), { company: 'Orbital Labs' });
        expect(m.answer, q).toBeTruthy();
        expect(m.confident, q).toBe(false);
      }
    });
  });

  it('is filled in as before while the date is still to come', () => {
    at(new Date(2026, 9, 12, 12), () => {
      for (const q of ['What is your earliest start date?', 'When are you available to start?']) {
        expect(matchAnswer(q, bank(), { company: 'Orbital Labs' }).confident, q).toBe(true);
      }
    });
  });

  /*
   * Only a start date goes stale. A graduation date in the past is still the
   * day somebody graduated, and an answer to it is as good as it ever was.
   */
  it('is still filled in when the question asks about something that happened', () => {
    at(new Date(2027, 2, 1, 12), () => {
      const items: AnswerBankItem[] = [];
      fileSentAnswer(items, { question: 'Expected graduation date?', answer: 'May 2024', label: 'Helios Systems', unread: false, newId: () => 'grad' });
      fileSentAnswer(items, { question: 'Start date', answer: 'June 2023', label: 'Helios Systems', unread: false, newId: () => 'job' });
      expect(matchAnswer('Expected graduation date?', items, { company: 'Orbital Labs' }).confident).toBe(true);
      expect(matchAnswer('Start date', items, { company: 'Orbital Labs' }).confident).toBe(true);
    });
  });

  it('knows a question about starting from one about the past', () => {
    for (const q of [
      'What is your earliest start date?',
      'When can you start?',
      'When are you available to start?',
      'Available from',
      'Availability',
      'Desired start date',
      'Joining date',
      'When does your notice period end?',
      'When could you begin work?',
      'Internship start date',
    ]) {
      expect(asksWhenYouStart(q), q).toBe(true);
    }
    for (const q of ['Expected graduation date?', 'Start date', 'End date', 'When did you graduate?', 'Date of your last promotion']) {
      expect(asksWhenYouStart(q), q).toBe(false);
    }
  });

  it('reads the dates written in the ordinary ways, against the local day', () => {
    const now = new Date(2026, 10, 15, 0, 5); // five past midnight, 15 Nov, local
    for (const text of ['October 2026', 'Oct. 2026', 'Sept 2026', '14 November 2026', 'Nov 14th, 2026', 'November 14, 2026', '2026-11-14', '11/14/2026', '14/11/2026']) {
      expect(namesPassedDate(text, now), text).toBe(true);
    }
    // A month and a year covers the month; today is not yet past; nor are
    // things that are not a day on a calendar.
    for (const text of ['November 2026', '15 November 2026', '2026-11-15', 'Dec. 2026', 'Immediately', 'Two weeks notice', '2025', 'January 5th', '']) {
      expect(namesPassedDate(text, now), text).toBe(false);
    }
  });

  /*
   * The same cases as JobHelper's tests/remembering.mjs, for the same words:
   * the two regexes are kept identical, and so are the questions they are
   * held to. "Availability" in a sentence asked about weekends, overtime and
   * travel as often as about starting, and the common ways of asking when,
   * how soon or what date were not read at all.
   */
  const ASKS_WHEN_YOU_START_CASES: [string, boolean][] = [
    ['What date can you start?', true],
    ['When is the earliest you could start?', true],
    ['How soon can you start?', true],
    ['How soon could you join?', true],
    ['Date available', true],
    ['Date available for employment', true],
    ['If offered, what date could you start?', true],
    ['Wann können Sie anfangen?', true],
    ['Eintrittsdatum', true],
    ['Date de début', true],
    ['Date de disponibilité', true],
  ['Disponibilité', true],
  ['Disponibilité :', true],
  ['Disponibilité à partir du', true],
  ['Disponible à partir de quand ?', true],
  ['Disponibilité pour commencer', true],
  ['Votre disponibilité pour débuter le poste', true],
  ['Votre disponibilité', true],
  ['Quelle est votre disponibilité ?', true],
  ['Disponibilité (date)', true],
  ['Disponibilité / préavis', true],
  ['Disponibilité et préavis', true],
  ['À partir de quand êtes-vous disponible ?', true],
  ['Votre disponibilité le week-end', false],
  ['Quelle est votre disponibilité pour les déplacements ?', false],
  ['Disponibilité le week-end', false],
  ['Disponibilité pour les déplacements', false],
  ['Êtes-vous disponible le soir et le week-end ?', false],
    ['Fecha de inicio', true],
    ['¿Cuándo puede empezar?', true],
    ['Availability', true],
    ['What is your availability to work weekends?', false],
    ['Please describe your availability for overtime', false],
    ['Do you have any availability constraints for travel?', false],
    ['Start date', false],
    ['Job start date', false],
    ['End date', false],
  // Round 24: the rest of what German, Spanish, Portuguese, Dutch and Japanese forms ask.
  ['Gewünschtes Startdatum', true],
  ['Startdatum', true],
  ['Verfügbar ab', true],
  ['Wann könnten Sie bei uns anfangen?', true],
  ['Disponibilidad para incorporarse', true],
  ['Data de início', true],
  ['Quando você pode começar?', true],
  ['Quando pode começar?', true],
  ['Per wanneer ben je beschikbaar?', true],
  ['Beschikbaar vanaf', true],
  ['Gewenste startdatum', true],
  ['入社可能日', true],
  ['入社希望日', true],
  ['Verfügbarkeit am Wochenende', false],
  ['Disponibilidad para viajar', false],
  ['Geburtsdatum', false],
  ];
  it('reads the common ways of asking when somebody can start, and not availability for other things', () => {
    for (const [q, asks] of ASKS_WHEN_YOU_START_CASES) expect(asksWhenYouStart(q), q).toBe(asks);
  });

  /*
   * Round 24: a month as German, French, Spanish, Portuguese and Dutch forms
   * write it, and as Japanese does. "Juni 2025" for "Gewünschtes Startdatum"
   * was no date at all, and a start eighteen months gone was offered as good.
   * JobHelper's remembering.mjs asks the same of `onlyAPassedDate`.
   */
  it('reads a month written in another language, or in Japanese, as a date that passes', () => {
    const now = new Date(2026, 9, 12, 12);
    for (const text of ['Juni 2025', 'juin 2025', 'junio de 2025', 'junho de 2025', 'juni 2025', 'mei 2025', 'März 2026', 'août 2026', '2025年6月', '1. Juni 2025', '15 de junio de 2025', '2026年9月30日']) {
      expect(namesPassedDate(text, now), text).toBe(true);
    }
    for (const text of ['Juni 2027', 'juillet 2027', 'Oktober 2026', '2026年10月', 'diciembre de 2026']) {
      expect(namesPassedDate(text, now), text).toBe(false);
    }
    expect(asksWhenYouStart('Gewünschtes Startdatum') && namesPassedDate('Juni 2025', now)).toBe(true);
  });

  it('reads a season and a numeric month as dates that pass', () => {
    const now = new Date(2026, 9, 12, 12); // 12 October 2026, local
    // A season runs to the end of its last month, and Winter into the next year.
    for (const text of ['Fall 2025', 'Autumn 2025', 'Summer 2026', 'Spring 2026', 'Winter 2025', 'Available from 11/2025', '2025-11', '09/2026']) {
      expect(namesPassedDate(text, now), text).toBe(true);
    }
    for (const text of ['Fall 2026', 'Winter 2026', '10/2026', '2026-10', '2026-11-05']) {
      expect(namesPassedDate(text, now), text).toBe(false);
    }
  });

  /*
   * An answer names a past date for reasons of its own, and only the latest
   * one it names says whether it still holds. A start given from today never
   * passes. And "05/11/2026" is the fifth of November as much as the eleventh
   * of May: it is stale only once both have gone.
   */
  it('is judged by the latest date it names', () => {
    const now = new Date(2026, 9, 12, 12);
    for (const text of [
      'Immediately',
      'Two weeks’ notice',
      'One month\'s notice',
      'Between May 2026 and February 2027',
      'Available from 05/11/2026',
      '01/12/2026',
    ]) {
      expect(namesPassedDate(text, now), text).toBe(false);
    }
    for (const text of ['Between May 2026 and August 2026', '05/09/2026', '13/09/2026', '09/13/2026']) {
      expect(namesPassedDate(text, now), text).toBe(true);
    }
    at(new Date(2026, 9, 12, 12), () => {
      const items: AnswerBankItem[] = [];
      fileSentAnswer(items, { question: 'When can you start?', answer: 'Two weeks’ notice', label: 'Helios Systems', unread: false, newId: () => 'now' });
      expect(matchAnswer('When can you start?', items, { company: 'Orbital Labs' }).confident).toBe(true);
    });
  });

  /*
   * A start from today excused every date beside it, so a notice counted
   * from a day eighteen months gone was offered as good, unread. It holds
   * only when the answer names no date at all; one that does is judged by its
   * dates — the August in "Immediately; I left my last role in August 2026"
   * included, which is the price of it.
   */
  it('judges an answer that starts from today by the dates it names beside it', () => {
    const now = new Date(2026, 9, 12, 12);
    for (const text of [
      'Available from 1 March 2025, after two weeks\' notice',
      'I can start on 3 March 2025 with 2 weeks notice',
      'Available from 1 March 2025, after one month\'s notice',
      'Immediately after my contract ends on 31 March 2025',
      'ASAP after graduating in May 2025',
      'Immediately; I left my last role in August 2026',
      'Two weeks’ notice; my contract ended in May 2026',
    ]) {
      expect(namesPassedDate(text, now), text).toBe(true);
    }
    expect(namesPassedDate('Two weeks’ notice from 1 December 2026', now)).toBe(false);
    at(new Date(2026, 9, 12, 12), () => {
      const items: AnswerBankItem[] = [];
      fileSentAnswer(items, { question: 'When can you start?', answer: 'Available from 1 March 2025, after one month\'s notice', label: 'Helios Systems', unread: false, newId: () => 'then' });
      expect(matchAnswer('When can you start?', items, { company: 'Orbital Labs' }).confident).toBe(false);
    });
  });
});

const one = (id: string, question: string, text: string): AnswerBankItem => ({
  id,
  question,
  default: 'v',
  variants: [{ id: 'v', label: 'Chosen on a form', text }],
});

/*
 * A radio group whose question the extension could not find banked its first
 * option as the question. These are the owner's own rows, as banked.
 */
describe('a row whose question is one of the answers', () => {
  const junk = [
    one('a', 'Yes Required', 'No'),
    one('b', "No, I don't have an agreement Required", 'Yes, I have an agreement'),
    one('c', 'Yes, and I would require relocation assistance Required', 'Yes, but I am planning to relocate on my own'),
    one('d', 'Yes, I live in the U.S.', 'Yes, I live in the U.S.'),
    one('e', 'No, I opt-out Required', 'Yes, I opt-in'),
    one('f', 'CA - Irvine', 'CA - Irvine'),
  ];

  it('is never offered, asked by its own words or by a question near them', () => {
    for (const q of [
      'Yes Required',
      "No, I don't have an agreement",
      'Yes, and I would require relocation assistance',
      'Yes, I live in the U.S.',
      'CA - Irvine',
      'Do you have an agreement?',
      'Would you require relocation assistance?',
    ]) {
      const m = matchAnswer(q, junk);
      expect(m.item, q).toBeUndefined();
      expect(m.confident, q).toBe(false);
    }
    expect(matchAnswers(['Yes Required', 'CA - Irvine'], junk).every((m) => !m.item)).toBe(true);
  });

  it('never looks up an option as a question, whatever the bank holds', () => {
    const bank = [one('real', 'Yes', 'No')];
    expect(matchAnswer('Yes', bank).item).toBeUndefined();
    expect(matchAnswer('No, I was NEVER a government employee.', [one('g', 'No, I was NEVER a government employee.', 'Yes')]).item).toBeUndefined();
  });

  it('leaves real questions that open with an answer word alone', () => {
    const bank = [
      one('h', 'Yes or no: are you authorized to work in the US?', 'Yes'),
      one('i', 'Are you willing to relocate?', 'Yes'),
    ];
    expect(matchAnswer('Yes or no: are you authorized to work in the US?', bank).confident).toBe(true);
    expect(matchAnswer('Are you willing to relocate?', [...junk, ...bank]).confident).toBe(true);
  });
});

/*
 * "— Please Specify —" banked as the answer to "Willingness to Travel" and
 * "Candidate Source", the prompt of a dropdown left on it.
 */
describe('a dropdown prompt kept as an answer', () => {
  it('is never offered, and an item with a real answer besides keeps that one', () => {
    const bank: AnswerBankItem[] = [
      one('travel', 'Willingness to Travel', '— Please Specify —'),
      one('source', 'Candidate Source', '- Select -'),
      {
        id: 'hear',
        question: 'How did you hear about us?',
        default: 'v1',
        variants: [
          { id: 'v1', label: 'Chosen on a form', text: '[Select]' },
          { id: 'v2', label: 'Chosen on a form', text: 'LinkedIn' },
        ],
      },
    ];
    expect(matchAnswer('Willingness to Travel', bank).item).toBeUndefined();
    expect(matchAnswer('Candidate Source', bank).item).toBeUndefined();
    const hear = matchAnswer('How did you hear about us?', bank);
    expect(hear.answer).toBe('LinkedIn');
    expect(hear.confident).toBe(true);
  });
});

/*
 * Furniture — "position", "company", "min", "above" — forgiven on both sides
 * made different questions one question.
 */
describe('questions the furniture made the same', () => {
  const ask = (asked: string, stored: string, text = 'An answer', company?: string) =>
    matchAnswer(asked, [one('s', stored, text)], { company });

  it('does not answer a ceiling with a floor', () => {
    for (const [stored, asked] of [
      ['Minimum salary expectation', 'Maximum salary expectation'],
      ['Desired salary (minimum)', 'Desired salary (maximum)'],
      ['Minimum hourly rate', 'Maximum hourly rate'],
      ['Is your cumulative GPA above 3.5?', 'Is your cumulative GPA below 3.5?'],
      ['Are you able to lift 50 pounds or above?', 'Are you able to lift 50 pounds or below?'],
      ['Desired salary', 'Desired salary (maximum)'],
    ]) {
      expect(ask(asked!, stored!).confident, `${asked} <- ${stored}`).toBe(false);
    }
  });

  it('still forgives a length limit, and a floor the stored question said and the page did not', () => {
    expect(ask('Why do you want to work here? (500 characters max)', 'Why do you want to work here?').confident).toBe(true);
    expect(ask('Why do you want to work here? (Maximum 300 words)', 'Why do you want to work here?').confident).toBe(true);
    expect(ask('Are you available for a 12 week internship?', 'Are you available for a minimum 12 week internship?', 'Yes').confident).toBe(true);
    expect(ask('Minimum salary expectation', 'Minimum salary expectation').confident).toBe(true);
  });

  it('does not answer a role with a company, or a company with a role', () => {
    for (const [stored, asked] of [
      ['Most recent employer', 'Most recent role'],
      ['Most recent company', 'Most recent position'],
      ['Current job title', 'Current employer'],
      ['Current position', 'Current company'],
      ['Current company', 'Current position'],
      ['Current company', 'Current team'],
    ]) {
      expect(ask(asked!, stored!, 'Storm Flag Games').confident, `${asked} <- ${stored}`).toBe(false);
    }
  });

  it('does not take a tick box’s "No" for the answer to a label', () => {
    expect(ask('Current position', 'Is current position?', 'No').confident).toBe(false);
  });

  it('still matches the same thing named the same way, or as a stand-in', () => {
    expect(ask('Current employer', 'Current Company/Employer', 'Cryptic Vector').confident).toBe(true);
    expect(ask('Company', 'Company *', 'IndieCade').confident).toBe(true);
    expect(ask('How did you hear about this position?', 'How did you hear about our company?', 'LinkedIn').confident).toBe(true);
    expect(ask('Why are you interested in this role at our company? (500 characters max)', 'Why are you interested in this role?').confident).toBe(true);
  });
});

/*
 * The employer's name was a free word wherever it was added, so a question
 * about these people was answered with what was said about anybody.
 */
describe('the employer named where the stored question named nobody', () => {
  const ask = (asked: string, stored: string, text: string) => matchAnswer(asked, [one('s', stored, text)], { company: 'Acme' });

  it('is a word the stored question did not answer', () => {
    expect(ask('Are you currently employed at Acme?', 'Are you currently employed?', 'Yes').confident).toBe(false);
    expect(ask('Have you applied to Acme before?', 'Have you applied before?', 'No').confident).toBe(false);
    expect(ask('Are you willing to relocate to Acme?', 'Are you willing to relocate?', 'Yes').confident).toBe(false);
    expect(ask('Are you currently enrolled in school at Acme?', 'Are you currently enrolled in school?', 'Yes').confident).toBe(false);
  });

  it('and is still free where the stored question stood in for them', () => {
    expect(ask('Have you worked with Acme before?', 'Have you worked with us before? (required)', 'No').confident).toBe(true);
    expect(ask('Have you worked for Acme before?', 'Have you worked for this company before?', 'No').confident).toBe(true);
    // "the US" is a country, not a stand-in.
    expect(ask('Are you authorized to work at Acme?', 'Are you authorized to work in the US?', 'Yes').confident).toBe(false);
  });
});
