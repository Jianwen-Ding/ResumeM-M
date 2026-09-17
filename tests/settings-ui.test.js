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
 * The AI command, its arguments and its timeout are deliberately not saved
 * until Save is pressed: a half-typed command is not a command, and running it
 * on every keystroke would be worse than useless. Everything else on the panel
 * has to respect that — a control that saves itself must not take the typing
 * next to it down with it.
 */
describe('the settings panel', () => {
  let config;

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    document.documentElement.innerHTML = fs.readFileSync('web/index.html', 'utf8');
    location.hash = '';
    const fixture = makeTempStore();
    const data = fixture.store.load();
    fixture.cleanup();

    config = {
      ai: { enabled: false, research: false, command: 'claude', args: ['-p', '{promptText}'], timeoutMs: 180_000 },
      latex: { engine: '' },
      git: { autoCommit: false },
      output: { dir: 'out', fileNames: 'type' },
      overrides: {},
    };

    vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
      const body = options.body ? JSON.parse(options.body) : null;
      let result = {};
      if (url === '/api/store') result = data;
      else if (url === '/api/ai/jobs') result = { jobs: [] };
      else if (url === '/api/render') result = { pages: 1, fits: true, adjustments: [], pdfUrl: '/pdf/x.pdf' };
      else if (url === '/api/voice') result = { voice: '' };
      else if (url === '/api/ai/presets') result = { presets: [] };
      else if (url === '/api/config' && options.method === 'PUT') {
        config = { ...config, ...body, ai: { ...config.ai, ...(body.ai ?? {}) } };
        result = config;
      } else if (url === '/api/config') result = config;
      return { ok: true, json: async () => structuredClone(result) };
    }));

    await import('../web/app.js');
    await vi.waitFor(() => expect(document.querySelector('#resume-select')).not.toBeNull());
    for (const b of document.querySelectorAll('#tabs button')) b.disabled = false;
    document.querySelector('button[data-tab="voice"]').click();
    await vi.waitFor(() => expect(document.querySelector('#settings input[type=checkbox]')).not.toBeNull());
  });

  const checkboxes = () => [...document.querySelectorAll('#settings input[type=checkbox]')];
  const commandBox = () =>
    [...document.querySelectorAll('#settings label.f')]
      .find((f) => f.querySelector('.lbl').textContent === 'Command')
      .querySelector('input');

  /*
   * The bug: flipping the research switch saved itself and then reloaded the
   * whole panel to update the paragraph underneath it, rebuilding every field
   * from the server. A command typed but not yet saved was simply replaced by
   * the old one, mid-sentence, with nothing to say it had happened.
   */
  it('keeps a command you are still typing when the research switch is flipped', async () => {
    const command = commandBox();
    command.value = 'my-own-cli --with-a-flag';

    const research = checkboxes()[1];
    research.checked = true;
    research.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(config.ai.research).toBe(true));
    await vi.advanceTimersByTimeAsync(50);

    expect(commandBox().value).toBe('my-own-cli --with-a-flag');
  });

  /*
   * And across a tab switch, which is the one that actually bit. The panel is
   * rebuilt from the server every time the Voice tab is opened, so looking at
   * another tab and coming back was enough to delete a command that had been
   * typed but — as is normal for a field with a Save button — not yet saved.
   */
  it('keeps a command you are still typing across a tab switch', async () => {
    const command = commandBox();
    command.value = 'my-own-cli --with-a-flag';
    command.dispatchEvent(new Event('input'));

    document.querySelector('button[data-tab="resumes"]').click();
    document.querySelector('button[data-tab="voice"]').click();
    await vi.advanceTimersByTimeAsync(60);

    expect(commandBox().value).toBe('my-own-cli --with-a-flag');
  });

  // The other half: a field nobody has touched must still show what the store
  // says, or a change made in another window would never arrive in this one.
  it('still refreshes a command you have not touched', async () => {
    config.ai = { ...config.ai, command: 'changed-elsewhere' };

    document.querySelector('button[data-tab="resumes"]').click();
    document.querySelector('button[data-tab="voice"]').click();
    await vi.waitFor(() => expect(commandBox().value).toBe('changed-elsewhere'));
  });

  it('still explains what the switch now means', async () => {
    const research = checkboxes()[1];
    expect(document.querySelector('#settings').textContent).toContain('works only from the posting');

    research.checked = true;
    research.dispatchEvent(new Event('change'));
    await vi.waitFor(() =>
      expect(document.querySelector('#settings').textContent).toContain('read about the company before writing'),
    );
  });

  it('puts the switch back where it was when the save is refused', async () => {
    const research = checkboxes()[1];
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({ error: 'read-only save' }) })));

    research.checked = true;
    research.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(research.checked).toBe(false));
  });
});
