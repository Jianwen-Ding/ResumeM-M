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

const EXT = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';

/*
 * The resume on screen, deleted somewhere else.
 *
 * Another tab, the CLI, or JobHelper's card throwing away the copy it made
 * for a posting. Coming back to the tab, or the side panel saying the save
 * changed, reads the store again (`refreshOnReturn`); the read no longer has
 * the resume, and `adoptStore` moves the editor onto the pinned base. It
 * moved `state.resumeId` and nothing else: the screen still showed the
 * deleted resume, its dropdown and address still named it, and nothing was
 * said. The next tick on that screen was written into the base, which nobody
 * had touched. And an edit still waiting on its save when the resume went was
 * written anyway, which put the deleted resume back.
 *
 * `intern` is the resume that goes; `newgrad` is the pinned base. They differ
 * in one line, Acme, which `intern` leaves out, so which one is drawn shows.
 */
describe('the resume on screen, deleted elsewhere', () => {
  function serve() {
    const fixture = makeTempStore();
    const data = fixture.store.load();
    fixture.cleanup();
    data.resumes.find((r) => r.id === 'newgrad').tier = 'base';
    const intern = data.resumes.find((r) => r.id === 'intern');
    intern.sections.find((s) => s.kind === 'experience').entries = [];

    const puts = [];
    const sent = [];
    const saves = { hold: false, held: [] };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, init = {}) => {
        const method = init.method ?? 'GET';
        let result = {};
        let status = 200;
        if (url === '/api/store') result = structuredClone(data);
        else if (url === '/api/ai/jobs') result = { jobs: [] };
        else if (url === '/api/config') {
          result = { ai: { enabled: false }, latex: {}, git: {}, output: {}, overrides: {}, resumes: {} };
        } else if (url === '/api/resumes/expiring') result = { due: [] };
        else if (String(url).startsWith('/api/render')) {
          result = { pages: 1, fits: true, adjustments: [], warnings: [], lost: [], pdfUrl: '/pdf/x.pdf' };
        } else if (String(url).startsWith('/api/resumes/') && method === 'PUT') {
          sent.push(JSON.parse(init.body).id);
          if (saves.hold) await new Promise((go) => saves.held.push(go));
          const spec = JSON.parse(init.body);
          const at = data.resumes.findIndex((r) => r.id === spec.id);
          // As the server does: a save writes the file, whatever is there,
          // unless it asks to write only over a resume that is still there.
          if (at < 0 && /[?&]existing=1(&|$)/.test(url)) {
            status = 404;
            result = { error: 'That resume is no longer in the save.' };
          } else {
            puts.push(spec);
            if (at >= 0) data.resumes[at] = structuredClone(spec);
            else data.resumes.push(structuredClone(spec));
            result = spec;
          }
        }
        return { ok: status < 400, status, json: async () => structuredClone(result) };
      }),
    );
    return { data, puts, sent, saves, remove: (id) => data.resumes.splice(data.resumes.findIndex((r) => r.id === id), 1) };
  }

  const entryRow = (title) =>
    [...document.querySelectorAll('#editor .entry')].find((e) => e.querySelector('.title')?.textContent === title);
  const box = (title) => entryRow(title)?.querySelector(':scope > .entry-head input[type=checkbox], :scope > .toggle input[type=checkbox]');
  const shownIn = (spec, kind) => spec?.sections?.find((s) => s.kind === kind)?.entries ?? [];
  const status = () => document.querySelector('#status').textContent;
  const settle = (ms = 0) => new Promise((go) => setTimeout(go, ms));

  async function openOn(id, { framed = false } = {}) {
    vi.resetModules();
    document.documentElement.innerHTML = fs.readFileSync('web/index.html', 'utf8');
    window.location.hash = `#resumes/${id}`;
    const panel = { postMessage: vi.fn() };
    if (framed) {
      Object.defineProperty(window, 'parent', { value: panel, configurable: true });
      // Node's URL gives an extension's address no origin, so not the referrer.
      Object.defineProperty(window.location, 'ancestorOrigins', { value: [EXT], configurable: true });
    }
    const server = serve();
    await import('../web/app.js');
    await vi.waitFor(() => {
      expect(box('Thing')).toBeTruthy();
      expect(document.querySelector('#resume-select').value).toBe(id);
    });
    await settle(20);
    return { ...server, panel };
  }

  function comeBack() {
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  }

  /** The newgrad resume drawn, named, and addressed, and the move said. */
  async function showsBase() {
    await vi.waitFor(() => {
      expect(document.querySelector('#resume-select').value, 'the dropdown').toBe('newgrad');
      expect(box('Acme Co.')?.checked, 'the base’s own lines are drawn').toBe(true);
      expect(status()).toMatch(/“Summer intern” was deleted elsewhere/);
      expect(status()).toMatch(/showing “New grad”/);
    });
    expect(window.location.hash).toBe('#resumes/newgrad');
  }

  it('draws the resume it moved to, says so, and edits that one', async () => {
    const { data, puts, remove } = await openOn('intern');
    expect(box('Acme Co.').checked).toBe(false);

    remove('intern');
    comeBack();
    await showsBase();

    // What is on screen is what is written: a tick lands on the resume drawn.
    box('Thing').click();
    await vi.waitFor(() => expect(puts.length).toBe(1), { timeout: 4000 });
    expect(puts[0].id).toBe('newgrad');
    expect(shownIn(puts[0], 'experience'), 'the base kept its own lines').toContain('exp_acme');
    expect(data.resumes.some((r) => r.id === 'intern'), 'the deleted resume stays deleted').toBe(false);
  });

  it('does not write an edit still waiting on its save, and says it was not kept', async () => {
    const { data, puts, sent, remove } = await openOn('intern');
    box('Thing').click(); // waiting out the auto-save's pause
    remove('intern');
    comeBack();
    await vi.waitFor(() => expect(status()).toMatch(/your unsaved change to it was not kept/));
    await showsBase();
    expect(box('Thing').checked, 'the dropped edit is not drawn over the base').toBe(true);

    // Past the auto-save's pause: nothing went anywhere.
    await settle(1500);
    // Not even asked for: the read had already said the resume was gone.
    expect(sent, 'no save was sent for the deleted resume, or into the base').toEqual([]);
    expect(puts).toEqual([]);
    expect(data.resumes.some((r) => r.id === 'intern'), 'the deleted resume was not put back').toBe(false);
    expect(document.querySelector('#save-state').textContent).toBe('All changes saved');
  });

  it('does not put the resume back with a save that was already out when it went', async () => {
    const { data, saves, remove } = await openOn('intern');
    saves.hold = true;
    box('Thing').click();
    await vi.waitFor(() => expect(saves.held.length, 'the save is out').toBe(1), { timeout: 4000 });
    remove('intern');
    saves.hold = false;
    saves.held.forEach((go) => go());

    await vi.waitFor(() => expect(status()).toMatch(/your unsaved change to it was not kept/), { timeout: 4000 });
    expect(data.resumes.some((r) => r.id === 'intern'), 'the deleted resume was not put back').toBe(false);
    await showsBase();
    expect(document.querySelector('#save-state').textContent).toBe('All changes saved');
  });

  it('tells the side panel the resume it moved to', async () => {
    const { panel, remove } = await openOn('intern', { framed: true });
    const told = () => panel.postMessage.mock.calls.map(([m]) => m).filter((m) => m.rmm === 'state').at(-1);
    await vi.waitFor(() => expect(told()?.resumeId).toBe('intern'));

    remove('intern');
    const ev = new Event('message');
    Object.defineProperties(ev, { data: { value: { rmm: 'refresh' } }, source: { value: panel }, origin: { value: EXT } });
    window.dispatchEvent(ev);
    await showsBase();
    await vi.waitFor(() => expect(told()).toMatchObject({ resumeId: 'newgrad', label: 'New grad', exists: true }));
  });
});
