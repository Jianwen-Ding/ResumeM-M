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

afterEach(() => {
  vi.unstubAllGlobals();
});

/*
 * Switching resumes while the one being left is still saving.
 *
 * With auto-commit on, leaving a resume asks for a commit and waits for it,
 * and the old resume stayed drawn and editable until it came back. A click
 * in that gap — the editor walk clicking a skill chip it took for the new
 * resume's — changed the resume being left, which was then saved, and the
 * switch landed on top. The editor takes nothing while a move is under way.
 * (jsdom does not keep clicks off an inert element; the browser does, and
 * tests/editor.mjs's "A skill switched off and on again" is that half.)
 */
describe('the editor while the resume on it is being left', () => {
  let releaseSave;
  let saves;

  beforeEach(async () => {
    vi.resetModules();
    document.documentElement.innerHTML = fs.readFileSync('web/index.html', 'utf8');
    location.hash = '#resumes';
    const fixture = makeTempStore();
    const data = fixture.store.load();
    fixture.cleanup();
    releaseSave = null;
    saves = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, options = {}) => {
        const method = options.method ?? 'GET';
        let result = {};
        if (url === '/api/store') result = { ...data, config: { ...data.config, git: { ...data.config.git, autoCommit: true } } };
        else if (url === '/api/ai/jobs') result = { jobs: [] };
        else if (url === '/api/workspace') result = { drafts: [] };
        else if (url === '/api/render') result = { pages: 1, fits: true, adjustments: [], pdfUrl: '/pdf/x.pdf' };
        else if (String(url).startsWith('/api/store/save')) {
          saves++;
          if (releaseSave === null) await new Promise((go) => (releaseSave = go));
          result = { saved: true, files: [] };
        } else if (String(url).startsWith('/api/resumes/') && method === 'PUT') result = JSON.parse(options.body);
        return { ok: true, json: async () => structuredClone(result) };
      }),
    );
    await import('../web/app.js');
    await vi.waitFor(() => expect(document.querySelector('#resume-select option')).not.toBeNull());
    await vi.waitFor(() => expect(document.querySelector('#editor').children.length).toBeGreaterThan(0));
  });

  it('is inert from the dropdown’s change until the move lands, and editable after', async () => {
    const select = document.querySelector('#resume-select');
    const other = [...select.options].map((o) => o.value).find((v) => v && v !== select.value && v !== '__master__' && !v.startsWith('__'));
    expect(other).toBeTruthy();
    select.value = other;
    select.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(saves).toBe(1));
    expect(document.querySelector('#editor').inert).toBe(true);

    releaseSave();
    await vi.waitFor(() => expect(document.querySelector('#editor').inert).toBe(false));
    expect(select.value).toBe(other);
  });

  it('is inert while #master is being opened, too', async () => {
    location.hash = '#master';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    await vi.waitFor(() => expect(saves).toBeGreaterThan(0));
    expect(document.querySelector('#editor').inert).toBe(true);
    releaseSave();
    await vi.waitFor(() => expect(document.querySelector('#editor').inert).toBe(false));
  });
});
