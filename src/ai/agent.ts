import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { startRun, type RunHandle } from './activity.js';
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
  /**
   * True when a tool server was wired in and the run never called it.
   *
   * The two reasons `tools` can be absent look identical from outside and are
   * not the same thing at all: a run that was never given tools answered the
   * only way it could, and a run that *was* given them and never touched one
   * could not see them. Only the second is a fault, and it is invisible
   * without this — the run comes back looking like a model that answered
   * badly, when it is a model that was never handed what the prompt told it
   * to use.
   */
  wiredButUnused?: boolean;
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
  wire: (
    sandbox: string,
    command: string,
  ) => { args: string[]; approval?: string[]; out: string; env: Record<string, string> } | null;
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
 * working directory gives them. So the child runs in a fresh temp directory of
 * its own, and `{sandbox}` in the argument template expands to it for CLIs
 * that want it named explicitly.
 *
 * What this stops: an agent that decides to "look around the project" ending up
 * in your source tree or your home directory.
 *
 * ## What it does not stop, said plainly
 *
 * The directory does not hold "nothing but the prompt", which this note used
 * to claim. A tailoring run is given a session file — see `mcp/launch.ts` —
 * and that file is the store: every entry, every unused variant, the profile
 * with your address and phone number in it. A CLI with file tools can read all
 * of it, which is the point, and can also read it for its own reasons.
 *
 * Nor is the directory a sandbox in the security sense. Nothing here blocks
 * the child from opening a socket, and the server it would find on loopback
 * has no authentication — so a CLI with a shell or a fetch tool can write to
 * the store directly, around the id-only plan that `sanitizeAiPlan` exists to
 * enforce. Some presets close that off themselves (`claude` denies Bash and
 * Web, `codex` runs read-only, `agy` plans only); `gemini` and any command
 * somebody configures by hand do not.
 *
 * That is a deliberate position rather than an oversight: this is a local tool
 * running your own CLI, as you, on your own machine, and a resume store is not
 * a multi-tenant boundary. It is written down because the guarantee this note
 * used to assert was stronger than the one the code makes, and a comment that
 * overstates a protection is worse than no comment at all.
 */
export async function runAgent(
  config: StoreConfig,
  prompt: string,
  tools?: AgentTools,
  /**
   * Internal. Set on the one retry a rejected approval setting earns — see
   * `Wiring.approval` and `rejectedApproval`. Its only job is to make sure the
   * retry cannot itself retry.
   */
  without?: { approval?: boolean },
): Promise<AgentResult> {
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
  /*
   * "You may call this server without asking" — dropped on the retry.
   *
   * Kept in its own binding rather than folded into `wiring.args` because the
   * catch below has to be able to tell whether the CLI's complaint was about
   * one of these, and because the retry has to be able to leave them out.
   */
  const approval = without?.approval ? [] : (wiring?.approval ?? []);

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
    const added = wiring ? [...wiring.args, ...approval] : [];
    if (added.length === 0) return expanded;
    const promptAt = expanded.findIndex((a) => a === prompt || a === promptFile || a.endsWith(prompt));
    if (promptAt < 0) return [...expanded, ...added];
    return [...expanded.slice(0, promptAt), ...added, ...expanded.slice(promptAt)];
  })();
  const usesFile = config.ai.args.some((a) => a.includes('{prompt}') && !a.includes('{promptText}'));

  /*
   * Declared out here so `finally` can close the record whatever happens.
   * Nullable because the work above — writing the prompt, wiring the tools —
   * can throw before there is anything to watch, and a run that never reached
   * a command is not a run to show.
   */
  let watching: RunHandle | null = null;

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

    /*
     * Watched as well as collected.
     *
     * `execFile` buffers both streams and hands them over at exit, so until
     * the child exits there is nothing to see — and a run killed at the
     * timeout is precisely the run nobody could see. Listening for `data`
     * takes nothing away from that buffering: every listener on a stream
     * receives the same chunk, so this is a copy for `activity` and changes
     * nothing about what `await pending` returns.
     *
     * See `activity.ts` for why the copy is worth having.
     */
    watching = startRun({ command: config.ai.command, args, prompt });
    pending.child.stdout?.on('data', (d: Buffer | string) => watching?.saw('out', String(d)));
    pending.child.stderr?.on('data', (d: Buffer | string) => watching?.saw('err', String(d)));

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
    const output = lastMessage(config.ai.command, args) ?? unwrapAgentFraming(stdout.trim());
    /*
     * Silence is only a failure when there was no other way to answer.
     *
     * A CLI that did its work through the tools has already said everything
     * it had to say, and several of them print nothing to stdout when the
     * last thing they did was call a tool. Treating that as "the command
     * produced nothing" would fail the one kind of run that went best.
     */
    if (!output && !decided) {
      const why = explainSilence(config.ai.command, stderr, config.ai.args);
      watching.ended('failed', why);
      throw new AgentError(why);
    }
    /*
     * A run that had tools and never touched one still "succeeded", and that
     * is worth saying out loud where somebody can see it.
     *
     * The caller quietly asks again the old way when this happens, which is
     * the right thing to do and means a tailoring still comes out — so from
     * the outside nothing looks wrong at all, while every run is silently
     * costing twice what it should and the tools are doing nothing. Silent
     * degradation is the shape of bug this whole panel exists to end, so it
     * is written on the run.
     */
    watching.ended(
      'ok',
      wiring && !decided ? 'Finished, but never called any of the tools it was given.' : undefined,
    );
    return {
      output,
      executed: true,
      command: `${config.ai.command} ${args.join(' ')}`,
      ...(decided ? { tools: decided } : {}),
      ...(wiring && !decided ? { wiredButUnused: true } : {}),
    };
  } catch (err) {
    // Our own refusals already say what happened; re-wrapping them as "AI
    // command failed: AI command failed: …" helps nobody.
    if (err instanceof AgentError) throw err;
    const e = err as { code?: string; message?: string; stderr?: string; stdout?: string };
    /*
     * The CLI would not take the server approval setting. Run it again without.
     *
     * `Wiring.approval` names a setting that older Codex versions may not
     * understand. The worst case is one wasted start and a run that ends up
     * exactly where it was before the setting existed, rather than a CLI that
     * refuses to start at all and a tailoring that produces nothing.
     *
     * Once only, and only when the complaint names the key — a CLI that failed
     * for its own reasons would otherwise be run twice for nothing.
     */
    if (approval.length > 0 && rejectedApproval(`${e.stdout ?? ''}\n${e.stderr ?? ''}\n${e.message ?? ''}`, approval)) {
      watching?.ended('failed', 'The CLI would not take the setting that lets it call the tools unprompted; trying again without it.');
      return await runAgent(config, prompt, tools, { approval: true });
    }
    if (e.code === 'ENOENT') {
      watching?.ended('failed', `"${config.ai.command}" is not installed or not on PATH.`);
      throw new AgentError(
        `AI command "${config.ai.command}" not found. Install it, or change ai.command in data/config.yaml, ` +
          `or set ai.enabled: false to get prompts back instead of answers.`,
        undefined,
        'not-installed',
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
      const seconds = Math.round(config.ai.timeoutMs / 1000);

      /*
       * Did it ever reach the tools it was given?
       *
       * A run that was handed a tool server writes its decisions after every
       * call, so the absence of that file after three minutes says the model
       * never called one — and that changes the advice completely. Raising the
       * timeout is right for a model that is thinking and wrong for one that
       * cannot see the tools and is filling the time some other way.
       *
       * Measured, from a real run's own output: with the server unreachable
       * the model spent forty seconds trying to start it by hand and ninety
       * more reading our session file with `jq`, then hit the limit with
       * nothing decided. "Raise ai.timeoutMs" was the one thing that would
       * not have helped.
       */
      const toolless = wiring !== null && !fs.existsSync(wiring.out);
      /*
       * When the CLI said why, say that instead of guessing.
       *
       * A refused tool call does not stop a run — it sends it looking for
       * another way round until the clock runs out, so this arrives here
       * rather than as a failure. The refusal is the whole explanation and it
       * is already in the output; it just never reached anybody.
       */
      const refused = deniedTools(`${e.stdout ?? ''}\n${e.stderr ?? ''}`);
      const advice = refused
        ? refused
        : toolless
          ? `It never called any of the resume tools, so the time went somewhere else — raising ` +
            `ai.timeoutMs will not help until it can reach them. "What the AI is doing" shows what ` +
            `it did instead.`
          : `Raise ai.timeoutMs in config.yaml if it needs longer.`;

      watching?.ended(
        'timeout',
        refused
          ? `Stopped after ${seconds}s; the CLI refused every tool call.`
          : toolless
            ? `Stopped after ${seconds}s, having never called a tool. See what it did instead.`
            : `Stopped after ${seconds}s. Raise the AI timeout in Settings if it needs longer.`,
      );
      throw new AgentError(
        `AI command "${config.ai.command}" ran for longer than ${seconds}s and was stopped. ${advice}`,
        e.stdout,
        'timeout',
      );
    }
    const why = `AI command failed: ${e.stderr?.trim() || e.message || 'unknown error'}`;
    watching?.ended('failed', why);
    throw new AgentError(why, e.stdout);
  } finally {
    // Whatever left the try another way still closes the record; `ended` keeps
    // the first outcome, so this only catches what nothing else named.
    watching?.ended('failed', 'The run ended without saying why.');
    tidyUp(dir);
  }
}

/**
 * Take the scratch directory away, and never let that be the thing that fails.
 *
 * This ran unguarded in a `finally`, so a removal that threw replaced whatever
 * the run had produced — including a run that had gone perfectly. What that
 * looked like, reported from a real tailoring pass:
 *
 *   The AI did not finish, so nothing was tailored. It said: ENOTEMPTY,
 *   Directory not empty: /private/var/folders/…/T/rmm-ai-UuaoCq
 *
 * The model had done the work. A temp directory would not delete, and the work
 * went with it.
 *
 * `force` does not cover this: it suppresses "it was not there", not "it is
 * not empty". Not-empty means something wrote into the directory while the
 * walk was removing it, and this sandbox has an obvious candidate — the tool
 * server runs inside it, so its own output can land between the last unlink
 * and the rmdir. Hence the retries: the race is short, and the second attempt
 * is against a directory nothing is writing to any more.
 *
 * And if it still will not go, it stays. A few kilobytes left in the system
 * temp directory, which the OS clears anyway, is not a reason to throw away
 * somebody's cover letter.
 */
export function tidyUp(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch {
    // Deliberately nothing. See above: the run's result is worth more than
    // the directory, and there is nothing here the user could act on.
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
/**
 * Did the CLI fail *because of* the approval setting, rather than despite it?
 *
 * The narrow question, asked narrowly. `Wiring.approval` carries a config key
 * older Codex versions may not understand, and the whole reason that is safe
 * is that a rejection costs one retry instead of the run. But only a rejection
 * should: re-running a CLI that fell over for its own reasons doubles every
 * real failure's wait, and on a tailoring pass that wait is minutes.
 *
 * So both halves have to hold. The output has to name the key we passed (the
 * dotted path, or its last segment — a CLI complaining about a config key
 * usually quotes the field rather than the whole override), *and* it has to be
 * complaining rather than merely echoing its configuration back, which several
 * of these CLIs do at startup.
 */
export function rejectedApproval(output: string, approval: string[]): boolean {
  const keys = approval
    .map((a) => (a.includes('=') ? a.slice(0, a.indexOf('=')) : a))
    .map((k) => k.trim())
    .filter((k) => k.length > 0 && !/^-{1,2}c$/.test(k));
  if (keys.length === 0) return false;
  const named = keys.some((k) => output.includes(k) || output.includes(k.split('.').pop() ?? k));
  if (!named) return false;
  return /unknown|unrecognis|unrecogniz|unexpected|invalid|unsupported|not supported|no such|deserializ|failed to parse|cannot parse/i.test(
    output,
  );
}

/**
 * Was the run stopped from using the tools it was given?
 *
 * Returns the sentence to say, or undefined when this is not what happened.
 * Shared with the timeout path, because the same refusal shows up there: a run
 * that cannot call a tool does not fail, it casts about until the clock runs
 * out, and the useful thing to say is the same either way.
 */
export function deniedTools(stderr: string): string | undefined {
  const lower = stderr.toLowerCase();
  if (!/approval|approve/.test(lower)) return undefined;
  if (!/\bmcp\b|tool call/.test(lower)) return undefined;
  return (
    'The CLI would not let it use the resume tools: it asked to call one and its own approval ' +
    'policy refused, because a run with nobody watching has nobody to ask. The tools are how this ' +
    'tailoring is done, so nothing could be decided. Allow the tool calls in the CLI\u2019s own ' +
    'settings, or switch to a command that permits them.'
  );
}

export function explainSilence(command: string, stderr: string, args: string[] = []): string {
  const said = stderr.trim();
  const lower = said.toLowerCase();
  const head = `The AI command "${command}" finished without writing anything.`;

  /*
   * The opposite refusal, and it wants the opposite advice.
   *
   * The branch below is about a model reaching for a shell it does not need.
   * This one is about a model reaching for *our own* tools — the ones it was
   * told to use — and being refused by the CLI in between:
   *
   *   MCP tool call requires approval, but approval policy is never
   *   mcp: resume/read_resume started
   *
   * The server was wired in and started; the very first call was turned down.
   * `codex exec` cannot prompt anybody, so its approval policy is `never`, and
   * under that policy an MCP call is refused rather than allowed. The run then
   * spends its whole budget finding another way round and produces nothing.
   *
   * Told apart from the branch below by "approval", which the existing test
   * does not look for — it asks for "permission", "denied" or "not allowed",
   * and this message uses none of the three, so it fell through to a generic
   * sentence that sent people looking at the wrong thing entirely.
   */
  if (deniedTools(said)) return `${head} ${deniedTools(said)}`;

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

/**
 * Which way a run failed, for a caller that has to put it into a sentence.
 *
 * The message alone cannot be read for this without parsing English, and the
 * one place that most needs to know — the extension's card — is furthest from
 * it. So it said "The AI could not be started" about every failure, including
 * this one:
 *
 *   The AI could not be started, so nothing was tailored. It said: AI command
 *   "codex" ran for longer than 180s and was stopped.
 *
 * A command that ran for three minutes was plainly started, and the sentence
 * contradicts its own evidence in the same breath. The three cases want three
 * different words and only this file knows which one applies.
 */
export type AgentFailure = 'not-installed' | 'timeout' | 'failed';

export class AgentError extends Error {
  readonly partial?: string;
  readonly kind: AgentFailure;
  constructor(message: string, partial?: string, kind: AgentFailure = 'failed') {
    super(message);
    this.name = 'AgentError';
    this.partial = partial;
    this.kind = kind;
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

/*
 * And the same session with no answer in it at all.
 *
 * A run that prints its banner, echoes the prompt and then stops — the model
 * returned nothing, the key was refused, a future version moved the marker —
 * has not answered. Left alone, the banner and the echoed prompt *are* the
 * output, so they became the cover letter: a run that failed, saved and
 * bundled as though it had worked. Silence is the honest reading, and the
 * caller already knows how to report that.
 *
 * Only when the transcript is unmistakably one. "User instructions:" under a
 * timestamp is not a line anybody's letter contains.
 */
const CODEX_SESSION = new RegExp(`^${STAMP}[ \\t]*User instructions:`, 'm');

/**
 * The answer the CLI wrote to a file because it was asked to, if it did.
 *
 * `unwrapAgentFraming` below is a rule about the shape of Codex's printed
 * session, and a rule about a shape is only ever as good as the version that
 * printed it. Codex also takes `--output-last-message <file>`, which writes
 * the final message and nothing else — no turns above it, no "tokens used"
 * line under it, nothing to recognise or strip. When the command line asks
 * for one, that file is the answer and the transcript is not consulted.
 *
 * Silence stays silence: an empty or missing file falls through to the
 * transcript, so a version that does not write the file behaves exactly as
 * before rather than reporting that the model said nothing.
 */
function lastMessage(command: string, args: string[]): string | null {
  /*
   * `--output-last-message` is Codex's alone, and means only ever this, so it
   * is honoured whatever the command is. `-o` is its short spelling, and `-o`
   * on somebody else's tool means something else entirely — an output format,
   * a report file. Read everywhere, a custom command carrying `-o report.txt`
   * would have had that file returned as the model's answer.
   */
  const isCodex = /(^|[\\/])codex(\.exe)?$/i.test(command.trim());
  const at = args.findIndex((a) => a === '--output-last-message' || (isCodex && a === '-o'));
  const joined = args.find((a) => a.startsWith('--output-last-message='));
  const file = joined ? joined.slice('--output-last-message='.length) : at >= 0 ? args[at + 1] : undefined;
  if (!file) return null;
  try {
    const said = fs.readFileSync(file, 'utf8').trim();
    return said || null;
  } catch {
    // Not written: an older Codex, a run that died, a path it could not use.
    return null;
  }
}

export function unwrapAgentFraming(text: string): string {
  const marks = [...text.matchAll(CODEX_ANSWER)];
  const last = marks[marks.length - 1];
  if (last && last.index !== undefined) {
    return text.slice(last.index + last[0].length).replace(CODEX_TOKENS, '').trim();
  }
  return CODEX_SESSION.test(text) ? '' : text;
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
/*
 * What the assistant would be handing over, if it were describing itself.
 *
 * "The assistant describing what it just did" was written as the verb alone,
 * and the verbs are ones a letter uses about its writer. `I have written` is
 * how somebody opens a paragraph about four years of production Go, and
 * `Here's` is how they open one about what drew them to the role — both
 * matched, and the whole paragraph went, silently, with nothing saying the
 * letter had been cut. `I'll` was already found to do this once; see the test
 * below that pins it.
 *
 * So the sentence has to name the thing as well as the act, within the same
 * clause. An agent handing over its work says what it is handing over — the
 * run this whole net exists for said "the implementation plan and a
 * candidate-voice-matched draft" — and a letter talking about its writer's
 * work does not.
 */
const HANDED_OVER = String.raw`[^.\n]{0,80}?\b(?:cover letter|letter|draft|answers?|responses?|version|revision|write-?up|document|plan|file|markdown)\b`;

const AGENT_META = new RegExp(
  [
    // Markup a letter never opens with: a heading, a rule, a fence, a quote.
    String.raw`^(?:#{1,6}\s|-{3,}$|\*{3,}$|\x60\x60\x60|>\s)`,
    // The assistant acknowledging the request.
    String.raw`^(?:sure|certainly|okay|ok|of course|got it|understood|alright)\b[,.!:]`,
    // The assistant describing what it just did, or is about to.
    String.raw`^(?:here(?:'s| is| are)|below (?:is|are)|i(?:'ve| have) (?:prepared|written|drafted|created|put together|produced|generated)|i(?:'ll| will)(?: now)? (?:write|draft|prepare|put together|create|generate))\b${HANDED_OVER}`,
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
