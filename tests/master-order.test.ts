import { describe, expect, it } from 'vitest';
import { adoptBulletOrder, resolveResume } from '../src/model/resolve.js';
import { DEFAULT_CONFIG } from '../src/model/types.js';
import type { Bullet, Entry, ResumeSpec, StoreData } from '../src/model/types.js';

/*
 * The master document decides what order the lines inside an entry come in.
 *
 * Every resume is a selection over one shared store, and until now the order
 * of the lines inside an entry was decided per resume — which meant deciding
 * it again on every variation, by hand, forever. The master is the inventory
 * and the one place an order can be stated once and mean something
 * everywhere, so it is where that order now lives.
 *
 * Entries themselves are not affected and are still ordered by date: the
 * order of a career is not a matter of taste. The order of the lines inside
 * one job is, and that is the taste this stops you repeating.
 *
 * The exception is the resume that arranged its lines itself, and it says so
 * with `bulletOrder`. That has to be recorded rather than inferred from the
 * order. Inferring it — "this list disagrees with the master, so it must have
 * been dragged" — holds right up until the master moves, at which point every
 * resume that was faithfully following it disagrees with it too and they all
 * detach at once, which is the exact opposite of the point. Two of the tests
 * below were written against that inference and are the ones that caught it.
 */

const line = (id: string, text: string): Bullet => ({
  id,
  default: 'v1',
  variants: [{ id: 'v1', label: 'One', text }],
});

/** One entry whose lines are in the order the master shows them. */
const entryWith = (...ids: string[]): Entry => ({
  id: 'exp',
  kind: 'experience',
  title: 'Everclear',
  bullets: ids.map((id) => line(id, id)),
});

function storeOf(entry: Entry, spec: ResumeSpec): StoreData {
  return {
    profile: { name: 'Someone' },
    entries: [entry],
    skillGroups: [],
    resumes: [spec],
    applications: [],
    coverLetters: [],
    drafts: [],
    samples: [],
    answers: [],
    voice: '',
    config: DEFAULT_CONFIG,
  };
}

const resumeShowing = (bullets: string[], byHand = false): ResumeSpec => ({
  id: 'r',
  label: 'A resume',
  sections: [
    {
      kind: 'experience',
      entries: ['exp'],
      bullets: { exp: bullets },
      ...(byHand ? { bulletOrder: { exp: 'manual' as const } } : {}),
    },
  ],
});

/** The lines that will print, in the order they will print. */
const printed = (entry: Entry, spec: ResumeSpec): string[] =>
  resolveResume('r', storeOf(entry, spec)).sections[0]!.entries[0]!.bullets.map((b) => b.id);

describe('the master decides the order of the lines', () => {
  it('prints a resume’s lines in the order the master holds them', () => {
    expect(printed(entryWith('a', 'b', 'c'), resumeShowing(['a', 'b', 'c']))).toEqual(['a', 'b', 'c']);
  });

  /*
   * The whole point. One entry, two states of the master, one untouched
   * resume — and the resume moves with it.
   */
  it('restacks every resume that never arranged its own lines', () => {
    const spec = resumeShowing(['a', 'c']);
    expect(printed(entryWith('a', 'b', 'c'), spec)).toEqual(['a', 'c']);
    expect(printed(entryWith('c', 'b', 'a'), spec)).toEqual(['c', 'a']);
  });

  /*
   * And the exception: a resume that says, in `bulletOrder`, that it arranged
   * these lines itself. Moving the master must not reach it.
   */
  it('leaves a resume that arranged its own lines exactly where it is', () => {
    const arranged = resumeShowing(['c', 'a', 'b'], true);
    expect(printed(entryWith('a', 'b', 'c'), arranged)).toEqual(['c', 'a', 'b']);
    // The master moves; this resume does not.
    expect(printed(entryWith('b', 'a', 'c'), arranged)).toEqual(['c', 'a', 'b']);
  });

  /*
   * Hiding is not arranging, and this is the case the inference got wrong.
   * Hide a line, then move the master: the stored list now disagrees with the
   * master through no act of the user's, and anything reading disagreement as
   * intent pins the resume here forever.
   */
  it('a resume that only hid a line still follows the master', () => {
    const hidden = resumeShowing(['a', 'c']);
    expect(printed(entryWith('b', 'c', 'a'), hidden)).toEqual(['c', 'a']);
  });

  it('says nothing about an entry the resume left to itself', () => {
    const spec: ResumeSpec = { id: 'r', label: 'A resume', sections: [{ kind: 'experience', entries: ['exp'] }] };
    expect(printed(entryWith('c', 'a', 'b'), spec)).toEqual(['c', 'a', 'b']);
  });

  /*
   * Archiving still wins. A line kept for its text and never printed must not
   * come back because the master happens to list it.
   */
  it('an archived line stays out however the master orders it', () => {
    const entry = entryWith('a', 'b', 'c');
    entry.bullets![1]!.archived = true;
    expect(printed(entry, resumeShowing(['a', 'b', 'c']))).toEqual(['a', 'c']);
  });

  /*
   * A resume naming a line the entry no longer has is a broken reference, not
   * an arrangement — it must not be read as one, or deleting a line from the
   * master would silently detach every resume that showed it.
   */
  it('a line that no longer exists does not count as an arrangement', () => {
    const out = resolveResume('r', storeOf(entryWith('a', 'b'), resumeShowing(['a', 'gone', 'b'])));
    expect(out.sections[0]!.entries[0]!.bullets.map((b) => b.id)).toEqual(['a', 'b']);
    expect(out.warnings.join(' ')).toMatch(/gone/);
  });
});

/*
 * What happens to the resumes that were arranged before any of this existed.
 *
 * They carry no `bulletOrder`, because there was nothing to carry, and
 * "absent" now means "follow the master" — so read literally, the upgrade
 * that introduced this feature would restack every document somebody had
 * already arranged, proofread and sent.
 *
 * So the same one-time question `adoptDateOrder` asks of a section is asked
 * of an entry's lines, once, before the master has had a chance to move:
 * does this list disagree with the master? At that moment, and only at that
 * moment, disagreement really does mean somebody dragged it. The answer is
 * written down, and from then on it is a fact rather than an inference.
 */
describe('resumes arranged before the master had a say', () => {
  const sectionOf = (bullets: string[], bulletOrder?: Record<string, 'manual'>) => ({
    kind: 'experience' as const,
    entries: ['exp'],
    bullets: { exp: bullets },
    ...(bulletOrder ? { bulletOrder } : {}),
  });

  it('is left alone, and said so, when it disagrees with the master', () => {
    const [out] = adoptBulletOrder([sectionOf(['c', 'a'])], [entryWith('a', 'b', 'c')]);
    expect(out?.bulletOrder).toEqual({ exp: 'manual' });
  });

  it('is left following the master when it already agrees with it', () => {
    const [out] = adoptBulletOrder([sectionOf(['a', 'c'])], [entryWith('a', 'b', 'c')]);
    expect(out?.bulletOrder).toBeUndefined();
  });

  it('does not overrule a resume that has already answered', () => {
    const [out] = adoptBulletOrder([sectionOf(['a', 'c'], { exp: 'manual' })], [entryWith('a', 'b', 'c')]);
    expect(out?.bulletOrder).toEqual({ exp: 'manual' });
  });

  it('has nothing to say about a section that names no lines', () => {
    const plain = { kind: 'experience' as const, entries: ['exp'] };
    expect(adoptBulletOrder([plain], [entryWith('a', 'b')])[0]).toBe(plain);
  });

  it('has nothing to say about an entry the store no longer holds', () => {
    const [out] = adoptBulletOrder([sectionOf(['a'])], []);
    expect(out?.bulletOrder).toBeUndefined();
  });

  /*
   * And it must not rewrite the section it was handed: `load()` runs this on
   * every read, over the objects the parse cache hands out.
   */
  it('leaves the sections it was given alone', () => {
    const before = sectionOf(['c', 'a']);
    const snapshot = structuredClone(before);
    adoptBulletOrder([before], [entryWith('a', 'b', 'c')]);
    expect(before).toEqual(snapshot);
  });

  /*
   * The end to end of it: adopted, then resolved, and the arrangement is
   * still there after the master moves underneath it.
   */
  it('survives the master moving, once it has been adopted', () => {
    const [adopted] = adoptBulletOrder([sectionOf(['c', 'a'])], [entryWith('a', 'b', 'c')]);
    const spec: ResumeSpec = { id: 'r', label: 'A resume', sections: [adopted!] };
    expect(printed(entryWith('a', 'b', 'c'), spec)).toEqual(['c', 'a']);
    expect(printed(entryWith('b', 'a', 'c'), spec)).toEqual(['c', 'a']);
  });
});
