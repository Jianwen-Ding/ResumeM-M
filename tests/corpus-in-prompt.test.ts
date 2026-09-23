import { describe, expect, it } from 'vitest';
import { coverLetterPrompt } from '../src/ai/prompts.js';
import { makeTempStore } from './helpers.js';
import { resolveResume } from '../src/model/resolve.js';
import type { CoverLetter, StoreData } from '../src/model/types.js';

/*
 * What the corpus costs, every single run.
 *
 * Past letters and answers were pasted into the prompt in full, up to a nine
 * kilobyte budget, chosen by a ranking made here rather than by the model. On a
 * single-shot run that is right: there is no way to ask for more, so the only
 * chance to show any of it is to show it.
 *
 * With the writing tools attached it is wrong three ways over. It spends the
 * context on something the model can fetch a piece at a time; it hides
 * everything the ranking cut, which after a season of applying is most of the
 * corpus; and it hands the model two copies of the same material — the paste
 * and whatever `find_my_letters` returns — to disagree with each other about.
 *
 * `tailorPrompt` already drops its store inventory for exactly this reason.
 *
 * Note what these assertions do *not* claim. The voice preamble draws on the
 * same letters, on purpose and in every prompt: you cannot match a register you
 * have not been shown, and a style sample the model has to remember to fetch is
 * one it will skip. So the letter text legitimately appears above, and these
 * measure the prior-work section alone. Writing it the other way round is the
 * mistake this file made first, and it hid the fact that there were two copies
 * of the corpus in every prompt rather than one.
 */

/**
 * Just the prior-work section, whichever of the two shapes it took.
 *
 * `## What you have already written` is the paste; `## What they have written
 * before` is the index. Anchoring on both is what makes the size comparison
 * below a comparison of the same thing.
 */
function corpusSection(prompt: string): string {
  for (const heading of ['## What they have written before', '## What you have already written']) {
    const at = prompt.indexOf(heading);
    if (at >= 0) return prompt.slice(at);
  }
  return '';
}

const LETTER_BODY =
  'I have spent four years on build pipelines, and the thing I keep coming back to is how much ' +
  'of the work is deciding what not to build. '.repeat(12);

function storeWith(n: number): { data: StoreData; resume: ReturnType<typeof resolveResume> } {
  const fixture = makeTempStore();
  const loaded = fixture.store.load();
  fixture.cleanup();

  const coverLetters: CoverLetter[] = Array.from({ length: n }, (_, i) => ({
    id: `l${i}`,
    title: `Letter ${i} — Company ${i}`,
    company: `Company ${i}`,
    role: 'Platform Engineer',
    createdAt: `2026-0${(i % 9) + 1}-01`,
    body: LETTER_BODY,
  }));

  const answers = Array.from({ length: n }, (_, i) => ({
    id: `a${i}`,
    question: `Why do you want to work at Company ${i}?`,
    default: 'v',
    variants: [{ id: 'v', label: 'Neutral', text: LETTER_BODY }],
  }));

  const data = { ...loaded, coverLetters, answers };
  return { data, resume: resolveResume(loaded.resumes[0]!.id, loaded) };
}

const job = { company: 'Helios', jobTitle: 'Platform Engineer', jobDescription: 'Build things.' };

describe('what the corpus costs a prompt', () => {
  it('pastes the letters in full when there are no tools to fetch them with', () => {
    const { data, resume } = storeWith(12);
    const prompt = coverLetterPrompt(data, resume, job, [], { tools: false });
    // The body itself, not merely a title.
    expect(prompt).toContain('deciding what not to build');
    expect(prompt).toContain('### Cover letters they have sent');
  });

  it('lists them instead of pasting them when the tools are attached', () => {
    const { data, resume } = storeWith(12);
    const section = corpusSection(coverLetterPrompt(data, resume, job, [], { tools: true }));

    expect(section).toContain('Letter 0 — Company 0');
    expect(section).toContain('Why do you want to work at Company 0?');
    expect(section).toContain('find_my_letters');
    // Titles and questions, no bodies.
    expect(section).not.toContain('deciding what not to build');
  });

  /*
   * The point of the change, measured rather than asserted in the abstract:
   * the index has to be dramatically cheaper, and it has to stay cheap as the
   * store fills up, or it is the paste again with extra steps.
   */
  it('costs a fraction of the paste', () => {
    const { data, resume } = storeWith(12);
    const pasted = corpusSection(coverLetterPrompt(data, resume, job, [], { tools: false })).length;
    const listed = corpusSection(coverLetterPrompt(data, resume, job, [], { tools: true })).length;

    // The paste runs to its whole budget on a store this size; the list is
    // one line each.
    expect(pasted).toBeGreaterThan(4000);
    expect(listed).toBeLessThan(pasted / 3);
  });

  /*
   * A list that grows without limit is the paste again. Past a point the index
   * says how many more there are instead of naming every one.
   */
  it('stops listing and starts counting on a store with hundreds in it', () => {
    const { data, resume } = storeWith(400);
    const section = corpusSection(coverLetterPrompt(data, resume, job, [], { tools: true }));
    expect(section).toMatch(/…and \d+ more/);
    // Four hundred letters, and the section stays a page rather than a book.
    expect(section.length).toBeLessThan(5000);
  });

  it('says nothing at all about prior work when there is none', () => {
    const { data, resume } = storeWith(0);
    expect(corpusSection(coverLetterPrompt(data, resume, job, [], { tools: true }))).toBe('');
  });

  /*
   * Ranking still matters in the index: it decides which thirty get named, and
   * the most useful letter to start from is the one sent to these people.
   */
  it('puts the same employer first in the list', () => {
    const { data, resume } = storeWith(40);
    data.coverLetters.push({
      id: 'here',
      title: 'The one I sent Helios',
      company: 'Helios',
      role: 'Platform Engineer',
      createdAt: '2020-01-01',
      body: LETTER_BODY,
    });
    const section = corpusSection(coverLetterPrompt(data, resume, job, [], { tools: true }));
    /*
     * The oldest letter of the lot, so only the same-employer rule can put it
     * anywhere near the front — and with forty others competing for thirty
     * places, only that rule gets it listed at all.
     */
    const bullets = section.split('\n').filter((l) => l.startsWith('- '));
    expect(bullets[0]).toContain('The one I sent Helios');
  });
});

/*
 * The same employer first in the index, however its name is written: a
 * letter sent to "Acme, Inc." is the one to start from for a form that says
 * "Acme", and compared as written it was ranked with everybody else.
 */
describe('the index puts the same employer first, with or without its legal form', () => {
  it('lists the letter sent to "Acme, Inc." first for "Acme"', () => {
    const { data, resume } = storeWith(3);
    // The oldest of the three, so "most recent first" alone would list it last.
    const acme = { ...data.coverLetters[2]!, id: 'acme', title: 'The Acme letter', company: 'Acme, Inc.', createdAt: '2020-01-01T00:00:00Z' };
    const withAcme = { ...data, coverLetters: [data.coverLetters[0]!, data.coverLetters[1]!, acme] };
    const job = { jobTitle: 'Platform Engineer', company: 'Acme', jobDescription: 'Build pipelines.' };
    const section = corpusSection(coverLetterPrompt(withAcme, resume, job, [], { tools: true }));
    const firstListed = section.split('\n').find((line) => line.startsWith('- '));
    expect(firstListed).toContain('The Acme letter');
  });
});
