// @vitest-environment jsdom
/**
 * The panel where a transcript goes in.
 *
 * The storage layer is covered in `documents.test.ts`; what is checked here
 * is the part a person touches — that adding a file sends it under the name
 * it will be uploaded as, and that removing one asks first. The name is the
 * whole of the interface: a reviewer opening the attachment sees that string.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { makeTempStore } from './helpers.ts';

vi.mock('../web/preview.js', () => ({ createPreview: () => ({ show: async () => {} }) }));
vi.mock('../web/assets.js', () => ({
  setupAssets: () => ({ init: async () => ({ current: '/test-save' }), load: async () => {} }),
}));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('documents to attach', () => {
  let documents;
  let requests;

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    document.documentElement.innerHTML = fs.readFileSync('web/index.html', 'utf8');
    location.hash = '';
    const fixture = makeTempStore();
    const data = fixture.store.load();
    fixture.cleanup();
    documents = [];
    requests = [];

    vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
      const body = options.body ? JSON.parse(options.body) : null;
      const method = options.method ?? 'GET';
      requests.push({ url, method, body });
      let result = {};
      if (url === '/api/store') result = data;
      else if (url === '/api/ai/jobs') result = { jobs: [] };
      else if (url === '/api/documents' && method === 'GET') result = { documents, dir: '/save/out/current' };
      else if (url === '/api/documents' && method === 'POST') {
        documents = [...documents.filter((d) => d.name !== body.name),
          { name: body.name, bytes: 1234, at: '2026-09-21T00:00:00.000Z' }];
        result = documents[documents.length - 1];
      } else if (url.startsWith('/api/documents/') && method === 'DELETE') {
        const name = decodeURIComponent(url.split('/').pop());
        documents = documents.filter((d) => d.name !== name);
        result = { ok: true };
      } else if (url === '/api/render') result = { pages: 1, fits: true, adjustments: [], pdfUrl: '/pdf/x.pdf' };
      return { ok: true, json: async () => structuredClone(result) };
    }));

    await import('../web/app.js');
    await vi.waitFor(() => expect(document.querySelector('#doc-list')).not.toBeNull());
  });

  const shown = () => [...document.querySelectorAll('#doc-list .card b')].map((b) => b.textContent);

  it('says what to put here when there is nothing yet', async () => {
    await vi.waitFor(() => expect(document.querySelector('#doc-list').textContent).toMatch(/transcript/i));
  });

  it('sends a chosen file under the name it will be uploaded as', async () => {
    const picker = document.querySelector('#doc-file');
    const file = new File([new Uint8Array([1, 2, 3])], 'Transcript.pdf', { type: 'application/pdf' });
    Object.defineProperty(picker, 'files', { value: [file], configurable: true });
    picker.dispatchEvent(new Event('change'));

    await vi.waitFor(() =>
      expect(requests.some((r) => r.url === '/api/documents' && r.method === 'POST')).toBe(true),
    );
    const sent = requests.find((r) => r.url === '/api/documents' && r.method === 'POST');
    expect(sent.body.name).toBe('Transcript.pdf');
    expect(typeof sent.body.data).toBe('string');

    // And the list shows it without a reload.
    await vi.waitFor(() => expect(shown()).toEqual(['Transcript.pdf']));
  });

  /*
   * Removing one takes it out of the folder a file dialog is pointed at, so
   * it asks — the same rule every other deletion in this editor follows.
   */
  it('asks before removing one, and leaves it alone if you say no', async () => {
    documents = [{ name: 'Transcript.pdf', bytes: 1234, at: '2026-09-21T00:00:00.000Z' }];
    document.querySelector('button[data-tab="save"]').click();
    await vi.waitFor(() => expect(shown()).toEqual(['Transcript.pdf']));

    [...document.querySelectorAll('#doc-list button')].find((b) => b.textContent === 'Remove').click();
    await vi.waitFor(() => expect(document.querySelector('#modal').classList.contains('hidden')).toBe(false));
    expect(document.querySelector('#modal').textContent).toMatch(/Transcript\.pdf/);

    document.querySelector('#modal-cancel').click();
    await vi.advanceTimersByTimeAsync(100);
    expect(requests.some((r) => r.method === 'DELETE')).toBe(false);
    expect(shown()).toEqual(['Transcript.pdf']);
  });
});
