import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveResume } from '../src/model/resolve.js';
import { makeTempStore } from './helpers.js';

/*
 * Deleting one resume used to break the others, and this is the file that
 * held the line on it.
 *
 * Variations were thin: "new grad" was the base resume plus a handful of
 * choices, recorded as `extends: base`. Deleting the base unlinked its file
 * and nothing else, so every variation built on it threw "extends 'base',
 * which does not exist" from that moment on — in the editor, in the preview,
 * in the tracker, everywhere, with nothing in the UI able to edit `extends`
 * and so no way back but hand-editing YAML. The fix was to rewrite every
 * child on the way past, folding in what the deleted resume had contributed,
 * and *that* then had to be careful about which of its fields were content
 * and which were identity — a distinction the spread implementing the merge
 * could not make on its own, so it got that wrong too and handed every
 * variation the base's `generatedFor`.
 *
 * None of that exists now. Resumes stand alone, so deleting one has nothing
 * to rewrite and nothing to get wrong. The tests stay, pointed at the
 * property that replaced the machinery: the delete touches one file.
 */

let temp: ReturnType<typeof makeTempStore>;

beforeEach(() => {
  temp = makeTempStore();
});
afterEach(() => temp.cleanup());

describe('deleting a resume other resumes were copied from', () => {
  /*
   * The one that caught a real fault. Folding happens on read, so deleting
   * the base of a save still written in the old shape left the children with
   * nothing to fold: every section the base was contributing vanished,
   * silently, on the next read. The delete folds the files first now.
   */
  it('leaves the others resolving, and resolving to what they did', () => {
    const data = temp.store.load();
    const before = Object.fromEntries(
      data.resumes.filter((r) => r.id !== 'base').map((r) => [r.id, resolveResume(r.id, data)]),
    );

    temp.store.deleteResume('base');

    const after = temp.store.load();
    expect(after.resumes.map((r) => r.id).sort()).toEqual(['intern', 'newgrad']);
    for (const r of after.resumes) {
      expect(resolveResume(r.id, after), r.id).toEqual(before[r.id]);
    }
  });

  it('does not touch the file of any other resume', () => {
    // After the one-time fold, which the delete runs first and which is the
    // last thing that ever rewrites a file it was not asked about.
    temp.store.migrateResumes();
    const newgrad = temp.read('resumes/newgrad.yaml');
    const intern = temp.read('resumes/intern.yaml');

    temp.store.deleteResume('base');

    expect(temp.read('resumes/newgrad.yaml')).toEqual(newgrad);
    expect(temp.read('resumes/intern.yaml')).toEqual(intern);
  });

  it('does not touch resumes that were never copied from it', () => {
    temp.store.migrateResumes();
    const untouched = temp.read('resumes/intern.yaml');
    temp.write('resumes/solo.yaml', { id: 'solo', label: 'Solo', choices: { z: 'q' } });

    temp.store.deleteResume('solo');

    expect(temp.read('resumes/intern.yaml')).toEqual(untouched);
    expect(temp.exists('resumes/solo.yaml')).toBe(false);
  });

  it('deletes both spellings of the filename', () => {
    // A hand-made `.yml` beside the `.yaml` the app writes. Leaving one
    // behind would have the resume come back on the next read.
    temp.write('resumes/twice.yml', { id: 'twice', label: 'Twice' });
    temp.write('resumes/twice.yaml', { id: 'twice', label: 'Twice' });

    temp.store.deleteResume('twice');

    expect(temp.exists('resumes/twice.yml')).toBe(false);
    expect(temp.exists('resumes/twice.yaml')).toBe(false);
  });

  it('is quiet about a resume that is not there', () => {
    // The editor deletes and reloads; a double click should not raise.
    expect(() => temp.store.deleteResume('never-existed')).not.toThrow();
    expect(temp.store.loadResumes()).toHaveLength(3);
  });
});
