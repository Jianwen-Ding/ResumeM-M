import { describe, expect, it } from 'vitest';
import {
  answerPrompt,
  bulletFeedbackPrompt,
  coverLetterPrompt,
  feedbackPrompt,
  resumeAsText,
  shortenPrompt,
  tailorPrompt,
} from '../src/ai/prompts.js';
import { resolveResume } from '../src/model/resolve.js';
import { makeTempStore } from './helpers.js';

const t = makeTempStore();
const data = t.store.load();
const resolved = resolveResume('newgrad', data);

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
  it('uses previous letters for voice and says so', () => {
    const p = coverLetterPrompt(data, resolved, { jobDescription: 'job' }, ['an earlier letter']);
    expect(p).toContain('an earlier letter');
    expect(p).toContain('for voice, not content');
  });

  it('omits the previous-letters section when there are none', () => {
    expect(coverLetterPrompt(data, resolved, { jobDescription: 'job' }, [])).not.toContain('Previous letters');
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
    expect(p).toContain('Previously written answers');
    expect(p).toContain('Because the work is interesting.');
    expect(p).toMatch(/staying consistent across applications/);
  });

  it('omits the bank section when it is empty', () => {
    expect(answerPrompt({ ...data, answers: [] }, 'Q?')).not.toContain('Previously written answers');
  });

  it('includes the posting when one is supplied', () => {
    const p = answerPrompt(data, 'Q?', { company: 'Streamly', jobDescription: 'Kafka' });
    expect(p).toContain('Streamly');
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
