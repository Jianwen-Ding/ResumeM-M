// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

/*
 * Restoring a version, which is the most destructive button in the editor:
 * it replaces the resume in front of you with one from a commit.
 *
 * What makes pressing it reasonable is the sentence in the confirmation —
 * "its own history is kept, so you can still get back to it". Everything here
 * is about that sentence being true.
 */
describe('restoring a version', () => {
  let data;
  let requests;
  let releaseSave;

  const versions = [
    { hash: 'now000', date: '2026-09-18T10:00:00Z', message: 'Edited', changes: [] },
    { hash: 'old111', date: '2026-09-10T10:00:00Z', message: 'Earlier', changes: [] },
  ];

  const openHistory = async (id) => {
    document.querySelector('#tabs button[data-tab="history"]').click();
    await vi.waitFor(() => expect(document.querySelector('#history-resume option')).not.toBeNull());
    const picker = document.querySelector('#history-resume');
    picker.value = id;
    picker.dispatchEvent(new window.Event('change'));
    await vi.waitFor(() => expect(document.querySelector('.version-card:not(.current) button')).not.toBeNull());
  };

  const restoreButton = () =>
    [...document.querySelectorAll('.version-card button')].find((b) => b.textContent.startsWith('Restore'));

  beforeEach(async () => {
    vi.resetModules();
    document.documentElement.innerHTML = fs.readFileSync('web/index.html', 'utf8');
    window.location.hash = '';

    const fixture = makeTempStore();
    data = fixture.store.load();
    fixture.cleanup();
    requests = [];
    releaseSave = null;
    vi.stubGlobal('confirm', () => true);

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, options = {}) => {
        const method = options.method ?? 'GET';
        const body = options.body ? JSON.parse(options.body) : null;
        requests.push({ url: String(url), method, body });
        let result = {};
        if (url === '/api/store') result = structuredClone(data);
        else if (url === '/api/ai/jobs') result = { jobs: [] };
        else if (url === '/api/render') result = { pages: 1, fits: true, adjustments: [], pdfUrl: '/pdf/x.pdf' };
        else if (String(url).includes('/history/') && String(url).endsWith('/restore')) {
          result = { id: 'newgrad', label: 'New grad', warnings: [] };
        } else if (String(url).includes('/history')) result = { versions };
        else if (String(url).startsWith('/api/resumes/') && method === 'PUT') {
          // The write the flush waits on, held open when a test asks.
          if (releaseSave) await releaseSave;
          const id = decodeURIComponent(String(url).split('?')[0].split('/').pop());
          data.resumes = data.resumes.map((r) => (r.id === id ? { ...body, id } : r));
          result = data.resumes.find((r) => r.id === id);
        }
        return { ok: true, json: async () => structuredClone(result) };
      }),
    );

    await import('../web/app.js');
    await vi.waitFor(() => expect(document.querySelector('#resume-select option')).not.toBeNull());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const restored = () => requests.filter((r) => r.url.includes('/restore'));

  it('restores the resume that was on screen when it was asked for', async () => {
    await openHistory('newgrad');
    restoreButton().click();
    await vi.waitFor(() => expect(restored()).toHaveLength(1));
    expect(restored()[0].url).toContain('/resumes/newgrad/history/old111/restore');
  });

  /*
   * The dropdown above the timeline is a control somebody can use while this
   * is running, and the flush before the restore is a round trip — slow
   * exactly when there is an unsaved edit, which is exactly when people reach
   * for an old version.
   *
   * Read again after that wait, the restore went to whichever resume was
   * selected by then, carrying a version from the timeline of a different
   * one. The server reads that commit's file for the id it is given and saves
   * it, so a resume nobody was looking at was overwritten out of a commit
   * never shown for it, under a confirmation naming something else.
   */
  it('does not follow the dropdown if it is changed while the save is in flight', async () => {
    let release;
    releaseSave = new Promise((settle) => {
      release = settle;
    });

    // An edit, so the restore has a write to flush before it goes.
    await vi.waitFor(() => expect(document.querySelector('#tab-resumes .toggle input')).not.toBeNull());
    document.querySelector('#tab-resumes .toggle input').click();

    await openHistory('newgrad');
    restoreButton().click();

    // …and the dropdown is used while that write is still out.
    const picker = document.querySelector('#history-resume');
    picker.value = 'intern';
    picker.dispatchEvent(new window.Event('change'));

    release();
    await vi.waitFor(() => expect(restored()).toHaveLength(1));
    expect(restored()[0].url).toContain('/resumes/newgrad/');
    expect(restored()[0].url).not.toContain('/resumes/intern/');
  });

  /*
   * And undo stops pointing at a document that is gone.
   *
   * Its entries are "this resume before and after an edit", and the resume
   * they describe has just been replaced. Undo is always enabled and says
   * nothing about what it is about to undo, so one press after a restore put
   * the pre-restore document back over the restored one, reported "Undid
   * change", and left no sign that the version somebody had just gone to
   * fetch was gone.
   */
  it('leaves nothing on the undo stack pointing at what was replaced', async () => {
    await vi.waitFor(() => expect(document.querySelector('#tab-resumes .toggle input')).not.toBeNull());
    document.querySelector('#tab-resumes .toggle input').click();
    await vi.waitFor(() =>
      expect(requests.some((r) => r.method === 'PUT' && r.url.startsWith('/api/resumes/'))).toBe(true),
    );

    await openHistory('newgrad');
    restoreButton().click();
    await vi.waitFor(() => expect(restored()).toHaveLength(1));

    const wrote = requests.filter((r) => r.method === 'PUT' && r.url.startsWith('/api/resumes/')).length;
    document.querySelector('#tabs button[data-tab="resumes"]').click();
    document.querySelector('#btn-undo').click();
    await new Promise((settle) => setTimeout(settle, 30));

    expect(requests.filter((r) => r.method === 'PUT' && r.url.startsWith('/api/resumes/')).length).toBe(wrote);
    expect(document.querySelector('#btn-undo').disabled).toBe(true);
  });
});
