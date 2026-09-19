// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { makeTempStore } from './helpers.ts';

vi.mock('../web/preview.js', () => ({ createPreview: () => ({ show: async () => {} }) }));
/*
 * The asset panel is stubbed, but not the one wire this file is about: the
 * real `load` is what draws the save panel, and the sweep control lives on it.
 */
vi.mock('../web/assets.js', () => ({
  setupAssets: ({ loadProjectSettings }) => ({
    init: async () => {
      for (const b of document.querySelectorAll('#tabs button')) b.disabled = false;
      return { current: '/test-save' };
    },
    load: async () => loadProjectSettings(),
  }),
}));

/*
 * The one button in the program that deletes somebody's work.
 *
 * What makes pressing it acceptable is that the version history keeps what
 * went — so the case that matters here is the one where it does not. A resume
 * written while the save history was off, or one whose commit failed and was
 * never retried, is on disk and in no commit at all, and the server refuses to
 * take it rather than perform the only unrecoverable act in the program.
 *
 * Refusing quietly would be its own fault: the person pressed a button that
 * said it would remove three resumes and three resumes are still there. The
 * refusal is worth more than the sweep, because what it is really reporting is
 * that the save history is not working.
 */
describe('sweeping from the save panel', () => {
  let reply;
  let asked;
  let brokenHistory;
  let autoCommit;

  const openPanel = async () => {
    document.querySelector('#tabs button[data-tab="save"]').click();
    await vi.waitFor(() => expect(document.querySelector('.temporary-life')).not.toBeNull());
  };

  const sweepButton = () =>
    [...document.querySelectorAll('.temporary-life button')].find((b) =>
      b.textContent.startsWith('Sweep'),
    );

  const press = async () => {
    sweepButton().click();
    await vi.waitFor(() => expect(document.querySelector('#modal:not(.hidden)')).not.toBeNull());
    document.querySelector('#modal-ok').click();
  };

  beforeEach(async () => {
    vi.resetModules();
    document.documentElement.innerHTML = fs.readFileSync('web/index.html', 'utf8');
    window.location.hash = '';

    const fixture = makeTempStore();
    const data = fixture.store.load();
    fixture.cleanup();

    const due = [
      { id: 'job-helios', label: 'Platform Engineer — Helios' },
      { id: 'job-lyra', label: 'Data Scientist — Lyra' },
    ];
    reply = { swept: due, held: [], days: 7 };
    brokenHistory = undefined;
    autoCommit = true;
    asked = [];

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, options = {}) => {
        asked.push(String(url));
        let result = {};
        if (url === '/api/store') result = data;
        else if (url === '/api/ai/jobs') result = { jobs: [] };
        else if (url === '/api/render') result = { pages: 1, fits: true, adjustments: [], pdfUrl: '/pdf/x.pdf' };
        // `overrides` says which settings an environment variable has taken
        // out of the user's hands; the panel reads it to disable those boxes.
        else if (url === '/api/config') {
          result = { ...data.config, git: { ...data.config.git, autoCommit }, overrides: {} };
        }
        else if (url === '/api/config/store') {
          result = {
            dir: '/test-save', isRepo: true, commits: 3, remote: {}, pending: [],
            lastCommitError: brokenHistory,
          };
        } else if (url === '/api/resumes/expiring') result = { due, days: 7 };
        else if (url === '/api/resumes/sweep' && options.method === 'POST') result = reply;
        return { ok: true, json: async () => structuredClone(result) };
      }),
    );

    await import('../web/app.js');
    await vi.waitFor(() => expect(document.querySelector('#resume-select option')).not.toBeNull());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('offers to take the ones that are due, by name', async () => {
    await openPanel();
    expect(sweepButton()?.textContent).toBe('Sweep 2 resumes now');
    expect(document.querySelector('.temporary-life .result').textContent).toContain(
      'Platform Engineer — Helios',
    );
  });

  it('asks first, and says what stays behind', async () => {
    await openPanel();
    sweepButton().click();
    await vi.waitFor(() => expect(document.querySelector('#modal:not(.hidden)')).not.toBeNull());
    const said = document.querySelector('#modal').textContent;
    expect(said).toContain('Platform Engineer — Helios');
    expect(said).toMatch(/version history/i);
  });

  it('says how many went when they went', async () => {
    await openPanel();
    await press();

    await vi.waitFor(() => expect(asked).toContain('/api/resumes/sweep'));
    await vi.waitFor(() => expect(document.querySelector('#status').textContent).toBe('Swept 2 resumes'));
    expect(document.querySelector('#status').className).not.toContain('err');
  });

  /*
   * The case this file is really for. The server kept them because the
   * history does not have them, and saying "Swept 0 resumes" — or nothing at
   * all — leaves somebody looking at two resumes they just asked to be rid of
   * with no idea why they are still there, and no idea that their save
   * history has stopped working.
   */
  it('says why, and how to fix it, when it kept them instead', async () => {
    reply = { swept: [], held: [{ id: 'job-helios', label: 'Platform Engineer — Helios' }], days: 7 };
    await openPanel();
    await press();

    await vi.waitFor(() => {
      const chip = document.querySelector('#status');
      expect(chip.className).toContain('err');
      expect(chip.textContent).toMatch(/version history does not have it/i);
    });
    // The thing to do about it, named as it is named on this same panel.
    expect(document.querySelector('#status').textContent).toMatch(/Save History/);
    // And never the cheerful one alongside it.
    expect(document.querySelector('#status').textContent).not.toMatch(/^Swept/);
  });

  it('counts them properly when it kept more than one', async () => {
    reply = {
      swept: [],
      held: [
        { id: 'job-helios', label: 'Platform Engineer — Helios' },
        { id: 'job-lyra', label: 'Data Scientist — Lyra' },
      ],
      days: 7,
    };
    await openPanel();
    await press();

    await vi.waitFor(() =>
      expect(document.querySelector('#status').textContent).toMatch(/Kept 2 resumes that are due/),
    );
  });

  /*
   * Why a resume could not be filed, said where somebody will see it.
   *
   * The refusal above is the safe outcome, but on its own it is a mystery: a
   * button that says it will remove two resumes, pressed, and two resumes are
   * still there. The cause is one panel up — auto-commit has been failing, in
   * silence, because a failed commit cannot be allowed to fail the edit that
   * it goes with.
   */
  it('says the version history has stopped, when it has', async () => {
    brokenHistory = { message: "Unable to create '.git/index.lock': File exists", at: '2026-09-12T10:00:00Z' };

    await openPanel();

    const said = document.querySelector('#project-settings .result.bad')?.textContent;
    expect(said).toMatch(/version history/i);
    expect(said).toMatch(/index\.lock/);
    // And the reassurance that goes with it, because the frightening reading
    // of "nothing has been recorded" is that the work itself is gone.
    expect(said).toMatch(/files are all written/i);
  });

  it('says nothing about it when the history was never meant to run itself', async () => {
    // Auto-commit off is a choice. A stale failure from before it was
    // switched off is not news, and reads as a fault that needs fixing.
    brokenHistory = { message: 'anything at all', at: '2026-09-12T10:00:00Z' };
    autoCommit = false;

    await openPanel();

    expect(document.querySelector('#project-settings .result.bad')).toBeNull();
  });

  it('does nothing at all if the question is answered no', async () => {
    await openPanel();
    sweepButton().click();
    await vi.waitFor(() => expect(document.querySelector('#modal:not(.hidden)')).not.toBeNull());
    document.querySelector('#modal-cancel').click();

    /*
     * Give the click somewhere to go first. This is an assertion about a
     * request that is never made, and a request that *is* made goes out a
     * microtask after the modal resolves — so asserting straight away passes
     * whether the answer was read or thrown away.
     */
    await vi.waitFor(() => expect(document.querySelector('#modal.hidden')).not.toBeNull());
    await new Promise((settle) => setTimeout(settle, 20));
    expect(asked).not.toContain('/api/resumes/sweep');
  });
});
