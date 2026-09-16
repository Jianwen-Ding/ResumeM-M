import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runAgent } from '../src/ai/agent.js';
import { AI_PRESETS, applyResearch, matchPreset, repairAiArgs } from '../src/ai/presets.js';
import { DEFAULT_CONFIG, type StoreConfig } from '../src/model/types.js';

/**
 * The supported CLIs, checked against stand-ins.
 *
 * The real `claude`, `codex` and `gemini` are not installable in a test, and
 * "does the model give a good answer" is not a thing a test can assert anyway.
 * What can be checked is the part that actually breaks: whether each preset
 * hands its CLI the prompt in the form that CLI expects, in the place it
 * expects it, with stdin closed and nothing outside the scratch directory in
 * reach. Every bug reported about this so far has been exactly that — Codex
 * hanging on an open stdin, Codex refusing to start outside a git repository.
 *
 * Each stand-in below parses argv the way its real counterpart does, and fails
 * loudly if handed something it could not use.
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmm-stub-'));

/** Write a stand-in CLI and return the argv that runs it. */
function stub(name: string, body: string): { command: string; prefix: string[] } {
  const file = path.join(dir, `${name}.cjs`);
  fs.writeFileSync(file, body, 'utf8');
  return { command: process.execPath, prefix: [file] };
}

const config = (command: string, args: string[]): StoreConfig => ({
  ...DEFAULT_CONFIG,
  ai: { ...DEFAULT_CONFIG.ai, enabled: true, command, args, timeoutMs: 15_000 },
});

const PROMPT = 'Task: say something.\nThe prompt runs to several lines.\n';

/*
 * Claude Code: `-p <flags> <prompt-file>`. The prompt arrives as a path, so the
 * stand-in reads it, and asserts the sandbox was named and the dangerous tools
 * were disallowed.
 */
const CLAUDE = `
const argv = process.argv.slice(2);
if (!argv.includes('-p')) throw new Error('claude: expected -p');
const addDir = argv[argv.indexOf('--add-dir') + 1];

/*
 * --disallowedTools takes a list, so it consumes everything after it. The real
 * CLI rejected a prompt passed positionally here with 'Permission deny rule
 * "..." matches no known tool', then 'Input must be provided either through
 * stdin or as a prompt argument'. The stand-in does the same.
 */
const after = argv.slice(argv.indexOf('--disallowedTools') + 1);
const disallowed = after.join(' ');
if (after.length > 1) {
  process.stderr.write('Permission deny rule "' + after[1] + '" matches no known tool');
  process.exit(1);
}

let prompt = '';
process.stdin.on('data', (d) => { prompt += d; });
process.stdin.on('end', () => {
  if (!prompt) {
    process.stderr.write('Input must be provided either through stdin or as a prompt argument when using --print');
    process.exit(1);
  }
  process.stdout.write(JSON.stringify({ cli: 'claude', addDir, disallowed, cwd: process.cwd(), prompt }));
});
`;

/*
 * Codex: `exec [flags] <prompt>` with the prompt inline, and — this is the one
 * that bit us — it drains stdin before doing anything, and refuses to run
 * outside a git repository unless told not to check.
 */
const CODEX = `
const argv = process.argv.slice(2);
const fs = require('node:fs');
if (argv[0] !== 'exec') throw new Error('codex: expected exec');
if (!argv.includes('--skip-git-repo-check')) {
  const cd = argv[argv.indexOf('--cd') + 1] ?? process.cwd();
  if (!fs.existsSync(cd + '/.git')) {
    process.stderr.write('Not inside a trusted directory and --skip-git-repo-check was not specified');
    process.exit(1);
  }
}
const sandbox = argv[argv.indexOf('--sandbox') + 1];
const cd = argv[argv.indexOf('--cd') + 1];
const prompt = argv[argv.length - 1];
// Codex reads stdin even when the prompt came in on argv; if it is never
// closed this hangs until the caller's timeout.
let read = 0;
process.stdin.on('data', (d) => { read += d.length; });
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({ cli: 'codex', sandbox, cd, cwd: process.cwd(), prompt, read }));
});
`;

/** Gemini: `-p <prompt>`, inline, answer on stdout. */
const GEMINI = `
const argv = process.argv.slice(2);
const i = argv.indexOf('-p');
if (i < 0) throw new Error('gemini: expected -p');
process.stdout.write(JSON.stringify({ cli: 'gemini', cwd: process.cwd(), prompt: argv[i + 1] }));
`;

/** agy: print is a string flag, not a switch; stdin is not a text prompt. */
const AGY = `
const argv = process.argv.slice(2);
const print = argv.find(a => a.startsWith('--print='));
if (!print) throw new Error('agy: expected --print=<prompt>');
const prompt = print.slice('--print='.length);
if (!prompt) throw new Error('agy: empty prompt');
if (argv[argv.indexOf('--mode') + 1] !== 'plan') throw new Error('agy: expected plan mode');
if (!argv.includes('--sandbox')) throw new Error('agy: expected sandbox');
if (!argv.includes('--disable-slash-commands')) throw new Error('agy: expected literal prompt');
if (argv[argv.indexOf('--output-format') + 1] !== 'text') throw new Error('agy: expected text output');
process.stdout.write(JSON.stringify({ cli: 'agy', cwd: process.cwd(), prompt }));
`;

const STANDINS: Record<string, string> = {
  'Claude Code': CLAUDE, 'Codex CLI': CODEX, 'Gemini CLI': GEMINI, 'Antigravity (agy)': AGY,
};

describe('every preset hands its CLI a prompt it can actually use', () => {
  for (const preset of AI_PRESETS) {
    it(`${preset.label}`, { timeout: 30_000 }, async () => {
      const { command, prefix } = stub(preset.command, STANDINS[preset.label]!);
      const result = await runAgent(config(command, [...prefix, ...preset.args]), PROMPT);

      expect(result.executed).toBe(true);
      const seen = JSON.parse(result.output) as Record<string, string>;

      // However it was passed, the CLI ended up with the whole prompt.
      expect(seen.prompt).toContain('Task: say something.');
      expect(seen.prompt).toContain('runs to several lines');

      // And it ran in the scratch directory, not anywhere of ours.
      expect(seen.cwd).toMatch(/rmm-ai-/);
      expect(seen.cwd).not.toContain('ResumeM-M');
    });
  }

  it('gives Claude Code the prompt on stdin, and names the sandbox it may see', async () => {
    const preset = AI_PRESETS.find((p) => p.label === 'Claude Code')!;
    const { command, prefix } = stub('claude', CLAUDE);
    const result = await runAgent(config(command, [...prefix, ...preset.args]), PROMPT);
    const seen = JSON.parse(result.output) as Record<string, string>;

    expect(seen.addDir).toBe(seen.cwd);
    for (const tool of ['Bash', 'Write', 'Edit', 'WebFetch', 'WebSearch']) {
      expect(seen.disallowed).toContain(tool);
    }
  });

  it('fails the way the real Claude Code failed, with the prompt after the deny list', async () => {
    const { command, prefix } = stub('claude', CLAUDE);
    const broken = ['-p', '--add-dir', '{sandbox}', '--disallowedTools', 'Bash,Write', '{prompt}'];
    await expect(runAgent(config(command, [...prefix, ...broken]), PROMPT)).rejects.toThrow(
      /matches no known tool/,
    );
  });

  it('repairs a config saved with that prompt argument still on the end', () => {
    const broken = ['-p', '--add-dir', '{sandbox}', '--disallowedTools', 'Bash,Write,Edit', '{prompt}'];
    expect(repairAiArgs('claude', broken)).toEqual(broken.slice(0, -1));
    expect(repairAiArgs('/usr/local/bin/claude', broken)).toEqual(broken.slice(0, -1));
    // A custom set-up that puts the prompt somewhere workable is left alone.
    expect(repairAiArgs('claude', ['-p', '{promptText}', '--disallowedTools', 'Bash'])).toEqual([
      '-p',
      '{promptText}',
      '--disallowedTools',
      'Bash',
    ]);
  });

  it('gets past Codex’s git check, and does not hang on its stdin', { timeout: 30_000 }, async () => {
    const preset = AI_PRESETS.find((p) => p.label === 'Codex CLI')!;
    const { command, prefix } = stub('codex', CODEX);

    const started = Date.now();
    const result = await runAgent(config(command, [...prefix, ...preset.args]), PROMPT);
    const seen = JSON.parse(result.output) as Record<string, string | number>;

    expect(seen.sandbox).toBe('read-only');
    expect(seen.cd).toBe(seen.cwd);
    // The stand-in only reaches this line once stdin has been closed for it.
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('fails the way the real Codex failed, when the flag is missing', async () => {
    const { command, prefix } = stub('codex', CODEX);
    const withoutFlag = ['exec', '--sandbox', 'read-only', '--cd', '{sandbox}', '{promptText}'];
    await expect(runAgent(config(command, [...prefix, ...withoutFlag]), PROMPT)).rejects.toThrow(
      /skip-git-repo-check/,
    );
  });

  it('repairs a config saved before that flag existed', () => {
    expect(repairAiArgs('codex', ['exec', '--sandbox', 'read-only', '--cd', '{sandbox}'])).toEqual([
      'exec',
      '--skip-git-repo-check',
      '--sandbox',
      'read-only',
      '--cd',
      '{sandbox}',
    ]);
    // Wherever it is installed, and whatever it is called on Windows.
    expect(repairAiArgs('/usr/local/bin/codex', ['exec'])).toContain('--skip-git-repo-check');
    expect(repairAiArgs('codex.exe', ['exec'])).toContain('--skip-git-repo-check');
    // Already correct, or not Codex: left alone.
    expect(repairAiArgs('codex', AI_PRESETS[1]!.args)).toEqual(AI_PRESETS[1]!.args);
    expect(repairAiArgs('claude', ['-p', '{prompt}'])).toEqual(['-p', '{prompt}']);
  });

  it('recognises a saved config as the preset it came from', () => {
    for (const preset of AI_PRESETS) {
      expect(matchPreset(preset.command, preset.args)?.label).toBe(preset.label);
    }
    expect(matchPreset('claude', ['-p', '{prompt}'])).toBeUndefined();
  });

  it('passes agy multiline prompts literally, including leading dashes and shell syntax', async () => {
    const preset = AI_PRESETS.find((p) => p.command === 'agy')!;
    const { command, prefix } = stub('agy', AGY);
    const prompt = '--resume\nQuotes: "hello"; $HOME; `whoami`\n' + 'Experience. '.repeat(5000);
    const result = await runAgent(config(command, [...prefix, ...preset.args]), prompt);
    expect(JSON.parse(result.output).prompt).toBe(prompt);
  });

  it('repairs agy print placeholders without changing custom flags or other commands', () => {
    for (const command of ['agy', '/Users/example/.local/bin/agy', 'agy.exe']) {
      for (const flag of ['-p', '--print', '--prompt']) {
        expect(repairAiArgs(command, ['--mode', 'plan', flag, '{prompt}']))
          .toEqual(['--mode', 'plan', `${flag}={promptText}`]);
        expect(repairAiArgs(command, [`${flag}={prompt}`])).toEqual([`${flag}={promptText}`]);
        expect(repairAiArgs(command, [flag, '{promptText}'])).toEqual([`${flag}={promptText}`]);
      }
    }
    const preset = AI_PRESETS.find((p) => p.command === 'agy')!;
    expect(repairAiArgs('agy', preset.args)).toEqual(preset.args);
    expect(repairAiArgs('agy', ['--print=custom', '--model', 'chosen'])).toEqual(['--print=custom', '--model', 'chosen']);
    expect(repairAiArgs('custom-agy', ['-p', '{prompt}'])).toEqual(['-p', '{prompt}']);
  });

  it('opens the web tools when research is on, and shuts them when it is off', () => {
    const confined = AI_PRESETS.find((p) => p.label === 'Claude Code')!.args;
    const open = applyResearch('claude', confined, true);

    expect(open.join(' ')).not.toContain('WebFetch');
    expect(open.join(' ')).not.toContain('WebSearch');
    // Everything else about the confinement is untouched: the model may read
    // the company's careers page, not the user's files.
    expect(open).toContain('--add-dir');
    expect(open.join(' ')).toContain('Bash,Write,Edit');

    expect(applyResearch('claude', open, false).join(' ')).toContain('WebFetch');
  });

  it('drops the flag rather than passing it an empty list', () => {
    const onlyWeb = ['-p', '--disallowedTools', 'WebFetch,WebSearch'];
    expect(applyResearch('claude', onlyWeb, true)).toEqual(['-p']);
  });

  it('does not add the same tool twice when it is already denied', () => {
    const confined = AI_PRESETS.find((p) => p.label === 'Claude Code')!.args;
    expect(applyResearch('claude', confined, false)).toEqual(confined);
  });

  it('leaves a CLI it does not know how to open alone', () => {
    const codex = AI_PRESETS.find((p) => p.label === 'Codex CLI')!.args;
    expect(applyResearch('codex', codex, true)).toEqual(codex);
    expect(applyResearch('gemini', ['-p', '{promptText}'], true)).toEqual(['-p', '{promptText}']);
  });
});
