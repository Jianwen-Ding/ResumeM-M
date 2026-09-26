// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { makeTempStore } from './helpers.ts';

vi.mock('../web/preview.js', () => ({
  createPreview: () => ({ show: async () => {}, clear: () => {} }),
}));
vi.mock('../web/assets.js', () => ({
  setupAssets: () => ({ init: async () => ({ current: '/test-save' }), load: async () => {} }),
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

/*
 * Two saves of one Workspace draft out at once.
 *
 * The draft saves itself 900ms after the typing stops, and on a server slower
 * than that the save before it is still out when the next one goes. Nothing
 * held the second back: both were in flight together, and the server writes
 * whichever reaches it last. When that was the older one, the letter on disk
 * went back to what it said a sentence ago, under a chip reading "All changes
 * saved", and a reload showed it.
 *
 * The stand-in server here writes a draft when the request reaches it, which
 * is what the real one does: a held request is one still on its way.
 */
describe('saving one Workspace draft twice while the first save is out', () => {
  let drafts;
  let puts;
  /** The next draft PUT waits on this before it reaches the server. */
  let holdNext;

  const id = 'halcyon';
  const letter = () => document.querySelector('#draft-editor .letter');
  const chip = () => document.querySelector('#draft-save-state').textContent;
  const type = (text) => {
    letter().value = text;
    letter().dispatchEvent(new window.Event('input', { bubbles: true }));
  };
  const hold = () => {
    let release;
    holdNext = new Promise((go) => (release = go));
    return () => release();
  };
  const wait = (ms) => new Promise((go) => setTimeout(go, ms));

  beforeEach(async () => {
    vi.resetModules();
    document.documentElement.innerHTML = fs.readFileSync('web/index.html', 'utf8');
    location.hash = '';
    const fixture = makeTempStore();
    const data = fixture.store.load();
    fixture.cleanup();
    holdNext = null;
    puts = [];
    drafts = {
      [id]: {
        id,
        company: 'Halcyon',
        role: 'Platform Engineer',
        resumeId: 'intern',
        coverLetter: { required: true, body: '', edited: false },
        questions: [],
        notes: '',
      },
    };
    /*
     * The server's side of `?order=<page>:<n>` on a draft (see the draft PUT
     * in src/server/api.ts): a save older than one already written from the
     * same page is not written. A save without one is written as before.
     */
    const written = new Map();

    vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
      const method = options.method ?? 'GET';
      const body = options.body ? JSON.parse(options.body) : null;
      const [path, query = ''] = url.split('?');
      let result = {};
      if (url === '/api/store') result = data;
      else if (url === '/api/ai/jobs') result = { jobs: [] };
      else if (url === '/api/render') result = { pages: 1, fits: true, adjustments: [], pdfUrl: '/pdf/x.pdf' };
      else if (url === '/api/workspace') result = { drafts: Object.values(drafts) };
      else if (path.startsWith('/api/workspace/') && method === 'PUT') {
        const put = { body, order: new URLSearchParams(query).get('order'), arrived: false };
        puts.push(put);
        const held = holdNext;
        holdNext = null;
        if (held) await held;
        put.arrived = true;
        const [page, n] = (put.order ?? '').split(':');
        const last = written.get(page);
        if (put.order && last !== undefined && Number(n) <= last) {
          result = drafts[id];
        } else {
          if (put.order) written.set(page, Number(n));
          drafts[id] = body;
          result = body;
        }
      } else if (path.startsWith('/api/workspace/')) result = drafts[id];
      return { ok: true, json: async () => structuredClone(result) };
    }));

    await import('../web/app.js');
    await vi.waitFor(() => expect(document.querySelector('#resume-select')).not.toBeNull());
    for (const b of document.querySelectorAll('#tabs button')) b.disabled = false;
    document.querySelector('button[data-tab="workspace"]').click();
    await vi.waitFor(() => expect(letter()).not.toBeNull());
  });

  it('leaves the server with the newest letter, whichever save reaches it first', async () => {
    const release = hold();
    type('Dear Halcyon,');
    await vi.waitFor(() => expect(puts.length).toBe(1), { timeout: 3000 });

    // More typed while the first save is still on its way, and past the wait.
    type('Dear Halcyon, I build data pipelines.');
    await wait(1500);
    // The first save reaches the server now, after the second was asked for.
    release();

    await vi.waitFor(
      () => {
        expect(puts.every((p) => p.arrived)).toBe(true);
        expect(chip()).toBe('All changes saved');
      },
      { timeout: 3000 },
    );
    await wait(50);
    expect(drafts[id].coverLetter.body).toBe('Dear Halcyon, I build data pipelines.');
    expect(letter().value).toBe('Dear Halcyon, I build data pipelines.');
  });

  /*
   * Everything typed while the first save was out goes in one save behind it,
   * not one per pause: the save reads the draft when it goes.
   */
  it('sends what was typed meanwhile in one save once the first is answered', async () => {
    const release = hold();
    type('Dear Halcyon,');
    await vi.waitFor(() => expect(puts.length).toBe(1), { timeout: 3000 });
    type('Dear Halcyon, I build');
    await wait(1000);
    type('Dear Halcyon, I build data pipelines.');
    await wait(1000);
    release();
    await vi.waitFor(() => expect(drafts[id].coverLetter.body).toBe('Dear Halcyon, I build data pipelines.'), {
      timeout: 3000,
    });
    await wait(1000);
    expect(puts.map((p) => p.body.coverLetter.body)).toEqual(['Dear Halcyon,', 'Dear Halcyon, I build data pipelines.']);
  });
});
