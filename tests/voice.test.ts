import { describe, expect, it } from 'vitest';
import { buildVoiceContext, collectSamples, renderVoiceContext } from '../src/ai/voice.js';
import type { StoreData, WritingSample } from '../src/model/types.js';
import { makeTempStore } from './helpers.js';

const t = makeTempStore();
const base = t.store.load();

const prose = (n: number, word = 'sentence') => `${`A ${word} of some length. `.repeat(n)}`.trim();

const sample = (over: Partial<WritingSample> = {}): WritingSample => ({
  id: 's1',
  title: 'Something',
  kind: 'other',
  text: prose(6),
  createdAt: '2026-01-01T00:00:00Z',
  ...over,
});

const store = (over: Partial<StoreData> = {}): StoreData => ({
  ...base,
  samples: [],
  coverLetters: [],
  answers: [],
  entries: [],
  ...over,
});

describe('what counts as a sample of someone’s writing', () => {
  it('takes the corpus they added', () => {
    const found = collectSamples(store({ samples: [sample({ title: 'An old essay' })] }));
    expect(found.map((s) => s.title)).toEqual(['An old essay']);
  });

  it('leaves out an archived sample, without deleting it', () => {
    expect(collectSamples(store({ samples: [sample({ archived: true })] }))).toEqual([]);
  });

  it('leaves out a fragment too short to show anything', () => {
    expect(collectSamples(store({ samples: [sample({ text: 'Hi.' })] }))).toEqual([]);
  });

  it('counts the letters they have sent', () => {
    const data = store({
      coverLetters: [{ id: 'l', title: 'To Acme', body: prose(5), createdAt: '2026-01-01T00:00:00Z' }],
    });
    expect(collectSamples(data)[0]?.kind).toBe('letter');
  });

  it('skips a letter that is barely there', () => {
    const data = store({ coverLetters: [{ id: 'l', title: 'x', body: 'Hi.', createdAt: '2026-01-01T00:00:00Z' }] });
    expect(collectSamples(data)).toEqual([]);
  });

  it('counts every phrasing of an answer, but not a one-word one', () => {
    const data = store({
      answers: [
        {
          id: 'a',
          question: 'Why us?',
          default: 'v1',
          variants: [
            { id: 'v1', label: 'Long', text: prose(5) },
            { id: 'v2', label: 'Short', text: 'No' },
          ],
        },
      ],
    });
    const found = collectSamples(data);
    expect(found).toHaveLength(1);
    expect(found[0]?.title).toBe('Why us?');
  });

  it('adds the resume bullets, as the register the resume itself is in', () => {
    const found = collectSamples(base);
    const bullets = found.find((s) => s.kind === 'resume');
    expect(bullets?.title).toBe('Bullets from your resume');
    expect(bullets?.text).toMatch(/^- /m);
  });

  /*
   * But not for a letter or an answer, which go beside the resume: those
   * bullets were the most concrete thing in the prompt about what the person
   * had done, so the answer was built out of one of them.
   */
  it('leaves the resume bullets out when asked to, and keeps everything else', () => {
    const all = collectSamples(base);
    const prose = collectSamples(base, { resume: false });
    expect(prose.some((s) => s.kind === 'resume')).toBe(false);
    expect(prose).toEqual(all.filter((s) => s.kind !== 'resume'));
  });

  it('has no bullet section when every bullet is too terse to matter', () => {
    const data = store({
      entries: [
        {
          id: 'e',
          kind: 'project',
          title: 'x',
          bullets: [{ id: 'b', default: 'v', variants: [{ id: 'v', label: 'l', text: 'Short' }] }],
        },
      ],
    });
    expect(collectSamples(data).some((s) => s.kind === 'resume')).toBe(false);
  });
});

describe('choosing what to send', () => {
  it('spends across kinds rather than on whichever is longest', () => {
    const data = store({
      samples: [sample({ id: 's1', title: 'Essay', text: prose(40) })],
      coverLetters: [{ id: 'l', title: 'To Acme', body: prose(40), createdAt: '2026-01-01T00:00:00Z' }],
      answers: [{ id: 'a', question: 'Why us?', default: 'v', variants: [{ id: 'v', label: 'l', text: prose(40) }] }],
    });
    const kinds = new Set(buildVoiceContext(data).samples.map((s) => s.kind));
    expect(kinds.size).toBeGreaterThan(1);
  });

  it('reports what existed as well as what fit', () => {
    const data = store({ samples: [sample({ text: prose(400) })] });
    const context = buildVoiceContext(data);
    expect(context.available).toBeGreaterThan(context.chars);
    expect(context.chars).toBeLessThanOrEqual(9000);
  });

  it('truncates the sample that runs past the budget rather than dropping it', () => {
    const data = store({ samples: [sample({ text: prose(2000) })] });
    const context = buildVoiceContext(data);
    expect(context.samples).toHaveLength(1);
    expect(context.samples[0]?.text.endsWith('…')).toBe(true);
  });

  it('is content with a store that has nothing in it', () => {
    const context = buildVoiceContext(store({ voice: '' }));
    expect(context.samples).toEqual([]);
    expect(context.chars).toBe(0);
    expect(context.available).toBe(0);
  });
});

describe('the section that leads every prompt', () => {
  it('shows the writing, and says to match it rather than describe it', () => {
    const data = store({ samples: [sample({ title: 'An old essay', text: prose(5, 'plain') })] });
    const text = renderVoiceContext(buildVoiceContext(data));
    expect(text).toContain('An old essay');
    expect(text).toContain('Match its register');
    expect(text).toContain('plain');
  });

  it('falls back to generic guidance when there is nothing to show', () => {
    expect(renderVoiceContext(buildVoiceContext(store({ voice: '' })))).toContain(
      'No samples of their writing are stored yet',
    );
  });

  it('carries the notes, when there are any, as a footnote to the evidence', () => {
    const text = renderVoiceContext(buildVoiceContext(store({ voice: 'Never use "leverage".' })));
    expect(text).toContain('Notes they added themselves');
    expect(text).toContain('leverage');
  });

  it('says nothing about notes when there are none', () => {
    expect(renderVoiceContext(buildVoiceContext(store({ voice: '   ' })))).not.toContain('Notes they added');
  });
});

/**
 * Letters and answers are the bulk of most people's corpus, and until now all
 * of them counted with no way to say otherwise.
 *
 * A letter written to somebody else's template, an answer that is a date, a
 * draft nobody was pleased with — all things worth keeping as a record and
 * none of them how you write. `voice: false` is the one thing the field says;
 * absent still means yes, which is what every save written before it meant.
 */
describe('leaving one letter or answer out of your voice', () => {
  const letters = [
    { id: 'l1', title: 'To Acme', createdAt: '', body: prose(8) },
    { id: 'l2', title: 'To Zenith', createdAt: '', body: prose(8, 'clause') },
  ];
  const answers = [
    {
      id: 'a1',
      question: 'Why here?',
      default: 'v1',
      variants: [{ id: 'v1', label: 'Long', text: prose(6, 'reason') }],
    },
    {
      id: 'a2',
      question: 'Notice period?',
      default: 'v1',
      variants: [{ id: 'v1', label: 'Long', text: prose(6, 'week') }],
    },
  ];

  const titles = (data: StoreData) => collectSamples(data).map((s) => s.title);

  it('counts every one of them while nothing says otherwise', () => {
    const got = titles(store({ coverLetters: letters, answers }));
    expect(got).toEqual(expect.arrayContaining(['To Acme', 'To Zenith', 'Why here?', 'Notice period?']));
  });

  it('drops the letter that says it is not one', () => {
    const got = titles(store({ coverLetters: [letters[0]!, { ...letters[1]!, voice: false }], answers: [] }));
    expect(got).toContain('To Acme');
    expect(got).not.toContain('To Zenith');
  });

  it('and the answer that says so, without touching its neighbour', () => {
    const got = titles(store({ coverLetters: [], answers: [answers[0]!, { ...answers[1]!, voice: false }] }));
    expect(got).toContain('Why here?');
    expect(got).not.toContain('Notice period?');
  });

  it('reads `voice: true` as the yes it already was, not as a second meaning', () => {
    const got = titles(store({ coverLetters: [{ ...letters[0]!, voice: true }], answers: [] }));
    expect(got).toContain('To Acme');
  });

  it('leaves the budget to spend on what is left', () => {
    const all = buildVoiceContext(store({ coverLetters: letters, answers }));
    const fewer = buildVoiceContext(
      store({ coverLetters: [letters[0]!, { ...letters[1]!, voice: false }], answers }),
    );
    expect(fewer.available).toBeLessThan(all.available);
    expect(fewer.samples.map((s) => s.title)).not.toContain('To Zenith');
  });
});
