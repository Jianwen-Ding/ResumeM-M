// @vitest-environment jsdom
/*
 * The toolbar's tier button says what pressing it does.
 *
 * It said what the resume *was* — "☆ Kept", "★ Base", "⌛ Temporary" — and only
 * its hover text said what a press would do. In the narrow More menu that is a
 * row reading "☆ Kept" among "Rename…" and "Delete variation", which reads as
 * a status, and a touch screen never shows the hover text. Now the button is
 * the action and the state is a quiet label beside it (#tier-state), wide and
 * narrow alike, since both are the same two elements.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
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

let data;
let tiersWritten;

/** The editor, opened on a save where `newgrad` is of the tier given. */
async function boot(tier = 'extended') {
  vi.resetModules();
  vi.useFakeTimers();
  document.documentElement.innerHTML = fs.readFileSync('web/index.html', 'utf8');
  location.hash = '';
  const fixture = makeTempStore();
  data = fixture.store.load();
  fixture.cleanup();
  data.resumes = data.resumes.map((r) => (r.id === 'newgrad' ? { ...r, tier } : r));
  tiersWritten = [];

  vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
    const method = options.method ?? 'GET';
    let result = {};
    if (url === '/api/store') result = data;
    else if (url === '/api/ai/jobs') result = { jobs: [] };
    else if (url === '/api/render') result = { pages: 1, fits: true, adjustments: [], pdfUrl: '/pdf/x.pdf' };
    else if (url.endsWith('/tier') && method === 'PUT') {
      const id = decodeURIComponent(url.split('/').slice(-2)[0]);
      const { tier } = JSON.parse(options.body);
      tiersWritten.push(tier);
      data.resumes = data.resumes.map((r) => (r.id === id ? { ...r, tier } : r));
      result = { ok: true };
    }
    return { ok: true, json: async () => structuredClone(result) };
  }));

  await import('../web/app.js');
  await vi.waitFor(() => expect(document.querySelector('#resume-select option')).not.toBeNull());
}

async function open(tier) {
  await boot(tier);
  const picker = document.querySelector('#resume-select');
  picker.value = 'newgrad';
  picker.dispatchEvent(new Event('change'));
  await vi.waitFor(() => expect(document.querySelector('#btn-base').disabled).toBe(false));
}

const button = () => document.querySelector('#btn-base');
const label = () => document.querySelector('#tier-state');

/** Press it, and wait for the store to be read back and the toolbar redrawn. */
async function press() {
  const before = tiersWritten.length;
  button().click();
  await vi.waitFor(() => expect(tiersWritten.length).toBe(before + 1));
  await vi.advanceTimersByTimeAsync(50);
}

describe('the tier button', () => {
  it('on a kept resume, offers to make it a base, and does', async () => {
    await open('extended');
    expect(label().textContent).toMatch(/Kept/);
    expect(button().textContent).toBe('Make this a base');

    await press();
    expect(tiersWritten.at(-1)).toBe('base');
    expect(label().textContent).toMatch(/Base/);
    expect(button().textContent).toBe('Stop using as a base');
  });

  it('on a base, offers to stop using it as one, which keeps it', async () => {
    await open('base');
    expect(label().textContent).toMatch(/Base/);
    expect(button().textContent).toBe('Stop using as a base');

    await press();
    expect(tiersWritten.at(-1)).toBe('extended');
    expect(label().textContent).toMatch(/Kept/);
    expect(button().textContent).toBe('Make this a base');
  });

  it('on a temporary resume, offers to keep it', async () => {
    await open('temporary');
    expect(label().textContent).toMatch(/Temporary/);
    expect(label().className).toContain('temporary');
    expect(button().textContent).toBe('Keep this resume');

    await press();
    expect(tiersWritten.at(-1)).toBe('extended');
    expect(label().textContent).toMatch(/Kept/);
  });

  it('never reads as the state it is in, and is described by it', async () => {
    for (const tier of ['base', 'extended', 'temporary']) {
      await open(tier);
      expect(button().textContent).not.toBe(label().textContent);
      expect(button().textContent).not.toMatch(/[★☆⌛]/);
      expect(button().getAttribute('aria-describedby')).toBe('tier-state');
      expect(label().hidden).toBe(false);
    }
  });

  it('is not a button in the More menu, so the arrow keys pass the label by', async () => {
    await boot();
    const menu = document.querySelector('#toolbar-more');
    expect(menu.contains(label())).toBe(true);
    expect(label().tagName).not.toBe('BUTTON');
    // First in the menu, over the button that changes it.
    expect(label().nextElementSibling).toBe(button());
  });

  it('goes, with its label, on the master, which has no tier', async () => {
    await boot();
    const picker = document.querySelector('#resume-select');
    picker.value = '__master__';
    picker.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(button().hidden).toBe(true));
    expect(label().hidden).toBe(true);
  });
});
