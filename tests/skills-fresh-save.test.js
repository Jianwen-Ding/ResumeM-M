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
});

/*
 * The skills list, changed in another tab and then here.
 *
 * Every change to it is a write of the whole list, and the first one in the
 * lane was made to the page's copy, so a skill added elsewhere went with the
 * next × pressed here. Undoing that put the page's copy back whole, and took
 * it away again.
 */
describe('a skill deleted here after one was added elsewhere', () => {
  let data;
  let puts;

  async function open() {
    vi.resetModules();
    puts = [];
    document.documentElement.innerHTML = fs.readFileSync('web/index.html', 'utf8');
    window.location.hash = '#resumes';
    const fixture = makeTempStore();
    const loaded = fixture.store.load();
    fixture.cleanup();
    data = {
      ...loaded,
      entries: [],
      skillGroups: [{ id: 'g1', name: 'Languages', items: [{ id: 's_py', text: 'Python' }, { id: 's_go', text: 'Go' }] }],
      resumes: [{ id: 'base', label: 'Base', base: true, sections: [{ kind: 'skills', groups: ['g1'] }] }],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, init) => {
        if (String(url).startsWith('/api/skills') && init?.method === 'PUT') {
          const body = JSON.parse(init.body);
          puts.push(body);
          data.skillGroups = body;
          return { ok: true, json: async () => structuredClone(body) };
        }
        let result = {};
        if (url === '/api/store') result = data;
        else if (url === '/api/ai/jobs') result = { jobs: [] };
        else if (url === '/api/render') {
          result = { pages: 1, fits: true, overflowLines: -4, adjustments: [], warnings: [], pdfUrl: '/pdf/x.pdf' };
        }
        return { ok: true, json: async () => structuredClone(result) };
      }),
    );
    await import('../web/app.js');
    await vi.waitFor(() => expect(document.querySelector('#editor button.x[aria-label="Delete \\"Go\\" from the save"]')).not.toBeNull());
  }

  const items = (body) => body[0].items.map((i) => i.id);

  it('keeps the skill added elsewhere, and its undo puts back only the one deleted here', async () => {
    await open();
    data.skillGroups = [{ ...data.skillGroups[0], items: [...data.skillGroups[0].items, { id: 's_rust', text: 'Rust' }] }];
    document.querySelector('#editor button.x[aria-label="Delete \\"Go\\" from the save"]').click();
    await vi.waitFor(() => expect(puts.length).toBe(1));
    expect(items(puts[0])).toEqual(['s_py', 's_rust']);

    await vi.waitFor(() => expect(document.querySelector('#btn-undo').disabled).toBe(false));
    document.querySelector('#btn-undo').click();
    await vi.waitFor(() => expect(puts.length).toBe(2));
    expect(items(puts[1])).toEqual(['s_py', 's_go', 's_rust']);
  });
});
