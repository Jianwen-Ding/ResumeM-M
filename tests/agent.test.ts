import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AgentError,
  deniedTools,
  explainSilence,
  extractJson,
  rejectedApproval,
  runAgent,
  tidyUp,
  trimToLetter,
  unwrapAgentFraming,
} from '../src/ai/agent.js';
import { AI_PRESETS } from '../src/ai/presets.js';
import { DEFAULT_CONFIG, type StoreConfig } from '../src/model/types.js';
import { repairAiArgs } from '../src/model/store.js';

function config(patch: Partial<StoreConfig['ai']>): StoreConfig {
  return { ...DEFAULT_CONFIG, ai: { ...DEFAULT_CONFIG.ai, ...patch } };
}

/*
 * Taking the scratch directory away must never be the thing that fails.
 *
 * It ran unguarded in a `finally`, so a removal that threw replaced whatever
 * the run had produced — including a run that had gone perfectly. Reported
 * from a real tailoring pass: "The AI did not finish, so nothing was
 * tailored. It said: ENOTEMPTY, Directory not empty: …/rmm-ai-UuaoCq". The
 * model had done the work; a temp directory would not delete and the work
 * went with it.
 */
/*
 * The CLI refusing the tools it was given, in its own words.
 *
 * Reported from a real run: "MCP tool call requires approval, but approval
 * policy is never". The server had started and the very first call was turned
 * down — `codex exec` cannot prompt anybody, so its policy is `never`, and
 * under that policy an MCP call is refused rather than allowed.
 *
 * The existing test for an auto-denied permission cannot see this: it asks for
 * "permission", "denied" or "not allowed", and this message uses none of the
 * three. It fell through to a sentence about the command not writing anything,
 * which sends somebody looking at the wrong thing entirely.
 */
describe('a CLI that refuses the tools', () => {
  const REFUSED = 'MCP tool call requires approval, but approval policy is never\nmcp: resume/read_resume started\n';

  it('is named as that, not as a command that wrote nothing', () => {
    const said = explainSilence('codex', REFUSED);
    expect(said).toMatch(/would not let it use the resume tools/i);
    expect(said).toMatch(/nobody to ask/i);
  });

  it('is told apart from a model reaching for a shell it does not need', () => {
    const shell = explainSilence('claude', 'tool use was auto-denied: Bash requires the command permission');
    expect(shell).toMatch(/permission to run something on your machine/i);
    expect(shell).not.toMatch(/would not let it use the resume tools/i);
  });

  it('says nothing of the kind about an ordinary quiet run', () => {
    expect(deniedTools('warning: using cached credentials')).toBeUndefined();
    // "approval" alone is not it either: the message has to be about a tool.
    expect(deniedTools('your approval is pending for this account')).toBeUndefined();
  });
});

describe('clearing up after a run', () => {
  it('removes the scratch directory', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmm-tidy-'));
    fs.writeFileSync(path.join(dir, 'prompt.md'), 'hello', 'utf8');
    fs.mkdirSync(path.join(dir, 'tools'));
    fs.writeFileSync(path.join(dir, 'tools', 'decisions.json'), '{}', 'utf8');

    tidyUp(dir);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('says nothing when it cannot, rather than throwing over the answer', () => {
    // A path the process genuinely cannot remove, so this is a real failure
    // rather than a stubbed one.
    expect(fs.existsSync('/proc/sys')).toBe(true);

    /*
     * First, that the expression this replaced really does throw on it —
     * otherwise the assertion below would pass against anything. This is
     * character for character what sat unguarded in the `finally`, and
     * `force` does not cover it: that suppresses "it was not there", not
     * "it would not go".
     */
    expect(() => fs.rmSync('/proc/sys', { recursive: true, force: true })).toThrow();

    expect(() => tidyUp('/proc/sys')).not.toThrow();
    // And it left it alone, which is the other half of not throwing.
    expect(fs.existsSync('/proc/sys')).toBe(true);
  });

  it('is not upset by a directory that has already gone', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmm-tidy-'));
    fs.rmSync(dir, { recursive: true });
    expect(() => tidyUp(dir)).not.toThrow();
  });
});

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

/**
 * A CLI that drains stdin before doing anything — Codex does this even when
 * the prompt arrived as an argument. If stdin is never closed, it waits for
 * input that will never come and the call hangs until the timeout. These use a
 * short timeout deliberately: a regression here shows up as a failure in a
 * couple of seconds rather than as a suite that appears to be thinking.
 */
const DRAINS_STDIN = [
  '-e',
  'let n=0;process.stdin.on("data",(d)=>{n+=d.length});process.stdin.on("end",()=>process.stdout.write(`read ${n} bytes of stdin, argv=${process.argv[1]??""}`))',
];

describe('stdin handling', () => {
  it('does not hang on a CLI that reads stdin when the prompt was an argument', async () => {
    const started = Date.now();
    const result = await runAgent(
      config({ enabled: true, command: process.execPath, args: [...DRAINS_STDIN, '{promptText}'], timeoutMs: 5000 }),
      'the prompt',
    );
    expect(result.executed).toBe(true);
    expect(result.output).toContain('argv=the prompt');
    expect(Date.now() - started).toBeLessThan(4000); // i.e. it did not wait out the timeout
  });

  it('does not hang on a CLI that reads stdin when the prompt is in a file', async () => {
    const started = Date.now();
    const result = await runAgent(
      config({ enabled: true, command: process.execPath, args: [...DRAINS_STDIN, '{prompt}'], timeoutMs: 5000 }),
      'the prompt',
    );
    expect(result.output).toContain('read 0 bytes'); // nothing on stdin, but it was closed
    expect(Date.now() - started).toBeLessThan(4000);
  });

  it('delivers the prompt on stdin when the command takes no prompt argument', async () => {
    const result = await runAgent(
      config({ enabled: true, command: process.execPath, args: DRAINS_STDIN, timeoutMs: 5000 }),
      'twelve chars',
    );
    expect(result.output).toContain('read 12 bytes of stdin');
  });

  it('survives a command that exits without reading stdin', async () => {
    const result = await runAgent(
      config({
        enabled: true,
        command: process.execPath,
        args: ['-e', 'process.stdout.write("done early")'],
        timeoutMs: 5000,
      }),
      'x'.repeat(200_000), // enough to fill the pipe buffer, so the write would block
    );
    expect(result.output).toBe('done early');
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

  /*
   * This used to fall back to stderr, and the test asserted it. But a CLI that
   * exits 0 having written a warning to stderr has not answered — and its
   * warning was taken as the answer: a tool printing "[WARN] api key rotated;
   * using cached credentials" had that line saved as the user's cover letter,
   * and as the answer to an application question, under the note "Cover letter
   * drafted in your voice".
   */
  it('refuses a command that exits cleanly having written nothing', async () => {
    await expect(
      runAgent(
        config({
          enabled: true,
          command: process.execPath,
          args: ['-e', 'process.stderr.write("warned")', '{prompt}'],
        }),
        'hello',
      ),
    ).rejects.toThrow(/finished without writing anything/);
  });

  it('says what the command complained about, so the failure is actionable', async () => {
    await expect(
      runAgent(
        config({
          enabled: true,
          command: process.execPath,
          args: ['-e', 'process.stderr.write("api key rotated")', '{prompt}'],
        }),
        'hello',
      ),
    ).rejects.toThrow(/api key rotated/);
  });

  it('does not mistake a CLI talking to itself for a sign-in problem', async () => {
    // "api key rotated; using cached credentials" is a working command saying
    // so. Answering it with "you are not signed in" sends someone to fix
    // something that is not broken.
    await expect(
      runAgent(
        config({
          enabled: true,
          command: process.execPath,
          args: ['-e', 'process.stderr.write("401 unauthorized")', '{prompt}'],
        }),
        'hello',
      ),
    ).rejects.toThrow(/not signed in/);
  });

  /*
   * A CLI reports its troubles in its own vocabulary, and pasting that through
   * unread put two program names, a settings file the user does not have, and
   * a suggestion to disable every permission check in front of someone who
   * wanted a cover letter. None of it was theirs to act on.
   */
  it('translates a run that stopped to ask for a permission nobody could grant', async () => {
    await expect(
      runAgent(
        config({
          enabled: true,
          command: process.execPath,
          args: [
            '-e',
            'process.stderr.write(\'jetski: no output produced — a tool required the "command" \' +\n' +
              '  \'permission that headless mode cannot prompt for, so it was auto-denied. Add an \' +\n' +
              '  \'allow-rule under permissions.allow in settings.json. Alternatively, re-run with \' +\n' +
              '  \'--dangerously-skip-permissions to auto-approve all tools.\')',
            '{prompt}',
          ],
        }),
        'hello',
      ),
    ).rejects.toThrow(/only ever wants text back/);
  });

  it('does not repeat a CLI\'s advice to turn its own safety checks off', async () => {
    await expect(
      runAgent(
        config({
          enabled: true,
          command: process.execPath,
          args: ['-e', 'process.stderr.write("a tool required the permission and was auto-denied")', '{prompt}'],
        }),
        'hello',
      ),
    ).rejects.toThrow(/^(?!.*dangerously-skip-permissions)/s);
  });

  it('says a rate limit is a rate limit', async () => {
    await expect(
      runAgent(
        config({
          enabled: true,
          command: process.execPath,
          args: ['-e', 'process.stderr.write("429 rate limit exceeded")', '{prompt}'],
        }),
        'hello',
      ),
    ).rejects.toThrow(/rate or usage limit/);
  });

  it('passes an unfamiliar complaint through, saying whose words they are', async () => {
    await expect(
      runAgent(
        config({
          enabled: true,
          command: process.execPath,
          args: ['-e', 'process.stderr.write("segmentation fault in module 4")', '{prompt}'],
        }),
        'hello',
      ),
    ).rejects.toThrow(/The command reported: segmentation fault in module 4/);
  });

  /*
   * `String.replace` with a string second argument still reads `$&`, `` $` ``,
   * `$\'` and `$1` in that argument as instructions. Prompts are built from the
   * user's own store and from postings fetched off the web, so a bullet
   * mentioning a shell variable was enough: "cut cloud spend by $&" reached the
   * CLI as "cut cloud spend by {promptText}". Three of the four presets pass
   * the prompt inline, so three of the four were affected.
   */
  it('passes the prompt through exactly, dollar signs and all', async () => {
    const d = String.fromCharCode(36);
    const prompt = [
      'Reduced spend by ' + d + '&, see ' + d + String.fromCharCode(96),
      ' and ' + d + String.fromCharCode(39) + ' and ' + d + '1 for detail.',
    ].join('');

    const result = await runAgent(
      config({
        enabled: true,
        command: process.execPath,
        args: ['-e', 'process.stdout.write(process.argv[1])', 'X={promptText}'],
      }),
      prompt,
    );
    expect(result.output).toBe(`X=${prompt}`);
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

/*
 * Codex does not print an answer. It prints a session.
 *
 * `codex exec` writes a version banner, the working directory, the model and
 * the sandbox mode; then, under "User instructions", the whole prompt echoed
 * back; then its reasoning under "thinking"; then the answer under "codex";
 * then a token count. Taken as it came, that is what was saved as the cover
 * letter — and the prompt quotes the user's previous letters as examples of
 * their voice, so the "letter" contained letters written to other companies,
 * with the real one several hundred lines down.
 *
 * `trimToLetter` made it worse rather than better: the first salutation in
 * that wall is the one in the quoted example, so the letter it kept was the
 * one addressed to somebody else.
 */
describe('a CLI that prints a session rather than an answer', () => {
  const session = (answer: string, prompt = 'Write a letter.') =>
    [
      '[2026-09-19T17:20:01] OpenAI Codex v0.9.0 (research preview)',
      '--------',
      'workdir: /tmp/rmm-ai-abc123',
      'model: gpt-5-codex',
      'sandbox: read-only',
      '--------',
      '[2026-09-19T17:20:01] User instructions:',
      prompt,
      '[2026-09-19T17:20:04] thinking',
      '',
      'I should match the posting to the strongest bullets.',
      '',
      '[2026-09-19T17:20:09] codex',
      '',
      answer,
      '',
      '[2026-09-19T17:20:09] tokens used: 4821',
    ].join('\n');

  it('keeps the answer and nothing around it', () => {
    const got = unwrapAgentFraming(session('Dear Helios,\n\nI build ingest pipelines.\n\nJianwen'));
    expect(got).toBe('Dear Helios,\n\nI build ingest pipelines.\n\nJianwen');
  });

  /*
   * The one that matters most: the prompt quotes a letter to another company,
   * because that is how the voice is taught. Left in, it is the letter with
   * the salutation nearest the top — so it is the one that got sent.
   */
  it('does not leave the letter the prompt quoted as an example', () => {
    const quoted = [
      'Write a letter to Helios.',
      '',
      'Here is one you wrote before, for its voice:',
      'Dear Northwind,',
      '',
      'I am writing about the data engineering role.',
      '',
      'Yours,',
      'Jianwen',
    ].join('\n');
    const whole = session('Dear Helios,\n\nI build ingest pipelines.\n\nJianwen', quoted);

    expect(trimToLetter(unwrapAgentFraming(whole))).not.toMatch(/Northwind/);
    expect(trimToLetter(unwrapAgentFraming(whole))).toMatch(/^Dear Helios,/);
    // And the wall of transcript, which is what actually reached the PDF.
    expect(unwrapAgentFraming(whole)).not.toMatch(/OpenAI Codex|workdir:|thinking|tokens used/);
  });

  /*
   * And the plan. `extractJson` takes the first object it can parse, and an
   * echoed prompt is full of them — so the plan that was applied was a
   * fragment of the store quoted back at us, and an AI run that changed
   * nothing reported success.
   */
  it('finds the plan the model wrote, not one quoted in the prompt', () => {
    const asked = 'Return JSON. The store is {"resumes":[{"id":"base"}]}. Not {"example":"this"}.';
    const whole = session('{"choices":{"b_pipeline":"v_kafka"},"disable":["exp_old"]}', asked);

    expect(extractJson(unwrapAgentFraming(whole))).toEqual({
      choices: { b_pipeline: 'v_kafka' },
      disable: ['exp_old'],
    });
  });

  it('takes the last turn when there are several', () => {
    const two = `${session('first')}\n[2026-09-19T17:21:00] codex\n\nsecond\n\n[2026-09-19T17:21:00] tokens used: 12`;
    expect(unwrapAgentFraming(two)).toBe('second');
  });

  /*
   * Matched on the shape, not on the command, because the command is whatever
   * somebody typed — a path, a wrapper script, `npx codex`. Which also means
   * it has to leave every other CLI's output exactly alone.
   */
  /*
   * A session that never reached an answer.
   *
   * The model returned nothing, the key was refused, a future version moved
   * the marker — whichever it was, the run did not answer. Left as it came,
   * the banner and the echoed prompt *are* the output, so they became the
   * cover letter: a failure saved and bundled as though it had worked.
   */
  it('treats a transcript with no answer in it as silence', () => {
    const stopped = [
      '[2026-09-19T17:20:01] OpenAI Codex v0.9.0 (research preview)',
      '--------',
      'workdir: /tmp/rmm-ai-abc123',
      '--------',
      '[2026-09-19T17:20:01] User instructions:',
      'Write a letter to Helios.',
      '[2026-09-19T17:20:03] thinking',
      '',
      'I will not be able to do that.',
    ].join('\n');
    expect(unwrapAgentFraming(stopped)).toBe('');
  });

  it('leaves an answer that is only an answer untouched', () => {
    const plain = 'Dear Helios,\n\nI build ingest pipelines.\n\nJianwen';
    expect(unwrapAgentFraming(plain)).toBe(plain);
    expect(unwrapAgentFraming('{"choices":{}}')).toBe('{"choices":{}}');
  });

  it('does not take a mention of codex in prose for a marker', () => {
    const prose = 'I have used the codex tool.\n\n[not a timestamp] codex\n\nstill the letter';
    expect(unwrapAgentFraming(prose)).toBe(prose);
  });
});

describe('confinement', () => {
  it('runs the command in an empty scratch directory, not the server’s own', async () => {
    // An agent CLI that "looks around the project" must find nothing but the
    // prompt. This is the guarantee that does not depend on any particular
    // CLI's sandbox flags.
    const result = await runAgent(
      config({
        enabled: true,
        command: process.execPath,
        args: [
          '-e',
          'const fs=require("fs");process.stdout.write(JSON.stringify({cwd:process.cwd(),files:fs.readdirSync(".")}))',
          '{prompt}',
        ],
      }),
      'prompt body',
    );

    const seen = JSON.parse(result.output) as { cwd: string; files: string[] };
    expect(seen.files).toEqual(['prompt.md']);
    expect(seen.cwd).not.toBe(process.cwd());
    expect(seen.cwd).toContain('rmm-ai-');
  });

  it('expands {sandbox} to that directory for CLIs that want it named', async () => {
    const result = await runAgent(
      config({
        enabled: true,
        command: process.execPath,
        args: ['-e', 'process.stdout.write(process.argv[1])', '{sandbox}'],
      }),
      'p',
    );
    expect(result.output).toContain('rmm-ai-');
  });

  it('points the working-directory environment at the sandbox too', async () => {
    const result = await runAgent(
      config({
        enabled: true,
        command: process.execPath,
        args: ['-e', 'process.stdout.write(process.env.PWD ?? "")', '{prompt}'],
      }),
      'p',
    );
    expect(result.output).toContain('rmm-ai-');
  });
});

/*
 * "MCP tool call requires approval, but approval policy is never."
 *
 * The run is wired correctly, the server starts, the model finds the tools,
 * and every call it makes is refused — `codex exec` has nobody to ask, so its
 * approval policy is `never` and a call needing approval is simply denied.
 * The narrow fix is to pre-approve calls to the one server we ourselves wrote,
 * and to leave the sandbox and every other approval alone.
 *
 * Older Codex versions may not know the server-level setting, so the point of
 * these tests is also the recovery: a CLI that will not take it gets one more
 * run without it and ends up exactly where it was, rather than not running.
 */
describe('pre-approving the one server we wired in', () => {
  const sandbox = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rmm-trust-'));
  const APPROVAL = ['-c', 'mcp_servers.resume.default_tools_approval_mode="approve"'];

  /** A stand-in CLI that records its arguments and can object to one of them. */
  function fakeCli(dir: string, body: string): { cli: string; log: string; seen: () => string[][] } {
    const log = path.join(dir, 'argv.log');
    const cli = path.join(dir, 'cli.cjs');
    fs.writeFileSync(
      cli,
      `const fs = require('fs');\n` +
        `const seen = process.argv.slice(2);\n` +
        `fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(seen) + '\\n');\n` +
        body,
      'utf8',
    );
    return {
      cli,
      log,
      seen: () =>
        (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '')
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l) as string[]),
    };
  }

  const withApproval = (out: string) => ({
    wire: () => ({ args: [], approval: APPROVAL, out, env: {} }),
    read: () => undefined,
  });

  it('runs again without the approval setting when an older CLI will not take it', async () => {
    const dir = sandbox();
    const { cli, seen } = fakeCli(
      dir,
      `if (seen.some((a) => a.includes('default_tools_approval_mode'))) {\n` +
        `  process.stderr.write('error: unknown field \`default_tools_approval_mode\`, expected one of \`command\`, \`args\`, \`env\`\\n');\n` +
        `  process.exit(1);\n` +
        `}\n` +
        `process.stdout.write('done');\n`,
    );

    const result = await runAgent(
      config({ enabled: true, command: process.execPath, args: [cli, '{prompt}'] }),
      'p',
      withApproval(path.join(dir, 'decisions.json')),
    );

    const runs = seen();
    // The first half: it was actually offered. Without this the test passes
    // against a build that never sends an approval setting at all.
    expect(runs).toHaveLength(2);
    const [first, second] = runs as [string[], string[]];
    expect(first.join(' ')).toContain('mcp_servers.resume.default_tools_approval_mode');
    // The second half: the retry dropped it, and kept everything else.
    expect(second.join(' ')).not.toContain('default_tools_approval_mode');
    expect(second.some((a) => a.endsWith('prompt.md'))).toBe(true);
    // And the caller got an answer rather than a failure.
    expect(result.output).toBe('done');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('does not run twice when the CLI failed for its own reasons', async () => {
    const dir = sandbox();
    const { cli, seen } = fakeCli(
      dir,
      `process.stderr.write('the model is unavailable right now\\n');\nprocess.exit(1);\n`,
    );

    await expect(
      runAgent(
        config({ enabled: true, command: process.execPath, args: [cli, '{prompt}'] }),
        'p',
        withApproval(path.join(dir, 'decisions.json')),
      ),
    ).rejects.toThrow(AgentError);
    expect(seen()).toHaveLength(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('tells a complaint about the key apart from a CLI echoing its config', () => {
    expect(rejectedApproval('error: unknown field `default_tools_approval_mode`', APPROVAL)).toBe(true);
    expect(rejectedApproval('config: mcp_servers.resume.default_tools_approval_mode = "approve"\nboom', APPROVAL)).toBe(false);
    expect(rejectedApproval('invalid model name "gpt-nonesuch"', APPROVAL)).toBe(false);
    expect(rejectedApproval('unknown field `default_tools_approval_mode`', [])).toBe(false);
  });
});

describe('repairing an AI command that cannot work', () => {
  it('adds --skip-git-repo-check to a codex exec that lacks it', () => {
    // The agent runs in an empty scratch directory, which is never a git
    // repository, so codex refuses to start without this.
    expect(repairAiArgs('codex', ['exec', '--sandbox', 'read-only', '--cd', '{sandbox}', '{promptText}'])).toEqual([
      'exec',
      '--skip-git-repo-check',
      '--sandbox',
      'read-only',
      '--cd',
      '{sandbox}',
      '--output-last-message',
      '{sandbox}/last-message.txt',
      '{promptText}',
    ]);
  });

  /*
   * And asks for the answer by itself, rather than leaving it to be found
   * inside the printed session. In front of the prompt, which Codex takes as
   * a positional: anything after it is read as more prompt.
   */
  it('asks a codex exec for its last message in a file', () => {
    const repaired = repairAiArgs('codex', ['exec', '--skip-git-repo-check', '{promptText}']);
    expect(repaired).toEqual(['exec', '--skip-git-repo-check', '--output-last-message', '{sandbox}/last-message.txt', '{promptText}']);

    // Whatever spelling is already there is theirs, and is left alone.
    const mine = ['exec', '--skip-git-repo-check', '-o', '/tmp/mine.txt', '{promptText}'];
    expect(repairAiArgs('codex', mine)).toEqual(mine);
    const joined = ['exec', '--skip-git-repo-check', '--output-last-message=/tmp/mine.txt', '{promptText}'];
    expect(repairAiArgs('codex', joined)).toEqual(joined);
  });

  it('recognises codex by path and on Windows', () => {
    expect(repairAiArgs('/usr/local/bin/codex', ['exec', 'x'])).toContain('--skip-git-repo-check');
    expect(repairAiArgs('C:\\tools\\codex.exe', ['exec', 'x'])).toContain('--skip-git-repo-check');
  });

  it('touches nothing else', () => {
    for (const [command, args] of [
      ['claude', ['-p', '{prompt}']],
      ['gemini', ['-p', '{promptText}']],
      ['codex-like-but-not', ['exec', 'x']],
      ['codex', ['--help']], // no `exec`, so not the broken shape
    ] as [string, string[]][]) {
      expect(repairAiArgs(command, args)).toBe(args);
    }
  });
});

describe('taking the letter out of what the model wrapped it in', () => {
  const LETTER = 'Dear Anthropic,\n\nClaude runs at a scale where a slow join shows up for someone.\n\nSincerely,\nJianwen';

  it('leaves a letter that starts where it should', () => {
    expect(trimToLetter(LETTER)).toBe(LETTER);
  });

  it('drops the sentence the model wrote before starting', () => {
    // Observed from a real run: the rules say no preamble, and mostly that
    // holds — "mostly" is not a contract, and the failure is visible.
    const chatty = `I have grounded this only in the resume. Here is the draft:\n\n---\n\n${LETTER}`;
    expect(trimToLetter(chatty)).toBe(LETTER);
  });

  it('keeps whatever the model added at the end', () => {
    // Trimming the tail risks cutting a real sign-off, and a stray line at the
    // bottom is visible where a missing signature is not.
    const trailing = `${LETTER}\n\nLet me know if you would like it shorter.`;
    expect(trimToLetter(trailing)).toContain('Let me know');
  });

  it('leaves alone a reply with no salutation to find', () => {
    expect(trimToLetter('I would rather not write that.')).toBe('I would rather not write that.');
  });

  it('does not cut into a letter that quotes a salutation later on', () => {
    const quoting = ['Some notes first.', '', ...Array(20).fill('A line of prose.'), 'Dear reader,'].join('\n');
    expect(trimToLetter(quoting)).toContain('Some notes first.');
  });

  it('handles the salutations people actually use', () => {
    expect(trimToLetter('Here you go:\n\nHi there,\n\nBody.')).toBe('Hi there,\n\nBody.');
    expect(trimToLetter('Draft:\n\nTo whom it may concern\n\nBody.')).toContain('To whom it may concern');
  });
});

describe('a letter with no salutation to find', () => {
  // Word for word what a run actually returned, minus the letter's length.
  const PROSE = [
    'I want to work on systems where performance and reliability under load actually matter.',
    '',
    'At Example Co. I built a Kafka-backed pipeline handling 2M events a day, and cut median',
    'end-to-end latency from 900ms to 180ms by trimming the bottlenecks between stages.',
    '',
    'I would like to bring that to your team and learn how you approach it in production.',
  ].join('\n');

  it('drops the plan file the agent wrote and linked', () => {
    const chatty = [
      'I have prepared the implementation plan and a candidate-voice-matched draft in',
      '[cover_letter_plan.md](file:///Users/someone/brain/cover_letter_plan.md).',
      '',
      '### Key Decision / Question:',
      '- **Target Company Name**: The posting lists the company name as `Software Engineering`.',
      '  If this is a placeholder or test input, the plan accommodates it without inventing',
      '  details. Let me know if you have a specific team in mind.',
      '',
      PROSE,
    ].join('\n');

    const out = trimToLetter(chatty);
    expect(out).toBe(PROSE);
    expect(out).not.toContain('cover_letter_plan');
    expect(out).not.toContain('Key Decision');
  });

  it('leaves a letter that opens straight into prose', () => {
    expect(trimToLetter(PROSE)).toBe(PROSE);
  });

  it('does not touch a first paragraph that merely starts with "I"', () => {
    // "I'll" on its own used to match the pattern for "I'll write it now",
    // which would have eaten the opening paragraph of a real letter.
    const letter = `I'll be blunt: the scheduler work is why I am writing.\n\nSecond paragraph.`;
    expect(trimToLetter(letter)).toBe(letter);
  });

  /*
   * The verbs an agent uses about its own work are the verbs a letter uses
   * about its writer's. "The assistant describing what it just did" was
   * written as the verb alone, so an opening paragraph beginning "Here's what
   * drew me to this role" or "I have written production Go since 2022" was
   * taken for commentary and the whole paragraph dropped — silently, with the
   * letter still long enough to clear every guard underneath.
   *
   * The same slip the test above pins for "I'll", in three more places.
   */
  it('does not eat an opening paragraph that talks about the writer', () => {
    for (const opening of [
      "Here's what drew me to this role: the scheduler work is the part I want.",
      'I have written production Go since 2022, most of it under a latency budget.',
      "I've created two ingest pipelines from nothing, and kept both of them up.",
      'Below is not where I would start; the hard part is the tail latency.',
      "I'll write the boring migration nobody volunteers for, and I have.",
    ]) {
      const letter = `${opening}\n\n${PROSE}`;
      expect(trimToLetter(letter), opening.slice(0, 24)).toBe(letter);
    }
  });

  /*
   * And still drops the same shapes when they say what is being handed over,
   * which is the difference: an agent names the artifact.
   */
  it('still drops a paragraph that hands over a letter', () => {
    for (const preamble of [
      "Here's the cover letter you asked for:",
      'Below is a draft based on the posting.',
      'I have written the letter and saved a plan alongside it.',
      "I'll now draft the answers to the three questions.",
    ]) {
      expect(trimToLetter(`${preamble}\n\n${PROSE}`), preamble.slice(0, 24)).toBe(PROSE);
    }
  });

  it('hands back the whole reply when nearly all of it looks like commentary', () => {
    // A refusal, a clarifying question, an error: guessing which half is the
    // letter is how a draft disappears.
    const noLetter = 'Here is what I need first:\n\n- Which company is this?\n\n- Which role?';
    expect(trimToLetter(noLetter)).toBe(noLetter);
  });

  it('keeps a list that is the reply itself, with no preamble above it', () => {
    const list = '- One point.\n\n- Another point.';
    expect(trimToLetter(list)).toBe(list);
  });
});

describe('telling someone which part of their AI setting is wrong', () => {
  const PERMISSION = 'a tool required the "command" permission and was auto-denied';
  const claude = AI_PRESETS.find((p) => p.command === 'claude')!;

  it('says plainly when the command is not one this tool knows', () => {
    const said = explainSilence('mycli', PERMISSION, ['--go']);
    expect(said).toContain('Nothing here is set to "mycli" by any of the presets');
    expect(said).toContain('claude');
    expect(said).toMatch(/nothing to ask permission for/);
  });

  it('names the mismatch when the command is a preset and the arguments are not', () => {
    /*
     * The real report: "I did pick a preset, it still failed like this",
     * about agy — which *is* a preset's command, so "pick a preset" was
     * advice they had already taken. What a preset picked and never saved
     * leaves behind is exactly this: the right command, the old arguments.
     */
    const said = explainSilence('agy', PERMISSION, ['--mode', 'plan', '--disable-slash-commands']);
    expect(said).toContain('matches the "Antigravity (agy)" preset but the arguments saved with it do not');
    expect(said).toContain('saved: --mode plan --disable-slash-commands');
    expect(said).toMatch(/choosing it saves and tests it/);
  });

  it('stops blaming the settings when the settings are exactly a preset', () => {
    const agy = AI_PRESETS.find((p) => p.command === 'agy')!;
    const said = explainSilence('agy', PERMISSION, agy.args);
    expect(said).toContain('exactly the "Antigravity (agy)" preset');
    expect(said).toMatch(/asked for by the CLI\s+itself/);
    expect(said).not.toMatch(/Pick a preset/);
  });

  it('always leaves a way out that needs nothing installed', () => {
    for (const [command, args] of [
      ['mycli', ['--go']],
      ['agy', ['--mode', 'plan', '--disable-slash-commands']],
      ['claude', claude.args],
    ] as [string, string[]][]) {
      const said = explainSilence(command, PERMISSION, args);
      expect(said).toContain('finished without writing anything');
      expect(said).toMatch(/hands you the prompt it would have sent/);
    }
  });
});
