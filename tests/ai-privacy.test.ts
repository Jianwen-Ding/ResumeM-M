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
import { answersForAi } from '../src/ai/privacy.js';
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
