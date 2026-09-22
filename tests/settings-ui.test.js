// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { makeTempStore } from './helpers.ts';
import { AI_PRESETS, AI_TASKS } from '../src/ai/presets.ts';

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
  /** Set by the test that wants a command that runs and refuses. */
  let aiRefuses;
  let liveModels;

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    aiRefuses = false;
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
    liveModels = {
      claude: ['opus', 'sonnet', 'haiku'],
      gemini: ['gemini-2.5-pro', 'gemini-2.5-flash'],
    };

    vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
      const body = options.body ? JSON.parse(options.body) : null;
      let result = {};
      if (url === '/api/store') result = data;
      else if (url === '/api/ai/jobs') result = { jobs: [] };
      else if (url === '/api/render') result = { pages: 1, fits: true, adjustments: [], pdfUrl: '/pdf/x.pdf' };
      else if (url === '/api/voice') result = { voice: '' };
      else if (url === '/api/ai/presets') result = { presets: AI_PRESETS, tasks: AI_TASKS };
      else if (url.startsWith('/api/ai/models?')) {
        const command = new URL(url, 'http://local').searchParams.get('command');
        result = { models: liveModels[command] ?? [], from: 'cli' };
      }
      // A working AI, which is one that answers the question the test asks:
      // the prompt is "reply with exactly the word: ready".
      else if (url === '/api/config/test-ai') {
        result = aiRefuses
          ? { ok: true, saidReady: false, command: config.ai.command, ms: 1200, output: 'I cannot do that: this action requires approval.' }
          : { ok: true, saidReady: true, command: config.ai.command, ms: 1200, output: 'ready' };
      }
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
  /*
   * "Let it look up the company online" is drawn whichever CLI is
   * configured, and it only writes a tool list for one of them. For the
   * others it was promising in both directions over a command line it had
   * not touched — and the direction people would believe is the one it could
   * not keep: "off: it works only from the posting and what you have
   * written". Somebody deciding not to let a model read about their employer
   * should not be told they have decided it when they have not.
   */
  describe('the switch that only reaches one of the CLIs', () => {
    const note = () =>
      [...document.querySelectorAll('#settings .hint')].map((n) => n.textContent).join(' | ');

    it('makes its promise for the CLI whose tool list it writes', () => {
      expect(note()).toMatch(/works only from the posting/i);
      expect(note()).not.toMatch(/does not reach/i);
    });

    it('says whose setting it is for one it does not reach', async () => {
      config.overrides = { research: true };
      config.ai = { ...config.ai, command: 'codex' };
      // Reopening the panel is what a save change or a preset change does.
      document.querySelector('button[data-tab="resumes"]').click();
      document.querySelector('button[data-tab="voice"]').click();
      await vi.waitFor(() => expect(note()).toMatch(/does not reach/i));

      expect(note()).toMatch(/codex/);
      expect(note()).toMatch(/its own setting/i);
      // And never the promise it cannot keep.
      expect(note()).not.toMatch(/works only from the posting/i);
    });
  });

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
  /*
   * The two controls on this panel that wait for Save without any typing in
   * them. They were rebuilt fresh every time the Voice tab was opened, so a
   * glance at another tab put the slider back where the store had it — and
   * took the "Not saved yet." warning with it, since the warning is computed
   * from the control that no longer held the change. Nothing on screen said
   * anything had happened.
   */
  it('keeps an effort you have slid but not saved, across a tab switch', async () => {
    const slider = document.querySelector('.effort-slider');
    slider.value = '3';
    slider.dispatchEvent(new Event('input'));
    expect(document.querySelector('#settings').textContent).toContain('Not saved yet.');

    document.querySelector('button[data-tab="resumes"]').click();
    document.querySelector('button[data-tab="voice"]').click();
    await vi.advanceTimersByTimeAsync(60);

    expect(document.querySelector('.effort-slider').value).toBe('3');
    // And still says so, which is the half that makes it recoverable.
    expect(document.querySelector('#settings').textContent).toContain('Not saved yet.');
    // The scale reads the restored value, not the one on disk.
    expect(document.querySelector('.effort-scale .on').textContent).toBe('Thorough');
  });

  it('keeps a LaTeX engine you have chosen but not saved', async () => {
    const engineOf = () => [...document.querySelectorAll('#settings select')].find((s) => s.querySelector('option[value=pdflatex]'));
    const engine = engineOf();
    engine.value = 'pdflatex';
    engine.dispatchEvent(new Event('change'));

    document.querySelector('button[data-tab="resumes"]').click();
    document.querySelector('button[data-tab="voice"]').click();
    await vi.advanceTimersByTimeAsync(60);

    expect(engineOf().value).toBe('pdflatex');
  });

  // The other half, as for the text boxes: an untouched control must still
  // follow the store, or a change made in another window never arrives.
  it('still refreshes an effort and an engine you have not touched', async () => {
    config.ai = { ...config.ai, effort: 'low' };
    config.latex = { engine: 'tectonic' };

    document.querySelector('button[data-tab="resumes"]').click();
    document.querySelector('button[data-tab="voice"]').click();
    await vi.waitFor(() => expect(document.querySelector('.effort-slider').value).toBe('1'));
    expect([...document.querySelectorAll('#settings select')].find((s) => s.querySelector('option[value=pdflatex]')).value).toBe('tectonic');
  });

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
  /*
   * A command that runs, exits cleanly, and refuses.
   *
   * That is what a permission-blocked agent looks like from here: the
   * command was found, it ran, it printed something. The panel painted that
   * green and told somebody their AI was configured, over the sentence
   * saying it is not — which is the one thing this panel exists to get
   * right.
   *
   * Still not red: the command really did run, and calling a setup broken
   * when it is only unusual is its own kind of wrong. What changes is that
   * the green stops claiming more than the reply supports.
   */
  it('does not call it working when the reply was a refusal', async () => {
    aiRefuses = true;
    const select = [...document.querySelectorAll('#settings select')][0];
    const claude = AI_PRESETS.find((p) => p.command === 'claude');
    select.value = claude.label;
    select.dispatchEvent(new Event('change'));

    await vi.waitFor(() => expect(document.querySelector('#settings .result.warn')).not.toBeNull());
    expect(document.querySelector('#settings .result.ok')).toBeNull();
    const said = document.querySelector('#settings .result').textContent;
    // What it actually said is still there, because that is the thing to read.
    expect(said).toMatch(/requires approval/);
    expect(said).toMatch(/not the word it was asked for/i);
  });

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

    /*
     * The button has to say what it does on its own. It read "Use the
     * preset’s", with the noun in the next node, so the whole instruction
     * came out as "Use the preset’s — that saves and tests it." on the only
     * warning that explains why the AI command will not run.
     */
    const mend = warning.querySelector('button.link');
    expect(mend.textContent).toContain('Claude Code');
    expect(mend.textContent).toMatch(/arguments/i);
    expect(mend.textContent.trim()).not.toMatch(/[’']s$/);

    mend.click();
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
  /*
   * Changing which model tailors a resume used to mean hand-editing the
   * argument line — which turns a preset into a custom configuration that
   * then drifts out of date with the preset it came from, the exact failure
   * behind "I picked a preset and it still ran the old command". It is a
   * setting now, applied to the arguments on the server.
   */
  const boxFor = (label) =>
    [...document.querySelectorAll('#settings label.f')]
      .find((f) => f.querySelector('.lbl').textContent === label)
      ?.querySelector('input, select');

  /** The model buttons, which are the chosen CLI's own names for its models. */
  const modelChips = () => [...document.querySelectorAll('#settings .model-chips button')];
  const chip = (label) => modelChips().find((b) => b.textContent === label);
  const effortSlider = () => document.querySelector('#settings .effort-slider');
  const slideTo = (i) => {
    const s = effortSlider();
    s.value = String(i);
    s.dispatchEvent(new Event('input'));
  };

  /*
   * Typing "opus" into a box is asking somebody to remember a name; four
   * buttons is reading. The box stays behind "Another…", because these CLIs
   * gain models faster than the list in this repository can be edited.
   */
  it('saves a model chosen from the buttons, without touching the preset’s arguments', async () => {
    expect(modelChips().map((b) => b.textContent)).toEqual(['Default', 'opus', 'sonnet', 'haiku', 'Another…']);
    expect(chip('Default').className).toContain('on');

    chip('opus').click();
    expect(chip('opus').className).toContain('on');
    document.querySelector('#settings button.primary').click();

    await vi.waitFor(() => expect(config.ai.model).toBe('opus'));
    // The arguments are still the ones that were there; the flag is the
    // server's business, not a hand edit to this box.
    expect(config.ai.args).toEqual(['-p', '{promptText}']);
  });

  it('still takes a model name that is not on the list', async () => {
    const box = () => document.querySelector('#settings .model-other');
    expect(box().hidden).toBe(true);

    chip('Another…').click();
    expect(box().hidden).toBe(false);

    const input = box().querySelector('input');
    input.value = 'some-model-9';
    input.dispatchEvent(new Event('input'));
    document.querySelector('#settings button.primary').click();
    await vi.waitFor(() => expect(config.ai.model).toBe('some-model-9'));
    // And it is the one that reads as chosen, since none of the buttons is.
    expect(chip('Another…').getAttribute('aria-pressed')).toBe('true');
    expect(chip('Default').getAttribute('aria-pressed')).toBe('false');
  });

  /*
   * Effort is one axis with four stops on it. A dropdown hides that: you have
   * to open it before you can see the choices are even ordered.
   */
  it('saves an effort level from the slider, and says it in words', async () => {
    expect([...document.querySelectorAll('#settings .effort-scale span')].map((n) => n.textContent)).toEqual([
      'As it comes',
      'Quick',
      'Normal',
      'Thorough',
    ]);
    // The scale is the readout: the stop you are on is the one marked. A
    // separate line above the slider said the same words as the left-hand end
    // of the scale below it.
    const marked = () =>
      [...document.querySelectorAll('#settings .effort-scale span.on')].map((n) => n.textContent);
    expect(marked()).toEqual(['As it comes']);

    slideTo(3);
    expect(marked()).toEqual(['Thorough']);
    expect(effortSlider().getAttribute('aria-valuetext')).toBe('Thorough');

    document.querySelector('#settings button.primary').click();
    await vi.waitFor(() => expect(config.ai.effort).toBe('high'));
  });

  /*
   * Only Codex has a reasoning-effort flag. Saying "Thorough" and having it
   * silently mean nothing would be the worst version of this.
   */
  it('says which mechanism each setting will actually use', async () => {
    const text = () => document.querySelector('#settings').textContent;
    // The fixture is claude.
    expect(text()).toContain('has no effort switch');
    expect(text()).toContain('Passed as --model');

    /*
     * And says it under the field it is about. Both sentences were one line
     * below Effort, so "Passed as --model" sat two fields from the box it
     * describes and read as though the effort were what got passed.
     */
    const hints = [...document.querySelectorAll('#settings .hint')].map((n) => n.textContent);
    expect(hints.some((h) => h.includes('--model') && !/effort/i.test(h))).toBe(true);
    expect(hints.some((h) => /effort switch/i.test(h) && !h.includes('--model'))).toBe(true);

    const command = commandBox();
    command.value = 'codex';
    command.dispatchEvent(new Event('input'));
    await vi.waitFor(() => expect(text()).toContain('Passed as -c'));

    command.value = 'my-own-cli';
    command.dispatchEvent(new Event('input'));
    await vi.waitFor(() => expect(text()).toContain('is not one of the presets'));
  });

  /*
   * A command that is not a preset has nothing to build a model menu out of —
   * the names come from the preset — and nothing to attach either setting to.
   * Showing the pair greyed out, or full of another CLI's model names, would
   * be offering a choice that does nothing.
   */
  it('takes the model and the effort away when the command is not a preset', async () => {
    const block = () => effortSlider().closest('div');
    const command = commandBox();
    command.value = 'my-own-cli';
    command.dispatchEvent(new Event('input'));

    await vi.waitFor(() => expect(block().hidden).toBe(true));
    expect(document.querySelector('#settings').textContent).toContain('is not one of the presets');
    // And the heading over it stops promising what is no longer inside.
    expect(advancedBlock().querySelector('summary').textContent).toBe('Advanced — the exact command');

    command.value = 'claude';
    command.dispatchEvent(new Event('input'));
    await vi.waitFor(() => expect(block().hidden).toBe(false));
    expect(advancedBlock().querySelector('summary').textContent).toContain('the model and the effort');
  });

  it('follows the command: the buttons are whichever CLI is configured', async () => {
    expect(modelChips().map((b) => b.textContent)).toContain('opus');

    const command = commandBox();
    command.value = 'gemini';
    command.dispatchEvent(new Event('input'));
    await vi.waitFor(() => expect(modelChips().map((b) => b.textContent)).toContain('gemini-2.5-pro'));
    expect(modelChips().map((b) => b.textContent)).not.toContain('opus');

  });

  it('counts the model and the effort as unsaved changes like everything else', async () => {
    const flag = () =>
      [...document.querySelectorAll('#settings .hint.warn')].find((n) => n.textContent === 'Not saved yet.');
    expect(flag().hidden).toBe(true);

    slideTo(1);
    expect(flag().hidden).toBe(false);
  });
  /*
   * The panel led with a command line and an argument template full of
   * {promptText} placeholders, which made choosing a preset look like
   * something you had to understand the machinery to do.
   */
  const advancedBlock = () =>
    [...document.querySelectorAll('#settings details.advanced')].find((d) =>
      d.querySelector('summary').textContent.includes('exact command'),
    );

  it('keeps the command line behind a disclosure', () => {
    const box = advancedBlock();
    expect(box).toBeTruthy();
    expect(box.contains(commandBox())).toBe(true);
    // The fixture's config is claude with drifted arguments, so it is not a
    // preset and the block opens by itself — see the next test for why.
    expect(box.open).toBe(true);
  });

  it('but opens it when what is saved is not a preset, which is when it matters', async () => {
    const claude = AI_PRESETS.find((p) => p.command === 'claude');
    config.ai = { ...config.ai, args: [...claude.args] };
    document.querySelector('button[data-tab="resumes"]').click();
    document.querySelector('button[data-tab="voice"]').click();
    // Exactly a preset now: the machinery folds away.
    await vi.waitFor(() => expect(advancedBlock()?.open).toBe(false));
    expect(advancedBlock().contains(commandBox())).toBe(true);
  });

  /*
   * The preset is the whole of what most people need. The model and the
   * effort are facts about the command it chose — which names are even on
   * offer depends on which CLI it is — so they live with it.
   */
  it('keeps the preset in plain sight and the command’s own settings with the command', () => {
    const outside = (label) => {
      const f = [...document.querySelectorAll('#settings label.f')].find(
        (n) => n.querySelector('.lbl').textContent === label,
      );
      return f && !f.closest('details.advanced');
    };
    expect(outside('Preset')).toBe(true);
    expect(outside('LaTeX engine')).toBe(true);
    expect(outside('Command')).toBe(false);
    expect(outside('Timeout, seconds')).toBe(false);

    const box = advancedBlock();
    expect(box.contains(document.querySelector('#settings .model-chips'))).toBe(true);
    expect(box.contains(effortSlider())).toBe(true);
  });
  /*
   * "terra for resume review, astra for cover letter drafting, luna for
   * tailoring resumes" — one model for all of it is the wrong shape, and
   * hand-editing the argument line per task is not a way to express it.
   */
  const taskBlock = () =>
    [...document.querySelectorAll('#settings details.advanced')].find((d) =>
      d.querySelector('summary').textContent.includes('particular kind of work'),
    );
  /** The radio for one kind of work and one column of the grid. */
  const gridCell = (row, column) =>
    [...taskBlock().querySelectorAll('tbody tr')]
      .find((tr) => tr.querySelector('th.what')?.textContent === row)
      ?.querySelector(`input[value="${column}"]`);

  /*
   * It was four text boxes, each asking for a model name from memory, and no
   * way to see at a glance that three of them said the same thing. As a grid
   * it is one look: every row has one mark, and the column it is in is the
   * answer.
   */
  it('lays the kinds of work against the models, behind a disclosure', async () => {
    const box = taskBlock();
    expect(box).toBeTruthy();
    // Folded away: almost nobody needs it, and putting it at the top would
    // make choosing a preset look like a configuration exercise.
    expect(box.open).toBe(false);

    const columns = [...box.querySelectorAll('thead th')].map((n) => n.textContent);
    expect(columns).toEqual(['For', 'Same as above', 'opus', 'sonnet', 'haiku', 'Another…']);

    const rows = [...box.querySelectorAll('tbody th.what')].map((n) => n.textContent);
    expect(rows).toEqual([
      'Tailoring a resume',
      'Writing letters and answers',
      'Reviewing what you wrote',
      'Drafting new entries and wordings',
    ]);

    // Exactly one mark per row, and to begin with it is "same as above" —
    // which is what an empty per-task model does.
    for (const tr of box.querySelectorAll('tbody tr:not(.other-row)')) {
      expect([...tr.querySelectorAll('input:checked')]).toHaveLength(1);
    }
    for (const row of rows) expect(gridCell(row, '').checked).toBe(true);
  });

  it('repaints every task from the live CLI answer, not a preset guess', async () => {
    liveModels.claude = ['brand-new-fast', 'brand-new-deep'];
    document.querySelector('button[data-tab="resumes"]').click();
    document.querySelector('button[data-tab="voice"]').click();

    await vi.waitFor(() => expect(chip('brand-new-deep')).toBeTruthy());
    expect([...taskBlock().querySelectorAll('thead th')].map((n) => n.textContent)).toEqual([
      'For',
      'Same as above',
      'brand-new-fast',
      'brand-new-deep',
      'Another…',
    ]);
    expect(gridCell('Tailoring a resume', 'brand-new-fast')).toBeTruthy();
  });

  it('saves the one it is given, and leaves the rest alone', async () => {
    gridCell('Writing letters and answers', 'sonnet').click();
    document.querySelector('#settings button.primary').click();

    await vi.waitFor(() => expect(config.ai.models.write).toBe('sonnet'));
    expect(config.ai.models.tailor).toBe('');
    expect(config.ai.models.review).toBe('');
    // And the row shows it, while the others still say "same as above".
    expect(gridCell('Writing letters and answers', 'sonnet').checked).toBe(true);
    expect(gridCell('Tailoring a resume', '').checked).toBe(true);
  });

  it('still takes a model name that is not on the grid', async () => {
    const otherRow = () =>
      gridCell('Reviewing what you wrote', 'other').closest('tr').nextElementSibling;
    expect(otherRow().hidden).toBe(true);

    gridCell('Reviewing what you wrote', 'other').click();
    expect(otherRow().hidden).toBe(false);

    const box = otherRow().querySelector('input');
    box.value = 'terra';
    box.dispatchEvent(new Event('input'));
    document.querySelector('#settings button.primary').click();
    await vi.waitFor(() => expect(config.ai.models.review).toBe('terra'));
  });

  it('counts a per-task model as an unsaved change like everything else', () => {
    const flag = () =>
      [...document.querySelectorAll('#settings .hint.warn')].find((n) => n.textContent === 'Not saved yet.');
    expect(flag().hidden).toBe(true);

    gridCell('Tailoring a resume', 'opus').click();
    expect(flag().hidden).toBe(false);
  });
});
