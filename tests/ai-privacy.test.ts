import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeTempStore } from './helpers.js';
import { resolveResume } from '../src/model/resolve.js';
import {
  answerPrompt,
  applicationWritingPrompt,
  coverLetterPrompt,
  feedbackPrompt,
} from '../src/ai/prompts.js';
import { collectSamples } from '../src/ai/voice.js';
import { answersForAi, personalDetailIn } from '../src/ai/privacy.js';
import { wireUp } from '../src/mcp/launch.js';
import { build, type SessionFile } from '../src/mcp/main.js';
import { WritingSession } from '../src/mcp/writing.js';
import type { AnswerBankItem, StoreData } from '../src/model/types.js';

/*
 * Self-identification answers and private details, kept away from the AI.
 *
 * The bank refuses to save "What is your Veterans Status?" now, but a bank
 * written before that rule still holds it, and every AI-facing read of the
 * bank pasted it into prompts and handed it to `find_my_answers`. And the
 * session file in the AI's working directory held the whole store: phone,
 * email, the autofill block, the tracker, every draft.
 */

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const VETERAN = 'What is your Veterans Status?';
const HISPANIC = 'Are you Hispanic/Latino?';
const VETERAN_ANSWER = 'I am a protected veteran who served in the Marine Corps for many years, honourably discharged.';
const HISPANIC_ANSWER = 'Yes, I identify as Hispanic or Latino, of Puerto Rican heritage on my mother’s side of the family.';

const sensitive = (): AnswerBankItem[] => [
  { id: 'a_vet', question: VETERAN, default: 'v1', variants: [{ id: 'v1', label: 'v1', text: VETERAN_ANSWER }] },
  { id: 'a_hisp', question: HISPANIC, default: 'v1', variants: [{ id: 'v1', label: 'v1', text: HISPANIC_ANSWER }] },
  {
    id: 'a_mixed',
    question: 'Why do you want to work at Helios?',
    default: 'v2',
    variants: [
      { id: 'v1', label: 'v1', text: 'Because I love streaming systems and Helios builds the best ones in robotics today.' },
      { id: 'v2', label: 'v2', text: 'Reach me any time; my SSN is 123-45-6789 if you need it for the background check.' },
    ],
  },
];

function storeData(): StoreData {
  const t = makeTempStore();
  try {
    const data = t.store.load();
    data.answers = [
      ...sensitive(),
      // Contact details the bank keeps for forms, which no model needs.
      { id: 'a_addr', question: 'What is your current full address?', default: 'v1', variants: [{ id: 'v1', label: 'Typed', text: '12 Elm Street, Apt 4, Springfield' }] },
      { id: 'a_loc', question: 'Location (required) df15e425', default: 'v1', variants: [{ id: 'v1', label: 'Typed', text: '12 Elm Street Springfield ZZ' }] },
      { id: 'a_line', question: 'Address Line1', default: 'v1', variants: [{ id: 'v1', label: 'Typed', text: 'Flat 9 Hidden Mews' }] },
      { id: 'a_phone', question: 'Best number to reach you', default: 'v1', variants: [{ id: 'v1', label: 'Typed', text: '+1 (617) 555-0199' }] },
      ...data.answers,
    ];
    data.profile = {
      ...data.profile,
      location: 'Springfield, ZZ',
      autofill: { ...(data.profile.autofill ?? {}), address: '12 Elm Street, Apt 4', gpa: '3.91' },
    };
    data.applications = [
      { id: 'app_globex', company: 'Globex Secretcorp', role: 'Engineer', status: 'applied', notes: 'recruiter Jane' } as StoreData['applications'][number],
    ];
    data.drafts = [
      {
        id: 'd_other',
        company: 'Initech Hiddenco',
        role: 'Engineer',
        coverLetter: { required: true, body: 'Dear Initech Hiddenco, a draft for another employer.' },
        questions: [],
      } as unknown as StoreData['drafts'][number],
    ];
    return data;
  } finally {
    t.cleanup();
  }
}

const JOB = { company: 'Helios Robotics', jobTitle: 'Platform Engineer', jobDescription: 'Kafka and Go.' };

function expectClean(text: string) {
  expect(text).not.toContain(VETERAN);
  expect(text).not.toContain(HISPANIC);
  expect(text).not.toContain(VETERAN_ANSWER);
  expect(text).not.toContain(HISPANIC_ANSWER);
  expect(text).not.toContain('123-45-6789');
  expect(text).not.toContain('Hidden Mews');
  expect(text).not.toContain('555-0199');
  expect(text).not.toContain('12 Elm Street');
}

describe('the answer bank, as an AI reads it', () => {
  it('drops self-identification questions and phrasings that carry an identifier', () => {
    const kept = answersForAi(sensitive());
    expect(kept.map((a) => a.id)).toEqual(['a_mixed']);
    expect(kept[0]!.variants.map((v) => v.id)).toEqual(['v1']);
    // The default went with the phrasing that was taken out.
    expect(kept[0]!.default).toBe('v1');
  });

  it('keeps them out of every prompt built from the bank', () => {
    const data = storeData();
    const resume = resolveResume('base', data);
    const prompts = [
      feedbackPrompt(data, resume),
      answerPrompt(data, 'What is your veteran status?', JOB),
      answerPrompt(data, 'Are you Hispanic or Latino?', JOB),
      coverLetterPrompt(data, resume, JOB, []),
      coverLetterPrompt(data, resume, JOB, [], { tools: true }),
      applicationWritingPrompt(data, resume, JOB, { questions: [{ question: 'Please state your veteran status' }, { question: 'Are you Hispanic or Latino?' }] }),
    ];
    for (const p of prompts) expectClean(p);
    // And the bank is still there for everything else.
    expect(prompts[0]).toContain('Why do you want to work at Helios?');
    expectClean(JSON.stringify(collectSamples(data)));
  });

  it('does not hand them over through find_my_answers or check_claim', () => {
    const data = storeData();
    const resume = resolveResume('base', data);
    const posting = { company: 'Helios Robotics', description: 'Kafka.' };
    const draft = { coverLetter: { required: true, body: '' }, questions: [] };

    // Built straight from a whole store, the way an older caller would.
    const direct = new WritingSession(data, resume, posting, draft, '');
    expectClean(direct.findAnswers(VETERAN, 5));
    expectClean(direct.findAnswers(HISPANIC, 5));
    expectClean(JSON.stringify(direct.checkClaim('served in the Marine Corps as a protected veteran')));

    // And through the tool, as the CLI calls it.
    const { tools } = build({ kind: 'write', data, resume, posting, draft, out: '/dev/null' } as SessionFile);
    const find = tools.find((t) => t.name === 'find_my_answers')!;
    return Promise.all(
      [VETERAN, HISPANIC].map(async (question) => expectClean(JSON.stringify(await find.run({ question, limit: 5 })))),
    );
  });
});

describe('the session file in the AI’s working directory', () => {
  const sandbox = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmm-privacy-'));
    made.push(dir);
    return dir;
  };

  const written = (kind: 'tailor' | 'write' | 'author') => {
    const data = storeData();
    const resume = resolveResume('base', data);
    const dir = sandbox();
    // Handed the whole store, as every caller used to: the file must not be.
    wireUp(
      dir,
      'claude',
      {
        kind,
        data,
        resume,
        posting: { company: 'Helios Robotics', description: 'Kafka.' },
        draft: { coverLetter: { required: true, body: '' }, questions: [] },
        resumeText: 'Test Person',
        documents: [],
        existing: { entryIds: [], bulletIds: [], skillGroups: [] },
      },
      '/somewhere/bin.js',
    );
    const raw = fs.readFileSync(path.join(dir, 'tailor-session.json'), 'utf8');
    return { raw, file: JSON.parse(raw) as SessionFile & Record<string, unknown> };
  };

  for (const kind of ['tailor', 'write', 'author'] as const) {
    it(`holds no contact details, autofill, tracker or other drafts for a ${kind} session`, () => {
      const { raw, file } = written(kind);
      for (const secret of ['555-0100', 'test@example.com', '12 Elm Street', 'Hidden Mews', '555-0199', '3.91', 'Springfield, ZZ', 'Globex Secretcorp', 'recruiter Jane', 'Initech Hiddenco', 'autofill']) {
        expect(raw).not.toContain(secret);
      }
      expect(Object.keys(file.data ?? {}).sort()).toEqual(
        kind === 'tailor' ? ['entries', 'resumes', 'skillGroups'] : kind === 'write' ? ['answers', 'coverLetters'] : [],
      );
      expectClean(raw);
      expect(raw).not.toContain('"config"');
      expect(raw).not.toContain('"applications"');
      expect(raw).not.toContain('"drafts"');
      expect(raw).not.toContain('"profile":{"name":"Test Person","');
    });
  }

  it('still builds each kind of session from what it was given', () => {
    for (const kind of ['tailor', 'write', 'author'] as const) {
      const { file } = written(kind);
      const { tools } = build(file);
      expect(tools.length).toBeGreaterThan(0);
    }
    const { file } = written('tailor');
    expect(file.resume?.profile).toEqual({ name: 'Test Person' });
  });
});

/*
 * What the writing session refuses to save, and what it must not.
 *
 * The phone shape read any ten digits with dots and dashes between as a phone
 * number, so a DOI, an ORCID iD, a LinkedIn or commit address, a requisition
 * number, "1.000.000.000" and a version string were refused — the link being
 * the whole answer to "Website". The street shape read "mentored 3 Junior
 * Engineers to drive" as an address, and `git@github.com:` as an email.
 */
describe('personalDetailIn', () => {
  it.each([
    'My paper (https://doi.org/10.1145/3292500.3330701) introduced the method.',
    'DOI: 10.1145/3292500.3330701',
    'arXiv:2310.12345 describes it',
    'ORCID: 0000-0002-1825-0097',
    'https://orcid.org/0000-0002-1825-0097',
    'https://www.linkedin.com/in/jane-doe-1234567890',
    'linkedin.com/in/jane-doe-1234567890',
    'https://github.com/jane/repo/commit/1234567890abcdef',
    'git@github.com:jane/repo.git',
    'I am applying for requisition 2024-0012345 posted on your site.',
    'We processed 1.000.000.000 events a day.',
    'served 1 234 567 890 requests',
    'Python 3.11.4 2023.10.1 versions',
    'Between 2015 and 2019, 2020 2021 2022 were busy.',
    'I mentored 3 Junior Engineers to drive the migration.',
    'I grew the team to 12 Data Scientists in a way that scaled.',
    'At Google I led 4 Senior Engineers to drive adoption.',
    'I led 4 engineers to drive adoption.',
    'Req ID: 2024 0012345',
    // Figures and identifiers in a phone's digit count, refused once two
    // spaced groups stopped reading as a requisition.
    'ISBN 978 0 13 468599 1',
    'batch 4096 8192 16384',
    'ports 8080 8443 9090',
    'order 10000 20000',
    'IDs 12345 67890',
    'tickets 00123 45678',
    'revenue grew 100000 200000',
    'Order no. 98765 43210',
    'orders # 98765 43210',
    'Raised 10000 20000 dollars',
  ])('lets through %j', (text) => {
    expect(personalDetailIn(text)).toBeNull();
  });

  it.each([
    ['Call me at (555) 555-5555.', 'a phone number'],
    ['+1 415 555 1234', 'a phone number'],
    ['Reach me on 415.555.1234.', 'a phone number'],
    ['phone: 415-555-1234 anytime', 'a phone number'],
    ['My number is 4155551234', 'a phone number'],
    ['call 415 555 1234 2 times', 'a phone number'],
    ['Tel.415.555.1234', 'a phone number'],
    ['415-555-1234x22', 'a phone number'],
    ['Reach me at 555-555-5555 or https://github.com/jane', 'a phone number'],
    ['someone@example.edu', 'an email address'],
    ['Email me@example.com: thanks', 'an email address'],
    ['https://example.com/?contact=jane@example.com', 'an email address'],
    ['I live at 123 Main Street.', 'a street address'],
    ['I live at 221B Baker Street.', 'a street address'],
    // Phones written in threes after a country code, which read as a figure.
    ['+34 912 345 678', 'a phone number'],
    ['+31 612 345 678', 'a phone number'],
    // Two groups with a space between, which read as a requisition.
    ['07700 900123', 'a phone number'],
    ['Call 98765 43210 after six.', 'a phone number'],
    ['030 12345678', 'a phone number'],
    ['+49 (0)30 1234567', 'a phone number'],
    ['+44 (0) 20 7946 0958', 'a phone number'],
    // Exactly a phone's shape with a country code, whatever it says around it.
    ['grew revenue by +1 234 567 890', 'a phone number'],
    // A one-digit group straight after a country code, which read as an ISBN's.
    ['Mobile +33 6 12 34 56 78', 'a phone number'],
    ['Call me +33 1 42 68 53 00', 'a phone number'],
    ['Mobile +61 4 1234 5678', 'a phone number'],
    ['Phone +61 2 9876 5432', 'a phone number'],
    // After an everyday word that the list of naming words had in it.
    ['Text me about the job 07700 900123', 'a phone number'],
    ['For the job: 98765 43210', 'a phone number'],
    ['Reach me in any case 07700 900123', 'a phone number'],
    ['Item: 98765 43210', 'a phone number'],
    ['Ref: 07700 900123', 'a phone number'],
    ['Contact re PR 07700 900123', 'a phone number'],
    // A trunk 0 is a phone's whatever word is in front.
    ['IDs 07700 900123', 'a phone number'],
    // "00" in place of the "+", and an Indian mobile that read as round figures.
    ['Call 0049 1520 1234 5678', 'a phone number'],
    ['Call 90000 80000', 'a phone number'],
  ])('refuses %j', (text, what) => {
    expect(personalDetailIn(text)).toBe(what);
  });

  it('refuses a national number', () => {
    expect(personalDetailIn('my SSN is 123-45-6789')).toMatch(/identifier/);
  });
});
