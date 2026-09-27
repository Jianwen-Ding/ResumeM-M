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
 * The editor's other writes of a resume, each made while the resume was
 * written elsewhere after the editor read it.
 *
 * The auto-save was made conditional first (tests/refused-save.test.js). The
 * tier button, Rename, adding a skills group (`saveResumeSpec`), undo, a
 * restore from the history and Save as variation each wrote whatever was
 * there, or undid to a copy without the other write in it. JobHelper's card
 * files its copy of a posting's resume whole with every stage, and a stage
 * landing between the editor's read and one of these was lost.
 *
 * The stand-in server keeps a version per resume, moved by every write, and
 * refuses a write based on another, as src/server/api.ts does (`movedOn`).
 * `server.before(path, fn)` runs `fn` as a request for that path arrives,
 * before it is answered: a write landing between the read and the action.
 */
describe('the editor’s other resume writes, over a write made elsewhere', () => {
  function serve() {
    const fixture = makeTempStore();
    const data = fixture.store.load();
    fixture.cleanup();
    data.resumes = data.resumes.map((r) => (r.id === 'intern' ? { ...r, tier: 'extended' } : r));
    let writes = 0;
    const versions = Object.fromEntries(data.resumes.map((r) => [r.id, `v${++writes}`]));
    const older = structuredClone(data.resumes.find((r) => r.id === 'intern'));
    older.label = 'An older name';

    const writesSeen = [];
    const hooks = [];
    const at = (id) => data.resumes.findIndex((r) => r.id === id);
    const elsewhere = (id, change) => {
      data.resumes[at(id)] = change(structuredClone(data.resumes[at(id)]));
      versions[id] = `v${++writes}`;
    };
    const written = (id, spec) => {
      if (at(id) >= 0) data.resumes[at(id)] = structuredClone(spec);
      else data.resumes.push(structuredClone(spec));
      versions[id] = `v${++writes}`;
      return `"${versions[id]}"`;
    };
    const refused = (id, basedOn) =>
      typeof basedOn === 'string' && versions[id] !== basedOn
        ? { kind: 'conflict', error: 'Changed elsewhere.', id, current: structuredClone(data.resumes[at(id)]), version: versions[id] }
        : null;

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, init = {}) => {
        const method = init.method ?? 'GET';
        const where = new URL(url, 'http://x');
        const route = where.pathname;
        for (const hook of hooks.filter((h) => h.method === method && h.test(route, where)).splice(0)) {
          hooks.splice(hooks.indexOf(hook), 1);
          hook.fn();
        }
        const body = init.body ? JSON.parse(init.body) : {};
        let result = {};
        let status = 200;
        let etag = null;
        const id = decodeURIComponent(route.split('/')[3] ?? '');
        if (route === '/api/store') result = { ...structuredClone(data), versions: { ...versions } };
        else if (route === '/api/ai/jobs') result = { jobs: [] };
        else if (route === '/api/config') result = { ai: { enabled: false }, latex: {}, git: {}, output: {}, overrides: {}, resumes: {} };
        else if (route === '/api/resumes/expiring') result = { due: [] };
        else if (route.startsWith('/api/render')) result = { pages: 1, fits: true, adjustments: [], warnings: [], lost: [], pdfUrl: '/pdf/x.pdf' };
        else if (route === '/api/skills' && method === 'PUT') {
          data.skillGroups = body;
          result = body;
        } else if (/^\/api\/resumes\/[^/]+$/.test(route) && method === 'PUT') {
          writesSeen.push({ route: `${route}${where.search}`, basedOn: where.searchParams.get('basedOn'), body });
          const conflict = refused(id, where.searchParams.get('basedOn'));
          if (where.searchParams.get('create') === '1' && at(id) >= 0) {
            status = 409;
            result = { error: `A resume is already saved as “${id}”. Choose another filename.` };
          } else if (conflict) {
            status = 409;
            result = conflict;
          } else {
            etag = written(id, { ...body, id });
            result = { ...body, id };
          }
        } else if (/\/tier$/.test(route) && method === 'PUT') {
          writesSeen.push({ route, basedOn: body.basedOn ?? null, body });
          const conflict = refused(id, body.basedOn);
          if (conflict) [status, result] = [409, conflict];
          else {
            etag = written(id, { ...data.resumes[at(id)], tier: body.tier });
            result = data.resumes[at(id)];
          }
        } else if (/\/rename$/.test(route) && method === 'POST') {
          writesSeen.push({ route, basedOn: body.basedOn ?? null, body });
          const conflict = refused(id, body.basedOn);
          if (conflict) [status, result] = [409, conflict];
          else {
            etag = written(id, { ...data.resumes[at(id)], label: body.label });
            result = data.resumes[at(id)];
          }
        } else if (/\/history$/.test(route)) {
          result = {
            versions: [
              { hash: 'now000', date: '2026-09-18T10:00:00Z', message: 'Edited', changes: [] },
              { hash: 'old111', date: '2026-09-10T10:00:00Z', message: 'Earlier', changes: [] },
            ],
            more: false,
          };
        } else if (/\/restore$/.test(route) && method === 'POST') {
          writesSeen.push({ route, basedOn: body.basedOn ?? null, body });
          const conflict = refused(id, body.basedOn);
          if (conflict) [status, result] = [409, conflict];
          else {
            etag = written(id, { ...older, tier: data.resumes[at(id)].tier });
            result = { ...data.resumes[at(id)], warnings: [] };
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
    const before = (method, test, fn) => hooks.push({ method, test, fn });
    return { data, versions, elsewhere, writesSeen, before };
  }

  const entryRow = (title) =>
    [...document.querySelectorAll('#editor .entry')].find((e) => e.querySelector('.title')?.textContent === title);
  const box = (title) => entryRow(title)?.querySelector(':scope > .entry-head input[type=checkbox], :scope > .toggle input[type=checkbox]');
  const shownIn = (spec, kind) => spec?.sections?.find((s) => s.kind === kind)?.entries ?? [];
  const intern = (data) => data.resumes.find((r) => r.id === 'intern');
  const status = () => document.querySelector('#status').textContent;
  const saveState = () => document.querySelector('#save-state').textContent;
  const settle = (ms = 0) => new Promise((go) => setTimeout(go, ms));
  const modalOpen = () => !document.querySelector('#modal').classList.contains('hidden');
  const field = (name) => document.querySelector(`#modal-content [name="${name}"]`);
  /** The card, filing its copy: renamed, and Acme switched off. */
  const cardFiles = (r) => {
    r.label = 'Renamed by the card';
    r.sections.find((s) => s.kind === 'experience').entries = [];
    return r;
  };

  async function openOn(id) {
    vi.resetModules();
    document.documentElement.innerHTML = fs.readFileSync('web/index.html', 'utf8');
    window.location.hash = `#resumes/${id}`;
    const server = serve();
    await import('../web/app.js');
    await vi.waitFor(() => {
      expect(box('Thing')).toBeTruthy();
      expect(document.querySelector('#resume-select').value).toBe(id);
    });
    await settle(20);
    return server;
  }

  async function undo() {
    const was = status();
    document.querySelector('#btn-undo').click();
    await vi.waitFor(() => expect(status()).not.toBe(was), { timeout: 4000 });
    await vi.waitFor(() => expect(status()).toMatch(/^Undid/), { timeout: 4000 });
  }

  it('the tier button: sets the tier on the write made elsewhere, and undoing it keeps that write', async () => {
    const { data, versions, elsewhere, writesSeen } = await openOn('intern');
    const read = versions.intern;
    elsewhere('intern', cardFiles);
    const theirs = versions.intern;

    document.querySelector('#btn-base').click();
    await vi.waitFor(() => expect(intern(data).tier).toBe('base'), { timeout: 4000 });
    await vi.waitFor(() => expect(status()).toMatch(/changed elsewhere; that change was kept/));
    expect(writesSeen.map((w) => w.basedOn), 'refused once, then reapplied on the write made elsewhere').toEqual([read, theirs]);
    expect(intern(data).label).toBe('Renamed by the card');
    expect(document.querySelector('#tier-state').textContent).toMatch(/Base/);

    // Taken back: the tier goes, the card's write stays.
    await undo();
    expect(intern(data).tier).toBe('extended');
    expect(intern(data).label, 'the card’s rename survives the undo').toBe('Renamed by the card');
    expect(shownIn(intern(data), 'experience'), 'and so does its switch').toEqual([]);
  });

  it('Rename: names the resume as it is now, says what it was called elsewhere, and undoes to that', async () => {
    const { data, versions, elsewhere, writesSeen } = await openOn('intern');
    const read = versions.intern;
    elsewhere('intern', cardFiles);

    document.querySelector('#btn-rename-resume').click();
    await vi.waitFor(() => expect(field('label')).toBeTruthy());
    field('label').value = 'Typed here';
    document.querySelector('#modal-ok').click();

    await vi.waitFor(() => expect(intern(data).label).toBe('Typed here'), { timeout: 4000 });
    await vi.waitFor(() => expect(status()).toMatch(/renamed “Renamed by the card” elsewhere/));
    expect(writesSeen[0].basedOn).toBe(read);
    expect(writesSeen.length).toBe(2);
    expect(shownIn(intern(data), 'experience'), 'the card’s switch stays').toEqual([]);
    expect(modalOpen()).toBe(false);

    await undo();
    expect(intern(data).label, 'back to the name the card gave it').toBe('Renamed by the card');
    expect(shownIn(intern(data), 'experience'), 'and the card’s switch stays').toEqual([]);
  });

  it('a skills group added: rebased onto a write that landed just before it, which stays', async () => {
    const { data, elsewhere, writesSeen, before } = await openOn('intern');
    // Lands after the editor read the resume, as the group's own write goes.
    before('PUT', (route) => route === '/api/resumes/intern', () => elsewhere('intern', cardFiles));

    const add = [...document.querySelectorAll('#editor button')].find((b) => b.textContent === '+ Add skill group');
    add.click();
    await vi.waitFor(() => expect(field('name')).toBeTruthy());
    field('name').value = 'Tools';
    field('items').value = 'Make, Bash';
    document.querySelector('#modal-ok').click();

    await vi.waitFor(() => expect(data.skillGroups.some((g) => g.name === 'Tools')).toBe(true), { timeout: 4000 });
    const tools = data.skillGroups.find((g) => g.name === 'Tools').id;
    await vi.waitFor(() => expect(intern(data).sections.find((s) => s.kind === 'skills').groups).toContain(tools), { timeout: 4000 });
    const puts = writesSeen.filter((w) => w.route.startsWith('/api/resumes/intern'));
    expect(puts.length, 'refused, rebased, sent again').toBe(2);
    expect(puts[0].basedOn).toBeTruthy();
    expect(intern(data).label, 'the card’s rename stays').toBe('Renamed by the card');
    expect(shownIn(intern(data), 'experience'), 'the card’s switch stays').toEqual([]);
  });

  it('undo: takes back the edit made here, and not a write made elsewhere since', async () => {
    const { data, elsewhere, writesSeen } = await openOn('intern');
    box('Thing').click();
    await vi.waitFor(() => expect(saveState()).toBe('All changes saved'), { timeout: 5000 });
    expect(shownIn(intern(data), 'project')).toEqual([]);
    elsewhere('intern', cardFiles);

    await undo();
    expect(shownIn(intern(data), 'project'), 'the edit is taken back').toEqual(['proj_thing']);
    expect(intern(data).label, 'the card’s rename stays').toBe('Renamed by the card');
    expect(shownIn(intern(data), 'experience'), 'the card’s switch stays').toEqual([]);
    expect(writesSeen.at(-1).basedOn, 'sent on the write made elsewhere').toBeTruthy();
  });

  describe('a restore from the history', () => {
    async function restoreWith(answers) {
      const server = await openOn('intern');
      const asked = [];
      vi.stubGlobal('confirm', (text) => {
        asked.push(text);
        // The card files while the restore dialog is open.
        if (asked.length === 1) server.elsewhere('intern', cardFiles);
        return answers[asked.length - 1] ?? false;
      });
      document.querySelector('#tabs button[data-tab="history"]').click();
      await vi.waitFor(() => expect(document.querySelector('#history-resume').value).toBe('intern'));
      const restore = () => [...document.querySelectorAll('.version-card button')].find((b) => b.textContent.startsWith('Restore'));
      await vi.waitFor(() => expect(restore()).toBeTruthy());
      restore().click();
      return { ...server, asked };
    }

    it('is not made over a write made while its dialog was open, unless the person says so again', async () => {
      const { data, asked, writesSeen } = await restoreWith([true, false]);
      await vi.waitFor(() => expect(status()).toMatch(/Nothing was restored/), { timeout: 4000 });
      expect(asked.length).toBe(2);
      expect(asked[1]).toMatch(/“Renamed by the card” was changed elsewhere .* Restore anyway\?/);
      expect(intern(data).label, 'the card’s write stays').toBe('Renamed by the card');
      expect(shownIn(intern(data), 'experience')).toEqual([]);
      expect(writesSeen.filter((w) => w.route.endsWith('/restore')).length).toBe(1);
    });

    it('is made when the person says restore anyway', async () => {
      const { data, versions, asked, writesSeen } = await restoreWith([true, true]);
      await vi.waitFor(() => expect(intern(data).label).toBe('An older name'), { timeout: 4000 });
      await vi.waitFor(() => expect(status()).toMatch(/^Restored/));
      expect(asked.length).toBe(2);
      const restores = writesSeen.filter((w) => w.route.endsWith('/restore'));
      expect(restores.length).toBe(2);
      expect(restores[1].basedOn, 'on the write the person was told about').not.toBe(restores[0].basedOn);
      expect(restores[1].basedOn).not.toBe(versions.intern);
    });

    it('is not refused for this page’s own save of an edit, flushed on the way', async () => {
      const server = await openOn('intern');
      const asked = [];
      vi.stubGlobal('confirm', (text) => (asked.push(text), true));
      box('Thing').click(); // not saved yet
      document.querySelector('#tabs button[data-tab="history"]').click();
      await vi.waitFor(() => expect(document.querySelector('#history-resume').value).toBe('intern'));
      const restore = () => [...document.querySelectorAll('.version-card button')].find((b) => b.textContent.startsWith('Restore'));
      await vi.waitFor(() => expect(restore()).toBeTruthy());
      restore().click();
      await vi.waitFor(() => expect(intern(server.data).label).toBe('An older name'), { timeout: 5000 });
      expect(asked.length, 'asked once, not told of a conflict').toBe(1);
      expect(server.writesSeen.filter((w) => w.route.endsWith('/restore')).length).toBe(1);
    });
  });

  it('Save as variation: does not replace a resume made under its filename since the form checked', async () => {
    const { data, before } = await openOn('intern');
    before('PUT', (route, where) => route === '/api/resumes/intern-variant' && where.searchParams.get('create') === '1', () => {
      data.resumes.push({ id: 'intern-variant', label: 'Made by the card', sections: [] });
    });
    document.querySelector('#btn-save-as').click();
    await vi.waitFor(() => expect(field('label')).toBeTruthy());
    document.querySelector('#modal-ok').click();

    await vi.waitFor(() => expect(document.querySelector('#modal-note')?.textContent).toMatch(/already saved as “intern-variant”/), { timeout: 4000 });
    expect(data.resumes.filter((r) => r.id === 'intern-variant').map((r) => r.label)).toEqual(['Made by the card']);
    expect(modalOpen(), 'asked again').toBe(true);
  });
});
