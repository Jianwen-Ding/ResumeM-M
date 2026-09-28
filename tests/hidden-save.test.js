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
  delete document.visibilityState;
  vi.unstubAllGlobals();
  localStorage.clear();
});

/*
 * The resume's save when the page is hidden, and when it is unloaded.
 *
 * Every save of the resume is based on the write it was made on (`basedOn`),
 * and refused when the resume was written elsewhere since, except the one
 * sent on the way out of the page, which wrote whatever was there. That one
 * also ran when the tab was only hidden: someone going from here to a
 * posting, where JobHelper's card files its copy of this resume, sent a whole
 * resume unconditionally at the moment the card was likely to write, and
 * wrote the card's filing away.
 *
 * Hidden, the page is still there: its save is the ordinary conditional one,
 * and a refusal is rebased and sent again. Unloaded, the save goes at once,
 * conditional too, with the edit kept in localStorage first, and the next
 * page to open the resume offers to put it back when it is not in the save.
 *
 * The stand-in server keeps a version per resume, moved by every write, and
 * refuses a save based on another, as src/server/api.ts does, including
 * taking a page's save as based on the write its own save ahead was based on
 * (`ownWriteSince`), and not writing a save older than one already written
 * from the same page (`?order`).
 */
describe('the resume’s save when the page is hidden or unloaded', () => {
  function serve() {
    const fixture = makeTempStore();
    const data = fixture.store.load();
    fixture.cleanup();
    let writes = 0;
    const versions = Object.fromEntries(data.resumes.map((r) => [r.id, `v${++writes}`]));
    const puts = [];
    // Hold the next resume PUT before the server sees it, or only its reply.
    const holds = { before: [], reply: [] };
    let lastOrder = null;
    let lastConditional = null;
    const server = { data, versions, puts, holds, page: null };

    /** Another writer (the card staging its copy) changing a resume. */
    server.elsewhere = (id, change) => {
      const at = data.resumes.findIndex((r) => r.id === id);
      data.resumes[at] = change(structuredClone(data.resumes[at]));
      versions[id] = `v${++writes}`;
    };

    const putResume = (url, spec) => {
      const query = new URL(url, 'http://x').searchParams;
      const basedOn = query.get('basedOn');
      const [page, n] = (query.get('order') ?? '').split(':');
      const order = page ? { page, n: Number(n) } : null;
      const at = data.resumes.findIndex((r) => r.id === spec.id);
      const own =
        order &&
        lastConditional &&
        lastConditional.page === order.page &&
        lastConditional.n < order.n &&
        lastConditional.basedOn === basedOn &&
        lastConditional.made === versions[spec.id];
      if (basedOn && versions[spec.id] !== basedOn && !own) {
        return {
          status: 409,
          result: { kind: 'conflict', error: 'Changed elsewhere.', id: spec.id, current: data.resumes[at], version: versions[spec.id] },
        };
      }
      if (order && lastOrder && lastOrder.page === order.page && order.n <= lastOrder.n) {
        return { status: 200, result: data.resumes[at], etag: versions[spec.id] };
      }
      if (order) lastOrder = order;
      data.resumes[at] = structuredClone(spec);
      versions[spec.id] = `v${++writes}`;
      lastConditional = order && basedOn ? { ...order, basedOn, made: versions[spec.id] } : null;
      return { status: 200, result: spec, etag: versions[spec.id] };
    };

    /**
     * The page's fetch. A page that has gone (`gone`) still has its requests
     * reach the server, as keepalive ones do, and never hears back.
     */
    server.install = () => {
      const page = { gone: false };
      server.page = page;
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url, init = {}) => {
          const method = init.method ?? 'GET';
          let answer = { status: 200, result: {} };
          if (url === '/api/store') answer.result = { ...structuredClone(data), versions: { ...versions } };
          else if (url === '/api/ai/jobs') answer.result = { jobs: [] };
          else if (url === '/api/resumes/expiring') answer.result = { due: [] };
          else if (String(url).startsWith('/api/render')) {
            answer.result = { pages: 1, fits: true, adjustments: [], warnings: [], lost: [], pdfUrl: '/pdf/x.pdf' };
          } else if (String(url).startsWith('/api/resumes/') && method === 'PUT') {
            const spec = JSON.parse(init.body);
            const query = new URL(url, 'http://x').searchParams;
            const put = { url, spec, basedOn: query.get('basedOn'), order: query.get('order'), keepalive: init.keepalive === true };
            puts.push(put);
            if (holds.before.length) await holds.before.shift();
            answer = putResume(url, spec);
            put.status = answer.status;
            put.made = answer.status === 200 ? answer.etag : undefined;
            if (holds.reply.length) await holds.reply.shift();
          }
          if (page.gone) return new Promise(() => {});
          return {
            ok: answer.status < 400,
            status: answer.status,
            headers: { get: (name) => (/^etag$/i.test(name) && answer.etag ? `"${answer.etag}"` : null) },
            json: async () => structuredClone(answer.result),
          };
        }),
      );
    };
    return server;
  }

  /** A promise for `holds`, and the function that lets it go. */
  const held = () => {
    let go;
    const promise = new Promise((resolve) => (go = resolve));
    return { promise, go };
  };

  const entryRow = (title) =>
    [...document.querySelectorAll('#editor .entry')].find((e) => e.querySelector('.title')?.textContent === title);
  const box = (title) => entryRow(title)?.querySelector(':scope > .entry-head input[type=checkbox], :scope > .toggle input[type=checkbox]');
  const shownIn = (spec, kind) => spec?.sections?.find((s) => s.kind === kind)?.entries ?? [];
  const intern = (data) => data.resumes.find((r) => r.id === 'intern');
  const saveState = () => document.querySelector('#save-state').textContent;
  const settle = (ms = 0) => new Promise((go) => setTimeout(go, ms));
  const kept = () => Object.keys(localStorage).filter((k) => k.startsWith('rmm-rescue:'));
  const rescueBar = () => document.querySelector('#rescue');

  async function openOn(id, server = serve()) {
    vi.resetModules();
    document.documentElement.innerHTML = fs.readFileSync('web/index.html', 'utf8');
    window.location.hash = `#resumes/${id}`;
    server.install();
    await import('../web/app.js');
    await vi.waitFor(() => {
      expect(box('Thing')).toBeTruthy();
      expect(document.querySelector('#resume-select').value).toBe(id);
    });
    await settle(20);
    return server;
  }

  const setVisibility = (value) => {
    Object.defineProperty(document, 'visibilityState', { value, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  };
  const hide = () => setVisibility('hidden');
  const show = () => setVisibility('visible');
  /** Closed or reloaded: `pagehide`, then hidden, and the page gone. */
  const unload = (server) => {
    server.page.gone = true;
    window.dispatchEvent(new Event('pagehide'));
    hide();
  };

  it('sends a save based on the write it was made on when the tab is hidden', async () => {
    const server = await openOn('intern');
    const read = server.versions.intern;
    box('Thing').click();
    hide();
    // At once, not after the auto-save's pause.
    await settle(20);
    expect(server.puts.length).toBe(1);
    expect(server.puts[0].basedOn).toBe(read);
    expect(server.puts[0].keepalive).toBe(true);
    await vi.waitFor(() => expect(saveState()).toBe('All changes saved'));
    expect(shownIn(intern(server.data), 'project')).toEqual([]);
    expect(kept(), 'nothing left to rescue once it landed').toEqual([]);
  });

  it('keeps a write made elsewhere before the tab was hidden, with the edit on top', async () => {
    const server = await openOn('intern');
    const read = server.versions.intern;
    // The card, filing its copy after the editor read the store: renamed,
    // and Acme switched off.
    server.elsewhere('intern', (r) => {
      r.label = 'Renamed by the card';
      r.sections.find((s) => s.kind === 'experience').entries = [];
      return r;
    });
    const theirs = server.versions.intern;

    box('Thing').click();
    hide();
    await vi.waitFor(() => expect(server.puts.length).toBe(2), { timeout: 3000 });
    await vi.waitFor(() => expect(saveState()).toBe('All changes saved'));
    expect(server.puts.map((p) => p.basedOn), 'refused once, then sent on the other write').toEqual([read, theirs]);
    expect(server.puts[0].status).toBe(409);
    const saved = intern(server.data);
    expect(saved.label, 'the card’s rename stays').toBe('Renamed by the card');
    expect(shownIn(saved, 'experience'), 'the card’s switch stays').toEqual([]);
    expect(shownIn(saved, 'project'), 'and the edit is on top').toEqual([]);

    // Back on the tab: both on screen, and nothing sent again.
    show();
    await settle(50);
    expect(box('Acme Co.').checked).toBe(false);
    expect(box('Thing').checked).toBe(false);
    expect(server.puts.length).toBe(2);
    expect(kept()).toEqual([]);
  });

  it('waits for a save still out when hidden, and is based on the write it made', async () => {
    const server = await openOn('intern');
    const first = held();
    server.holds.before.push(first.promise);
    box('Thing').click();
    await vi.waitFor(() => expect(server.puts.length).toBe(1), { timeout: 3000 });
    box('Acme Co.').click();
    hide();
    await settle(20);
    expect(server.puts.length, 'not sent over the save still out').toBe(1);
    expect(kept().length, 'kept while it waits').toBe(1);
    first.go();
    await vi.waitFor(() => expect(server.puts.length).toBe(2));
    await vi.waitFor(() => expect(saveState()).toBe('All changes saved'));
    expect(server.puts[1].basedOn, 'on the write the save ahead made').toBe(server.puts[0].made);
    expect(server.puts.every((p) => p.status === 200)).toBe(true);
    expect(shownIn(intern(server.data), 'experience')).toEqual([]);
    expect(shownIn(intern(server.data), 'project')).toEqual([]);
    expect(kept()).toEqual([]);
  });

  it('on unloading, sends the edit at once, based on the write it was made on, and keeps it', async () => {
    const server = await openOn('intern');
    const read = server.versions.intern;
    box('Thing').click();
    unload(server);
    await settle(20);
    expect(server.puts.length).toBe(1);
    expect(server.puts[0].basedOn).toBe(read);
    expect(server.puts[0].keepalive).toBe(true);
    expect(kept().length, 'kept in this browser, the reply never heard').toBe(1);
    const [key] = kept();
    expect(shownIn(JSON.parse(localStorage.getItem(key)).spec, 'project')).toEqual([]);
  });

  it('offers a refused edit from a closed tab back, and puts it on top of the other write', async () => {
    let server = await openOn('intern');
    server.elsewhere('intern', (r) => {
      r.label = 'Renamed by the card';
      r.sections.find((s) => s.kind === 'experience').entries = [];
      return r;
    });
    box('Thing').click();
    unload(server);
    await settle(20);
    expect(server.puts.at(-1).status, 'refused, to a page that has gone').toBe(409);
    expect(intern(server.data).label).toBe('Renamed by the card');
    expect(shownIn(intern(server.data), 'project'), 'the edit is not in the save').toEqual(['proj_thing']);

    // Opened again.
    server = await openOn('intern', server);
    expect(rescueBar().hidden).toBe(false);
    expect(rescueBar().textContent).toMatch(/is not in the save/);
    const putBack = [...rescueBar().querySelectorAll('button')].find((b) => b.textContent === 'Put it back');
    putBack.click();
    await vi.waitFor(() => expect(shownIn(intern(server.data), 'project')).toEqual([]), { timeout: 3000 });
    await vi.waitFor(() => expect(saveState()).toBe('All changes saved'));
    const saved = intern(server.data);
    expect(saved.label).toBe('Renamed by the card');
    expect(shownIn(saved, 'experience')).toEqual([]);
    expect(server.puts.at(-1).status).toBe(200);
    expect(rescueBar().hidden).toBe(true);
    expect(kept()).toEqual([]);
  });

  it('offers nothing for a closed tab whose save landed, and forgets it', async () => {
    let server = await openOn('intern');
    box('Thing').click();
    unload(server);
    await settle(20);
    expect(server.puts.at(-1).status).toBe(200);
    expect(kept().length).toBe(1);

    server = await openOn('intern', server);
    expect(rescueBar().hidden).toBe(true);
    expect(kept()).toEqual([]);
  });

  it('on unloading behind a save still out, is written over that save and not refused', async () => {
    const server = await openOn('intern');
    const read = server.versions.intern;
    const reply = held();
    server.holds.reply.push(reply.promise); // the first is written; its reply is out
    box('Thing').click();
    await vi.waitFor(() => expect(server.puts.length).toBe(1), { timeout: 3000 });
    box('Acme Co.').click();
    unload(server);
    await settle(20);
    reply.go();
    await settle(20);
    expect(server.puts.length).toBe(2);
    expect(server.puts.map((p) => p.basedOn), 'both on the write they were made on').toEqual([read, read]);
    expect(server.puts[1].status).toBe(200);
    expect(shownIn(intern(server.data), 'experience')).toEqual([]);
    expect(shownIn(intern(server.data), 'project')).toEqual([]);
  });
});
