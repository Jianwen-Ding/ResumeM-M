import { describe, expect, it } from 'vitest';
import {
  answerFeedbackPrompt,
  answerPrompt,
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

  it('carries the voice notes, so they are never retyped into a chat', () => {
    for (const [name, p] of Object.entries(prompts)) {
      expect(p, name).toContain('Plain and direct');
    }
  });

  it('carries the rules against inventing things', () => {
    for (const [name, p] of Object.entries(prompts)) {
      expect(p, name).toMatch(/Never invent experience/);
      expect(p, name).toMatch(/Never inflate a number/);
    }
  });

  it('falls back to generic guidance when there is no writing to learn from', () => {
    const bare = { ...data, voice: '', coverLetters: [], answers: [], samples: [], entries: [] };
    expect(feedbackPrompt(bare, resolved)).toContain('No samples of their writing are stored yet');
  });

  it('shows the person’s own writing instead of a self-description', () => {
    // The point of the change: voice comes from what they actually wrote —
    // a sent letter, here — not from a note describing their style.
    expect(feedbackPrompt(data, resolved)).toContain('Dear Acme, here is a letter I wrote before');
    expect(feedbackPrompt(data, resolved)).toContain('Match its register, sentence length');
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
      expect(prompt).toContain('inherit choices');
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
    expect(p).toMatch(/staying consistent across applications/);
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
      expect(prompt).toContain('Dear Acme'); // the letter in the fixture
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
