// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { makeTempStore } from './helpers.ts';

vi.mock('../web/preview.js', () => ({ createPreview: () => ({ show: async () => {} }) }));
vi.mock('../web/assets.js', () => ({
  setupAssets: () => ({
    init: async () => {
      for (const b of document.querySelectorAll('#tabs button')) b.disabled = false;
      return { current: '/test-save' };
    },
    load: async () => {},
  }),
}));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/*
 * The list of resumes, after a month of using this.
 *
 * It grows by one every time the extension builds an application, so the two
 * or three documents somebody actually starts from end up scattered
 * alphabetically through everything they have ever sent. The editor split the
 * list in two — but only once a resume had been pinned as a base, and nothing
 * is pinned in a store nobody has pinned anything in, which is every store to
 * begin with. So the grouping appeared for people who had already found the
 * pin and stayed away from everyone who had not.
 *
 * Every resume has a tier now, including the ones a migration gave one to, so
 * there is always something to group by: what you build from, what you keep,
 * and what was made for one posting and will be swept when that posting is
 * done with.
 */
describe('picking a resume out of a store that has been used', () => {
  const groups = () => [...document.querySelectorAll('#resume-select optgroup')].map((g) => g.label);
  const inGroup = (label) =>
    [...document.querySelectorAll('#resume-select optgroup')]
      .filter((g) => g.label === label)
      .flatMap((g) => [...g.children].map((o) => o.textContent));

  /** A store with `resumes` replaced, and a fetch that serves it. */
  async function open(resumes) {
    vi.resetModules();
    document.documentElement.innerHTML = fs.readFileSync('web/index.html', 'utf8');
    window.location.hash = '#resumes';

    const fixture = makeTempStore();
    const data = { ...fixture.store.load(), resumes };
    fixture.cleanup();

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url) => {
        let result = {};
        if (url === '/api/store') result = data;
        else if (url === '/api/ai/jobs') result = { jobs: [] };
        return { ok: true, json: async () => structuredClone(result) };
      }),
    );

    await import('../web/app.js');
    await vi.waitFor(() => expect(document.querySelectorAll('#resume-select option').length).toBeGreaterThan(1));
  }

  const KEPT = 'Kept';
  const BASES = 'Bases — what you build from';
  const GOING = 'Made for a posting — swept when it is done';

  const written = [
    { id: 'new-grad', label: 'New Grad', tier: 'extended', choices: {} },
    { id: 'backend', label: 'Backend', tier: 'extended', choices: {} },
  ];
  const built = [
    { id: 'job-helios-platform-engineer', label: 'Helios — Platform Engineer', tier: 'temporary', choices: {} },
    { id: 'job-lyra-data-scientist', label: 'Lyra — Data Scientist', tier: 'temporary', choices: {} },
  ];

  it('separates what you keep from what was built for a posting', async () => {
    await open([...written, ...built]);
    expect(groups()).toEqual([KEPT, GOING]);
    expect(inGroup(KEPT)).toEqual(['New Grad', 'Backend']);
    expect(inGroup(GOING)).toEqual(['Helios — Platform Engineer', 'Lyra — Data Scientist']);
  });

  /*
   * Marking a base is a deliberate statement about which resume is a starting
   * point, and marking one of the tailored ones is a perfectly reasonable
   * thing to do with a good one.
   */
  it('puts a base of its own in front of both', async () => {
    await open([...written, ...built.map((r, i) => (i === 0 ? { ...r, tier: 'base' } : r))]);
    expect(groups()).toEqual([BASES, KEPT, GOING]);
    expect(inGroup(BASES)).toEqual(['Helios — Platform Engineer']);
    expect(inGroup(KEPT)).toEqual(['New Grad', 'Backend']);
    expect(inGroup(GOING)).toEqual(['Lyra — Data Scientist']);
  });

  /*
   * A resume with no tier written on it is one this save has not been
   * migrated for, or one somebody wrote by hand. It is kept, and it appears
   * among the kept — not in its own group, and never among the ones about to
   * be swept.
   */
  it('shows a resume with no tier among the ones it keeps', async () => {
    await open([{ id: 'handmade', label: 'Written By Hand', choices: {} }, ...built]);
    expect(groups()).toEqual([KEPT, GOING]);
    expect(inGroup(KEPT)).toEqual(['Written By Hand']);
  });

  /*
   * A new store has nothing built for a posting in it yet, and a heading over
   * a group with nothing beside it is a division of one thing into one thing.
   */
  it('does not divide a list that has nothing to divide', async () => {
    await open(written);
    // One group is no grouping: a heading over the whole list divides one
    // thing into one thing.
    expect(groups()).toEqual([]);
    expect([...document.querySelectorAll('#resume-select option')].map((o) => o.textContent)).toEqual([
      'Master Document — All Source Content',
      'New Grad',
      'Backend',
    ]);
  });

  /*
   * And the master document stays where it is: first, outside either group,
   * because it is not one of the resumes — it is all of them at once.
   */
  it('keeps the master document out of the grouping', async () => {
    await open([...written, ...built]);
    const first = document.querySelector('#resume-select').firstElementChild;
    expect(first.tagName).toBe('OPTION');
    expect(first.value).toBe('__master__');
  });
});
