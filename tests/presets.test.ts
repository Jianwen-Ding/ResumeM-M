import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runAgent } from '../src/ai/agent.js';
import {
  AI_PRESETS,
  applyModelAndEffort,
  applyResearch,
  effortInstruction,
  AI_TASKS,
  configForTask,
  modelFor,
  matchPreset,
  repairAiArgs,
} from '../src/ai/presets.js';
import { DEFAULT_CONFIG, type StoreConfig } from '../src/model/types.js';
import { tempDir } from './helpers.js';

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

const dir = tempDir('rmm-stub-');

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

/*
 * The same Codex, doing what `--output-last-message` says: the final message
 * goes to the file, and the printed session — turns, reasoning, the "tokens
 * used" line — goes to stdout, where it is nobody's answer.
 */
const CODEX_WITH_FILE = `
const argv = process.argv.slice(2);
const fs = require('node:fs');
const out = argv[argv.indexOf('--output-last-message') + 1];
fs.writeFileSync(out, 'Dear Hiring Manager,\\n\\nThis is the letter.\\n');
process.stdin.on('data', () => {});
process.stdin.on('end', () => {
  /*
   * The session says what it did, not what it wrote — which is the case the
   * file exists for. Reading the transcript here gets a sentence about a
   * letter instead of the letter.
   */
  process.stdout.write(
    '[2026-02-01T10:00:00] User instructions:\\n' + argv[argv.length - 1] + '\\n' +
    '[2026-02-01T10:00:01] codex\\nI have written the draft out to the file you asked for.\\n' +
    '[2026-02-01T10:00:02] tokens used: 1234\\n',
  );
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
// The real agy warns "--mode plan has no effect while slash command
// expansion is disabled" and then, no longer planning, stops to ask for a
// permission headless mode cannot grant — producing nothing at all.
if (argv.includes('--disable-slash-commands')) throw new Error('agy: plan mode cancelled, refusing to run tools');
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
    const repaired = repairAiArgs('claude', broken);
    expect(repaired).not.toContain('{prompt}');
    expect(repairAiArgs('/usr/local/bin/claude', broken)).toEqual(repaired);
    // A custom set-up that puts the prompt somewhere workable keeps it there.
    expect(repairAiArgs('claude', ['-p', '{promptText}', '--disallowedTools', 'Bash']).slice(0, 2)).toEqual([
      '-p',
      '{promptText}',
    ]);
  });

  /*
   * The deny list used to stop at Bash, Write, Edit and the web, which left
   * reading — and reading is what sent the model looking at the machine, which
   * is what made macOS ask whether ResumeM-M could see the user's Music
   * library. A preset is copied when it is chosen rather than referenced, so
   * a config saved back then keeps the short list forever.
   */
  it('widens a deny list saved before reading was understood to be the problem', () => {
    const old = ['-p', '--add-dir', '{sandbox}', '--disallowedTools', 'Bash,Write,Edit,WebFetch,WebSearch'];
    const now = repairAiArgs('claude', old).join(' ');
    for (const tool of ['Read', 'Glob', 'Grep', 'Task']) expect(now, tool).toContain(tool);
    // And what was already denied stays denied.
    for (const tool of ['Bash', 'Write', 'Edit', 'WebFetch']) expect(now, tool).toContain(tool);
    // Nothing else about the invocation moves.
    expect(repairAiArgs('claude', old).slice(0, 4)).toEqual(['-p', '--add-dir', '{sandbox}', '--disallowedTools']);
  });

  it('does not hand the web back to a config that had research switched on', () => {
    // Research is the one thing allowed to have taken the web tools out, so
    // widening the rest must not quietly put them back.
    const researching = ['-p', '--add-dir', '{sandbox}', '--disallowedTools', 'Bash,Write,Edit'];
    const now = repairAiArgs('claude', researching).join(' ');
    expect(now).toContain('Read');
    expect(now).not.toContain('WebFetch');
    expect(now).not.toContain('WebSearch');
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

  /*
   * The answer taken from the file Codex was asked to write, not from the
   * session it printed.
   *
   * Reading it out of the transcript works until it does not: the shape of
   * that transcript is Codex's to change, and when the rule misses, what gets
   * saved as the cover letter is the banner, the reasoning, or a letter the
   * run had quoted from the corpus. `--output-last-message` is a contract —
   * the final message, in a file, and nothing else in it.
   */
  it('takes the answer from the file Codex wrote, not the session it printed', { timeout: 30_000 }, async () => {
    const preset = AI_PRESETS.find((p) => p.label === 'Codex CLI')!;
    const { command, prefix } = stub('codex', CODEX_WITH_FILE);

    const result = await runAgent(config(command, [...prefix, ...preset.args]), PROMPT);
    expect(result.output).toBe('Dear Hiring Manager,\n\nThis is the letter.');
    // Nothing of the printed session came through with it.
    expect(result.output).not.toContain('User instructions');
    expect(result.output).not.toContain('tokens used');
  });

  /*
   * And a Codex too old to write the file, or one whose run died before it
   * could: the transcript is still there, and is still read. Silence would be
   * a worse answer than the one that worked before the flag existed.
   */
  it('falls back to the printed session when no file was written', { timeout: 30_000 }, async () => {
    const preset = AI_PRESETS.find((p) => p.label === 'Codex CLI')!;
    const { command, prefix } = stub('codex', CODEX);
    const result = await runAgent(config(command, [...prefix, ...preset.args]), PROMPT);
    expect((JSON.parse(result.output) as { cli: string }).cli).toBe('codex');
  });

  /*
   * And only on Codex's own command line.
   *
   * `-o` is Codex's short spelling of it, and `-o` on somebody else's tool
   * means something else — an output format, a report file. Read for every
   * CLI, a custom command carrying `-o report.txt` would have had that file
   * returned as the model's answer.
   */
  it('does not read another tool’s -o as the answer', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmm-not-codex-'));
    const decoy = path.join(dir, 'report.txt');
    fs.writeFileSync(decoy, 'A report this tool wrote for its own reasons.\n');
    try {
      const { command, prefix } = stub('other', `
process.stdout.write('The actual answer.');
`);
      const result = await runAgent(config(command, [...prefix, '-o', decoy]), PROMPT);
      expect(result.output).toBe('The actual answer.');
      expect(result.output).not.toContain('for its own reasons');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
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
      // No prompt token in this one, so the answer file goes on the end.
      '--output-last-message',
      '{sandbox}/last-message.txt',
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
    for (const tool of ['Bash', 'Write', 'Edit', 'Read', 'Glob', 'Grep']) {
      expect(open.join(' '), tool).toContain(tool);
    }

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

describe('choosing a model and an effort level', () => {
  const claude = AI_PRESETS.find((p) => p.command === 'claude')!;
  const codex = AI_PRESETS.find((p) => p.command === 'codex')!;
  const gemini = AI_PRESETS.find((p) => p.command === 'gemini')!;

  it('adds nothing when nothing was chosen', () => {
    expect(applyModelAndEffort('claude', claude.args, {})).toEqual(claude.args);
    expect(applyModelAndEffort('claude', claude.args, { model: '   ' })).toEqual(claude.args);
  });

  it('names the model the way each CLI spells it', () => {
    expect(applyModelAndEffort('claude', claude.args, { model: 'opus' })).toContain('--model');
    expect(applyModelAndEffort('claude', claude.args, { model: 'opus' })).toContain('opus');
    expect(applyModelAndEffort('gemini', gemini.args, { model: 'gemini-2.5-pro' })).toContain('gemini-2.5-pro');
  });

  /*
   * Three of the four presets pass the prompt as the last argument, and a CLI
   * that takes a positional prompt reads whatever follows it as more prompt —
   * so a flag appended to the end became part of the posting.
   */
  it('puts the flag in front of the prompt, never after it', () => {
    const out = applyModelAndEffort('codex', codex.args, { model: 'gpt-5' });
    const prompt = out.findIndex((a) => a.includes('{promptText}'));
    const flag = out.indexOf('--model');
    expect(flag).toBeGreaterThanOrEqual(0);
    expect(flag).toBeLessThan(prompt);
    expect(out[flag + 1]).toBe('gpt-5');
    // And the prompt is still the last thing on the line.
    expect(prompt).toBe(out.length - 1);
  });

  it('replaces a model rather than stacking them up', () => {
    const once = applyModelAndEffort('claude', claude.args, { model: 'opus' });
    const twice = applyModelAndEffort('claude', once, { model: 'sonnet' });
    expect(twice.filter((a) => a === '--model')).toHaveLength(1);
    expect(twice).toContain('sonnet');
    expect(twice).not.toContain('opus');
  });

  it('takes the flag away again when the box is cleared', () => {
    const set = applyModelAndEffort('claude', claude.args, { model: 'opus' });
    expect(applyModelAndEffort('claude', set, {})).toEqual(claude.args);
  });

  /*
   * Codex's `-c` is not the effort setting. It is its general config
   * override, and the effort switch is only one of the things people put
   * behind it — a proxy, a provider, a sandbox rule.
   *
   * Replacing "the flag" meant replacing all of them: picking an effort
   * silently deleted `-c model_provider=myproxy` from somebody's command
   * line, and clearing the effort afterwards did not bring it back. Nothing
   * said so at either end; the run simply went somewhere else.
   */
  it('leaves alone a config override that is not the effort', () => {
    const mine = [
      'exec', '--sandbox', 'read-only', '--skip-git-repo-check',
      '-c', 'model_provider=myproxy',
      '--cd', '{sandbox}', '{promptText}',
    ];

    const high = applyModelAndEffort('codex', mine, { effort: 'high' });
    expect(high).toContain('model_provider=myproxy');
    expect(high).toContain('model_reasoning_effort=high');

    // And taking the effort off again leaves theirs exactly where it was.
    const cleared = applyModelAndEffort('codex', high, {});
    expect(cleared).toEqual(mine);
  });

  it('still replaces its own value rather than stacking them up', () => {
    const once = applyModelAndEffort('codex', codex.args, { effort: 'low' });
    const twice = applyModelAndEffort('codex', once, { effort: 'high' });
    expect(twice.filter((a) => a.startsWith('model_reasoning_effort='))).toEqual([
      'model_reasoning_effort=high',
    ]);
  });

  it('passes effort only where the CLI has a switch for it', () => {
    const withEffort = applyModelAndEffort('codex', codex.args, { effort: 'high' });
    expect(withEffort).toContain('model_reasoning_effort=high');
    // Claude has none. Adding one would be inventing a flag, which is how a
    // command stops working entirely.
    expect(applyModelAndEffort('claude', claude.args, { effort: 'high' })).toEqual(claude.args);
  });

  it('leaves a command it does not recognise exactly as written', () => {
    const mine = ['--go', '{promptText}'];
    expect(applyModelAndEffort('my-own-cli', mine, { model: 'opus', effort: 'high' })).toEqual(mine);
  });

  it('finds the CLI behind a path or an extension', () => {
    expect(applyModelAndEffort('/usr/local/bin/claude', claude.args, { model: 'opus' })).toContain('opus');
    expect(applyModelAndEffort('C:\\tools\\claude.exe', claude.args, { model: 'opus' })).toContain('opus');
  });

  /*
   * Only one of the four has a flag, so the flag alone would make this a
   * no-op on three of them — and a setting that silently does nothing on most
   * configurations is worse than no setting.
   */
  it('says it in words too, which reaches every model', () => {
    expect(effortInstruction('high')).toMatch(/Take your time/);
    expect(effortInstruction('low')).toMatch(/Work quickly/);
    expect(effortInstruction('medium')).toBe('');
    expect(effortInstruction(undefined)).toBe('');
  });
});

/**
 * One model for everything is the wrong shape, and obviously so once the list
 * is written down: tailoring is a selection problem over a fixed inventory,
 * writing a letter is a writing problem in somebody else's voice, and reading
 * a repository is neither — and is the one that runs while you wait.
 */
describe('a different model for a different kind of work', () => {
  const claude = AI_PRESETS.find((p) => p.command === 'claude')!;
  const base = { command: 'claude', args: claude.args, enabled: true, timeoutMs: 1000 };

  it('falls back to the one model when a kind of work names none', () => {
    expect(modelFor({ model: 'opus' }, 'tailor')).toBe('opus');
    expect(modelFor({ model: 'opus', models: {} }, 'write')).toBe('opus');
    expect(modelFor({ model: 'opus', models: { write: '  ' } }, 'write')).toBe('opus');
  });

  it('uses the one it names when it names one', () => {
    expect(modelFor({ model: 'opus', models: { write: 'sonnet' } }, 'write')).toBe('sonnet');
    // And the others are unaffected.
    expect(modelFor({ model: 'opus', models: { write: 'sonnet' } }, 'tailor')).toBe('opus');
  });

  it('manages with no default at all', () => {
    expect(modelFor({ models: { tailor: 'opus' } }, 'tailor')).toBe('opus');
    expect(modelFor({}, 'review')).toBe('');
  });

  it('rewrites the arguments for that kind of work and nothing else', () => {
    const config = { ai: { ...base, model: 'opus', models: { write: 'haiku' } } };
    const writing = configForTask(config, 'write');
    expect(writing.ai.args).toContain('haiku');
    expect(writing.ai.args).not.toContain('opus');
    // The config it was given is untouched: twelve call sites share it.
    expect(config.ai.args).toBe(claude.args);
  });

  it('hands back the same object when nothing differs, so a call site costs nothing', () => {
    const config = { ai: { ...base, model: 'opus' } };
    expect(configForTask(config, 'tailor')).toBe(config);
  });

  it('carries the effort setting along, rather than dropping it on the way', () => {
    const codex = AI_PRESETS.find((p) => p.command === 'codex')!;
    const config = {
      ai: { command: 'codex', args: codex.args, model: 'gpt-5', models: { tailor: 'o4-mini' }, effort: 'high' as const },
    };
    const tailoring = configForTask(config, 'tailor');
    expect(tailoring.ai.args).toContain('o4-mini');
    expect(tailoring.ai.args).toContain('model_reasoning_effort=high');
  });

  it('names the kinds of work in words a person would use', () => {
    expect(AI_TASKS.map((t) => t.key)).toEqual(['tailor', 'write', 'review', 'author']);
    for (const t of AI_TASKS) {
      expect(t.label[0]).toBe(t.label[0]?.toUpperCase());
      expect(t.note.length).toBeGreaterThan(20);
    }
  });
});
