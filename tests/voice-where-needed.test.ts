import { describe, expect, it } from 'vitest';
import {
  answerPrompt,
  bulletFeedbackPrompt,
  coverLetterPrompt,
  entryFeedbackPrompt,
  feedbackPrompt,
  phraseFeedbackPrompt,
  readMaterialPrompt,
  shortenPrompt,
  tailorPrompt,
} from '../src/ai/prompts.js';
import { makeTempStore } from './helpers.js';
import { resolveResume } from '../src/model/resolve.js';
import type { CoverLetter, StoreData } from '../src/model/types.js';

/*
 * Which requests are shown how this person writes, and which are not.
 *
 * The voice section is real material — the corpus, the sent letters, the
 * stored answers, the resume's own bullets — up to a nine kilobyte budget, and
 * it was prepended to every prompt this file exports. Most of them cannot use
 * it. `tailorPrompt` says in its own instructions "You are selecting, not
 * writing. You may not edit this resume"; every critique prompt opens with "do
 * not rewrite". Thousands of characters of somebody's cover letters in front
 * of a request forbidden from writing a word is not free, and it is not
 * harmless either: `entryFeedbackPrompt` had acquired the line "Focus on this
 * entry, not unrelated entries in the writing samples", which exists only to
 * undo the samples above it.
 *
 * So the split below. Anything that produces prose in the person's register
 * keeps it; anything that selects, critiques, or reads their own files back to
 * them does not.
 */

const SAMPLE =
  'I have spent four years on build pipelines, and the thing I keep coming back to is how much ' +
  'of the work is deciding what not to build. '.repeat(10);

/** The heading `renderVoiceContext` puts above the samples. */
const VOICE_HEADING = '## How this person writes';

function storeWithAVoice(): { data: StoreData; resume: ReturnType<typeof resolveResume> } {
  const fixture = makeTempStore();
  const loaded = fixture.store.load();
  fixture.cleanup();

  const coverLetters: CoverLetter[] = [
    {
      id: 'l0',
      title: 'Letter — Helios',
      company: 'Helios',
      role: 'Platform Engineer',
      createdAt: '2026-01-01',
      body: SAMPLE,
    },
  ];

  const data = { ...loaded, coverLetters };
  return { data, resume: resolveResume(loaded.resumes[0]!.id, loaded) };
}

const job = { company: 'Helios', jobTitle: 'Platform Engineer', jobDescription: 'Build things.' };

describe('the voice section goes only where prose is written', () => {
  /*
   * The guard the rest of this file rests on. Every "does not contain"
   * assertion below would pass just as well against a store with no voice at
   * all, and then it would be measuring nothing.
   */
  it('is really there to be left out', () => {
    const { data, resume } = storeWithAVoice();
    const letter = coverLetterPrompt(data, resume, job, [], { tools: false });
    expect(letter).toContain(VOICE_HEADING);
    expect(letter).toContain('deciding what not to build');
  });

  it('is kept for the requests that write in it', () => {
    const { data, resume } = storeWithAVoice();
    expect(coverLetterPrompt(data, resume, job, [], { tools: false })).toContain(VOICE_HEADING);
    expect(answerPrompt(data, 'Why do you want to work here?')).toContain(VOICE_HEADING);
    // Shortening proposes a tighter phrasing of a real line, which is writing.
    expect(shortenPrompt(data, [{ id: 'b1', text: 'Did a thing, carefully.' }], 1)).toContain(VOICE_HEADING);
  });

  it('is left out of tailoring, which may not write a word', () => {
    const { data, resume } = storeWithAVoice();
    const prompt = tailorPrompt(data, resume, job);

    expect(prompt).not.toContain(VOICE_HEADING);
    expect(prompt).not.toContain('deciding what not to build');
    // And the instruction that makes the samples pointless is still there, so
    // this is the prompt it claims to be.
    expect(prompt).toContain('You are selecting, not writing');
  });

  it('is left out of every critique, which may not rewrite', () => {
    const { data, resume } = storeWithAVoice();
    const entry = data.entries[0]!;
    const bullet = entry.bullets![0]!;

    for (const prompt of [
      feedbackPrompt(data, resume),
      entryFeedbackPrompt(data, entry),
      bulletFeedbackPrompt(data, entry, bullet),
      phraseFeedbackPrompt(data, entry, { id: 'x', text: 'Did a thing.' }),
    ]) {
      expect(prompt).not.toContain(VOICE_HEADING);
      expect(prompt).not.toContain('deciding what not to build');
      expect(prompt).toMatch(/do not rewrite|Do NOT produce a rewritten/i);
    }
  });

  /*
   * Reading their own files is the one case where the samples are not merely
   * unused but redundant: the files in front of the model are better evidence
   * of how they write than a ranked extract of the same store.
   */
  it('is left out of reading their own material back', () => {
    const { data } = storeWithAVoice();
    const prompt = readMaterialPrompt(data, [{ name: 'old-letter.md' }]);

    expect(prompt).not.toContain(VOICE_HEADING);
    expect(prompt).not.toContain('deciding what not to build');
  });

  /*
   * A rule that points at material which is not there is worse than no rule.
   * "Match the register of the writing above" was in the hard rules of every
   * prompt, and with the samples gone it referred to nothing.
   */
  it('never tells a prompt to match writing it was not shown', () => {
    const { data, resume } = storeWithAVoice();
    const entry = data.entries[0]!;

    for (const prompt of [
      tailorPrompt(data, resume, job),
      feedbackPrompt(data, resume),
      entryFeedbackPrompt(data, entry),
      readMaterialPrompt(data, [{ name: 'old-letter.md' }]),
    ]) {
      expect(prompt).not.toContain('the writing above');
      // The intent survives, said without the dangling reference.
      expect(prompt).toContain('Do not make text sound more corporate');
    }

    // And where the writing really is above, it still says so.
    expect(coverLetterPrompt(data, resume, job, [], { tools: false })).toContain('the writing above');
  });

  /*
   * The entry critique had a line whose only job was to tell the model to
   * ignore the samples. With the samples gone it described a section of the
   * prompt that does not exist.
   */
  it('drops the instruction that existed only to undo the samples', () => {
    const { data } = storeWithAVoice();
    const prompt = entryFeedbackPrompt(data, data.entries[0]!);

    expect(prompt).not.toContain('writing samples');
    expect(prompt).toContain('Do not produce replacement wording or a rewritten entry.');
  });
});
