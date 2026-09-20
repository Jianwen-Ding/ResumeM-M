/**
 * Seeing an AI run while it is still running.
 *
 * The failure this exists for is a run that never finishes: `execFile` hands
 * its output over at exit, so a command killed at the timeout produced three
 * minutes of nothing and then a sentence that could not say whether it had
 * been working. The test that matters here is therefore the one that looks
 * *during* the run — a check that only reads the record afterwards would pass
 * against the old code, which also had the output afterwards.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runAgent } from '../src/ai/agent.js';
import { findRun, forgetRuns, recentRuns, running, startRun } from '../src/ai/activity.js';
import type { StoreConfig } from '../src/model/types.js';

afterEach(() => forgetRuns());

/** A config that runs a script of our own instead of a real coding agent. */
function configFor(script: string, timeoutMs = 10_000): StoreConfig {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmm-activity-'));
  const file = path.join(dir, 'fake-cli.cjs');
  fs.writeFileSync(file, script, 'utf8');
  return {
    ai: { enabled: true, command: process.execPath, args: [file], timeoutMs },
  } as unknown as StoreConfig;
}

describe('watching a run as it happens', () => {
  it('shows what the command said before it has finished saying it', async () => {
    /*
     * Prints, waits, prints again, exits. The wait is what the old code could
     * not see through: everything below the first line arrived at exit.
     */
    const config = configFor(`
      process.stdout.write('reading the posting\\n');
      setTimeout(() => { process.stdout.write('done\\n'); }, 600);
    `);

    const finished = runAgent(config, 'hello');

    // Long enough for the first line, well short of the second.
    await new Promise((r) => setTimeout(r, 300));

    const live = running();
    expect(live).toHaveLength(1);
    const seen = live[0]!.chunks.map((c) => c.text).join('');
    expect(seen).toContain('reading the posting');
    expect(seen).not.toContain('done');
    expect(live[0]!.outcome).toBeUndefined();
    // And it is plainly alive: something arrived after it started.
    expect(live[0]!.lastOutputAt).toBeGreaterThanOrEqual(live[0]!.startedAt);

    await finished;
    expect(running()).toHaveLength(0);
    expect(recentRuns()[0]!.outcome).toBe('ok');
  });

  it('tells a run that is thinking from one that is wedged', async () => {
    // Says nothing at all, and is stopped for it.
    const config = configFor(`setTimeout(() => {}, 60_000);`, 700);
    await expect(runAgent(config, 'hello')).rejects.toThrow(/longer than/i);

    const last = recentRuns()[0]!;
    expect(last.outcome).toBe('timeout');
    expect(last.note).toMatch(/raise the ai timeout/i);
    // The discriminator: nothing ever arrived, so there is nothing to wait for.
    expect(last.lastOutputAt).toBeUndefined();
    expect(last.bytes).toEqual({ out: 0, err: 0 });
  });

  it('keeps what a run managed to say before it was stopped', async () => {
    const config = configFor(
      `process.stdout.write('thinking hard\\n'); setTimeout(() => {}, 60_000);`,
      700,
    );
    await expect(runAgent(config, 'hello')).rejects.toThrow(/longer than/i);

    const last = recentRuns()[0]!;
    expect(last.outcome).toBe('timeout');
    expect(last.chunks.map((c) => c.text).join('')).toContain('thinking hard');
    // Which is the case where raising the timeout is the right advice.
    expect(last.lastOutputAt).toBeDefined();
  });

  it('says which stream a line came from', async () => {
    const config = configFor(`
      process.stderr.write('warning: using cached credentials\\n');
      process.stdout.write('the answer\\n');
    `);
    await runAgent(config, 'hello');

    const last = recentRuns()[0]!;
    const err = last.chunks.filter((c) => c.stream === 'err').map((c) => c.text).join('');
    const out = last.chunks.filter((c) => c.stream === 'out').map((c) => c.text).join('');
    expect(err).toContain('cached credentials');
    expect(out).toContain('the answer');
  });

  it('names a command that is not installed rather than leaving the run open', async () => {
    const config = { ai: { enabled: true, command: 'definitely-not-a-cli', args: [], timeoutMs: 5000 } } as unknown as StoreConfig;
    await expect(runAgent(config, 'hello')).rejects.toThrow(/not found/i);

    const last = recentRuns()[0]!;
    expect(last.outcome).toBe('failed');
    expect(last.note).toMatch(/not installed|not on PATH/i);
    expect(running()).toHaveLength(0);
  });

  /*
   * Which way it failed, not only that it did.
   *
   * The message cannot be read for this without parsing English, and the one
   * place that most needs to know — the extension's card — is furthest from
   * it. So it said "The AI could not be started" about a run that had plainly
   * been started and had run for three minutes, quoting the timeout in the
   * same breath. The two halves suggested opposite fixes.
   */
  it('says which way a run failed, so a caller can put it in a sentence', async () => {
    const gone = { ai: { enabled: true, command: 'definitely-not-a-cli', args: [], timeoutMs: 5000 } } as unknown as StoreConfig;
    await expect(runAgent(gone, 'hello')).rejects.toMatchObject({ kind: 'not-installed' });

    const slow = configFor(`setTimeout(() => {}, 60_000);`, 700);
    await expect(runAgent(slow, 'hello')).rejects.toMatchObject({ kind: 'timeout' });

    // Anything else is "failed", which is also what an AgentError built
    // without a kind says, so a caller always has one to read.
    const cross = configFor(`process.stderr.write('boom\n'); process.exit(3);`);
    await expect(runAgent(cross, 'hello')).rejects.toMatchObject({ kind: 'failed' });
  });

  it('records nothing at all when the AI is switched off', async () => {
    const config = { ai: { enabled: false, command: 'claude', args: [], timeoutMs: 5000 } } as unknown as StoreConfig;
    const result = await runAgent(config, 'the prompt');
    expect(result.executed).toBe(false);
    expect(recentRuns()).toHaveLength(0);
  });
});

describe('what the record holds', () => {
  it('shortens an argument long enough to be the prompt', () => {
    const prompt = 'x'.repeat(5000);
    startRun({ command: 'codex', args: ['--model', 'gpt-5-codex', prompt], prompt });

    const [run] = recentRuns();
    expect(run!.args[0]).toBe('--model');
    expect(run!.args[1]).toBe('gpt-5-codex');
    expect(run!.args[2]!.length).toBeLessThan(300);
    expect(run!.args[2]).toContain('5000 chars');
  });

  it('keeps the end of a noisy run, and says how much it let go', () => {
    const handle = startRun({ command: 'codex', args: [], prompt: '' });
    for (let i = 0; i < 400; i++) handle.saw('out', `${'line '.repeat(60)}${i}\n`);

    const run = findRun(handle.id)!;
    const held = run.chunks.map((c) => c.text).join('');
    expect(run.dropped).toBeGreaterThan(0);
    expect(Buffer.byteLength(held)).toBeLessThanOrEqual(64 * 1024 + 1024);
    // The end is what explains a run, so the end is what survives.
    expect(held).toContain('399');
    expect(held).not.toContain(' 0\n');
  });

  it('keeps what the model was actually given', async () => {
    const config = configFor(`process.stdout.write('ok\\n');`);
    await runAgent(config, 'Tailor this resume for the posting below.\n\nPlatform Engineer at Helios');

    const run = recentRuns()[0]!;
    expect(run.prompt).toContain('Tailor this resume');
    expect(run.prompt).toContain('Platform Engineer at Helios');
    expect(run.promptBytes).toBeGreaterThan(40);
    expect(run.promptCut).toBe(0);
  });

  it('cuts a very long prompt in the middle, keeping both ends', () => {
    // The instructions open a prompt and the posting closes it; the store is
    // the bulk in between, and it is the part worth losing.
    const prompt = `WHAT TO DO\n${'filler '.repeat(40_000)}\nTHE POSTING`;
    const handle = startRun({ command: 'codex', args: [], prompt });

    const run = findRun(handle.id)!;
    expect(run.promptCut).toBeGreaterThan(0);
    expect(run.prompt).toContain('WHAT TO DO');
    expect(run.prompt).toContain('THE POSTING');
    expect(run.prompt).toContain('bytes not kept');
    expect(Buffer.byteLength(run.prompt)).toBeLessThan(140 * 1024);
    // And the real size is still reported, not the kept size.
    expect(run.promptBytes).toBe(Buffer.byteLength(prompt));
  });

  it('keeps the first outcome, so a backstop cannot overwrite the diagnosis', () => {
    const handle = startRun({ command: 'codex', args: [], prompt: '' });
    handle.ended('timeout', 'Stopped after 180s.');
    handle.ended('failed', 'The run ended without saying why.');

    const run = findRun(handle.id)!;
    expect(run.outcome).toBe('timeout');
    expect(run.note).toBe('Stopped after 180s.');
  });
});
