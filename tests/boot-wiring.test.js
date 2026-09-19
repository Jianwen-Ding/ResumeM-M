// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { makeTempStore } from './helpers.ts';

vi.mock('../web/preview.js', () => ({ createPreview: () => ({ show: async () => {} }) }));
vi.mock('../web/assets.js', () => ({
  setupAssets: () => ({
    // The real one enables the tab strip once a save is open, and the tabs
    // start disabled in the markup. A stub that skips that leaves every tab
    // button inert, so `showTab` clicks nothing and the deep link looks
    // broken for a reason that has nothing to do with deep links.
    init: async () => {
      for (const b of document.querySelectorAll('#tabs button')) b.disabled = false;
      return { current: '/test-save' };
    },
    load: async () => {},
  }),
}));

/*
 * One jsdom window, several boots of the editor in it.
 *
 * `vi.resetModules()` gets a fresh copy of `app.js` per test, and replacing
 * `documentElement.innerHTML` gets it a fresh page — but the copies from the
 * tests before are still subscribed to `hashchange` on the same window, and
 * they look their elements up by id at the moment they run. So a test that
 * changes the hash wakes three stale editors, each of which redraws the page
 * in front of this one from a state of its own, and the screen ends up
 * showing a resume nothing in this test ever asked for.
 *
 * It fails as a flake, which is the expensive kind: whichever assertion the
 * stale redraw lands on top of. Every listener a boot registers is recorded
 * here and taken off again after it.
 */
const registered = [];
for (const on of [window, document]) {
  const real = on.addEventListener.bind(on);
  on.addEventListener = (type, fn, opts) => {
    registered.push([on, type, fn, opts]);
    real(type, fn, opts);
  };
}

afterEach(() => {
  for (const [on, type, fn, opts] of registered.splice(0)) on.removeEventListener(type, fn, opts);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/*
 * The controls have to work as soon as they are on screen.
 *
 * Arriving on a deep link — which is how the browser extension sends you here
 * — the editor drew the toolbar, then waited on the request that opens the
 * linked resume before attaching a single handler. In between, the resume
 * dropdown was a full list attached to nothing: picking one did nothing, said
 * nothing, and the next repaint put the old name back, so it read as a broken
 * control rather than as a slow one.
 *
 * It cost three full browser runs to find, because the window is invisible on
 * an idle machine and wide on a loaded one. Here the slow request is simply
 * held open, which makes the window as wide as the test likes.
 */
describe('arriving on a deep link', () => {
  let data;
  let release;

  beforeEach(async () => {
    vi.resetModules();
    document.documentElement.innerHTML = fs.readFileSync('web/index.html', 'utf8');
    window.location.hash = '#resumes/intern';

    const fixture = makeTempStore();
    data = fixture.store.load();
    fixture.cleanup();

    // The one request the deep link waits on, held open until the test says.
    const held = new Promise((done) => {
      release = done;
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, options = {}) => {
        let result = {};
        if (url === '/api/store') result = data;
        else if (url === '/api/ai/jobs') result = { jobs: [] };
        else if (url.startsWith('/api/resumes/') && url.includes('/resolved')) await held;
        else if (url === '/api/render') {
          await held;
          result = { pages: 1, fits: true, adjustments: [], pdfUrl: '/pdf/x.pdf' };
        }
        return { ok: true, json: async () => structuredClone(result) };
      }),
    );

    await import('../web/app.js');
    // The dropdown has been drawn and filled: as far as anyone looking at the
    // screen is concerned, the editor is ready.
    await vi.waitFor(() => expect(document.querySelector('#resume-select option')).not.toBeNull());
  });

  it('answers the resume dropdown before the linked resume has finished loading', async () => {
    const selector = document.querySelector('#resume-select');
    expect([...selector.options].map((o) => o.value)).toContain('__master__');

    selector.value = '__master__';
    selector.dispatchEvent(new Event('change'));

    // The master view is built from the store, which is already here — so
    // there is nothing legitimate for this to be waiting on.
    await vi.waitFor(() => expect(document.querySelector('.master-source-variant')).not.toBeNull());
    expect(selector.value).toBe('__master__');

    release();
  });

  it('has its buttons wired too, not only the dropdown', async () => {
    // Every handler in `boot` sat behind the same wait; the dropdown is the
    // one that was noticed because it is the one people reach for first.
    for (const id of ['#btn-add-entry', '#btn-save-as', '#btn-rebuild', '#btn-add-app', '#btn-new-draft']) {
      const button = document.querySelector(id);
      expect(button, id).not.toBeNull();
      expect(typeof button.onclick, id).toBe('function');
    }
    release();
  });
});

/*
 * The other end of the same links: the resume they point at is gone.
 *
 * This used to be somebody having deleted a variation by hand, and it said so
 * by printing the filename — `job-helios-platform-engineer`, which names
 * nothing anyone has typed and reads as a fault. A resume built for one
 * posting is now removed a week after that application is done with, so every
 * way back from an older application lands here, and what it has to say is
 * what is still true: the files that were sent are on the application, and
 * the version history still has the resume.
 */
describe('arriving on a link to a resume that is no longer in the save', () => {
  const gone = 'job-helios-platform-engineer';

  beforeEach(async () => {
    vi.resetModules();
    document.documentElement.innerHTML = fs.readFileSync('web/index.html', 'utf8');
    window.location.hash = `#resumes/${gone}`;

    const fixture = makeTempStore();
    const data = fixture.store.load();
    fixture.cleanup();

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url) => {
        let result = {};
        if (url === '/api/store') result = data;
        else if (url === '/api/ai/jobs') result = { jobs: [] };
        else if (url === '/api/render') result = { pages: 1, fits: true, adjustments: [], pdfUrl: '/pdf/x.pdf' };
        return { ok: true, json: async () => structuredClone(result) };
      }),
    );

    await import('../web/app.js');
    await vi.waitFor(() => expect(document.querySelector('#status.err')?.textContent).toBeTruthy());
  });

  it('says what happened to it, in words', () => {
    const said = document.querySelector('#status').textContent;
    expect(said).toMatch(/no longer in the save/i);
    // The two things that are still there, which is the whole of the answer.
    expect(said).toMatch(/files that were sent/i);
    expect(said).toMatch(/version history/i);
  });

  it('does not print the filename at anyone', () => {
    expect(document.querySelector('#status').textContent).not.toContain(gone);
  });

  it('still opens the builder, rather than leaving whatever tab was showing', () => {
    expect(document.querySelector('#tab-resumes')?.classList.contains('active')).toBe(true);
  });
});

/*
 * Following one of these links with an edit that has not saved.
 *
 * The dropdown has always refused to move in that case — it writes first, and
 * if the write will not go it stays where it is and says so, because the edit
 * exists only in the page and switching resumes is where it would be lost.
 * The hash route did the writing but not the refusing: the write failed, the
 * route moved anyway, and the edit went with it.
 *
 * The address has to come back too. Left pointing at the resume that was not
 * opened, the Back button — which is how most people arrive here — and a
 * reload both take you to it, and the edit that would not save is gone.
 */
describe('a link followed while the save is failing', () => {
  let data;

  beforeEach(async () => {
    vi.resetModules();
    document.documentElement.innerHTML = fs.readFileSync('web/index.html', 'utf8');
    window.location.hash = '#resumes/intern';

    const fixture = makeTempStore();
    data = fixture.store.load();
    fixture.cleanup();

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, options = {}) => {
        let result = {};
        if (url === '/api/store') result = data;
        else if (url === '/api/ai/jobs') result = { jobs: [] };
        else if (url === '/api/render') result = { pages: 1, fits: true, adjustments: [], pdfUrl: '/pdf/x.pdf' };
        else if (url.startsWith('/api/resumes/') && options.method === 'PUT') {
          // The disk is full, the save folder is read-only, the server is
          // being restarted — the editor cannot tell which, only that the
          // edit is still only in the page.
          return { ok: false, status: 500, statusText: 'Internal Server Error', json: async () => ({ error: 'no space left on device' }) };
        }
        return { ok: true, json: async () => structuredClone(result) };
      }),
    );

    await import('../web/app.js');
    await vi.waitFor(() => expect(document.querySelector('#resume-select')?.value).toBe('intern'));
    await vi.waitFor(() => expect(document.querySelector('#tab-resumes .toggle input')).not.toBeNull());

    // An edit, inside the auto-save debounce: exactly the window this is about.
    document.querySelector('#tab-resumes .toggle input').click();

    // Assigning the hash is what the link does, and jsdom raises
    // `hashchange` for it the way a browser does.
    window.location.hash = '#resumes/newgrad';
    await vi.waitFor(() => expect(document.querySelector('#status.err')?.textContent).toBeTruthy());
  });

  it('stays on the resume the edit belongs to', async () => {
    expect(document.querySelector('#resume-select').value).toBe('intern');
    expect(document.querySelector('#status').textContent).toMatch(/has not saved yet/i);
  });

  it('puts the address back on it, so the way out does not lose the edit', async () => {
    await vi.waitFor(() => expect(window.location.hash).toBe('#resumes/intern'));
  });
});
