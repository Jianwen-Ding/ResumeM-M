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
 * Opening the application that is already open, while somebody writes in it.
 *
 * Opening the Workspace opens the first application in the list by itself,
 * and a click on that same card opens it again: two reads of one draft, the
 * second landing after the panel is up and typeable. When it landed on an
 * edit, the edit was saved and read back and the panel was drawn again from
 * that. Whatever was typed while that save and read were out went into a box
 * the redraw then replaced. The cursor went with it, so the rest of the
 * sentence went nowhere. The editor walk lost "Dear Halcyon, I spent last
 * year…" after "Dear Halcyon" that way with the page slowed, and an answer
 * after "Because the".
 */
describe('opening the application already open', () => {
  let drafts;
  /** Set by a test to hold the next read of the draft, or the next save. */
  let holdRead;
  let holdSave;
  let saves;

  const id = 'halcyon';
  const letter = () => document.querySelector('#draft-editor .letter');
  const card = () => [...document.querySelectorAll('.draft-card')].find((c) => c.textContent.includes('Halcyon'));
  const type = (box, text) => {
    box.value = text;
    box.dispatchEvent(new window.Event('input', { bubbles: true }));
  };
  const gate = () => {
    let open;
    const shut = new Promise((go) => (open = go));
    return { shut, open };
  };

  beforeEach(async () => {
    vi.resetModules();
    document.documentElement.innerHTML = fs.readFileSync('web/index.html', 'utf8');
    location.hash = '';
    const fixture = makeTempStore();
    const data = fixture.store.load();
    fixture.cleanup();
    holdRead = null;
    holdSave = null;
    saves = [];
    drafts = {
      [id]: {
        id,
        company: 'Halcyon',
        role: 'Platform Engineer',
        resumeId: 'intern',
        coverLetter: { required: true, body: '', edited: false },
        questions: [],
        notes: '',
        updatedAt: '2026-09-26T07:00:00.000Z',
      },
    };

    vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
      const method = options.method ?? 'GET';
      const body = options.body ? JSON.parse(options.body) : null;
      let result = {};
      if (url === '/api/store') result = data;
      else if (url === '/api/ai/jobs') result = { jobs: [] };
      else if (url === '/api/render') result = { pages: 1, fits: true, adjustments: [], pdfUrl: '/pdf/x.pdf' };
      else if (url === '/api/workspace') result = { drafts: Object.values(drafts) };
      else if (url.startsWith('/api/workspace/') && method === 'PUT') {
        const held = holdSave;
        holdSave = null;
        if (held) await held;
        // As the server does: the save touches `updatedAt`.
        drafts[id] = { ...body, updatedAt: new Date().toISOString() };
        saves.push(body.coverLetter.body);
        result = drafts[id];
      } else if (url.startsWith('/api/workspace/')) {
        const held = holdRead;
        holdRead = null;
        const copy = structuredClone(drafts[id]);
        if (held) await held;
        result = copy;
      }
      return { ok: true, json: async () => structuredClone(result) };
    }));

    await import('../web/app.js');
    await vi.waitFor(() => expect(document.querySelector('#resume-select')).not.toBeNull());
    for (const b of document.querySelectorAll('#tabs button')) b.disabled = false;
    // Opens the first application by itself.
    document.querySelector('button[data-tab="workspace"]').click();
    await vi.waitFor(() => expect(letter()).not.toBeNull());
    await vi.waitFor(() => expect(card()).toBeTruthy());
  });

  it('keeps what is typed while the second read and its save are out', async () => {
    const box = letter();
    const read = gate();
    holdRead = read.shut;
    card().click();
    await new Promise((go) => setTimeout(go, 20));

    box.focus();
    type(box, 'Dear Halcyon');
    const save = gate();
    holdSave = save.shut;
    read.open();
    await new Promise((go) => setTimeout(go, 20));

    // Still typing while that save is out.
    type(box, 'Dear Halcyon, I spent last year running the ingest path end to end.');
    save.open();
    await new Promise((go) => setTimeout(go, 50));

    expect(letter()).toBe(box);
    expect(letter().value).toBe('Dear Halcyon, I spent last year running the ingest path end to end.');
    expect(document.activeElement).toBe(box);
    // And it reaches the save, on the next write.
    box.dispatchEvent(new window.Event('blur'));
    await vi.waitFor(() => expect(saves.at(-1)).toBe('Dear Halcyon, I spent last year running the ingest path end to end.'));
  });

  it('leaves the box alone when the second read says nothing new, so the cursor stays in it', async () => {
    const box = letter();
    const read = gate();
    holdRead = read.shut;
    card().click();
    await new Promise((go) => setTimeout(go, 20));

    // Clicked into, not yet typed in.
    box.focus();
    read.open();
    await new Promise((go) => setTimeout(go, 50));

    expect(letter()).toBe(box);
    expect(document.activeElement).toBe(box);
  });

  it('still draws it again when the draft changed underneath, as when a letter is drafted for it', async () => {
    drafts[id] = {
      ...drafts[id],
      coverLetter: { required: true, body: 'A letter drafted elsewhere.', edited: false },
      updatedAt: '2026-09-26T07:05:00.000Z',
    };
    card().click();
    await vi.waitFor(() => expect(letter().value).toBe('A letter drafted elsewhere.'));
  });
});
