import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_LAYOUT, layoutFor } from '../src/model/types.js';
import { resolveResume } from '../src/model/resolve.js';
import { makeTempStore } from './helpers.js';

/*
 * Where a page's settings live, now that resumes do not inherit.
 *
 * Layout was the one thing inheritance carried that nothing else covers. A
 * base stated the font size and the margins; every variation of it took them,
 * and changing the base changed all of them at once. Resumes stand alone now,
 * so without somewhere to say it once, "make my margins a little wider" is an
 * edit to every resume in the save — and the next resume you make would still
 * come out with the old ones.
 *
 * It belongs to the save rather than to a resume anyway: how you like a page
 * to look is not a fact about the job you are applying for. The per-resume
 * setting stays for the one document that has to be squeezed harder to fit.
 */

let temp: ReturnType<typeof makeTempStore>;

beforeEach(() => {
  temp = makeTempStore();
});
afterEach(() => temp.cleanup());

describe('the page a resume is set on', () => {
  it('takes the app’s defaults when neither the save nor the resume says', () => {
    expect(layoutFor(undefined, undefined)).toEqual(DEFAULT_LAYOUT);
  });

  it('takes the save’s where it has one', () => {
    expect(layoutFor(undefined, { marginIn: 0.7 }).marginIn).toBe(0.7);
    // And the rest still comes from the app, rather than the save having to
    // restate everything to change one thing.
    expect(layoutFor(undefined, { marginIn: 0.7 }).fontSizePt).toBe(DEFAULT_LAYOUT.fontSizePt);
  });

  it('lets one resume overrule the save', () => {
    const l = layoutFor({ fontSizePt: 9.5 }, { fontSizePt: 11, marginIn: 0.7 });
    expect(l.fontSizePt).toBe(9.5); // the resume's
    expect(l.marginIn).toBe(0.7); // still the save's
  });

  /*
   * The floors are a third level of the same thing, and the reason they are
   * merged separately: raising the margin floor should not silently drop the
   * font floor back to this version's, which is a change nobody asked for
   * and would not notice until a resume came out set smaller than allowed.
   */
  it('merges the auto-fit floors one at a time', () => {
    const l = layoutFor({ fitBounds: { minMarginIn: 0.5 } }, { fitBounds: { minFontSizePt: 10.2 } });
    expect(l.fitBounds.minMarginIn).toBe(0.5); // the resume's
    expect(l.fitBounds.minFontSizePt).toBe(10.2); // the save's
    expect(l.fitBounds.minSpacing).toBe(DEFAULT_LAYOUT.fitBounds.minSpacing); // the app's
  });
});

describe('a save that has said how it likes a page', () => {
  it('sets every resume in it, without any of them mentioning it', () => {
    temp.write('config.yaml', {
      ai: { enabled: false },
      git: { autoCommit: false },
      output: { dir: 'out' },
      layout: { fontSizePt: 11.5, marginIn: 0.75 },
    });
    // None of these state a layout of their own.
    for (const id of ['base', 'newgrad', 'intern']) {
      temp.write(`resumes/${id}.yaml`, { id, label: id, sections: [{ kind: 'education', entries: ['edu_neu'] }] });
    }

    const data = temp.store.load();
    for (const id of ['base', 'newgrad', 'intern']) {
      const l = resolveResume(id, data).layout;
      expect(l.fontSizePt, id).toBe(11.5);
      expect(l.marginIn, id).toBe(0.75);
    }
  });

  it('and one resume can still be set tighter than the rest', () => {
    temp.write('config.yaml', {
      ai: { enabled: false },
      git: { autoCommit: false },
      output: { dir: 'out' },
      layout: { fontSizePt: 11.5, marginIn: 0.75 },
    });
    temp.write('resumes/base.yaml', {
      id: 'base',
      label: 'Base',
      sections: [{ kind: 'education', entries: ['edu_neu'] }],
      layout: { fontSizePt: 10 },
    });

    const l = resolveResume('base', temp.store.load()).layout;
    expect(l.fontSizePt).toBe(10); // squeezed
    expect(l.marginIn).toBe(0.75); // but still the save's margin
  });
});

describe('changing the save’s page settings', () => {
  it('keeps the settings it was not asked about', () => {
    temp.store.saveConfig({ layout: { fontSizePt: 11.5, marginIn: 0.75 } });
    temp.store.saveConfig({ layout: { marginIn: 0.5 } });

    const { layout } = temp.store.loadConfig();
    expect(layout?.marginIn).toBe(0.5);
    expect(layout?.fontSizePt).toBe(11.5);
  });

  /*
   * And the floors likewise. Sending one floor used to drop the other two
   * back to this version's — a resume set smaller than its owner had allowed,
   * for no reason they would ever see.
   */
  it('keeps the auto-fit floors it was not asked about', () => {
    temp.store.saveConfig({ layout: { fitBounds: { minFontSizePt: 10.2, minMarginIn: 0.5 } } });
    temp.store.saveConfig({ layout: { fitBounds: { minMarginIn: 0.6 } } });

    const { layout } = temp.store.loadConfig();
    expect(layout?.fitBounds?.minMarginIn).toBe(0.6);
    expect(layout?.fitBounds?.minFontSizePt).toBe(10.2);
  });

  it('leaves the rest of the settings alone', () => {
    temp.store.saveConfig({ output: { dir: 'somewhere-else' } });
    temp.store.saveConfig({ layout: { fontSizePt: 12 } });

    const config = temp.store.loadConfig();
    expect(config.output.dir).toBe('somewhere-else');
    expect(config.layout?.fontSizePt).toBe(12);
  });

  it('is absent by default, so a save follows the app rather than freezing', () => {
    // A save created today should not be pinned to today's numbers: absent
    // means "whatever this version thinks a resume should look like".
    expect(temp.store.loadConfig().layout).toEqual({});
  });
});
