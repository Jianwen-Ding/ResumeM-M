// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { makeTempStore } from './helpers.ts';
import { normalizeEntries } from '../src/model/normalize.ts';

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

/* See boot-wiring.test.js: every listener a boot adds comes off after it. */
const registered = [];
for (const on of [window, document]) {
  const real = on.addEventListener.bind(on);
  on.addEventListener = (type, fn, opts) => {
    registered.push([on, type, fn, opts]);
    real(type, fn, opts);
  };
}

/*
 * Chromium fires `change`, if the box has been typed in since it was focused
 * or last changed, and then `blur` at a focused box that is taken out of the
 * page, there and then, while it is still connected. jsdom fires neither. The
 * redraw below does exactly that to the box being typed in, and a box that
 * saved on either would save half a year, so the browser's behaviour is
 * copied here. A value put in by script is not typing, as in Chromium.
 */
const typedIn = new WeakSet();
// Past the recording above, so these stay for every test in the file.
const listen = (type, fn) => EventTarget.prototype.addEventListener.call(document, type, fn, true);
listen('focusin', (e) => typedIn.delete(e.target));
listen('change', (e) => typedIn.delete(e.target));
listen('input', (e) => typedIn.add(e.target));
const realReplace = Element.prototype.replaceChildren;
Element.prototype.replaceChildren = function (...nodes) {
  const focused = document.activeElement;
  if (focused && focused !== this && this.contains(focused)) {
    if (typedIn.has(focused)) focused.dispatchEvent(new window.Event('change', { bubbles: true }));
    focused.dispatchEvent(new window.FocusEvent('blur'));
  }
  return realReplace.apply(this, nodes);
};

afterEach(() => {
  for (const [on, type, fn, opts] of registered.splice(0)) on.removeEventListener(type, fn, opts);
  vi.unstubAllGlobals();
});

/*
 * A year typed while the last date change is still saving.
 *
 * A date's save redraws the editor when it comes back, twice: once when the
 * entry's write returns and once more after the store is read again for the
 * words the server wrote. Each redraw builds new year boxes. So a year being
 * typed into one of them while that save was out went into a box the redraw
 * then threw away, along with the cursor. The box that replaced it held the
 * stored year, and leaving it saved nothing, because nothing had changed in
 * it. The editor walk lost a year that way with the page slowed, and the last
 * sweep made it wait for each date's save before typing the next. Typed key
 * by key it was worse: Chromium fires change at the box as it is removed, so
 * the "20" of 2030 was saved, which is no year, and that end of the date was
 * dropped from the entry.
 */
describe('typing a year while the last date change is saving', () => {
  let saves;
  let holdSave;

  const JOB = { id: 'j1', kind: 'experience', title: 'Everclear', dates: 'Jul. 2024 -- Dec. 2024' };
  const years = () => [...document.querySelectorAll('#editor .entry .dates .date-year')];
  const gate = () => {
    let open;
    const shut = new Promise((go) => (open = go));
    return { shut, open };
  };
  const typeInto = (box, text) => {
    box.value = text;
    box.dispatchEvent(new window.Event('input', { bubbles: true }));
  };
  const settle = () => new Promise((go) => setTimeout(go, 100));

  beforeEach(async () => {
    vi.resetModules();
    document.documentElement.innerHTML = fs.readFileSync('web/index.html', 'utf8');
    window.location.hash = '#resumes';
    const fixture = makeTempStore();
    const loaded = fixture.store.load();
    fixture.cleanup();
    saves = [];
    holdSave = null;
    const data = {
      ...loaded,
      entries: normalizeEntries([JOB]),
      skillGroups: [],
      resumes: [{ id: 'base', label: 'Base', base: true, sections: [{ kind: 'experience', entries: [JOB.id] }] }],
    };

    vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
      if (String(url).startsWith('/api/entries/') && init.method === 'PUT') {
        const body = JSON.parse(init.body);
        saves.push(body);
        const held = holdSave;
        holdSave = null;
        if (held) await held;
        // On a later turn, as a server answers. A redraw that kept saving
        // would otherwise spin without ever letting a timer run.
        await new Promise((go) => setTimeout(go, 0));
        const at = data.entries.findIndex((e) => e.id === body.id);
        if (at >= 0) data.entries[at] = { ...data.entries[at], ...body };
        return { ok: true, json: async () => structuredClone(body) };
      }
      let result = {};
      if (url === '/api/store') result = data;
      else if (url === '/api/ai/jobs') result = { jobs: [] };
      else if (url === '/api/render') result = { pages: 1, fits: true, adjustments: [], pdfUrl: '/pdf/x.pdf' };
      return { ok: true, json: async () => structuredClone(result) };
    }));

    await import('../web/app.js');
    await vi.waitFor(() => expect(years().length).toBe(2));
  });

  it('keeps the year being typed, and the cursor in it, and saves it on leaving', async () => {
    const [from, to] = years();
    const save = gate();
    holdSave = save.shut;
    from.value = '2023';
    from.dispatchEvent(new window.Event('change'));
    await vi.waitFor(() => expect(saves.length).toBe(1));

    // On to the far end while that save is out, halfway through a year.
    to.focus();
    typeInto(to, '202');
    save.open();
    await settle();

    const now = years()[1];
    expect(now.value).toBe('202');
    expect(document.activeElement).toBe(now);
    // Nothing was saved from the half-typed year as its box was replaced.
    expect(saves.length).toBe(1);

    // The rest of the year, into whichever box has the cursor, then away.
    typeInto(document.activeElement, '2026');
    document.activeElement.blur();
    await vi.waitFor(() => expect(saves.length).toBe(2));
    expect(saves[1].period).toEqual({ start: { year: 2023, month: 7 }, end: { year: 2026, month: 12 } });
  });

  /*
   * Typed in full before the redraw, then left without another key. The box
   * on screen holds the year, but only because it was put there: a browser
   * fires no change for that, so leaving it has to save it anyway.
   */
  it('saves a year that was carried over when the box is left without another key', async () => {
    const [from, to] = years();
    const save = gate();
    holdSave = save.shut;
    from.value = '2023';
    from.dispatchEvent(new window.Event('change'));
    await vi.waitFor(() => expect(saves.length).toBe(1));

    to.focus();
    typeInto(to, '2026');
    save.open();
    await settle();

    expect(years()[1].value).toBe('2026');
    document.activeElement.blur();
    await vi.waitFor(() => expect(saves.length).toBe(2));
    expect(saves[1].period.end).toEqual({ year: 2026, month: 12 });
    await settle();
    expect(saves.length).toBe(2);
  });

  /*
   * And a box that is only focused, with nothing typed, takes what the save
   * says. The redraw is how the server's answer reaches the screen.
   */
  it('shows the saved year in a box that is focused but untouched', async () => {
    const [from] = years();
    from.focus();
    from.value = '2023';
    from.dispatchEvent(new window.Event('change'));
    await vi.waitFor(() => expect(saves.length).toBe(1));
    await settle();

    const now = years()[0];
    expect(now.value).toBe('2023');
    expect(document.activeElement).toBe(now);
    // Leaving it is not another save: nothing was typed since the last.
    now.blur();
    await settle();
    expect(saves.length).toBe(1);
  });
});
