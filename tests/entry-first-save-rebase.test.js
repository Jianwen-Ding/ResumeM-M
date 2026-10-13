// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { makeTempStore } from './helpers.ts';
import { normalizeEntries } from '../src/model/normalize.ts';

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
 * An entry changed in another tab, then edited here.
 *
 * An entry is saved whole, and a save that found nothing landed in its lane
 * sent the page's copy of it, as old as the page's last read of the store.
 * So the other tab's change went back with the first edit here; and undoing
 * that edit put the page's copy back whole and took it away a second time.
 * The stand-in server keeps what it is sent, as the real one does.
 */
describe('the first save of an entry after it changed elsewhere', () => {
  const JOB = { id: 'j1', kind: 'experience', title: 'Everclear', dates: 'Jul. 2024 -- Dec. 2024', location: 'Boston, MA' };
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
      entries: normalizeEntries([JOB]),
      skillGroups: [],
      resumes: [{ id: 'base', label: 'Base', base: true, sections: [{ kind: 'experience', entries: [JOB.id] }] }],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, init) => {
        if (String(url).startsWith('/api/entries/') && init?.method === 'PUT') {
          const body = JSON.parse(init.body);
          puts.push(body);
          const at = data.entries.findIndex((e) => e.id === body.id);
          data.entries[at] = body;
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
    await vi.waitFor(() => expect(document.querySelector('#editor .entry .dates')).not.toBeNull());
  }

  /** Another tab moves the entry to another city. */
  const elsewhere = () => {
    data.entries[0] = { ...data.entries[0], location: 'Remote' };
  };

  const pickMonth = (value) => {
    const month = document.querySelector('#editor .entry .dates .date-end .date-month');
    month.value = value;
    month.dispatchEvent(new window.Event('change'));
  };

  it('keeps the change made elsewhere, with the edit made here on top', async () => {
    await open();
    elsewhere();
    pickMonth('8');
    await vi.waitFor(() => expect(puts.length).toBe(1));
    expect(puts[0].location).toBe('Remote');
    expect(puts[0].period.start).toEqual({ year: 2024, month: 8 });
    expect(data.entries[0].location).toBe('Remote');
  });

  it('undoes only the edit made here, not the change made elsewhere', async () => {
    await open();
    elsewhere();
    pickMonth('8');
    await vi.waitFor(() => expect(puts.length).toBe(1));
    await vi.waitFor(() => expect(document.querySelector('#btn-undo').disabled).toBe(false));

    document.querySelector('#btn-undo').click();
    await vi.waitFor(() => expect(puts.length).toBe(2));
    expect(puts[1].location).toBe('Remote');
    expect(puts[1].period.start).toEqual({ year: 2024, month: 7 });
  });

  /* And an undo after another change elsewhere, made once this edit had landed. */
  it('undoes the edit over what was written elsewhere after it', async () => {
    await open();
    pickMonth('8');
    await vi.waitFor(() => expect(puts.length).toBe(1));
    await vi.waitFor(() => expect(document.querySelector('#btn-undo').disabled).toBe(false));
    elsewhere();

    document.querySelector('#btn-undo').click();
    await vi.waitFor(() => expect(puts.length).toBe(2));
    expect(puts[1].location).toBe('Remote');
    expect(puts[1].period.start).toEqual({ year: 2024, month: 7 });
  });
});
