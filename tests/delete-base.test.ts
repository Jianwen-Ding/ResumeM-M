import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { flattenSpec } from '../src/model/resolve.js';
import { makeTempStore } from './helpers.js';

/*
 * Deleting one resume used to break the others.
 *
 * Variations are thin: "new grad" is the base resume plus a handful of
 * choices, recorded as `extends: base`. Deleting the base unlinked its file and
 * nothing else, so every variation built on it threw "extends 'base', which
 * does not exist" from that moment on — in the editor, in the preview, in the
 * tracker, everywhere. Nothing in the UI edits `extends`, so there was no way
 * back except hand-editing YAML.
 *
 * The user asked to delete one resume. Keeping the others working, and looking
 * exactly as they did, is the only reading of that.
 */

let temp: ReturnType<typeof makeTempStore>;

beforeEach(() => {
  temp = makeTempStore();
});
afterEach(() => temp.cleanup());

describe('deleting a resume other resumes are built on', () => {
  it('leaves the variations resolvable', () => {
    temp.store.deleteResume('base');

    const all = temp.store.loadResumes();
    expect(all.map((r) => r.id).sort()).toEqual(['intern', 'newgrad']);
    for (const r of all) {
      expect(() => flattenSpec(r, all), r.id).not.toThrow();
    }
  });

  it('leaves them resolving to exactly what they resolved to before', () => {
    const before = temp.store.loadResumes();
    const expected = Object.fromEntries(
      before
        .filter((r) => r.id !== 'base')
        .map((r) => [r.id, flattenSpec(r, before)]),
    );

    temp.store.deleteResume('base');

    const after = temp.store.loadResumes();
    for (const r of after) {
      const flat = flattenSpec(r, after);
      // `extends` is the one thing that legitimately differs: it pointed at the
      // resume that is now gone.
      expect({ ...flat, extends: undefined }, r.id).toEqual({
        ...expected[r.id],
        extends: undefined,
      });
    }
  });

  it('keeps the child its own choices where the two disagreed', () => {
    // The base pins a date; the child overrides it. Folding the base in must
    // not let the base's value win on the way past.
    temp.write('resumes/base.yaml', {
      id: 'base',
      label: 'Base resume',
      choices: { 'edu_neu.dates': 'v_may2026', 'exp_acme.title': 'v_long' },
      sections: [{ kind: 'education', entries: ['edu_neu'] }],
    });
    temp.write('resumes/newgrad.yaml', {
      id: 'newgrad',
      label: 'New grad',
      extends: 'base',
      choices: { 'edu_neu.dates': 'v_dec2026' },
    });

    temp.store.deleteResume('base');

    const child = temp.store.getResume('newgrad');
    expect(child?.choices?.['edu_neu.dates']).toBe('v_dec2026'); // the child's
    expect(child?.choices?.['exp_acme.title']).toBe('v_long'); // inherited
    expect(child?.extends).toBeUndefined();
    expect(child?.label).toBe('New grad');
  });

  it('re-points a grandchild at the grandparent, not at nothing', () => {
    temp.write('resumes/mid.yaml', { id: 'mid', label: 'Mid', extends: 'base', choices: { a: 'x' } });
    temp.write('resumes/leaf.yaml', { id: 'leaf', label: 'Leaf', extends: 'mid', choices: { b: 'y' } });

    temp.store.deleteResume('mid');

    const leaf = temp.store.getResume('leaf');
    expect(leaf?.extends).toBe('base'); // mid's own parent
    expect(leaf?.choices).toMatchObject({ a: 'x', b: 'y' }); // mid's contribution kept
    expect(() => flattenSpec(leaf!, temp.store.loadResumes())).not.toThrow();
  });

  it('does not touch resumes that were not built on the deleted one', () => {
    const untouched = temp.read('resumes/intern.yaml');
    temp.write('resumes/solo.yaml', { id: 'solo', label: 'Solo', choices: { z: 'q' } });

    temp.store.deleteResume('solo');

    expect(temp.read('resumes/intern.yaml')).toEqual(untouched);
    expect(temp.exists('resumes/solo.yaml')).toBe(false);
  });

  it('deleting a leaf still just deletes it', () => {
    temp.store.deleteResume('intern');
    expect(temp.exists('resumes/intern.yaml')).toBe(false);
    expect(temp.store.getResume('base')?.id).toBe('base');
    expect(temp.store.getResume('newgrad')?.extends).toBe('base');
  });
});

/*
 * What the deleted resume *contributed to the document* is kept. What it *was*
 * is not — those are different things, and the spread that implements the merge
 * cannot tell them apart on its own.
 */
describe('what a child does not inherit from a resume being deleted', () => {
  it('does not turn every variation into a pinned base', () => {
    temp.write('resumes/base.yaml', {
      id: 'base',
      label: 'Base resume',
      base: true,
      notes: 'The one I build from.',
      generatedFor: { company: 'Acme', role: 'Intern' },
      choices: { 'edu_neu.dates': 'v_may2026' },
      sections: [{ kind: 'education', entries: ['edu_neu'] }],
    });

    temp.store.deleteResume('base');

    for (const id of ['newgrad', 'intern']) {
      const child = temp.store.getResume(id);
      expect(child?.base, id).toBeUndefined();
      expect(child?.notes, id).toBeUndefined();
      // A resume tailored for one posting must not come back claiming it was
      // written for another.
      expect(child?.generatedFor, id).toBeUndefined();
      // And it keeps its own name.
      expect(child?.label, id).toBe(id === 'newgrad' ? 'New grad' : 'Summer intern');
      // While still inheriting what the base actually contributed.
      expect(child?.choices?.['edu_neu.dates'], id).toBeTruthy();
      expect(child?.sections?.length, id).toBeGreaterThan(0);
    }
  });

  it('keeps those fields when the child set them itself', () => {
    temp.write('resumes/base.yaml', { id: 'base', label: 'Base', base: true, notes: 'parent note' });
    temp.write('resumes/newgrad.yaml', {
      id: 'newgrad',
      label: 'New grad',
      extends: 'base',
      base: true,
      notes: 'my own note',
    });

    temp.store.deleteResume('base');

    const child = temp.store.getResume('newgrad');
    expect(child?.base).toBe(true);
    expect(child?.notes).toBe('my own note');
  });
});
