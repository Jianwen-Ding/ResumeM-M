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
 * An entry changed elsewhere after the editor last read it, then saved here.
 *
 * The first save of an entry reads it first and rebases onto it (see
 * entry-first-save-rebase.test.js), but a change landing after that read —
 * a `git pull` in a terminal, another tab — was still written away by the
 * whole entry the editor sent: the title fixed here, and the location pulled
 * in went back to the old one. The stand-in server keeps a version per entry
 * and refuses a save based on an older one with 409, as the real one does
 * (`entryVersion` in src/server/api.ts); the editor rebases onto what it is
 * told is there and sends again, and both changes stay.
 */
describe('an entry save refused because the entry moved on', () => {
  const JOB = { id: 'j1', kind: 'experience', title: 'Everclear', dates: 'Jul. 2024 -- Dec. 2024', location: 'Boston, MA' };
  let data;
  let version;
  let puts;
  let refusals;
  let pullAfterNextRead;

  const reply = (body, { status = 200, etag } = {}) => ({
    ok: status < 400,
    status,
    statusText: status === 409 ? 'Conflict' : 'OK',
    headers: { get: (name) => (name.toLowerCase() === 'etag' && etag ? `"${etag}"` : null) },
    json: async () => structuredClone(body),
  });

  async function open() {
    vi.resetModules();
    puts = [];
    refusals = 0;
    pullAfterNextRead = false;
    version = 1;
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
        url = String(url);
        if (url.startsWith('/api/entries/') && init?.method === 'PUT') {
          const body = JSON.parse(init.body);
          const basedOn = new URL(url, 'http://x').searchParams.get('basedOn');
          if (basedOn && basedOn !== `v${version}`) {
            refusals++;
            return reply(
              { kind: 'conflict', error: 'changed elsewhere', id: body.id, current: data.entries[0], version: `v${version}` },
              { status: 409 },
            );
          }
          puts.push(body);
          data.entries[0] = body;
          version++;
          return reply(body, { etag: `v${version}` });
        }
        let result = {};
        if (url === '/api/store') {
          result = { ...data, entryVersions: { [JOB.id]: `v${version}` } };
          if (pullAfterNextRead) {
            pullAfterNextRead = false;
            // Answered first: the pull lands once the editor has read the entry.
            const answered = reply(result);
            pulled();
            return answered;
          }
        } else if (url === '/api/ai/jobs') result = { jobs: [] };
        else if (url === '/api/render') {
          result = { pages: 1, fits: true, overflowLines: -4, adjustments: [], warnings: [], pdfUrl: '/pdf/x.pdf' };
        }
        return reply(result);
      }),
    );
    await import('../web/app.js');
    await vi.waitFor(() => expect(document.querySelector('#editor .entry .dates')).not.toBeNull());
  }

  /** A pull moves the entry to another city. */
  const pulled = () => {
    data.entries[0] = { ...data.entries[0], location: 'Seattle, WA' };
    version++;
  };

  const pickMonth = (value) => {
    const month = document.querySelector('#editor .entry .dates .date-end .date-month');
    month.value = value;
    month.dispatchEvent(new window.Event('change'));
  };

  it('rebases the edit onto what is there and keeps both changes', async () => {
    await open();
    pullAfterNextRead = true;
    pickMonth('8');
    await vi.waitFor(() => expect(puts.length).toBe(1));
    expect(refusals).toBe(1);
    expect(puts[0].location).toBe('Seattle, WA');
    expect(puts[0].period.start).toEqual({ year: 2024, month: 8 });
    expect(data.entries[0].location).toBe('Seattle, WA');
  });

  it('sends the next edit based on the version its save made', async () => {
    await open();
    pickMonth('8');
    await vi.waitFor(() => expect(puts.length).toBe(1));
    pickMonth('9');
    await vi.waitFor(() => expect(puts.length).toBe(2));
    expect(refusals).toBe(0);
    expect(data.entries[0].period.start).toEqual({ year: 2024, month: 9 });
  });
});
