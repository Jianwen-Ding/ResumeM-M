// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { makeTempStore } from './helpers.ts';
import { docKeyFor, readDoc, restoreRequest } from '../web/undo.js';

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
 * Saving a letter opened on the Letters tab.
 *
 * The box sent the whole letter as it was when it opened, so whatever was
 * saved to the letter while it was open — the extension's "Save to store",
 * completing the application, another tab — was written away, and nothing
 * said so. And a letter saved there was the one document the editor wrote
 * that Undo could not take back.
 */
describe('undo knows a letter', () => {
  it('as a document of its own, and not the id route', () => {
    expect(docKeyFor('/letters/2026-01-15-example-co', 'PUT')).toBe('letter:2026-01-15-example-co');
    expect(docKeyFor('/letters/a%20b?basedOn=v1', 'PUT')).toBe('letter:a b');
    expect(docKeyFor('/letters/id', 'PUT')).toBeNull();
    expect(readDoc({ coverLetters: [{ id: 'l1', title: 'One' }] }, 'letter:l1')).toEqual({ id: 'l1', title: 'One' });
    expect(restoreRequest('letter:l1', null)).toEqual({ path: '/letters/l1', options: { method: 'DELETE' } });
    // A field the letter did not have is put back as not there.
    const put = restoreRequest('letter:l1', { id: 'l1', title: 'One', body: 'B' });
    expect(put.path).toBe('/letters/l1?commit=0');
    expect(JSON.parse(put.options.body)).toMatchObject({ title: 'One', company: null, role: null });
  });
});

describe('editing a letter', () => {
  let stored;
  let writes;
  let refuseOnce;

  const letter = () => ({
    id: 'l1',
    title: 'Engineer — Acme',
    company: 'Acme',
    role: 'Engineer',
    createdAt: '2026-01-15T10:00:00.000Z',
    body: 'The letter as it was opened.',
  });

  beforeEach(async () => {
    vi.resetModules();
    document.documentElement.innerHTML = fs.readFileSync('web/index.html', 'utf8');
    window.location.hash = '#letters';

    const fixture = makeTempStore();
    const data = fixture.store.load();
    fixture.cleanup();
    stored = letter();
    writes = [];
    refuseOnce = true;
    const version = () => `v-${stored.title}-${stored.body.length}`;

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, options = {}) => {
        const path = String(url);
        let result = {};
        let status = 200;
        if (path === '/api/store') result = { ...data, coverLetters: [stored] };
        else if (path === '/api/ai/jobs') result = { jobs: [] };
        else if (path === '/api/letters') result = [{ ...stored, version: version() }];
        else if (path.startsWith('/api/letters/l1') && options.method === 'PUT') {
          const sent = JSON.parse(options.body);
          writes.push({ path, sent });
          const basedOn = new URL(path, 'http://x').searchParams.get('basedOn');
          if (refuseOnce && basedOn) {
            // Saved elsewhere while the box was open.
            refuseOnce = false;
            stored = { ...stored, body: 'Changed by the extension meanwhile.' };
            status = 409;
            result = { kind: 'conflict', error: 'changed', current: stored, version: version() };
          } else if (basedOn && basedOn !== version()) {
            status = 409;
            result = { kind: 'conflict', error: 'changed', current: stored, version: version() };
          } else {
            stored = { ...stored, ...sent };
            for (const k of Object.keys(sent)) if (sent[k] === null) delete stored[k];
            result = stored;
          }
        }
        return {
          ok: status < 400,
          status,
          statusText: String(status),
          headers: { get: () => null },
          json: async () => structuredClone(result),
        };
      }),
    );

    await import('../web/app.js');
    await vi.waitFor(() => expect(document.querySelector('#letters .mini-card button.tiny')).not.toBeNull());
  });

  const openAndRetitle = async (title) => {
    const open = [...document.querySelectorAll('#letters .mini-card button.tiny')].find((b) => b.textContent === 'Open');
    open.click();
    await vi.waitFor(() => expect(document.querySelector('#modal-content [name="title"]')).not.toBeNull());
    document.querySelector('#modal-content [name="title"]').value = title;
    document.querySelector('#modal-ok').click();
    await vi.waitFor(() => expect(document.querySelector('#status').textContent).toMatch(/Letter saved|not saved/i));
  };

  it('sends only what changed, on the version it opened, and makes the change again over a newer letter', async () => {
    await openAndRetitle('Platform Engineer — Acme');

    expect(writes).toHaveLength(2);
    expect(writes[0].sent).toEqual({ title: 'Platform Engineer — Acme' });
    expect(writes[0].path).toContain('basedOn=v-Engineer%20%E2%80%94%20Acme-28');
    // Made again on what the 409 handed back, and the edit made meanwhile kept.
    expect(writes[1].sent).toEqual({ title: 'Platform Engineer — Acme' });
    expect(writes[1].path).not.toBe(writes[0].path);
    expect(stored).toMatchObject({ title: 'Platform Engineer — Acme', body: 'Changed by the extension meanwhile.' });
    expect(document.querySelector('#status').textContent).toMatch(/Letter saved/);
  });

  it('can be undone', async () => {
    await openAndRetitle('Platform Engineer — Acme');
    const undo = document.querySelector('#btn-undo');
    await vi.waitFor(() => expect(undo.disabled).toBe(false));
    expect(undo.title).toMatch(/letter/);

    undo.click();
    await vi.waitFor(() => expect(stored.title).toBe('Engineer — Acme'));
    // Back to the letter the edit was made on, which is the one with the
    // extension's text, not the one the box opened with.
    expect(stored.body).toBe('Changed by the extension meanwhile.');
  });
});
