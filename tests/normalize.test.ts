import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tailorPrompt } from '../src/ai/prompts.js';
import { buildVoiceContext } from '../src/ai/voice.js';
import { buildMaster, resolveResume } from '../src/model/resolve.js';
import { normalizeAnswers, normalizeEntries, normalizeField } from '../src/model/normalize.js';
import { makeTempStore, type TempStore } from './helpers.js';

/**
 * The store is hand-editable YAML, so it can be hand-edited into shapes the
 * code did not expect. This is the reported one: an entry whose `dates` is a
 * mapping with no `variants:` under it. Every `for…of field.variants` in the
 * codebase then threw "field.variants is not iterable", which named no field
 * and suggested no fix.
 */

let t: TempStore;
beforeEach(() => {
  t = makeTempStore();
});
afterEach(() => t.cleanup());

/** The malformed education file, written the way a person would mistype it. */
const BROKEN = `
- id: edu_neu
  kind: education
  title: Northeastern University
  dates:
    default: v_may2026
  subtitle:
    variants: []
  bullets:
    - id: b_course
      default: v_broad
    - id: b_list
      items:
        - id: c_algo
          text: Algorithms
`;

describe('a store someone edited by hand', () => {
  beforeEach(() => t.write('education.yaml', BROKEN));

  it('loads without throwing, whatever the file says', () => {
    const data = t.store.load();
    const entry = data.entries.find((e) => e.id === 'edu_neu')!;
    expect(Array.isArray(entry.bullets?.[0]?.variants)).toBe(true);
    expect(entry.bullets?.[0]?.variants).toEqual([]);
  });

  it('does not throw where it used to: building the tailoring prompt', () => {
    const data = t.store.load();
    const resolved = resolveResume('newgrad', data);
    // The exact call that produced "field.variants is not iterable".
    expect(() => tailorPrompt(data, resolved, { jobDescription: 'Kafka' })).not.toThrow();
  });

  it('does not throw anywhere else that walks the store', () => {
    const data = t.store.load();
    expect(() => resolveResume('newgrad', data)).not.toThrow();
    expect(() => buildMaster(data)).not.toThrow();
    expect(() => buildVoiceContext(data)).not.toThrow();
  });

  it('says what is wrong rather than silently printing nothing', () => {
    const resolved = resolveResume('newgrad', t.store.load());
    expect(resolved.warnings.join(' ')).toMatch(/no variants|has no variants/i);
  });

  it('keeps the entry, so it can be repaired rather than vanishing', () => {
    const data = t.store.load();
    const entry = data.entries.find((e) => e.id === 'edu_neu');
    expect(entry).toBeDefined();
    expect(entry?.title).toBe('Northeastern University');
    expect(entry?.bullets?.map((b) => b.id)).toEqual(['b_course', 'b_list']);
  });
});

describe('making a field’s shape true', () => {
  it('leaves a plain string alone', () => {
    expect(normalizeField('Boston, MA')).toBe('Boston, MA');
  });

  it('turns what YAML read as a number back into text', () => {
    expect(normalizeField(2026)).toBe('2026');
  });

  it('gives a variant set with no variants an empty list rather than nothing', () => {
    expect(normalizeField({ default: 'v_x' })).toEqual({ default: 'v_x', variants: [] });
  });

  it('points the default at something that exists', () => {
    const field = normalizeField({
      default: 'v_gone',
      variants: [{ id: 'v_here', label: 'Here', text: 'Some text' }],
    });
    expect(field).toMatchObject({ default: 'v_here' });
  });

  it('drops a variant with no text, which could never have printed', () => {
    const field = normalizeField({ default: 'v_a', variants: [{ id: 'v_a' }, { id: 'v_b', text: 'Kept' }] });
    expect(field).toMatchObject({ default: 'v_b', variants: [{ id: 'v_b', text: 'Kept' }] });
  });

  it('names a variant that forgot to name itself', () => {
    const field = normalizeField({ variants: [{ text: 'No id, no label' }] }) as { variants: { id: string }[] };
    expect(field.variants[0]?.id).toBeTruthy();
  });

  it('has nothing to say about a field that is not there', () => {
    expect(normalizeField(undefined)).toBeUndefined();
    expect(normalizeField(null)).toBeUndefined();
  });
});

describe('making the rest of the store’s shape true', () => {
  it('survives a file that is not a list at all', () => {
    expect(normalizeEntries('not a list')).toEqual([]);
    expect(normalizeAnswers(undefined)).toEqual([]);
  });

  it('gives an entry with no title one it can print', () => {
    expect(normalizeEntries([{ id: 'exp_x', kind: 'experience' }])[0]?.title).toBe('exp_x');
  });

  it('gives an answer with no phrasings an empty list rather than a crash', () => {
    const answers = normalizeAnswers([{ id: 'a1', question: 'Why us?' }]);
    expect(answers[0]?.variants).toEqual([]);
    expect(() => answers[0]!.variants.map((v) => v.text)).not.toThrow();
  });

  it('steps over an entry that is not an object', () => {
    expect(normalizeEntries([null, 'x', { id: 'ok', kind: 'project' }]).map((e) => e.id)).toEqual(['ok']);
  });
});
