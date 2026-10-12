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
 * "+ Add skill", when the skills list moved on under it.
 *
 * The lane (`inSkillsLane`) answers a 409 by running the change again on the
 * list the server sent back. `addSkill`'s change remembered the id it chose
 * in a variable outside itself and never forgot it, so when the group had
 * been deleted in another tab meanwhile the retry added nothing — and the id
 * from the first, refused attempt was still there to be ticked on this
 * resume, under a group that no longer existed, with "Skill added" on the
 * status line.
 */
describe('adding a skill to a group deleted elsewhere', () => {
  let data;
  let skillPuts;
  let resumePuts;

  async function open() {
    vi.resetModules();
    skillPuts = [];
    resumePuts = [];
    document.documentElement.innerHTML = fs.readFileSync('web/index.html', 'utf8');
    window.location.hash = '#resumes/base';
    const fixture = makeTempStore();
    const loaded = fixture.store.load();
    fixture.cleanup();
    data = {
      ...loaded,
      entries: [],
      skillGroups: [
        { id: 'g1', name: 'Languages', items: [{ id: 's_py', text: 'Python' }] },
        { id: 'g2', name: 'Tools', items: [] },
      ],
      skillsVersion: 'v1',
      // A list of its own for the group, so a tick would be a write of this resume.
      resumes: [{ id: 'base', label: 'Base', base: true, sections: [{ kind: 'skills', groups: ['g1', 'g2'], items: { g1: ['s_py'] } }] }],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, init) => {
        const method = init?.method ?? 'GET';
        if (String(url).startsWith('/api/skills') && method === 'PUT') {
          const body = JSON.parse(init.body);
          skillPuts.push({ url: String(url), body });
          const basedOn = new URL(url, 'http://x').searchParams.get('basedOn');
          if (basedOn && basedOn !== data.skillsVersion) {
            const current = structuredClone(data.skillGroups);
            return { ok: false, status: 409, json: async () => ({ error: 'Changed elsewhere.', current, version: data.skillsVersion }) };
          }
          data.skillGroups = body;
          data.skillsVersion = `v${skillPuts.length + 1}`;
          return { ok: true, json: async () => structuredClone(body) };
        }
        if (String(url).startsWith('/api/resumes/') && method === 'PUT') {
          const body = JSON.parse(init.body);
          resumePuts.push(body);
          return { ok: true, json: async () => structuredClone(body) };
        }
        let result = {};
        if (url === '/api/store') result = data;
        else if (url === '/api/ai/jobs') result = { jobs: [] };
        else if (url === '/api/config') result = { ai: { enabled: false }, latex: {}, git: {}, output: {}, overrides: {}, resumes: {} };
        else if (String(url).startsWith('/api/render')) {
          result = { pages: 1, fits: true, overflowLines: -4, adjustments: [], warnings: [], lost: [], pdfUrl: '/pdf/x.pdf' };
        }
        return { ok: true, json: async () => structuredClone(result) };
      }),
    );
    await import('../web/app.js');
    await vi.waitFor(() => expect(addButtons().length).toBeGreaterThan(0));
  }

  const addButtons = () =>
    [...document.querySelectorAll('#editor button')].filter((b) => ['+ Add skill', '+ Skill'].includes(b.textContent.trim()));
  const status = () => document.querySelector('#status').textContent;

  it('writes nothing, ticks nothing, and does not say "Skill added"', async () => {
    await open();
    addButtons()[0].click();
    await vi.waitFor(() => expect(document.querySelector('#f_text')).not.toBeNull());
    document.querySelector('#f_text').value = 'Rust';

    // Another tab deletes the group after this page read the list.
    data.skillGroups = data.skillGroups.filter((g) => g.id !== 'g1');
    data.skillsVersion = 'v-elsewhere';
    // The page's read of the store as the lane starts: still the old list, as
    // when the deletion lands between that read and the write.
    const stale = { ...data, skillGroups: [{ id: 'g1', name: 'Languages', items: [{ id: 's_py', text: 'Python' }] }, ...data.skillGroups], skillsVersion: 'v1' };
    const real = globalThis.fetch;
    let served = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, init) => {
        if (url === '/api/store' && !served) {
          served = true;
          return { ok: true, json: async () => structuredClone(stale) };
        }
        return real(url, init);
      }),
    );
    document.querySelector('#modal-ok').click();

    // Whatever it ends up saying, said once the lane is done.
    await vi.waitFor(() => expect(status()).not.toBe(''), { timeout: 4000 });
    expect(resumePuts.flatMap((r) => r.sections.flatMap((s) => Object.values(s.items ?? {}).flat())), 'not ticked here').not.toContain(
      's_rust',
    );
    expect(status()).not.toMatch(/Skill added/);
    expect(status()).toMatch(/Rust was not added/);
    expect(skillPuts.length, 'refused once, and nothing to write after that').toBe(1);
    expect(data.skillGroups.map((g) => g.id)).toEqual(['g2']);
  });
});
