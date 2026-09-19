import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { AI_PRESETS } from './presets.js';
import type { StoreConfig } from '../model/types.js';

const run = promisify(execFile);

export interface AgentResult {
  /** Raw stdout from the CLI, or the prompt itself when the agent is disabled. */
  output: string;
  /** False when `ai.enabled` is off — `output` is then the unexecuted prompt. */
  executed: boolean;
  command?: string;
  /**
   * What the run decided through its tools, when it was given any.
   *
   * Absent means the run was a plain one, or the CLI ignored the tools and
   * answered in prose — in which case `output` is still the reply and the
   * caller falls back to reading JSON out of it, exactly as before.
   */
  tools?: unknown;
}

/**
 * A set of tools to hand the run, and where its decisions come back.
 *
 * Optional because most prompts here want prose back and have nothing to call:
 * a cover letter is not a set of moves. It is the tailoring pass that is a set
 * of moves, and that is the one where a single unparseable reply used to throw
 * the whole run away.
 */
export interface AgentTools {
  /** Given the scratch directory and the command, wire a server into it. */
  wire: (sandbox: string, command: string) => { args: string[]; out: string; env: Record<string, string> } | null;
  /** Read back whatever the run decided. */
  read: (out: string) => unknown;
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
export async function runAgent(config: StoreConfig, prompt: string, tools?: AgentTools): Promise<AgentResult> {
  if (!config.ai.enabled) {
    return { output: prompt, executed: false };
  }

  // macOS aliases /var to /private/var; CLI arguments and cwd must agree.
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rmm-ai-')));
  const promptFile = path.join(dir, 'prompt.md');
  fs.writeFileSync(promptFile, prompt, 'utf8');

  /*
   * The tool server, if this run gets one.
   *
   * Everything it needs goes into the same scratch directory the child is
   * already confined to, so the tools do not widen what the run can reach by
   * one byte: the CLI spawns the server itself over a pipe, and the entire
   * exchange is two processes and a file that is deleted below.
   *
   * `wire` returning null means we do not know how to tell this particular
   * CLI about a server. That is not a failure — the prompt still asks for
   * JSON, which is what every run did before any of this existed.
   */
  const wiring = tools?.wire(dir, config.ai.command) ?? null;

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
  const expanded = config.ai.args.map((a) =>
    put(put(put(a, '{prompt}', promptFile), '{promptText}', prompt), '{sandbox}', dir),
  );
  /*
   * In front of the prompt, for the same reason the model and effort flags
   * are: three of the four presets pass the prompt as the last argument, and
   * a CLI that takes a positional prompt reads whatever follows it as more
   * prompt.
   */
  const args = (() => {
    if (!wiring || wiring.args.length === 0) return expanded;
    const promptAt = expanded.findIndex((a) => a === prompt || a === promptFile || a.endsWith(prompt));
    if (promptAt < 0) return [...expanded, ...wiring.args];
    return [...expanded.slice(0, promptAt), ...wiring.args, ...expanded.slice(promptAt)];
  })();
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
        ...(wiring?.env ?? {}),
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
    const decided = wiring ? tools?.read(wiring.out) : undefined;

    // The answer, not the session transcript it may be wrapped in. See
    // `unwrapAgentFraming` — this is before every reader of `output`, because
    // all of them were reading the wrapper.
    const output = unwrapAgentFraming(stdout.trim());
    /*
     * Silence is only a failure when there was no other way to answer.
     *
     * A CLI that did its work through the tools has already said everything
     * it had to say, and several of them print nothing to stdout when the
     * last thing they did was call a tool. Treating that as "the command
     * produced nothing" would fail the one kind of run that went best.
     */
    if (!output && !decided) {
      throw new AgentError(explainSilence(config.ai.command, stderr, config.ai.args));
    }
    return {
      output,
      executed: true,
      command: `${config.ai.command} ${args.join(' ')}`,
      ...(decided ? { tools: decided } : {}),
    };
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
export function explainSilence(command: string, stderr: string, args: string[] = []): string {
  const said = stderr.trim();
  const lower = said.toLowerCase();
  const head = `The AI command "${command}" finished without writing anything.`;

  if (/permission|auto-denied|not allowed|denied/.test(lower) && /tool|command|bash|shell/.test(lower)) {
    return (
      `${head} It stopped to ask permission to run something on your machine, and nothing was ` +
      `there to answer, so it gave up. ResumeM-M only ever wants text back — it does not need ` +
      `the AI to run commands, read your files or change anything. ` +
      whichSettingIsWrong(command, args)
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

/**
 * Which part of the setting is the problem, given what is actually saved.
 *
 * "Pick a preset in Settings" was the whole of the advice, and it is useless
 * to the person who already did. The three cases it could not tell apart:
 * the command is not one this tool knows, so there is no preset to be using;
 * it is a preset's command but not its arguments, which is the shape a
 * half-saved change leaves behind; or it is exactly a preset and the fault is
 * outside ResumeM-M. Naming the saved command and args makes the second case
 * — the one that reads as "the preset was ignored" — visible at a glance.
 */
function whichSettingIsWrong(command: string, args: string[]): string {
  const where = 'Voice & AI › AI command';
  const preset = AI_PRESETS.find((p) => p.command === command);

  if (!preset) {
    return (
      `Nothing here is set to "${command}" by any of the presets (${AI_PRESETS.map((p) => p.command).join(', ')}), ` +
      `so this is a command of your own. Open Settings › ${where} and pick a preset — each one runs ` +
      `its CLI with every tool switched off and confines it to a scratch folder, which leaves it ` +
      `nothing to ask permission for. ` + NOTHING_IS_LOST
    );
  }

  if (preset.args.join(' ') !== args.join(' ')) {
    return (
      `The command matches the "${preset.label}" preset but the arguments saved with it do not ` +
      `(saved: ${args.join(' ') || 'none'}). That is what a change that was picked but never saved ` +
      `looks like. Open Settings › ${where}, choose "${preset.label}" again — choosing it saves and ` +
      `tests it — and check the result line underneath before running anything else. ` + NOTHING_IS_LOST
    );
  }

  return (
    `This is exactly the "${preset.label}" preset, so the permission is being asked for by the CLI ` +
    `itself rather than by anything ResumeM-M configured — its own settings, or a version whose ` +
    `flags have moved on from this preset. Run "${command} ${args.join(' ')}" once in a terminal to ` +
    `see what it wants, and settle it there rather than by loosening the flags saved here. ` +
    NOTHING_IS_LOST
  );
}

/**
 * The way out that is always available, and that nobody finds on their own.
 *
 * Every branch above ends in "go and fix your CLI", which is a task, and it
 * arrives in the middle of an application. Switching the AI off is not a
 * downgrade to nothing: the prompt comes back instead of the answer, and it
 * is a prompt you can paste into any chat window and paste the reply back.
 */
const NOTHING_IS_LOST =
  'If you would rather not deal with it now, switch "Let the tool run the AI command" off: ' +
  'every AI button then hands you the prompt it would have sent, to paste into a chat of your own.';

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
 * The answer, out of the transcript the CLI wrapped it in.
 *
 * `codex exec` does not print an answer; it prints a session. A version
 * banner, the working directory, the model, the sandbox mode — then, under
 * "User instructions", **the whole prompt echoed back**, then its reasoning
 * under "thinking", then the answer under "codex", then a token count.
 *
 * Taken whole, as it was, that is what became the cover letter: a letter that
 * opens with a version number and a working directory, contains the prompt,
 * contains the letters the prompt quoted as examples of the user's voice —
 * which are letters to *other companies* — and reaches the actual letter
 * several hundred lines down. `trimToLetter` cannot save it, and makes it
 * worse: the first salutation it finds is the one in the echoed example, so
 * the letter it keeps is the one written to somebody else.
 *
 * The tailoring plan went the same way for the same reason. `extractJson`
 * takes the first JSON object it can parse, and the echoed prompt is full of
 * them — so the plan applied was a fragment of the store that had been quoted
 * back, and an AI run that changed nothing reported success.
 *
 * Matched on the shape rather than on the configured command, because the
 * command is whatever the user typed: a path, a wrapper script, `npx codex`.
 * A timestamped line that is exactly the word `codex` is not something a
 * cover letter contains, and the last one is the answer — the earlier ones
 * are earlier turns.
 */
/*
 * A date in the brackets, not merely brackets. "[not a timestamp] codex" is a
 * line somebody could write, and taking it for a marker would throw away
 * everything above it — the rule has to be narrow enough that only a machine
 * writes it. Both spellings, because the separator has moved between
 * versions.
 */
const STAMP = String.raw`\[\d{4}-\d{2}-\d{2}[T ][^\]]*\]`;
const CODEX_ANSWER = new RegExp(`^${STAMP}[ \\t]*codex[ \\t]*$`, 'gm');
const CODEX_TOKENS = new RegExp(`\\n${STAMP}[ \\t]*tokens used:[^\\n]*$`);

export function unwrapAgentFraming(text: string): string {
  const marks = [...text.matchAll(CODEX_ANSWER)];
  const last = marks[marks.length - 1];
  if (!last || last.index === undefined) return text;
  return text.slice(last.index + last[0].length).replace(CODEX_TOKENS, '').trim();
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

  // No salutation to find: the letter opens straight into prose, so there is
  // no landmark — only the shape of the things that are not the letter.
  if (salutation < 0) return dropAgentCommentary(text);
  // Already the first thing: leave it alone.
  if (salutation === 0) return text;

  // Only skip a preamble, not half the letter: a salutation a long way down is
  // more likely to be quoted inside one than to be the start of one.
  if (salutation > 12) return text;
  return lines.slice(salutation).join('\n').trim();
}

/**
 * A paragraph that is the agent talking about the job rather than doing it.
 *
 * These CLIs are coding agents, and a coding agent handed a writing task
 * reaches for the habits it has: write a plan to a file, link the file, raise
 * the open question. One came back with
 *
 *   I have prepared the implementation plan and a candidate-voice-matched
 *   draft in [cover_letter_plan.md](file:///…/cover_letter_plan.md).
 *
 *   ### Key Decision / Question:
 *   - **Target Company Name**: The posting lists the company name as `Software
 *     Engineering`. If this is a placeholder…
 *
 * and then the letter. There is no salutation to find in a letter that opens
 * "I want to work on systems where…", so all of that was saved as the letter.
 *
 * The prompt now forbids every part of it, which is the real fix; this is the
 * net under it, and it is a narrow one on purpose. Only these shapes go, only
 * from the top, only while they keep matching, and never so much that the
 * letter itself could be what was thrown away.
 */
const AGENT_META = new RegExp(
  [
    // Markup a letter never opens with: a heading, a rule, a fence, a quote.
    String.raw`^(?:#{1,6}\s|-{3,}$|\*{3,}$|\x60\x60\x60|>\s)`,
    // The assistant acknowledging the request.
    String.raw`^(?:sure|certainly|okay|ok|of course|got it|understood|alright)\b[,.!:]`,
    // The assistant describing what it just did, or is about to.
    String.raw`^(?:here(?:'s| is| are)\b|below (?:is|are)\b|i(?:'ve| have) (?:prepared|written|drafted|created|put together|produced|generated)\b|i(?:'ll| will)(?: now)? (?:write|draft|prepare|put together|create|generate)\b)`,
    // A link to a file it wrote. There is nowhere for the reader to open it.
    String.raw`\]\(\s*(?:file://|\.{0,2}/)`,
  ].join('|'),
  'i',
);

/** A bullet or a numbered item — part of whatever block it hangs under. */
const LIST_ITEM = /^\s*(?:[-*+]\s|\d+[.)]\s)/;

/**
 * What has to be left for the remainder to be a letter at all.
 *
 * A proportion of the reply was the obvious rule and the wrong one: the run
 * this exists for had 470 characters of plan-file commentary over a 330
 * character letter, so "never drop more than half" kept every word of it. The
 * question is not how much was dropped, it is whether what is left is a
 * letter — and a reply whose non-commentary remainder is one short line
 * ("Let me know.") is a reply with no letter in it, at any ratio.
 */
const ENOUGH_LETTER = 120;
/** And an upper bound on the preamble itself, so nothing runs away. */
const MOST_PREAMBLE = 2500;

export function dropAgentCommentary(text: string): string {
  const blocks = text.split(/\n\s*\n/);
  let cut = 0;
  // A list under a heading we dropped belongs to it; a list at the very top,
  // with nothing dropped before it, might be the letter's own.
  let dropping = false;

  while (cut < blocks.length) {
    const block = (blocks[cut] ?? '').trim();
    if (!block) {
      cut++;
      continue;
    }
    if (AGENT_META.test(block) || (dropping && LIST_ITEM.test(block))) {
      dropping = true;
      cut++;
      continue;
    }
    break;
  }

  if (cut === 0) return text;

  const whole = text.trim();
  const kept = blocks.slice(cut).join('\n\n').trim();
  // Nothing left that could be a letter, or a preamble longer than any
  // preamble plausibly is: this is not a letter with commentary on top, and
  // guessing which part to keep is how a draft disappears. Hand back what the
  // model actually said.
  if (kept.length < ENOUGH_LETTER) return text;
  if (whole.length - kept.length > MOST_PREAMBLE) return text;
  return kept;
}
