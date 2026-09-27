// @vitest-environment jsdom
/*
 * Enter in a dialog, and a long word in the header.
 *
 * The dialog is a <div>, not a <form>, so Enter in its one text field did
 * nothing: Rename, Save as and the rest needed Tab to Save and Enter again.
 * It sends the dialog now, through the dialog's own button, so whatever that
 * button checks — a name another resume already has — is still checked. A
 * textarea keeps Enter for a new line.
 *
 * And the status line: a long "Renamed to …" wrapped to three lines in the
 * header and squeezed the tabs until Voice & AI was cut off. It is one line,
 * cut short, with the rest in its title and all of it read out.
 */
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

let data;
let calls;
/** Resolves the application POST the test is holding open, when it is. */
let letApplicationLand = null;

async function boot() {
  vi.resetModules();
  vi.useFakeTimers();
  document.documentElement.innerHTML = fs.readFileSync('web/index.html', 'utf8');
  location.hash = '';
  const fixture = makeTempStore();
  data = fixture.store.load();
  fixture.cleanup();
  calls = [];

  vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
    const method = options.method ?? 'GET';
    calls.push(`${method} ${url}`);
    let result = {};
    if (url === '/api/store') result = data;
    else if (url === '/api/ai/jobs') result = { jobs: [] };
    else if (url === '/api/documents') result = { documents: [], dir: '/save/out/current' };
    else if (url === '/api/workspace') result = { drafts: [] };
    else if (url === '/api/applications' && method === 'GET') {
      result = { applications: [], stats: { total: 0, last7: 0, last30: 0, responseRate: 0 } };
    }
    else if (url === '/api/applications' && method === 'POST') {
      await new Promise((resolve) => (letApplicationLand = resolve));
      result = { ok: true };
    } else if (url.endsWith('/rename') && method === 'POST') {
      const id = decodeURIComponent(url.split('/').slice(-2)[0]);
      const body = JSON.parse(options.body);
      data.resumes = data.resumes.map((r) => (r.id === id ? { ...r, label: body.label } : r));
      result = data.resumes.find((r) => r.id === id);
    } else if (url.includes('?create=1') && method === 'PUT') {
      const spec = JSON.parse(options.body);
      data.resumes = [...data.resumes, spec];
      result = spec;
    } else if (url === '/api/render') result = { pages: 1, fits: true, adjustments: [], pdfUrl: '/pdf/x.pdf' };
    return { ok: true, json: async () => structuredClone(result) };
  }));

  await import('../web/app.js');
  await vi.waitFor(() => expect(document.querySelector('#doc-list')).not.toBeNull());

  for (const b of document.querySelectorAll('#tabs button')) b.disabled = false;
  document.querySelector('button[data-tab="resumes"]').click();
  await vi.advanceTimersByTimeAsync(10);
  const picker = document.querySelector('#resume-select');
  picker.value = 'newgrad';
  picker.dispatchEvent(new Event('change'));
  await vi.waitFor(() => expect(document.querySelector('#btn-rename-resume').hidden).toBe(false));
}

const modalShut = () => document.querySelector('#modal').classList.contains('hidden');
const field = (name) => document.querySelector(`#modal-content [name="${name}"]`);

/** Enter, pressed on whatever has the focus (or `on`). The event, to ask whether it was stopped. */
function enter(init = {}, on = document.activeElement) {
  const e = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...init });
  on.dispatchEvent(e);
  return e;
}

/** Open a dialog from a button, the way a keyboard does, and let focus move into it. */
async function openFrom(button) {
  button.focus();
  button.click();
  await vi.waitFor(() => expect(modalShut()).toBe(false));
  await vi.advanceTimersByTimeAsync(10);
}

describe('Enter in a dialog', () => {
  beforeEach(boot);

  it('saves Rename from its name field, as its Save button does', async () => {
    await openFrom(document.querySelector('#btn-rename-resume'));
    expect(document.activeElement).toBe(field('label'));
    field('label').value = 'Morgan Testwell — new grad';

    const e = enter();
    expect(e.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(data.resumes.find((r) => r.id === 'newgrad').label).toBe('Morgan Testwell — new grad'));
    expect(modalShut()).toBe(true);
  });

  it('still refuses a name another resume has, and says why', async () => {
    await openFrom(document.querySelector('#btn-rename-resume'));
    field('label').value = 'Summer intern';
    enter();
    await vi.advanceTimersByTimeAsync(10);

    // Asked again, with the reason, holding what was typed.
    expect(modalShut()).toBe(false);
    expect(document.querySelector('#modal-note').textContent).toMatch(/“Summer intern” already exists/);
    expect(field('label').value).toBe('Summer intern');
    expect(calls.some((c) => c.endsWith('/rename'))).toBe(false);
  });

  it('keeps Enter in a textarea for a new line, and sends on Ctrl+Enter there', async () => {
    // + Entry: a dialog of two selects, then the entry's own form.
    await openFrom(document.querySelector('#btn-add-entry'));
    document.querySelector('#modal-ok').click();
    await vi.waitFor(() => expect(field('bullet')).not.toBeNull());
    await vi.advanceTimersByTimeAsync(10);
    field('title').value = 'Testwell Labs';
    field('bullet').focus();

    const plain = enter();
    expect(plain.defaultPrevented).toBe(false);
    expect(modalShut()).toBe(false);

    enter({ ctrlKey: true });
    expect(modalShut()).toBe(true);
    // And the entry is added, rather than left half-done when the test ends.
    await vi.waitFor(() => expect(document.querySelector('#status').textContent).toMatch(/^Added/));
  });

  it('leaves Enter on a button or a select to that control', async () => {
    await openFrom(document.querySelector('#btn-add-entry'));
    // "Which section?" has the focus; Enter there is the select's own.
    expect(document.activeElement.tagName).toBe('SELECT');
    expect(enter().defaultPrevented).toBe(false);
    expect(enter({}, document.querySelector('#modal-cancel')).defaultPrevented).toBe(false);
    expect(modalShut()).toBe(false);
  });

  it('does not send while a word is still being composed', async () => {
    await openFrom(document.querySelector('#btn-rename-resume'));
    field('label').value = 'Morgan Testwell 新卒';
    expect(enter({ isComposing: true }).defaultPrevented).toBe(false);
    expect(modalShut()).toBe(false);
  });

  it('sends a form that saves once, however often Enter is pressed while it saves', async () => {
    await openFrom(document.querySelector('#btn-add-app'));
    field('company').value = 'Testwell Labs';
    field('role').value = 'Engineer';
    field('url').focus();

    enter();
    await vi.advanceTimersByTimeAsync(700);
    // Well apart, so it is the disabled Save that stops the second, not the pause.
    enter();
    await vi.advanceTimersByTimeAsync(10);
    expect(calls.filter((c) => c === 'POST /api/applications')).toHaveLength(1);
    expect(modalShut()).toBe(false);

    letApplicationLand();
    await vi.waitFor(() => expect(modalShut()).toBe(true));
    expect(calls.filter((c) => c === 'POST /api/applications')).toHaveLength(1);
  });

  it('pressed twice quickly, or held, gives the second press to nothing — not to the button focus went back to', async () => {
    const saveAs = document.querySelector('#btn-save-as');
    await openFrom(saveAs);
    field('label').value = 'Morgan Testwell — variation';
    field('id').value = 'morgan-variation';
    enter();
    await vi.waitFor(() => expect(data.resumes.some((r) => r.id === 'morgan-variation')).toBe(true));

    // Focus is back on Save as…, where an Enter would open the dialog again.
    expect(modalShut()).toBe(true);
    expect(document.activeElement).toBe(saveAs);
    expect(enter().defaultPrevented).toBe(true);
    expect(enter({ repeat: true }).defaultPrevented).toBe(true);

    // A deliberate press later is the button's again.
    await vi.advanceTimersByTimeAsync(600);
    expect(enter().defaultPrevented).toBe(false);
    expect(calls.filter((c) => c.includes('?create=1'))).toHaveLength(1);
  });

  it('does not reach the button behind the dialog before focus has moved in', async () => {
    const rename = document.querySelector('#btn-rename-resume');
    rename.focus();
    rename.click();
    // The dialog is up, and focus moves into it on the next tick.
    expect(modalShut()).toBe(false);
    expect(document.activeElement).toBe(rename);
    expect(enter().defaultPrevented).toBe(true);
  });
});

describe('a long status in the header', () => {
  const long = 'Morgan Testwell — senior platform engineer, distributed systems and developer tooling';

  beforeEach(async () => {
    await boot();
    await openFrom(document.querySelector('#btn-rename-resume'));
    field('label').value = long;
    document.querySelector('#modal-ok').click();
    await vi.waitFor(() => expect(document.querySelector('#status').textContent).toBe(`Renamed to “${long}”`));
  });

  const css = () => fs.readFileSync('web/style.css', 'utf8');
  const narrowRules = () => /@media \(max-width: 640px\) \{([\s\S]*?)\n\}/.exec(css())?.[1];
  const withStyle = (text) => {
    const style = document.createElement('style');
    style.textContent = text;
    document.head.append(style);
  };

  it('is said in full: all of it is the text of a live region, and its title', () => {
    const status = document.querySelector('#status');
    expect(status.getAttribute('role')).toBe('status');
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(status.title).toBe(`Renamed to “${long}”`);
  });

  it('forgets the title with the text when it clears', async () => {
    await vi.advanceTimersByTimeAsync(4000);
    expect(document.querySelector('#status').textContent).toBe('');
    expect(document.querySelector('#status').title).toBe('');
  });

  it('is one line cut short, and gives up its room before the tabs give up theirs', () => {
    withStyle(css());
    const shown = getComputedStyle(document.querySelector('#status'));
    expect(shown.whiteSpace).toBe('nowrap');
    expect(shown.overflow).toBe('hidden');
    expect(shown.textOverflow).toBe('ellipsis');
    expect(parseFloat(shown.minWidth)).toBe(0);
    const tabs = Number(getComputedStyle(document.querySelector('#tabs')).flexShrink || 1);
    expect(Number(shown.flexShrink)).toBeGreaterThanOrEqual(1000 * tabs);
  });

  it('narrow, floats over the page and wraps, rather than taking a row above the toolbar', () => {
    // jsdom ignores media queries: the narrow block, added as plain rules.
    expect(narrowRules()).toBeTruthy();
    withStyle(css() + narrowRules());
    const shown = getComputedStyle(document.querySelector('#status'));
    expect(shown.position).toBe('fixed');
    expect(shown.whiteSpace).toBe('normal');
  });

  it('in the side panel, stays in the floating header rather than floating twice', () => {
    document.documentElement.classList.add('embedded');
    withStyle(css() + narrowRules());
    const shown = getComputedStyle(document.querySelector('#status'));
    expect(shown.position).toBe('static');
    expect(shown.whiteSpace).toBe('normal');
  });
});
