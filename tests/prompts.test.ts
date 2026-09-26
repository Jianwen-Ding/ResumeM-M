import { describe, expect, it } from 'vitest';
import {
  answerFeedbackPrompt,
  answerPrompt,
  applicationWritingPrompt,
  bulletFeedbackPrompt,
  coverLetterPrompt,
  feedbackPrompt,
  letterFeedbackPrompt,
  resumeAsText,
  shortenPrompt,
  tailorPrompt,
} from '../src/ai/prompts.js';
import { buildMaster, resolveResume } from '../src/model/resolve.js';
import type { Draft, DraftQuestion } from '../src/model/types.js';
import { makeTempStore } from './helpers.js';

const t = makeTempStore();
const data = t.store.load();
const resolved = resolveResume('newgrad', data);

/** An application in progress, with a letter and a question already written. */
const makeDraft = (over: Partial<Draft> = {}): Draft => ({
  id: 'd_streamly',
  company: 'Streamly',
  role: 'Data Engineer',
  url: 'https://example.com/job',
  createdAt: '2026-02-01T00:00:00.000Z',
  updatedAt: '2026-02-01T00:00:00.000Z',
  status: 'drafting',
  jobDescription: 'Kafka, Go, distributed systems',
  coverLetter: { required: true, body: 'Dear Streamly, I am passionate about synergy and data.' },
  questions: [{ id: 'q1', question: 'Why are you interested in this role?', answer: 'Because it is a role.' }],
  ...over,
});

describe('resumeAsText', () => {
  it('renders sections, entries, and bullets with their ids', () => {
    const text = resumeAsText(resolved);
    expect(text).toContain('Northeastern University');
    expect(text).toContain('[entry:edu_neu]');
    expect(text).toContain('[bullet:b_course');
    expect(text).toContain('## Technical Skills');
  });
});

describe('every prompt', () => {
  const prompts = {
    feedback: feedbackPrompt(data, resolved),
    tailor: tailorPrompt(data, resolved, { jobDescription: 'Kafka and Go' }),
    cover: coverLetterPrompt(data, resolved, { jobDescription: 'Kafka' }, ['a previous letter']),
    answer: answerPrompt(data, 'Why this role?'),
    shorten: shortenPrompt(data, [{ id: 'b', text: 'a bullet' }], 3),
    letterFeedback: letterFeedbackPrompt(data, makeDraft(), []),
    answerFeedback: answerFeedbackPrompt(data, makeDraft(), makeDraft().questions[0]!),
  };

  /*
   * The voice section goes to the prompts that write prose and no further —
   * see `preamble` and tests/voice-where-needed.test.ts. `feedback` and
   * `tailor` are the two here that cannot produce a word of it: one says "do
   * not rewrite", the other "You are selecting, not writing".
   */
  const writesProse = ['cover', 'answer', 'shorten', 'letterFeedback', 'answerFeedback'];

  it('carries the voice notes to the prompts that write, so they are never retyped into a chat', () => {
    for (const name of writesProse) {
      expect(prompts[name as keyof typeof prompts], name).toContain('Plain and direct');
    }
  });

  it('spends nothing on the voice where no prose can come out', () => {
    for (const name of ['feedback', 'tailor']) {
      expect(prompts[name as keyof typeof prompts], name).not.toContain('Plain and direct');
    }
  });

  it('carries the rules against inventing things', () => {
    for (const [name, p] of Object.entries(prompts)) {
      expect(p, name).toMatch(/Never invent experience/);
      expect(p, name).toMatch(/Never inflate a number/);
    }
  });

  /*
   * Asked of a prompt that is shown the voice at all. These used to go through
   * `feedbackPrompt`, which no longer carries it — and against that prompt
   * they would pass for the wrong reason, by finding nothing because there is
   * nothing to find rather than because the fallback works.
   */
  it('falls back to generic guidance when there is no writing to learn from', () => {
    const bare = { ...data, voice: '', coverLetters: [], answers: [], samples: [], entries: [] };
    expect(answerPrompt(bare, 'Why this role?')).toContain('No samples of their writing are stored yet');
  });

  it('shows the person’s own writing instead of a self-description', () => {
    // The point of the change: voice comes from what they actually wrote —
    // a sent letter, here — not from a note describing their style.
    expect(answerPrompt(data, 'Why this role?')).toContain('Dear Acme, here is a letter I wrote before');
    expect(answerPrompt(data, 'Why this role?')).toContain('Match its register, sentence length');
  });
});

describe('feedback prompts', () => {
  it('asks for a critique and explicitly forbids a rewrite', () => {
    const p = feedbackPrompt(data, resolved);
    expect(p).toContain('critique, do not rewrite');
    expect(p).toMatch(/Do NOT produce a rewritten resume/);
  });

  it('passes a focus through when one is given', () => {
    expect(feedbackPrompt(data, resolved, 'the projects section')).toContain('the projects section');
    expect(feedbackPrompt(data, resolved)).not.toContain('specifically wants feedback on');
  });

  it('shows every phrasing when critiquing one bullet', () => {
    const entry = data.entries.find((e) => e.id === 'exp_acme')!;
    const bullet = entry.bullets!.find((b) => b.id === 'b_pipeline')!;
    const p = bulletFeedbackPrompt(data, entry, bullet);
    expect(p).toContain('[v_base]');
    expect(p).toContain('[v_kafka]');
    expect(p).toContain('do not rewrite');
  });
});

describe('feedback understands the master and derived resumes', () => {
  it('gives shared-source context to resume and bullet critiques', () => {
    const entry = data.entries.find(e => e.id === 'exp_acme')!;
    const bullet = entry.bullets![0]!;
    for (const prompt of [feedbackPrompt(data, resolved), bulletFeedbackPrompt(data, entry, bullet)]) {
      expect(prompt).toContain('automatically compiles smaller, tailored resumes');
      // Resumes stopped inheriting; the prompt must not tell the model they do.
      expect(prompt).not.toContain('inherit');
      expect(prompt).toContain('stands alone');
      expect(prompt).toContain('not separate achievements printed together');
      expect(prompt).toContain('does not require deleting it from the master');
    }
  });

  it('critiques every master variant without imposing a submission page budget', () => {
    const prompt = feedbackPrompt(data, buildMaster(data), {
      focus: 'evidence gaps', tex: 'master latex source',
      fit: { pages: 3, fits: false, overflowLines: 20, adjustments: ['shrank text'] },
    });
    expect(prompt).toContain('MASTER DOCUMENT');
    expect(prompt).toContain('no one-page limit');
    expect(prompt).toContain('genuine duplicate claims');
    expect(prompt).toContain('variant:v_base');
    expect(prompt).toContain('variant:v_kafka');
    expect(prompt).toContain('variant:v_short');
    expect(prompt).toContain('evidence gaps');
    expect(prompt).toContain('Master inventory rendering: 3 page(s)');
    expect(prompt).toContain('master latex source');
    expect(prompt).not.toContain('lines too long');
    expect(prompt).not.toContain('Auto-fit had to:');
    expect(prompt).toContain('Never invent experience');
  });

  /*
   * A resume with room to spare is set larger to fill its page, and its
   * adjustments read like shrinking ones. Given as "Auto-fit had to: font
   * 10.5pt → 12pt", they told the critic a short resume was a tight one.
   */
  it('tells the critic a resume set larger had room, not that auto-fit had to squeeze it', () => {
    const fit = { pages: 1, fits: true, overflowLines: -1, adjustments: ['font 10.5pt → 12pt', 'margins 0.45in → 0.75in'] };
    const grown = feedbackPrompt(data, resolved, { fit: { ...fit, grew: true } });
    expect(grown).not.toContain('Auto-fit had to:');
    expect(grown).toContain('room to spare as written');
    expect(grown).toContain('font 10.5pt → 12pt');
    // While one it really squeezed is still said to have been.
    const squeezed = feedbackPrompt(data, resolved, { fit: { ...fit, adjustments: ['font 10.5pt → 10pt'] } });
    expect(squeezed).toContain('Auto-fit had to: font 10.5pt → 10pt.');
  });
});

describe('tailor prompt', () => {
  const p = tailorPrompt(data, resolved, {
    jobTitle: 'Data Engineer',
    company: 'Streamly',
    jobDescription: 'Kafka, Go, distributed systems',
    url: 'https://example.com/job',
  });

  it('lists every phrasing available to choose among', () => {
    expect(p).toContain('[v_kafka]');
    expect(p).toContain('[v_short]');
    expect(p).toContain('skills group');
  });

  it('includes the field alternates, not just bullets', () => {
    expect(p).toContain('field edu_neu.dates');
  });

  it('asks for conservatism in so many words', () => {
    expect(p).toContain('Be conservative');
    expect(p).toMatch(/most choices should stay as they are/);
  });

  it('caps new wording and says an empty list is the expected answer', () => {
    expect(p).toMatch(/at most 3 genuinely new phrasings/);
    expect(p).toMatch(/return an empty list — that is\s*\n?\s*the expected answer/);
  });

  it('specifies the JSON shape it wants back', () => {
    expect(p).toContain('"choices"');
    expect(p).toContain('"suggestions"');
    expect(p).toContain('"reasoning"');
  });

  it('includes the posting details', () => {
    expect(p).toContain('Streamly');
    expect(p).toContain('Data Engineer');
    expect(p).toContain('https://example.com/job');
  });

  it('truncates an enormous description rather than sending it whole', () => {
    const huge = tailorPrompt(data, resolved, { jobDescription: 'x'.repeat(50_000) });
    expect(huge.length).toBeLessThan(40_000);
  });
});

describe('cover letter prompt', () => {
  it('hands over the letters the caller picked out, to adapt rather than imitate', () => {
    const p = coverLetterPrompt(data, resolved, { jobDescription: 'job' }, ['an earlier letter']);
    expect(p).toContain('an earlier letter');
    expect(p).toContain('What you have already written');
    expect(p).toMatch(/adapt it rather than starting over/);
  });

  it('names the company a letter went to, so the model can tell them apart', () => {
    const p = coverLetterPrompt(data, resolved, { jobDescription: 'job' }, [
      {
        id: 'l1',
        title: 'x',
        body: 'A letter body long enough to matter.',
        company: 'Northwind',
        role: 'Intern',
        createdAt: '2026-01-01T00:00:00Z',
      },
    ]);
    expect(p).toContain('Northwind — Intern');
  });

  it('falls back to the letters in the store when the caller picked none', () => {
    const p = coverLetterPrompt(data, resolved, { jobDescription: 'job' }, []);
    expect(p).toContain('Dear Acme, here is a letter I wrote before');
  });

  it('shows the answers they have already given, which often say it better', () => {
    const p = coverLetterPrompt(data, resolved, { jobDescription: 'job' }, []);
    expect(p).toContain('Questions they have answered');
    expect(p).toContain('Because the work is interesting.');
  });

  it('says nothing about previous work when there is none', () => {
    const bare = { ...data, coverLetters: [], answers: [] };
    expect(coverLetterPrompt(bare, resolved, { jobDescription: 'job' }, [])).not.toContain(
      'What you have already written',
    );
  });

  it('bans the opening everyone uses', () => {
    expect(coverLetterPrompt(data, resolved, { jobDescription: 'j' }, [])).toContain(
      'I am writing to express my interest',
    );
  });
});

describe('answer prompt', () => {
  it('offers previously written answers to adapt', () => {
    const p = answerPrompt(data, 'Why this role?');
    expect(p).toContain('What you have already written');
    expect(p).toContain('Because the work is interesting.');
    expect(p).toMatch(/recognisably the same person across a season of applications/);
  });

  it('shows every phrasing of an answer, not only the default one', () => {
    // The alternates are the range this person has already accepted for that
    // question; showing one of them throws that away.
    const p = answerPrompt(data, 'Will you require sponsorship?');
    expect(p).toContain('No');
    expect(p).toContain('Yes');
    expect(p).toContain('— or —');
  });

  it('gives a question the cover letters too, which often say it better', () => {
    const p = answerPrompt(data, 'Why this role?');
    expect(p).toContain('Cover letters they have sent');
    expect(p).toContain('Dear Acme, here is a letter I wrote before');
  });

  it('puts the closest previous question first', () => {
    const p = answerPrompt(data, 'Will you now or in the future require sponsorship?');
    const sponsorship = p.indexOf('require sponsorship for employment');
    const interest = p.indexOf('Why are you interested in this role?');
    expect(sponsorship).toBeGreaterThan(-1);
    expect(sponsorship).toBeLessThan(interest);
  });

  it('omits the section when there is nothing written yet', () => {
    const bare = { ...data, answers: [], coverLetters: [] };
    expect(answerPrompt(bare, 'Q?')).not.toContain('What you have already written');
  });

  it('includes the posting when one is supplied', () => {
    const p = answerPrompt(data, 'Q?', { company: 'Streamly', jobDescription: 'Kafka' });
    expect(p).toContain('Streamly');
  });
});

describe('cover letter feedback prompt', () => {
  it('shows the posting and the letter as written, so the critique is about this one', () => {
    const p = letterFeedbackPrompt(data, makeDraft(), []);
    expect(p).toContain('Streamly');
    expect(p).toContain('Data Engineer');
    expect(p).toContain('Kafka, Go, distributed systems');
    expect(p).toContain('## The letter as written');
    expect(p).toContain('I am passionate about synergy and data');
  });

  it('asks for criticism and forbids handing back a rewrite', () => {
    const p = letterFeedbackPrompt(data, makeDraft(), []);
    expect(p).toContain('critique a cover letter, do not rewrite');
    expect(p).toMatch(/Do NOT rewrite it/);
    expect(p).toMatch(/would fit any applicant writing to any company/);
    expect(p).toMatch(/posting repeated back at them/);
    expect(p).toMatch(/a reader would skim/);
    expect(p).toMatch(/Never supply an achievement, a metric/);
  });

  it('hands over the letters the caller picked, to judge whether it is the same person', () => {
    const p = letterFeedbackPrompt(data, makeDraft(), [
      {
        id: 'l1',
        title: 'x',
        body: 'A letter body long enough to matter.',
        company: 'Northwind',
        role: 'Intern',
        createdAt: '2026-01-01T00:00:00Z',
      },
    ]);
    expect(p).toContain('Northwind — Intern');
    expect(p).toContain('A letter body long enough to matter.');
    expect(p).toMatch(/sounds like the same person/);
  });

  it('falls back to the letters in the store when the caller picked none', () => {
    const p = letterFeedbackPrompt(data, makeDraft(), []);
    expect(p).toContain('Dear Acme, here is a letter I wrote before');
  });

  it('gives it the stored experience, so an unsupported claim can be spotted', () => {
    const p = letterFeedbackPrompt(data, makeDraft(), []);
    expect(p).toContain('What this person has evidence for');
    expect(p).toContain('Built a pipeline handling **2M events/day**');
    expect(p).toContain('Languages: Python, Go');
  });

  it('says plainly there is nothing to review, without inviting a draft', () => {
    const p = letterFeedbackPrompt(data, makeDraft({ coverLetter: { required: true, body: '   ' } }), []);
    expect(p).toContain('nothing to review yet');
    expect(p).toContain('no letter to review yet');
    expect(p).toMatch(/Do not draft one/);
    expect(p).not.toContain('## The letter as written');
    expect(p).not.toContain('Kafka, Go, distributed systems');
  });

  it('clips an enormous letter and an enormous posting rather than sending them whole', () => {
    const bare = { ...data, coverLetters: [], answers: [], samples: [], entries: [], skillGroups: [] };
    const p = letterFeedbackPrompt(
      bare,
      makeDraft({
        jobDescription: 'j'.repeat(50_000),
        coverLetter: { required: true, body: 'x'.repeat(50_000) },
      }),
      [],
    );
    expect(p.length).toBeLessThan(25_000);
    expect(p).toContain('…');
  });

  it('manages a draft that never captured the posting text', () => {
    const p = letterFeedbackPrompt(data, makeDraft({ jobDescription: undefined }), []);
    expect(p).toContain('No posting text was saved');
  });
});

describe('answer feedback prompt', () => {
  const question: DraftQuestion = {
    id: 'q1',
    question: 'Why are you interested in this role?',
    required: true,
    answer: 'Because it is a role, and I am interested in roles.',
  };

  it('shows the question, the answer, and the posting it was written for', () => {
    const p = answerFeedbackPrompt(data, makeDraft(), question);
    expect(p).toContain('## The question (required)');
    expect(p).toContain('Why are you interested in this role?');
    expect(p).toContain('## The answer as written');
    expect(p).toContain('I am interested in roles');
    expect(p).toContain('Streamly');
    expect(p).toContain('Kafka, Go, distributed systems');
  });

  it('asks for criticism and forbids handing back a rewrite', () => {
    const p = answerFeedbackPrompt(data, makeDraft(), question);
    expect(p).toContain('critique one answer, do not rewrite');
    expect(p).toMatch(/Do NOT rewrite it/);
    expect(p).toMatch(/does not answer what was actually asked/);
    expect(p).toMatch(/Never supply an achievement, a metric/);
  });

  it('brings in what they have answered before, closest question first', () => {
    const p = answerFeedbackPrompt(data, makeDraft(), {
      ...question,
      question: 'Will you now or in the future require sponsorship?',
    });
    const sponsorship = p.indexOf('require sponsorship for employment');
    const interest = p.indexOf('## Questions they have answered');
    expect(sponsorship).toBeGreaterThan(-1);
    expect(sponsorship).toBeGreaterThan(interest);
    expect(p).toMatch(/judge consistency, not as material to paste in/);
  });

  it('says plainly there is nothing to review, without answering the question itself', () => {
    const p = answerFeedbackPrompt(data, makeDraft(), { ...question, answer: '  ' });
    expect(p).toContain('nothing to review yet');
    expect(p).toMatch(/Do not answer it/);
    expect(p).not.toContain('## The answer as written');
    expect(p).not.toContain('Kafka, Go, distributed systems');
  });

  it('clips an enormous answer rather than sending it whole', () => {
    const bare = { ...data, coverLetters: [], answers: [], samples: [], entries: [], skillGroups: [] };
    const p = answerFeedbackPrompt(bare, makeDraft({ jobDescription: 'j'.repeat(50_000) }), {
      ...question,
      answer: 'y'.repeat(50_000),
    });
    expect(p.length).toBeLessThan(25_000);
    expect(p).toContain('…');
  });
});

describe('shorten prompt', () => {
  it('says how much has to go and asks to keep the claims', () => {
    const p = shortenPrompt(data, [{ id: 'b1', text: 'a long bullet' }], 3);
    expect(p).toContain('about 3 line(s) too long');
    expect(p).toContain('keeps every concrete claim');
    expect(p).toContain('[b1]');
  });
});

describe('feedback sees the whole picture', () => {
  it('includes the compiled LaTeX and what the compiler said', () => {
    const t = makeTempStore();
    try {
      const data = t.store.load();
      const prompt = feedbackPrompt(data, resolveResume('newgrad', data), {
        tex: '\\documentclass{article}\\begin{document}hi\\end{document}',
        fit: { pages: 2, fits: false, overflowLines: 7, adjustments: ['font 10.5pt → 9.6pt'] },
      });

      expect(prompt).toContain('What it compiles to');
      expect(prompt).toContain('does NOT fit: 2 pages, about 7 lines too long');
      expect(prompt).toContain('font 10.5pt → 9.6pt');
      expect(prompt).toContain('\\documentclass{article}');
    } finally {
      t.cleanup();
    }
  });

  it('truncates a very long document rather than sending all of it', () => {
    const t = makeTempStore();
    try {
      const data = t.store.load();
      const prompt = feedbackPrompt(data, resolveResume('newgrad', data), { tex: 'x'.repeat(40_000) });
      expect(prompt).toContain('truncated');
      expect(prompt.length).toBeLessThan(40_000);
    } finally {
      t.cleanup();
    }
  });

  it('brings in the other resumes, letters, and answered questions', () => {
    const t = makeTempStore();
    try {
      const data = t.store.load();
      const prompt = feedbackPrompt(data, resolveResume('newgrad', data));

      expect(prompt).toContain('What else this person has');
      expect(prompt).toContain('Other resumes they keep');
      expect(prompt).toContain('Summer intern'); // a sibling resume
      expect(prompt).toContain('Recent cover letters');
      // Named, not quoted: a critique can use that the letter exists and who
      // it was for. Its paragraphs were the voice section's job, and the
      // voice section is deliberately not in this prompt. See `preamble`.
      expect(prompt).toContain('SWE Co-op — Acme Co.');
      expect(prompt).toContain('Software Engineer Co-op at Acme Co.');
      expect(prompt).not.toContain('Dear Acme');
      expect(prompt).toContain('Questions they have answered');
      expect(prompt).toContain('Why are you interested in this role?');
    } finally {
      t.cleanup();
    }
  });

  it('still accepts a plain focus string, as older callers pass', () => {
    const t = makeTempStore();
    try {
      const data = t.store.load();
      expect(feedbackPrompt(data, resolveResume('newgrad', data), 'the projects section')).toContain(
        'the projects section',
      );
    } finally {
      t.cleanup();
    }
  });
});

describe('stores that are not shaped like the example', () => {
  const bare = (over: Partial<typeof data> = {}) => ({ ...data, coverLetters: [], answers: [], ...over });

  it('renders an entry with no subtitle and no dates', () => {
    const text = resumeAsText({
      ...resolved,
      sections: [
        {
          kind: 'project',
          heading: 'Projects',
          skillGroups: [],
          entries: [{ id: 'p', kind: 'project' as const, title: 'A thing', bullets: [] }],
        },
      ],
    } as typeof resolved);
    // No stray "— " or "()" where the optional halves of the heading would be.
    expect(text).toContain('### A thing [entry:p]');
    expect(text.split('\n').find((l) => l.startsWith('### '))).toBe('### A thing [entry:p]');
  });

  it('leaves the previous-work section out rather than printing an empty heading', () => {
    expect(answerPrompt(bare(), 'Q?')).not.toContain('What you have already written');
  });

  it('skips a letter with nothing in it and an answer with no phrasings', () => {
    const data2 = bare({
      coverLetters: [{ id: 'l', title: 'Empty', body: '   ', createdAt: '2026-01-01T00:00:00Z' }],
      answers: [{ id: 'a', question: 'Why?', default: 'v', variants: [] }],
    });
    expect(answerPrompt(data2, 'Why?')).not.toContain('What you have already written');
  });

  it('stops adding previous work once the budget is spent', () => {
    const long = 'A sentence that goes on. '.repeat(500);
    const data2 = bare({
      answers: Array.from({ length: 12 }, (_, n) => ({
        id: `a${n}`,
        question: `Question ${n}?`,
        default: 'v',
        variants: [{ id: 'v', label: 'l', text: long }],
      })),
    });
    const prompt = answerPrompt(data2, 'Question 0?');
    // Everything is not an option: the section is cut, not unbounded.
    expect(prompt.length).toBeLessThan(40_000);
    expect(prompt).not.toContain('Question 11?');
  });

  it('answers a question with no posting attached', () => {
    expect(answerPrompt(data, 'Why this role?')).not.toContain('## Posting');
  });

  it('leaves an archived entry and an archived bullet out of what the AI may pick from', () => {
    const entries = data.entries.map((e, n) =>
      n === 0
        ? { ...e, archived: true }
        : { ...e, bullets: (e.bullets ?? []).map((b, i) => (i === 0 ? { ...b, archived: true } : b)) },
    );
    const prompt = tailorPrompt({ ...data, entries }, resolved, { jobDescription: 'Kafka' });
    // The resume itself still shows what it shows; the inventory is what the
    // AI may pick from, and an archived thing is not on offer there.
    expect(prompt).not.toContain('[entry:edu_neu] kind=education');
    expect(prompt).not.toContain('bullet b_pipeline:');
  });
});

describe('when the AI may look things up', () => {
  const researching = { ...data, config: { ...data.config, ai: { ...data.config.ai, research: true } } };

  it('says nothing about it when the setting is off', () => {
    expect(coverLetterPrompt(data, resolved, { jobDescription: 'job', company: 'Acme' }, [])).not.toContain(
      'You may look things up',
    );
  });

  it('invites it to read about the company by name', () => {
    const p = coverLetterPrompt(researching, resolved, { jobDescription: 'job', company: 'Acme' }, []);
    expect(p).toContain('You may look things up');
    expect(p).toContain('Read about Acme');
  });

  it('draws the line that matters: nothing found becomes a claim about them', () => {
    const p = coverLetterPrompt(researching, resolved, { jobDescription: 'job', company: 'Acme' }, []);
    expect(p).toMatch(/never becomes a claim about this person/);
    expect(p).toMatch(/Do not name a fact you are unsure of/);
  });

  it('offers the same to an answer, which has the same temptation', () => {
    const p = answerPrompt(researching, 'Why us?', { company: 'Acme', jobDescription: 'job' });
    expect(p).toContain('Read about Acme');
  });

  it('manages without a company name', () => {
    expect(answerPrompt(researching, 'Why us?')).toContain('Read about the company');
  });
});

describe('saying exactly what a letter and an answer should be', () => {
  const job = { jobDescription: 'Kafka, low latency', company: 'Helios Robotics', jobTitle: 'Backend Engineer' };

  it('tells a coding agent there is no side channel', () => {
    // The observed failure: a CLI wrote a plan file, linked it, asked a
    // question, and all of it was saved as the cover letter.
    const p = coverLetterPrompt(data, resolved, job, []);
    expect(p).toMatch(/Do not write, create or edit any file/);
    expect(p).toMatch(/Do not ask a question/);
    expect(p).toMatch(/arrives as the first line of their letter/);
    expect(p).toMatch(/No markdown/);
  });

  it('says the same to an answer, which runs through the same CLI', () => {
    const p = answerPrompt(data, 'Why this role?', job);
    expect(p).toMatch(/Do not write, create or edit any file/);
    expect(p).toMatch(/arrives as the first line of their answer/);
  });

  it('bans the placeholder, which is worse than the omission', () => {
    for (const p of [coverLetterPrompt(data, resolved, job, []), answerPrompt(data, 'Why?', job)]) {
      expect(p).toMatch(/Never leave a placeholder/);
      expect(p).toMatch(/\[Company\]/);
    }
  });

  it('gives the letter a shape rather than a word count alone', () => {
    const p = coverLetterPrompt(data, resolved, job, []);
    expect(p).toContain('### What the letter does');
    expect(p).toMatch(/Opening: why this posting in particular/);
    expect(p).toMatch(/Close: what they want out of the role/);
    expect(p).toMatch(/employer's name and the role could be swapped out/i);
  });

  it('uses a company name that is one', () => {
    const p = coverLetterPrompt(data, resolved, job, []);
    expect(p).toContain('They are applying to Helios Robotics');
    expect(p).toContain('Company: Helios Robotics');
    expect(p).not.toContain('not a usable company name');
  });

  it('refuses a company name that is a job title', () => {
    // The real one. "Software Engineering" came back as the employer and the
    // letter closed "I want to bring that focus to Software Engineering".
    const p = coverLetterPrompt(data, resolved, { ...job, company: 'Software Engineering' }, []);
    expect(p).toMatch(/does not read like\nthe name of a company/);
    expect(p).toMatch(/So do not name them/);
    expect(p).toContain('not a usable company name');
    expect(p).not.toContain('They are applying to Software Engineering');
  });

  it('says plainly when the page named nobody', () => {
    const p = coverLetterPrompt(data, resolved, { jobDescription: 'job' }, []);
    expect(p).toContain('The page never named the employer.');
    expect(p).toContain('Company: not named on the page.');
  });

  it('carries the same judgement into an answer', () => {
    expect(answerPrompt(data, 'Why?', { ...job, company: 'Software Engineering' })).toMatch(/So do not name them/);
    expect(answerPrompt(data, 'Why?', job)).toContain('They are applying to Helios Robotics');
  });

  it('will not let an answer invent a fact the store does not hold', () => {
    const p = answerPrompt(data, 'How many years of Go do you have?', job);
    expect(p).toMatch(/no years of\n {2}experience you counted yourself/);
    expect(p).toMatch(/no visa or work-authorisation status, no salary figure/);
  });
});

/*
 * "AI should be able to rearrange bullet points but not entries ever." The
 * lines inside an entry, yes, and the prompt says what that is for; the
 * entries of a section, never, and the prompt says that too — in both
 * versions, the JSON reply and the tools, since a model shown an
 * `entryOrder` field or a `reorder_entries` tool will use it.
 */
describe('telling the AI it may rearrange lines, and never entries', () => {
  const both = () => ({
    json: tailorPrompt(data, resolved, { jobDescription: 'Kafka streaming ingest', jobTitle: 'Platform Engineer' }),
    tools: tailorPrompt(data, resolved, { jobDescription: 'Kafka streaming ingest', jobTitle: 'Platform Engineer' }, { tools: true }),
  });

  it('names ordering the lines among the moves, and says what it is for', () => {
    const p = tailorPrompt(data, resolved, { jobDescription: 'Kafka streaming ingest', jobTitle: 'Platform Engineer' });
    expect(p).toMatch(/put the bullet points of an entry in a different\s+order/);
    expect(p).toMatch(/first bullet of an entry more attention than the last/);
    expect(p).toMatch(/by how\s+directly each line answers \*this\* posting/);
  });

  /*
   * A model told only that it may reorder will reorder. The limit is what
   * stops it scrambling a project that reads design, build, measure.
   */
  it('says when not to', () => {
    const p = tailorPrompt(data, resolved, { jobDescription: 'job' });
    expect(p).toMatch(/bullets read as a sequence/);
    expect(p).toMatch(/Naming nothing leaves the order exactly as it is/);
  });

  it('says the entries are never reordered', () => {
    for (const [mode, p] of Object.entries(both())) {
      expect(p, mode).toMatch(/You may never change the order of the entries themselves/);
      expect(p, mode).not.toMatch(/first entry of a section more/);
      expect(p, mode).not.toMatch(/Reordering entries is for/);
    }
  });

  it('shows it the shape to answer in, with no entry order', () => {
    const { json } = both();
    expect(json).toContain('"order":');
    expect(json).not.toContain('"entryOrder":');
    expect(json).not.toContain('entryOrder');
  });

  it('names the tool for lines and none for entries', () => {
    const { tools } = both();
    expect(tools).toContain('`reorder_bullets`');
    expect(tools).not.toContain('reorder_entries');
    expect(tools).toMatch(/Nothing can change the order of the entries themselves/);
  });
});

describe('an answer box with a limit', () => {
  it('is named in the prompt when the form gives one, and not otherwise', () => {
    expect(answerPrompt(data, 'Why this role?', undefined, 500)).toContain('at most 500 characters');
    expect(answerPrompt(data, 'Why this role?')).not.toContain('characters, spaces included');
    expect(answerPrompt(data, 'Why this role?', undefined, 0)).not.toContain('characters, spaces included');
  });
});

/*
 * Reported: "instead of rephrasing stories I've told in previous cover
 * letters, they end up heavily rephrasing a resume point already in the
 * resume sent", and "the AI should use previous questions when writing
 * questions and the previous cover letter when writing a cover letter —
 * right now it's way too wordy".
 */
describe('writing from what they wrote before, not from the resume', () => {
  const words = (n: number, seed: string) => Array.from({ length: n }, (_, i) => `${seed}${i}`).join(' ');
  const STORY =
    'At Vega I rebuilt the on-call rotation after a week where one person took every page, ' +
    'and the thing I learned was that a rota nobody trusts is worse than none.';
  const withLetters = {
    ...data,
    coverLetters: [
      {
        id: 'l_helios',
        title: 'Platform Engineer — Helios Robotics',
        company: 'Helios Robotics',
        role: 'Platform Engineer',
        createdAt: '2026-03-01T00:00:00Z',
        body: `${STORY} ${words(100, 'h')}`,
      },
      {
        id: 'l_other',
        title: 'Data Engineer — Northwind',
        company: 'Northwind',
        role: 'Data Engineer',
        createdAt: '2026-04-01T00:00:00Z',
        body: words(140, 'n'),
      },
    ],
  };
  const helios = { company: 'Helios Robotics', jobTitle: 'Platform Engineer', jobDescription: 'On-call, Kafka, latency.' };
  const startSection = (p: string) => {
    const at = p.indexOf('## Start from what they have already written');
    if (at < 0) return '';
    const next = p.slice(at + 3).search(/\n## /);
    return next < 0 ? p.slice(at) : p.slice(at, at + 3 + next);
  };

  it('starts a letter from the closest one they sent, whole, even when the tools could fetch it', () => {
    for (const tools of [true, false]) {
      const p = coverLetterPrompt(withLetters, resolved, helios, [], { tools });
      const start = startSection(p);
      expect(start, `tools: ${tools}`).toContain('The letter to start from — Helios Robotics — Platform Engineer');
      expect(start, `tools: ${tools}`).toContain(STORY);
      // Above everything else they have written, whichever shape that takes.
      const rest = p.indexOf(tools ? '## What they have written before' : '## What you have already written');
      expect(p.indexOf('## Start from what they have already written')).toBeLessThan(rest);
    }
  });

  it('does not paste the letter it starts from a second time', () => {
    const p = coverLetterPrompt(withLetters, resolved, helios, [], { tools: false });
    const pasted = p.slice(p.indexOf('## What you have already written'), p.indexOf('## Posting'));
    expect(pasted).not.toContain(STORY);
    expect(pasted).toContain('Northwind');
  });

  it('starts an answer from their answer to the closest question', () => {
    const p = answerPrompt(data, 'Why are you interested in this role at Helios?');
    const start = startSection(p);
    expect(start).toContain('start from their answer to "Why are you interested in this role?"');
    expect(start).toContain('Because the work is interesting.');
  });

  it('starts each question of an application from its own closest answer, and the letter from the closest letter', () => {
    const p = applicationWritingPrompt(withLetters, resolved, helios, {
      letter: true,
      questions: [
        { question: 'Why are you interested in this role?' },
        { question: 'Will you require visa sponsorship for employment?' },
      ],
    });
    const start = startSection(p);
    expect(start).toContain(STORY);
    expect(start).toContain('Because the work is interesting.');
    expect(start).toContain('require sponsorship for employment visa status');
  });

  it('tells every one of them not to retell the resume, and to tell the stories instead', () => {
    const prompts = {
      letter: coverLetterPrompt(withLetters, resolved, helios, [], { tools: false }),
      letterTools: coverLetterPrompt(withLetters, resolved, helios, [], { tools: true }),
      answer: answerPrompt(withLetters, 'Why this role?', helios),
      application: applicationWritingPrompt(withLetters, resolved, helios, { letter: true, questions: [] }),
    };
    for (const [name, p] of Object.entries(prompts)) {
      expect(p, name).toContain('Do not retell its');
      expect(p, name).toMatch(/The stories come from what they have written before/);
      expect(p, name).toMatch(/Fill no gap in it yourself/);
      expect(p, name).not.toMatch(/pieces of work from the resume/);
    }
  });

  it('leaves resume lines out of the writing samples of a letter or an answer', () => {
    // The fixture's own bullets are long enough to be samples.
    expect(shortenPrompt(data, [{ id: 'b', text: 'a bullet' }], 1)).toContain('Bullets from your resume');
    expect(coverLetterPrompt(data, resolved, helios, [])).not.toContain('Bullets from your resume');
    expect(answerPrompt(data, 'Why this role?')).not.toContain('Bullets from your resume');
  });

  it('asks for a letter as long as theirs run, and a short one where there is nothing to go by', () => {
    const own = coverLetterPrompt(withLetters, resolved, helios, []);
    // 120 and 140 words: the middle of the two.
    expect(own).toMatch(/About 1[23]\d words, which is how long the letters they send run/);
    const none = coverLetterPrompt(data, resolved, helios, []);
    expect(none).toContain('150–220 words');
    for (const p of [own, none]) expect(p).not.toContain('200–320');
  });

  it('holds an answer to the limit its question states, else to the length of their closest answer', () => {
    expect(answerPrompt(data, 'Describe a project you are proud of (100 words max).')).toContain('at most 100 words');
    const long = words(60, 'w');
    const bank = { ...data, answers: [{ id: 'a', question: 'Describe a project you are proud of.', default: 'v', variants: [{ id: 'v', label: 'l', text: long }] }] };
    expect(answerPrompt(bank, 'Describe a project you are most proud of.')).toContain('About 60 words');
    expect(answerPrompt({ ...data, answers: [] }, 'Describe a project you are proud of.')).toContain('80–150 words');
    for (const p of [answerPrompt(data, 'Describe something.')]) expect(p).not.toContain('150–250');
  });

  /*
   * Only pointed at when it is there. A store with nothing written yet has no
   * section to start from, and a step naming one sends the model looking for
   * a heading that does not exist.
   */
  it('points at the place to start only when there is one', () => {
    const bare = { ...data, coverLetters: [], answers: [] };
    const letter = coverLetterPrompt(bare, resolved, helios, [], { tools: true });
    const application = applicationWritingPrompt(bare, resolved, helios, { letter: true, questions: [{ question: 'Why us?' }] });
    for (const p of [letter, application]) {
      expect(p).not.toContain('## Start from what they have already written');
      expect(p).not.toContain('under "Start from what they have already written"');
      expect(p).toContain('find_my_letters');
    }
    expect(coverLetterPrompt(withLetters, resolved, helios, [], { tools: true })).toContain(
      'Start from the letter under "Start from what they have already written"',
    );
  });

  it('says what padding is made of', () => {
    for (const p of [coverLetterPrompt(data, resolved, helios, []), answerPrompt(data, 'Why?')]) {
      expect(p).toContain('### Say it once, briefly');
      expect(p).toMatch(/No summing up at the end/);
    }
  });
});

/*
 * The switch beside every letter and answer says one taken out is "left out
 * of the examples any AI request is told to sound like". The voice samples
 * kept that; the letter to start from, the paste of what they have written
 * and the list the tools fetch from did not — so a letter written to
 * somebody else's template, switched off for exactly that, came back as the
 * one to start from, "its shape, its length".
 */
describe('writing they have taken out of their voice', () => {
  const words = (n: number, seed: string) => Array.from({ length: n }, (_, i) => `${seed}${i}`).join(' ');
  const TEMPLATE = 'To whom it may concern, please find enclosed my application for the advertised position';
  const OWN = 'At Vega I rebuilt the on-call rotation after a week where one person took every page';
  const store = {
    ...data,
    coverLetters: [
      // The closest by every measure — the same employer, the same role,
      // the newest — and switched off.
      {
        id: 'l_template',
        title: 'Platform Engineer — Helios Robotics',
        company: 'Helios Robotics',
        role: 'Platform Engineer',
        createdAt: '2026-05-01T00:00:00Z',
        body: `${TEMPLATE} ${words(100, 't')}`,
        voice: false,
      },
      {
        id: 'l_own',
        title: 'Data Engineer — Northwind',
        company: 'Northwind',
        role: 'Data Engineer',
        createdAt: '2026-04-01T00:00:00Z',
        body: `${OWN} ${words(100, 'o')}`,
      },
    ],
    answers: [
      {
        id: 'a_off',
        question: 'Why are you interested in this role?',
        default: 'v',
        variants: [{ id: 'v', label: 'Saved', text: 'OFF-ANSWER, written to a template.' }],
        voice: false,
      },
      {
        id: 'a_on',
        question: 'Why are you interested in this company?',
        default: 'v',
        variants: [{ id: 'v', label: 'Saved', text: 'ON-ANSWER, in their own words.' }],
      },
    ],
  };
  const helios = { company: 'Helios Robotics', jobTitle: 'Platform Engineer', jobDescription: 'On-call, Kafka.' };

  it('starts a letter from the closest one that counts as theirs, and shows the other nowhere', () => {
    for (const tools of [true, false]) {
      const p = coverLetterPrompt(store, resolved, helios, [], { tools });
      expect(p, `tools: ${tools}`).toContain('The letter to start from — Northwind — Data Engineer');
      expect(p, `tools: ${tools}`).not.toContain(TEMPLATE);
      // Nor in the list of letters the tools fetch from.
      expect(p, `tools: ${tools}`).not.toContain('- Platform Engineer — Helios Robotics');
    }
    // Handed the letters by a caller that ranked every one of them.
    expect(coverLetterPrompt(store, resolved, helios, store.coverLetters)).not.toContain(TEMPLATE);
  });

  it('starts an answer from the closest one that counts as theirs', () => {
    const p = answerPrompt(store, 'Why are you interested in this role at Helios?', helios);
    expect(p).toContain('start from their answer to "Why are you interested in this company?"');
    expect(p).toContain('ON-ANSWER');
    expect(p).not.toContain('OFF-ANSWER');
  });

  it('writes an application from neither', () => {
    const p = applicationWritingPrompt(store, resolved, helios, {
      letter: true,
      questions: [{ question: 'Why are you interested in this role?' }],
    });
    expect(p).toContain(OWN);
    expect(p).toContain('ON-ANSWER');
    expect(p).not.toContain(TEMPLATE);
    expect(p).not.toContain('OFF-ANSWER');
    expect(p).not.toContain('- Platform Engineer — Helios Robotics');
    expect(p).not.toContain('- Why are you interested in this role?');
  });

  it('does not judge whether a draft sounds like them by either', () => {
    const draft = makeDraft({ company: 'Helios Robotics', role: 'Platform Engineer' });
    const letter = letterFeedbackPrompt(store, draft, store.coverLetters);
    expect(letter).toContain(OWN);
    expect(letter).not.toContain(TEMPLATE);
    const answer = answerFeedbackPrompt(store, draft, draft.questions[0]!);
    expect(answer).toContain('ON-ANSWER');
    expect(answer).not.toContain('OFF-ANSWER');
  });
});

/*
 * Asked for: a way to load feedback into the AI's answers. A redraft that
 * cannot be told what was wrong with the last one is a second roll of the
 * same dice.
 */
describe('a draft and what they want changed about it', () => {
  const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');

  it('shows the draft and what they said, only when there is something to show', () => {
    const p = answerPrompt(data, 'Why this role?', undefined, undefined, {
      draft: 'My first go at this.',
      feedback: 'Shorter, and use the on-call story.',
    });
    expect(p).toContain('## What they want changed');
    expect(p).toContain('My first go at this.');
    expect(p).toContain('What they said about it: Shorter, and use the on-call story.');
    expect(answerPrompt(data, 'Why this role?')).not.toContain('## What they want changed');
    expect(answerPrompt(data, 'Why this role?', undefined, undefined, { feedback: '   ' })).not.toContain(
      '## What they want changed',
    );
  });

  it('puts it above the place to start, and lets it win over everything but the rule against inventing', () => {
    const lettered = {
      ...data,
      coverLetters: [{ id: 'l', title: 'To Acme', company: 'Acme', body: words(80), createdAt: '2026-01-01T00:00:00Z' }],
    };
    const p = coverLetterPrompt(lettered, resolved, { jobDescription: 'job', company: 'Acme' }, [], {
      tools: true,
      draft: 'Dear team, a first go.',
      feedback: 'Longer.',
    });
    expect(p).toMatch(/what they said wins/);
    expect(p).toMatch(/except the rules against\s+inventing anything/);
    const at = p.indexOf('## What they want changed');
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(p.indexOf('## Start from what they have already written'));
  });
});
