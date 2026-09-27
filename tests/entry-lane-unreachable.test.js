// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
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

/*
 * Watched, to see whether an edit found a lane still holding a base for its
 * entry: only a held lane with a copy of its own gets an edit rebased.
 */
const rebased = vi.hoisted(() => ({ calls: [] }));
vi.mock('../web/rebase.js', async (actual) => {
  const real = await actual();
  return {
    ...real,
    rebase: (base, mine, theirs) => {
      rebased.calls.push(mine.id);
      return real.rebase(base, mine, theirs);
    },
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

/*
 * An entry's write lane, when the server is not there to read the entry back.
 *
 * Every write to an entry goes through `inEntryLane`, which reads the store
 * back afterwards and keeps the server's copy as the base the next write in
 * the lane is rebased onto. That reload is also what released the lane, and
 * with the server down it threw before the release. The lane then stayed for
 * good, holding whatever copy it had last seen, and every later edit of the
 * entry was rebased onto that copy: a change made to the entry elsewhere in
 * the meantime — another tab, the card, the AI — was quietly written away by
 * the next edit here.
 */
describe('an entry edited while the server comes and goes', () => {
  function serve() {
    const fixture = makeTempStore();
    const data = fixture.store.load();
    fixture.cleanup();
    const net = { down: false, dieAfterEntryPut: false, data, entryPuts: [] };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, init = {}) => {
        if (net.down) throw new TypeError('Failed to fetch');
        const method = init.method ?? 'GET';
        const body = init.body ? JSON.parse(init.body) : null;
        const path = String(url).split('?')[0];
        let result = {};
        if (url === '/api/store') result = data;
        else if (url === '/api/ai/jobs') result = { jobs: [] };
        else if (url === '/api/config') {
          result = { ai: { enabled: false }, latex: {}, git: {}, output: {}, overrides: {}, resumes: {} };
        } else if (url === '/api/resumes/expiring') result = { due: [] };
        else if (path.startsWith('/api/render')) {
          result = { pages: 1, fits: true, adjustments: [], warnings: [], lost: [], pdfUrl: '/pdf/x.pdf' };
        } else if (path === '/api/workspace') result = { drafts: [] };
        else if (path.startsWith('/api/entries/') && method === 'PUT') {
          net.entryPuts.push(body);
          data.entries = data.entries.map((e) => (e.id === body.id ? body : e));
          result = body;
          // Written, answered, and then the server stops: the read-back finds nobody.
          if (net.dieAfterEntryPut) {
            net.dieAfterEntryPut = false;
            net.down = true;
          }
        } else if (path.startsWith('/api/resumes/') && method === 'PUT') {
          data.resumes = data.resumes.map((r) => (r.id === body.id ? body : r));
          result = body;
        }
        return { ok: true, json: async () => structuredClone(result) };
      }),
    );
    return net;
  }

  const text = (sel) => document.querySelector(sel)?.textContent ?? '';

  async function bootBuilder() {
    vi.resetModules();
    document.documentElement.innerHTML = fs.readFileSync('web/index.html', 'utf8');
    window.location.hash = '#resumes';
    const net = serve();
    await import('../web/app.js');
    await vi.waitFor(() => expect(document.querySelectorAll('#editor .entry').length).toBeGreaterThan(1));
    await vi.waitFor(() => expect(text('#live-state')).toBe('Live'), { timeout: 4000 });
    return net;
  }

  const line = (start) => [...document.querySelectorAll('#editor .editable')].find((n) => n.textContent.startsWith(start));
  const enter = (node) => node.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  const edit = (node, wording) => {
    node.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true }));
    node.textContent = wording;
    enter(node);
  };
  const acme = (net) => net.data.entries.find((e) => e.id === 'exp_acme');
  const wording = (entry, bulletId) => entry.bullets.find((b) => b.id === bulletId).variants[0].text;

  /*
   * The rest of each story, once this page's copy of the entry has landed:
   * the entry changes somewhere else, this page reads it (here, as the save
   * of a line in another entry reads the store back and redraws), and then a
   * line of the entry is edited here. What the other side changed must still
   * be on the server afterwards.
   */
  async function changedElsewhereThenEditedHere(net) {
    await vi.waitFor(() => expect(text('#save-state')).toBe('All changes saved'), { timeout: 4000 });
    acme(net).location = 'Remote — changed in another tab';

    const project = line('Built a thing');
    expect(project, 'the project bullet on screen').toBeTruthy();
    const puts = net.entryPuts.length;
    edit(project, 'Built a thing for Example Corp');
    await vi.waitFor(() => expect(net.entryPuts.length).toBe(puts + 1));
    await vi.waitFor(() => expect(text('#status')).toBe('Wording updated'));

    const testing = line('Raised coverage');
    expect(testing, 'the testing bullet on screen').toBeTruthy();
    rebased.calls.length = 0;
    edit(testing, 'Raised coverage from 41% to 90% for Morgan Testwell');
    await vi.waitFor(() => expect(net.entryPuts.length).toBe(puts + 2));
    await vi.waitFor(() => expect(text('#status')).toBe('Wording updated'));
    // Nothing of this entry was in flight, so no lane was left to rebase it onto.
    expect(rebased.calls, 'a lane still held for exp_acme').toEqual([]);

    expect(wording(acme(net), 'b_testing')).toBe('Raised coverage from 41% to 90% for Morgan Testwell');
    // The other side's change, not written back to the copy the lane was left holding.
    expect(acme(net).location).toBe('Remote — changed in another tab');
    expect(net.entryPuts.at(-1).location).toBe('Remote — changed in another tab');
  }

  it('keeps a change made elsewhere after a save that could not reach the server', async () => {
    const net = await bootBuilder();

    net.down = true;
    const pipeline = line('Built a');
    edit(pipeline, 'Built a pipeline, while the server was away');
    await vi.waitFor(() => expect(text('#status')).toMatch(/can’t reach the server/i), { timeout: 4000 });
    expect(pipeline.classList.contains('editing')).toBe(true);
    expect(net.entryPuts).toHaveLength(0);

    // Back; Enter commits the wording still in the line, and this time it lands.
    net.down = false;
    enter(pipeline);
    await vi.waitFor(() => expect(net.entryPuts).toHaveLength(1));
    expect(wording(acme(net), 'b_pipeline')).toBe('Built a pipeline, while the server was away');

    await changedElsewhereThenEditedHere(net);
    expect(wording(acme(net), 'b_pipeline')).toBe('Built a pipeline, while the server was away');
  }, 20_000);

  it('keeps a change made elsewhere after a save that landed but could not be read back', async () => {
    const net = await bootBuilder();

    net.dieAfterEntryPut = true;
    const pipeline = line('Built a');
    edit(pipeline, 'Built a pipeline, just before the server stopped');
    await vi.waitFor(() => expect(text('#status')).toMatch(/can’t reach the server/i), { timeout: 4000 });
    expect(net.entryPuts).toHaveLength(1);

    // Back; the line is sent again and read back this time.
    net.down = false;
    enter(pipeline);
    await vi.waitFor(() => expect(net.entryPuts).toHaveLength(2));

    await changedElsewhereThenEditedHere(net);
    expect(wording(acme(net), 'b_pipeline')).toBe('Built a pipeline, just before the server stopped');
  }, 20_000);
});
