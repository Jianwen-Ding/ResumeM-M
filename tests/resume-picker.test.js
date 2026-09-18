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
 * It grows by one every time the extension builds an application and never
 * shrinks, so the two or three documents somebody actually starts from end up
 * scattered alphabetically through everything they have ever sent. The editor
 * already split the list in two — but only once a resume had been pinned as a
 * base, and nothing is pinned in a store nobody has pinned anything in, which
 * is every store to begin with. So the grouping appeared for people who had
 * already found the pin, and stayed away from everyone who had not.
 *
 * The extension's own picker answers this with the id: the server names what
 * it generates `job-<company>-<role>`, and nothing else is named that way.
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

  const written = [
    { id: 'new-grad', label: 'New Grad', choices: {} },
    { id: 'backend', label: 'Backend', choices: {} },
  ];
  const built = [
    { id: 'job-helios-platform-engineer', label: 'Helios — Platform Engineer', choices: {} },
    { id: 'job-lyra-data-scientist', label: 'Lyra — Data Scientist', choices: {} },
  ];

  it('separates what you wrote from what was built for a posting, with nothing pinned', async () => {
    await open([...written, ...built]);
    expect(groups()).toEqual(['Your resumes', 'Built for a posting']);
    expect(inGroup('Your resumes')).toEqual(['New Grad', 'Backend']);
    expect(inGroup('Built for a posting')).toEqual(['Helios — Platform Engineer', 'Lyra — Data Scientist']);
  });

  /*
   * A pin is a deliberate statement about which resume is a starting point,
   * and it has to beat a guess made from a name — otherwise pinning one of the
   * tailored resumes, which is a perfectly reasonable thing to do with a good
   * one, would do nothing visible.
   */
  it('lets a pin overrule the naming, and says so in the labels', async () => {
    await open([...written, ...built.map((r, i) => (i === 0 ? { ...r, base: true } : r))]);
    expect(groups()).toEqual(['Bases', 'Variations']);
    expect(inGroup('Bases')).toEqual(['Helios — Platform Engineer']);
    expect(inGroup('Variations')).toEqual(['New Grad', 'Backend', 'Lyra — Data Scientist']);
  });

  /*
   * A new store has nothing built for a posting in it yet, and a heading over
   * a group with nothing beside it is a division of one thing into one thing.
   */
  it('does not divide a list that has nothing to divide', async () => {
    await open(written);
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
