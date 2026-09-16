import { describe, expect, it } from 'vitest';
import { AgentError, extractJson, runAgent } from '../src/ai/agent.js';
import { DEFAULT_CONFIG, type StoreConfig } from '../src/model/types.js';

function config(patch: Partial<StoreConfig['ai']>): StoreConfig {
  return { ...DEFAULT_CONFIG, ai: { ...DEFAULT_CONFIG.ai, ...patch } };
}

describe('extractJson', () => {
  it('parses a bare object', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('parses a fenced block', () => {
    expect(extractJson('Here you go:\n```json\n{"a":2}\n```\nHope that helps.')).toEqual({ a: 2 });
  });

  it('parses a fenced block with no language tag', () => {
    expect(extractJson('```\n{"a":3}\n```')).toEqual({ a: 3 });
  });

  it('finds an object buried in prose', () => {
    expect(extractJson('I think {"choices":{"b":"v"}} is right.')).toEqual({ choices: { b: 'v' } });
  });

  it('does not stop at the first closing brace of a nested object', () => {
    const text = 'Result: {"outer":{"inner":{"deep":true}},"after":1} — done.';
    expect(extractJson(text)).toEqual({ outer: { inner: { deep: true } }, after: 1 });
  });

  it('is not fooled by braces inside strings', () => {
    const text = '{"note":"a } brace and a \\" quote","ok":true}';
    expect(extractJson(text)).toEqual({ note: 'a } brace and a " quote', ok: true });
  });

  it('throws with the raw output when there is no JSON', () => {
    expect(() => extractJson('Sorry, I cannot help with that.')).toThrow(AgentError);
    expect(() => extractJson('nothing here')).toThrow(/Could not find JSON/);
  });

  it('throws when the only object present is malformed', () => {
    expect(() => extractJson('{"a": }')).toThrow(AgentError);
  });
});

describe('runAgent', () => {
  it('returns the prompt unexecuted when the AI is switched off', async () => {
    const result = await runAgent(config({ enabled: false }), 'PROMPT BODY');
    expect(result.executed).toBe(false);
    expect(result.output).toBe('PROMPT BODY');
    expect(result.command).toBeUndefined();
  });

  it('runs the configured command and returns its output', async () => {
    // `node -e` stands in for a coding-agent CLI: it reads the prompt file the
    // same way one would.
    const result = await runAgent(
      config({
        enabled: true,
        command: process.execPath,
        args: ['-e', 'const fs=require("fs");process.stdout.write(fs.readFileSync(process.argv[1],"utf8").toUpperCase())', '{prompt}'],
      }),
      'hello',
    );
    expect(result.executed).toBe(true);
    expect(result.output).toBe('HELLO');
  });

  it('falls back to stderr when a command writes nothing to stdout', async () => {
    const result = await runAgent(
      config({
        enabled: true,
        command: process.execPath,
        args: ['-e', 'process.stderr.write("warned")', '{prompt}'],
      }),
      'hello',
    );
    expect(result.output).toBe('warned');
  });

  it('can inline the prompt for CLIs that insist on an argument', async () => {
    const result = await runAgent(
      config({
        enabled: true,
        command: process.execPath,
        args: ['-e', 'process.stdout.write(process.argv[1])', '{promptText}'],
      }),
      'inline me',
    );
    expect(result.output).toBe('inline me');
  });

  it('explains clearly when the configured command is not installed', async () => {
    await expect(
      runAgent(config({ enabled: true, command: 'definitely-not-a-real-command-xyz' }), 'p'),
    ).rejects.toThrow(/not found/);
  });

  it('surfaces a failing command as an AgentError', async () => {
    await expect(
      runAgent(
        config({
          enabled: true,
          command: process.execPath,
          args: ['-e', 'process.stderr.write("boom");process.exit(3)', '{prompt}'],
        }),
        'p',
      ),
    ).rejects.toThrow(AgentError);
  });

  it('cleans up the prompt file it wrote', async () => {
    const result = await runAgent(
      config({
        enabled: true,
        command: process.execPath,
        args: ['-e', 'process.stdout.write(process.argv[1])', '{prompt}'],
      }),
      'x',
    );
    const promptPath = result.output.trim();
    const fs = await import('node:fs');
    expect(fs.existsSync(promptPath)).toBe(false);
  });
});
