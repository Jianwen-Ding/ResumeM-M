import { beforeEach, describe, expect, it } from 'vitest';
import {
  captureModelPicker,
  forgetModels,
  listModels,
  modelsInPicker,
  plainTerminal,
  type ModelProbe,
} from '../src/ai/models.js';
import { AI_PRESETS } from '../src/ai/presets.js';

const CLAUDE_PICKER = `
you: /model
Select model
1. Default (recommended) — Use the default model (currently Opus 5)
2. (selected) Opus (1M context) — Best for everyday, complex tasks
3. Sonnet — Efficient for routine tasks
4. Haiku — Fastest for quick answers
5. (disabled) Fable (disabled) — currently unavailable
Select with numbers [1-5].
`;

describe('reading model choices from interactive CLI pickers', () => {
  it('reads Claude aliases and ignores the default and unavailable choices', () => {
    expect(modelsInPicker(CLAUDE_PICKER, 'claude')).toEqual(['opus', 'sonnet', 'haiku']);
  });

  it('reads exact Codex identifiers without inventing a release list', () => {
    const screen = `
model: gpt-old-startup-value
Select Model and Effort
› 1. gpt-6-astra       Most capable
  2. gpt-5.6-sol       Reliable coding agent
  3. gpt-5.6-terra     Balanced
Press enter to confirm or esc to go back
`;
    expect(modelsInPicker(screen, 'codex')).toEqual(['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra']);
  });

  it('reads the manual Gemini list and not prose about other providers', () => {
    const screen = `
Select a model
Auto may route between gemini-3-pro-preview and gemini-3-flash-preview.
Manual
  gemini-2.5-pro
  gemini-2.5-flash
The docs also mention claude-fable-5.
`;
    expect(modelsInPicker(screen, 'gemini')).toEqual([
      'gemini-3-pro-preview',
      'gemini-3-flash-preview',
      'gemini-2.5-pro',
      'gemini-2.5-flash',
    ]);
  });

  it('deduplicates redraws from a terminal UI', () => {
    expect(modelsInPicker('gpt-5.6-sol\r\n\x1b[2Jgpt-5.6-sol\r\ngpt-6-astra', 'codex'))
      .toEqual(['gpt-5.6-sol', 'gpt-6-astra']);
  });

  it('strips terminal title and cursor sequences without losing their text', () => {
    expect(plainTerminal('\x1b]0;Title\x07\x1b[2Jchoice')).toContain('choice');
    expect(plainTerminal('\x1b]0;Title\x07\x1b[2Jchoice')).not.toContain('Title');
  });
});

describe('asking the configured command', () => {
  beforeEach(() => forgetModels());

  const answer = (output: string, calls?: { count: number }): ModelProbe =>
    async (_command, picker, cwd) => {
      if (calls) calls.count++;
      expect(cwd).toBe('/a/save');
      expect(picker.mode).not.toBe('command');
      if (picker.mode !== 'command') expect(picker.query).toBe('/model');
      return output;
    };

  it('uses the preset-specific interactive command and returns what it showed', async () => {
    const found = await listModels('claude', '/a/save', answer(CLAUDE_PICKER));
    expect(found).toEqual({ models: ['opus', 'sonnet', 'haiku'], from: 'cli' });
  });

  it('declares the right live model request for every supported CLI', () => {
    expect(AI_PRESETS.map((preset) => [
      preset.command,
      preset.model?.picker.mode === 'command'
        ? preset.model.picker.args.join(' ')
        : preset.model?.picker.query,
    ])).toEqual([
      ['claude', '/model'],
      ['codex', '/model'],
      ['gemini', '/model'],
      ['agy', 'models'],
    ]);
  });

  it('reads exact Antigravity model IDs from its account-aware listing', () => {
    const screen = `
gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)
claude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)
gpt-oss-120b-medium\tGPT-OSS 120B (Medium)
`;
    expect(modelsInPicker(screen, 'agy')).toEqual([
      'gemini-3.8-flash-medium',
      'claude-opus-4-6-thinking',
      'gpt-oss-120b-medium',
    ]);
  });

  it('does not replace a failed picker with guessed presets', async () => {
    const found = await listModels('claude', '/a/save', async () => {
      throw Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' });
    });
    expect(found.models).toEqual([]);
    expect(found.from).toBe('unavailable');
    expect(found.message).toMatch(/not installed|PATH/i);
  });

  it('says when the CLI opened but did not show choices', async () => {
    const found = await listModels('claude', '/a/save', answer('Please run /login'));
    expect(found.models).toEqual([]);
    expect(found.from).toBe('unavailable');
    expect(found.message).toMatch(/sign in/i);
  });

  it('does not execute a command that is not one of the known CLI presets', async () => {
    let called = false;
    const found = await listModels('not-a-real-cli', '/a/save', async () => {
      called = true;
      return 'gpt-should-not-run';
    });
    expect(called).toBe(false);
    expect(found.from).toBe('unavailable');
  });

  it('answers for a path to a particular installed build', async () => {
    const found = await listModels('/opt/homebrew/bin/claude', '/a/save', answer(CLAUDE_PICKER));
    expect(found.from).toBe('cli');
  });

  it('asks once and remembers the answer', async () => {
    const calls = { count: 0 };
    const probe = answer(CLAUDE_PICKER, calls);
    await listModels('claude', '/a/save', probe);
    await listModels('claude', '/a/save', probe);
    await listModels('claude', '/a/save', probe);
    expect(calls.count).toBe(1);
  });

  it('asks again after being told to forget', async () => {
    const calls = { count: 0 };
    const probe = answer(CLAUDE_PICKER, calls);
    await listModels('claude', '/a/save', probe);
    forgetModels();
    await listModels('claude', '/a/save', probe);
    expect(calls.count).toBe(2);
  });
});

describe.skipIf(process.platform === 'win32')('the pseudo-terminal bridge', () => {
  it('actually types the picker command into an interactive process', async () => {
    const fakeCli = [
      "process.stdin.setEncoding('utf8')",
      "process.stdin.on('data', value => {",
      "  if (!value.includes('/model')) return",
      "  console.log('1. gpt-live-from-picker')",
      "  process.exit(0)",
      "})",
    ].join(';');
    const output = await captureModelPicker(
      process.execPath,
      { mode: 'terminal', query: '/model', args: ['-e', fakeCli], parser: 'codex' },
      process.cwd(),
    );
    expect(modelsInPicker(output, 'codex')).toEqual(['gpt-live-from-picker']);
  }, 8_000);
});
