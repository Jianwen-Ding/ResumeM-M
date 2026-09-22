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

async function boot() {
  vi.resetModules();
  vi.useFakeTimers();
  document.documentElement.innerHTML = fs.readFileSync('web/index.html', 'utf8');
  location.hash = '';
  const fixture = makeTempStore();
  const data = fixture.store.load();
  fixture.cleanup();
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
