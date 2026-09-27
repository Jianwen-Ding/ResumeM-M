// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { makeTempStore } from './helpers.ts';

vi.mock('../web/preview.js', () => ({ createPreview: () => ({ show: async () => {} }) }));
vi.mock('../web/assets.js', () => ({
  setupAssets: () => ({ init: async () => ({ current: '/test-save' }), load: async () => {} }),
}));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/*
 * Stepping a phrasing, or switching a line, far down the page.
 *
 * Both redraw the whole editor (`renderEditor`), which throws every control
 * away and builds new ones. In Chromium the line the page was scrolled to
 * went with them, and the browser's scroll anchoring, having lost its
 * anchor, put the view back near the top: measured at 360px wide, switching
 * off the last line of a resume moved the page from 2881px down to 432px,
 * and stepping a wording from 2337 to 414 — the same at 1280px. The line you
 * had just changed was a screen and a half away.
 *
 * jsdom lays nothing out, so the browser's half is played here by a page
 * that jumps up when the editor is emptied — exactly what was measured —
 * and the check is that the editor puts it back.
 */
describe('the editor redrawing under a scrolled page', () => {
  let y = 0;
  const scrolls = [];

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    document.documentElement.innerHTML = fs.readFileSync('web/index.html', 'utf8');
    location.hash = '';
    const fixture = makeTempStore();
    const data = fixture.store.load();
    fixture.cleanup();
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      let result = {};
      if (url === '/api/store') result = data;
      else if (url === '/api/ai/jobs') result = { jobs: [] };
      else if (url === '/api/render') result = { pages: 1, fits: true, adjustments: [], pdfUrl: '/pdf/x.pdf' };
      return { ok: true, json: async () => structuredClone(result) };
    }));

    y = 0;
    scrolls.length = 0;
    Object.defineProperty(window, 'scrollY', { configurable: true, get: () => y });
    vi.stubGlobal('scrollTo', (x, to) => {
      scrolls.push(to);
      y = to;
    });

    await import('../web/app.js');
    await vi.waitFor(() => expect(document.querySelector('#editor .bullet input[type=checkbox]')).not.toBeNull());

    // The browser's part: emptying the editor drops the view near the top.
    const editor = document.querySelector('#editor');
    const empty = editor.replaceChildren.bind(editor);
    editor.replaceChildren = (...nodes) => {
      if (nodes.length === 0) y = Math.min(y, 400);
      return empty(...nodes);
    };
  });

  it('keeps the page where it was when a line is switched off', () => {
    y = 2881;
    const boxes = [...document.querySelectorAll('#editor .bullet input[type=checkbox]')];
    const last = boxes.at(-1);
    last.checked = !last.checked;
    last.dispatchEvent(new Event('change'));
    expect(y).toBe(2881);
    expect(scrolls).toContain(2881);
  });

  it('and when a wording is stepped', () => {
    const step = [...document.querySelectorAll('#editor .stepper .step')].at(-1);
    expect(step).toBeTruthy();
    y = 2337;
    step.click();
    expect(y).toBe(2337);
  });

  it('and leaves a page that did not move alone', () => {
    y = 0;
    const box = document.querySelector('#editor .bullet input[type=checkbox]');
    box.checked = !box.checked;
    box.dispatchEvent(new Event('change'));
    expect(scrolls).toEqual([]);
  });
});
