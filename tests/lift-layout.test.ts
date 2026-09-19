import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { liftLayout } from '../src/model/lift-layout.js';
import { resolveResume } from '../src/model/resolve.js';
import { makeTempStore } from './helpers.js';
import type { ResumeSpec } from '../src/model/types.js';

/*
 * A page setting every resume agrees on belongs to the save, not to each of
 * them.
 *
 * The fold that removed inheritance copied each base's layout down into every
 * resume that had been inheriting it. That is correct — the documents have to
 * come out the same — and it leaves the save in a state where the setting
 * meant to say "this is how I like a page" says nothing, because every resume
 * overrules it. The number in Settings changes and no resume moves, which is
 * the complaint the setting exists to answer, moved one level down and made
 * harder to see.
 *
 * Found by changing the save-wide font size on a real server and watching the
 * seeded base come back at the size it started.
 */

const spec = (id: string, layout?: ResumeSpec['layout']): ResumeSpec =>
  ({ id, label: id, ...(layout ? { layout } : {}) });

describe('lifting what they all agree on', () => {
  it('moves a setting they share up, and takes it off them', () => {
    const { layout, resumes, keys } = liftLayout([
      spec('a', { fontSizePt: 11, marginIn: 0.5 }),
      spec('b', { fontSizePt: 11, marginIn: 0.5 }),
    ]);

    expect(layout).toMatchObject({ fontSizePt: 11, marginIn: 0.5 });
    expect(keys.sort()).toEqual(['fontSizePt', 'marginIn']);
    // And off the resumes, or they would go on overruling it.
    for (const r of resumes) expect(r.layout).toBeUndefined();
  });

  /*
   * The case that actually occurs, and the reason this takes the common value
   * rather than demanding unanimity: twenty resumes at 11pt and one squeezed
   * to fit. Requiring agreement would lift nothing, and the save-wide setting
   * would go on saying nothing for the twenty because of the one.
   */
  it('lifts what most of them say, and leaves the odd one out saying its own', () => {
    const { layout, resumes, keys } = liftLayout([
      spec('a', { fontSizePt: 11, marginIn: 0.5 }),
      spec('b', { fontSizePt: 11, marginIn: 0.5 }),
      spec('squeezed', { fontSizePt: 10, marginIn: 0.5 }),
    ]);

    expect(keys.sort()).toEqual(['fontSizePt', 'marginIn']);
    expect(layout.fontSizePt).toBe(11);
    // Off the two that shared it —
    expect(resumes.find((r) => r.id === 'a')?.layout).toBeUndefined();
    // — and still on the one that did not, which is why it prints the same.
    expect(resumes.find((r) => r.id === 'squeezed')?.layout).toEqual({ fontSizePt: 10 });
  });

  /*
   * "Not stated" and "stated as the same value" are different. A resume that
   * never had an opinion should go on not having one, and lifting a value on
   * its behalf would pin the save to a number it was only inheriting from the
   * app.
   */
  it('does not lift a setting one of them never stated', () => {
    const { keys } = liftLayout([spec('a', { fontSizePt: 11 }), spec('quiet')]);
    expect(keys).toEqual([]);
  });

  it('does nothing to a save that has no resumes', () => {
    expect(liftLayout([])).toEqual({ layout: {}, resumes: [], keys: [] });
  });

  it('lifts the auto-fit floors one at a time, like everything else', () => {
    const { layout, resumes, keys } = liftLayout([
      spec('a', { fitBounds: { minFontSizePt: 10.2, minMarginIn: 0.5 } }),
      spec('b', { fitBounds: { minFontSizePt: 10.2, minMarginIn: 0.5 } }),
      spec('c', { fitBounds: { minFontSizePt: 10.2, minMarginIn: 0.6 } }),
    ]);

    expect(keys.sort()).toEqual(['fitBounds.minFontSizePt', 'fitBounds.minMarginIn']);
    expect(layout.fitBounds).toEqual({ minFontSizePt: 10.2, minMarginIn: 0.5 });
    // The one that differs keeps its own floor, and the key that is now empty
    // does not linger as a resume with an opinion it does not have.
    expect(resumes.find((r) => r.id === 'a')?.layout).toBeUndefined();
    expect(resumes.find((r) => r.id === 'c')?.layout?.fitBounds).toEqual({ minMarginIn: 0.6 });
  });

  it('leaves a resume with no layout at all alone', () => {
    const plain = [spec('a'), spec('b')];
    expect(liftLayout(plain).resumes).toBe(plain);
  });
});

describe('migrating a save whose resumes all carry the same page', () => {
  let temp: ReturnType<typeof makeTempStore>;
  beforeEach(() => { temp = makeTempStore(); });
  afterEach(() => temp.cleanup());

  /** The fixture's own shape: a base that states a layout, children that inherit it. */
  function inheritedLayout() {
    temp.write('resumes/base.yaml', {
      id: 'base',
      label: 'Base',
      sections: [{ kind: 'education', entries: ['edu_neu'] }],
      layout: { fontSizePt: 11, marginIn: 0.5 },
    });
    temp.write('resumes/newgrad.yaml', { id: 'newgrad', label: 'New grad', extends: 'base' });
    temp.write('resumes/intern.yaml', { id: 'intern', label: 'Intern', extends: 'base' });
  }

  it('leaves every resume printing exactly what it printed', () => {
    inheritedLayout();
    const before = Object.fromEntries(
      temp.store.load().resumes.map((r) => [r.id, resolveResume(r.id, temp.store.load()).layout]),
    );

    temp.store.migrateResumes();

    const after = temp.store.load();
    for (const r of after.resumes) {
      expect(resolveResume(r.id, after).layout, r.id).toEqual(before[r.id]);
    }
  });

  it('puts the page on the save and takes it off the resumes', () => {
    inheritedLayout();

    const { lifted } = temp.store.migrateResumes();

    expect(lifted).toContain('fontSizePt');
    expect(temp.store.loadConfig().layout).toMatchObject({ fontSizePt: 11, marginIn: 0.5 });
    for (const id of ['base', 'newgrad', 'intern']) {
      expect(temp.store.getResume(id)?.layout, id).toBeUndefined();
    }
  });

  /*
   * And then the setting actually does something, which is the whole point.
   * Without the lift this assertion fails on every save that has ever used
   * inheritance: the number changes and the document does not.
   */
  it('so that changing it once changes all of them', () => {
    inheritedLayout();
    temp.store.migrateResumes();

    temp.store.saveConfig({ layout: { fontSizePt: 12.5 } });

    const data = temp.store.load();
    for (const id of ['base', 'newgrad', 'intern']) {
      expect(resolveResume(id, data).layout.fontSizePt, id).toBe(12.5);
    }
  });

  /*
   * And the squeezed one keeps its own size while the rest follow the save.
   * This is the case the whole majority rule exists for.
   */
  it('and a resume set tighter than the rest stays tighter', () => {
    inheritedLayout();
    temp.write('resumes/squeezed.yaml', {
      id: 'squeezed',
      label: 'Squeezed',
      extends: 'base',
      layout: { fontSizePt: 10 },
    });
    temp.write('resumes/another.yaml', { id: 'another', label: 'Another', extends: 'base' });

    temp.store.migrateResumes();
    temp.store.saveConfig({ layout: { fontSizePt: 12.5 } });

    const data = temp.store.load();
    expect(resolveResume('base', data).layout.fontSizePt).toBe(12.5);
    expect(resolveResume('squeezed', data).layout.fontSizePt).toBe(10);
  });
});

describe('what the migration actually writes', () => {
  let temp: ReturnType<typeof makeTempStore>;
  beforeEach(() => { temp = makeTempStore(); });
  afterEach(() => temp.cleanup());

  /*
   * A resume none of the passes changed is not rewritten.
   *
   * Which pass ran is the wrong question: the lift takes a key off some
   * resumes and not others, so "something was lifted" and "was this one of
   * them" are different. Writing on the coarser answer put every file in the
   * save into one commit, most identical to themselves, burying the ones that
   * did change in the history somebody would read to find them.
   */
  it('leaves a resume the passes did not touch exactly as it was on disk', () => {
    // Two that share a layout, so the lift has something to do —
    temp.write('resumes/base.yaml', {
      id: 'base', label: 'Base', tier: 'base',
      sections: [{ kind: 'education', entries: ['edu_neu'] }],
      layout: { fontSizePt: 11 },
    });
    temp.write('resumes/other.yaml', {
      id: 'other', label: 'Other', tier: 'extended',
      sections: [{ kind: 'education', entries: ['edu_neu'] }],
      layout: { fontSizePt: 11 },
    });
    /*
     * — and one that keeps its own size, so the lift leaves it alone.
     *
     * It has to state the key: a resume with no layout at all blocks the
     * lift entirely, because it was taking the app's default and putting a
     * number on the save would move it. That rule is tested above; this is
     * about what gets *written*, so the fixture has to be one where the lift
     * happens and this resume is still untouched by it.
     */
    /*
     * Written as raw YAML with a comment in it, because that is the only
     * thing that can tell "not written" from "written back identically" —
     * and it is the honest signal, too. The folder is advertised as editable
     * YAML, so a note somebody left in a file is theirs, and a rewrite it did
     * not need would take it away.
     */
    temp.write(
      'resumes/untouched.yaml',
      '# Kept small on purpose — this one has to fit beside a long cover letter.\n' +
        'id: untouched\nlabel: Untouched\ntier: extended\n' +
        'sections:\n  - kind: education\n    entries: [edu_neu]\n' +
        'layout:\n  fontSizePt: 10\n',
    );
    const before = fs.readFileSync(path.join(temp.dir, 'resumes/untouched.yaml'), 'utf8');

    const { lifted } = temp.store.migrateResumes();

    expect(lifted).toContain('fontSizePt');
    expect(temp.store.getResume('base')?.layout).toBeUndefined();
    expect(fs.readFileSync(path.join(temp.dir, 'resumes/untouched.yaml'), 'utf8')).toBe(before);
  });
});
