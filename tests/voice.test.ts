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
