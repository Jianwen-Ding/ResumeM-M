// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { makeTempStore } from './helpers.ts';
import { keyOf } from '../web/compact.js';

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
 * Two skills groups with one name, as the editor draws them.
 *
 * The narrow layout's Focus keeps one entry open and tells entries apart by
 * `keyOf`. A skills group has no `data-drag-id`, and was named by its title —
 * so a "Languages" of programming languages and a "Languages" of spoken ones
 * were the same group to it, and opening one opened both. The editor now
 * names each by its group's id.
 */
describe('skills groups of one name', () => {
  it('are drawn with keys of their own', async () => {
    vi.resetModules();
    document.documentElement.innerHTML = fs.readFileSync('web/index.html', 'utf8');
    window.location.hash = '#resumes';
    const fixture = makeTempStore();
    const loaded = fixture.store.load();
    fixture.cleanup();
    const data = {
      ...loaded,
      entries: [],
      skillGroups: [
        { id: 'g_code', name: 'Languages', items: [{ id: 's_py', text: 'Python' }] },
        { id: 'g_spoken', name: 'Languages', items: [{ id: 's_fr', text: 'French' }] },
      ],
      resumes: [{ id: 'base', label: 'Base', base: true, sections: [{ kind: 'skills', groups: ['g_code', 'g_spoken'] }] }],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url) => {
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

    const groups = () =>
      [...document.querySelectorAll('#editor .entry')].filter(
        (e) => e.querySelector('.entry-head .title')?.textContent === 'Languages',
      );
    await vi.waitFor(() => expect(groups()).toHaveLength(2));
    const keys = groups().map(keyOf);
    expect(keys[0]).not.toBe(keys[1]);
  });
});
