// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { makeTempStore } from './helpers.ts';

vi.mock('../web/preview.js', () => ({ createPreview: () => ({ show: async () => {}, clear: () => {} }) }));
vi.mock('../web/assets.js', () => ({
  setupAssets: () => ({
    init: async () => {
      for (const b of document.querySelectorAll('#tabs button')) b.disabled = false;
      return { current: '/test-save' };
    },
    load: async () => {},
  }),
}));

/* See boot-wiring.test.js: every listener a boot adds comes off after it. */
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
  delete document.visibilityState;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/*
 * An edit made just before the page goes away.
 *
 * The editor walk unfolded an entry and reloaded, and with the page slowed the
 * entry came back folded. The page does write on the way out: hiding it runs
 * `flushEdits`, which starts the resume's save at once. But that save was a
 * plain `fetch`, and a browser cancels a plain request when its page unloads.
 * In Chromium, with the API held 600ms, the PUT was started and then failed
 * with net::ERR_ABORTED, three reloads of three. The commit after it had
 * `keepalive` and the save it was meant to commit did not.
 *
 * Here "the page has gone" is the first timer after the event: once a page is
 * unloading nothing on a timer runs, so a save has to have been asked for
 * before then, and asked for in the one form that outlives the page.
 */
describe('an edit made just before leaving the page', () => {
  let requests;
  let pageGone;
  // A promise the next resume PUT's reply waits on, to hold a save in flight.
  let holdPut;

  const fold = (id) => document.querySelector(`#editor .entry[data-drag-id="${id}"] .fold`);
  const resumePuts = () => requests.filter((r) => r.method === 'PUT' && r.url.startsWith('/api/resumes/'));

  beforeEach(async () => {
    vi.resetModules();
    document.documentElement.innerHTML = fs.readFileSync('web/index.html', 'utf8');
    location.hash = '#resumes';
    const fixture = makeTempStore();
    const data = fixture.store.load();
    fixture.cleanup();
    requests = [];
    pageGone = false;
    holdPut = null;

    vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
      const method = options.method ?? 'GET';
      const body = options.body ? JSON.parse(options.body) : null;
      requests.push({ url, method, body, keepalive: options.keepalive === true, afterPageGone: pageGone });
      let result = {};
      if (url === '/api/store') result = data;
      else if (url === '/api/ai/jobs') result = { jobs: [] };
      else if (url === '/api/render') result = { pages: 1, fits: true, adjustments: [], pdfUrl: '/pdf/x.pdf' };
      else if (url.startsWith('/api/resumes/') && method === 'PUT') {
        if (holdPut) {
          const held = holdPut;
          holdPut = null;
          await held;
        }
        const at = data.resumes.findIndex((r) => r.id === body.id);
        if (at >= 0) data.resumes[at] = body;
        result = body;
      }
      return { ok: true, json: async () => structuredClone(result) };
    }));

    await import('../web/app.js');
    await vi.waitFor(() => expect(document.querySelector('#editor .entry .fold')).not.toBeNull());
  });

  it('asks for the save before the page has gone, in a form that outlives it', async () => {
    const id = document.querySelector('#editor .entry:has(.fold)').dataset.dragId;
    fold(id).click();
    await vi.waitFor(() => expect(resumePuts().at(-1)?.body.collapsed).toContain(id), { timeout: 3000 });

    // Unfolded, and the page reloaded well inside the auto-save's wait.
    fold(id).click();
    expect(document.querySelector(`#editor .entry[data-drag-id="${id}"].folded`)).toBeNull();
    const before = resumePuts().length;
    setTimeout(() => {
      pageGone = true;
    }, 0);
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await new Promise((go) => setTimeout(go, 20));

    const leaving = resumePuts().slice(before);
    expect(leaving.length).toBe(1);
    expect(leaving[0].body.collapsed).not.toContain(id);
    expect(leaving[0].afterPageGone).toBe(false);
    expect(leaving[0].keepalive).toBe(true);
  });

  /*
   * And the save the wait itself starts. It can still be out when the page
   * goes, and `flushEdits` then has nothing to add: the edit is no longer
   * unsaved, it is in flight. Cancelled with the page, it was lost the same
   * way.
   */
  it('lets the ordinary auto-save outlive the page too', async () => {
    const id = document.querySelector('#editor .entry:has(.fold)').dataset.dragId;
    fold(id).click();
    await vi.waitFor(() => expect(resumePuts().at(-1)?.body.collapsed).toContain(id), { timeout: 3000 });
    expect(resumePuts().at(-1).keepalive).toBe(true);
  });

  /*
   * An edit made while the save before it is still out, and then the page
   * left.
   *
   * Saves of one resume go one at a time, so that the server writes them in
   * the order they were made (see `autoSave`). But leaving the page puts the
   * latest edit into that queue too, behind a save whose reply only comes
   * after the page has gone, and nothing on a gone page runs. The edit was
   * never sent. On the way out it is sent at once instead, and it carries
   * where it stands among this page's saves, so that the server can drop the
   * earlier one if that arrives later.
   */
  it('sends the latest edit on the way out, not behind a save still in flight', async () => {
    const id = document.querySelector('#editor .entry:has(.fold)').dataset.dragId;
    let release;
    holdPut = new Promise((go) => {
      release = go;
    });
    fold(id).click();
    await vi.waitFor(() => expect(resumePuts().at(-1)?.body.collapsed).toContain(id), { timeout: 3000 });
    const inFlight = resumePuts().at(-1);

    // Unfolded while the fold's save is still out, and the page then left.
    fold(id).click();
    const before = resumePuts().length;
    setTimeout(() => {
      pageGone = true;
    }, 0);
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await new Promise((go) => setTimeout(go, 20));
    // The fold's reply, which comes back after the page has gone.
    release();
    await new Promise((go) => setTimeout(go, 20));

    const leaving = resumePuts().slice(before);
    expect(leaving.length).toBe(1);
    expect(leaving[0].body.collapsed).not.toContain(id);
    expect(leaving[0].afterPageGone).toBe(false);
    expect(leaving[0].keepalive).toBe(true);
    // In order after the save still out, for the server to keep them so.
    const order = (put) => new URL(put.url, 'http://x').searchParams.get('order');
    expect(order(inFlight)).toMatch(/^[\w-]+:\d+$/);
    const [page, first] = order(inFlight).split(':');
    const [samePage, second] = order(leaving[0]).split(':');
    expect(samePage).toBe(page);
    expect(Number(second)).toBeGreaterThan(Number(first));
  });
});
