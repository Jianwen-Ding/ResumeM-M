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
 * The resume on screen, written elsewhere while an edit to it waits on its
 * save.
 *
 * JobHelper's card files its copy of a posting's resume whole with every
 * stage, and the side panel's editor saves the same copy. The editor's save
 * was written whole too, from the copy it read: a stage that landed while an
 * edit waited was written away by the edit's save, under "All changes saved".
 * The save now says which write of the resume it was made on (`basedOn`), the
 * server refuses it with 409 when that is not the write it holds, and the
 * editor rebases its edit onto what is there, as an entry's lane does.
 *
 * The stand-in server below keeps a version per resume, moved by every write,
 * and refuses a save based on another, as src/server/api.ts does.
 */
describe('a save of the resume refused because it was written elsewhere', () => {
  function serve({ versioned = true } = {}) {
    const fixture = makeTempStore();
    const data = fixture.store.load();
    fixture.cleanup();
    let writes = 0;
    const versions = Object.fromEntries(data.resumes.map((r) => [r.id, `v${++writes}`]));

    const puts = [];
    const saves = { hold: false, held: [] };
    /** Another writer — the card staging its copy — changing a resume. */
    const elsewhere = (id, change) => {
      const at = data.resumes.findIndex((r) => r.id === id);
      data.resumes[at] = change(structuredClone(data.resumes[at]));
      versions[id] = `v${++writes}`;
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, init = {}) => {
        const method = init.method ?? 'GET';
        let result = {};
        let status = 200;
        let etag = null;
        if (url === '/api/store') result = { ...structuredClone(data), ...(versioned ? { versions: { ...versions } } : {}) };
        else if (url === '/api/ai/jobs') result = { jobs: [] };
        else if (url === '/api/config') {
          result = { ai: { enabled: false }, latex: {}, git: {}, output: {}, overrides: {}, resumes: {} };
        } else if (url === '/api/resumes/expiring') result = { due: [] };
        else if (String(url).startsWith('/api/render')) {
          result = { pages: 1, fits: true, adjustments: [], warnings: [], lost: [], pdfUrl: '/pdf/x.pdf' };
        } else if (String(url).startsWith('/api/resumes/') && method === 'PUT') {
          const spec = JSON.parse(init.body);
          const basedOn = new URL(url, 'http://x').searchParams.get('basedOn');
          puts.push({ url, spec, basedOn });
          if (saves.hold) await new Promise((go) => saves.held.push(go));
          const at = data.resumes.findIndex((r) => r.id === spec.id);
          if (basedOn && versions[spec.id] !== basedOn) {
            status = 409;
            result = { kind: 'conflict', error: 'Changed elsewhere.', id: spec.id, current: data.resumes[at], version: versions[spec.id] };
          } else {
            data.resumes[at] = structuredClone(spec);
            if (versioned) etag = `"${(versions[spec.id] = `v${++writes}`)}"`;
            result = spec;
          }
        }
        return {
          ok: status < 400,
          status,
          headers: { get: (name) => (/^etag$/i.test(name) ? etag : null) },
          json: async () => structuredClone(result),
        };
      }),
    );
    return { data, puts, saves, versions, elsewhere };
  }

  const entryRow = (title) =>
    [...document.querySelectorAll('#editor .entry')].find((e) => e.querySelector('.title')?.textContent === title);
  const box = (title) => entryRow(title)?.querySelector(':scope > .entry-head input[type=checkbox], :scope > .toggle input[type=checkbox]');
  const shownIn = (spec, kind) => spec?.sections?.find((s) => s.kind === kind)?.entries ?? [];
  const intern = (data) => data.resumes.find((r) => r.id === 'intern');
  const status = () => document.querySelector('#status').textContent;
  const saveState = () => document.querySelector('#save-state').textContent;
  const settle = (ms = 0) => new Promise((go) => setTimeout(go, ms));

  async function openOn(id, options) {
    vi.resetModules();
    document.documentElement.innerHTML = fs.readFileSync('web/index.html', 'utf8');
    window.location.hash = `#resumes/${id}`;
    const server = serve(options);
    await import('../web/app.js');
    await vi.waitFor(() => {
      expect(box('Thing')).toBeTruthy();
      expect(document.querySelector('#resume-select').value).toBe(id);
    });
    await settle(20);
    return server;
  }

  it('keeps the change made elsewhere and puts the edit on top of it', async () => {
    const { data, puts, versions, elsewhere } = await openOn('intern');
    const read = versions.intern;
    // The card, filing its copy: renamed, and Acme switched off.
    elsewhere('intern', (r) => {
      r.label = 'Renamed by the card';
      r.sections.find((s) => s.kind === 'experience').entries = [];
      return r;
    });
    const theirs = versions.intern;

    box('Thing').click();
    await vi.waitFor(() => expect(saveState()).toBe('All changes saved'), { timeout: 5000 });

    expect(puts.map((p) => p.basedOn), 'refused once, then sent again on the write it was rebased onto').toEqual([read, theirs]);
    const landed = versions.intern;
    const saved = intern(data);
    expect(saved.label, 'the card’s rename stays').toBe('Renamed by the card');
    expect(shownIn(saved, 'experience'), 'the card’s switch stays').toEqual([]);
    expect(shownIn(saved, 'project'), 'and the edit made here is on top').toEqual([]);
    expect(status()).toMatch(/changed elsewhere while your edit was saving/);
    // Drawn as saved: the line the card switched off is off here too.
    expect(box('Acme Co.').checked).toBe(false);
    expect(box('Thing').checked).toBe(false);

    // And the next edit is based on the write that landed, and is not refused.
    box('Thing').click();
    await vi.waitFor(() => expect(puts.length).toBe(3), { timeout: 5000 });
    await vi.waitFor(() => expect(saveState()).toBe('All changes saved'));
    expect(puts[2].basedOn).toBe(landed);
    expect(shownIn(intern(data), 'project')).toEqual(['proj_thing']);
    expect(intern(data).label).toBe('Renamed by the card');
  });

  it('keeps an edit made while the refused save was out, too', async () => {
    const { data, puts, saves, elsewhere } = await openOn('intern');
    saves.hold = true;
    box('Thing').click();
    await vi.waitFor(() => expect(saves.held.length, 'the save is out').toBe(1), { timeout: 4000 });
    elsewhere('intern', (r) => ({ ...r, label: 'Renamed by the card' }));
    box('Acme Co.').click(); // made on the same copy, while the save is out
    saves.hold = false;
    saves.held.splice(0).forEach((go) => go());

    await vi.waitFor(
      () => {
        expect(shownIn(intern(data), 'experience')).toEqual([]);
        expect(saveState()).toBe('All changes saved');
      },
      { timeout: 5000 },
    );
    const saved = intern(data);
    expect(saved.label).toBe('Renamed by the card');
    expect(shownIn(saved, 'project')).toEqual([]);
    expect(puts.filter((p) => p.basedOn).length).toBe(puts.length);
  });

  it('is written as it always was by a server that says nothing about versions', async () => {
    const { data, puts } = await openOn('intern', { versioned: false });
    box('Thing').click();
    await vi.waitFor(() => expect(saveState()).toBe('All changes saved'), { timeout: 5000 });
    expect(puts.length).toBe(1);
    expect(puts[0].basedOn, 'no condition sent').toBe(null);
    expect(shownIn(intern(data), 'project')).toEqual([]);
  });
});
