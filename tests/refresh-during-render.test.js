// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
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
  vi.unstubAllGlobals();
  localStorage.clear();
});

/*
 * Coming back to the tab reads the store again (`refreshOnReturn`), and that
 * read is thrown away if a write of this page's was out while it was read
 * (`readStoreUncrossed`). Every request that was not a GET counted as one —
 * the compile too, which is a POST and is running nearly all the time — so
 * coming back mid-compile kept the screen on the store from before a change
 * made elsewhere, and the compile moves no revision to ask again.
 */
describe('coming back to the tab while a request is out', () => {
  function serve() {
    const fixture = makeTempStore();
    const data = fixture.store.load();
    fixture.cleanup();

    const held = { render: false, rename: false, renders: [], renames: [] };
    const reads = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, init = {}) => {
        const method = init.method ?? 'GET';
        let result = {};
        if (url === '/api/store') {
          reads.push(url);
          result = structuredClone(data);
        } else if (url === '/api/ai/jobs') result = { jobs: [] };
        else if (url === '/api/config') {
          result = { ai: { enabled: false }, latex: {}, git: {}, output: {}, overrides: {}, resumes: {} };
        } else if (url === '/api/resumes/expiring') result = { due: [] };
        else if (String(url).startsWith('/api/render')) {
          if (held.render) await new Promise((go) => held.renders.push(go));
          result = { pages: 1, fits: true, adjustments: [], warnings: [], lost: [], pdfUrl: '/pdf/x.pdf' };
        } else if (/^\/api\/resumes\/[^/]+\/rename$/.test(url) && method === 'POST') {
          if (held.rename) await new Promise((go) => held.renames.push(go));
          const id = decodeURIComponent(url.split('/')[3]);
          const at = data.resumes.findIndex((r) => r.id === id);
          data.resumes[at] = { ...data.resumes[at], label: JSON.parse(init.body).label };
          result = structuredClone(data.resumes[at]);
        } else if (String(url).startsWith('/api/resumes/') && method === 'PUT') {
          const spec = JSON.parse(init.body);
          const at = data.resumes.findIndex((r) => r.id === spec.id);
          if (at >= 0) data.resumes[at] = structuredClone(spec);
          result = spec;
        }
        return { ok: true, json: async () => structuredClone(result) };
      }),
    );
    return { data, held, reads };
  }

  const entryRow = (title) =>
    [...document.querySelectorAll('#editor .entry')].find((e) => e.querySelector('.title')?.textContent === title);
  const box = (title) => entryRow(title)?.querySelector(':scope > .entry-head input[type=checkbox], :scope > .toggle input[type=checkbox]');

  async function open() {
    vi.resetModules();
    document.documentElement.innerHTML = fs.readFileSync('web/index.html', 'utf8');
    window.location.hash = '#resumes/newgrad';
    const served = serve();
    await import('../web/app.js');
    await vi.waitFor(() => expect(box('Acme Co.')).toBeTruthy());
    expect(box('Acme Co.').checked).toBe(true);
    return served;
  }

  /** Another tab switches the line off: written to the save, not by this page. */
  function switchedOffElsewhere(data) {
    const experience = data.resumes.find((r) => r.id === 'newgrad').sections.find((s) => s.kind === 'experience');
    experience.entries = experience.entries.filter((id) => id !== 'exp_acme');
  }

  function comeBack() {
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  }

  it('takes up a change made elsewhere while the preview is compiling', async () => {
    const { data, held, reads } = await open();

    // A compile, held open.
    held.render = true;
    document.querySelector('#btn-rebuild').click();
    await vi.waitFor(() => expect(held.renders.length, 'the compile is out').toBeGreaterThan(0));

    switchedOffElsewhere(data);
    const before = reads.length;
    comeBack();

    await vi.waitFor(() => expect(box('Acme Co.').checked, 'the change made elsewhere is on screen').toBe(false));
    expect(reads.length, 'the store was read').toBeGreaterThan(before);
    expect(document.querySelector('#status').textContent).toMatch(/Updated with changes made in another tab/);
    expect(held.renders.length, 'and the compile is still out').toBeGreaterThan(0);

    held.render = false;
    held.renders.splice(0).forEach((go) => go());
  });

  it('still stands aside while a write of its own is out, and takes the change up once it lands', async () => {
    const { data, held, reads } = await open();

    // A rename — a POST, like the compile, but one that writes the resume.
    held.rename = true;
    document.querySelector('#btn-rename-resume').click();
    await vi.waitFor(() => expect(document.querySelector('#f_label')).toBeTruthy());
    document.querySelector('#f_label').value = 'Renamed by Morgan Testwell';
    document.querySelector('#modal-ok').click();
    await vi.waitFor(() => expect(held.renames.length, 'the rename is out').toBe(1));

    switchedOffElsewhere(data);
    const before = reads.length;
    comeBack();
    await new Promise((go) => setTimeout(go, 50));

    expect(reads.length, 'no store read is taken while the write is out').toBe(before);
    expect(box('Acme Co.').checked, 'the screen is left alone').toBe(true);

    // The rename lands, and the store is read after it, change and all.
    held.rename = false;
    held.renames.splice(0).forEach((go) => go());
    await vi.waitFor(() => expect(box('Acme Co.').checked).toBe(false));
    expect(data.resumes.find((r) => r.id === 'newgrad').label).toBe('Renamed by Morgan Testwell');
  });
});
