import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { StoreConfig } from '../model/types.js';

const run = promisify(execFile);

export interface AgentResult {
  /** Raw stdout from the CLI, or the prompt itself when the agent is disabled. */
  output: string;
  /** False when `ai.enabled` is off — `output` is then the unexecuted prompt. */
  executed: boolean;
  command?: string;
}

/**
 * Shells out to whichever coding-agent CLI is configured. The prompt goes to a
 * file rather than the command line: prompts here run to tens of kilobytes,
 * past what an argv can hold, and a file keeps quoting out of the picture.
 *
 * ## Confinement
 *
 * These CLIs are agents: left alone they can read and write whatever their
 * working directory gives them. None of these tasks needs a filesystem at all —
 * every prompt already carries the text it is reasoning about — so the child
 * runs in a fresh empty temp directory holding nothing but the prompt. That
 * alone is the guarantee, independent of whatever sandbox flags a particular
 * CLI happens to offer; `{sandbox}` in the argument template expands to that
 * directory for CLIs that want it named explicitly.
 *
 * What this stops: an agent that decides to "look around the project" ending up
 * in your source tree, your store, or your home directory.
 */
export async function runAgent(config: StoreConfig, prompt: string): Promise<AgentResult> {
  if (!config.ai.enabled) {
    return { output: prompt, executed: false };
  }

  // macOS aliases /var to /private/var; CLI arguments and cwd must agree.
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rmm-ai-')));
  const promptFile = path.join(dir, 'prompt.md');
  fs.writeFileSync(promptFile, prompt, 'utf8');

  // `{prompt}` is the prompt file path; `{promptText}` inlines it for CLIs that
  // insist on an argument; `{sandbox}` is the directory the child is confined
  // to, for CLIs that take an explicit allow-list.
  /*
   * Substituted literally, not as a replacement pattern.
   *
   * `String.replace` with a string second argument still reads `$&`, `` $` ``,
   * `$'` and `$1` in it as instructions. Prompts are built from the user's own
   * store and from job postings fetched off the web, so a bullet that mentions
   * a shell variable or a regex is enough: "cut cloud spend by $&" reached the
   * CLI as "cut cloud spend by {promptText}", and `` $` `` spliced the argument
   * template's own text into the middle of the prompt. Three of the four
   * presets pass the prompt inline, so three of the four were affected.
   */
  const put = (into: string, token: string, value: string) => into.split(token).join(value);
  const args = config.ai.args.map((a) =>
    put(put(put(a, '{prompt}', promptFile), '{promptText}', prompt), '{sandbox}', dir),
  );
  const usesFile = config.ai.args.some((a) => a.includes('{prompt}') && !a.includes('{promptText}'));

  try {
    const pending = run(config.ai.command, args, {
      timeout: config.ai.timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
      // The confinement: an empty directory with only the prompt in it, never
      // the server's own working directory.
      cwd: dir,
      env: {
        ...process.env,
        // Some CLIs treat these as "the project"; point them at the sandbox so
        // a stray relative path cannot escape it.
        PWD: dir,
        TMPDIR: dir,
      },
    });

    /*
     * Close the child's stdin — always, and explicitly.
     *
     * `execFile` has no `input` option (that belongs to the *Sync* variants),
     * so passing one silently does nothing and leaves stdin an open pipe that
     * nothing ever ends. A CLI that reads stdin then waits for input that will
     * never come, and the call hangs until the timeout: Codex does exactly
     * this even when the prompt was handed to it as an argument.
     *
     * Ending the stream is also how a CLI that *does* want the prompt on stdin
     * gets it, so one line covers both.
     */
    const stdin = pending.child.stdin;
    if (stdin) {
      // The child may exit before reading; a broken pipe is not our problem.
      stdin.on('error', () => undefined);
      stdin.end(usesFile ? undefined : prompt);
    }

    const { stdout, stderr } = await pending;

    /*
     * The answer is what the CLI printed to stdout. Falling back to stderr on a
     * clean exit treated a CLI's own diagnostics as the model's reply: a tool
     * that exits 0 having written "[WARN] api key rotated; using cached
     * credentials" to stderr had that line saved as the cover letter and as the
     * answer to an application question, under the note "Cover letter drafted
     * in your voice".
     *
     * Empty stdout on a clean exit is a failed run, and saying so is the honest
     * answer — the caller already knows how to show that.
     */
    const output = stdout.trim();
    if (!output) {
      throw new AgentError(explainSilence(config.ai.command, stderr));
    }
    return { output, executed: true, command: `${config.ai.command} ${args.join(' ')}` };
  } catch (err) {
    // Our own refusals already say what happened; re-wrapping them as "AI
    // command failed: AI command failed: …" helps nobody.
    if (err instanceof AgentError) throw err;
    const e = err as { code?: string; message?: string; stderr?: string; stdout?: string };
    if (e.code === 'ENOENT') {
      throw new AgentError(
        `AI command "${config.ai.command}" not found. Install it, or change ai.command in data/config.yaml, ` +
          `or set ai.enabled: false to get prompts back instead of answers.`,
      );
    }
    /*
     * A timeout is the commonest failure and the least self-explanatory: the
     * message was "AI command failed: Command failed: /opt/node22/bin/node
     * /tmp/rmm-to-xxx/slow.cjs -p", which says nothing about time and shows the
     * user a scratch path. `killed` and `signal` are right there.
     */
    const killed = (err as { killed?: boolean }).killed;
    if (killed) {
      throw new AgentError(
        `AI command "${config.ai.command}" ran for longer than ${Math.round(config.ai.timeoutMs / 1000)}s ` +
          `and was stopped. Raise ai.timeoutMs in config.yaml if it needs longer.`,
        e.stdout,
      );
    }
    throw new AgentError(
      `AI command failed: ${e.stderr?.trim() || e.message || 'unknown error'}`,
      e.stdout,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Why a CLI that exited cleanly wrote nothing, in this tool's own words.
 *
 * A coding-agent CLI reports its troubles in its own vocabulary, and pasting
 * that through unread put this in front of someone who wanted a cover letter:
 *
 *   AI command "agy" exited without writing anything. It said: warning: --mode
 *   plan has no effect while slash command expansion is disabled. jetski: no
 *   output produced — a tool required the "command" permission that headless
 *   mode cannot prompt for, so it was auto-denied. Add an allow-rule under
 *   permissions.allow in settings.json (e.g. command(<target>)). Alternatively,
 *   re-run with --dangerously-skip-permissions to auto-approve all tools.
 *
 * Two names for programs they did not run, a file they do not have, and a
 * suggestion to disable every safety check in it. None of that is theirs to
 * act on: this tool asks the model for text and nothing else, so a run that
 * stopped to ask for a shell is a run that was configured to do more than it
 * needs to. Say that, and say where the switch is.
 */
export function explainSilence(command: string, stderr: string): string {
  const said = stderr.trim();
  const lower = said.toLowerCase();
  const head = `The AI command "${command}" finished without writing anything.`;

  if (/permission|auto-denied|not allowed|denied/.test(lower) && /tool|command|bash|shell/.test(lower)) {
    return (
      `${head} It stopped to ask permission to run something on your machine, and nothing was ` +
      `there to answer, so it gave up. ResumeM-M only ever wants text back — it does not need ` +
      `the AI to run commands, read your files or change anything. Pick a preset in Settings, ` +
      `which confines the command to a scratch folder, rather than granting it more access.`
    );
  }

  // Deliberately narrow. "api key rotated; using cached credentials" is a
  // working command talking to itself, and answering it with "you are not
  // signed in" sends someone to fix something that is not broken.
  if (/unauthorized|\b401\b|\b403\b|not (logged|signed) in|please (log|sign) in|authentication failed|(invalid|missing|no) api key/.test(lower)) {
    return (
      `${head} It looks like it is not signed in. Run it once yourself in a terminal to log in, ` +
      `then try again — Settings › Save and test will tell you when it is working.`
    );
  }

  if (/rate limit|quota|429|usage limit/.test(lower)) {
    return `${head} It reported a rate or usage limit. Wait and try again; nothing was lost.`;
  }

  // Unrecognised: pass it on, but say plainly that it is the CLI talking.
  return head + (said ? ` The command reported: ${said.slice(0, 400)}` : '');
}

export class AgentError extends Error {
  readonly partial?: string;
  constructor(message: string, partial?: string) {
    super(message);
    this.name = 'AgentError';
    this.partial = partial;
  }
}

/**
 * Pull a JSON object out of an agent's reply. Models wrap JSON in prose or
 * fences often enough that demanding clean output is not worth the failures.
 */
export function extractJson<T>(text: string): T {
  const fenced = /```(?:json)?\s*\n([\s\S]*?)```/.exec(text);
  const candidates = [fenced?.[1], text].filter((c): c is string => Boolean(c));

  for (const c of candidates) {
    try {
      return JSON.parse(c.trim()) as T;
    } catch {
      // Fall through to brace matching.
    }
    const start = c.indexOf('{');
    if (start < 0) continue;
    // Walk braces so a nested object doesn't get truncated at the first '}'.
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < c.length; i++) {
      const ch = c[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === '"') inString = !inString;
      if (inString) continue;
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(c.slice(start, i + 1)) as T;
          } catch {
            break;
          }
        }
      }
    }
  }
  throw new AgentError(`Could not find JSON in the agent's reply. Raw output:\n${text.slice(0, 2000)}`);
}

/**
 * Take the letter out of whatever the model wrapped it in.
 *
 * The rules say to output only what was asked for, and models mostly comply —
 * but "mostly" is not a contract, and the failure is ugly in a way the user
 * sees: a cover letter that opens "Here is the draft:" and then has a row of
 * dashes above the salutation. A letter starts at its salutation, which is a
 * shape that can be found, so it is found rather than hoped for.
 *
 * Only the opening is touched. Everything after the salutation is the letter,
 * including anything the model added at the end — trimming that would risk
 * cutting a real sign-off, and a stray trailing line is visible where a
 * missing signature is not.
 */
export function trimToLetter(output: string): string {
  const text = output.replace(/\r/g, '').trim();
  const lines = text.split('\n');

  const salutation = lines.findIndex((line) => {
    const l = line.trim();
    if (/^(dear\b|to whom it may concern)/i.test(l)) return true;
    return /^(hello|hi|greetings|good (morning|afternoon))\b[^.!?]{0,60}[,:]$/i.test(l);
  });

  // No salutation to find, or it is already the first thing: leave it alone.
  if (salutation <= 0) return text;

  // Only skip a preamble, not half the letter: a salutation a long way down is
  // more likely to be quoted inside one than to be the start of one.
  if (salutation > 12) return text;
  return lines.slice(salutation).join('\n').trim();
}
