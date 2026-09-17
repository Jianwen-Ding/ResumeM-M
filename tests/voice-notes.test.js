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
 * The notes beside the writing samples are the one field in the editor with
 * no autosave — they have a Save button instead, because they are a standing
 * instruction rather than an edit to a document.
 *
 * That makes them the one field that can be destroyed by something else being
 * reloaded, and `loadVoice` reloads them on six occasions: opening the panel,
 * adding a sample, editing one, dropping a file, accepting what was read out
 * of it, and saving. Five of those are something you might plausibly do
 * while a note sits half-typed, and every one of them replaced it with the
 * older copy from disk — silently, and with nothing to undo it with.
 */
describe('the writing notes', () => {
  let stored;

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    document.documentElement.innerHTML = fs.readFileSync('web/index.html', 'utf8');
    location.hash = '';
    const fixture = makeTempStore();
    const data = fixture.store.load();
    fixture.cleanup();

    stored = 'Never say "synergy".';

    vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
      const body = options.body ? JSON.parse(options.body) : null;
      let result = {};
      if (url === '/api/store') result = data;
      else if (url === '/api/ai/jobs') result = { jobs: [] };
      else if (url === '/api/render') result = { pages: 1, fits: true, adjustments: [], pdfUrl: '/pdf/x.pdf' };
      else if (url === '/api/voice' && options.method === 'PUT') {
        stored = body.voice;
        result = { ok: true };
      } else if (url === '/api/voice') {
        result = { voice: stored, preview: stored, context: { chars: 0, available: 1000, used: [] }, samples: [] };
      } else if (url === '/api/ai/presets') result = { presets: [] };
      else if (url === '/api/config') {
        result = {
          ai: { enabled: false, research: false, command: 'claude', args: [], timeoutMs: 1000 },
          latex: { engine: '' },
          git: { autoCommit: false },
          output: { dir: 'out', fileNames: 'type' },
          overrides: {},
        };
      }
      return { ok: true, json: async () => structuredClone(result) };
    }));

    await import('../web/app.js');
    await vi.waitFor(() => expect(document.querySelector('#resume-select')).not.toBeNull());
    for (const b of document.querySelectorAll('#tabs button')) b.disabled = false;
    await openVoice();
    await vi.waitFor(() => expect(document.querySelector('#voice').value).toBe('Never say "synergy".'));
  });

  const openVoice = async () => {
    document.querySelector('button[data-tab="voice"]').click();
    await vi.advanceTimersByTimeAsync(20);
  };
  const notes = () => document.querySelector('#voice');
  const type = async (text) => {
    notes().value = text;
    notes().dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(10);
  };

  it('keeps what you are still typing when the panel is reloaded around it', async () => {
    await type('Never say "synergy". Never say "passionate" either.');

    // Anything that reloads the panel. Leaving the tab and coming back is the
    // cheapest to drive, and adding a sample takes exactly the same path.
    document.querySelector('button[data-tab="resumes"]').click();
    await openVoice();
    await vi.advanceTimersByTimeAsync(50);

    expect(notes().value).toBe('Never say "synergy". Never say "passionate" either.');
  });

  it('says so, rather than only keeping it', async () => {
    expect(document.querySelector('#voice-unsaved').hidden).toBe(true);
    await type('Something new.');
    expect(document.querySelector('#voice-unsaved').hidden).toBe(false);
  });

  it('stops saying so once it has been saved', async () => {
    await type('Something new.');
    document.querySelector('#btn-save-voice').click();
    await vi.waitFor(() => expect(stored).toBe('Something new.'));
    await vi.advanceTimersByTimeAsync(50);

    expect(document.querySelector('#voice-unsaved').hidden).toBe(true);
    expect(notes().value).toBe('Something new.');
  });

  /*
   * The other half of not clobbering: a box nobody has touched must still
   * pick up what the store says, or a note saved in another window would
   * never appear in this one.
   */
  it('still refreshes a box you have not touched', async () => {
    stored = 'Edited somewhere else.';
    document.querySelector('button[data-tab="resumes"]').click();
    await openVoice();
    await vi.waitFor(() => expect(notes().value).toBe('Edited somewhere else.'));
  });
});
