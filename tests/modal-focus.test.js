// @vitest-environment jsdom
/*
 * Where the keyboard goes when a dialog opens, and whether it can leave.
 *
 * Nothing here checks what a dialog says — that is covered wherever each one
 * is opened. What was never checked, in a browser or in jsdom, is what the
 * dialog does to the keyboard: neither `showModal` nor `form` ever moved
 * focus into it, so a dialog with no text field (a confirmation, "Add an
 * entry") left focus sitting on the button that opened it, invisible now
 * under the overlay. And nothing stopped Tab walking past the dialog into
 * the toolbar behind it, because Tab just follows document order and the
 * dialog is one element among many in that order, not a boundary to it.
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

let documents;
let data;
/** Set by a block that needs the save arranged before the editor opens it. */
let arrange = () => {};

async function boot() {
  vi.resetModules();
  vi.useFakeTimers();
  document.documentElement.innerHTML = fs.readFileSync('web/index.html', 'utf8');
  location.hash = '';
  const fixture = makeTempStore();
  data = fixture.store.load();
  fixture.cleanup();
  arrange(data);
  documents = [{ name: 'Transcript.pdf', bytes: 1234, at: '2026-09-21T00:00:00.000Z' }];

  vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
    const method = options.method ?? 'GET';
    let result = {};
    if (url === '/api/store') result = data;
    else if (url === '/api/ai/jobs') result = { jobs: [] };
    else if (url === '/api/documents' && method === 'GET') result = { documents, dir: '/save/out/current' };
    else if (url.startsWith('/api/documents/') && method === 'DELETE') {
      const name = decodeURIComponent(url.split('/').pop());
      documents = documents.filter((d) => d.name !== name);
      result = { ok: true };
    } else if (url.endsWith('/rename') && method === 'POST') {
      const id = decodeURIComponent(url.split('/').slice(-2)[0]);
      const body = JSON.parse(options.body);
      data.resumes = data.resumes.map((r) => (r.id === id ? { ...r, label: body.label } : r));
      result = data.resumes.find((r) => r.id === id);
    } else if (url.startsWith('/api/resumes/') && method === 'DELETE') {
      const id = decodeURIComponent(url.split('/').pop());
      data.resumes = data.resumes.filter((r) => r.id !== id);
      result = { ok: true };
    } else if (url === '/api/render') result = { pages: 1, fits: true, adjustments: [], pdfUrl: '/pdf/x.pdf' };
    return { ok: true, json: async () => structuredClone(result) };
  }));

  await import('../web/app.js');
  await vi.waitFor(() => expect(document.querySelector('#doc-list')).not.toBeNull());
}

/** Open the "Remove Transcript.pdf?" confirmation — a dialog with no text field. */
async function openRemoveDialog() {
  document.querySelector('button[data-tab="save"]').click();
  await vi.waitFor(() =>
    expect([...document.querySelectorAll('#doc-list button')].some((b) => b.textContent === 'Remove')).toBe(true),
  );
  const remove = [...document.querySelectorAll('#doc-list button')].find((b) => b.textContent === 'Remove');
  remove.focus();
  remove.click();
  await vi.waitFor(() => expect(document.querySelector('#modal').classList.contains('hidden')).toBe(false));
  await vi.advanceTimersByTimeAsync(10);
  return remove;
}

describe('a dialog, opened over the editor', () => {
  beforeEach(boot);

  it('takes the keyboard focus, rather than leaving it on the button behind it', async () => {
    const remove = await openRemoveDialog();
    expect(document.activeElement).not.toBe(remove);
    expect(document.querySelector('#modal').contains(document.activeElement)).toBe(true);
  });

  it('does the same for a dialog of nothing but selects and checkboxes', async () => {
    const add = document.querySelector('#btn-add-entry');
    add.focus();
    add.click();
    await vi.waitFor(() => expect(document.querySelector('#modal').classList.contains('hidden')).toBe(false));
    await vi.advanceTimersByTimeAsync(10);

    expect(document.activeElement).not.toBe(add);
    expect(document.querySelector('#modal').contains(document.activeElement)).toBe(true);
    // The first field ("Which section?"), not merely something in the dialog.
    expect(document.activeElement.tagName).toBe('SELECT');
  });

  it('keeps Tab from reaching the page behind it', async () => {
    await openRemoveDialog();

    // Cancel is the first focusable thing in this dialog (it has no text
    // field), OK the last. Tab from the last has nowhere else in the dialog
    // to go — the bug let it carry on into the toolbar; the fix wraps it.
    document.querySelector('#modal-ok').focus();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(document.querySelector('#modal-cancel'));

    // And the other edge, the same way: Shift+Tab from the first wraps to
    // the last rather than leaving through the front of the dialog.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(document.querySelector('#modal-ok'));
  });

  it('leaves Escape and Ctrl+Z alone otherwise', async () => {
    await openRemoveDialog();
    // Unrelated keys still reach the dialog's own handling — Escape closes
    // it — so the trap above is additive, not a replacement for the rest of
    // this listener.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await vi.advanceTimersByTimeAsync(10);
    expect(document.querySelector('#modal').classList.contains('hidden')).toBe(true);
  });
});

/*
 * Where the keyboard goes when a dialog closes.
 *
 * Nowhere, it used to: Escape, Cancel and a successful Save all left focus on
 * <body>, so after renaming a resume from the toolbar the next Tab started
 * from the top of the page. It goes back to the button that opened the
 * dialog — or, when that button is no longer on screen (the narrow More menu
 * shuts once something in it is chosen), to More.
 */
describe('a dialog opened from the toolbar, once it closes', () => {
  const modalShut = () => document.querySelector('#modal').classList.contains('hidden');
  const escape = () =>
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));

  /** Press a toolbar button the way a keyboard does, and wait for its dialog. */
  async function openFrom(button) {
    button.focus();
    button.click();
    await vi.waitFor(() => expect(modalShut()).toBe(false));
    await vi.advanceTimersByTimeAsync(10);
    expect(document.querySelector('#modal').contains(document.activeElement)).toBe(true);
  }

  /**
   * The Resumes tab, on screen, with the stylesheet applied — as it is
   * wide, or (jsdom ignores media queries) with the narrow block added as
   * plain rules. The stylesheet is what hides a button that has gone: the
   * narrow menu once it shuts, and More itself when wide.
   */
  async function onResume(id, { narrow = false } = {}) {
    const css = fs.readFileSync('web/style.css', 'utf8');
    const narrowRules = /@media \(max-width: 640px\) \{([\s\S]*?)\n\}/.exec(css)?.[1];
    expect(narrowRules).toBeTruthy();
    const style = document.createElement('style');
    style.textContent = narrow ? css + narrowRules : css;
    document.head.append(style);
    for (const b of document.querySelectorAll('#tabs button')) b.disabled = false;
    document.querySelector('button[data-tab="resumes"]').click();
    await vi.advanceTimersByTimeAsync(10);

    const picker = document.querySelector('#resume-select');
    picker.value = id;
    picker.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(document.querySelector('#btn-rename-resume').hidden).toBe(false));
  }

  describe('wide', () => {
    beforeEach(async () => {
      await boot();
      await onResume('newgrad');
    });

    it('goes back to Rename… on Escape, on Cancel, and after the new name is saved', async () => {
      const rename = document.querySelector('#btn-rename-resume');

      await openFrom(rename);
      escape();
      expect(modalShut()).toBe(true);
      expect(document.activeElement).toBe(rename);

      await openFrom(rename);
      document.querySelector('#modal-cancel').click();
      expect(document.activeElement).toBe(rename);

      await openFrom(rename);
      document.querySelector('#modal-content [name="label"]').value = 'Morgan Testwell — new grad';
      document.querySelector('#modal-ok').click();
      await vi.waitFor(() => expect(data.resumes.find((r) => r.id === 'newgrad').label).toBe('Morgan Testwell — new grad'));
      await vi.advanceTimersByTimeAsync(100);
      expect(document.activeElement).toBe(rename);
    });

    it('goes back to Save as variation… when it is cancelled', async () => {
      const saveAs = document.querySelector('#btn-save-as');
      await openFrom(saveAs);
      escape();
      expect(document.activeElement).toBe(saveAs);
    });

    it('goes back to Delete variation when the delete is not confirmed, and stays there once it is', async () => {
      const del = document.querySelector('#btn-delete-resume');
      await openFrom(del);
      escape();
      expect(document.activeElement).toBe(del);

      await openFrom(del);
      document.querySelector('#modal-cancel').click();
      expect(document.activeElement).toBe(del);

      // Three resumes, two left: Delete is still there to come back to.
      await openFrom(del);
      document.querySelector('#modal-ok').click();
      await vi.waitFor(() => expect(data.resumes.some((r) => r.id === 'newgrad')).toBe(false));
      await vi.advanceTimersByTimeAsync(100);
      expect(del.hidden).toBe(false);
      expect(document.activeElement).toBe(del);
    });
  });

  describe('wide, deleting the last resume but one', () => {
    beforeEach(async () => {
      arrange = (d) => {
        d.resumes = d.resumes.filter((r) => r.id !== 'intern');
      };
      await boot();
      await onResume('newgrad');
    });
    afterEach(() => {
      arrange = () => {};
    });

    it('lands on the resume picker, since Delete has gone with it', async () => {
      const del = document.querySelector('#btn-delete-resume');
      await openFrom(del);
      document.querySelector('#modal-ok').click();
      await vi.waitFor(() => expect(data.resumes).toHaveLength(1));
      await vi.advanceTimersByTimeAsync(100);
      expect(del.hidden).toBe(true);
      expect(document.activeElement).toBe(document.querySelector('#resume-select'));
    });
  });

  describe('narrow, from the More menu', () => {
    beforeEach(async () => {
      await boot();
      await onResume('newgrad', { narrow: true });
    });

    for (const [id, close] of [
      ['btn-rename-resume', 'Escape'],
      ['btn-rename-resume', 'Cancel'],
      ['btn-save-as', 'Escape'],
      ['btn-delete-resume', 'Cancel'],
    ]) {
      it(`goes back to More after ${close} on #${id}, the item having gone with the menu`, async () => {
        const more = document.querySelector('#btn-more');
        more.click();
        expect(more.getAttribute('aria-expanded')).toBe('true');
        await openFrom(document.querySelector(`#${id}`));
        // Chosen, so the menu shut behind the dialog.
        expect(more.getAttribute('aria-expanded')).toBe('false');

        if (close === 'Escape') escape();
        else document.querySelector('#modal-cancel').click();
        expect(modalShut()).toBe(true);
        expect(document.activeElement).toBe(more);
      });
    }

    it('goes back to More after a rename is saved', async () => {
      const more = document.querySelector('#btn-more');
      more.click();
      await openFrom(document.querySelector('#btn-rename-resume'));
      document.querySelector('#modal-content [name="label"]').value = 'Morgan Testwell — narrow';
      document.querySelector('#modal-ok').click();
      await vi.waitFor(() => expect(data.resumes.find((r) => r.id === 'newgrad').label).toBe('Morgan Testwell — narrow'));
      await vi.advanceTimersByTimeAsync(100);
      expect(document.activeElement).toBe(more);
    });
  });
});
