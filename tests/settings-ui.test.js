// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { makeTempStore } from './helpers.ts';
import { AI_PRESETS } from '../src/ai/presets.ts';

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
      else if (url === '/api/ai/presets') result = { presets: AI_PRESETS };
      else if (url === '/api/config/test-ai') result = { ok: true, command: config.ai.command, ms: 1200, output: 'ok' };
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

  /*
   * And once saved, the field must go back to following the store. Keeping
   * "it differs from what was last loaded" as the test forever would mean a
   * field stayed pinned to its own value after being saved, and a change made
   * in another window never arrived here again.
   */
  it('follows the store again once the command has been saved', async () => {
    const command = commandBox();
    command.value = 'my-own-cli';
    command.dispatchEvent(new Event('input'));
    document.querySelector('#settings button.primary').click();
    await vi.waitFor(() => expect(config.ai.command).toBe('my-own-cli'));

    config.ai = { ...config.ai, command: 'changed-elsewhere' };
    document.querySelector('button[data-tab="resumes"]').click();
    document.querySelector('button[data-tab="voice"]').click();
    await vi.waitFor(() => expect(commandBox().value).toBe('changed-elsewhere'));
  });

  it('puts the switch back where it was when the save is refused', async () => {
    const research = checkboxes()[1];
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({ error: 'read-only save' }) })));

    research.checked = true;
    research.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(research.checked).toBe(false));
  });
  /*
   * "I did pick a preset, it still failed like this."
   *
   * Picking one only filled two boxes. The Save button below them was a
   * separate, unmarked step, so the most deliberate act on the panel —
   * choosing from a list of known-good configurations — did nothing at all
   * until you found it, and the next AI run failed naming the old command.
   */
  it('saves a preset the moment it is picked, and tries it', async () => {
    const select = [...document.querySelectorAll('#settings select')][0];
    const claude = AI_PRESETS.find((p) => p.command === 'claude');
    select.value = claude.label;
    select.dispatchEvent(new Event('change'));

    await vi.waitFor(() => expect(config.ai.args).toEqual(claude.args));
    expect(config.ai.command).toBe('claude');
    await vi.waitFor(() => expect(document.querySelector('#settings .result.ok')).not.toBeNull());
  });

  /* And a command typed by hand still waits — but now says that it is waiting. */
  it('says when what is on screen is not what will run', async () => {
    const flag = () =>
      [...document.querySelectorAll('#settings .hint.warn')].find((n) => n.textContent === 'Not saved yet.');
    expect(flag()?.hidden ?? true).toBe(true);

    const command = commandBox();
    command.value = 'my-own-cli';
    command.dispatchEvent(new Event('input'));
    expect(flag().hidden).toBe(false);

    document.querySelector('#settings button.primary').click();
    await vi.waitFor(() => expect(config.ai.command).toBe('my-own-cli'));
    await vi.waitFor(() => expect(flag().hidden).toBe(true));
  });

  /*
   * A preset is copied when it is chosen, never referenced, so a config saved
   * before a preset was corrected keeps the old arguments for good. The
   * picker only ever matched exactly, called that "Custom…", and said nothing
   * — which is indistinguishable from having picked the preset.
   */
  it('points out a preset whose arguments have drifted, and mends it', async () => {
    // The fixture's config is claude with the old `-p {promptText}` arguments.
    const warning = [...document.querySelectorAll('#settings .hint.warn')].find((n) =>
      n.textContent.includes('not the "Claude Code" preset'),
    );
    expect(warning).toBeTruthy();

    warning.querySelector('button.link').click();
    const claude = AI_PRESETS.find((p) => p.command === 'claude');
    await vi.waitFor(() => expect(config.ai.args).toEqual(claude.args));
  });

  it('says nothing about drift when the settings are exactly a preset', async () => {
    const claude = AI_PRESETS.find((p) => p.command === 'claude');
    config.ai = { ...config.ai, args: [...claude.args] };
    document.querySelector('button[data-tab="resumes"]').click();
    document.querySelector('button[data-tab="voice"]').click();
    await vi.waitFor(() =>
      expect(document.querySelector('#settings').textContent).not.toContain('not the "Claude Code" preset'),
    );
  });
});
